use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde_json::{Number, Value};
use tempfile::Builder;

use crate::{
    UpstreamLock, UpstreamSource, load_lock, patches_for_lock, valid_lock_path, validate_commit,
    validate_lock,
};

const COMMIT_PREFIX: &str = "kixdns-overlay:";
const LOCK_FILE: &str = "Cargo.lock";

pub(crate) struct Options {
    pub(crate) lock_file: PathBuf,
    pub(crate) base_commit: String,
}

impl Options {
    pub(crate) fn parse(mut arguments: impl Iterator<Item = String>) -> Result<Self> {
        let mut lock_file = None;
        let mut base_commit = None;

        while let Some(flag) = arguments.next() {
            let value = arguments
                .next()
                .with_context(|| format!("{flag} 缺少参数值"))?;
            match flag.as_str() {
                "--lock" if lock_file.is_none() => lock_file = Some(PathBuf::from(value)),
                "--base-commit" if base_commit.is_none() => base_commit = Some(value),
                "--lock" | "--base-commit" => bail!("重复的参数：{flag}"),
                _ => bail!("未知的 rebase 参数：{flag}"),
            }
        }

        let lock_file = lock_file.context("rebase 需要 --lock")?;
        if !valid_lock_path(&lock_file) {
            bail!("--lock 必须是受支持的上游锁文件");
        }
        let base_commit = base_commit.context("rebase 需要 --base-commit")?;
        validate_commit(&base_commit)?;

        Ok(Self {
            lock_file,
            base_commit,
        })
    }
}

pub(crate) fn rebase_patchset(root: &Path, options: &Options) -> Result<()> {
    let candidate = load_lock(root, &options.lock_file)?;
    validate_lock(&candidate)?;
    if candidate.commit == options.base_commit {
        bail!("候选提交与补丁基准相同，无需重基");
    }

    let base = find_base_lock(root, &candidate, &options.base_commit)?;
    let source_patches = patches_for_lock(root, &base)?;
    let next_patchset = next_patchset(root)?;
    let checkout = build_rebased_overlay(root, &base, &candidate, &source_patches)?;
    let export = export_overlay(root, checkout.path(), &base, &candidate, next_patchset)?;
    persist_patchset(root, &options.lock_file, &base, next_patchset, export)?;

    println!(
        "自动重基完成：{} -> {}，新补丁集 p{}",
        &base.commit[..12],
        &candidate.commit[..12],
        next_patchset
    );
    Ok(())
}

fn find_base_lock(root: &Path, candidate: &UpstreamLock, commit: &str) -> Result<UpstreamLock> {
    let mut matches = Vec::new();
    for path in lock_catalog_paths(root)? {
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("读取补丁基准候选失败：{}", path.display()))?;
        let lock: UpstreamLock = serde_json::from_str(&raw)
            .with_context(|| format!("解析补丁基准候选失败：{}", path.display()))?;
        if lock.commit == commit
            && lock.repository == candidate.repository
            && lock.source == candidate.source
            && lock.patchset == candidate.patchset
        {
            validate_lock(&lock)?;
            matches.push(lock);
        }
    }

    let base = matches
        .into_iter()
        .next()
        .with_context(|| format!("版本目录中找不到补丁基准提交 {commit}"))?;
    Ok(base)
}

