use std::env;
use std::ffi::OsStr;
use std::fmt::Write;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

const PATCH_STAMP: &str = ".kixdns-panel-patches";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum UpstreamSource {
    Action,
    Release,
}

impl UpstreamSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Action => "action",
            Self::Release => "release",
        }
    }
}

#[derive(Debug, Deserialize)]
struct UpstreamLock {
    repository: String,
    source: UpstreamSource,
    commit: String,
    #[serde(default)]
    official_run_id: Option<u64>,
    #[serde(default)]
    release_id: Option<u64>,
    #[serde(default)]
    release_tag: Option<String>,
    patchset: u32,
    control_protocol: u32,
}

fn main() -> Result<()> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| "help".to_owned());
    let lock_file = parse_lock_argument(arguments)?;
    let root = workspace_root()?;

    match command.as_str() {
        "prepare" => prepare(&root, &lock_file),
        "info" => print_info(&root, &lock_file),
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
    if flag != "--lock"
        || arguments.next().is_some()
        || !matches!(
            value.as_str(),
            "upstream.lock.json" | "upstream.release.lock.json"
        )
    {
        bail!("仅支持 --lock upstream.lock.json 或 upstream.release.lock.json");
    }
    Ok(PathBuf::from(value))
}

fn workspace_root() -> Result<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .context("无法确定工作区根目录")
}

fn load_lock(root: &Path, lock_file: &Path) -> Result<UpstreamLock> {
    let path = root.join(lock_file);
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("读取上游锁定文件失败：{}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("解析 {} 失败", lock_file.display()))
}

fn prepare(root: &Path, lock_file: &Path) -> Result<()> {
    let lock = load_lock(root, lock_file)?;
    validate_lock(&lock)?;

    let source_root = root.join(".upstream");
    let checkout = source_root.join(format!(
        "kixdns-{}-{}-p{}",
        lock.source.as_str(),
        &lock.commit[..12],
        lock.patchset
    ));
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
    Ok(())
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
    let url = format!("https://github.com/{}.git", lock.repository);
    run(
        root,
        "git",
        [
            OsStr::new("clone"),
            OsStr::new("--filter=blob:none"),
            OsStr::new("--no-checkout"),
            OsStr::new(&url),
            staging.path().as_os_str(),
        ],
    )?;
    run(
        staging.path(),
        "git",
        ["fetch", "--depth", "1", "origin", lock.commit.as_str()],
    )?;
    run(
        staging.path(),
        "git",
        ["checkout", "--detach", lock.commit.as_str()],
    )?;

    activate_checkout(staging, checkout, placeholder)
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
    let patch_dir = root.join("patches");
    if !patch_dir.is_dir() {
        println!("补丁目录尚未创建，保留原始上游源码");
        return Ok(());
    }

    let mut patches = Vec::new();
    if lock.source == UpstreamSource::Release {
        let release_tag = lock.release_tag.as_deref().expect("已验证 Release 标签");
        patches.extend(read_patches(&patch_dir.join("release").join(release_tag))?);
    }
    patches.extend(read_patches(&patch_dir)?);
    let expected_stamp = patch_stamp(lock.patchset, lock.source, &patches)?;
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

    for patch in patches {
        let patch_arg = patch.as_os_str().to_string_lossy();
        run(checkout, "git", ["apply", "--check", &patch_arg])
            .with_context(|| format!("补丁与上游不兼容：{}", patch.display()))?;
        run(checkout, "git", ["apply", &patch_arg])
            .with_context(|| format!("应用补丁失败：{}", patch.display()))?;
        println!("已应用补丁：{}", patch.display());
    }
    fs::write(&stamp_path, expected_stamp)
        .with_context(|| format!("写入补丁集标记失败：{}", stamp_path.display()))?;
    Ok(())
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

fn patch_stamp(patchset: u32, source: UpstreamSource, patches: &[PathBuf]) -> Result<String> {
    let mut digest = Sha256::new();
    for patch in patches {
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
    Ok(format!(
        "source={}\npatchset={patchset}\nsha256={}\n",
        source.as_str(),
        encode_hex(digest.finalize())
    ))
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
    println!("控制协议：v{}", lock.control_protocol);
    Ok(())
}

fn validate_lock(lock: &UpstreamLock) -> Result<()> {
    validate_commit(&lock.commit)?;
    if lock.patchset == 0 || lock.control_protocol == 0 {
        bail!("upstream.lock.json 中的版本号必须大于 0");
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

fn validate_commit(commit: &str) -> Result<()> {
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
    println!("  cargo xtask info [--lock <文件>]     显示锁定的上游版本");
    println!("  cargo xtask prepare [--lock <文件>]  检出上游并应用增强补丁");
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::{tempdir, tempdir_in};

    use super::{
        CheckoutPlaceholder, UpstreamLock, UpstreamSource, activate_checkout,
        inspect_checkout_placeholder, validate_commit, validate_lock,
    };

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
            patchset: 5,
            control_protocol: 1,
        };
        assert!(validate_lock(&lock).is_err());
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
