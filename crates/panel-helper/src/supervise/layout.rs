//! 容器里的目录布局。看管进程在容器里就是 init 脚本：数据目录归谁、面板的路径环境变量都由它按这里定好，和 `OpenWrt` 的
//! kixdns-panel.init 是一个角色
//!
//! - 镜像（`--image`，只读）：和 `OpenWrt` 安装包同样的布局 —— `bin/kixdns`（自带的内核）、`bin/kixdns-panel-server`、`web/`、
//!   `geo/`、`bundle/`（自带内核的身份）、`etc/pipeline.json`（默认配置）、`PANEL_RELEASE`、`PANEL_BUILD_COMMIT`
//! - 数据（`--data`，用户映射的卷）：`config/`（pipeline.json、panel.db，要备份的都在这里）、`geo/`、`kernels/`（在线装的
//!   内核）、`panel/<版本>/`（在线装的面板，布局同镜像）、`logs/`（内核日志、查询日志）归面板；`supervisor/` 归看管进程
//! - 运行（`--run`）：`kixdns/admin.sock`（内核的管理套接字）、`kixdns-panel/control.sock`（helper 套接字）
//!
//! The directory layout in the container. In a container the supervisor is the init script: it settles who owns the data
//! directories and fills in the panel's path variables from here, the role `OpenWrt`'s kixdns-panel.init plays
//!
//! - Image (`--image`, read-only): the layout of the `OpenWrt` package, see above
//! - Data (`--data`, the volume the user maps): `config/` (pipeline.json, panel.db: all there is to back up), `geo/`,
//!   `kernels/` (kernels installed online), `panel/<version>/` (panels installed online, laid out as the image) and `logs/`
//!   (kernel log, query log) belong to the panel; `supervisor/` belongs to the supervisor
//! - Run (`--run`): `kixdns/admin.sock` (the kernel's admin socket), `kixdns-panel/control.sock` (the helper socket)

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, fchown, lchown};
use std::path::{Path, PathBuf};

use rustix::fs::OFlags;
use rustix::process::{getgid, getuid};

use super::state::PanelFailure;

/// 内核日志启动时超过这么大就滚一次，和 `OpenWrt` 的 init 脚本、面板的定时滚动一样 / Past this size the kernel log rolls at start,
/// as `OpenWrt`'s init script and the panel's periodic roll do
const KERNEL_LOG_ROLL_BYTES: u64 = 8 * 1024 * 1024;

/// 数据卷里归面板的目录 / The directories of the volume that belong to the panel
const PANEL_DIRECTORIES: [&str; 5] = ["config", "geo", "kernels", "panel", "logs"];

#[derive(Debug, Clone)]
pub struct Layout {
    pub image: PathBuf,
    pub data: PathBuf,
    pub run: PathBuf,
    pub kernel_uid: u32,
    pub panel_uid: u32,
    pub gid: u32,
}

/// 一份可以跑的面板：镜像里的，或者 /data/panel 里在线装的 / A panel that can run: the image's, or one installed online
/// under /data/panel
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelRoot {
    pub dir: PathBuf,
    pub version: [u64; 3],
    pub online: bool,
}

impl PanelRoot {
    /// 目录名，也是 state.json 里的键 / The directory name, also the key in state.json
    pub fn name(&self) -> String {
        let [major, minor, patch] = self.version;
        format!("{major}.{minor}.{patch}")
    }

    pub fn label(&self) -> String {
        let place = if self.online {
            "在线装的"
        } else {
            "镜像里的"
        };
        format!("{place}面板 v{}", self.name())
    }

    pub fn server(&self) -> PathBuf {
        self.dir.join("bin/kixdns-panel-server")
    }
}

impl Layout {
    fn config(&self) -> PathBuf {
        self.data.join("config")
    }

    pub fn pipeline(&self) -> PathBuf {
        self.config().join("pipeline.json")
    }

    pub fn kernel_binary(&self) -> PathBuf {
        self.data.join("kernels/kixdns")
    }

    fn kernel_log(&self) -> PathBuf {
        self.data.join("logs/kixdns.log")
    }

    pub fn admin_socket(&self) -> PathBuf {
        self.run.join("kixdns/admin.sock")
    }

