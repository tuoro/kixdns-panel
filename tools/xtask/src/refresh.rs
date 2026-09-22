//! 依赖安全刷新：不等上游，为锁定版本生成依赖修订。
//! Dependency security refresh: produces a dependency revision for a locked
//! version without waiting for upstream.
//!
//! 这里只生成和审计修订，不参与 prepare，所以 artifact 指纹固定了本文件的摘要。
//! 任何影响 prepare 的逻辑必须放在 main.rs。
//! This module only generates and audits revisions and never runs during
//! prepare, so the artifact fingerprint pins its digest. Anything that affects
//! prepare belongs in main.rs.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Number, Value};
use tempfile::Builder;

use crate::overlay::cargo_network_failure;
use crate::{
    UpstreamLock, apply_patch, clone_upstream, dependency_revision_directory,
    dependency_revision_file_name, load_lock, patch_series, prepare, valid_lock_path,
    validate_lock,
};

/// 工作流按这句话区分“需要人工处理”和基础设施故障。
/// The workflow tells "needs a human" apart from infrastructure failures by this text.
const UNFIXABLE: &str = "依赖无法在兼容版本内修复";
const LOCK_FILE: &str = "Cargo.lock";

pub(crate) struct Options {
    pub(crate) lock_file: PathBuf,
    pub(crate) advisory_db: PathBuf,
}

impl Options {
    pub(crate) fn parse(mut arguments: impl Iterator<Item = String>) -> Result<Self> {
        let mut lock_file = None;
        let mut advisory_db = None;

        while let Some(flag) = arguments.next() {
            let value = arguments
                .next()
                .with_context(|| format!("{flag} 缺少参数值"))?;
            match flag.as_str() {
                "--lock" if lock_file.is_none() => lock_file = Some(PathBuf::from(value)),
                "--advisory-db" if advisory_db.is_none() => {
                    advisory_db = Some(PathBuf::from(value));
                }
                "--lock" | "--advisory-db" => bail!("重复的参数：{flag}"),
                _ => bail!("未知的依赖审计参数：{flag}"),
            }
        }

        let lock_file = lock_file.context("需要 --lock")?;
        if !valid_lock_path(&lock_file) {
            bail!("--lock 必须是受支持的上游锁文件");
        }
        let advisory_db = advisory_db.context("需要 --advisory-db")?;
        let advisory_db = fs::canonicalize(&advisory_db)
            .with_context(|| format!("RustSec 数据库不存在：{}", advisory_db.display()))?;
        if !advisory_db.is_dir() {
            bail!("RustSec 数据库不是目录：{}", advisory_db.display());
        }
        Ok(Self {
            lock_file,
            advisory_db,
        })
    }
}

#[derive(Debug, Deserialize)]
struct AuditReport {
    vulnerabilities: Vulnerabilities,
    #[serde(default)]
    warnings: BTreeMap<String, Vec<Finding>>,
}

#[derive(Debug, Deserialize)]
struct Vulnerabilities {
    list: Vec<Finding>,
}

#[derive(Debug, Deserialize)]
struct Finding {
    #[serde(default)]
    advisory: Option<Advisory>,
    package: Package,
    #[serde(default)]
    versions: Option<Versions>,
}

#[derive(Debug, Deserialize)]
struct Versions {
    #[serde(default)]
    patched: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Advisory {
    id: String,
}

#[derive(Debug, Deserialize)]
struct Package {
    name: String,
    version: String,
}

impl AuditReport {
    fn findings(&self) -> impl Iterator<Item = (&str, &Finding)> {
        self.vulnerabilities
            .list
            .iter()
            .map(|finding| ("vulnerability", finding))
            .chain(self.warnings.iter().flat_map(|(kind, findings)| {
                findings.iter().map(move |finding| (kind.as_str(), finding))
            }))
    }

    fn is_clean(&self) -> bool {
        self.findings().next().is_none()
    }