fn lock_catalog_paths(root: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = vec![
        root.join("upstream.lock.json"),
        root.join("upstream.release.lock.json"),
    ];
    for directory in ["upstreams/actions", "upstreams/releases"] {
        let directory = root.join(directory);
        if !directory.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("读取版本目录失败：{}", directory.display()))?
        {
            let path = entry?.path();
            if path.extension() == Some(OsStr::new("json")) {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

fn next_patchset(root: &Path) -> Result<u32> {
    let directory = root.join("patches/sets");
    let mut highest = 0_u32;
    for entry in fs::read_dir(&directory)
        .with_context(|| format!("读取补丁集目录失败：{}", directory.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let common = entry.path().join("common");
        let has_common_patch = common.is_dir()
            && fs::read_dir(&common)
                .with_context(|| format!("读取通用补丁目录失败：{}", common.display()))?
                .filter_map(Result::ok)
                .any(|item| item.path().extension() == Some(OsStr::new("patch")));
        if !has_common_patch {
            continue;
        }
        let Some(value) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        else {
            continue;
        };
        highest = highest.max(value);
    }
    highest.checked_add(1).context("补丁集编号溢出")
}

fn build_rebased_overlay(
    root: &Path,
    base: &UpstreamLock,
    candidate: &UpstreamLock,
    patches: &[PathBuf],
) -> Result<tempfile::TempDir> {
    let source_root = root.join(".upstream");
    fs::create_dir_all(&source_root).context("创建 .upstream 目录失败")?;
    let checkout = Builder::new()
        .prefix(".kixdns-overlay-rebase-")
        .tempdir_in(&source_root)
        .context("创建 overlay 重基目录失败")?;
    let url = format!("https://github.com/{}.git", base.repository);

    let clone_arguments = vec![
        OsString::from("clone"),
        OsString::from("--filter=blob:none"),
        OsString::from("--no-checkout"),
        OsString::from(url),
        checkout.path().as_os_str().to_owned(),
    ];
    run_program(root, "git", clone_arguments)?;
    run_git(checkout.path(), ["config", "core.autocrlf", "false"])?;
    run_git(checkout.path(), ["config", "core.eol", "lf"])?;
    fetch_commit(checkout.path(), &base.commit)?;
    fetch_commit(checkout.path(), &candidate.commit)?;
    run_git(checkout.path(), ["checkout", "--detach", &base.commit])?;
    run_git(
        checkout.path(),
        ["config", "user.name", "kixdns-overlay-bot"],
    )?;
    run_git(
        checkout.path(),
        [
            "config",
            "user.email",
            "kixdns-overlay-bot@users.noreply.github.com",
        ],
    )?;

    let patchset_root = root.join("patches/sets").join(base.patchset.to_string());
    let mut replayed = 0_usize;
    for patch in patches {
        if !patch_changes_non_lock(patch)? {
            continue;
        }
        let relative = patch
            .strip_prefix(&patchset_root)
            .with_context(|| format!("补丁不属于 p{}：{}", base.patchset, patch.display()))?;
        apply_without_lock(checkout.path(), patch)?;
        commit_overlay(checkout.path(), relative)?;
        replayed += 1;
    }
    if replayed == 0 {
        bail!("补丁集 p{} 没有可重基的源码变更", base.patchset);
    }

    let overlay_head = git_output(checkout.path(), ["rev-parse", "HEAD"])?;
    rebase_commits(
        checkout.path(),
        &base.commit,
        &candidate.commit,
        overlay_head.trim(),
    )?;
    regenerate_lock(checkout.path(), patches)?;
    Ok(checkout)
}

fn fetch_commit(checkout: &Path, commit: &str) -> Result<()> {
    run_git(checkout, ["fetch", "--depth", "1", "origin", commit])
        .with_context(|| format!("获取上游提交 {commit} 失败"))
}

fn apply_without_lock(checkout: &Path, patch: &Path) -> Result<()> {
    let raw = fs::read_to_string(patch)
        .with_context(|| format!("读取 overlay 补丁失败：{}", patch.display()))?;
    let mut normalized = Builder::new()
        .suffix(".patch")
        .tempfile()
        .context("创建规范化补丁暂存文件失败")?;
    normalized
        .write_all(raw.replace("\r\n", "\n").as_bytes())
        .context("写入规范化补丁失败")?;
    normalized.flush().context("刷新规范化补丁失败")?;
    let arguments = vec![
        OsString::from("apply"),
        OsString::from("--exclude=Cargo.lock"),
        normalized.path().as_os_str().to_owned(),
    ];
    run_program(checkout, "git", arguments)
        .with_context(|| format!("重建 overlay 提交失败：{}", patch.display()))?;
    run_git(checkout, ["add", "--all"])
        .with_context(|| format!("暂存 overlay 提交失败：{}", patch.display()))
}

fn commit_overlay(checkout: &Path, relative: &Path) -> Result<()> {
    let relative = normalized_relative(relative)?;
    let subject = format!("{COMMIT_PREFIX}{relative}");
    run_git(checkout, ["commit", "--no-gpg-sign", "-m", &subject])
        .with_context(|| format!("提交 overlay 变更失败：{relative}"))
}

fn rebase_commits(checkout: &Path, base: &str, candidate: &str, head: &str) -> Result<()> {
    let status = Command::new("git")
        .args(["rebase", "--empty=drop", "--onto", candidate, base, head])
        .current_dir(checkout)
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .stdin(Stdio::null())
        .status()
        .context("无法执行 git rebase")?;
    if status.success() {
        return Ok(());
    }

    let conflicts = git_output_allow_failure(checkout, ["diff", "--name-only", "--diff-filter=U"])?;
    let conflicts = conflicts.trim();
    if conflicts.is_empty() {
        bail!("overlay 自动重基失败，Git 未报告冲突文件");
    }
    bail!("overlay 自动重基存在代码冲突：\n{conflicts}")
}

fn regenerate_lock(checkout: &Path, source_patches: &[PathBuf]) -> Result<()> {
    let lock = checkout.join(LOCK_FILE);
    if lock.exists() {
        fs::remove_file(&lock).context("移除候选 Cargo.lock 失败")?;
    }

    let output = Command::new("cargo")
        .arg("generate-lockfile")
        .current_dir(checkout)
        .env("CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS", "fallback")
        .stdin(Stdio::null())
        .output()
        .context("无法执行 cargo generate-lockfile")?;
    std::io::stdout()
        .write_all(&output.stdout)
        .context("输出 cargo generate-lockfile 标准输出失败")?;
    std::io::stderr()
        .write_all(&output.stderr)
        .context("输出 cargo generate-lockfile 错误日志失败")?;
    if !output.status.success() {
        if cargo_network_failure(&output.stderr) {
            bail!("Cargo.lock 解析基础设施失败：{}", output.status);
        }
        bail!("重新解析 Cargo.lock 失败：{}", output.status);
    }
    if !lock.is_file() {
        bail!("cargo generate-lockfile 未生成 Cargo.lock");
    }

    run_git(checkout, ["add", "--", LOCK_FILE])?;
    if git_cached_is_clean(checkout)? {
        return Ok(());
    }
    let number = next_lock_patch_number(source_patches)?;
    let relative = format!("common/{number:04}-dependency-lock.patch");
    let subject = format!("{COMMIT_PREFIX}{relative}");
    run_git(checkout, ["commit", "--no-gpg-sign", "-m", &subject])
        .context("提交自动解析的 Cargo.lock 失败")
}

fn next_lock_patch_number(patches: &[PathBuf]) -> Result<u32> {
    let mut highest = 0;
    for patch in patches {
        if !patch_changes_non_lock(patch)? {
            continue;
        }
        let Some(name) = patch.file_stem().and_then(OsStr::to_str) else {
            continue;
        };
        let Some(prefix) = name.split('-').next() else {
            continue;
        };
        if let Ok(number) = prefix.parse::<u32>() {
            highest = highest.max(number);
        }
    }
    highest.checked_add(1).context("Cargo.lock 补丁编号溢出")
}

struct ExportedOverlay {
    staging: tempfile::TempDir,
    compatibility: Option<String>,
}

fn export_overlay(
    root: &Path,
    checkout: &Path,
    base: &UpstreamLock,
    candidate: &UpstreamLock,
    patchset: u32,
) -> Result<ExportedOverlay> {
    let sets = root.join("patches/sets");
    let destination = sets.join(patchset.to_string());
    if destination.exists() {
        bail!("目标补丁集已经存在：{}", destination.display());
    }
    let staging = Builder::new()
        .prefix(&format!(".p{patchset}-"))
        .tempdir_in(&sets)
        .context("创建补丁集暂存目录失败")?;

    copy_capabilities(root, base.patchset, staging.path())?;
    let commits = git_output(
        checkout,
        [
            "rev-list",
            "--reverse",
            &format!("{}..HEAD", candidate.commit),
        ],
    )?;
    let mut written = HashSet::new();
    let mut common_count = 0_usize;
    let mut compatibility = None;

    for commit in commits.lines().filter(|line| !line.is_empty()) {
        let subject = git_output(checkout, ["show", "-s", "--format=%s", commit])?;
        let relative = subject
            .trim()
            .strip_prefix(COMMIT_PREFIX)
            .with_context(|| format!("重基提交缺少 overlay 身份：{commit}"))?;
        let relative = remap_export_path(Path::new(relative), base, candidate)?;
        let normalized = normalized_relative(&relative)?;
        if !written.insert(normalized.clone()) {
            bail!("重基后生成了重复补丁：{normalized}");
        }
        if normalized.starts_with("common/") {
            common_count += 1;
        } else if normalized.starts_with("compatibility/") {
            compatibility.clone_from(&base.compatibility);
        }

        let output = staging.path().join(&relative);
        let parent = output.parent().context("补丁输出路径缺少父目录")?;
        fs::create_dir_all(parent)
            .with_context(|| format!("创建补丁输出目录失败：{}", parent.display()))?;
        let patch = git_output_bytes(
            checkout,
            ["show", "--format=", "--binary", "--full-index", commit],
        )?;
        if patch.is_empty() {
            bail!("重基提交没有可导出的差异：{commit}");
        }
        fs::write(&output, patch)
            .with_context(|| format!("写入重基补丁失败：{}", output.display()))?;
    }

    if common_count == 0 {
        bail!("重基结果缺少通用补丁，拒绝生成不可用的 p{patchset}");
    }
    Ok(ExportedOverlay {
        staging,
        compatibility,
    })
}

fn remap_export_path(
    relative: &Path,
    base: &UpstreamLock,
    candidate: &UpstreamLock,
) -> Result<PathBuf> {
    let components = normal_components(relative)?;
    match components.as_slice() {
        [category, file] if category == "common" => Ok(PathBuf::from(category).join(file)),
        [category, profile, file] if category == "compatibility" => {
            if base.compatibility.as_deref() != Some(profile.as_str()) {
                bail!("overlay 兼容层与基准锁文件不一致：{profile}");
            }
            Ok(PathBuf::from(category).join(profile).join(file))
        }
        [category, _, file] if category == "release" => {
            if candidate.source != UpstreamSource::Release {
                bail!("Action 轨道不能导出 Release 专用补丁");
            }
            let tag = candidate
                .release_tag
                .as_deref()
                .context("候选 Release 缺少标签")?;
            Ok(PathBuf::from(category).join(tag).join(file))
        }
        _ => bail!("不支持的 overlay 补丁路径：{}", relative.display()),
    }
}

fn copy_capabilities(root: &Path, patchset: u32, staging: &Path) -> Result<()> {
    let source = root
        .join("patches/sets")
        .join(patchset.to_string())
        .join("capabilities.json");
    if source.is_file() {
        fs::copy(&source, staging.join("capabilities.json"))
            .with_context(|| format!("复制能力清单失败：{}", source.display()))?;
    }
    Ok(())
}

fn persist_patchset(
    root: &Path,
    lock_file: &Path,
    base: &UpstreamLock,
    patchset: u32,
    export: ExportedOverlay,
) -> Result<()> {
    let lock_path = root.join(lock_file);
    let lock_raw = fs::read_to_string(&lock_path)
        .with_context(|| format!("读取候选锁文件失败：{}", lock_path.display()))?;
    let mut lock_value: Value = serde_json::from_str(&lock_raw)
        .with_context(|| format!("解析候选锁文件失败：{}", lock_path.display()))?;
    let object = lock_value
        .as_object_mut()
        .context("候选锁文件根节点必须是对象")?;
    object.insert("patchset".to_owned(), Value::Number(Number::from(patchset)));
    if let Some(profile) = export.compatibility.as_deref() {
        object.insert(
            "compatibility".to_owned(),
            Value::String(profile.to_owned()),
        );
    } else {
        object.remove("compatibility");
    }

    let parent = lock_path.parent().context("候选锁文件缺少父目录")?;
    let mut lock_staging = Builder::new()
        .prefix(".upstream-lock-")
        .tempfile_in(parent)
        .context("创建候选锁文件暂存文件失败")?;
    serde_json::to_writer_pretty(&mut lock_staging, &lock_value).context("序列化候选锁文件失败")?;
    writeln!(lock_staging).context("写入候选锁文件换行失败")?;
    lock_staging
        .as_file_mut()
        .sync_all()
        .context("同步候选锁文件失败")?;

    let destination = root.join("patches/sets").join(patchset.to_string());
    let staging = export.staging.keep();
    fs::rename(&staging, &destination)
        .with_context(|| format!("启用重基补丁集失败；暂存内容保留在 {}", staging.display()))?;
    if let Err(error) = lock_staging.persist(&lock_path) {
        let rollback = fs::remove_dir_all(&destination);
        if let Err(rollback_error) = rollback {
            bail!(
                "写入候选锁文件失败：{}；同时无法回滚 {}：{}",
                error.error,
                destination.display(),
                rollback_error
            );
        }
        return Err(error.error).context("写入候选锁文件失败，已回滚新补丁集");
    }

    println!("已从 p{} 生成密封候选补丁集 p{}", base.patchset, patchset);
    Ok(())
}

fn patch_changes_non_lock(path: &Path) -> Result<bool> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("读取补丁失败：{}", path.display()))?;
    let mut has_diff = false;
    for line in raw.lines() {
        let Some(paths) = line.strip_prefix("diff --git a/") else {
            continue;
        };
        has_diff = true;
        let Some((before, after)) = paths.split_once(" b/") else {
            bail!("无法解析补丁文件路径：{}", path.display());
        };
        if before != LOCK_FILE || after != LOCK_FILE {
            return Ok(true);
        }
    }
    if !has_diff {
        bail!("补丁不包含 Git 差异：{}", path.display());
    }
    Ok(false)
}

fn cargo_network_failure(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    [
        "spurious network error",
        "failed to download from",
        "could not resolve host",
        "failed to connect",
        "operation timed out",
        "network failure",
        "connection reset",
    ]
    .iter()
    .any(|pattern| stderr.contains(pattern))
}

fn normalized_relative(path: &Path) -> Result<String> {
    Ok(normal_components(path)?.join("/"))
}

fn normal_components(path: &Path) -> Result<Vec<String>> {
    let mut values = Vec::new();
    for component in path.components() {
        let Component::Normal(value) = component else {
            bail!("overlay 路径不能包含跳转或绝对路径：{}", path.display());
        };
        let value = value.to_str().context("overlay 路径不是 UTF-8")?;
        if value.is_empty() {
            bail!("overlay 路径包含空组件");
        }
        values.push(value.to_owned());
    }
    let Some(file) = values.last() else {
        bail!("overlay 路径不能为空");
    };
    if Path::new(file).extension() != Some(OsStr::new("patch")) {
        bail!("overlay 路径必须指向 .patch 文件：{}", path.display());
    }
    Ok(values)
}

fn git_cached_is_clean(directory: &Path) -> Result<bool> {
    let status = Command::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(directory)
        .stdin(Stdio::null())
        .status()
        .context("无法检查 Git 暂存区")?;
    match status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => bail!("检查 Git 暂存区失败：{status}"),
    }
}

fn run_git<I, S>(directory: &Path, arguments: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_program(directory, "git", arguments)
}

fn run_program<I, S>(directory: &Path, program: &str, arguments: I) -> Result<()>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let status = Command::new(program)
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::null())
        .status()
        .with_context(|| format!("无法执行 {program}"))?;
    if !status.success() {
        bail!("命令 {program} 执行失败：{status}");
    }
    Ok(())
}

