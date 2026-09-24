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
    UpstreamLock, UpstreamSource, apply_patch, load_lock, patches_for_lock, valid_lock_path,
    validate_commit, validate_lock,
};

const COMMIT_PREFIX: &str = "kixdns-overlay:";
const LOCK_FILE: &str = "Cargo.lock";

pub(crate) struct Options {
    pub(crate) lock_file: PathBuf,
    pub(crate) base_commit: String,
    /// 补丁基准所在的轨道，缺省与候选相同。新 Release 并入 Action 的补丁集时取 Action。
    /// The track the base lock belongs to, the candidate's by default. A new release
    /// joining the action track's patchset takes it from the action track.
    pub(crate) base_source: Option<UpstreamSource>,
    /// 并入基准的补丁集：只新增一个兼容层，编号不变。
    /// Join the base patchset: add one compatibility layer and keep the number.
    pub(crate) join: bool,
}

impl Options {
    pub(crate) fn parse(mut arguments: impl Iterator<Item = String>) -> Result<Self> {
        let mut lock_file = None;
        let mut base_commit = None;
        let mut base_source = None;
        let mut join = false;

        while let Some(flag) = arguments.next() {
            if flag == "--join" {
                if join {
                    bail!("重复的参数：{flag}");
                }
                join = true;
                continue;
            }
            let value = arguments
                .next()
                .with_context(|| format!("{flag} 缺少参数值"))?;
            match flag.as_str() {
                "--lock" if lock_file.is_none() => lock_file = Some(PathBuf::from(value)),
                "--base-commit" if base_commit.is_none() => base_commit = Some(value),
                "--base-source" if base_source.is_none() => {
                    base_source = Some(match value.as_str() {
                        "action" => UpstreamSource::Action,
                        "release" => UpstreamSource::Release,
                        _ => bail!("--base-source 只能是 action 或 release"),
                    });
                }
                "--lock" | "--base-commit" | "--base-source" => bail!("重复的参数：{flag}"),
                _ => bail!("未知的 rebase 参数：{flag}"),
            }
        }

        let lock_file = lock_file.context("rebase 需要 --lock")?;
        if !valid_lock_path(&lock_file) {
            bail!("--lock 必须是受支持的上游锁文件");
        }
        let base_commit = base_commit.context("rebase 需要 --base-commit")?;
        validate_commit(&base_commit)?;
        if base_source.is_some() && !join {
            bail!("--base-source 只能与 --join 一起使用：跨轨道只允许并入，不生成新补丁集");
        }

        Ok(Self {
            lock_file,
            base_commit,
            base_source,
            join,
        })
    }
}