    /// 被 `--deny warnings` 拒绝的每个包版本都要换掉，包括已撤回的版本。
    /// 有公告给出修复版本时取兼容范围内最低的那个；同一个包命中多条公告时取其中最高的。
    /// Every package version that `--deny warnings` rejects has to move, yanked
    /// versions included. When an advisory names a patched version, the lowest
    /// compatible one is the target; a package hit by several advisories takes the
    /// highest of those targets.
    fn packages(&self) -> BTreeMap<(String, String), Option<Version>> {
        let mut packages = BTreeMap::new();
        for (_, finding) in self.findings() {
            let target = finding.versions.as_ref().and_then(|versions| {
                minimal_patched_version(&finding.package.version, &versions.patched)
            });
            let entry = packages
                .entry((
                    finding.package.name.clone(),
                    finding.package.version.clone(),
                ))
                .or_insert(None);
            *entry = (*entry).max(target);
        }
        packages
    }

    fn describe(&self) -> String {
        let mut lines = self
            .findings()
            .map(|(kind, finding)| {
                let advisory = finding
                    .advisory
                    .as_ref()
                    .map_or("", |advisory| advisory.id.as_str());
                format!(
                    "- {kind} {} {} {advisory}",
                    finding.package.name, finding.package.version
                )
                .trim_end()
                .to_owned()
            })
            .collect::<Vec<_>>();
        lines.sort();
        lines.dedup();
        lines.join("\n")
    }
}

type Version = (u64, u64, u64);

fn parse_version(text: &str) -> Option<Version> {
    let mut parts = text.trim().split('.');
    let version = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(version)
}

/// Cargo 的兼容规则：`0.0.x` 每个版本都不兼容，`0.y` 同 y 兼容，其余同主版本兼容。
/// Cargo's compatibility rule: every `0.0.x` is its own range, `0.y` shares y,
/// everything else shares the major version.
fn compatible(current: Version, candidate: Version) -> bool {
    match current {
        (0, 0, patch) => candidate == (0, 0, patch),
        (0, minor, _) => candidate.0 == 0 && candidate.1 == minor,
        (major, _, _) => candidate.0 == major,
    }
}

/// 公告修复范围里、与当前版本兼容且高于它的最低版本。只认下界；预发布版、严格大于
/// 和上界都不作为目标，找不到时交给 cargo 选最新兼容版本，再由审计判断。
/// The lowest version in the advisory's patched ranges that is compatible with and
/// newer than the current one. Only lower bounds count; pre-releases, strict `>` and
/// upper bounds never become a target. Without one, cargo picks the newest compatible
/// version and the audit judges the result.
fn minimal_patched_version(current: &str, patched: &[String]) -> Option<Version> {
    let current = parse_version(current)?;
    patched
        .iter()
        .flat_map(|requirement| requirement.split(','))
        .filter_map(|comparator| {
            let comparator = comparator.trim();
            let bound = [">=", "^", "~", "="]
                .iter()
                .find_map(|operator| comparator.strip_prefix(operator))
                .unwrap_or(comparator);
            parse_version(bound)
        })
        .filter(|candidate| *candidate > current && compatible(current, *candidate))
        .min()
}

fn parse_report(stdout: &[u8]) -> Result<AuditReport> {
    serde_json::from_slice(stdout).context("cargo audit 没有输出可解析的 JSON 报告")
}

fn run_audit(checkout: &Path, advisory_db: &Path) -> Result<AuditReport> {
    let output = Command::new("cargo")
        .arg("audit")
        .arg("--db")
        .arg(advisory_db)
        .args(["--no-fetch", "--deny", "warnings", "--json"])
        .current_dir(checkout)
        .stdin(Stdio::null())
        .output()
        .context("无法执行 cargo audit")?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let report = parse_report(&output.stdout)
        .with_context(|| format!("cargo audit 失败：{}\n{stderr}", output.status))?;
    if !output.status.success() && report.is_clean() {
        bail!(
            "cargo audit 失败但报告没有发现：{}\n{stderr}",
            output.status
        );
    }
    Ok(report)
}

/// 返回审计是否通过；有发现时打印清单，由调用方决定退出码。
/// Returns whether the audit passed; findings are printed and the caller picks the exit code.
pub(crate) fn audit_lock(root: &Path, options: &Options) -> Result<bool> {
    let checkout = prepare(root, &options.lock_file)?;
    let report = run_audit(&checkout, &options.advisory_db)?;
    if report.is_clean() {
        println!("依赖审计通过：{}", options.lock_file.display());
        return Ok(true);
    }
    eprintln!(
        "依赖审计未通过：{}\n{}",
        options.lock_file.display(),
        report.describe()
    );
    Ok(false)
}

pub(crate) fn refresh_dependencies(root: &Path, options: &Options) -> Result<()> {
    let lock = load_lock(root, &options.lock_file)?;
    validate_lock(&lock)?;
    let series = patch_series(root, &lock)?;

    let source_root = root.join(".upstream");
    fs::create_dir_all(&source_root).context("创建 .upstream 目录失败")?;
    let staging = Builder::new()
        .prefix(".kixdns-refresh-")
        .tempdir_in(&source_root)
        .context("创建依赖刷新目录失败")?;
    clone_upstream(root, staging.path(), &lock)?;
    for patch in &series.patches {
        apply_patch(staging.path(), patch)?;
    }
    // 修订从补丁集的锁算起：先把补丁集结果记为基准，再叠上现有修订开始刷新。
    // Revisions are taken from the patchset's lock: record the patchset result as the
    // baseline, then put any current revision on top and refresh from there.
    commit_baseline(staging.path())?;
    if let Some((_, revision)) = &series.revision {
        apply_patch(staging.path(), revision)?;
    }

    let before = run_audit(staging.path(), &options.advisory_db)?;
    if before.is_clean() {
        println!(
            "依赖审计通过，无需依赖修订：{}",
            options.lock_file.display()
        );
        return Ok(());
    }
    println!("依赖审计未通过，开始刷新：\n{}", before.describe());

    for ((name, version), target) in before.packages() {
        update_package(staging.path(), &name, &version, target)?;
    }

    let after = run_audit(staging.path(), &options.advisory_db)?;
    if !after.is_clean() {
        bail!("{UNFIXABLE}：\n{}", after.describe());
    }

    let diff = lock_diff(staging.path())?;
    if diff.is_empty() {
        bail!("刷新后的 Cargo.lock 与上游原样相同，无法生成依赖修订");
    }
    let revision = next_revision(root, &lock)?;
    persist_revision(root, &options.lock_file, &lock, revision, &diff)
}

/// 只移动出问题的包；它已被前一次更新顺带换掉时跳过。有修复版本时精确升到那一版，
/// cargo 会一并抬高它必需的依赖；精确升级不成立时退回最新兼容版本。
/// Moves only the offending package, skipping it when an earlier update already
/// replaced it. With a patched version it goes exactly there, and cargo raises the
/// dependencies that version needs; if that fails it falls back to the newest
/// compatible version.
fn update_package(
    checkout: &Path,
    name: &str,
    version: &str,
    target: Option<Version>,
) -> Result<()> {
    let lock = fs::read_to_string(checkout.join(LOCK_FILE)).context("读取 Cargo.lock 失败")?;
    if !lock_contains_package(&lock, name, version) {
        println!("{name} {version} 已被前面的更新替换");
        return Ok(());
    }

    let specification = format!("{name}@{version}");
    if let Some((major, minor, patch)) = target {
        let precise = format!("{major}.{minor}.{patch}");
        match cargo_update(checkout, &specification, Some(&precise)) {
            Ok(()) => return Ok(()),
            Err(error) if error.to_string().contains(NETWORK_FAILURE) => return Err(error),
            Err(error) => println!("{error}；改为升级到最新兼容版本"),
        }
    }
    cargo_update(checkout, &specification, None)
}

const NETWORK_FAILURE: &str = "网络失败";

fn cargo_update(checkout: &Path, specification: &str, precise: Option<&str>) -> Result<()> {
    let mut arguments = vec!["update", "--package", specification];
    if let Some(precise) = precise {
        arguments.extend(["--precise", precise]);
    }
    // 增强内核只用固定的工具链构建，上游声明的最低 Rust 版本不能挡住安全修复。
    // The enhanced kernel is only built with the pinned toolchain, so upstream's
    // declared minimum Rust version must not hold back a security fix.
    let output = Command::new("cargo")
        .args(&arguments)
        .current_dir(checkout)
        .env("CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS", "allow")
        .stdin(Stdio::null())
        .output()
        .context("无法执行 cargo update")?;
    std::io::stdout()
        .write_all(&output.stdout)
        .context("输出 cargo update 标准输出失败")?;
    std::io::stderr()
        .write_all(&output.stderr)
        .context("输出 cargo update 错误日志失败")?;
    if output.status.success() {
        return Ok(());
    }
    if cargo_network_failure(&output.stderr) {
        bail!(
            "更新 {specification} 时{NETWORK_FAILURE}：{}",
            output.status
        );
    }
    bail!(
        "{UNFIXABLE}：cargo {} 失败：{}",
        arguments.join(" "),
        output.status
    )
}

fn lock_contains_package(lock: &str, name: &str, version: &str) -> bool {
    let entry = format!("name = \"{name}\"\nversion = \"{version}\"\n");
    lock.replace("\r\n", "\n").contains(&entry)
}

fn commit_baseline(checkout: &Path) -> Result<()> {
    for arguments in [
        &["add", "--all"][..],
        &[
            "-c",
            "user.name=kixdns-refresh-bot",
            "-c",
            "user.email=kixdns-refresh-bot@users.noreply.github.com",
            "commit",
            "--quiet",
            "--no-gpg-sign",
            "--no-verify",
            "-m",
            "kixdns-refresh: patchset baseline",
        ][..],
    ] {
        let status = Command::new("git")
            .args(arguments)
            .current_dir(checkout)
            .stdin(Stdio::null())
            .status()
            .context("无法执行 git")?;
        if !status.success() {
            bail!("记录补丁集基准失败：git {}：{status}", arguments.join(" "));
        }
    }
    Ok(())
}

/// 相对补丁集基准的 Cargo.lock 差异，即新修订的全部内容。
/// The Cargo.lock diff from the patchset baseline, which is the whole new revision.
fn lock_diff(checkout: &Path) -> Result<Vec<u8>> {
    let output = Command::new("git")
        .args([
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--full-index",
            "HEAD",
            "--",
            LOCK_FILE,
        ])
        .current_dir(checkout)
        .stdin(Stdio::null())
        .output()
        .context("无法执行 git diff")?;
    if !output.status.success() {
        bail!("导出 Cargo.lock 差异失败：{}", output.status);
    }
    Ok(output.stdout)
}

fn next_revision(root: &Path, lock: &UpstreamLock) -> Result<u32> {
    let directory = dependency_revision_directory(root, lock)?;
    let prefix = format!("p{}-r", lock.patchset);
    let mut highest = lock.dependency_revision.unwrap_or(0);
    if directory.is_dir() {
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("读取依赖修订目录失败：{}", directory.display()))?
        {
            let name = entry?.file_name();
            let revision = name
                .to_str()
                .and_then(|name| name.strip_prefix(&prefix))
                .and_then(|name| name.strip_suffix(".patch"))
                .and_then(|number| number.parse::<u32>().ok());
            if let Some(revision) = revision {
                highest = highest.max(revision);
            }
        }
    }
    highest.checked_add(1).context("依赖修订编号溢出")
}

