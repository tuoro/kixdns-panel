//! 容器模式：看管进程（`kixdns-panel-helper supervise`，见 crates/panel-helper/src/supervise.rs）把面板跑在容器里时，面板自己在线
//! 更新自己 —— 下载 Release 里这个架构的 `OpenWrt` 安装包、和发布的 SHA-256 对照，解出面板程序、网页和 `GeoSite` 放进
//! `/data/panel/<版本>/`，再请看管进程换上；新版本起来以后自己记下「更新好了」。起不来的由看管进程退回上一份、原因记进
//! `/data/supervisor/state.json`，这里读出来给系统页。系统页的容器信息也在这里。
//!
//! 这里读的是 `OpenWrt` 安装包的布局（scripts/package-openwrt.sh），看管进程按同样的布局找文件
//! （crates/panel-helper/src/supervise/layout.rs），镜像也是照它拼的（scripts/package-docker.sh）：包的布局改了，这几处要一起改。
//! CI 的 Docker 验收用真包走一遍在线更新，改漏了会报出来
//!
//! Container mode: when the supervisor (`kixdns-panel-helper supervise`, see crates/panel-helper/src/supervise.rs) runs the
//! panel in a container, the panel updates itself online: it downloads this architecture's `OpenWrt` package from the
//! release, checks it against the published SHA-256, unpacks the panel program, web pages and `GeoSite` into
//! `/data/panel/<version>/`, then asks the supervisor to switch; the new version notes the update done once it runs. One
//! that does not come up is rolled back by the supervisor with the reason in `/data/supervisor/state.json`, read here for
//! the system page, as is the rest of the container information.
//!
//! What is read here is the `OpenWrt` package's layout (scripts/package-openwrt.sh); the supervisor looks for files by the
//! same layout (crates/panel-helper/src/supervise/layout.rs) and the image is put together from it as well
//! (scripts/package-docker.sh): a change to the package layout has to change them together. CI's Docker acceptance walks
//! an online update with the real package, so a missed one shows up there

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, bail, ensure};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::operations::Operations;
use crate::panel_update::{PanelUpdateState, PanelUpdateStatus, read_status_at, unix_timestamp};
use crate::updates::{PanelUpdateNotice, UpdateManager};

/// 解出来的东西最多这么大 / At most this much is unpacked
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

/// 看管进程给的容器设置 / The container settings the supervisor gives
#[derive(Debug, Clone)]
pub struct ContainerSettings {
    /// 数据卷 / The data volume
    pub data: PathBuf,
    /// 镜像里的面板（和 `OpenWrt` 安装包同样的布局）/ The image's panel (laid out as the `OpenWrt` package)
    pub image: PathBuf,
    pub image_version: String,
}

pub struct Container {
    data: PathBuf,
    image: PathBuf,
    image_version: semver::Version,
    /// 正在跑的这份面板的目录 / The directory of the panel copy that runs
    running: PathBuf,
    /// 同一时间只有一次在线更新 / One online update at a time
    updating: Arc<Mutex<()>>,
}

/// 系统页的容器信息 / The container information for the system page
#[derive(Debug, Serialize)]
pub struct ContainerInfo {
    /// 数据卷在容器里的路径 / The data volume's path in the container
    pub data: PathBuf,
    pub image_version: String,
    /// 正在跑的是在线装的那份，不是镜像里的 / The copy that runs was installed online, not the image's
    pub online: bool,
}

/// 看管进程的 state.json 里这里要的部分 / The part of the supervisor's state.json needed here
#[derive(Debug, Default, Deserialize)]
struct SupervisorState {
    #[serde(default)]
    failed_panels: BTreeMap<String, PanelFailure>,
}

#[derive(Debug, Deserialize)]
struct PanelFailure {
    at: u64,
    reason: String,
}

