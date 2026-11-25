//! 看管进程要记住、重建容器以后还在的事：内核是不是被用户停了，哪些在线装的面板起不来、为什么。放在 /data/supervisor/state.json，
//! 那个目录只有 root 写得进；面板读它在系统页说明为什么退回了上一版
//!
//! What the supervisor must remember across container rebuilds: whether the user stopped the kernel, and which panels
//! installed online did not come up and why. Kept in /data/supervisor/state.json, in a directory only root can write; the
//! panel reads it to explain on the system page why it went back to the previous version

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct State {
    /// 用户在面板里停了内核：看管进程重启、容器重建以后也不启动它，和 `systemctl disable` 一样
    /// The user stopped the kernel in the panel: it stays down across supervisor restarts and container rebuilds, as with
    /// `systemctl disable`
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub kernel_stopped: bool,
    /// 起不来、被退回的在线版面板：版本号 → 什么时候、为什么。再点一次在线更新就清掉，重新试
    /// Panels installed online that did not come up and were rolled back: version → when and why. Another online update
    /// clears them for a new try
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub failed_panels: BTreeMap<String, PanelFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PanelFailure {
    /// Unix 秒 / Unix seconds
    pub at: u64,
    /// 一句话的原因，系统页照原样显示 / The reason in one sentence, shown as is on the system page
    pub reason: String,
}

impl State {
    /// 没有文件就是新的 /data：内核照常启动。读不懂的文件记一条日志，也当新的
    /// No file means a new /data: the kernel starts as usual. A file that cannot be read is logged and treated as new too
    pub fn load(path: &Path) -> Self {
        match fs::read(path) {
            Ok(content) => serde_json::from_slice(&content).unwrap_or_else(|error| {
                eprintln!(
                    "kixdns-panel-helper: {} 读不懂（{error}），当作没有记录",
                    path.display()
                );
                Self::default()
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                eprintln!(
                    "kixdns-panel-helper: 读不了 {}（{error}），当作没有记录",
                    path.display()
                );
                Self::default()
            }
        }
    }

    /// 先写到旁边再改名，写到一半断电也不会留下半个文件 / Written next to it and renamed, so a cut-off write never leaves half
    /// a file
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let mut temporary = path.as_os_str().to_owned();
        temporary.push(".new");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(self).map_err(io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    }
}

#[cfg(test)]
mod tests {
    use super::{PanelFailure, State};

    #[test]
    fn a_missing_or_unreadable_file_is_a_new_data_directory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        assert_eq!(State::load(&path), State::default());
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(State::load(&path), State::default());
    }

    #[test]
    fn the_state_survives_a_save_and_load() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let mut state = State {
            kernel_stopped: true,
            ..State::default()
        };
        state.failed_panels.insert(
            "4.4.1".to_owned(),
            PanelFailure {
                at: 1_764_000_000,
                reason: "起来以后 60 秒内连着退出了 3 次，最后一次退出码 1".to_owned(),
            },
        );
        state.save(&path).unwrap();
        assert_eq!(State::load(&path), state);
        // 什么都没记时文件就是空对象 / With nothing recorded the file is an empty object
        State::default().save(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }
}
