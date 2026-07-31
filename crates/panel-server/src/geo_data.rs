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

#[derive(Clone)]
pub struct GeoDataManager {
    database: Database,
    root: Arc<PathBuf>,
    sync_lock: Arc<Mutex<()>>,
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
    #[error("{0}")]
    Download(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
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
            database,
            root: Arc::new(root),
            sync_lock: Arc::new(Mutex::new(())),
        })
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

    pub async fn schedule(&self) -> Result<GeoDataSchedule, GeoDataError> {
        let Some(value) = self.database.get_setting(SCHEDULE_KEY).await? else {
            return Ok(GeoDataSchedule::default());
        };
        let mut schedule: GeoDataSchedule = serde_json::from_str(&value).map_err(|error| {
            GeoDataError::Internal(anyhow::Error::new(error).context("Geo 定时更新设置已损坏"))
        })?;
        schedule.refresh_next_run();
        Ok(schedule)
    }

    pub async fn set_schedule(
        &self,
        interval_hours: Option<u64>,
    ) -> Result<GeoDataSchedule, GeoDataError> {
        if !matches!(interval_hours, None | Some(24 | 168)) {
            return Err(GeoDataError::Invalid(
                "Geo 自动更新仅支持每天或每周".to_owned(),
            ));
        }
        let mut schedule = self.schedule().await?;
        if schedule.interval_hours == interval_hours {
            return Ok(schedule);
        }
        schedule.interval_hours = interval_hours;
        schedule.last_attempt_at = None;
        schedule.last_error = None;
        schedule.refresh_next_run();
        self.store_schedule(&schedule).await?;
        Ok(schedule)
    }

    pub async fn mark_schedule_attempt(&self, now: i64) -> Result<(), GeoDataError> {
        let mut schedule = self.schedule().await?;
        schedule.last_attempt_at = Some(now);
        schedule.refresh_next_run();
        self.store_schedule(&schedule).await
    }

    pub async fn mark_schedule_result(
        &self,
        now: i64,
        error: Option<String>,
    ) -> Result<(), GeoDataError> {
        let mut schedule = self.schedule().await?;
        if error.is_none() {
            schedule.last_success_at = Some(now);
        }
        schedule.last_error = error.map(|message| message.chars().take(500).collect());
        schedule.refresh_next_run();
        self.store_schedule(&schedule).await
    }

    pub async fn cleanup(
        &self,
        retained_configs: &[Value],
    ) -> Result<GeoDataCleanupResult, GeoDataError> {
        let _guard = self.sync_lock.lock().await;
        let manifest = self.current().await?;
        let protected = protected_geo_paths(self.root.as_ref(), retained_configs, &manifest);
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
        let initial_url = parse_url(raw_url)?;
        let (response, final_url) = request_with_safe_redirects(initial_url).await?;
        validate_response(&response)?;

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
            let chunk = chunk
                .map_err(|error| GeoDataError::Download(format!("下载 Geo 数据失败：{error}")))?;
            size = size
                .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
                .ok_or_else(|| GeoDataError::Download("Geo 数据文件过大".to_owned()))?;
            if size > MAX_DOWNLOAD_BYTES {
                return Err(GeoDataError::Download(format!(
                    "Geo 数据文件不能超过 {} MiB",
                    MAX_DOWNLOAD_BYTES / 1024 / 1024
                )));
            }
            hasher.update(&chunk);
            writer
                .write_all(&chunk)
                .await
                .map_err(|error| internal_io("写入 Geo 数据", error))?;
        }
        if size == 0 {
            return Err(GeoDataError::Download("Geo 数据文件为空".to_owned()));
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
        let filename = format!("{}-{sha256}.{}", kind.prefix(), kind.extension(&final_url));
        let path = self.root.join(filename);
        persist_content_addressed(temporary, &path, &sha256, size).await?;

        Ok(GeoDataResource {
            url: raw_url.to_owned(),
            path: path.to_string_lossy().into_owned(),
            sha256,
            size,
            downloaded_at: unix_timestamp(),
        })
    }

    async fn store_schedule(&self, schedule: &GeoDataSchedule) -> Result<(), GeoDataError> {
        let serialized = serde_json::to_string(schedule)
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        self.database
            .set_setting(SCHEDULE_KEY, serialized, unix_timestamp())
            .await?;
        Ok(())
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
    settings.insert(
        "geosite_data_paths".to_owned(),
        Value::Array(
            manifest
                .geosite
                .iter()
                .map(|resource| Value::String(resource.path.clone()))
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

fn is_managed_geo_filename(name: &str) -> bool {
    [
        ("geoip-mmdb-", &["mmdb"][..]),
        ("geoip-dat-", &["dat", "json"][..]),
        ("geosite-", &["dat", "json"][..]),
    ]
    .iter()
    .any(|(prefix, extensions)| {
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
    })
}

fn normalize_optional_url(value: Option<String>) -> Result<Option<String>, GeoDataError> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .map(|value| {
            parse_url(&value)?;
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
        parse_url(&value)?;
        normalized.push(value);
    }
    if normalized.len() > MAX_GEOSITE_FILES {
        return Err(GeoDataError::Invalid(format!(
            "GeoSite 链接不能超过 {MAX_GEOSITE_FILES} 个"
        )));
    }
    Ok(normalized)
}

fn parse_url(value: &str) -> Result<Url, GeoDataError> {
    if value.len() > MAX_URL_BYTES {
        return Err(GeoDataError::Invalid("Geo 数据链接过长".to_owned()));
    }
    let url = Url::parse(value)
        .map_err(|_| GeoDataError::Invalid("Geo 数据链接格式不正确".to_owned()))?;
    if url.scheme() != "https" {
        return Err(GeoDataError::Invalid(
            "Geo 数据链接仅允许使用 HTTPS".to_owned(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(GeoDataError::Invalid(
            "Geo 数据链接不能包含用户名或密码".to_owned(),
        ));
    }
    if url.host().is_none() {
        return Err(GeoDataError::Invalid("Geo 数据链接缺少主机名".to_owned()));
    }
    Ok(url)
}

async fn request_with_safe_redirects(mut url: Url) -> Result<(Response, Url), GeoDataError> {
    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, address) = resolve_public_address(&url).await?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_mins(2))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .user_agent(concat!("kixdns-panel/", env!("CARGO_PKG_VERSION")))
            .resolve(&host, address)
            .build()
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| GeoDataError::Download(format!("下载 Geo 数据失败：{error}")))?;
        if !response.status().is_redirection() {
            return Ok((response, url));
        }
        if redirect_count == MAX_REDIRECTS {
            return Err(GeoDataError::Download(
                "Geo 数据链接重定向次数过多".to_owned(),
            ));
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| GeoDataError::Download("Geo 数据重定向缺少目标地址".to_owned()))?;
        url = parse_url(
            url.join(location)
                .map_err(|_| GeoDataError::Download("Geo 数据重定向地址无效".to_owned()))?
                .as_str(),
        )?;
    }
    unreachable!("重定向循环总会返回")
}

async fn resolve_public_address(url: &Url) -> Result<(String, SocketAddr), GeoDataError> {
    let host = url
        .host_str()
        .ok_or_else(|| GeoDataError::Invalid("Geo 数据链接缺少主机名".to_owned()))?
        .trim_end_matches('.')
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let mut addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|error| GeoDataError::Download(format!("解析 Geo 数据主机失败：{error}")))?
            .collect::<Vec<_>>()
    };
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() {
        return Err(GeoDataError::Download(
            "Geo 数据主机没有可用地址".to_owned(),
        ));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(GeoDataError::Invalid(
            "Geo 数据链接不能指向本机、私网或保留地址".to_owned(),
        ));
    }
    Ok((host, addresses[0]))
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

fn validate_response(response: &Response) -> Result<(), GeoDataError> {
    if response.status() != StatusCode::OK {
        return Err(GeoDataError::Download(format!(
            "Geo 数据服务器返回 HTTP {}",
            response.status().as_u16()
        )));
    }
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
    {
        return Err(GeoDataError::Download(format!(
            "Geo 数据文件不能超过 {} MiB",
            MAX_DOWNLOAD_BYTES / 1024 / 1024
        )));
    }
    if response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/html"))
    {
        return Err(GeoDataError::Download(
            "Geo 数据链接返回了 HTML 页面，请填写文件直链".to_owned(),
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
        ResourceKind, apply_manifest_paths, cleanup_managed_files, is_public_ip,
        normalize_geosite_urls, parse_url, persist_content_addressed, protected_geo_paths,
    };
    use crate::db::Database;
    use crate::digest::sha256_hex;

    #[test]
    fn only_accepts_safe_https_urls() {
        assert!(parse_url("https://example.com/geosite.dat").is_ok());
        assert!(parse_url("http://example.com/geosite.dat").is_err());
        assert!(parse_url("https://user:secret@example.com/geosite.dat").is_err());
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
        let url = parse_url("https://example.com/geosite.json").unwrap();
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
            manager.set_schedule(Some(12)).await,
            Err(GeoDataError::Invalid(_))
        ));
        let enabled = manager.set_schedule(Some(24)).await.unwrap();
        assert_eq!(enabled.interval_hours, Some(24));
        manager.mark_schedule_attempt(1_000).await.unwrap();
        manager.mark_schedule_result(1_001, None).await.unwrap();

        let unchanged = manager.set_schedule(Some(24)).await.unwrap();
        assert_eq!(unchanged.last_attempt_at, Some(1_000));
        assert_eq!(unchanged.last_success_at, Some(1_001));
        assert_eq!(unchanged.next_run_at, Some(87_400));
        assert!(!unchanged.is_due(87_399));
        assert!(unchanged.is_due(87_400));

        let disabled = manager.set_schedule(None).await.unwrap();
        assert_eq!(disabled.interval_hours, None);
        assert_eq!(disabled.next_run_at, None);
        assert!(!disabled.is_due(i64::MAX));
    }
}