pub(crate) fn rebase_patchset(root: &Path, options: &Options) -> Result<()> {
    let candidate = load_lock(root, &options.lock_file)?;
    validate_lock(&candidate)?;
    if candidate.commit == options.base_commit {
        bail!("候选提交与补丁基准相同，无需重基");
    }

    let base_source = options.base_source.unwrap_or(candidate.source);
    let base = find_base_lock(root, &candidate, &options.base_commit, base_source)?;
    let source_patches = patches_for_lock(root, &base)?;
    if options.join {
        return join_patchset(root, &options.lock_file, &base, &candidate, &source_patches);
    }
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

fn find_base_lock(
    root: &Path,
    candidate: &UpstreamLock,
    commit: &str,
    source: UpstreamSource,
) -> Result<UpstreamLock> {
    let mut matches = Vec::new();
    for path in lock_catalog_paths(root)? {
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("读取补丁基准候选失败：{}", path.display()))?;
        let lock: UpstreamLock = serde_json::from_str(&raw)
            .with_context(|| format!("解析补丁基准候选失败：{}", path.display()))?;
        if lock.commit == commit
            && lock.repository == candidate.repository
            && lock.source == source
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
    let lock_patch = lock_patch_path(patches, &patchset_root, base.compatibility.as_deref())?;
    regenerate_lock(checkout.path(), &lock_patch)?;
    Ok(checkout)
}

/// 重新解析的依赖锁放在哪。依赖锁只对这一份上游成立：有兼容层时放进兼容层，通用层才能
/// 原样给别的上游共用；没有兼容层的旧补丁集照旧放在通用层末尾。
///
/// Where the re-resolved Cargo.lock goes. A lockfile holds for one upstream tree only, so
/// with a compatibility layer it goes there and the common layer stays shareable as is;
/// older patchsets without one keep it at the end of the common layer.
fn lock_patch_path(
    patches: &[PathBuf],
    patchset_root: &Path,
    compatibility: Option<&str>,
) -> Result<String> {
    let layer = match compatibility {
        Some(profile) => format!("compatibility/{profile}"),
        None => "common".to_owned(),
    };
    let directory = patchset_root.join(&layer);
    let layer_patches = patches
        .iter()
        .filter(|patch| patch.parent() == Some(directory.as_path()))
        .cloned()
        .collect::<Vec<_>>();
    let number = next_lock_patch_number(&layer_patches)?;
    Ok(format!("{layer}/{number:04}-dependency-lock.patch"))
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

fn regenerate_lock(checkout: &Path, relative: &str) -> Result<()> {
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
    let destination = root.join("patches/sets").join(patchset.to_string());
    enable_with_lock(
        &root.join(lock_file),
        patchset,
        export.compatibility.as_deref(),
        export.staging,
        &destination,
    )?;
    println!("已从 p{} 生成密封候选补丁集 p{}", base.patchset, patchset);
    Ok(())
}

/// 启用暂存好的补丁目录，并把候选锁指向它；锁写不进去时撤回目录，不留半个结果。
/// Enables the staged patch directory and points the candidate lock at it; if the lock
/// cannot be written the directory is withdrawn, so no half result remains.
fn enable_with_lock(
    lock_path: &Path,
    patchset: u32,
    compatibility: Option<&str>,
    staging: tempfile::TempDir,
    destination: &Path,
) -> Result<()> {
    let lock_raw = fs::read_to_string(lock_path)
        .with_context(|| format!("读取候选锁文件失败：{}", lock_path.display()))?;
    let mut lock_value: Value = serde_json::from_str(&lock_raw)
        .with_context(|| format!("解析候选锁文件失败：{}", lock_path.display()))?;
    let object = lock_value
        .as_object_mut()
        .context("候选锁文件根节点必须是对象")?;
    object.insert("patchset".to_owned(), Value::Number(Number::from(patchset)));
    if let Some(profile) = compatibility {
        object.insert(
            "compatibility".to_owned(),
            Value::String(profile.to_owned()),
        );
    } else {
        object.remove("compatibility");
    }
    // 依赖修订属于旧的补丁组合；新的组合自带重新解析的 Cargo.lock。
    // A dependency revision belongs to the old combination; the new one carries a freshly
    // resolved Cargo.lock.
    object.remove("dependency_revision");

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

    let staging = staging.keep();
    fs::rename(&staging, destination)
        .with_context(|| format!("启用补丁目录失败；暂存内容保留在 {}", staging.display()))?;
    if let Err(error) = lock_staging.persist(lock_path) {
        let rollback = fs::remove_dir_all(destination);
        if let Err(rollback_error) = rollback {
            bail!(
                "写入候选锁文件失败：{}；同时无法回滚 {}：{}",
                error.error,
                destination.display(),
                rollback_error
            );
        }
        return Err(error.error).context("写入候选锁文件失败，已回滚补丁目录");
    }
    Ok(())
}

/// 并入：把候选上游接进基准的补丁集，只新增一个兼容层，编号不变。
///
/// 兼容层是这份上游独有的部分（入口写法和依赖锁），由基准的兼容层重基到候选上游得到；
/// 通用层和 Release 专用层必须原样适用。不适用说明通用补丁也要改，那只能新建补丁集，
/// 这里不做，由调用方决定。
///
/// Join: attach the candidate upstream to the base patchset with one new compatibility
/// layer and the same number. The layer holds what belongs to this upstream alone (the
/// entry point and the lockfile), rebased from the base's layer; the common and release
/// layers must apply unchanged. If they do not, the common patches need changing too,
/// which takes a new patchset; that is the caller's call, not done here.
fn join_patchset(
    root: &Path,
    lock_file: &Path,
    base: &UpstreamLock,
    candidate: &UpstreamLock,
    source_patches: &[PathBuf],
) -> Result<()> {
    let profile = base.compatibility.as_deref().with_context(|| {
        format!(
            "并入失败：p{} 的基准没有兼容层，依赖锁在通用层里，别的上游无法共用",
            base.patchset
        )
    })?;
    let layer = join_layer_name(candidate);
    let sets = root.join("patches/sets");
    let destination = sets
        .join(base.patchset.to_string())
        .join("compatibility")
        .join(&layer);
    if destination.exists() {
        bail!("并入失败：p{} 已有兼容层 {layer}", base.patchset);
    }

    let checkout = build_rebased_overlay(root, base, candidate, source_patches)?;
    let staging = Builder::new()
        .prefix(&format!(".p{}-{layer}-", base.patchset))
        .tempdir_in(&sets)
        .context("创建兼容层暂存目录失败")?;
    export_join_layer(checkout.path(), &candidate.commit, profile, staging.path())?;
    let shared = patches_for_lock(
        root,
        &UpstreamLock {
            patchset: base.patchset,
            compatibility: None,
            dependency_revision: None,
            ..candidate.clone()
        },
    )?;
    verify_join(checkout.path(), &candidate.commit, staging.path(), &shared)?;
    enable_with_lock(
        &root.join(lock_file),
        base.patchset,
        Some(&layer),
        staging,
        &destination,
    )?;

    println!(
        "并入完成：{} 使用 p{}，新增兼容层 {layer}",
        &candidate.commit[..12],
        base.patchset
    );
    Ok(())
}

/// 新兼容层按上游身份命名：Action 用 run-<运行编号>，Release 用标签。
/// A new layer is named after the upstream: run-<run id> for action, the tag for release.
fn join_layer_name(candidate: &UpstreamLock) -> String {
    match candidate.source {
        UpstreamSource::Action => format!(
            "run-{}",
            candidate.official_run_id.expect("已验证 Action 运行编号")
        ),
        UpstreamSource::Release => candidate.release_tag.clone().expect("已验证 Release 标签"),
    }
}

/// 只导出兼容层的重基结果；通用层不导出，由 `verify_join` 检验它能否原样适用。
/// Exports only the rebased compatibility layer; the common layer is not exported but
/// checked by `verify_join` to apply unchanged.
fn export_join_layer(
    checkout: &Path,
    candidate_commit: &str,
    profile: &str,
    staging: &Path,
) -> Result<()> {
    let commits = git_output(
        checkout,
        [
            "rev-list",
            "--reverse",
            &format!("{candidate_commit}..HEAD"),
        ],
    )?;
    let prefix = format!("compatibility/{profile}/");
    let mut exported = 0_usize;
    for commit in commits.lines().filter(|line| !line.is_empty()) {
        let subject = git_output(checkout, ["show", "-s", "--format=%s", commit])?;
        let relative = subject
            .trim()
            .strip_prefix(COMMIT_PREFIX)
            .with_context(|| format!("重基提交缺少 overlay 身份：{commit}"))?;
        let normalized = normalized_relative(Path::new(relative))?;
        if normalized.starts_with("common/") {
            continue;
        }
        let file = normalized
            .strip_prefix(&prefix)
            .filter(|file| !file.contains('/'))
            .with_context(|| format!("并入失败：不支持并入的补丁层 {normalized}"))?;
        let patch = git_output_bytes(
            checkout,
            ["show", "--format=", "--binary", "--full-index", commit],
        )?;
        if patch.is_empty() {
            bail!("重基提交没有可导出的差异：{commit}");
        }
        fs::write(staging.join(file), patch)
            .with_context(|| format!("写入兼容层补丁失败：{file}"))?;
        exported += 1;
    }
    if exported == 0 {
        bail!("并入失败：重基后兼容层为空");
    }
    Ok(())
}

/// 在候选上游的干净检出上先应用新兼容层，再应用补丁集其余各层，确认它们原样适用。
/// On a clean checkout of the candidate, applies the new layer and then the rest of the
/// patchset, confirming the rest applies unchanged.
fn verify_join(repository: &Path, commit: &str, layer: &Path, shared: &[PathBuf]) -> Result<()> {
    let mut layer_patches = fs::read_dir(layer)
        .with_context(|| format!("读取兼容层暂存目录失败：{}", layer.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension() == Some(OsStr::new("patch")))
        .collect::<Vec<_>>();
    layer_patches.sort();

    let trial = Builder::new()
        .prefix(".kixdns-join-trial-")
        .tempdir()
        .context("创建并入试用目录失败")?;
    let tree = trial.path().join("tree");
    run_git(
        repository,
        [
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("--detach"),
            tree.as_os_str(),
            OsStr::new(commit),
        ],
    )?;
    let result = layer_patches.iter().chain(shared).try_for_each(|patch| {
        apply_patch(&tree, patch).with_context(|| {
            format!(
                "并入失败：{} 不能原样应用到候选上游，通用补丁要改动时只能新建补丁集",
                patch.display()
            )
        })
    });
    let _ = run_git(
        repository,
        [
            OsStr::new("worktree"),
            OsStr::new("remove"),
            OsStr::new("--force"),
            tree.as_os_str(),
        ],
    );
    result
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

pub(crate) fn cargo_network_failure(stderr: &[u8]) -> bool {
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
        Options, apply_without_lock, cargo_network_failure, enable_with_lock, export_join_layer,
        find_base_lock, git_output, join_patchset, lock_patch_path, next_lock_patch_number,
        next_patchset, normalized_relative, patch_changes_non_lock, rebase_commits, run_git,
        verify_join,
    };
    use crate::{UpstreamLock, UpstreamSource};

    fn initialize_repository(path: &Path) {
        run_git(path, ["init"]).unwrap();
        run_git(path, ["config", "core.autocrlf", "false"]).unwrap();
        run_git(path, ["config", "user.name", "overlay-test"]).unwrap();
        run_git(path, ["config", "user.email", "overlay-test@example.com"]).unwrap();
    }

    const ACTION_COMMIT: &str = "681183cb25c745cfe42eb380bf9dda886683eaa7";
    const RELEASE_COMMIT: &str = "98522846d060fc9b59fb0764cea2d734f26634d8";

    fn action_lock(compatibility: Option<&str>) -> UpstreamLock {
        UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Action,
            commit: ACTION_COMMIT.to_owned(),
            official_run_id: Some(34_942_284_951),
            release_id: None,
            release_tag: None,
            compatibility: compatibility.map(str::to_owned),
            patchset: 27,
            control_protocol: 1,
            dependency_revision: None,
        }
    }

    fn release_candidate() -> UpstreamLock {
        UpstreamLock {
            repository: "olicesx/kixdns".to_owned(),
            source: UpstreamSource::Release,
            commit: RELEASE_COMMIT.to_owned(),
            official_run_id: None,
            release_id: Some(9),
            release_tag: Some("v0.3.0".to_owned()),
            compatibility: Some("split-main".to_owned()),
            patchset: 27,
            control_protocol: 1,
            dependency_revision: None,
        }
    }

    fn commit_file(repository: &Path, file: &str, content: &str, subject: &str) -> String {
        fs::write(repository.join(file), content).unwrap();
        run_git(repository, ["add", "--all"]).unwrap();
        run_git(repository, ["commit", "-m", subject]).unwrap();
        git_output(repository, ["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned()
    }

    fn one_line_patch(file: &str, before: &str, after: &str) -> String {
        format!(
            "diff --git a/{file} b/{file}\n--- a/{file}\n+++ b/{file}\n@@ -1 +1 @@\n-{before}\n+{after}\n"
        )
    }

    #[test]
    fn parses_join_across_tracks() {
        let arguments = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
                .into_iter()
        };
        let options = Options::parse(arguments(&[
            "--join",
            "--base-source",
            "action",
            "--lock",
            "upstream.release.lock.json",
            "--base-commit",
            ACTION_COMMIT,
        ]))
        .unwrap();
        assert!(options.join);
        assert_eq!(options.base_source, Some(UpstreamSource::Action));

        // 跨轨道只允许并入：从别的轨道领新编号会让 Release 超过 Action。
        // Crossing tracks is for joining only: a new number from the other track would put
        // the release ahead of the action track.
        let error = Options::parse(arguments(&[
            "--base-source",
            "action",
            "--lock",
            "upstream.release.lock.json",
            "--base-commit",
            ACTION_COMMIT,
        ]))
        .err()
        .unwrap();
        assert!(
            error.to_string().contains("只能与 --join 一起使用"),
            "{error}"
        );
        assert!(
            Options::parse(arguments(&[
                "--join",
                "--base-source",
                "nightly",
                "--lock",
                "upstream.lock.json",
                "--base-commit",
                ACTION_COMMIT,
            ]))
            .is_err()
        );
        assert!(
            Options::parse(arguments(&[
                "--join",
                "--join",
                "--lock",
                "upstream.lock.json",
                "--base-commit",
                ACTION_COMMIT,
            ]))
            .is_err()
        );
    }

    #[test]
    fn regenerated_lock_goes_into_the_compatibility_layer() {
        let root = tempdir().unwrap();
        let set = root.path().join("patches/sets/27");
        let entry = set.join("compatibility/split-main/0001-panel-entry.patch");
        let lock = set.join("compatibility/split-main/0002-dependency-lock.patch");
        let config = set.join("common/0001-query-stats-config.patch");
        let panel = set.join("common/0002-panel-control-socket.patch");
        for (path, file) in [
            (&entry, "src/main.rs"),
            (&lock, "Cargo.lock"),
            (&config, "src/config.rs"),
            (&panel, "src/panel.rs"),
        ] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("diff --git a/{file} b/{file}\n")).unwrap();
        }
        let patches = [entry, lock, config, panel];

        // 依赖锁只对这一份上游成立，留在兼容层里通用层才能共用。
        // The lockfile holds for one upstream only; in the layer it keeps common shareable.
        assert_eq!(
            lock_patch_path(&patches, &set, Some("split-main")).unwrap(),
            "compatibility/split-main/0002-dependency-lock.patch"
        );
        assert_eq!(
            lock_patch_path(&patches, &set, None).unwrap(),
            "common/0003-dependency-lock.patch"
        );
    }

    #[test]
    fn a_release_finds_its_base_on_the_action_track() {
        let root = tempdir().unwrap();
        let catalog = root.path().join("upstreams/actions");
        fs::create_dir_all(&catalog).unwrap();
        fs::write(
            catalog.join("34942284951.json"),
            serde_json::json!({
                "repository": "olicesx/kixdns",
                "source": "action",
                "commit": ACTION_COMMIT,
                "official_run_id": 34_942_284_951_u64,
                "compatibility": "split-main",
                "patchset": 27,
                "control_protocol": 1
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            root.path().join("upstream.lock.json"),
            fs::read_to_string(catalog.join("34942284951.json")).unwrap(),
        )
        .unwrap();
        fs::write(
            root.path().join("upstream.release.lock.json"),
            fs::read_to_string(catalog.join("34942284951.json")).unwrap(),
        )
        .unwrap();

        let candidate = release_candidate();
        let base = find_base_lock(
            root.path(),
            &candidate,
            ACTION_COMMIT,
            UpstreamSource::Action,
        )
        .unwrap();
        assert_eq!(base.source, UpstreamSource::Action);
        assert_eq!(base.compatibility.as_deref(), Some("split-main"));
        assert!(
            find_base_lock(
                root.path(),
                &candidate,
                ACTION_COMMIT,
                UpstreamSource::Release
            )
            .is_err()
        );
    }

    #[test]
    fn exports_only_the_rebased_compatibility_layer() {
        let root = tempdir().unwrap();
        initialize_repository(root.path());
        fs::write(root.path().join("lib.rs"), "old\n").unwrap();
        fs::write(root.path().join("Cargo.lock"), "old\n").unwrap();
        let candidate = commit_file(root.path(), "main.rs", "old\n", "candidate");
        commit_file(
            root.path(),
            "main.rs",
            "entry\n",
            "kixdns-overlay:compatibility/split-main/0001-panel-entry.patch",
        );
        commit_file(
            root.path(),
            "lib.rs",
            "panel\n",
            "kixdns-overlay:common/0002-panel-control-socket.patch",
        );
        commit_file(
            root.path(),
            "Cargo.lock",
            "resolved\n",
            "kixdns-overlay:compatibility/split-main/0002-dependency-lock.patch",
        );

        let staging = tempdir().unwrap();
        export_join_layer(root.path(), &candidate, "split-main", staging.path()).unwrap();
        let mut exported = fs::read_dir(staging.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        exported.sort();
        assert_eq!(
            exported,
            ["0001-panel-entry.patch", "0002-dependency-lock.patch"]
        );
        let entry = fs::read_to_string(staging.path().join("0001-panel-entry.patch")).unwrap();
        assert!(entry.contains("+entry"), "{entry}");

        // Release 专用层按标签自动选中，不能靠并入带进一个已封印的补丁集。
        // A release layer is selected by tag and cannot ride a join into a sealed set.
        commit_file(
            root.path(),
            "lib.rs",
            "release\n",
            "kixdns-overlay:release/v0.3.0/0001-release.patch",
        );
        let error = export_join_layer(
            root.path(),
            &candidate,
            "split-main",
            tempdir().unwrap().path(),
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("不支持并入的补丁层"), "{error}");
    }

    #[test]
    fn a_join_needs_the_shared_layers_to_apply_unchanged() {
        let root = tempdir().unwrap();
        initialize_repository(root.path());
        fs::write(root.path().join("main.rs"), "tokio\n").unwrap();
        let candidate = commit_file(root.path(), "lib.rs", "upstream\n", "candidate");

        let layer = tempdir().unwrap();
        fs::write(
            layer.path().join("0001-panel-entry.patch"),
            one_line_patch("main.rs", "tokio", "tokio-with-panel"),
        )
        .unwrap();
        let shared = tempdir().unwrap();
        let fits = shared.path().join("0001-fits.patch");
        fs::write(&fits, one_line_patch("lib.rs", "upstream", "panel")).unwrap();
        verify_join(
            root.path(),
            &candidate,
            layer.path(),
            std::slice::from_ref(&fits),
        )
        .unwrap();

        // 上游改了挂钩点附近：通用补丁要改，只能新建补丁集，并入必须拒绝。
        // Upstream changed the code around a hook: common needs editing, which takes a new
        // patchset, so the join must refuse.
        let drifted = shared.path().join("0002-drifted.patch");
        fs::write(
            &drifted,
            one_line_patch("lib.rs", "older-upstream", "panel"),
        )
        .unwrap();
        let error = verify_join(root.path(), &candidate, layer.path(), &[drifted])
            .err()
            .unwrap();
        assert!(error.to_string().starts_with("并入失败"), "{error:#}");
        // 试用检出不留在上游仓库里。 / The trial checkout does not linger in the repository.
        let worktrees = git_output(root.path(), ["worktree", "list"]).unwrap();
        assert_eq!(worktrees.lines().count(), 1, "{worktrees}");
    }

    #[test]
    fn enabling_a_layer_points_the_lock_at_it() {
        let root = tempdir().unwrap();
        let lock_path = root.path().join("upstream.release.lock.json");
        fs::write(
            &lock_path,
            concat!(
                "{\n  \"repository\": \"olicesx/kixdns\",\n  \"source\": \"release\",\n",
                "  \"commit\": \"98522846d060fc9b59fb0764cea2d734f26634d8\",\n",
                "  \"release_id\": 9,\n  \"release_tag\": \"v0.3.0\",\n",
                "  \"compatibility\": \"split-main\",\n  \"patchset\": 27,\n",
                "  \"control_protocol\": 1,\n  \"dependency_revision\": 2\n}\n"
            ),
        )
        .unwrap();
        let staging = tempfile::Builder::new().tempdir_in(root.path()).unwrap();
        fs::write(staging.path().join("0001-panel-entry.patch"), "patch").unwrap();
        let destination = root.path().join("compatibility-v0.3.0");

        enable_with_lock(&lock_path, 27, Some("v0.3.0"), staging, &destination).unwrap();

        assert!(destination.join("0001-panel-entry.patch").is_file());
        let lock = fs::read_to_string(&lock_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&lock).unwrap();
        assert_eq!(value["patchset"], 27);
        assert_eq!(value["compatibility"], "v0.3.0");
        assert!(value.get("dependency_revision").is_none(), "{lock}");
        // 键的顺序不变，锁文件和版本目录才能逐字节比较。
        // Key order is kept so the lock and its catalogue copy compare byte for byte.
        let keys = value.as_object().unwrap().keys().collect::<Vec<_>>();
        assert_eq!(
            keys,
            [
                "repository",
                "source",
                "commit",
                "release_id",
                "release_tag",
                "compatibility",
                "patchset",
                "control_protocol"
            ]
        );
    }

    #[test]
    fn a_join_refuses_before_touching_the_network() {
        let root = tempdir().unwrap();
        let layer = root.path().join("patches/sets/27/compatibility/v0.3.0");
        fs::create_dir_all(&layer).unwrap();
        let lock_file = PathBuf::from("upstream.release.lock.json");

        // 依赖锁还在通用层的旧补丁集没法共用。
        // An older patchset with the lockfile in its common layer cannot be shared.
        let error = join_patchset(
            root.path(),
            &lock_file,
            &action_lock(None),
            &release_candidate(),
            &[],
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("基准没有兼容层"), "{error}");

        // 同名兼容层已经在补丁集里：已封印的内容不能被覆盖。
        // A layer of that name is already in the set: sealed content is never overwritten.
        let error = join_patchset(
            root.path(),
            &lock_file,
            &action_lock(Some("split-main")),
            &release_candidate(),
            &[],
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("已有兼容层 v0.3.0"), "{error}");
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
