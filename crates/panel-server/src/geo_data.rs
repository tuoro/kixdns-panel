use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{Client, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::{Builder, NamedTempFile};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::auth::unix_timestamp;
use crate::db::Database;
use crate::digest::encode_hex;

const MANIFEST_KEY: &str = "geo_data_manifest";
const SCHEDULE_KEY: &str = "geo_data_schedule";
const MAX_URL_BYTES: usize = 4096;
const MAX_GEOSITE_FILES: usize = 8;
const MAX_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_REDIRECTS: usize = 4;
/// 全新安装时安装器在 Geo 目录里留下的标记：首次启动导入一次内置 GeoSite，用完就删。
/// The marker the installer leaves in the Geo directory on a fresh install: the first start
/// imports the built-in `GeoSite` once and removes it.
const BUILTIN_SEED_MARKER: &str = ".import-builtin-geosite";

#[derive(Clone)]
pub struct GeoDataManager {
    database: Database,
    root: Arc<PathBuf>,
    sync_lock: Arc<Mutex<()>>,
    builtin_geosite: Option<Arc<PathBuf>>,
    schedule: ScheduleStore,
}

/// 安装包自带的 GeoSite：说明文件 `geosite.json` 写着同目录下数据文件的来源、发布、摘要和大小。
/// The `GeoSite` the package brings along: `geosite.json` describes the data file next to it by
/// source, release, digest and size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuiltinGeosite {
    /// 导入后按这个链接更新；用户可以改成别的。 / Updates follow this link once imported; the user may change it.
    pub url: String,
    pub release: String,
    pub release_url: String,
    pub published_at: Option<String>,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct BuiltinGeositeDescriptor {
    schema_version: u32,
    file: String,
    url: String,
    release: String,
    release_url: String,
    #[serde(default)]
    published_at: Option<String>,
    sha256: String,
    size: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GeoDataManifest {
    pub geoip_mmdb: Option<GeoDataResource>,
    pub geoip_dat: Option<GeoDataResource>,
    pub geosite: Vec<GeoDataResource>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GeoDataResource {
    pub url: String,
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub downloaded_at: i64,
}

/// 按内容存好的一个文件 / One file stored by content
#[derive(Debug, Clone)]
pub(crate) struct StoredFile {
    pub path: PathBuf,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
pub struct GeoDataSyncRequest {
    pub geoip_mmdb_url: Option<String>,
    pub geoip_dat_url: Option<String>,
    #[serde(default)]
    pub geosite_urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GeoDataCleanupResult {
    pub scanned_files: usize,
    pub removed_files: usize,
    pub reclaimed_bytes: u64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct GeoDataSchedule {
    pub interval_hours: Option<u64>,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
    pub next_run_at: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum GeoDataError {
    #[error("{0}")]
    Invalid(String),
    /// 下载没成功：`what` 是下的什么，`cause` 是原因本身，`retry` 时原因是连接一类、稍后再试可能就好。拦截列表的每一行已经写着
    /// 是哪个列表，只用 `cause`
    /// A download failed: `what` names what was downloaded, `cause` is the reason alone, and `retry` marks a connection-type cause
    /// that may clear up later. Each blocklist row already names its list, so it uses `cause` alone
    #[error("{what}没下载成功：{cause}{}", if *.retry { "，稍后再试" } else { "" })]
    Download {
        what: String,
        cause: String,
        retry: bool,
    },
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl GeoDataError {
    fn download(what: &str, cause: impl Into<String>, retry: bool) -> Self {
        Self::Download {
            what: what.to_owned(),
            cause: cause.into(),
            retry,
        }
    }
}

#[derive(Clone, Copy)]
enum ResourceKind {
    Mmdb,
    IpDat,
    Site,
}

impl ResourceKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Mmdb => "geoip-mmdb",
            Self::IpDat => "geoip-dat",
            Self::Site => "geosite",
        }
    }

    fn extension(self, url: &Url) -> &'static str {
        if matches!(self, Self::Mmdb) {
            return "mmdb";
        }
        if url.path().to_ascii_lowercase().ends_with(".json") {
            "json"
        } else {
            "dat"
        }
    }
}

impl GeoDataManager {
    pub fn new(database: Database, root: &Path) -> Result<Self, GeoDataError> {
        prepare_root(root)?;
        let root =
            fs::canonicalize(root).map_err(|error| internal_io("规范化 Geo 数据目录", error))?;
        Ok(Self {
            schedule: ScheduleStore::new(database.clone(), SCHEDULE_KEY, "Geo 数据"),
            database,
            root: Arc::new(root),
            sync_lock: Arc::new(Mutex::new(())),
            builtin_geosite: None,
        })
    }

    /// 安装包里内置 `GeoSite` 的说明文件位置；文件不存在（开发构建）时就当没有内置的。
    /// Where the package's built-in `GeoSite` descriptor lives; a missing file (a development
    /// build) means there is none.
    #[must_use]
    pub fn with_builtin_geosite(mut self, descriptor: PathBuf) -> Self {
        self.builtin_geosite = Some(Arc::new(descriptor));
        self
    }

    pub fn builtin_geosite(&self) -> Result<Option<BuiltinGeosite>, GeoDataError> {
        Ok(self.load_builtin_geosite()?.map(|(builtin, _)| builtin))
    }

    /// 内置 `GeoSite` 的数据文件；开发构建没有。配置页在还没导入时用它列出分类。
    /// The built-in `GeoSite` data file; a development build has none. Before an import the config
    /// page lists its categories.
    pub fn builtin_geosite_data(&self) -> Result<Option<PathBuf>, GeoDataError> {
        Ok(self.load_builtin_geosite()?.map(|(_, data)| data))
    }

    fn load_builtin_geosite(&self) -> Result<Option<(BuiltinGeosite, PathBuf)>, GeoDataError> {
        match self.builtin_geosite.as_deref() {
            Some(descriptor) => load_builtin_geosite(descriptor),
            None => Ok(None),
        }
    }

    /// 把内置 `GeoSite` 拷进面板管理的 Geo 目录、记进清单，来源记成它的下载链接，之后按那个
    /// 链接更新。已经有 `GeoSite` 数据时不动：用户自己选的来源不被换掉。
    /// Copies the built-in `GeoSite` into the panel's Geo directory and records it in the manifest
    /// with its download link as the source, which later updates follow. With `GeoSite` data
    /// already present nothing changes: a source the user chose is never replaced.
    pub async fn import_builtin_geosite(&self) -> Result<GeoDataManifest, GeoDataError> {
        let _guard = self.sync_lock.lock().await;
        let (builtin, data) = self
            .load_builtin_geosite()?
            .ok_or_else(|| GeoDataError::Invalid("这个安装包没有带内置 GeoSite".to_owned()))?;
        let mut manifest = self.current().await?;
        if !manifest.geosite.is_empty() {
            return Err(GeoDataError::Invalid(
                "已经有 GeoSite 数据了：要换成内置的那份，先删掉现有的链接并保存".to_owned(),
            ));
        }
        manifest
            .geosite
            .push(self.copy_builtin_geosite(&builtin, &data).await?);
        let serialized = serde_json::to_string(&manifest)
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        self.database
            .set_setting(MANIFEST_KEY, serialized, unix_timestamp())
            .await?;
        Ok(manifest)
    }

    async fn copy_builtin_geosite(
        &self,
        builtin: &BuiltinGeosite,
        data: &Path,
    ) -> Result<GeoDataResource, GeoDataError> {
        let bytes = tokio::fs::read(data)
            .await
            .map_err(|error| internal_io("读取内置 GeoSite", error))?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let sha256 = encode_hex(Sha256::digest(&bytes));
        if size != builtin.size || sha256 != builtin.sha256 {
            return Err(GeoDataError::Internal(anyhow::anyhow!(
                "内置 GeoSite 和它的说明对不上，安装包可能损坏了，重新安装面板"
            )));
        }
        let file = self
            .write_file(&bytes, |sha256| {
                format!("{}-{sha256}.dat", ResourceKind::Site.prefix())
            })
            .await?;
        Ok(GeoDataResource {
            url: builtin.url.clone(),
            path: file.path.to_string_lossy().into_owned(),
            sha256: file.sha256,
            size: file.size,
            downloaded_at: unix_timestamp(),
        })
    }

    /// 全新安装留下的「首次启动导入内置 GeoSite」标记还在不在。
    /// Whether the fresh-install marker asking the first start to import the built-in `GeoSite` is
    /// still there.
    #[must_use]
    pub fn builtin_seed_requested(&self) -> bool {
        fs::symlink_metadata(self.root.join(BUILTIN_SEED_MARKER))
            .is_ok_and(|metadata| metadata.is_file())
    }

    pub fn clear_builtin_seed(&self) -> Result<(), GeoDataError> {
        match fs::remove_file(self.root.join(BUILTIN_SEED_MARKER)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(internal_io("删除内置 GeoSite 导入标记", error)),
        }
    }

    pub async fn current(&self) -> Result<GeoDataManifest, GeoDataError> {
        let Some(value) = self.database.get_setting(MANIFEST_KEY).await? else {
            return Ok(GeoDataManifest::default());
        };
        serde_json::from_str(&value).map_err(|error| {
            GeoDataError::Internal(anyhow::Error::new(error).context("Geo 数据清单已损坏"))
        })
    }

    pub async fn sync(&self, request: GeoDataSyncRequest) -> Result<GeoDataManifest, GeoDataError> {
        let _guard = self.sync_lock.lock().await;
        let mmdb_url = normalize_optional_url(request.geoip_mmdb_url)?;
        let dat_url = normalize_optional_url(request.geoip_dat_url)?;
        let geosite_urls = normalize_geosite_urls(request.geosite_urls)?;

        let geoip_mmdb = match mmdb_url {
            Some(url) => Some(self.download(&url, ResourceKind::Mmdb).await?),
            None => None,
        };
        let geoip_dat = match dat_url {
            Some(url) => Some(self.download(&url, ResourceKind::IpDat).await?),
            None => None,
        };
        let mut geosite = Vec::with_capacity(geosite_urls.len());
        for url in geosite_urls {
            geosite.push(self.download(&url, ResourceKind::Site).await?);
        }

        let manifest = GeoDataManifest {
            geoip_mmdb,
            geoip_dat,
            geosite,
        };
        let serialized = serde_json::to_string(&manifest)
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        self.database
            .set_setting(MANIFEST_KEY, serialized, unix_timestamp())
            .await?;
        Ok(manifest)
    }

    /// 自动更新的设置 / The automatic-update setting
    pub(crate) fn schedule(&self) -> &ScheduleStore {
        &self.schedule
    }

    /// `also_keep` 是别处（拦截列表）还要用的文件 / `also_keep` holds files still needed elsewhere (the blocklists)
    pub async fn cleanup(
        &self,
        retained_configs: &[Value],
        also_keep: HashSet<PathBuf>,
    ) -> Result<GeoDataCleanupResult, GeoDataError> {
        let _guard = self.sync_lock.lock().await;
        let manifest = self.current().await?;
        let mut protected = protected_geo_paths(self.root.as_ref(), retained_configs, &manifest);
        protected.extend(also_keep);
        let root = Arc::clone(&self.root);
        tokio::task::spawn_blocking(move || cleanup_managed_files(&root, &protected))
            .await
            .map_err(|error| {
                GeoDataError::Internal(anyhow::Error::new(error).context("Geo 清理任务异常结束"))
            })?
    }

    async fn download(
        &self,
        raw_url: &str,
        kind: ResourceKind,
    ) -> Result<GeoDataResource, GeoDataError> {
        let file = self
            .download_file(
                raw_url,
                "Geo 数据",
                MAX_DOWNLOAD_BYTES,
                |sha256, final_url| {
                    format!("{}-{sha256}.{}", kind.prefix(), kind.extension(final_url))
                },
            )
            .await?;
        Ok(GeoDataResource {
            url: raw_url.to_owned(),
            path: file.path.to_string_lossy().into_owned(),
            sha256: file.sha256,
            size: file.size,
            downloaded_at: unix_timestamp(),
        })
    }

    /// 下载一个文件，按内容存进面板管理的目录：只走 https、不连内网地址，最多 `max_bytes` 字节。`what` 是报错时
    /// 对这个文件的说法，`filename` 由内容摘要和最后落到的地址给出文件名。Geo 数据和拦截列表都走这里。
    /// Downloads a file and stores it in the panel's directory by content: https only, no private addresses, at
    /// most `max_bytes`. `what` names the file in error messages, and `filename` names it from its digest and
    /// the address it finally came from. Geo data and blocklists both come through here.
    pub(crate) async fn download_file(
        &self,
        raw_url: &str,
        what: &str,
        max_bytes: u64,
        filename: impl FnOnce(&str, &Url) -> String,
    ) -> Result<StoredFile, GeoDataError> {
        let initial_url = parse_url(raw_url, what)?;
        let (response, final_url) = request_with_safe_redirects(initial_url, what).await?;
        validate_response(&response, what, max_bytes)?;

        let temporary = Builder::new()
            .prefix(".geo-download-")
            .tempfile_in(self.root.as_ref())
            .map_err(|error| internal_io("创建 Geo 数据临时文件", error))?;
        #[cfg(unix)]
        restrict_file_permissions(temporary.as_file())?;
        let writer = temporary
            .reopen()
            .map_err(|error| internal_io("打开 Geo 数据临时文件", error))?;
        let mut writer = tokio::fs::File::from_std(writer);
        let mut stream = response.bytes_stream();
        let mut hasher = Sha256::new();
        let mut size = 0_u64;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| {
                tracing::warn!(%error, what, "下载时连接中断");
                GeoDataError::download(what, "下载到一半连接断了", true)
            })?;
            size = size.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
            if size > max_bytes {
                return Err(too_large(what, max_bytes));
            }
            hasher.update(&chunk);
            writer
                .write_all(&chunk)
                .await
                .map_err(|error| internal_io("写入 Geo 数据", error))?;
        }
        if size == 0 {
            return Err(GeoDataError::download(what, "文件是空的", false));
        }
        writer
            .flush()
            .await
            .map_err(|error| internal_io("刷新 Geo 数据", error))?;
        writer
            .sync_all()
            .await
            .map_err(|error| internal_io("持久化 Geo 数据", error))?;
        drop(writer);

        let sha256 = encode_hex(hasher.finalize());
        let path = self.root.join(filename(&sha256, &final_url));
        persist_content_addressed(temporary, &path, &sha256, size).await?;
        Ok(StoredFile { path, sha256, size })
    }

    /// 把一段内容按内容存进面板管理的目录，文件名由内容摘要给出 / Stores bytes in the panel's directory by content,
    /// the file named from the digest
    pub(crate) async fn write_file(
        &self,
        bytes: &[u8],
        filename: impl FnOnce(&str) -> String,
    ) -> Result<StoredFile, GeoDataError> {
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let sha256 = encode_hex(Sha256::digest(bytes));
        let mut temporary = Builder::new()
            .prefix(".geo-write-")
            .tempfile_in(self.root.as_ref())
            .map_err(|error| internal_io("创建 Geo 数据临时文件", error))?;
        #[cfg(unix)]
        restrict_file_permissions(temporary.as_file())?;
        std::io::Write::write_all(&mut temporary, bytes)
            .map_err(|error| internal_io("写入 Geo 数据", error))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| internal_io("持久化 Geo 数据", error))?;
        let path = self.root.join(filename(&sha256));
        persist_content_addressed(temporary, &path, &sha256, size).await?;
        Ok(StoredFile { path, sha256, size })
    }

    /// 面板管理的目录（Geo 数据和拦截列表都在这里） / The panel's directory, where Geo data and blocklists live
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

impl GeoDataSchedule {
    #[must_use]
    pub fn is_due(&self, now: i64) -> bool {
        self.interval_hours.is_some() && self.next_run_at.is_some_and(|next| next <= now)
    }

    fn refresh_next_run(&mut self) {
        self.next_run_at = self.interval_hours.map(|hours| {
            self.last_attempt_at.map_or_else(unix_timestamp, |attempt| {
                attempt
                    .saturating_add(i64::try_from(hours.saturating_mul(3600)).unwrap_or(i64::MAX))
            })
        });
    }
}

/// 存在数据库一个键下的自动更新设置：Geo 数据和拦截列表各一份 / An automatic-update setting under one database key: one for
/// Geo data, one for the blocklists
#[derive(Clone)]
pub(crate) struct ScheduleStore {
    database: Database,
    key: &'static str,
    /// 报错时对它的说法 / What error messages call it
    what: &'static str,
}

impl ScheduleStore {
    pub(crate) fn new(database: Database, key: &'static str, what: &'static str) -> Self {
        Self {
            database,
            key,
            what,
        }
    }

    pub(crate) async fn get(&self) -> Result<GeoDataSchedule, GeoDataError> {
        let Some(value) = self.database.get_setting(self.key).await? else {
            return Ok(GeoDataSchedule::default());
        };
        let mut schedule: GeoDataSchedule = serde_json::from_str(&value).map_err(|error| {
            GeoDataError::Internal(
                anyhow::Error::new(error).context(format!("{}的自动更新设置已损坏", self.what)),
            )
        })?;
        schedule.refresh_next_run();
        Ok(schedule)
    }

    pub(crate) async fn set_interval(
        &self,
        interval_hours: Option<u64>,
    ) -> Result<GeoDataSchedule, GeoDataError> {
        if !matches!(interval_hours, None | Some(24 | 168)) {
            return Err(GeoDataError::Invalid(format!(
                "{}的自动更新只能每天或每周",
                self.what
            )));
        }
        let mut schedule = self.get().await?;
        if schedule.interval_hours == interval_hours {
            return Ok(schedule);
        }
        schedule.interval_hours = interval_hours;
        schedule.last_attempt_at = None;
        schedule.last_error = None;
        schedule.refresh_next_run();
        self.store(&schedule).await?;
        Ok(schedule)
    }

    pub(crate) async fn mark_attempt(&self, now: i64) -> Result<(), GeoDataError> {
        let mut schedule = self.get().await?;
        schedule.last_attempt_at = Some(now);
        schedule.refresh_next_run();
        self.store(&schedule).await
    }

    pub(crate) async fn mark_result(
        &self,
        now: i64,
        error: Option<String>,
    ) -> Result<(), GeoDataError> {
        let mut schedule = self.get().await?;
        if error.is_none() {
            schedule.last_success_at = Some(now);
        }
        schedule.last_error = error.map(|message| message.chars().take(500).collect());
        schedule.refresh_next_run();
        self.store(&schedule).await
    }

    async fn store(&self, schedule: &GeoDataSchedule) -> Result<(), GeoDataError> {
        let serialized = serde_json::to_string(schedule)
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        self.database
            .set_setting(self.key, serialized, unix_timestamp())
            .await?;
        Ok(())
    }
}

impl GeoDataSyncRequest {
    #[must_use]
    pub fn from_manifest(manifest: &GeoDataManifest) -> Self {
        Self {
            geoip_mmdb_url: manifest
                .geoip_mmdb
                .as_ref()
                .map(|resource| resource.url.clone()),
            geoip_dat_url: manifest
                .geoip_dat
                .as_ref()
                .map(|resource| resource.url.clone()),
            geosite_urls: manifest
                .geosite
                .iter()
                .map(|resource| resource.url.clone())
                .collect(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.geoip_mmdb_url.is_none()
            && self.geoip_dat_url.is_none()
            && self.geosite_urls.is_empty()
    }
}

/// 读内置 `GeoSite` 的说明并和数据文件对照；说明文件不存在时就是没有内置的。
/// Reads the built-in `GeoSite` descriptor and checks it against the data file; a missing
/// descriptor means there is none.
fn load_builtin_geosite(
    descriptor: &Path,
) -> Result<Option<(BuiltinGeosite, PathBuf)>, GeoDataError> {
    let invalid = |reason: &str| {
        GeoDataError::Internal(anyhow::anyhow!(
            "内置 GeoSite 的说明无效（{reason}），重新安装面板"
        ))
    };
    let content = match fs::read(descriptor) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(internal_io("读取内置 GeoSite 说明", error)),
    };
    let parsed: BuiltinGeositeDescriptor =
        serde_json::from_slice(&content).map_err(|_| invalid("不是有效的 JSON"))?;
    if parsed.schema_version != 1 {
        return Err(invalid("格式版本不受支持"));
    }
    if parsed.file.is_empty() || parsed.file.contains(['/', '\\']) || parsed.file.starts_with('.') {
        return Err(invalid("文件名"));
    }
    parse_url(&parsed.url, "GeoSite").map_err(|_| invalid("下载链接"))?;
    parse_url(&parsed.release_url, "GeoSite").map_err(|_| invalid("发布页链接"))?;
    if parsed.release.is_empty()
        || parsed.release.len() > 64
        || !parsed
            .release
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(invalid("发布标签"));
    }
    if parsed.sha256.len() != 64
        || !parsed
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("摘要"));
    }
    if parsed.size == 0 || parsed.size > MAX_DOWNLOAD_BYTES {
        return Err(invalid("大小"));
    }
    let data = descriptor
        .parent()
        .ok_or_else(|| invalid("所在目录"))?
        .join(&parsed.file);
    let metadata =
        fs::symlink_metadata(&data).map_err(|error| internal_io("检查内置 GeoSite", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != parsed.size {
        return Err(invalid("数据文件和说明的大小对不上"));
    }
    Ok(Some((
        BuiltinGeosite {
            url: parsed.url,
            release: parsed.release,
            release_url: parsed.release_url,
            published_at: parsed.published_at,
            sha256: parsed.sha256,
            size: parsed.size,
        },
        data,
    )))
}

pub fn apply_manifest_paths(
    content: &mut Value,
    manifest: &GeoDataManifest,
) -> Result<bool, GeoDataError> {
    let root = content
        .as_object_mut()
        .ok_or_else(|| GeoDataError::Invalid("配置根节点必须是 JSON 对象".to_owned()))?;
    let settings = root
        .entry("settings")
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| GeoDataError::Invalid("settings 必须是 JSON 对象".to_owned()))?;
    let before = settings.clone();
    set_optional_path(settings, "geoip_db_path", manifest.geoip_mmdb.as_ref());
    set_optional_path(settings, "geoip_dat_path", manifest.geoip_dat.as_ref());
    // 拦截列表合并出的文件也在这一项里，但不归 Geo 数据管：原样留在后面
    // The blocklists' merged file sits in this list too but is not Geo data's to manage: it stays, after them
    let blocklists: Vec<Value> = settings
        .get("geosite_data_paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|path| path.as_str().is_some_and(is_blocklist_path))
        .cloned()
        .collect();
    settings.insert(
        "geosite_data_paths".to_owned(),
        Value::Array(
            manifest
                .geosite
                .iter()
                .map(|resource| Value::String(resource.path.clone()))
                .chain(blocklists)
                .collect(),
        ),
    );
    Ok(before != *settings)
}

fn set_optional_path(
    settings: &mut serde_json::Map<String, Value>,
    key: &str,
    resource: Option<&GeoDataResource>,
) {
    if let Some(resource) = resource {
        settings.insert(key.to_owned(), Value::String(resource.path.clone()));
    } else {
        settings.remove(key);
    }
}

fn protected_geo_paths(
    root: &Path,
    retained_configs: &[Value],
    manifest: &GeoDataManifest,
) -> HashSet<PathBuf> {
    let mut protected = HashSet::new();
    for resource in manifest
        .geoip_mmdb
        .iter()
        .chain(manifest.geoip_dat.iter())
        .chain(manifest.geosite.iter())
    {
        protect_managed_path(root, &resource.path, &mut protected);
    }
    for content in retained_configs {
        let Some(settings) = content.get("settings").and_then(Value::as_object) else {
            continue;
        };
        for key in ["geoip_db_path", "geoip_dat_path"] {
            if let Some(path) = settings.get(key).and_then(Value::as_str) {
                protect_managed_path(root, path, &mut protected);
            }
        }
        if let Some(paths) = settings.get("geosite_data_paths").and_then(Value::as_array) {
            for path in paths.iter().filter_map(Value::as_str) {
                protect_managed_path(root, path, &mut protected);
            }
        }
    }
    protected
}

fn protect_managed_path(root: &Path, raw_path: &str, protected: &mut HashSet<PathBuf>) {
    let path = Path::new(raw_path);
    if path.parent() == Some(root)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_managed_geo_filename)
    {
        protected.insert(path.to_path_buf());
    }
}

fn cleanup_managed_files(
    root: &Path,
    protected: &HashSet<PathBuf>,
) -> Result<GeoDataCleanupResult, GeoDataError> {
    let mut result = GeoDataCleanupResult {
        scanned_files: 0,
        removed_files: 0,
        reclaimed_bytes: 0,
    };
    for entry in fs::read_dir(root).map_err(|error| internal_io("读取 Geo 数据目录", error))?
    {
        let entry = entry.map_err(|error| internal_io("读取 Geo 数据目录项", error))?;
        let path = entry.path();
        let metadata =
            fs::symlink_metadata(&path).map_err(|error| internal_io("检查 Geo 数据文件", error))?;
        let managed = metadata.is_file()
            && !metadata.file_type().is_symlink()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_managed_geo_filename);
        if !managed {
            continue;
        }
        result.scanned_files += 1;
        if protected.contains(&path) {
            continue;
        }
        fs::remove_file(&path).map_err(|error| internal_io("删除未引用 Geo 数据", error))?;
        result.removed_files += 1;
        result.reclaimed_bytes = result.reclaimed_bytes.saturating_add(metadata.len());
    }
    #[cfg(unix)]
    if result.removed_files > 0 {
        sync_parent(&root.join("cleanup"))?;
    }
    Ok(result)
}