impl Container {
    /// `running` 是正在跑的面板的目录（程序在它的 `bin/` 下）/ `running` is the directory of the panel that runs (its
    /// program sits in `bin/`)
    pub fn new(settings: ContainerSettings, running: PathBuf) -> anyhow::Result<Self> {
        let image_version = semver::Version::parse(&settings.image_version)
            .context("KIXDNS_CONTAINER_IMAGE_VERSION 不是版本号")?;
        Ok(Self {
            data: settings.data,
            image: settings.image,
            image_version,
            running,
            updating: Arc::default(),
        })
    }

    fn panels(&self) -> PathBuf {
        self.data.join("panel")
    }

    fn status_file(&self) -> PathBuf {
        self.panels().join("update-status.json")
    }

    /// 镜像带的内核 / The kernel the image carries
    pub fn image_kernel(&self) -> PathBuf {
        self.image.join("bin/kixdns")
    }

    pub fn info(&self) -> ContainerInfo {
        ContainerInfo {
            data: self.data.clone(),
            image_version: self.image_version.to_string(),
            online: self.running.starts_with(self.panels()),
        }
    }

    /// 在线更新的状态：自己写的状态文件，看管进程退回过的、比它新的那一次优先，说哪一版为什么没能起来
    /// The online update's state: the status file written here, unless the supervisor rolled a version back after it,
    /// which then says which version did not come up and why
    pub async fn status(&self) -> anyhow::Result<PanelUpdateStatus> {
        let status = read_status_at(&self.status_file(), |_| true).await?;
        let failed = self.supervisor_state().await.failed_panels;
        failed
            .into_iter()
            .filter(|(_, failure)| failure.at >= status.updated_at)
            .max_by_key(|(_, failure)| failure.at)
            .map_or(status, |(version, failure)| {
                failure_status(&version, &failure)
            })
            .validate()
    }

