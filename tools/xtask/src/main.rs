use std::env;
use std::ffi::OsStr;
use std::fmt::Write;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

mod overlay;
mod refresh;

const PATCH_STAMP: &str = ".kixdns-panel-patches";
const AUDIT_FINDINGS_EXIT_CODE: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum UpstreamSource {
    Action,
    Release,
}

impl UpstreamSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Action => "action",
            Self::Release => "release",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct UpstreamLock {
    pub(crate) repository: String,
    pub(crate) source: UpstreamSource,
    pub(crate) commit: String,
    #[serde(default)]
    pub(crate) official_run_id: Option<u64>,
    #[serde(default)]
    pub(crate) release_id: Option<u64>,
    #[serde(default)]
    pub(crate) release_tag: Option<String>,
    #[serde(default)]
    pub(crate) compatibility: Option<String>,
    pub(crate) patchset: u32,
    pub(crate) control_protocol: u32,
    /// 依赖修订：补丁集之后再调整 Cargo.lock，用于不跟随上游的安全刷新。
    /// A dependency revision adjusts Cargo.lock after the patchset, so a security
    /// refresh does not have to wait for upstream.
    #[serde(default)]
    pub(crate) dependency_revision: Option<u32>,
}

fn main() -> Result<()> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| "help".to_owned());
    let root = workspace_root()?;

    match command.as_str() {
        "prepare" => prepare(&root, &parse_lock_argument(arguments)?).map(drop),
        "rebase" => {
            let options = overlay::Options::parse(arguments)?;
            overlay::rebase_patchset(&root, &options)
        }
        "info" => print_info(&root, &parse_lock_argument(arguments)?),
        "checkout-dir" => {
            let lock = load_lock(&root, &parse_lock_argument(arguments)?)?;
            validate_lock(&lock)?;
            println!("{}", checkout_directory(&lock).display());
            Ok(())
        }
        "audit" => {
            let options = refresh::Options::parse(arguments)?;
            if !refresh::audit_lock(&root, &options)? {
                // 与执行失败（退出码 1）区分：只有确实审计出问题时才返回 3。
                // Kept apart from a failed run (exit 1): 3 means the audit found problems.
                std::process::exit(AUDIT_FINDINGS_EXIT_CODE);
            }
            Ok(())
        }
        "refresh-dependencies" => {
            let options = refresh::Options::parse(arguments)?;
            refresh::refresh_dependencies(&root, &options)
        }
        "help" | "-h" | "--help" => {
            print_help();
            Ok(())
        }
        other => bail!("未知 xtask 命令：{other}"),
    }
}

fn parse_lock_argument(mut arguments: impl Iterator<Item = String>) -> Result<PathBuf> {
    let Some(flag) = arguments.next() else {
        return Ok(PathBuf::from("upstream.lock.json"));
    };
    let value = arguments.next().context("--lock 缺少锁文件名")?;
    let path = PathBuf::from(value);
    if flag != "--lock" || arguments.next().is_some() || !valid_lock_path(&path) {
        bail!("锁文件必须是根目录当前锁，或 upstreams/actions、upstreams/releases 下的 JSON 文件");
    }
    Ok(path)
}

pub(crate) fn valid_lock_path(path: &Path) -> bool {
    if matches!(
        path.to_str(),
        Some("upstream.lock.json" | "upstream.release.lock.json")
    ) {
        return true;
    }
    let components = path.components().collect::<Vec<_>>();
    let [
        Component::Normal(root),
        Component::Normal(track),
        Component::Normal(file),
    ] = components.as_slice()
    else {
        return false;
    };
    if *root != OsStr::new("upstreams") || !matches!(track.to_str(), Some("actions" | "releases")) {
        return false;
    }
    let file = Path::new(file);
    file.extension() == Some(OsStr::new("json"))
        && file
            .file_stem()
            .and_then(OsStr::to_str)
            .is_some_and(valid_reference)
}