/// 是不是拦截列表合并出的文件（`blocklist-<摘要>.json`） / Whether a path is the blocklists' merged file
/// (`blocklist-<digest>.json`)
pub(crate) fn is_blocklist_path(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| is_digest_name(name, "blocklist-", &["json"]))
}

fn is_managed_geo_filename(name: &str) -> bool {
    [
        ("geoip-mmdb-", &["mmdb"][..]),
        ("geoip-dat-", &["dat", "json"][..]),
        ("geosite-", &["dat", "json"][..]),
        // 拦截列表：合并给内核的文件，和下载下来的原始列表 / Blocklists: the merged file for the kernel, and the raw lists as downloaded
        ("blocklist-", &["json"][..]),
        ("blocklist-src-", &["txt"][..]),
    ]
    .iter()
    .any(|(prefix, extensions)| is_digest_name(name, prefix, extensions))
}

/// 文件名是不是 `<prefix><64 位十六进制摘要>.<extensions 之一>` / Whether a file name reads
/// `<prefix><64 hex digest>.<one of extensions>`
fn is_digest_name(name: &str, prefix: &str, extensions: &[&str]) -> bool {
    let Some(rest) = name.strip_prefix(prefix) else {
        return false;
    };
    let Some((digest, extension)) = rest.rsplit_once('.') else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && extensions.contains(&extension)
}