    async fn supervisor_state(&self) -> SupervisorState {
        let path = self.data.join("supervisor/state.json");
        match tokio::fs::read(&path).await {
            Ok(content) => serde_json::from_slice(&content).unwrap_or_else(|error| {
                tracing::warn!(%error, path = %path.display(), "看管进程的状态读不懂");
                SupervisorState::default()
            }),
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(%error, path = %path.display(), "读不了看管进程的状态");
                }
                SupervisorState::default()
            }
        }
    }

    /// 面板启动时：上次在线更新的目标就是自己，就记下更新好了、只留自己和上一份；目标不是自己，那次更新没做完或者被退回了，照实记下
    /// At panel start: when the last online update aimed at this very version it is noted done and only this copy and the
    /// one before stay; when it aimed elsewhere, that update was cut short or rolled back, and is noted so
    pub async fn settle_update(&self) -> anyhow::Result<()> {
        let status = read_status_at(&self.status_file(), |_| true).await?;
        if !matches!(
            status.state,
            PanelUpdateState::Checking | PanelUpdateState::Downloading
        ) {
            return Ok(());
        }
        let own = concat!("v", env!("CARGO_PKG_VERSION"));
        if status.target_version == own && self.info().online {
            self.write_status(
                PanelUpdateState::Complete,
                format!("面板已更新到 {own}"),
                own,
            )
            .await?;
            let panels = self.panels();
            let version = semver::Version::parse(env!("CARGO_PKG_VERSION"))?;
            return tokio::task::spawn_blocking(move || prune(&panels, &version)).await?;
        }
        let version = status.target_version.trim_start_matches('v').to_owned();
        let next = match self.supervisor_state().await.failed_panels.remove(&version) {
            Some(failure) => failure_status(&version, &failure),
            None => PanelUpdateStatus {
                state: PanelUpdateState::Failed,
                message: "上次在线更新没有做完，再点一次在线更新".to_owned(),
                updated_at: unix_timestamp(),
                ..status
            },
        };
        self.save_status(&next).await
    }

    /// 开始一次在线更新：先记下开始了，下载、校验、装好、请看管进程换上在后台做；已经有一次在做就拒绝
    /// Starts an online update: it is noted as started first, and downloading, checking, installing and asking the
    /// supervisor to switch happen in the background; refused while one is under way
    pub async fn start_update(
        self: &Arc<Self>,
        notice: PanelUpdateNotice,
        target: String,
        updates: UpdateManager,
        operations: Operations,
    ) -> anyhow::Result<bool> {
        let Ok(guard) = Arc::clone(&self.updating).try_lock_owned() else {
            return Ok(false);
        };
        self.write_status(
            PanelUpdateState::Checking,
            format!("正在准备更新到 {target}"),
            &target,
        )
        .await?;
        let container = Arc::clone(self);
        tokio::spawn(async move {
            let _guard = guard;
            if let Err(error) = container
                .update(&notice, &target, &updates, &operations)
                .await
            {
                tracing::warn!(error = ?error, "面板在线更新失败");
                let message: String = format!("在线更新失败：{error:#}")
                    .chars()
                    .take(300)
                    .collect();
                if let Err(error) = container
                    .write_status(PanelUpdateState::Failed, message, &target)
                    .await
                {
                    tracing::warn!(error = ?error, "写不了面板在线更新的状态");
                }
            }
        });
        Ok(true)
    }

    async fn update(
        &self,
        notice: &PanelUpdateNotice,
        target: &str,
        updates: &UpdateManager,
        operations: &Operations,
    ) -> anyhow::Result<()> {
        self.write_status(
            PanelUpdateState::Downloading,
            format!("正在下载并校验 {target}"),
            target,
        )
        .await?;
        let package = updates.download_panel_package(notice).await?;
        let panels = self.panels();
        let version = target.trim_start_matches('v').to_owned();
        tokio::task::spawn_blocking(move || unpack(&package, &panels, &version)).await??;
        self.write_status(
            PanelUpdateState::Downloading,
            format!("{target} 已装好，正在重启面板"),
            target,
        )
        .await?;
        // 看管进程先回 OK 再换面板：这个进程随后被停下，新版本起来以后自己记下更新好了
        // The supervisor answers OK before switching: this process is stopped next, and the new version notes the update
        // done once it runs
        operations.start_panel_update().await?;
        Ok(())
    }

    async fn write_status(
        &self,
        state: PanelUpdateState,
        message: String,
        target: &str,
    ) -> anyhow::Result<()> {
        self.save_status(&PanelUpdateStatus {
            state,
            message,
            target_version: target.to_owned(),
            updated_at: unix_timestamp(),
        })
        .await
    }

    async fn save_status(&self, status: &PanelUpdateStatus) -> anyhow::Result<()> {
        let path = self.status_file();
        let mut temporary = path.clone().into_os_string();
        temporary.push(".new");
        tokio::fs::write(&temporary, serde_json::to_vec(status)?).await?;
        tokio::fs::rename(&temporary, &path).await?;
        Ok(())
    }
}

/// 看管进程退回的那一版：说它为什么没能起来、现在跑的是哪一版 / A version the supervisor rolled back: why it did not come
/// up, and which version runs now
fn failure_status(version: &str, failure: &PanelFailure) -> PanelUpdateStatus {
    PanelUpdateStatus {
        state: PanelUpdateState::Failed,
        message: format!(
            "面板 v{version} 没能起来：{}，已退回 v{}",
            failure.reason,
            env!("CARGO_PKG_VERSION")
        ),
        target_version: format!("v{version}"),
        updated_at: failure.at,
    }
}

