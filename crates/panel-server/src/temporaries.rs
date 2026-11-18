//! 写到一半断掉（断电、进程被杀）的写入留下的临时文件：启动时按名字认出来删掉。面板写文件都先写进同一目录里的临时文件
//! 再改名换上，临时文件的名字是 tempfile 起的：前缀加 6 个字母或数字。
//!
//! Temporary files left by writes cut short (a power loss, a killed process): recognised by name and removed at
//! start-up. The panel writes every file into a temporary one in the same directory and renames it into place, and
//! tempfile names the temporary one: a prefix and 6 letters or digits.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

/// tempfile 在前缀后面接的随机字符数 / How many random characters tempfile puts after the prefix
const RANDOM_CHARS: usize = 6;

/// 删掉 `directory` 里用这些前缀起名的临时文件和临时目录：名字正好是前缀加 6 个字母或数字，别的一概不碰，符号链接也不碰。
/// 由拥有这个目录的一方在它开始往里写以前调用，删的就不会是正在写的。目录不在、读不了、删不掉都只记日志；返回删掉了几个
/// Removes the temporary files and directories in `directory` named with these prefixes: exactly a prefix and 6 letters
/// or digits, nothing else, and never a symlink. Called by the directory's owner before it starts writing there, so
/// nothing being written can be removed. A missing or unreadable directory and a failed removal are only logged;
/// returns how many were removed
pub(crate) fn sweep(directory: &Path, prefixes: &[&str]) -> usize {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return 0,
        Err(error) => {
            tracing::warn!(%error, directory = %directory.display(), "读不了目录，没清理写到一半留下的临时文件");
            return 0;
        }
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|name| prefixes.iter().any(|prefix| is_temporary(name, prefix)))
        {
            continue;
        }
        // 不跟符号链接：file_type 看的是链接本身 / Symlinks are not followed: file_type looks at the link itself
        let path = entry.path();
        let result = match entry.file_type() {
            Ok(kind) if kind.is_file() => fs::remove_file(&path),
            Ok(kind) if kind.is_dir() => fs::remove_dir_all(&path),
            _ => continue,
        };
        match result {
            Ok(()) => removed += 1,
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "删不掉写到一半留下的临时文件");
            }
        }
    }
    if removed > 0 {
        tracing::info!(removed, directory = %directory.display(), "清理了写到一半留下的临时文件");
    }
    removed
}

/// 名字是不是 `prefix` 加 6 个字母或数字 / Whether a name is `prefix` and 6 letters or digits
fn is_temporary(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == RANDOM_CHARS && rest.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests {
    use tempfile::{Builder, tempdir};

    use super::sweep;

    /// 只删 tempfile 起的那种名字（文件和目录都删），长短不对、带别的字符、前缀不对的都不碰，符号链接和它指的文件也不碰
    /// Only names as tempfile gives them go (files and directories alike); a wrong length, other characters or another
    /// prefix stay, and so do a symlink and the file it points at
    #[test]
    fn only_the_names_tempfile_gives_are_removed() {
        let directory = tempdir().unwrap();
        let root = directory.path();
        // 真用 tempfile 起一个名字，免得这里的写法和它对不上 / A name really given by tempfile, so this never drifts from it
        let real = Builder::new().prefix(".x-").tempfile_in(root).unwrap();
        let (_, real) = real.keep().unwrap();
        for name in [
            ".x-abc123",
            ".x-ABCdef",
            ".x-abc12",
            ".x-abc1234",
            ".x-abc12_",
            "x-abc123",
        ] {
            std::fs::write(root.join(name), b"x").unwrap();
        }
        std::fs::create_dir(root.join(".x-Zz0011")).unwrap();
        std::fs::write(root.join(".x-Zz0011/kixdns"), b"x").unwrap();
        std::fs::write(root.join("target"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("target"), root.join(".x-lnk123")).unwrap();

        assert_eq!(sweep(root, &[".x-"]), 4);

        for gone in [".x-abc123", ".x-ABCdef", ".x-Zz0011"] {
            assert!(!root.join(gone).exists(), "{gone}");
        }
        assert!(!real.exists());
        for kept in [
            ".x-abc12",
            ".x-abc1234",
            ".x-abc12_",
            "x-abc123",
            "target",
            ".x-lnk123",
        ] {
            assert!(std::fs::symlink_metadata(root.join(kept)).is_ok(), "{kept}");
        }
        assert_eq!(sweep(&root.join("missing"), &[".x-"]), 0);
    }
}
