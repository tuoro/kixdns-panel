//! 读出 `GeoSite` 数据文件里有哪些分类：每个分类多少个域名，带哪些属性、各多少个。配置页拿它给用户
//! 挑分类，并指出规则里写了数据里没有的分类。读法和内核一致：`.dat` 是 `V2Ray` 的 `GeoSiteList`
//! protobuf，其余按 `V2Ray` 的 JSON 读；分类名不分大小写，几个文件里有同名分类时后面的文件为准。
//! Reads which categories a `GeoSite` data file holds: how many domains each has, and which attributes
//! with how many domains each. The config page uses it to let people pick categories and to point out
//! rules naming a category the data lacks. It reads files the way the kernel does: `.dat` is `V2Ray`'s
//! `GeoSiteList` protobuf and anything else `V2Ray`'s JSON; names ignore case, and when several files share
//! a category the later file wins.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::digest::sha256_hex;
use crate::protobuf::{Fields, Value};

/// 读分类时接受的最大文件，和下载 Geo 数据的上限一样 / The largest file read for categories, the same as the Geo download limit
const MAX_CATALOG_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GeositeCategory {
    /// 小写的分类名 / The category name in lower case
    pub name: String,
    pub domains: u32,
    /// 按属性名排好；没有属性时是空的 / Sorted by key; empty when the category has none
    pub attributes: Vec<GeositeAttribute>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GeositeAttribute {
    /// 小写的属性名，例如 `cn`、`ads`、`!cn` / The attribute key in lower case, e.g. `cn`, `ads`, `!cn`
    pub key: String,
    pub domains: u32,
}

/// 一个文件读出来的分类，按内容摘要区分：内置那份和导入后的副本是同一份 / One file's categories, told apart by content digest: the built-in file and its imported copy are one
#[derive(Debug, Clone)]
pub struct GeositeCatalog {
    pub sha256: String,
    pub categories: Arc<Vec<GeositeCategory>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CatalogError {
    Missing,
    Unreadable,
    NotAFile,
    TooLarge,
    Invalid(String),
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => formatter.write_str("文件不存在"),
            Self::Unreadable => formatter.write_str("面板没有权限读这个文件"),
            Self::NotAFile => formatter.write_str("这不是一个普通文件"),
            Self::TooLarge => formatter.write_str("文件超过 128 MiB，面板不读"),
            Self::Invalid(reason) => write!(formatter, "不是能读的 GeoSite 数据：{reason}"),
        }
    }
}

struct Cached {
    len: u64,
    modified: Option<SystemTime>,
    catalog: GeositeCatalog,
}

/// 按路径缓存读过的文件；大小或修改时间变了就重读。面板管理的文件按摘要命名，内容不会变。
/// Caches files by path and rereads one whose size or modification time changed. Files the panel
/// manages are named by digest, so their content never changes.
#[derive(Default)]
pub struct CatalogCache {
    entries: Mutex<HashMap<PathBuf, Cached>>,
}

impl CatalogCache {
    /// 读一个文件的分类（会读磁盘、解析整个文件，要在阻塞线程里调） / Reads one file's categories (disk and parsing: call it on a blocking thread)
    pub fn read(&self, path: &Path) -> Result<GeositeCatalog, CatalogError> {
        let metadata = fs::metadata(path).map_err(|error| io_error(&error))?;
        if !metadata.is_file() {
            return Err(CatalogError::NotAFile);
        }
        if metadata.len() > MAX_CATALOG_BYTES {
            return Err(CatalogError::TooLarge);
        }
        let modified = metadata.modified().ok();
        if let Some(cached) = self.lock().get(path)
            && cached.len == metadata.len()
            && cached.modified == modified
        {
            return Ok(cached.catalog.clone());
        }
        // 解析在锁外做：一个大文件不挡着别的请求 / Parse outside the lock so one large file does not hold up other requests
        let catalog = read_catalog(path)?;
        self.lock().insert(
            path.to_owned(),
            Cached {
                len: metadata.len(),
                modified,
                catalog: catalog.clone(),
            },
        );
        Ok(catalog)
    }