/// 从 `OpenWrt` 安装包里解出面板程序、网页、`GeoSite` 和身份文件到 `<panels>/<version>/`：先解到旁边的暂存目录，齐了、标签对得上再
/// 换过去。看管进程照同样的条件挑版本（`PANEL_RELEASE` 对得上、有程序、有网页）
/// Unpacks the panel program, web pages, `GeoSite` and identity files from the `OpenWrt` package into
/// `<panels>/<version>/`: into a staging directory next to it first, swapped in once complete with a matching tag. The
/// supervisor picks versions by the same conditions (a matching `PANEL_RELEASE`, the program and the web pages)
fn unpack(package: &[u8], panels: &Path, version: &str) -> anyhow::Result<()> {
    let staging = panels.join(format!(".{version}.partial"));
    remove_directory(&staging)?;
    fs::create_dir_all(&staging)?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(package));
    let mut unpacked = 0_u64;
    for entry in archive.entries().context("安装包读不了")? {
        let mut entry = entry.context("安装包读不了")?;
        let path = entry.path()?.into_owned();
        // 第一层是 kixdns-panel-openwrt-<架构>/ / The first level is kixdns-panel-openwrt-<arch>/
        let inner: PathBuf = path.components().skip(1).collect();
        if !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            bail!("安装包里有不安全的路径：{}", path.display());
        }
        if !wanted(&inner) {
            continue;
        }
        let target = staging.join(&inner);
        match entry.header().entry_type() {
            tar::EntryType::Directory => fs::create_dir_all(&target)?,
            tar::EntryType::Regular => {
                unpacked = unpacked.saturating_add(entry.size());
                ensure!(unpacked <= MAX_UNPACKED_BYTES, "安装包解开以后太大");
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                io::copy(&mut entry, &mut fs::File::create(&target)?)?;
                if inner == Path::new("bin/kixdns-panel-server") {
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o750))?;
                }
            }
            _ => bail!("安装包里有链接或特殊文件：{}", path.display()),
        }
    }
    let release = fs::read_to_string(staging.join("PANEL_RELEASE"))
        .context("安装包里没有 PANEL_RELEASE，不是正式版的包")?;
    ensure!(
        release.trim() == format!("v{version}"),
        "安装包是 {}，不是 v{version}",
        release.trim()
    );
    ensure!(
        staging.join("bin/kixdns-panel-server").is_file()
            && staging.join("web/index.html").is_file(),
        "安装包里缺少面板程序或网页"
    );
    let directory = panels.join(version);
    remove_directory(&directory)?;
    fs::rename(&staging, &directory)?;
    Ok(())
}

/// 安装包里要的：面板程序、网页、`GeoSite` 和身份文件；内核、服务助手、init 脚本这些容器用不上
/// What is taken from the package: the panel program, web pages, `GeoSite` and identity files; the kernel, the service
/// helper and the init scripts are of no use in the container
fn wanted(inner: &Path) -> bool {
    [
        "bin",
        "bin/kixdns-panel-server",
        "PANEL_RELEASE",
        "PANEL_BUILD_COMMIT",
    ]
    .iter()
    .any(|name| inner == Path::new(name))
        || inner.starts_with("web")
        || inner.starts_with("geo")
}

