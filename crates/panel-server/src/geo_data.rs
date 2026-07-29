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
use sha2::{Digest, Sha256};
use tempfile::{Builder, NamedTempFile};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::auth::unix_timestamp;
use crate::db::Database;
use crate::digest::encode_hex;

const MANIFEST_KEY: &str = "geo_data_manifest";
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
    pub fn new(database: Database, root: PathBuf) -> Result<Self, GeoDataError> {
        prepare_root(&root)?;
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
        persist_content_addressed(temporary, &path)?;

        Ok(GeoDataResource {
            url: raw_url.to_owned(),
            path: path.to_string_lossy().into_owned(),
            sha256,
            size,
            downloaded_at: unix_timestamp(),
        })
    }
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

fn persist_content_addressed(temporary: NamedTempFile, path: &Path) -> Result<(), GeoDataError> {
    if path.exists() {
        return Ok(());
    }
    match temporary.persist_noclobber(path) {
        Ok(_) => {
            #[cfg(unix)]
            sync_parent(path)?;
            Ok(())
        }
        Err(error) if error.error.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(internal_io("保存 Geo 数据", error.error)),
    }
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
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::{ResourceKind, is_public_ip, normalize_geosite_urls, parse_url};

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
}