    pub fn helper_socket(&self) -> PathBuf {
        self.run.join("kixdns-panel/control.sock")
    }

    pub fn state_file(&self) -> PathBuf {
        self.data.join("supervisor/state.json")
    }

    /// 启动时把目录摆好：数据卷本身只有看管进程写得进（它自己的状态放在里面）；归面板的目录面板所有、kixdns 组能读（内核要读
    /// 配置和 Geo 数据）；用户放进 config/ 的文件改给面板；没有配置时放一份镜像里的默认配置
    ///
    /// Lays the directories out at start: the volume itself is writable by the supervisor only (its own state lives in it);
    /// the panel's directories are owned by the panel and readable by the kixdns group (the kernel reads the config and the
    /// Geo data); files the user put into config/ are handed to the panel; without a config the image's default is put in
    pub fn prepare(&self) -> io::Result<()> {
        let (me, my_group) = (getuid().as_raw(), getgid().as_raw());
        fs::create_dir_all(&self.data)?;
        let metadata = fs::metadata(&self.data)?;
        if metadata.uid() != me && [self.kernel_uid, self.panel_uid].contains(&metadata.uid()) {
            lchown(&self.data, Some(me), Some(my_group))?;
        }
        if metadata.mode() & 0o022 != 0 {
            fs::set_permissions(&self.data, Permissions::from_mode(metadata.mode() & 0o7755))?;
        }
        for name in PANEL_DIRECTORIES {
            directory(&self.data.join(name), self.panel_uid, self.gid, 0o750)?;
        }
        directory(&self.data.join("supervisor"), me, my_group, 0o755)?;
        directory(&self.run.join("kixdns"), self.kernel_uid, self.gid, 0o750)?;
        directory(&self.run.join("kixdns-panel"), me, self.gid, 0o750)?;
        self.hand_config_to_panel()?;
        if !present(&self.pipeline())? {
            place(
                &self.image.join("etc/pipeline.json"),
                &self.pipeline(),
                0o640,
                (self.panel_uid, self.gid),
            )?;
            // 新的数据卷和 systemd 版的全新安装一样：请面板第一次启动时导入一次镜像自带的 GeoSite（面板用完就删这个标记）。
            // 搬来的配置不放：它可能有意不用 GeoSite，由用户自己决定
            // A new volume is treated as a fresh systemd install: the panel's first start is asked to import the image's
            // GeoSite once (the panel removes the marker after use). A config brought over gets none: it may leave GeoSite out
            // on purpose, so the user decides
            place(
                Path::new("/dev/null"),
                &self.data.join("geo/.import-builtin-geosite"),
                0o640,
                (self.panel_uid, self.gid),
            )?;
        }
        Ok(())
    }