fn workspace_root() -> Result<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .context("无法确定工作区根目录")
}

pub(crate) fn load_lock(root: &Path, lock_file: &Path) -> Result<UpstreamLock> {
    let path = root.join(lock_file);
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("读取上游锁定文件失败：{}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("解析 {} 失败", lock_file.display()))
}

/// 检出目录按锁的完整构建输入区分，依赖修订不能复用未修订的目录。
/// The checkout directory is keyed on every build input of the lock, so a
/// dependency revision never reuses a directory prepared without it.
pub(crate) fn checkout_directory(lock: &UpstreamLock) -> PathBuf {
    let mut name = format!(
        "kixdns-{}-{}-p{}",
        lock.source.as_str(),
        &lock.commit[..12],
        lock.patchset
    );
    if let Some(revision) = lock.dependency_revision {
        write!(name, "-r{revision}").expect("写入 String 不会失败");
    }
    Path::new(".upstream").join(name)
}

pub(crate) fn prepare(root: &Path, lock_file: &Path) -> Result<PathBuf> {
    let lock = load_lock(root, lock_file)?;
    validate_lock(&lock)?;

    let source_root = root.join(".upstream");
    let checkout = root.join(checkout_directory(&lock));
    fs::create_dir_all(&source_root).context("创建 .upstream 目录失败")?;

    if !checkout.join(".git").is_dir() {
        initialize_checkout(root, &source_root, &checkout, &lock)?;
    }

    let head = output(&checkout, "git", ["rev-parse", "HEAD"])?;
    if head.trim() != lock.commit {
        bail!(
            "上游目录提交不匹配：期望 {}，实际 {}。请更换锁定提交或使用新的检出目录",
            lock.commit,
            head.trim()
        );
    }

    apply_patches(root, &checkout, &lock)?;
    println!("上游增强源码已准备：{}", checkout.display());
    Ok(checkout)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckoutPlaceholder {
    Missing,
    Empty,
    CachedTarget,
}

fn initialize_checkout(
    root: &Path,
    source_root: &Path,
    checkout: &Path,
    lock: &UpstreamLock,
) -> Result<()> {
    let placeholder = inspect_checkout_placeholder(checkout)?;
    let prefix = format!(".kixdns-{}-prepare-", &lock.commit[..12]);
    let staging = Builder::new()
        .prefix(&prefix)
        .tempdir_in(source_root)
        .context("创建上游临时检出目录失败")?;
    clone_upstream(root, staging.path(), lock)?;
    activate_checkout(staging, checkout, placeholder)
}

/// 只取锁定提交，检出为分离头指针；`HEAD` 即上游原样源码。
/// Fetches only the locked commit and detaches onto it, so `HEAD` is upstream's
/// pristine tree.
pub(crate) fn clone_upstream(root: &Path, destination: &Path, lock: &UpstreamLock) -> Result<()> {
    let url = format!("https://github.com/{}.git", lock.repository);
    run(
        root,
        "git",
        [
            OsStr::new("clone"),
            OsStr::new("--filter=blob:none"),
            OsStr::new("--no-checkout"),
            OsStr::new(&url),
            destination.as_os_str(),
        ],
    )?;
    run(
        destination,
        "git",
        ["fetch", "--depth", "1", "origin", lock.commit.as_str()],
    )?;
    run(
        destination,
        "git",
        ["checkout", "--detach", lock.commit.as_str()],
    )
}

fn activate_checkout(
    staging: TempDir,
    checkout: &Path,
    placeholder: CheckoutPlaceholder,
) -> Result<()> {
    let staging = staging.keep();
    if placeholder == CheckoutPlaceholder::CachedTarget {
        fs::rename(checkout.join("target"), staging.join("target"))
            .context("保留上游 Rust 构建缓存失败")?;
    }
    if placeholder != CheckoutPlaceholder::Missing {
        fs::remove_dir(checkout)
            .with_context(|| format!("移除空的上游占位目录失败：{}", checkout.display()))?;
    }
    fs::rename(&staging, checkout)
        .with_context(|| format!("启用上游临时检出失败；检出内容保留在 {}", staging.display()))?;
    Ok(())
}

fn inspect_checkout_placeholder(checkout: &Path) -> Result<CheckoutPlaceholder> {
    if !checkout.exists() {
        return Ok(CheckoutPlaceholder::Missing);
    }
    if !checkout.is_dir() {
        bail!("上游检出路径不是目录，拒绝覆盖：{}", checkout.display());
    }
    let entries = fs::read_dir(checkout)
        .with_context(|| format!("读取上游占位目录失败：{}", checkout.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if entries.is_empty() {
        return Ok(CheckoutPlaceholder::Empty);
    }
    if entries.len() == 1
        && entries[0].file_name() == OsStr::new("target")
        && entries[0].file_type()?.is_dir()
    {
        return Ok(CheckoutPlaceholder::CachedTarget);
    }
    bail!(
        "上游目录不是 Git 检出且包含未知内容，拒绝覆盖：{}",
        checkout.display()
    )
}

fn apply_patches(root: &Path, checkout: &Path, lock: &UpstreamLock) -> Result<()> {
    let series = patch_series(root, lock)?;
    let expected_stamp = patch_stamp(lock.patchset, lock.source, &series)?;
    let stamp_path = checkout.join(PATCH_STAMP);
    if fs::read_to_string(&stamp_path).is_ok_and(|stamp| stamp == expected_stamp) {
        println!("补丁集已应用：v{}", lock.patchset);
        return Ok(());
    }
    if !output(checkout, "git", ["status", "--porcelain"])?.is_empty() {
        bail!(
            "上游目录存在未标记变更，无法安全应用补丁。请保留需要的修改后移走目录：{}",
            checkout.display()
        );
    }

    apply_patch_series(checkout, &series)?;
    fs::write(&stamp_path, expected_stamp)
        .with_context(|| format!("写入补丁集标记失败：{}", stamp_path.display()))?;
    Ok(())
}

/// 一个锁要应用的全部补丁：补丁集本身，以及可选的依赖修订。
/// Everything a lock applies: the patchset itself plus an optional dependency revision.
pub(crate) struct PatchSeries {
    pub(crate) patches: Vec<PathBuf>,
    pub(crate) revision: Option<(u32, PathBuf)>,
}

pub(crate) fn patch_series(root: &Path, lock: &UpstreamLock) -> Result<PatchSeries> {
    let patches = patches_for_lock(root, lock)?;
    let revision = match lock.dependency_revision {
        None => None,
        Some(revision) => {
            let path = dependency_revision_path(root, lock, revision)?;
            if !path.is_file() {
                bail!("依赖修订不存在：{}", path.display());
            }
            Some((revision, path))
        }
    };
    Ok(PatchSeries { patches, revision })
}

/// 依赖修订是相对补丁集应用后那份 Cargo.lock 的差异，最后应用；每个修订都从补丁集
/// 的锁算起，所以同一时间只应用一个修订，不会层层叠加。
/// A dependency revision is a diff from the Cargo.lock the patchset produces and is
/// applied last. Every revision is taken from the patchset's lock, so exactly one
/// applies at a time and revisions never stack.
pub(crate) fn apply_patch_series(checkout: &Path, series: &PatchSeries) -> Result<()> {
    let revision = series.revision.as_ref().map(|(_, path)| path);
    for patch in series.patches.iter().chain(revision) {
        apply_patch(checkout, patch)?;
    }
    Ok(())
}

pub(crate) fn apply_patch(checkout: &Path, patch: &Path) -> Result<()> {
    let patch_arg = patch.as_os_str();
    run(
        checkout,
        "git",
        [OsStr::new("apply"), OsStr::new("--check"), patch_arg],
    )
    .with_context(|| format!("补丁与上游不兼容：{}", patch.display()))?;
    run(checkout, "git", [OsStr::new("apply"), patch_arg])
        .with_context(|| format!("应用补丁失败：{}", patch.display()))?;
    println!("已应用补丁：{}", patch.display());
    Ok(())
}

pub(crate) fn source_reference(lock: &UpstreamLock) -> Result<String> {
    match lock.source {
        UpstreamSource::Action => lock
            .official_run_id
            .map(|run_id| run_id.to_string())
            .context("Action 锁缺少 official_run_id"),
        UpstreamSource::Release => lock
            .release_tag
            .clone()
            .context("Release 锁缺少 release_tag"),
    }
}

pub(crate) fn dependency_revision_directory(root: &Path, lock: &UpstreamLock) -> Result<PathBuf> {
    Ok(root
        .join("patches/dependencies")
        .join(lock.source.as_str())
        .join(source_reference(lock)?))
}

pub(crate) fn dependency_revision_file_name(patchset: u32, revision: u32) -> String {
    format!("p{patchset}-r{revision}.patch")
}

pub(crate) fn dependency_revision_path(
    root: &Path,
    lock: &UpstreamLock,
    revision: u32,
) -> Result<PathBuf> {
    Ok(dependency_revision_directory(root, lock)?
        .join(dependency_revision_file_name(lock.patchset, revision)))
}

pub(crate) fn patches_for_lock(root: &Path, lock: &UpstreamLock) -> Result<Vec<PathBuf>> {
    let patchset_dir = root
        .join("patches")
        .join("sets")
        .join(lock.patchset.to_string());
    if !patchset_dir.is_dir() {
        bail!("补丁集目录不存在：{}", patchset_dir.display());
    }

    let mut patches = Vec::new();
    if let Some(compatibility) = lock.compatibility.as_deref() {
        let directory = patchset_dir.join("compatibility").join(compatibility);
        let selected = read_patches(&directory)?;
        if selected.is_empty() {
            bail!("补丁集 v{} 缺少兼容层 {compatibility}", lock.patchset);
        }
        patches.extend(selected);
    }
    if lock.source == UpstreamSource::Release {
        let release_tag = lock.release_tag.as_deref().expect("已验证 Release 标签");
        let directory = patchset_dir.join("release").join(release_tag);
        if directory.is_dir() {
            let selected = read_patches(&directory)?;
            if selected.is_empty() {
                bail!(
                    "补丁集 v{} 的 Release 目录 {release_tag} 为空",
                    lock.patchset
                );
            }
            patches.extend(selected);
        }
    }

    let common = read_patches(&patchset_dir.join("common"))?;
    if common.is_empty() {
        bail!("补丁集 v{} 缺少通用补丁", lock.patchset);
    }
    patches.extend(common);
    Ok(patches)
}

fn read_patches(directory: &Path) -> Result<Vec<PathBuf>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut patches = fs::read_dir(directory)
        .context("读取 patches 目录失败")?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension() == Some(OsStr::new("patch")))
        .collect::<Vec<_>>();
    patches.sort();

    Ok(patches)
}

fn patch_stamp(patchset: u32, source: UpstreamSource, series: &PatchSeries) -> Result<String> {
    let mut digest = Sha256::new();
    let revision_patch = series.revision.as_ref().map(|(_, path)| path);
    for patch in series.patches.iter().chain(revision_patch) {
        let name = patch
            .file_name()
            .context("补丁路径缺少文件名")?
            .as_encoded_bytes();
        let content =
            fs::read(patch).with_context(|| format!("读取补丁失败：{}", patch.display()))?;
        digest.update(name.len().to_le_bytes());
        digest.update(name);
        digest.update(content.len().to_le_bytes());
        digest.update(content);
    }
    let mut stamp = format!("source={}\npatchset={patchset}\n", source.as_str());
    if let Some((revision, _)) = &series.revision {
        writeln!(stamp, "dependency_revision={revision}").expect("写入 String 不会失败");
    }
    writeln!(stamp, "sha256={}", encode_hex(digest.finalize())).expect("写入 String 不会失败");
    Ok(stamp)
}

fn encode_hex(bytes: impl AsRef<[u8]>) -> String {
    let bytes = bytes.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(encoded, "{byte:02x}").expect("写入 String 不会失败");
    }
    encoded
}

fn print_info(root: &Path, lock_file: &Path) -> Result<()> {
    let lock = load_lock(root, lock_file)?;
    validate_lock(&lock)?;
    println!("锁文件：{}", lock_file.display());
    println!("仓库：https://github.com/{}", lock.repository);
    println!(
        "来源：{}",
        match lock.source {
            UpstreamSource::Action => "Action",
            UpstreamSource::Release => "Release",
        }
    );
    println!("提交：{}", lock.commit);
    println!("补丁集：{}", lock.patchset);
    if let Some(revision) = lock.dependency_revision {
        println!("依赖修订：r{revision}");
    }
    println!("控制协议：v{}", lock.control_protocol);
    Ok(())
}

pub(crate) fn validate_lock(lock: &UpstreamLock) -> Result<()> {
    validate_commit(&lock.commit)?;
    if lock.patchset == 0 || lock.control_protocol == 0 || lock.dependency_revision == Some(0) {
        bail!("upstream.lock.json 中的版本号必须大于 0");
    }
    if lock
        .compatibility
        .as_deref()
        .is_some_and(|profile| !valid_reference(profile))
    {
        bail!("upstream.lock.json 中的 compatibility 无效");
    }
    match lock.source {
        UpstreamSource::Action
            if lock.official_run_id.is_some_and(|run_id| run_id > 0)
                && lock.release_id.is_none()
                && lock.release_tag.is_none() => {}
        UpstreamSource::Release
            if lock.release_id.is_some_and(|release_id| release_id > 0)
                && lock.release_tag.as_deref().is_some_and(valid_reference)
                && lock.official_run_id.is_none() => {}
        _ => bail!("upstream.lock.json 中的来源元数据不完整"),
    }
    Ok(())
}

fn valid_reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub(crate) fn validate_commit(commit: &str) -> Result<()> {
    if commit.len() != 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("upstream.lock.json 中的 commit 必须是完整的 40 位十六进制 SHA");
    }
    Ok(())
}