fn normalize_optional_url(value: Option<String>) -> Result<Option<String>, GeoDataError> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(|value| {
            parse_url(&value, "Geo 数据")?;
            Ok(value)
        })
        .transpose()
}

fn normalize_geosite_urls(values: Vec<String>) -> Result<Vec<String>, GeoDataError> {
    let mut unique = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim().to_owned();
        if value.is_empty() || !unique.insert(value.clone()) {
            continue;
        }
        parse_url(&value, "Geo 数据")?;
        normalized.push(value);
    }
    if normalized.len() > MAX_GEOSITE_FILES {
        return Err(GeoDataError::Invalid(format!(
            "GeoSite 链接不能超过 {MAX_GEOSITE_FILES} 个"
        )));
    }
    Ok(normalized)
}

/// 检查一个下载链接：只收 https、不带用户名密码；`what` 是报错时对它的说法 / Checks a download link: https only,
/// no user name or password; `what` names it in error messages
pub(crate) fn parse_url(value: &str, what: &str) -> Result<Url, GeoDataError> {
    if value.len() > MAX_URL_BYTES {
        return Err(GeoDataError::Invalid(format!("{what}链接过长")));
    }
    let url =
        Url::parse(value).map_err(|_| GeoDataError::Invalid(format!("{what}链接写得不对")))?;
    if url.scheme() != "https" {
        return Err(GeoDataError::Invalid(format!("{what}链接只能用 https://")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(GeoDataError::Invalid(format!(
            "{what}链接不能包含用户名或密码"
        )));
    }
    if url.host().is_none() {
        return Err(GeoDataError::Invalid(format!("{what}链接缺少主机名")));
    }
    Ok(url)
}

async fn request_with_safe_redirects(
    mut url: Url,
    what: &str,
) -> Result<(Response, Url), GeoDataError> {
    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, address) = resolve_public_address(&url, what).await?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_mins(2))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .user_agent(concat!("kixdns-panel/", env!("CARGO_PKG_VERSION")))
            .resolve(&host, address)
            .build()
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        let response = client.get(url.clone()).send().await.map_err(|error| {
            tracing::warn!(%error, %url, what, "连不上下载地址");
            GeoDataError::download(what, format!("连不上 {host}"), true)
        })?;
        if !response.status().is_redirection() {
            return Ok((response, url));
        }
        if redirect_count == MAX_REDIRECTS {
            return Err(GeoDataError::download(what, "链接重定向次数过多", false));
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| GeoDataError::download(what, "重定向缺少目标地址", false))?;
        let next = url
            .join(location)
            .map_err(|_| GeoDataError::download(what, "重定向地址无效", false))?;
        // 用户给的是 https 链接，是网站把下载转去了别处：照实说，不说「链接只能用 https://」 / The user gave an https link and the site
        // sent the download elsewhere: say so, rather than 链接只能用 https://
        if next.scheme() != "https" {
            return Err(GeoDataError::download(
                what,
                "网站把下载转到了 http:// 地址，面板只走 https://",
                false,
            ));
        }
        url = parse_url(next.as_str(), what)?;
    }
    unreachable!("重定向循环总会返回")
}