    /// 从别的安装搬来的配置（用户放进 config/ 的文件）改给面板，内核要读的 pipeline.json 再加上组可读。只动 config/ 下直接的
    /// 普通文件：按 `O_NOFOLLOW` 打开再改，链接、目录原样不动，不递归
    ///
    /// Hands a config brought over from another install (files the user put into config/) to the panel, adding group read
    /// to pipeline.json, which the kernel reads. Only regular files directly in config/ are touched: opened with
    /// `O_NOFOLLOW` and changed through the descriptor; links and directories stay as they are, nothing is recursed into
    fn hand_config_to_panel(&self) -> io::Result<()> {
        for entry in fs::read_dir(self.config())? {
            let path = entry?.path();
            let file = match OpenOptions::new()
                .read(true)
                .custom_flags(flags(OFlags::NOFOLLOW | OFlags::NONBLOCK))
                .open(&path)
            {
                Ok(file) => file,
                Err(error) => {
                    eprintln!(
                        "kixdns-panel-helper: 跳过 {}（不是普通文件：{error}）",
                        path.display()
                    );
                    continue;
                }
            };
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                eprintln!(
                    "kixdns-panel-helper: 跳过 {}（不是普通文件）",
                    path.display()
                );
                continue;
            }
            let wanted = if path == self.pipeline() {
                0o640
            } else {
                0o600
            };
            if metadata.uid() != self.panel_uid {
                fchown(&file, Some(self.panel_uid), Some(self.gid))?;
                eprintln!("kixdns-panel-helper: {} 改给面板", path.display());
            }
            if metadata.mode() & wanted != wanted {
                file.set_permissions(Permissions::from_mode((metadata.mode() | wanted) & 0o7777))?;
            }
        }
        Ok(())
    }

    /// 卷里还没有内核时（第一次启动）放一份镜像里的；那里已经有东西就不动，那是面板的。镜像里的更新时的替换由面板启动时做
    /// Without a kernel in the volume yet (the first start) the image's goes there; whatever is there already belongs to the
    /// panel and stays. Replacing it with a newer one from the image is the panel's job at its start
    pub fn seed_kernel(&self) -> io::Result<()> {
        if present(&self.kernel_binary())? {
            return Ok(());
        }
        place(
            &self.image.join("bin/kixdns"),
            &self.kernel_binary(),
            0o755,
            (self.panel_uid, self.gid),
        )
    }

    /// 内核的日志：追加着写，启动时超过 8 MiB 先滚到 .1。文件归面板，面板一直跑着时也按大小滚它
    /// The kernel's log: appended to, rolled to .1 at start once over 8 MiB. The file belongs to the panel, which also rolls it
    /// by size while it runs
    pub fn open_kernel_log(&self) -> io::Result<File> {
        let path = self.kernel_log();
        if fs::symlink_metadata(&path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > KERNEL_LOG_ROLL_BYTES)
        {
            let mut rolled = path.clone().into_os_string();
            rolled.push(".1");
            fs::rename(&path, rolled)?;
        }
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o640)
            .custom_flags(flags(OFlags::NOFOLLOW))
            .open(&path)?;
        fchown(&file, Some(self.panel_uid), Some(self.gid))?;
        Ok(file)
    }

    /// 镜像里的面板：就是和看管进程一起编的那份，版本也一样 / The image's panel: built together with the supervisor, of the
    /// same version
    fn image_root(&self) -> PanelRoot {
        PanelRoot {
            dir: self.image.clone(),
            version: parse_version(env!("CARGO_PKG_VERSION")).unwrap_or_default(),
            online: false,
        }
    }

    /// 要跑的面板：镜像里的和 /data/panel 里在线装的，取版本最新、没被记成起不来的那个。一样新时用在线装的：换上的总是更新的
    /// 版本，拉了同一版本的镜像不会把用户在线装上的那份换下来
    /// The panel to run: of the image's and those installed online under /data/panel, the newest one not recorded as failing
    /// to come up. When equally new the online one runs: a switch is only ever to something newer, so pulling an image of
    /// the same version does not take down the copy the user installed online
    pub fn choose_panel(&self, failed: &BTreeMap<String, PanelFailure>) -> PanelRoot {
        let image = self.image_root();
        let Ok(entries) = fs::read_dir(self.data.join("panel")) else {
            return image;
        };
        entries
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name().into_string().ok()?;
                let root = PanelRoot {
                    version: parse_version(&name)?,
                    dir: entry.path(),
                    online: true,
                };
                (root.version >= image.version && !failed.contains_key(&name) && complete(&root))
                    .then_some(root)
            })
            .max_by_key(|root| root.version)
            .unwrap_or(image)
    }

    /// 面板的环境变量：路径照布局定死（用户在 compose 里写了也不算），查询日志目录和 GitHub Token 文件用户没写时给默认值，
    /// 身份按要跑的那份面板和镜像自带的内核填；`None` 是去掉。监听地址、信任的代理这些用户写的照传
    ///
    /// The panel's environment: paths fixed by the layout (whatever compose says), the query log directory and the GitHub
    /// token file defaulted when the user set none, the identity filled from the panel to run and the image's bundled kernel;
    /// `None` removes. What the user sets, such as the listen address and trusted proxies, passes through
    pub fn panel_env(&self, root: &PanelRoot) -> Vec<(&'static str, Option<OsString>)> {
        let path = |path: PathBuf| Some(path.into_os_string());
        let mut env = vec![
            ("KIXDNS_CONTAINER_DATA", path(self.data.clone())),
            ("KIXDNS_CONTAINER_IMAGE", path(self.image.clone())),
            (
                "KIXDNS_CONTAINER_IMAGE_VERSION",
                Some(self.image_root().name().into()),
            ),
            (
                "KIXDNS_PANEL_DATABASE",
                path(self.config().join("panel.db")),
            ),
            ("KIXDNS_CONFIG", path(self.pipeline())),
            ("KIXDNS_CONTROL_SOCKET", path(self.admin_socket())),
            ("KIXDNS_SERVICE_HELPER_SOCKET", path(self.helper_socket())),
            ("KIXDNS_SERVICE_PIDFILE", None),
            ("KIXDNS_SERVICE_LOG", path(self.kernel_log())),
            ("KIXDNS_BINARY", path(self.kernel_binary())),
            ("KIXDNS_VERSIONS", path(self.data.join("kernels/versions"))),
            ("KIXDNS_BUNDLED_METADATA", path(self.image.join("bundle"))),
            ("KIXDNS_GEO_DATA", path(self.data.join("geo"))),
            (
                "KIXDNS_BUILTIN_GEOSITE",
                path(root.dir.join("geo/geosite.json")),
            ),
            ("KIXDNS_WEB_ROOT", path(root.dir.join("web"))),
            (
                "KIXDNS_PANEL_INSTALLED_RELEASE",
                identity(&root.dir.join("PANEL_RELEASE"), valid_release),
            ),
            (
                "KIXDNS_PANEL_INSTALLED_COMMIT",
                identity(&root.dir.join("PANEL_BUILD_COMMIT"), valid_commit),
            ),
        ];
        // 自带内核的身份照 OpenWrt 的 install.sh 写：提交和发布编号都对得上格式才算有
        // The bundled kernel's identity as `OpenWrt`'s install.sh writes it: present only when commit and release id both
        // match their format
        let bundle = self.image.join("bundle");
        let kernel = identity(&bundle.join("KIXDNS_BUILD_COMMIT"), valid_commit)
            .zip(identity(&bundle.join("KIXDNS_ARTIFACT_ID"), valid_number));
        let (source, commit, id) = match kernel {
            Some((commit, id)) => (Some("fork".into()), Some(commit), Some(id)),
            None => (None, None, None),
        };
        env.extend([
            ("KIXDNS_INSTALLED_SOURCE", source),
            ("KIXDNS_INSTALLED_COMMIT", commit),
            ("KIXDNS_INSTALLED_SOURCE_ID", id),
        ]);
        for (key, default) in [
            ("KIXDNS_QUERYLOG_DIR", self.data.join("logs/querylog")),
            (
                "KIXDNS_GITHUB_TOKEN_FILE",
                self.config().join("github-token"),
            ),
        ] {
            if std::env::var_os(key).is_none() {
                env.push((key, path(default)));
            }
        }
        env
    }
}