    /// 只留下这次还用得到的文件，换掉的数据不一直占着内存 / Keeps only the files still in use, so replaced data does not stay in memory
    pub fn retain(&self, paths: &HashSet<PathBuf>) {
        self.lock().retain(|path, _| paths.contains(path));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Cached>> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn io_error(error: &std::io::Error) -> CatalogError {
    match error.kind() {
        ErrorKind::NotFound => CatalogError::Missing,
        _ => CatalogError::Unreadable,
    }
}

fn read_catalog(path: &Path) -> Result<GeositeCatalog, CatalogError> {
    let mut file = fs::File::open(path).map_err(|error| io_error(&error))?;
    let mut data = Vec::new();
    // 打开后再限一次：stat 和读之间文件可能变大 / Limit again after opening: the file may grow between stat and read
    file.by_ref()
        .take(MAX_CATALOG_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| io_error(&error))?;
    if data.len() as u64 > MAX_CATALOG_BYTES {
        return Err(CatalogError::TooLarge);
    }
    // 和内核同一个判定：扩展名是 .dat（不分大小写）就是 protobuf，其余按 JSON
    // The kernel's rule: a `.dat` extension (any case) means protobuf, anything else JSON
    let is_dat = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("dat"));
    let categories = if is_dat {
        parse_dat(&data)
    } else {
        parse_json(&data)
    }
    .map_err(CatalogError::Invalid)?;
    Ok(GeositeCatalog {
        sha256: sha256_hex(&data),
        categories: Arc::new(categories),
    })
}

/// 一个分类读到一半的样子：域名数和各属性的域名数 / A category while being read: its domain count and the count per attribute
#[derive(Default)]
struct Tally {
    domains: u32,
    attributes: BTreeMap<String, u32>,
}

fn finish(tallies: BTreeMap<String, Tally>) -> Vec<GeositeCategory> {
    tallies
        .into_iter()
        // 内核不收没有域名的分类：写了也匹配不到 / The kernel drops a category without domains: it can never match
        .filter(|(_, tally)| tally.domains > 0)
        .map(|(name, tally)| GeositeCategory {
            name,
            domains: tally.domains,
            attributes: tally
                .attributes
                .into_iter()
                .map(|(key, domains)| GeositeAttribute { key, domains })
                .collect(),
        })
        .collect()
}

/// `GeoSiteList { repeated GeoSite entry = 1; }`，`GeoSite { string country_code = 1; repeated Domain domain = 2; }`，
/// `Domain { Type type = 1; string value = 2; repeated Attribute attribute = 3; }`，`Attribute { string key = 1; … }`。
fn parse_dat(data: &[u8]) -> Result<Vec<GeositeCategory>, String> {
    let mut tallies = BTreeMap::new();
    for field in Fields::new(data) {
        let (number, value) = field?;
        let (1, Value::Bytes(site)) = (number, value) else {
            continue;
        };
        let mut name = None;
        let mut tally = Tally::default();
        for field in Fields::new(site) {
            match field? {
                (1, Value::Bytes(code)) => {
                    let code = std::str::from_utf8(code).map_err(|_| "分类名不是 UTF-8")?;
                    name = Some(code.to_ascii_lowercase());
                }
                (2, Value::Bytes(domain)) => {
                    tally.domains = tally.domains.saturating_add(1);
                    // 一个域名同一个属性写两遍也只算一次 / A domain listing one attribute twice counts once
                    let mut keys = HashSet::new();
                    for field in Fields::new(domain) {
                        if let (3, Value::Bytes(attribute)) = field?
                            && let Some(key) = attribute_key(attribute)?
                        {
                            keys.insert(key);
                        }
                    }
                    for key in keys {
                        *tally.attributes.entry(key).or_default() += 1;
                    }
                }
                _ => {}
            }
        }
        // 同名分类后面的为准，和内核一样 / A later category of the same name wins, as in the kernel
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            tallies.insert(name, tally);
        }
    }
    Ok(finish(tallies))
}