fn persist_revision(
    root: &Path,
    lock_file: &Path,
    lock: &UpstreamLock,
    revision: u32,
    diff: &[u8],
) -> Result<()> {
    let directory = dependency_revision_directory(root, lock)?;
    fs::create_dir_all(&directory)
        .with_context(|| format!("创建依赖修订目录失败：{}", directory.display()))?;
    let destination = directory.join(dependency_revision_file_name(lock.patchset, revision));
    let mut revision_staging = Builder::new()
        .prefix(".revision-")
        .suffix(".patch")
        .tempfile_in(&directory)
        .context("创建依赖修订暂存文件失败")?;
    revision_staging
        .write_all(diff)
        .context("写入依赖修订失败")?;
    revision_staging
        .as_file_mut()
        .sync_all()
        .context("同步依赖修订失败")?;

    let lock_path = root.join(lock_file);
    let lock_raw = fs::read_to_string(&lock_path)
        .with_context(|| format!("读取锁文件失败：{}", lock_path.display()))?;
    let mut lock_value: Value = serde_json::from_str(&lock_raw)
        .with_context(|| format!("解析锁文件失败：{}", lock_path.display()))?;
    lock_value
        .as_object_mut()
        .context("锁文件根节点必须是对象")?
        .insert(
            "dependency_revision".to_owned(),
            Value::Number(Number::from(revision)),
        );
    let parent = lock_path.parent().context("锁文件缺少父目录")?;
    let mut lock_staging = Builder::new()
        .prefix(".upstream-lock-")
        .tempfile_in(parent)
        .context("创建锁文件暂存文件失败")?;
    serde_json::to_writer_pretty(&mut lock_staging, &lock_value).context("序列化锁文件失败")?;
    writeln!(lock_staging).context("写入锁文件换行失败")?;
    lock_staging
        .as_file_mut()
        .sync_all()
        .context("同步锁文件失败")?;

    revision_staging
        .persist_noclobber(&destination)
        .map_err(|error| error.error)
        .with_context(|| format!("依赖修订已存在或无法写入：{}", destination.display()))?;
    if let Err(error) = lock_staging.persist(&lock_path) {
        if let Err(rollback_error) = fs::remove_file(&destination) {
            bail!(
                "写入锁文件失败：{}；同时无法回滚 {}：{}",
                error.error,
                destination.display(),
                rollback_error
            );
        }
        return Err(error.error).context("写入锁文件失败，已回滚依赖修订");
    }

    println!(
        "已生成依赖修订 r{revision}：{}",
        destination
            .strip_prefix(root)
            .unwrap_or(&destination)
            .display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::tempdir;

    use super::{
        Options, lock_contains_package, minimal_patched_version, next_revision, parse_report,
        persist_revision,
    };
    use crate::{UpstreamLock, UpstreamSource};

    fn action_lock(revision: Option<u32>) -> UpstreamLock {
        UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Action,
            commit: "681183cb25c745cfe42eb380bf9dda886683eaa7".to_owned(),
            official_run_id: Some(34_942_284_951),
            release_id: None,
            release_tag: None,
            compatibility: None,
            patchset: 23,
            control_protocol: 1,
            dependency_revision: revision,
        }
    }

    // 摘自 cargo-audit 0.22.2 对 v0.1.1 增强源码的真实输出，删去无关字段。
    // Trimmed from real cargo-audit 0.22.2 output on the v0.1.1 enhanced tree.
    const FAILING_REPORT: &str = r#"{
      "database": {}, "lockfile": {"dependency-count": 300}, "settings": {},
      "vulnerabilities": {"found": true, "count": 2, "list": [
        {"advisory": {"id": "RUSTSEC-2026-0258", "package": "h2"},
         "versions": {"patched": [">=0.4.16"], "unaffected": []}, "affected": null,
         "package": {"name": "h2", "version": "0.4.15", "source": "registry+https://github.com/rust-lang/crates.io-index"}},
        {"advisory": {"id": "RUSTSEC-2026-0285", "package": "rustls"},
         "versions": {"patched": [">=0.23.45"], "unaffected": []}, "affected": null,
         "package": {"name": "rustls", "version": "0.23.42", "source": "registry+https://github.com/rust-lang/crates.io-index"}}
      ]},
      "warnings": {"yanked": [
        {"kind": "yanked", "advisory": null, "versions": null, "affected": null,
         "package": {"name": "chacha20", "version": "0.10.1", "source": "registry+https://github.com/rust-lang/crates.io-index"}}
      ]}
    }"#;

    #[test]
    fn collects_vulnerable_and_yanked_packages() {
        let report = parse_report(FAILING_REPORT.as_bytes()).unwrap();
        assert!(!report.is_clean());
        let packages = report.packages().into_iter().collect::<Vec<_>>();
        assert_eq!(
            packages,
            [
                (("chacha20".to_owned(), "0.10.1".to_owned()), None),
                (("h2".to_owned(), "0.4.15".to_owned()), Some((0, 4, 16))),
                (
                    ("rustls".to_owned(), "0.23.42".to_owned()),
                    Some((0, 23, 45))
                ),
            ]
        );
        let description = report.describe();
        assert!(description.contains("rustls 0.23.42 RUSTSEC-2026-0285"));
        assert!(description.contains("yanked chacha20 0.10.1"));
    }

    #[test]
    fn targets_the_lowest_compatible_patched_version() {
        let patched = |ranges: &[&str]| {
            ranges
                .iter()
                .map(|&range| range.to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            minimal_patched_version("0.23.42", &patched(&[">=0.23.45"])),
            Some((0, 23, 45))
        );
        let split = patched(&[">=0.4.16, <0.5.0", ">= 0.5.3"]);
        assert_eq!(minimal_patched_version("0.4.15", &split), Some((0, 4, 16)));
        assert_eq!(minimal_patched_version("0.5.1", &split), Some((0, 5, 3)));
        assert_eq!(
            minimal_patched_version("1.2.3", &patched(&["^1.4.0", ">=2.0.0"])),
            Some((1, 4, 0))
        );
        // 公告按小版本分段给出修复时，停在最近的一段，不跨到更新的小版本。
        // With fixes listed per minor series, stay in the nearest series instead of
        // jumping to a newer minor.
        assert_eq!(
            minimal_patched_version("1.2.3", &patched(&[">=1.3.2", ">=1.2.5, <1.3.0"])),
            Some((1, 2, 5))
        );
        // 修复只在不兼容的新版本里，或给不出可用下界：交给 cargo 和审计。
        // A fix only in an incompatible release, or no usable lower bound: left to cargo
        // and the audit.
        assert_eq!(
            minimal_patched_version("1.2.3", &patched(&[">=2.0.0"])),
            None
        );
        assert_eq!(
            minimal_patched_version("0.4.15", &patched(&[">=0.5.0"])),
            None
        );
        assert_eq!(
            minimal_patched_version("0.0.3", &patched(&[">=0.0.4"])),
            None
        );
        assert_eq!(
            minimal_patched_version("1.0.0", &patched(&[">1.0.0", "<1.0.0", ">=1.0.1-rc.1"])),
            None
        );
        assert_eq!(minimal_patched_version("1.0.0", &[]), None);
    }

    #[test]
    fn keeps_the_highest_target_when_advisories_overlap() {
        let report = parse_report(
            br#"{"vulnerabilities": {"found": true, "count": 2, "list": [
                  {"advisory": {"id": "A"}, "versions": {"patched": [">=1.0.5"]},
                   "package": {"name": "demo", "version": "1.0.1"}},
                  {"advisory": {"id": "B"}, "versions": {"patched": [">=1.0.3"]},
                   "package": {"name": "demo", "version": "1.0.1"}}]},
                "warnings": {"yanked": [{"kind": "yanked",
                   "package": {"name": "demo", "version": "1.0.1"}}]}}"#,
        )
        .unwrap();
        assert_eq!(
            report.packages().into_iter().collect::<Vec<_>>(),
            [(("demo".to_owned(), "1.0.1".to_owned()), Some((1, 0, 5)))]
        );
    }

    #[test]
    fn treats_any_warning_kind_as_a_finding() {
        let report = parse_report(
            br#"{"vulnerabilities": {"found": false, "count": 0, "list": []},
                "warnings": {"unmaintained": [{"kind": "unmaintained",
                  "advisory": {"id": "RUSTSEC-2026-0001"},
                  "package": {"name": "old", "version": "1.0.0"}}]}}"#,
        )
        .unwrap();
        assert!(!report.is_clean());
    }

    #[test]
    fn accepts_a_clean_report() {
        let report = parse_report(
            br#"{"vulnerabilities": {"found": false, "count": 0, "list": []}, "warnings": {}}"#,
        )
        .unwrap();
        assert!(report.is_clean());
        assert!(report.packages().is_empty());
    }

    #[test]
    fn rejects_output_that_is_not_a_report() {
        assert!(parse_report(b"error: couldn't open Cargo.lock").is_err());
    }

    #[test]
    fn finds_exact_package_entries_only() {
        let lock = "[[package]]\nname = \"h2\"\nversion = \"0.4.15\"\n\n[[package]]\nname = \"h2-extra\"\nversion = \"1.0.0\"\n";
        assert!(lock_contains_package(lock, "h2", "0.4.15"));
        assert!(!lock_contains_package(lock, "h2", "0.4.16"));
        assert!(!lock_contains_package(lock, "extra", "1.0.0"));
    }

    #[test]
    fn numbers_revisions_after_every_existing_one_for_the_patchset() {
        let root = tempdir().unwrap();
        let directory = root.path().join("patches/dependencies/action/34942284951");
        fs::create_dir_all(&directory).unwrap();
        for name in ["p23-r1.patch", "p23-r3.patch", "p22-r9.patch", "notes.txt"] {
            fs::write(directory.join(name), "").unwrap();
        }

        assert_eq!(next_revision(root.path(), &action_lock(None)).unwrap(), 4);
        assert_eq!(
            next_revision(root.path(), &action_lock(Some(5))).unwrap(),
            6
        );
        let empty = tempdir().unwrap();
        assert_eq!(next_revision(empty.path(), &action_lock(None)).unwrap(), 1);
    }

    #[test]
    fn writes_revision_and_records_it_in_the_lock() {
        let root = tempdir().unwrap();
        let lock_file = Path::new("upstream.lock.json");
        fs::write(
            root.path().join(lock_file),
            "{\n  \"repository\": \"olicesx/kixdns\",\n  \"source\": \"action\",\n  \"patchset\": 23,\n  \"control_protocol\": 1\n}\n",
        )
        .unwrap();

        persist_revision(
            root.path(),
            lock_file,
            &action_lock(None),
            1,
            b"diff --git a/Cargo.lock b/Cargo.lock\n",
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(
                root.path()
                    .join("patches/dependencies/action/34942284951/p23-r1.patch")
            )
            .unwrap(),
            "diff --git a/Cargo.lock b/Cargo.lock\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join(lock_file)).unwrap(),
            "{\n  \"repository\": \"olicesx/kixdns\",\n  \"source\": \"action\",\n  \"patchset\": 23,\n  \"control_protocol\": 1,\n  \"dependency_revision\": 1\n}\n"
        );
        assert!(
            persist_revision(root.path(), lock_file, &action_lock(None), 1, b"x").is_err(),
            "an existing revision must never be overwritten"
        );
    }

    #[test]
    fn requires_lock_and_existing_advisory_database() {
        let database = tempdir().unwrap();
        let database_path = database.path().to_str().unwrap().to_owned();
        let options = Options::parse(
            [
                "--advisory-db",
                &database_path,
                "--lock",
                "upstream.lock.json",
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(options.lock_file, PathBuf::from("upstream.lock.json"));

        let missing = database.path().join("missing");
        assert!(
            Options::parse(
                [
                    "--lock",
                    "upstream.lock.json",
                    "--advisory-db",
                    missing.to_str().unwrap(),
                ]
                .into_iter()
                .map(str::to_owned),
            )
            .is_err()
        );
        assert!(
            Options::parse(
                ["--lock", "../escape.json", "--advisory-db", &database_path]
                    .into_iter()
                    .map(str::to_owned),
            )
            .is_err()
        );
    }
}