/// 建好（或者认好）一个目录，属主和权限摆成要的样子；那里是链接或文件就报错，不跟过去 / Creates (or takes) a directory and
/// sets its owner and mode; a link or a file there is an error, never followed
fn directory(path: &Path, uid: u32, gid: u32, mode: u32) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(io::Error::other(format!(
                "{} 不是目录（要是链接，改成直接映射那个目录）",
                path.display()
            )));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir_all(path)?,
        Err(error) => return Err(error),
    }
    lchown(path, Some(uid), Some(gid))?;
    fs::set_permissions(path, Permissions::from_mode(mode))
}

/// 路径上有没有东西（链接也算，不跟过去）/ Whether anything is at the path (a link counts and is not followed)
fn present(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// root 往面板的目录里放一份文件：先在旁边新建（`O_EXCL`，那里有链接也不会写过去），写好、改给面板，再改名过去
/// Root puts a file into one of the panel's directories: created next to it first (`O_EXCL`, so a link there is never
/// written through), filled, handed to the panel, then renamed into place
fn place(source: &Path, target: &Path, mode: u32, (uid, gid): (u32, u32)) -> io::Result<()> {
    let mut temporary = target.as_os_str().to_owned();
    temporary.push(".supervise");
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)?;
    io::copy(&mut File::open(source)?, &mut file)?;
    file.sync_all()?;
    fchown(&file, Some(uid), Some(gid))?;
    file.set_permissions(Permissions::from_mode(mode))?;
    fs::rename(&temporary, target)
}