fn run<I, S>(directory: &Path, program: &str, args: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let status = Command::new(program)
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .status()
        .with_context(|| format!("无法执行 {program}"))?;
    if !status.success() {
        bail!("命令 {program} 执行失败：{status}");
    }
    Ok(())
}

fn output<I, S>(directory: &Path, program: &str, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new(program)
        .args(args)
        .current_dir(directory)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("无法执行 {program}"))?;
    if !output.status.success() {
        bail!("命令 {program} 执行失败：{}", output.status);
    }
    String::from_utf8(output.stdout).context("命令输出不是 UTF-8")
}

fn print_help() {
    println!("KixDNS Panel 构建任务");
    println!("  cargo xtask info [--lock <锁文件>]     显示锁定的上游版本");
    println!("  cargo xtask prepare [--lock <锁文件>]  检出上游并应用增强补丁");
    println!("  cargo xtask rebase --lock <锁文件> --base-commit <SHA>  自动重基增强补丁");
    println!("  cargo xtask checkout-dir [--lock <锁文件>]  输出增强源码检出目录");
    println!("  cargo xtask audit --lock <锁文件> --advisory-db <目录>  审计增强源码的依赖");
    println!(
        "  cargo xtask refresh-dependencies --lock <锁文件> --advisory-db <目录>  生成依赖修订"
    );
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::{tempdir, tempdir_in};

    use super::{
        CheckoutPlaceholder, PatchSeries, UpstreamLock, UpstreamSource, activate_checkout,
        apply_patch_series, checkout_directory, inspect_checkout_placeholder, patch_series,
        patch_stamp, patches_for_lock, run, valid_lock_path, validate_commit, validate_lock,
    };

    fn release_lock(revision: Option<u32>) -> UpstreamLock {
        UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Release,
            commit: "647c5b1d2af6963176d7f8da6c3ed031e6b58497".to_owned(),
            official_run_id: None,
            release_id: Some(360_191_918),
            release_tag: Some("v0.1.1".to_owned()),
            compatibility: None,
            patchset: 9,
            control_protocol: 1,
            dependency_revision: revision,
        }
    }

    fn git(directory: &Path, arguments: &[&str]) {
        run(directory, "git", arguments).unwrap();
    }

    /// 以 `before` 为基准（暂存进索引），返回改成 `after` 的差异，然后还原工作区。
    /// Stages `before` as the base, returns the diff to `after`, then resets the tree.
    fn diff_between(directory: &Path, before: &[(&str, &str)], after: &[(&str, &str)]) -> String {
        for (file, content) in before {
            fs::write(directory.join(file), content).unwrap();
        }
        git(directory, &["add", "--all"]);
        for (file, content) in after {
            fs::write(directory.join(file), content).unwrap();
        }
        let diff = super::output(directory, "git", ["diff", "--full-index"]).unwrap();
        git(directory, &["reset", "--quiet", "--hard"]);
        diff
    }

    #[test]
    fn keeps_revisioned_checkouts_apart() {
        assert_eq!(
            checkout_directory(&release_lock(None)),
            Path::new(".upstream/kixdns-release-647c5b1d2af6-p9")
        );
        assert_eq!(
            checkout_directory(&release_lock(Some(2))),
            Path::new(".upstream/kixdns-release-647c5b1d2af6-p9-r2")
        );
    }

    #[test]
    fn rejects_revision_zero() {
        assert!(validate_lock(&release_lock(Some(1))).is_ok());
        assert!(validate_lock(&release_lock(Some(0))).is_err());
    }

    #[test]
    fn requires_the_referenced_revision_file() {
        let root = tempdir().unwrap();
        let common = root.path().join("patches/sets/9/common");
        fs::create_dir_all(&common).unwrap();
        fs::write(common.join("0001-common.patch"), "common").unwrap();

        let error = patch_series(root.path(), &release_lock(Some(1)))
            .err()
            .unwrap();
        assert!(error.to_string().contains("依赖修订不存在"));

        let revisions = root.path().join("patches/dependencies/release/v0.1.1");
        fs::create_dir_all(&revisions).unwrap();
        fs::write(revisions.join("p9-r1.patch"), "revision").unwrap();
        let series = patch_series(root.path(), &release_lock(Some(1))).unwrap();
        assert_eq!(series.revision.unwrap().1, revisions.join("p9-r1.patch"));
    }

    #[test]
    fn stamps_without_revision_keep_their_original_form() {
        let root = tempdir().unwrap();
        let patch = root.path().join("0001-common.patch");
        fs::write(&patch, "common").unwrap();
        let revision = root.path().join("p9-r1.patch");
        fs::write(&revision, "revision").unwrap();

        let plain = PatchSeries {
            patches: vec![patch.clone()],
            revision: None,
        };
        let stamp = patch_stamp(9, UpstreamSource::Release, &plain).unwrap();
        let lines = stamp.lines().collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[..2], ["source=release", "patchset=9"]);
        assert!(lines[2].starts_with("sha256="));

        let revised = PatchSeries {
            patches: vec![patch],
            revision: Some((1, revision)),
        };
        let revised_stamp = patch_stamp(9, UpstreamSource::Release, &revised).unwrap();
        assert!(revised_stamp.contains("dependency_revision=1\n"));
        assert_ne!(revised_stamp.lines().last(), stamp.lines().last());
    }

    #[test]
    fn revision_applies_last_on_top_of_the_patchset_lock() {
        let upstream = tempdir().unwrap();
        let tree = upstream.path();
        git(tree, &["init", "--quiet"]);
        git(tree, &["config", "core.autocrlf", "false"]);
        fs::write(tree.join("Cargo.lock"), "pristine\n").unwrap();
        fs::write(tree.join("source.rs"), "old\n").unwrap();
        git(tree, &["add", "--all"]);
        git(
            tree,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.com",
                "commit",
                "--quiet",
                "-m",
                "upstream",
            ],
        );

        // 一个同时改锁和源码的补丁、一个只改锁的补丁，以及从补丁集结果算起的修订。
        // One patch touching both the lock and the code, one lock-only patch, and a
        // revision taken from the lock the patchset produces.
        let patches = tempdir().unwrap();
        let mixed = patches.path().join("0001-mixed.patch");
        fs::write(
            &mixed,
            diff_between(
                tree,
                &[],
                &[("Cargo.lock", "mixed\n"), ("source.rs", "new\n")],
            ),
        )
        .unwrap();
        let lock_only = patches.path().join("0002-dependency-lock.patch");
        fs::write(
            &lock_only,
            diff_between(
                tree,
                &[("Cargo.lock", "mixed\n")],
                &[("Cargo.lock", "set-lock\n")],
            ),
        )
        .unwrap();
        let revision = patches.path().join("p9-r1.patch");
        fs::write(
            &revision,
            diff_between(
                tree,
                &[("Cargo.lock", "set-lock\n")],
                &[("Cargo.lock", "refreshed\n")],
            ),
        )
        .unwrap();

        let revised = PatchSeries {
            patches: vec![mixed.clone(), lock_only.clone()],
            revision: Some((1, revision)),
        };
        apply_patch_series(tree, &revised).unwrap();
        assert_eq!(
            fs::read_to_string(tree.join("Cargo.lock")).unwrap(),
            "refreshed\n"
        );
        assert_eq!(fs::read_to_string(tree.join("source.rs")).unwrap(), "new\n");

        git(tree, &["checkout", "--", "."]);
        let unrevised = PatchSeries {
            patches: vec![mixed, lock_only],
            revision: None,
        };
        apply_patch_series(tree, &unrevised).unwrap();
        assert_eq!(
            fs::read_to_string(tree.join("Cargo.lock")).unwrap(),
            "set-lock\n"
        );
        assert_eq!(fs::read_to_string(tree.join("source.rs")).unwrap(), "new\n");
    }

    #[test]
    fn accepts_full_commit_sha() {
        assert!(validate_commit("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_ok());
    }

    #[test]
    fn rejects_short_or_non_hex_commit() {
        assert!(validate_commit("374d63c").is_err());
        assert!(validate_commit("z74d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_err());
    }

    #[test]
    fn rejects_incomplete_source_identity() {
        let lock = UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Release,
            commit: "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned(),
            official_run_id: None,
            release_id: None,
            release_tag: Some("v0.1.1".to_owned()),
            compatibility: None,
            patchset: 5,
            control_protocol: 1,
            dependency_revision: None,
        };
        assert!(validate_lock(&lock).is_err());
    }

    #[test]
    fn selects_only_the_patchset_referenced_by_the_lock() {
        let root = tempdir().unwrap();
        for patchset in [5, 6] {
            let common = root
                .path()
                .join("patches")
                .join("sets")
                .join(patchset.to_string())
                .join("common");
            fs::create_dir_all(&common).unwrap();
            fs::write(common.join("0001-common.patch"), patchset.to_string()).unwrap();
        }
        let compatibility = root
            .path()
            .join("patches/sets/5/compatibility/pre-local-time");
        fs::create_dir_all(&compatibility).unwrap();
        fs::write(
            compatibility.join("0000-compatibility.patch"),
            "compatibility",
        )
        .unwrap();

        let lock = UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Action,
            commit: "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned(),
            official_run_id: Some(30_235_703_570),
            release_id: None,
            release_tag: None,
            compatibility: Some("pre-local-time".to_owned()),
            patchset: 5,
            control_protocol: 1,
            dependency_revision: None,
        };

        let patches = patches_for_lock(root.path(), &lock).unwrap();
        assert_eq!(patches.len(), 2);
        assert!(
            patches
                .iter()
                .all(|path| path.starts_with(root.path().join("patches/sets/5")))
        );
        assert!(
            patches
                .iter()
                .all(|path| !path.starts_with(root.path().join("patches/sets/6")))
        );
    }

    #[test]
    fn rejects_missing_compatibility_profile() {
        let root = tempdir().unwrap();
        let common = root.path().join("patches/sets/5/common");
        fs::create_dir_all(&common).unwrap();
        fs::write(common.join("0001-common.patch"), "common").unwrap();
        let lock = UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Action,
            commit: "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25".to_owned(),
            official_run_id: Some(30_235_703_570),
            release_id: None,
            release_tag: None,
            compatibility: Some("missing".to_owned()),
            patchset: 5,
            control_protocol: 1,
            dependency_revision: None,
        };

        let error = patches_for_lock(root.path(), &lock).unwrap_err();
        assert!(error.to_string().contains("缺少兼容层 missing"));
    }

    #[test]
    fn accepts_only_scoped_catalog_locks() {
        assert!(valid_lock_path(Path::new("upstream.lock.json")));
        assert!(valid_lock_path(Path::new(
            "upstreams/actions/30235703570.json"
        )));
        assert!(valid_lock_path(Path::new("upstreams/releases/v0.1.1.json")));
        assert!(!valid_lock_path(Path::new("../upstream.lock.json")));
        assert!(!valid_lock_path(Path::new(
            "upstreams/actions/bad/name.json"
        )));
        assert!(!valid_lock_path(Path::new("upstreams/other/v0.1.1.json")));
    }

    #[test]
    fn recognizes_safe_checkout_placeholders() {
        let root = tempdir().unwrap();
        let missing = root.path().join("missing");
        assert_eq!(
            inspect_checkout_placeholder(&missing).unwrap(),
            CheckoutPlaceholder::Missing
        );

        let empty = root.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert_eq!(
            inspect_checkout_placeholder(&empty).unwrap(),
            CheckoutPlaceholder::Empty
        );

        let cached = root.path().join("cached");
        fs::create_dir(&cached).unwrap();
        fs::create_dir(cached.join("target")).unwrap();
        assert_eq!(
            inspect_checkout_placeholder(&cached).unwrap(),
            CheckoutPlaceholder::CachedTarget
        );
    }

    #[test]
    fn rejects_unknown_partial_checkouts() {
        let root = tempdir().unwrap();
        let checkout = root.path().join("checkout");
        fs::create_dir(&checkout).unwrap();
        fs::write(checkout.join("README"), "保留").unwrap();

        let error = inspect_checkout_placeholder(&checkout).unwrap_err();
        assert!(error.to_string().contains("包含未知内容"));
    }

    #[test]
    fn activates_checkout_without_discarding_cached_target() {
        let root = tempdir().unwrap();
        let checkout = root.path().join("checkout");
        fs::create_dir(&checkout).unwrap();
        fs::create_dir(checkout.join("target")).unwrap();
        fs::write(checkout.join("target/cache"), "cached").unwrap();
        let staging = tempdir_in(root.path()).unwrap();
        fs::write(staging.path().join("source"), "checked out").unwrap();

        activate_checkout(staging, &checkout, CheckoutPlaceholder::CachedTarget).unwrap();

        assert_eq!(
            fs::read_to_string(checkout.join("source")).unwrap(),
            "checked out"
        );
        assert_eq!(
            fs::read_to_string(checkout.join("target/cache")).unwrap(),
            "cached"
        );
    }
}