fn attribute_key(attribute: &[u8]) -> Result<Option<String>, String> {
    for field in Fields::new(attribute) {
        if let (1, Value::Bytes(key)) = field? {
            let key = std::str::from_utf8(key).map_err(|_| "属性名不是 UTF-8")?;
            return Ok((!key.is_empty()).then(|| key.to_ascii_lowercase()));
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
struct JsonList {
    entries: Vec<JsonEntry>,
}

#[derive(Deserialize)]
struct JsonEntry {
    tag: String,
    domains: Vec<String>,
}

/// `V2Ray` 的 JSON：`{"entries": [{"tag": "cn", "domains": ["…"]}]}`，没有属性 / `V2Ray`'s JSON form, which carries no attributes
fn parse_json(data: &[u8]) -> Result<Vec<GeositeCategory>, String> {
    let list: JsonList = serde_json::from_slice(data).map_err(|error| error.to_string())?;
    let mut tallies = BTreeMap::new();
    for entry in list.entries {
        let name = entry.tag.to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        let domains = u32::try_from(entry.domains.len()).unwrap_or(u32::MAX);
        tallies.insert(
            name,
            Tally {
                domains,
                attributes: BTreeMap::new(),
            },
        );
    }
    Ok(finish(tallies))
}

/// 测试里拼 `GeoSiteList` 用（面板接口的测试也用它） / Builds `GeoSiteList` bytes for tests, the panel API tests included
#[cfg(test)]
pub(crate) mod test_data {
    use crate::protobuf::test_data::{bytes_field, varint};

    pub(crate) fn domain(value: &str, attributes: &[&str]) -> Vec<u8> {
        let mut message = varint(1 << 3);
        message.extend(varint(2));
        message.extend(bytes_field(2, value.as_bytes()));
        for key in attributes {
            let mut attribute = bytes_field(1, key.as_bytes());
            // bool_value = true，内核和这里都只看属性名 / bool_value = true; only the key matters here, as in the kernel
            attribute.extend(varint(2 << 3));
            attribute.extend(varint(1));
            message.extend(bytes_field(3, &attribute));
        }
        message
    }

    pub(crate) fn site(name: &str, domains: &[Vec<u8>]) -> Vec<u8> {
        let mut message = bytes_field(1, name.as_bytes());
        for domain in domains {
            message.extend(bytes_field(2, domain));
        }
        bytes_field(1, &message)
    }
}

#[cfg(test)]
mod tests {
    use super::test_data::{domain, site};
    use super::*;

    #[test]
    fn reads_categories_domain_counts_and_attributes_from_a_dat_file() {
        let mut data = site(
            "GOOGLE",
            &[
                domain("google.com", &[]),
                domain("google.cn", &["cn"]),
                domain("doubleclick.net", &["ads", "ads"]),
                domain("google.com.hk", &["CN", "!cn"]),
            ],
        );
        data.extend(site("CN", &[domain("baidu.com", &[])]));
        data.extend(site("EMPTY", &[]));
        let categories = parse_dat(&data).unwrap();
        assert_eq!(
            categories,
            vec![
                GeositeCategory {
                    name: "cn".to_owned(),
                    domains: 1,
                    attributes: vec![],
                },
                GeositeCategory {
                    name: "google".to_owned(),
                    domains: 4,
                    attributes: vec![
                        GeositeAttribute {
                            key: "!cn".to_owned(),
                            domains: 1,
                        },
                        GeositeAttribute {
                            key: "ads".to_owned(),
                            domains: 1,
                        },
                        GeositeAttribute {
                            key: "cn".to_owned(),
                            domains: 2,
                        },
                    ],
                },
            ],
            "names are lower case, a repeated attribute counts once and an empty category is dropped"
        );
    }

    #[test]
    fn a_later_category_of_the_same_name_wins_as_in_the_kernel() {
        let mut data = site("cn", &[domain("a.cn", &[]), domain("b.cn", &[])]);
        data.extend(site("CN", &[domain("c.cn", &["cn"])]));
        let categories = parse_dat(&data).unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].domains, 1);
        assert_eq!(categories[0].attributes.len(), 1);
    }

    #[test]
    fn truncated_or_malformed_dat_data_is_an_error_not_a_panic() {
        let data = site("cn", &[domain("baidu.com", &["cn"])]);
        for end in 1..data.len() {
            assert!(parse_dat(&data[..end]).is_err(), "cut at {end}");
        }
        // 组（线型 3）不是 GeoSite 里会有的东西 / Groups (wire type 3) never occur in GeoSite data
        assert!(parse_dat(&[0x0b]).is_err());
        assert!(
            parse_dat(&[
                0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01
            ])
            .is_err()
        );
    }

    #[test]
    fn reads_the_v2ray_json_form() {
        let data = br#"{"entries":[{"tag":"Private","domains":["lan","local"]},{"tag":"x","domains":[]}]}"#;
        assert_eq!(
            parse_json(data).unwrap(),
            vec![GeositeCategory {
                name: "private".to_owned(),
                domains: 2,
                attributes: vec![],
            }]
        );
        assert!(parse_json(b"[]").is_err());
    }

    #[test]
    fn the_cache_rereads_a_changed_file_and_reports_why_a_file_cannot_be_read() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("geosite.dat");
        let cache = CatalogCache::default();
        assert_eq!(cache.read(&path).unwrap_err(), CatalogError::Missing);
        assert_eq!(
            cache.read(directory.path()).unwrap_err(),
            CatalogError::NotAFile
        );

        fs::write(&path, site("cn", &[domain("baidu.com", &[])])).unwrap();
        let first = cache.read(&path).unwrap();
        assert_eq!(first.categories[0].name, "cn");
        assert_eq!(first.sha256, sha256_hex(&fs::read(&path).unwrap()));
        assert!(Arc::ptr_eq(
            &first.categories,
            &cache.read(&path).unwrap().categories
        ));

        // 大小变了就重读 / A changed size means a reread
        let mut changed = site("cn", &[domain("baidu.com", &[])]);
        changed.extend(site("apple", &[domain("apple.com", &[])]));
        fs::write(&path, changed).unwrap();
        let second = cache.read(&path).unwrap();
        assert_eq!(second.categories.len(), 2);
        assert_ne!(second.sha256, first.sha256);

        let json = directory.path().join("geosite.json");
        fs::write(&json, b"not json").unwrap();
        assert!(matches!(cache.read(&json), Err(CatalogError::Invalid(_))));

        cache.retain(&HashSet::from([json.clone()]));
        assert!(!cache.lock().contains_key(&path));
    }
}