/// 在线装的面板要齐：标签和目录名对得上、有程序、有网页 / A panel installed online must be complete: its tag matches the
/// directory name, and the program and the web pages are there
fn complete(root: &PanelRoot) -> bool {
    identity(&root.dir.join("PANEL_RELEASE"), valid_release)
        .is_some_and(|release| release == OsString::from(format!("v{}", root.name())))
        && root.server().is_file()
        && root.dir.join("web/index.html").is_file()
}

/// 读一个一行的身份文件，格式对才要 / Reads a one-line identity file, taken only when well-formed
fn identity(path: &Path, valid: fn(&str) -> bool) -> Option<OsString> {
    let mut text = String::new();
    File::open(path)
        .ok()?
        .take(128)
        .read_to_string(&mut text)
        .ok()?;
    let value = text.trim();
    valid(value).then(|| value.into())
}

fn parse_version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split('.');
    let version = [parts.next()?, parts.next()?, parts.next()?].map(|part| {
        (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| part.parse().ok())
            .flatten()
    });
    match (version, parts.next()) {
        ([Some(major), Some(minor), Some(patch)], None) => Some([major, minor, patch]),
        _ => None,
    }
}

fn valid_release(value: &str) -> bool {
    value.strip_prefix('v').and_then(parse_version).is_some()
}