async fn resolve_public_address(
    url: &Url,
    what: &str,
) -> Result<(String, SocketAddr), GeoDataError> {
    let host = url
        .host_str()
        .ok_or_else(|| GeoDataError::Invalid(format!("{what}链接缺少主机名")))?
        .trim_end_matches('.')
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let mut addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|error| {
                // 系统的原话（英文）只进日志 / The system's own words (in English) go to the log only
                tracing::warn!(%error, %host, what, "下载地址的域名解析失败");
                GeoDataError::download(what, format!("找不到 {host}（域名解析失败）"), true)
            })?
            .collect::<Vec<_>>()
    };
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(GeoDataError::download(
            what,
            format!("{host} 没有可用的地址"),
            true,
        ));
    }
    if let Some(address) = addresses
        .iter()
        .find(|address| !is_allowed_download_ip(address.ip()))
    {
        return Err(GeoDataError::Invalid(format!(
            "{what}主机 {host} 解析到不允许的地址 {}，链接不能指向本机、私网或保留地址",
            address.ip()
        )));
    }
    Ok((host, addresses[0]))
}

fn is_allowed_download_ip(ip: IpAddr) -> bool {
    is_public_ip(ip) || is_mihomo_fake_ip(ip)
}

fn is_mihomo_fake_ip(ip: IpAddr) -> bool {
    let IpAddr::V4(ip) = ip else {
        return false;
    };
    let [a, b, _, _] = ip.octets();
    a == 198 && (18..=19).contains(&b)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 88 && c == 99)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let global_unicast = (segments[0] & 0xe000) == 0x2000;
    let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    let teredo = segments[0] == 0x2001 && segments[1] == 0;
    let six_to_four = segments[0] == 0x2002;
    global_unicast && !documentation && !teredo && !six_to_four
}

