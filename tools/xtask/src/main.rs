use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const PATCH_STAMP: &str = ".kixdns-panel-patches";

#[derive(Debug, Deserialize)]
struct UpstreamLock {
    repository: String,
    commit: String,
    patchset: u32,
    control_protocol: u32,
}

fn main() -> Result<()> {
    let command = env::args().nth(1).unwrap_or_else(|| "help".to_owned());
    let root = workspace_root()?;

    match command.as_str() {
        "prepare" => prepare(&root),
        "info" => print_info(&root),
        "help" | "-h" | "--help" => {
            print_help();
            Ok(())
        }
        other => bail!("未知 xtask 命令：{other}"),
    }
}

fn workspace_root() -> Result<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .context("无法确定工作区根目录")
}

fn load_lock(root: &Path) -> Result<UpstreamLock> {
    let path = root.join("upstream.lock.json");
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("读取上游锁定文件失败：{}", path.display()))?;
    serde_json::from_str(&raw).context("解析 upstream.lock.json 失败")
}

fn prepare(root: &Path) -> Result<()> {
    let lock = load_lock(root)?;
    validate_commit(&lock.commit)?;

    let source_root = root.join(".upstream");
    let checkout = source_root.join(format!("kixdns-{}-p{}", &lock.commit[..12], lock.patchset));
    fs::create_dir_all(&source_root).context("创建 .upstream 目录失败")?;

    if !checkout.join(".git").is_dir() {
        let url = format!("https://github.com/{}.git", lock.repository);
        run(
            root,
            "git",
            ["clone", "--filter=blob:none", "--no-checkout", &url]
                .into_iter()
                .chain([checkout.as_os_str().to_string_lossy().as_ref()]),
        )?;
        run(
            &checkout,
            "git",
            ["fetch", "--depth", "1", "origin", lock.commit.as_str()],
        )?;
        run(
            &checkout,
            "git",
            ["checkout", "--detach", lock.commit.as_str()],
        )?;
    }

    let head = output(&checkout, "git", ["rev-parse", "HEAD"])?;
    if head.trim() != lock.commit {
        bail!(
            "上游目录提交不匹配：期望 {}，实际 {}。请更换锁定提交或使用新的检出目录",
            lock.commit,
            head.trim()
        );
    }

    apply_patches(root, &checkout, lock.patchset)?;
    println!("上游增强源码已准备：{}", checkout.display());
    Ok(())
}

fn apply_patches(root: &Path, checkout: &Path, patchset: u32) -> Result<()> {
    let patch_dir = root.join("patches");
    if !patch_dir.is_dir() {
        println!("补丁目录尚未创建，保留原始上游源码");
        return Ok(());
    }

    let mut patches = fs::read_dir(&patch_dir)
        .context("读取 patches 目录失败")?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension() == Some(OsStr::new("patch")))
        .collect::<Vec<_>>();
    patches.sort();

    let expected_stamp = patch_stamp(patchset, &patches)?;
    let stamp_path = checkout.join(PATCH_STAMP);
    if fs::read_to_string(&stamp_path).is_ok_and(|stamp| stamp == expected_stamp) {
        println!("补丁集已应用：v{patchset}");
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

fn patch_stamp(patchset: u32, patches: &[PathBuf]) -> Result<String> {
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
        "patchset={patchset}\nsha256={:x}\n",
        digest.finalize()
    ))
}

fn print_info(root: &Path) -> Result<()> {
    let lock = load_lock(root)?;
    println!("仓库：https://github.com/{}", lock.repository);
    println!("提交：{}", lock.commit);
    println!("补丁集：{}", lock.patchset);
    println!("控制协议：v{}", lock.control_protocol);
    Ok(())
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
    println!("  cargo xtask info     显示锁定的上游版本");
    println!("  cargo xtask prepare  检出上游并应用增强补丁");
}

#[cfg(test)]
mod tests {
    use super::validate_commit;

    #[test]
    fn accepts_full_commit_sha() {
        assert!(validate_commit("374d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_ok());
    }

    #[test]
    fn rejects_short_or_non_hex_commit() {
        assert!(validate_commit("374d63c").is_err());
        assert!(validate_commit("z74d63ccfdde6d281d3c7b5de9c689bfb0b0fb25").is_err());
    }
}