fn remove_directory(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// 更新好以后只留现在这一份和它前面的一份（看管进程退回时用），别的版本和没解完的都删掉
/// Once updated only this copy and the one before it (for the supervisor to roll back to) stay; other versions and
/// unfinished unpacks go
fn prune(panels: &Path, own: &semver::Version) -> anyhow::Result<()> {
    let mut versions = Vec::new();
    for entry in fs::read_dir(panels)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        match semver::Version::parse(&name) {
            Ok(version) => versions.push((version, entry.path())),
            Err(_) if name.ends_with(".partial") => remove_directory(&entry.path())?,
            Err(_) => {}
        }
    }
    let previous = versions
        .iter()
        .map(|(version, _)| version)
        .filter(|version| *version < own)
        .max()
        .cloned();
    for (version, path) in versions {
        if version != *own && Some(&version) != previous.as_ref() {
            remove_directory(&path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::Path;

    use super::{Container, ContainerSettings, prune, unpack};
    use crate::panel_update::PanelUpdateState;

    /// 照 scripts/package-openwrt.sh 的布局打一个包；`extra` 是再加进去的（路径、内容）
    /// Packs a package laid out as scripts/package-openwrt.sh does; `extra` adds (path, content) pairs
    fn package(release: &str, extra: &[(&str, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        // 名字直接写进头里：tar 的 Builder 不肯写带 .. 的路径，坏包要自己拼 / The name goes straight into the header: tar's
        // Builder refuses paths with .., so a bad package is put together by hand
        let mut add = |path: &str, content: &str| {
            let name = format!("kixdns-panel-openwrt-x86_64/{path}");
            let mut header = tar::Header::new_old();
            header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
            header.set_size(content.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(tar::EntryType::Regular);
            header.set_cksum();
            builder.append(&header, content.as_bytes()).unwrap();
        };
        for (path, content) in [
            ("bin/kixdns", "kernel"),
            ("bin/kixdns-panel-server", "panel"),
            ("libexec/kixdns-panel-helper", "helper"),
            ("web/index.html", "<!doctype html>"),
            ("web/assets/app.js", "app"),
            ("geo/geosite.json", "{}"),
            ("init/kixdns.init", "init"),
            ("PANEL_RELEASE", release),
        ] {
            add(path, content);
        }
        for (path, content) in extra {
            add(path, content);
        }
        let mut encoder = builder.into_inner().unwrap();
        encoder.flush().unwrap();
        encoder.finish().unwrap()
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    /// 只解出面板、网页、`GeoSite` 和身份文件，面板程序能执行；内核、服务助手、init 脚本不要
    /// Only the panel, web pages, `GeoSite` and identity files come out, the panel program executable; the kernel, the
    /// service helper and the init scripts stay out
    #[test]
    fn the_panel_comes_out_of_the_openwrt_package() {
        use std::os::unix::fs::PermissionsExt;

        let panels = tempfile::tempdir().unwrap();
        unpack(&package("v4.4.0\n", &[]), panels.path(), "4.4.0").unwrap();
        let root = panels.path().join("4.4.0");
        assert_eq!(read(&root.join("bin/kixdns-panel-server")), "panel");
        assert_eq!(
            std::fs::metadata(root.join("bin/kixdns-panel-server"))
                .unwrap()
                .permissions()
                .mode()
                & 0o100,
            0o100
        );
        assert_eq!(read(&root.join("web/assets/app.js")), "app");
        assert_eq!(read(&root.join("geo/geosite.json")), "{}");
        assert_eq!(read(&root.join("PANEL_RELEASE")), "v4.4.0\n");
        for absent in ["bin/kixdns", "libexec", "init"] {
            assert!(!root.join(absent).exists(), "{absent}");
        }
        assert!(!panels.path().join(".4.4.0.partial").exists());
    }

    /// 标签对不上、缺了网页、带路径穿越的包都不装，也不留下半个目录
    /// A package with another tag, without web pages or with a path escaping it is not installed, and leaves no half
    /// directory behind
    #[test]
    fn a_package_for_another_version_or_with_unsafe_paths_is_refused() {
        let panels = tempfile::tempdir().unwrap();
        assert!(unpack(&package("v4.3.9\n", &[]), panels.path(), "4.4.0").is_err());
        assert!(
            unpack(
                &package("v4.4.0\n", &[("web/../../escape", "x")]),
                panels.path(),
                "4.4.0"
            )
            .is_err()
        );
        assert!(!panels.path().join("4.4.0").exists());
        assert!(!panels.path().parent().unwrap().join("escape").exists());
    }

    #[test]
    fn only_this_copy_and_the_one_before_stay() {
        let panels = tempfile::tempdir().unwrap();
        for name in [
            "4.3.8",
            "4.3.9",
            "4.4.0",
            "4.5.0",
            ".4.6.0.partial",
            "notes",
        ] {
            std::fs::create_dir(panels.path().join(name)).unwrap();
        }
        std::fs::write(panels.path().join("update-status.json"), "{}").unwrap();
        prune(panels.path(), &semver::Version::new(4, 4, 0)).unwrap();
        let mut left: Vec<_> = std::fs::read_dir(panels.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["4.3.9", "4.4.0", "notes", "update-status.json"]);
    }

    fn container(data: &Path, running: &Path) -> Container {
        Container::new(
            ContainerSettings {
                data: data.to_owned(),
                image: data.join("image"),
                image_version: "4.3.9".to_owned(),
            },
            running.to_owned(),
        )
        .unwrap()
    }

    /// 看管进程退回过的那一版比状态文件新：状态说哪一版为什么没能起来；面板起来时记下没做完的更新
    /// A version the supervisor rolled back after the status file was written: the state says which version did not come
    /// up and why; at start the panel notes an update cut short
    #[tokio::test]
    async fn a_rolled_back_version_reads_as_a_failure_with_its_reason() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(data.path().join("panel")).unwrap();
        std::fs::create_dir_all(data.path().join("supervisor")).unwrap();
        let container = container(data.path(), &data.path().join("image"));
        assert!(!container.info().online);
        assert_eq!(
            container.status().await.unwrap().state,
            PanelUpdateState::Idle
        );

        container
            .write_status(
                PanelUpdateState::Downloading,
                "正在重启面板".to_owned(),
                "v999.0.0",
            )
            .await
            .unwrap();
        assert_eq!(
            container.status().await.unwrap().state,
            PanelUpdateState::Downloading
        );
        std::fs::write(
            data.path().join("supervisor/state.json"),
            format!(
                r#"{{"kernel_stopped":true,"failed_panels":{{"999.0.0":{{"at":{},"reason":"起来以后 60 秒内连着退出了 3 次，最后一次退出了（退出码 1）"}}}}}}"#,
                crate::panel_update::unix_timestamp() + 1
            ),
        )
        .unwrap();
        let status = container.status().await.unwrap();
        assert_eq!(status.state, PanelUpdateState::Failed);
        assert_eq!(
            status.message,
            concat!(
                "面板 v999.0.0 没能起来：起来以后 60 秒内连着退出了 3 次，最后一次退出了（退出码 1），已退回 v",
                env!("CARGO_PKG_VERSION")
            )
        );

        // 退回以后起来的这一份把状态文件也写成这次失败 / The copy that starts after the rollback writes the failure into the
        // status file too
        container.settle_update().await.unwrap();
        assert_eq!(
            super::read_status_at(&container.status_file(), |_| true)
                .await
                .unwrap()
                .message,
            status.message
        );
    }

    /// 更新的目标就是自己、跑的是在线装的那份：记下更新好了，只留自己和上一份
    /// The update aimed at this very version and the online copy runs: it is noted done and only this copy and the one
    /// before stay
    #[tokio::test]
    async fn the_new_version_notes_the_update_done_at_start() {
        let data = tempfile::tempdir().unwrap();
        let own = env!("CARGO_PKG_VERSION");
        let running = data.path().join("panel").join(own);
        std::fs::create_dir_all(&running).unwrap();
        std::fs::create_dir_all(data.path().join("panel/0.0.1")).unwrap();
        std::fs::create_dir_all(data.path().join("panel/0.0.2")).unwrap();
        let container = container(data.path(), &running);
        assert!(container.info().online);
        container
            .write_status(
                PanelUpdateState::Downloading,
                "正在重启面板".to_owned(),
                &format!("v{own}"),
            )
            .await
            .unwrap();
        container.settle_update().await.unwrap();
        let status = container.status().await.unwrap();
        assert_eq!(status.state, PanelUpdateState::Complete);
        assert_eq!(status.message, format!("面板已更新到 v{own}"));
        assert!(!data.path().join("panel/0.0.1").exists());
        assert!(data.path().join("panel/0.0.2").exists());
    }
}