fn too_large(what: &str, max_bytes: u64) -> GeoDataError {
    GeoDataError::download(
        what,
        format!("文件超过 {}\u{a0}MiB", max_bytes / 1024 / 1024),
        false,
    )
}

fn validate_response(response: &Response, what: &str, max_bytes: u64) -> Result<(), GeoDataError> {
    let status = response.status();
    if status != StatusCode::OK {
        // 404、410 是链接失效，重下也没用；5xx、429 是服务器那头一时的问题 / 404 and 410 mean the link is gone and
        // downloading again will not help; 5xx and 429 are passing trouble on the server's side
        let gone = matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE);
        return Err(GeoDataError::download(
            what,
            format!(
                "服务器返回 HTTP\u{a0}{}{}",
                status.as_u16(),
                if gone { "，链接可能失效了" } else { "" }
            ),
            status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
        ));
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|size| size > max_bytes)
    {
        return Err(too_large(what, max_bytes));
    }
    if response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"))
    {
        return Err(GeoDataError::download(
            what,
            "链接打开的是网页，要填文件的直接下载链接",
            false,
        ));
    }
    Ok(())
}

fn prepare_root(path: &Path) -> Result<(), GeoDataError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(GeoDataError::Internal(anyhow::anyhow!(
                "Geo 数据路径必须是普通目录，不能是符号链接：{}",
                path.display()
            )));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|error| internal_io("创建 Geo 数据目录", error))?;
        }
        Err(error) => return Err(internal_io("检查 Geo 数据目录", error)),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o750))
            .map_err(|error| internal_io("设置 Geo 数据目录权限", error))?;
    }
    Ok(())
}