fn valid_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn valid_number(value: &str) -> bool {
    !value.starts_with('0') && !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn flags(flags: OFlags) -> i32 {
    flags.bits().cast_signed()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::ffi::OsString;
    use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
    use std::path::Path;

    use rustix::process::{getgid, getuid};

    use super::{Layout, PanelRoot, parse_version};
    use crate::supervise::state::PanelFailure;

    /// 测试里看管进程不是 root：内核、面板都用自己的身份 / In tests the supervisor is not root: the kernel and the panel use
    /// its own identity
    fn layout(root: &Path) -> Layout {
        let (uid, gid) = (getuid().as_raw(), getgid().as_raw());
        Layout {
            image: root.join("image"),
            data: root.join("data"),
            run: root.join("run"),
            kernel_uid: uid,
            panel_uid: uid,
            gid,
        }
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn panel(layout: &Layout, version: &str, release: &str) -> std::path::PathBuf {
        let dir = layout.data.join("panel").join(version);
        write(&dir.join("PANEL_RELEASE"), &format!("{release}\n"));
        write(&dir.join("bin/kixdns-panel-server"), "#!/bin/sh\n");
        write(&dir.join("web/index.html"), "<!doctype html>");
        dir
    }

    #[test]
    fn versions_are_three_plain_numbers() {
        assert_eq!(parse_version("4.3.10"), Some([4, 3, 10]));
        for bad in ["4.3", "4.3.9.1", "4.3.x", "v4.3.9", "4..9", "4.3.+9"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    /// 布局摆好：归面板的目录、看管进程的目录、运行目录都在；没有配置时放镜像的默认配置，已经有的不动
    /// The layout is set up: the panel's directories, the supervisor's and the run directories exist; without a config the
    /// image's default goes in, an existing one stays
    #[test]
    fn prepare_lays_out_the_volume_and_seeds_the_config() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        write(
            &layout.image.join("etc/pipeline.json"),
            "{\"default\":true}",
        );
        layout.prepare().unwrap();
        for name in ["config", "geo", "kernels", "panel", "logs"] {
            let metadata = std::fs::metadata(layout.data.join(name)).unwrap();
            assert!(metadata.is_dir(), "{name}");
            assert_eq!(metadata.mode() & 0o7777, 0o750, "{name}");
        }
        assert_eq!(
            std::fs::metadata(layout.data.join("supervisor"))
                .unwrap()
                .mode()
                & 0o7777,
            0o755
        );
        assert!(layout.run.join("kixdns").is_dir());
        assert!(layout.run.join("kixdns-panel").is_dir());
        assert_eq!(
            std::fs::read_to_string(layout.pipeline()).unwrap(),
            "{\"default\":true}"
        );
        let marker = layout.data.join("geo/.import-builtin-geosite");
        assert!(marker.is_file(), "新的数据卷要导入一次自带的 GeoSite");

        std::fs::remove_file(&marker).unwrap();
        std::fs::write(layout.pipeline(), "{\"mine\":true}").unwrap();
        layout.prepare().unwrap();
        assert_eq!(
            std::fs::read_to_string(layout.pipeline()).unwrap(),
            "{\"mine\":true}"
        );
        assert!(!marker.exists(), "已经有配置的不再导入");
    }

    /// 搬来的配置：只有自己读得到的 pipeline.json 加上组可读；链接和目录原样不动，链接指的文件也不动
    /// A config brought over: a pipeline.json only its owner can read gains group read; links and directories stay as they
    /// are, and so does the file a link points to
    #[test]
    fn config_files_are_handed_over_without_following_links() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        write(&layout.pipeline(), "{}");
        std::fs::set_permissions(layout.pipeline(), std::fs::Permissions::from_mode(0o600))
            .unwrap();
        let outside = root.path().join("outside");
        write(&outside, "secret");
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o400)).unwrap();
        symlink(&outside, layout.data.join("config/link")).unwrap();
        std::fs::create_dir(layout.data.join("config/sub")).unwrap();
        layout.prepare().unwrap();
        let mode = |path: &Path| std::fs::symlink_metadata(path).unwrap().mode() & 0o7777;
        assert_eq!(mode(&layout.pipeline()), 0o640);
        assert_eq!(mode(&outside), 0o400, "链接指的文件不能动");
        assert!(
            std::fs::symlink_metadata(layout.data.join("config/link"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn a_link_where_a_data_directory_belongs_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        std::fs::create_dir_all(&layout.data).unwrap();
        std::fs::create_dir(root.path().join("elsewhere")).unwrap();
        symlink(root.path().join("elsewhere"), layout.data.join("geo")).unwrap();
        assert!(layout.prepare().is_err());
    }

    /// 第一次启动放一份镜像里的内核；卷里已经有的（面板在线装的）不动
    /// The first start puts in the image's kernel; one already in the volume (installed online by the panel) stays
    #[test]
    fn the_image_kernel_is_seeded_only_when_the_volume_has_none() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        write(&layout.image.join("etc/pipeline.json"), "{}");
        write(&layout.image.join("bin/kixdns"), "image kernel");
        layout.prepare().unwrap();
        layout.seed_kernel().unwrap();
        assert_eq!(
            std::fs::read_to_string(layout.kernel_binary()).unwrap(),
            "image kernel"
        );
        assert_eq!(
            std::fs::metadata(layout.kernel_binary()).unwrap().mode() & 0o7777,
            0o755
        );
        std::fs::write(layout.kernel_binary(), "online kernel").unwrap();
        layout.seed_kernel().unwrap();
        assert_eq!(
            std::fs::read_to_string(layout.kernel_binary()).unwrap(),
            "online kernel"
        );
    }

    #[test]
    fn the_kernel_log_rolls_past_eight_mebibytes_at_start() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        write(&layout.image.join("etc/pipeline.json"), "{}");
        layout.prepare().unwrap();
        let log = layout.data.join("logs/kixdns.log");
        std::fs::write(&log, "small").unwrap();
        drop(layout.open_kernel_log().unwrap());
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "small");
        std::fs::File::options()
            .write(true)
            .open(&log)
            .unwrap()
            .set_len(8 * 1024 * 1024 + 1)
            .unwrap();
        drop(layout.open_kernel_log().unwrap());
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        assert_eq!(
            std::fs::metadata(layout.data.join("logs/kixdns.log.1"))
                .unwrap()
                .len(),
            8 * 1024 * 1024 + 1
        );
    }

    /// 在线装的比镜像新、齐全、没被记成起不来，才跑它；几个都行时跑最新的
    /// One installed online runs only when it is newer than the image's, complete and not recorded as failing; of several,
    /// the newest
    #[test]
    fn the_newest_complete_panel_runs() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        let image = layout.choose_panel(&BTreeMap::new());
        assert!(!image.online);
        assert_eq!(image.dir, layout.image);
        assert_eq!(
            image.name(),
            env!("CARGO_PKG_VERSION"),
            "镜像里的面板就是和看管进程一起编的那份"
        );

        let image_version = env!("CARGO_PKG_VERSION");
        let same = panel(&layout, image_version, &format!("v{image_version}"));
        assert_eq!(
            layout.choose_panel(&BTreeMap::new()).dir,
            same,
            "一样新时用在线装的"
        );
        panel(&layout, "0.0.1", "v0.0.1");
        let newer = panel(&layout, "999.0.0", "v999.0.0");
        panel(&layout, "999.1.0", "v999.0.0");
        let incomplete = panel(&layout, "999.2.0", "v999.2.0");
        std::fs::remove_dir_all(incomplete.join("web")).unwrap();
        std::fs::create_dir_all(layout.data.join("panel/not-a-version")).unwrap();
        let chosen = layout.choose_panel(&BTreeMap::new());
        assert_eq!(chosen.dir, newer);
        assert!(chosen.online);
        assert_eq!(chosen.label(), "在线装的面板 v999.0.0");

        let failure = || PanelFailure {
            at: 1,
            reason: String::new(),
        };
        let failed = BTreeMap::from([("999.0.0".to_owned(), failure())]);
        assert_eq!(layout.choose_panel(&failed).dir, same, "退回下一份");
        let failed = BTreeMap::from([
            ("999.0.0".to_owned(), failure()),
            (image_version.to_owned(), failure()),
        ]);
        assert_eq!(layout.choose_panel(&failed).dir, layout.image);
    }

    #[test]
    fn the_panel_gets_the_layout_and_the_identity_of_what_runs() {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        let commit = "0123456789abcdef0123456789abcdef01234567";
        write(&layout.image.join("bundle/KIXDNS_BUILD_COMMIT"), commit);
        write(&layout.image.join("bundle/KIXDNS_ARTIFACT_ID"), "42\n");
        let online = PanelRoot {
            dir: panel(&layout, "999.0.0", "v999.0.0"),
            version: [999, 0, 0],
            online: true,
        };
        write(&online.dir.join("PANEL_BUILD_COMMIT"), "not a commit");
        let env: BTreeMap<_, _> = layout.panel_env(&online).into_iter().collect();
        let value = |key: &str| env.get(key).cloned().flatten();
        let path = |path: std::path::PathBuf| Some(OsString::from(path));
        assert_eq!(value("KIXDNS_CONTAINER_DATA"), path(layout.data.clone()));
        assert_eq!(value("KIXDNS_CONTAINER_IMAGE"), path(layout.image.clone()));
        assert_eq!(
            value("KIXDNS_CONTAINER_IMAGE_VERSION"),
            Some(env!("CARGO_PKG_VERSION").into())
        );
        assert_eq!(
            value("KIXDNS_CONFIG"),
            path(layout.data.join("config/pipeline.json"))
        );
        assert_eq!(
            value("KIXDNS_BINARY"),
            path(layout.data.join("kernels/kixdns"))
        );
        assert_eq!(value("KIXDNS_WEB_ROOT"), path(online.dir.join("web")));
        assert_eq!(
            value("KIXDNS_BUNDLED_METADATA"),
            path(layout.image.join("bundle"))
        );
        assert_eq!(
            value("KIXDNS_PANEL_INSTALLED_RELEASE"),
            Some("v999.0.0".into())
        );
        assert!(env.contains_key("KIXDNS_PANEL_INSTALLED_COMMIT"));
        assert_eq!(
            value("KIXDNS_PANEL_INSTALLED_COMMIT"),
            None,
            "格式不对就去掉"
        );
        assert_eq!(value("KIXDNS_SERVICE_PIDFILE"), None);
        assert_eq!(value("KIXDNS_INSTALLED_SOURCE"), Some("fork".into()));
        assert_eq!(value("KIXDNS_INSTALLED_COMMIT"), Some(commit.into()));
        assert_eq!(value("KIXDNS_INSTALLED_SOURCE_ID"), Some("42".into()));
    }
}