fn git_output<I, S>(directory: &Path, arguments: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_output_bytes(directory, arguments)?;
    String::from_utf8(output).context("Git 输出不是 UTF-8")
}

fn git_output_allow_failure<I, S>(directory: &Path, arguments: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::null())
        .output()
        .context("无法读取 Git 输出")?;
    String::from_utf8(output.stdout).context("Git 输出不是 UTF-8")
}

fn git_output_bytes<I, S>(directory: &Path, arguments: I) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .args(arguments)
        .current_dir(directory)
        .stdin(Stdio::null())
        .output()
        .context("无法读取 Git 输出")?;
    if !output.status.success() {
        bail!(
            "Git 命令执行失败：{}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use tempfile::tempdir;

    use super::{
        Options, apply_without_lock, cargo_network_failure, git_output, next_lock_patch_number,
        next_patchset, normalized_relative, patch_changes_non_lock, rebase_commits, run_git,
    };

    fn initialize_repository(path: &Path) {
        run_git(path, ["init"]).unwrap();
        run_git(path, ["config", "core.autocrlf", "false"]).unwrap();
        run_git(path, ["config", "user.name", "overlay-test"]).unwrap();
        run_git(path, ["config", "user.email", "overlay-test@example.com"]).unwrap();
    }

    #[test]
    fn parses_rebase_options_in_any_order() {
        let options = Options::parse(
            [
                "--base-commit",
                "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25",
                "--lock",
                "upstream.lock.json",
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(options.lock_file, PathBuf::from("upstream.lock.json"));
        assert_eq!(
            options.base_commit,
            "374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25"
        );
    }

    #[test]
    fn rejects_unsafe_overlay_paths() {
        assert!(normalized_relative(Path::new("common/0001-safe.patch")).is_ok());
        assert!(normalized_relative(Path::new("../outside.patch")).is_err());
        assert!(normalized_relative(Path::new("common/not-a-patch.txt")).is_err());
    }

    #[test]
    fn separates_source_changes_from_generated_lock_changes() {
        let root = tempdir().unwrap();
        let lock_only = root.path().join("0001-lock.patch");
        fs::write(
            &lock_only,
            "diff --git a/Cargo.lock b/Cargo.lock\n--- a/Cargo.lock\n+++ b/Cargo.lock\n",
        )
        .unwrap();
        assert!(!patch_changes_non_lock(&lock_only).unwrap());

        let mixed = root.path().join("0002-mixed.patch");
        fs::write(
            &mixed,
            "diff --git a/Cargo.lock b/Cargo.lock\ndiff --git a/src/lib.rs b/src/lib.rs\n",
        )
        .unwrap();
        assert!(patch_changes_non_lock(&mixed).unwrap());
        assert_eq!(next_lock_patch_number(&[lock_only, mixed]).unwrap(), 3);
    }

    #[test]
    fn ignores_empty_patchset_placeholders() {
        let root = tempdir().unwrap();
        let common = root.path().join("patches/sets/11/common");
        fs::create_dir_all(&common).unwrap();
        fs::write(common.join("0001-source.patch"), "diff --git a/a b/a\n").unwrap();
        fs::create_dir_all(root.path().join("patches/sets/12")).unwrap();

        assert_eq!(next_patchset(root.path()).unwrap(), 12);
    }

    #[test]
    fn classifies_only_transport_errors_as_lock_infrastructure_failures() {
        assert!(cargo_network_failure(
            b"warning: spurious network error: operation timed out"
        ));
        assert!(!cargo_network_failure(
            b"failed to select a version for the requirement `demo = ^2`"
        ));
    }

    #[test]
    fn replays_crlf_patch_without_lockfile_changes() {
        let root = tempdir().unwrap();
        initialize_repository(root.path());
        fs::write(root.path().join("Cargo.lock"), "old-lock\n").unwrap();
        fs::write(root.path().join("source.txt"), "old-source\n").unwrap();
        run_git(root.path(), ["add", "--all"]).unwrap();
        run_git(root.path(), ["commit", "-m", "base"]).unwrap();

        let patch = root.path().join("overlay.patch");
        fs::write(
            &patch,
            concat!(
                "diff --git a/Cargo.lock b/Cargo.lock\r\n",
                "--- a/Cargo.lock\r\n",
                "+++ b/Cargo.lock\r\n",
                "@@ -1 +1 @@\r\n",
                "-old-lock\r\n",
                "+new-lock\r\n",
                "diff --git a/source.txt b/source.txt\r\n",
                "--- a/source.txt\r\n",
                "+++ b/source.txt\r\n",
                "@@ -1 +1 @@\r\n",
                "-old-source\r\n",
                "+new-source\r\n",
            ),
        )
        .unwrap();

        apply_without_lock(root.path(), &patch).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("Cargo.lock")).unwrap(),
            "old-lock\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("source.txt")).unwrap(),
            "new-source\n"
        );
    }

    #[test]
    fn drops_overlay_commit_already_present_upstream() {
        let root = tempdir().unwrap();
        initialize_repository(root.path());
        fs::write(root.path().join("feature.txt"), "disabled\n").unwrap();
        run_git(root.path(), ["add", "--all"]).unwrap();
        run_git(root.path(), ["commit", "-m", "base"]).unwrap();
        let base = git_output(root.path(), ["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();

        run_git(root.path(), ["switch", "-c", "candidate"]).unwrap();
        fs::write(root.path().join("feature.txt"), "enabled\n").unwrap();
        run_git(root.path(), ["add", "--all"]).unwrap();
        run_git(root.path(), ["commit", "-m", "upstream feature"]).unwrap();
        let candidate = git_output(root.path(), ["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();

        run_git(root.path(), ["checkout", "--detach", &base]).unwrap();
        fs::write(root.path().join("feature.txt"), "enabled\n").unwrap();
        run_git(root.path(), ["add", "--all"]).unwrap();
        run_git(
            root.path(),
            ["commit", "-m", "kixdns-overlay:common/0001-feature.patch"],
        )
        .unwrap();
        let overlay = git_output(root.path(), ["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();

        rebase_commits(root.path(), &base, &candidate, &overlay).unwrap();
        assert_eq!(
            git_output(root.path(), ["rev-parse", "HEAD"])
                .unwrap()
                .trim(),
            candidate
        );
    }
}