async fn persist_content_addressed(
    temporary: NamedTempFile,
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), GeoDataError> {
    if path.exists() {
        return verify_existing(path, expected_sha256, expected_size).await;
    }
    match temporary.persist_noclobber(path) {
        Ok(_) => {
            #[cfg(unix)]
            sync_parent(path)?;
            Ok(())
        }
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => {
            verify_existing(path, expected_sha256, expected_size).await
        }
        Err(error) => Err(internal_io("保存 Geo 数据", error.error)),
    }
}

async fn verify_existing(
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), GeoDataError> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|error| internal_io("检查已有 Geo 数据", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != expected_size {
        return Err(GeoDataError::Internal(anyhow::anyhow!(
            "已有 Geo 数据与内容摘要不一致：{}",
            path.display()
        )));
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| internal_io("读取已有 Geo 数据", error))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| internal_io("校验已有 Geo 数据", error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if encode_hex(hasher.finalize()) != expected_sha256 {
        return Err(GeoDataError::Internal(anyhow::anyhow!(
            "已有 Geo 数据与内容摘要不一致：{}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_file_permissions(file: &fs::File) -> Result<(), GeoDataError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o640))
        .map_err(|error| internal_io("设置 Geo 数据文件权限", error))
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), GeoDataError> {
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| internal_io("持久化 Geo 数据目录", error))?;
    }
    Ok(())
}

fn internal_io(action: &str, error: std::io::Error) -> GeoDataError {
    GeoDataError::Internal(anyhow::Error::new(error).context(action.to_owned()))
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use tempfile::{Builder, tempdir};

    use super::{
        GeoDataError, GeoDataManager, GeoDataManifest, GeoDataResource, GeoDataSyncRequest,
        MANIFEST_KEY, ResourceKind, apply_manifest_paths, cleanup_managed_files,
        is_allowed_download_ip, is_mihomo_fake_ip, is_public_ip, normalize_geosite_urls, parse_url,
        persist_content_addressed, protected_geo_paths,
    };
    use crate::db::Database;
    use crate::digest::sha256_hex;

    /// 下载出错的说法：前面说下的是什么，连接一类的原因再说一句稍后再试
    /// How a failed download reads: what was downloaded comes first, and a connection-type cause adds 稍后再试
    #[test]
    fn a_failed_download_names_what_and_why() {
        let gone = GeoDataError::download("Geo 数据", "服务器返回 HTTP 404，链接可能失效了", false);
        assert_eq!(
            gone.to_string(),
            "Geo 数据没下载成功：服务器返回 HTTP 404，链接可能失效了"
        );
        let down = GeoDataError::download("拦截列表", "连不上 lists.example.org", true);
        assert_eq!(
            down.to_string(),
            "拦截列表没下载成功：连不上 lists.example.org，稍后再试"
        );
    }

    #[test]
    fn only_accepts_safe_https_urls() {
        assert!(parse_url("https://example.com/geosite.dat", "Geo 数据").is_ok());
        assert!(parse_url("http://example.com/geosite.dat", "Geo 数据").is_err());
        assert!(parse_url("https://user:secret@example.com/geosite.dat", "Geo 数据").is_err());
    }

    #[test]
    fn rejects_non_public_addresses() {
        for ip in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            "2001:db8::1".parse().unwrap(),
            "2002:7f00:1::".parse().unwrap(),
        ] {
            assert!(!is_public_ip(ip), "{ip} 不应视为公网地址");
        }
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn accepts_only_the_mihomo_fake_ip_reserved_range() {
        for ip in [
            Ipv4Addr::new(198, 18, 0, 0),
            Ipv4Addr::new(198, 18, 255, 255),
            Ipv4Addr::new(198, 19, 255, 255),
        ] {
            let ip = IpAddr::V4(ip);
            assert!(is_mihomo_fake_ip(ip));
            assert!(!is_public_ip(ip));
            assert!(is_allowed_download_ip(ip));
        }
        for ip in [
            IpAddr::V4(Ipv4Addr::new(198, 17, 255, 255)),
            IpAddr::V4(Ipv4Addr::new(198, 20, 0, 0)),
        ] {
            assert!(!is_mihomo_fake_ip(ip));
        }
        for ip in [
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ] {
            assert!(!is_mihomo_fake_ip(ip));
            assert!(!is_allowed_download_ip(ip));
        }
    }

    #[test]
    fn normalizes_geosite_urls_and_limits_count() {
        let values = vec![
            " https://example.com/geosite.dat ".to_owned(),
            "https://example.com/geosite.dat".to_owned(),
            String::new(),
        ];
        assert_eq!(normalize_geosite_urls(values).unwrap().len(), 1);
        let too_many = (0..9)
            .map(|index| format!("https://example.com/{index}.dat"))
            .collect();
        assert!(normalize_geosite_urls(too_many).is_err());
    }

    #[test]
    fn preserves_json_extension_for_supported_resources() {
        let url = parse_url("https://example.com/geosite.json", "Geo 数据").unwrap();
        assert_eq!(ResourceKind::Site.extension(&url), "json");
        assert_eq!(ResourceKind::IpDat.extension(&url), "json");
        assert_eq!(ResourceKind::Mmdb.extension(&url), "mmdb");
    }

    #[tokio::test]
    async fn verifies_existing_content_addressed_files_before_reuse() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("geoip-mmdb-digest.mmdb");
        std::fs::write(&path, b"evil").unwrap();
        let mut temporary = Builder::new().tempfile_in(directory.path()).unwrap();
        temporary.write_all(b"good").unwrap();
        let digest = sha256_hex(b"good");
        assert!(
            persist_content_addressed(temporary, &path, &digest, 4)
                .await
                .is_err()
        );

        std::fs::write(&path, b"good").unwrap();
        let mut duplicate = Builder::new().tempfile_in(directory.path()).unwrap();
        duplicate.write_all(b"good").unwrap();
        persist_content_addressed(duplicate, &path, &digest, 4)
            .await
            .unwrap();
    }

    #[test]
    fn removes_only_unreferenced_managed_geo_files() {
        let directory = tempdir().unwrap();
        let digest_a = "a".repeat(64);
        let digest_b = "b".repeat(64);
        let digest_c = "c".repeat(64);
        let retained = directory.path().join(format!("geoip-mmdb-{digest_a}.mmdb"));
        let retained_by_history = directory.path().join(format!("geoip-dat-{digest_c}.dat"));
        let removable = directory.path().join(format!("geosite-{digest_b}.dat"));
        let unknown = directory.path().join("notes.txt");
        std::fs::write(&retained, b"keep").unwrap();
        std::fs::write(&retained_by_history, b"history").unwrap();
        std::fs::write(&removable, b"remove").unwrap();
        std::fs::write(&unknown, b"unknown").unwrap();

        let manifest = GeoDataManifest {
            geoip_mmdb: Some(GeoDataResource {
                url: "https://example.com/geo.mmdb".to_owned(),
                path: retained.to_string_lossy().into_owned(),
                sha256: digest_a,
                size: 4,
                downloaded_at: 1,
            }),
            ..GeoDataManifest::default()
        };
        let history = serde_json::json!({
            "settings": {
                "geoip_dat_path": retained_by_history.to_string_lossy()
            }
        });
        let protected = protected_geo_paths(directory.path(), &[history], &manifest);
        let result = cleanup_managed_files(directory.path(), &protected).unwrap();

        assert_eq!(result.scanned_files, 3);
        assert_eq!(result.removed_files, 1);
        assert_eq!(result.reclaimed_bytes, 6);
        assert!(retained.exists());
        assert!(retained_by_history.exists());
        assert!(!removable.exists());
        assert!(unknown.exists());
    }

    /// Geo 同步改写 `GeoSite` 文件时，拦截列表合并的文件原样留在后面；名字像、但不是面板生成的不算
    /// A Geo sync rewriting the `GeoSite` files leaves the blocklists' merged file in place after them; a look-alike
    /// name the panel did not produce does not count
    #[test]
    fn a_geo_sync_keeps_the_blocklist_file() {
        let blocklist = format!(
            "/var/lib/kixdns-panel/geo/blocklist-{}.json",
            "e".repeat(64)
        );
        let manifest = GeoDataManifest {
            geosite: vec![GeoDataResource {
                url: "https://example.com/geosite.dat".to_owned(),
                path: "/var/lib/kixdns-panel/geo/geosite-new.dat".to_owned(),
                sha256: "a".repeat(64),
                size: 42,
                downloaded_at: 1,
            }],
            ..GeoDataManifest::default()
        };
        let mut content = serde_json::json!({
            "settings": { "geosite_data_paths": [blocklist, "/etc/old.dat", "/etc/blocklist-mine.json"] }
        });
        assert!(apply_manifest_paths(&mut content, &manifest).unwrap());
        assert_eq!(
            content["settings"]["geosite_data_paths"],
            serde_json::json!(["/var/lib/kixdns-panel/geo/geosite-new.dat", blocklist])
        );
    }

    #[test]
    fn applies_manifest_paths_and_reuses_remote_sources() {
        let resource = GeoDataResource {
            url: "https://example.com/geosite.dat".to_owned(),
            path: "/var/lib/kixdns/geo/geosite.dat".to_owned(),
            sha256: "a".repeat(64),
            size: 42,
            downloaded_at: 1,
        };
        let manifest = GeoDataManifest {
            geosite: vec![resource],
            ..GeoDataManifest::default()
        };
        let mut content = serde_json::json!({
            "settings": {"geoip_db_path": "/tmp/old.mmdb"},
            "pipelines": []
        });

        assert!(apply_manifest_paths(&mut content, &manifest).unwrap());
        assert!(content["settings"].get("geoip_db_path").is_none());
        assert_eq!(
            content["settings"]["geosite_data_paths"],
            serde_json::json!(["/var/lib/kixdns/geo/geosite.dat"])
        );
        assert!(!apply_manifest_paths(&mut content, &manifest).unwrap());

        let request = GeoDataSyncRequest::from_manifest(&manifest);
        assert_eq!(
            request.geosite_urls,
            vec!["https://example.com/geosite.dat"]
        );
        assert!(!request.is_empty());
    }

    #[tokio::test]
    async fn schedule_accepts_fixed_intervals_and_preserves_same_setting() {
        let directory = tempdir().unwrap();
        let database = Database::open(directory.path().join("panel.db"))
            .await
            .unwrap();
        let manager = GeoDataManager::new(database, &directory.path().join("geo")).unwrap();

        assert!(matches!(
            manager.schedule().set_interval(Some(12)).await,
            Err(GeoDataError::Invalid(_))
        ));
        let enabled = manager.schedule().set_interval(Some(24)).await.unwrap();
        assert_eq!(enabled.interval_hours, Some(24));
        manager.schedule().mark_attempt(1_000).await.unwrap();
        manager.schedule().mark_result(1_001, None).await.unwrap();

        let unchanged = manager.schedule().set_interval(Some(24)).await.unwrap();
        assert_eq!(unchanged.last_attempt_at, Some(1_000));
        assert_eq!(unchanged.last_success_at, Some(1_001));
        assert_eq!(unchanged.next_run_at, Some(87_400));
        assert!(!unchanged.is_due(87_399));
        assert!(unchanged.is_due(87_400));

        let disabled = manager.schedule().set_interval(None).await.unwrap();
        assert_eq!(disabled.interval_hours, None);
        assert_eq!(disabled.next_run_at, None);
        assert!(!disabled.is_due(i64::MAX));
    }

    const BUILTIN_URL: &str =
        "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat";

    /// 安装包里的内置 GeoSite：一个只有 `cn` 分类的数据文件和它的说明。
    /// The package's built-in `GeoSite`: a data file holding only the `cn` category, and its descriptor.
    fn write_builtin(directory: &std::path::Path) -> (std::path::PathBuf, Vec<u8>) {
        let builtin = directory.join("builtin");
        std::fs::create_dir_all(&builtin).unwrap();
        let data = b"\x0a\x04\x0a\x02cn".to_vec();
        std::fs::write(builtin.join("geosite.dat"), &data).unwrap();
        let descriptor = builtin.join("geosite.json");
        std::fs::write(
            &descriptor,
            serde_json::json!({
                "schema_version": 1,
                "file": "geosite.dat",
                "url": BUILTIN_URL,
                "release": "202610122207",
                "release_url": "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/tag/202610122207",
                "published_at": "2026-10-12T22:08:31Z",
                "sha256": sha256_hex(&data),
                "size": data.len(),
                "license": "GPL-3.0",
            })
            .to_string(),
        )
        .unwrap();
        (descriptor, data)
    }

    async fn manager_with_builtin(
        directory: &std::path::Path,
        descriptor: std::path::PathBuf,
    ) -> GeoDataManager {
        let database = Database::open(directory.join("panel.db")).await.unwrap();
        GeoDataManager::new(database, &directory.join("geo"))
            .unwrap()
            .with_builtin_geosite(descriptor)
    }

    #[tokio::test]
    async fn imports_the_builtin_geosite_into_the_managed_store() {
        let directory = tempdir().unwrap();
        let (descriptor, data) = write_builtin(directory.path());
        let manager = manager_with_builtin(directory.path(), descriptor).await;

        let builtin = manager
            .builtin_geosite()
            .unwrap()
            .expect("built-in GeoSite");
        assert_eq!(builtin.url, BUILTIN_URL);
        assert_eq!(builtin.release, "202610122207");
        let manifest = manager.import_builtin_geosite().await.unwrap();

        assert_eq!(manifest.geosite.len(), 1);
        let resource = &manifest.geosite[0];
        // 来源记成下载链接：之后的更新按它走，用户也可以改成别的
        // The source is the download link: later updates follow it, and the user may change it
        assert_eq!(resource.url, BUILTIN_URL);
        assert_eq!(resource.sha256, sha256_hex(&data));
        let stored = std::path::Path::new(&resource.path);
        assert_eq!(
            stored.file_name().unwrap().to_string_lossy(),
            format!("geosite-{}.dat", sha256_hex(&data))
        );
        assert_eq!(std::fs::read(stored).unwrap(), data);
        assert_eq!(manager.current().await.unwrap().geosite.len(), 1);
    }

    #[tokio::test]
    async fn the_builtin_geosite_never_replaces_existing_geosite_data() {
        let directory = tempdir().unwrap();
        let (descriptor, _) = write_builtin(directory.path());
        let manager = manager_with_builtin(directory.path(), descriptor).await;
        let own = GeoDataManifest {
            geosite: vec![GeoDataResource {
                url: "https://example.com/my-geosite.dat".to_owned(),
                path: "/var/lib/kixdns-panel/geo/geosite-mine.dat".to_owned(),
                sha256: "d".repeat(64),
                size: 9,
                downloaded_at: 1,
            }],
            ..GeoDataManifest::default()
        };
        manager
            .database
            .set_setting(MANIFEST_KEY, serde_json::to_string(&own).unwrap(), 1)
            .await
            .unwrap();

        assert!(matches!(
            manager.import_builtin_geosite().await,
            Err(GeoDataError::Invalid(_))
        ));
        let kept = manager.current().await.unwrap();
        assert_eq!(kept.geosite.len(), 1);
        assert_eq!(kept.geosite[0].url, "https://example.com/my-geosite.dat");
    }

    #[tokio::test]
    async fn a_builtin_geosite_that_disagrees_with_its_descriptor_is_refused() {
        let directory = tempdir().unwrap();
        let (descriptor, data) = write_builtin(directory.path());
        let mut description: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&descriptor).unwrap()).unwrap();

        // 内容被换过（大小一样，摘要不同）：导入时才发现，清单不动
        // The content was swapped (same size, different digest): caught at import, the manifest untouched
        let mut tampered = data.clone();
        *tampered.last_mut().unwrap() = b'x';
        std::fs::write(descriptor.with_file_name("geosite.dat"), &tampered).unwrap();
        let manager = manager_with_builtin(directory.path(), descriptor.clone()).await;
        assert!(manager.builtin_geosite().unwrap().is_some());
        assert!(manager.import_builtin_geosite().await.is_err());
        assert!(manager.current().await.unwrap().geosite.is_empty());
        std::fs::write(descriptor.with_file_name("geosite.dat"), &data).unwrap();

        for (field, value) in [
            ("size", serde_json::json!(data.len() + 1)),
            ("file", serde_json::json!("../geosite.dat")),
            ("url", serde_json::json!("http://example.com/geosite.dat")),
            ("sha256", serde_json::json!("abc")),
            ("schema_version", serde_json::json!(2)),
        ] {
            let mut changed = description.clone();
            changed[field] = value;
            std::fs::write(&descriptor, changed.to_string()).unwrap();
            assert!(manager.builtin_geosite().is_err(), "{field}");
        }
        description["release"] = serde_json::json!("202610122207");
        std::fs::remove_file(&descriptor).unwrap();
        assert!(
            manager.builtin_geosite().unwrap().is_none(),
            "no descriptor, no built-in"
        );
    }

    #[tokio::test]
    async fn the_fresh_install_marker_is_read_once_and_cleared() {
        let directory = tempdir().unwrap();
        let (descriptor, _) = write_builtin(directory.path());
        let manager = manager_with_builtin(directory.path(), descriptor).await;
        assert!(!manager.builtin_seed_requested());
        std::fs::write(directory.path().join("geo/.import-builtin-geosite"), b"").unwrap();
        assert!(manager.builtin_seed_requested());
        manager.clear_builtin_seed().unwrap();
        assert!(!manager.builtin_seed_requested());
        manager.clear_builtin_seed().unwrap();
    }
}
