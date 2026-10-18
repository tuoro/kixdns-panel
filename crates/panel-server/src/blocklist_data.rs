//! 订阅的拦截列表：下载原始列表，记下每个列表读得怎么样，把启用的列表合并成一个给内核读的 `GeoSite` 文件。文件放在 Geo
//! 数据的目录里、按内容命名：原始列表是 `blocklist-src-<摘要>.txt`，合并的是 `blocklist-<摘要>.json`。合并的文件里写着它由
//! 哪几个列表的哪一份合成，定时更新据此知道正在用的是哪些列表；订阅本身（有哪些、叫什么、开没开）在配置的草稿里，保存以后
//! 生效，这里只按链接记每个列表的情况。
//! Subscribed blocklists: downloads the raw lists, records how each one read, and merges the enabled ones into one
//! `GeoSite` file for the kernel. Files live in the Geo data directory, named by content: raw lists are
//! `blocklist-src-<digest>.txt` and merged files `blocklist-<digest>.json`. A merged file records which copy of which
//! list it was built from, which tells the scheduled update the lists in use; the subscriptions themselves (which
//! ones, their names, enabled or not) live in the config draft and take effect on save, so this only keeps each list's
//! status by link.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::auth::unix_timestamp;
use crate::blocklist::{self, ListSummary, Merged, SourceRef};
use crate::db::Database;
use crate::geo_data::{
    GeoDataCleanupResult, GeoDataError, GeoDataManager, ScheduleStore, StoredFile,
    is_blocklist_path, parse_url,
};

const STATE_KEY: &str = "blocklist_state";
const SCHEDULE_KEY: &str = "blocklist_schedule";
/// 一个列表的大小上限：最大的主流列表约 6 MiB / The size limit for one list: the largest common lists are about 6 MiB
const MAX_LIST_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SUBSCRIPTIONS: usize = 32;
/// 失败原因只留这么长，页面上一行写得下 / Failure reasons are kept this short, so they fit a line on the page
const MAX_ERROR_CHARS: usize = 300;

#[derive(Clone)]
pub struct BlocklistManager {
    geo: GeoDataManager,
    database: Database,
    /// 下载、合并、清理一个接一个：清理不会删掉刚下载、还没记下的文件 / Downloads, merges and cleanup take turns, so
    /// cleanup never removes a file just downloaded and not yet recorded
    lock: Arc<Mutex<()>>,
    schedule: ScheduleStore,
}

/// 记在数据库里的：每个列表最近一份读得怎么样，和最近一次合成的文件
/// What the database keeps: how the latest copy of each list read, and the file built last
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BlocklistState {
    #[serde(default)]
    sources: BTreeMap<String, SourceStatus>,
    /// 页面最近一次合成的文件：填进草稿、还没保存时，清理也留着它 / The file the page built last: kept by cleanup
    /// while it sits in an unsaved draft
    #[serde(default)]
    last_built: Option<String>,
    /// 定时更新最近一次合成的文件：写进配置以前，清理也留着它 / The file the scheduled update built last: kept by
    /// cleanup until it is written into the config
    #[serde(default)]
    last_refreshed: Option<String>,
    /// 页面最近一次合成时订阅的列表：草稿里删掉又放弃修改时，它们的情况还在 / The lists the page subscribed to when
    /// it last built: removed in a draft and then discarded, their status is still there
    #[serde(default)]
    requested: Vec<String>,
}

/// 一个列表（按链接）最近一份读得怎么样 / How the latest copy of one list (by link) read
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceStatus {
    /// 在用的那一份的内容摘要；还没成功下载过时为 None / The digest of the copy in use; None until a download succeeds
    pub sha256: Option<String>,
    pub downloaded_at: Option<i64>,
    #[serde(default)]
    pub summary: ListSummary,
    /// 最近一次下载失败的原因；成功以后清掉 / Why the latest download failed; cleared once one succeeds
    pub last_error: Option<String>,
    pub last_attempt_at: Option<i64>,
    /// 因为规则少了一半以上没换上的那一份：下次下载还是它，就当列表真变小了，换上 / The copy not taken because it
    /// held under half the rules: when the next download is the same copy, the list really shrank and it is taken
    #[serde(default)]
    pub rejected_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Subscription {
    pub url: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct BuildRequest {
    pub subscriptions: Vec<Subscription>,
    /// 这些链接重新下载；其余已有一份的直接用 / These links download again; the others use the copy already held
    #[serde(default)]
    pub refresh: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildResult {
    /// 合并出的文件；启用的列表一个都还没有、或者合起来没有要拦截的（只有放行）时为 None。列表里的放行只抵消列表里的
    /// 拦截，所以只有放行时文件没有用处
    /// The merged file; None while no enabled list has a copy, or when together they block nothing (allows only).
    /// A list's allows only offset lists' blocks, so with allows alone the file would do nothing
    pub path: Option<String>,
    /// 请求里每个列表的情况 / How each list in the request stands
    pub sources: BTreeMap<String, SourceStatus>,
    /// 这次没下载成功的列表数 / How many lists failed to download this time
    pub failed: usize,
}

/// 定时更新的结果 / What a scheduled update did
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refresh {
    /// 换掉的文件：`(旧文件, 新文件)`；内容没变时为 None / The file replaced, as `(old, new)`; None when nothing changed
    pub replaced: Option<(String, String)>,
    /// 没更新上、接着用上一份的列表数 / How many lists failed to update and keep their previous copy
    pub failed: usize,
}

/// 下载一个列表的结果：读得懂的换上，规则少了一半以上的先不换，读不懂的说出原因 / What downloading one list gave: a
/// copy that reads, one held back for holding under half the rules, or why it failed
enum Fetched {
    Read(StoredFile, ListSummary),
    Shrank { sha256: String, reason: String },
    Failed(String),
}

impl BlocklistManager {
    #[must_use]
    pub fn new(geo: GeoDataManager, database: Database) -> Self {
        Self {
            schedule: ScheduleStore::new(database.clone(), SCHEDULE_KEY, "拦截列表"),
            geo,
            database,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// 自动更新的设置 / The automatic-update setting
    pub fn schedule(&self) -> &ScheduleStore {
        &self.schedule
    }

    /// 每个列表的情况，按链接 / Each list's status, by link
    pub async fn sources(&self) -> Result<BTreeMap<String, SourceStatus>, GeoDataError> {
        Ok(self.state().await?.sources)
    }

    async fn state(&self) -> Result<BlocklistState, GeoDataError> {
        let Some(value) = self.database.get_setting(STATE_KEY).await? else {
            return Ok(BlocklistState::default());
        };
        serde_json::from_str(&value).map_err(|error| {
            GeoDataError::Internal(anyhow::Error::new(error).context("拦截列表的记录已损坏"))
        })
    }

    async fn store(&self, state: &BlocklistState) -> Result<(), GeoDataError> {
        let serialized = serde_json::to_string(state)
            .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error)))?;
        self.database
            .set_setting(STATE_KEY, serialized, unix_timestamp())
            .await?;
        Ok(())
    }

    /// 按页面给的订阅合成一个文件：从没试过下载的、和 `refresh` 点名的先下载，再把启用的合并。一个列表下载失败不挡别的：它照用
    /// 上一份（没有就不算进去），原因记在它自己的情况里。不在请求里的列表的情况等清理时再看要不要留。
    /// Builds a file for the page's subscriptions: lists never tried, and those `refresh` names, download first,
    /// then the enabled ones merge. One failed download does not hold up the rest: that list keeps its previous copy
    /// (or is left out without one), and the reason goes into its own status. Whether to keep the status of lists
    /// outside the request is left to cleanup.
    pub async fn build(&self, request: BuildRequest) -> Result<BuildResult, GeoDataError> {
        let subscriptions = normalize_subscriptions(request.subscriptions)?;
        let refresh: HashSet<&str> = request.refresh.iter().map(|url| url.trim()).collect();
        let _guard = self.lock.lock().await;
        let mut state = self.state().await?;
        let (path, failed) = self
            .update(&mut state, &subscriptions, |url| refresh.contains(url))
            .await?;
        state.last_built.clone_from(&path);
        state.requested = subscriptions
            .iter()
            .map(|subscription| subscription.url.clone())
            .collect();
        self.store(&state).await?;
        let sources = subscriptions
            .iter()
            .filter_map(|subscription| {
                let status = state.sources.get(&subscription.url)?;
                Some((subscription.url.clone(), status.clone()))
            })
            .collect();
        Ok(BuildResult {
            path,
            sources,
            failed,
        })
    }

    /// 定时更新：重新下载 `config` 正在用的列表，合出新文件。配置没用拦截列表时为 None。
    /// The scheduled update: downloads the lists `config` uses again and builds a new file. None when the config uses
    /// no blocklists.
    pub async fn refresh_running(&self, config: &Value) -> Result<Option<Refresh>, GeoDataError> {
        let Some(old) = blocklist_path(config) else {
            return Ok(None);
        };
        let sources = read_file_sources(Path::new(&old)).await?.ok_or_else(|| {
            GeoDataError::Invalid(
                "正在用的拦截列表文件读不出它的来源，在拦截列表页重新保存一次".to_owned(),
            )
        })?;
        let _guard = self.lock.lock().await;
        let mut state = self.state().await?;
        self.recall_sources(&mut state, &sources).await?;
        let subscriptions: Vec<Subscription> = sources
            .into_iter()
            .map(|source| Subscription {
                url: source.url,
                enabled: true,
            })
            .collect();
        let (path, failed) = self.update(&mut state, &subscriptions, |_| true).await?;
        state.last_refreshed.clone_from(&path);
        self.store(&state).await?;
        let replaced = path.filter(|new| *new != old).map(|new| (old, new));
        Ok(Some(Refresh { replaced, failed }))
    }

    /// 正在用的文件里有、记录里却没有一份的列表（比如面板的数据库换过），按文件里记的那份补回记录：定时更新下载失败时
    /// 它照用这一份，不会从配置里掉出去
    /// Lists the file in use names but the records hold no copy of (the panel's database was replaced, say) get their
    /// records back from the copy the file names, so a failed scheduled download keeps that copy instead of dropping
    /// the list from the config
    async fn recall_sources(
        &self,
        state: &mut BlocklistState,
        sources: &[SourceRef],
    ) -> Result<(), GeoDataError> {
        for source in sources {
            if state
                .sources
                .get(&source.url)
                .is_some_and(|status| status.sha256.is_some())
            {
                continue;
            }
            let path = self.raw_path(&source.sha256);
            let sha256 = source.sha256.clone();
            let recalled =
                tokio::task::spawn_blocking(move || -> std::io::Result<Option<SourceStatus>> {
                    let bytes = match std::fs::read(&path) {
                        Ok(bytes) => bytes,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            return Ok(None);
                        }
                        Err(error) => return Err(error),
                    };
                    let downloaded_at = std::fs::metadata(&path)?
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .and_then(|age| i64::try_from(age.as_secs()).ok());
                    Ok(Some(SourceStatus {
                        sha256: Some(sha256),
                        downloaded_at,
                        summary: blocklist::summarize(&String::from_utf8_lossy(&bytes)),
                        ..SourceStatus::default()
                    }))
                })
                .await
                .map_err(|error| {
                    GeoDataError::Internal(
                        anyhow::Error::new(error).context("读取拦截列表的任务异常结束"),
                    )
                })?
                .map_err(|error| {
                    GeoDataError::Internal(anyhow::Error::new(error).context("读取在用的拦截列表"))
                })?;
            if let Some(status) = recalled {
                state.sources.insert(source.url.clone(), status);
            }
        }
        Ok(())
    }

    /// 清理 Geo 目录：Geo 数据和拦截列表都不再用的文件删掉。页面最近一次请求里没有、保留的配置版本也没用到的列表，情况不再记
    /// Cleans the Geo directory, removing files neither Geo data nor the blocklists still use. Lists neither in the
    /// page's latest request nor used by a retained config version are no longer recorded
    pub async fn cleanup(
        &self,
        retained_configs: &[Value],
    ) -> Result<GeoDataCleanupResult, GeoDataError> {
        let _guard = self.lock.lock().await;
        let mut state = self.state().await?;
        let mut retained_sources = Vec::new();
        for path in retained_configs
            .iter()
            .filter_map(blocklist_path)
            .collect::<HashSet<_>>()
        {
            retained_sources.extend(
                read_file_sources(Path::new(&path))
                    .await?
                    .unwrap_or_default(),
            );
        }
        let before = state.sources.len();
        state.sources.retain(|url, _| {
            state.requested.contains(url)
                || retained_sources.iter().any(|source| source.url == *url)
        });
        if state.sources.len() != before {
            self.store(&state).await?;
        }
        let keep = self.protected_paths(&state, &retained_sources);
        self.geo.cleanup(retained_configs, keep).await
    }

    /// 下载 `subscriptions` 里还要下载的（见 [`Self::needs_download`]）和 `refresh` 说要重下的，再合并启用的。返回合成的文件和没下载成功的列表数。
    /// Downloads the lists in `subscriptions` that still need it (see [`Self::needs_download`]) or that `refresh` names,
    /// then merges the enabled ones. Returns the file built and how many lists failed to download.
    async fn update(
        &self,
        state: &mut BlocklistState,
        subscriptions: &[Subscription],
        refresh: impl Fn(&str) -> bool,
    ) -> Result<(Option<String>, usize), GeoDataError> {
        let mut fetch = Vec::new();
        for subscription in subscriptions {
            let status = state.sources.get(&subscription.url);
            if refresh(&subscription.url) || self.needs_download(status).await {
                fetch.push((&subscription.url, status.cloned()));
            }
        }
        // 几个列表一起下载 / The lists download together
        let fetched = join_all(
            fetch
                .iter()
                .map(|(url, previous)| self.fetch(url, previous.as_ref())),
        )
        .await;
        let now = unix_timestamp();
        let mut failed = 0;
        for ((url, _), fetched) in fetch.into_iter().zip(fetched) {
            let status = state.sources.entry(url.clone()).or_default();
            status.last_attempt_at = Some(now);
            match fetched? {
                Fetched::Read(file, summary) => {
                    status.sha256 = Some(file.sha256);
                    status.downloaded_at = Some(now);
                    status.summary = summary;
                    status.last_error = None;
                    status.rejected_sha256 = None;
                }
                Fetched::Shrank { sha256, reason } => {
                    tracing::warn!(url = %url, reason = %reason, "拦截列表这次下载的规则少了一半以上");
                    status.last_error = Some(reason);
                    status.rejected_sha256 = Some(sha256);
                    failed += 1;
                }
                Fetched::Failed(reason) => {
                    tracing::warn!(url = %url, reason = %reason, "拦截列表没下载成功");
                    status.last_error = Some(reason.chars().take(MAX_ERROR_CHARS).collect());
                    failed += 1;
                }
            }
        }
        let path = self.merge(subscriptions, state).await?;
        Ok((path, failed))
    }

    /// 没点名重下时还要下载的：从没试过的，和记着一份、文件却不在了的。试过没下载成功的等点名再下：不然开关别的列表时
    /// 也要陪着它等到下载超时
    /// What downloads without being named: lists never tried, and those recorded with a copy whose file is gone. A list
    /// whose download failed waits to be named: otherwise switching any other list would wait out its download timeout
    async fn needs_download(&self, status: Option<&SourceStatus>) -> bool {
        let Some(status) = status else {
            return true;
        };
        let Some(sha256) = status.sha256.as_deref() else {
            return false;
        };
        !tokio::fs::metadata(self.raw_path(sha256))
            .await
            .is_ok_and(|metadata| metadata.is_file())
    }

    fn raw_path(&self, sha256: &str) -> PathBuf {
        self.geo.root().join(format!("blocklist-src-{sha256}.txt"))
    }

    /// 下载一个列表：读得懂（见 [`read_list`]）、也没比上一份少一半以上（见 [`shrink_reason`]）才换上
    /// Downloads one list, taken when it reads (see [`read_list`]) and keeps at least half of the previous copy (see
    /// [`shrink_reason`])
    async fn fetch(
        &self,
        url: &str,
        previous: Option<&SourceStatus>,
    ) -> Result<Fetched, GeoDataError> {
        let file = match self
            .geo
            .download_file(url, "拦截列表", MAX_LIST_BYTES, |sha256, _| {
                format!("blocklist-src-{sha256}.txt")
            })
            .await
        {
            Ok(file) => file,
            Err(GeoDataError::Internal(error)) => return Err(GeoDataError::Internal(error)),
            Err(error) => return Ok(Fetched::Failed(error.to_string())),
        };
        let path = file.path.clone();
        let read =
            tokio::task::spawn_blocking(move || std::fs::read(path).map(|bytes| read_list(&bytes)))
                .await
                .map_err(|error| {
                    GeoDataError::Internal(
                        anyhow::Error::new(error).context("读取拦截列表的任务异常结束"),
                    )
                })?
                .map_err(|error| {
                    GeoDataError::Internal(anyhow::Error::new(error).context("读取下载的拦截列表"))
                })?;
        let summary = match read {
            Ok(summary) => summary,
            Err(reason) => return Ok(Fetched::Failed(reason)),
        };
        Ok(match shrink_reason(summary.rules, &file.sha256, previous) {
            Some(reason) => Fetched::Shrank {
                sha256: file.sha256,
                reason,
            },
            None => Fetched::Read(file, summary),
        })
    }

    /// 把启用、且已经有一份的列表合并成文件；一个都没有、或者合并后没有要拦截的时为 None
    /// Merges the enabled lists that have a copy into a file; None when there are none, or nothing is left to block
    async fn merge(
        &self,
        subscriptions: &[Subscription],
        state: &BlocklistState,
    ) -> Result<Option<String>, GeoDataError> {
        let sources: Vec<SourceRef> = subscriptions
            .iter()
            .filter(|subscription| subscription.enabled)
            .filter_map(|subscription| {
                let sha256 = state.sources.get(&subscription.url)?.sha256.clone()?;
                Some(SourceRef {
                    url: subscription.url.clone(),
                    sha256,
                })
            })
            .collect();
        if sources.is_empty() {
            return Ok(None);
        }
        let paths: Vec<PathBuf> = sources
            .iter()
            .map(|source| self.raw_path(&source.sha256))
            .collect();
        let json = tokio::task::spawn_blocking(move || -> std::io::Result<Option<String>> {
            let read = |path: &PathBuf| {
                std::fs::read(path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            };
            // `$badfilter` 对所有列表都管用，所以先读一遍收齐；一次只读一个列表，不同时占着所有列表的内存
            // `$badfilter` applies across every list, so a first pass gathers them; one list is read at a time,
            // never holding them all in memory at once
            let mut disabled = HashSet::new();
            for path in &paths {
                disabled.extend(blocklist::badfilters(&read(path)?));
            }
            let mut merged = Merged::default();
            for path in &paths {
                merged.add(&read(path)?, &disabled);
            }
            Ok((!merged.is_empty()).then(|| merged.geosite_json(&sources)))
        })
        .await
        .map_err(|error| {
            GeoDataError::Internal(anyhow::Error::new(error).context("合并拦截列表的任务异常结束"))
        })?
        .map_err(|error| {
            GeoDataError::Internal(anyhow::Error::new(error).context("读取要合并的拦截列表"))
        })?;
        let Some(json) = json else {
            return Ok(None);
        };
        let file = self
            .geo
            .write_file(json.as_bytes(), |sha256| format!("blocklist-{sha256}.json"))
            .await?;
        Ok(Some(file.path.to_string_lossy().into_owned()))
    }

    /// 清理时要留下的文件：页面和定时更新最近合成的、每个列表在用的那份，和保留的配置版本用到的合并文件里记的来源
    /// Files cleanup must keep: the ones the page and the scheduled update built last, each list's copy in use, and the
    /// sources recorded in the merged files that retained config versions use
    fn protected_paths(
        &self,
        state: &BlocklistState,
        retained_sources: &[SourceRef],
    ) -> HashSet<PathBuf> {
        state
            .last_built
            .iter()
            .chain(&state.last_refreshed)
            .map(PathBuf::from)
            .chain(
                state
                    .sources
                    .values()
                    .filter_map(|status| status.sha256.as_deref())
                    .chain(retained_sources.iter().map(|source| source.sha256.as_str()))
                    .map(|sha256| self.raw_path(sha256)),
            )
            .collect()
    }
}

#[cfg(test)]
impl BlocklistManager {
    /// 放好一份像是已经下载过的列表：测试不联网 / Places a list as if it had been downloaded: tests stay offline
    pub(crate) async fn hold_for_tests(&self, url: &str, text: &str) -> String {
        let sha256 = crate::digest::sha256_hex(text.as_bytes());
        std::fs::write(self.raw_path(&sha256), text).unwrap();
        let mut state = self.state().await.unwrap();
        state.sources.insert(
            url.to_owned(),
            SourceStatus {
                sha256: Some(sha256.clone()),
                downloaded_at: Some(1),
                summary: blocklist::summarize(text),
                last_attempt_at: Some(1),
                ..SourceStatus::default()
            },
        );
        self.store(&state).await.unwrap();
        sha256
    }
}

/// 下载到的列表读不读得懂：要是文本，还要读得出规则；读不懂时说出原因
/// Whether a downloaded list reads: it must be text and hold rules; when not, why
fn read_list(bytes: &[u8]) -> Result<ListSummary, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "下载到的不是文本文件".to_owned())?;
    let summary = blocklist::summarize(text);
    if summary.rules == 0 {
        return Err("这个链接里没有读得懂的规则".to_owned());
    }
    Ok(summary)
}

/// 新下载的一份（`rules` 条、摘要 `sha256`）比在用的那份少了一半以上时，说先不换的原因。上次就因此没换上的同一份这次
/// 换上：两次下载都一样，是列表真的变小了，不是下载出了错。
/// Why a new copy (`rules` rules, digest `sha256`) holding under half of the copy in use is not taken yet. The same
/// copy held back last time is taken now: two downloads agreeing means the list really shrank rather than a download
/// going wrong.
fn shrink_reason(rules: usize, sha256: &str, previous: Option<&SourceStatus>) -> Option<String> {
    let previous = previous.filter(|status| status.sha256.is_some())?;
    let before = previous.summary.rules;
    if rules.saturating_mul(2) >= before || previous.rejected_sha256.as_deref() == Some(sha256) {
        return None;
    }
    Some(format!(
        "这次下载的规则比上一份少了一半以上（{before} 条变成 {rules} 条），先接着用上一份；下次下载还是这样就换上"
    ))
}

/// 链接去掉首尾空白、检查写法，重复的只留第一个 / Links trimmed and checked, repeats keeping only the first
fn normalize_subscriptions(
    subscriptions: Vec<Subscription>,
) -> Result<Vec<Subscription>, GeoDataError> {
    if subscriptions.len() > MAX_SUBSCRIPTIONS {
        return Err(GeoDataError::Invalid(format!(
            "拦截列表最多订阅 {MAX_SUBSCRIPTIONS} 个"
        )));
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::with_capacity(subscriptions.len());
    for subscription in subscriptions {
        let url = subscription.url.trim().to_owned();
        parse_url(&url, "拦截列表")?;
        if seen.insert(url.clone()) {
            normalized.push(Subscription {
                url,
                enabled: subscription.enabled,
            });
        }
    }
    Ok(normalized)
}

/// 配置里拦截列表合并出的那个文件 / The blocklists' merged file a config uses
#[must_use]
pub fn blocklist_path(config: &Value) -> Option<String> {
    config
        .pointer("/settings/geosite_data_paths")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find(|path| is_blocklist_path(path))
        .map(str::to_owned)
}

/// 把配置里拦截列表的文件从 `old` 换成 `new`；换了返回 true / Replaces the blocklists' file in a config from `old` to
/// `new`; true when it changed
pub fn replace_blocklist_path(config: &mut Value, old: &str, new: &str) -> bool {
    let Some(paths) = config
        .pointer_mut("/settings/geosite_data_paths")
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let mut changed = false;
    for path in paths.iter_mut().filter(|path| path.as_str() == Some(old)) {
        *path = Value::String(new.to_owned());
        changed = true;
    }
    changed
}

/// 读合并文件里记的来源；文件不在时为 None。文件有十几 MB，在阻塞线程里读
/// Reads the sources a merged file records; None when the file is gone. The file runs to a dozen MB or more, so it
/// is read on a blocking thread
async fn read_file_sources(path: &Path) -> Result<Option<Vec<SourceRef>>, GeoDataError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || match std::fs::read(&path) {
        Ok(bytes) => Ok(blocklist::read_sources(&bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    })
    .await
    .map_err(|error| {
        GeoDataError::Internal(anyhow::Error::new(error).context("读取拦截列表文件的任务异常结束"))
    })?
    .map_err(|error| GeoDataError::Internal(anyhow::Error::new(error).context("读取拦截列表文件")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    // 测试不联网：这些链接指向本机，下载在连接以前就被拒，正好当作下载失败
    // Tests stay offline: these links point at this machine, so a download is refused before connecting, which
    // stands in for a failed download
    const A: &str = "https://127.0.0.1/a.txt";
    const B: &str = "https://127.0.0.1/b.txt";
    const C: &str = "https://127.0.0.1/c.txt";

    async fn manager(directory: &Path) -> BlocklistManager {
        let database = Database::open(directory.join("panel.db")).await.unwrap();
        let geo = GeoDataManager::new(database.clone(), &directory.join("geo")).unwrap();
        BlocklistManager::new(geo, database)
    }

    fn subscription(url: &str, enabled: bool) -> Subscription {
        Subscription {
            url: url.to_owned(),
            enabled,
        }
    }

    async fn build(
        manager: &BlocklistManager,
        subscriptions: Vec<Subscription>,
        refresh: &[&str],
    ) -> BuildResult {
        let refresh = refresh.iter().map(|url| (*url).to_owned()).collect();
        manager
            .build(BuildRequest {
                subscriptions,
                refresh,
            })
            .await
            .unwrap()
    }

    /// 只合并启用的列表，`$badfilter` 也只从启用的列表里来；不在请求里的列表不再记
    /// Only enabled lists merge, and `$badfilter` comes only from enabled lists; lists outside the request are dropped
    #[tokio::test]
    async fn a_build_merges_the_enabled_lists_it_holds() {
        let directory = tempdir().unwrap();
        let manager = manager(directory.path()).await;
        let sha_a = manager
            .hold_for_tests(A, "||ads.example^\n||gone.example^\n")
            .await;
        let sha_b = manager
            .hold_for_tests(B, "||other.example^\n||gone.example^$badfilter\n")
            .await;

        let only_a = build(
            &manager,
            vec![subscription(A, true), subscription(B, false)],
            &[],
        )
        .await;
        assert_eq!((only_a.failed, only_a.sources.len()), (0, 2));
        let json = std::fs::read(only_a.path.as_ref().unwrap()).unwrap();
        assert_eq!(
            blocklist::read_sources(&json),
            Some(vec![SourceRef {
                url: A.to_owned(),
                sha256: sha_a.clone()
            }])
        );
        let text = String::from_utf8(json).unwrap();
        assert!(text.contains("domain:ads.example") && text.contains("domain:gone.example"));
        assert!(!text.contains("other.example"));

        let both = build(
            &manager,
            vec![subscription(A, true), subscription(B, true)],
            &[],
        )
        .await;
        let text = std::fs::read_to_string(both.path.as_ref().unwrap()).unwrap();
        assert!(
            text.contains("domain:other.example") && !text.contains("gone.example"),
            "{text}"
        );
        assert_eq!(
            blocklist::read_sources(text.as_bytes()).unwrap(),
            vec![
                SourceRef {
                    url: A.to_owned(),
                    sha256: sha_a
                },
                SourceRef {
                    url: B.to_owned(),
                    sha256: sha_b
                }
            ]
        );

        let without_b = build(&manager, vec![subscription(A, false)], &[]).await;
        assert_eq!(without_b.path, None, "nothing enabled, nothing merged");
        assert_eq!(without_b.sources.keys().collect::<Vec<_>>(), [A]);
        // B 的情况留到清理：草稿里删掉又放弃时还看得到 / B's status stays until cleanup, seen again when a draft
        // removing it is discarded
        assert!(manager.state().await.unwrap().sources.contains_key(B));
        assert_eq!(manager.state().await.unwrap().last_built, None);
    }

    /// 下载失败的列表照用上一份，原因记在它自己的情况里；从没下载成功过的不算进去
    /// A list whose download fails keeps its previous copy with the reason in its own status; one never downloaded is
    /// left out
    #[tokio::test]
    async fn a_failed_download_keeps_the_previous_copy() {
        let directory = tempdir().unwrap();
        let manager = manager(directory.path()).await;
        let sha_a = manager.hold_for_tests(A, "||ads.example^\n").await;

        let result = build(
            &manager,
            vec![subscription(A, true), subscription(C, true)],
            &[A],
        )
        .await;
        assert_eq!(result.failed, 2);
        let kept = &result.sources[A];
        assert_eq!(
            (kept.sha256.as_deref(), kept.summary.rules),
            (Some(sha_a.as_str()), 1)
        );
        assert!(
            kept.last_error
                .as_deref()
                .unwrap()
                .starts_with("拦截列表主机"),
            "{kept:?}"
        );
        let never = &result.sources[C];
        assert_eq!((never.sha256.as_deref(), never.downloaded_at), (None, None));
        assert!(never.last_error.is_some());
        // 没点名就不再试：开关别的列表不用陪着它等 / Not tried again unless named: switching other lists does not wait on it
        let again = build(
            &manager,
            vec![subscription(A, false), subscription(C, true)],
            &[],
        )
        .await;
        assert_eq!(
            again.failed, 0,
            "a retried download would have failed again"
        );
        let json = std::fs::read(result.path.unwrap()).unwrap();
        assert_eq!(
            blocklist::read_sources(&json),
            Some(vec![SourceRef {
                url: A.to_owned(),
                sha256: sha_a
            }])
        );
    }

    /// 定时更新跟着配置正在用的文件走：重新下载它记的列表，失败的照用上一份，内容没变就不换文件
    /// The scheduled update follows the file the config uses: its lists download again, failures keep their previous
    /// copy, and unchanged content keeps the file
    #[tokio::test]
    async fn the_scheduled_update_follows_the_file_in_use() {
        let directory = tempdir().unwrap();
        let manager = manager(directory.path()).await;
        manager.hold_for_tests(A, "||ads.example^\n").await;
        manager.hold_for_tests(B, "||other.example^\n").await;
        let in_use = build(
            &manager,
            vec![subscription(A, true), subscription(B, false)],
            &[],
        )
        .await
        .path
        .unwrap();
        let config = json!({ "settings": { "geosite_data_paths": [in_use] } });

        let refresh = manager.refresh_running(&config).await.unwrap();
        assert_eq!(
            refresh,
            Some(Refresh {
                replaced: None,
                failed: 1
            }),
            "only the enabled list is fetched"
        );
        let state = manager.state().await.unwrap();
        assert_eq!(state.last_refreshed.as_deref(), Some(in_use.as_str()));
        assert!(state.sources[A].last_error.is_some() && state.sources[B].last_error.is_none());

        assert_eq!(
            manager
                .refresh_running(&json!({ "settings": {} }))
                .await
                .unwrap(),
            None
        );
        let gone = manager
            .geo
            .root()
            .join(format!("blocklist-{}.json", "e".repeat(64)));
        let missing = json!({ "settings": { "geosite_data_paths": [gone] } });
        assert!(matches!(
            manager.refresh_running(&missing).await,
            Err(GeoDataError::Invalid(_))
        ));
    }

    /// 清理留下拦截列表还要用的：最近合成的、每个列表在用的那份、保留版本用到的合并文件和它记的来源
    /// Cleanup keeps what the blocklists still use: the file built last, each list's copy in use, and the merged files
    /// of retained versions with the sources they record
    #[tokio::test]
    async fn cleanup_keeps_what_the_blocklists_use() {
        let directory = tempdir().unwrap();
        let manager = manager(directory.path()).await;
        let sha_a = manager.hold_for_tests(A, "||ads.example^\n").await;
        let sha_b = manager.hold_for_tests(B, "||other.example^\n").await;
        let sha_c = manager.hold_for_tests(C, "||older.example^\n").await;
        let mut older = Merged::default();
        older.add("||older.example^\n", &HashSet::new());
        let older_json = older.geosite_json(&[SourceRef {
            url: C.to_owned(),
            sha256: sha_c.clone(),
        }]);
        let retained_file = manager
            .geo
            .write_file(older_json.as_bytes(), |sha256| {
                format!("blocklist-{sha256}.json")
            })
            .await
            .unwrap()
            .path;
        let stray = manager
            .geo
            .root()
            .join(format!("blocklist-{}.json", "f".repeat(64)));
        std::fs::write(&stray, "{}").unwrap();
        // 页面只剩 A；C 还在保留的版本里 / The page holds A alone; C is still in a retained version
        let built = build(&manager, vec![subscription(A, true)], &[])
            .await
            .path
            .unwrap();
        let retained = json!({ "settings": { "geosite_data_paths": [retained_file] } });

        let result = manager.cleanup(&[retained]).await.unwrap();
        assert_eq!(result.removed_files, 2, "{result:?}");
        assert!(!stray.exists() && !manager.raw_path(&sha_b).exists());
        let recorded: Vec<String> = manager.state().await.unwrap().sources.into_keys().collect();
        assert_eq!(
            recorded,
            [A, C],
            "B is in neither the latest request nor a retained version"
        );
        for kept in [
            PathBuf::from(built),
            retained_file,
            manager.raw_path(&sha_a),
            manager.raw_path(&sha_c),
        ] {
            assert!(kept.exists(), "{}", kept.display());
        }
    }

    /// 正在用的文件里的列表重新下载失败、但手里有更新的一份时，定时更新换上它；换下的旧文件不再留，新文件写进配置以前
    /// 清理也留着它
    /// When the lists of the file in use fail to download again but a newer copy is held, the scheduled update takes
    /// it; the old file is no longer kept, and cleanup keeps the new one until it is written into the config
    #[tokio::test]
    async fn the_scheduled_update_swaps_in_a_newer_copy() {
        let directory = tempdir().unwrap();
        let manager = manager(directory.path()).await;
        manager.hold_for_tests(A, "||ads.example^\n").await;
        let in_use = build(&manager, vec![subscription(A, true)], &[])
            .await
            .path
            .unwrap();
        manager
            .hold_for_tests(A, "||ads.example^\n||more.example^\n")
            .await;
        let config = json!({ "settings": { "geosite_data_paths": [in_use] } });

        let refresh = manager.refresh_running(&config).await.unwrap().unwrap();
        assert_eq!(refresh.failed, 1);
        let (old, new) = refresh.replaced.unwrap();
        assert_eq!(old, in_use);
        assert!(
            std::fs::read_to_string(&new)
                .unwrap()
                .contains("domain:more.example")
        );

        // 页面那边什么都不开了：只剩定时更新合成的新文件还要留 / The page turns everything off: only the scheduled
        // update's new file is still needed
        assert_eq!(
            build(&manager, vec![subscription(A, false)], &[])
                .await
                .path,
            None
        );
        manager.cleanup(&[]).await.unwrap();
        assert!(Path::new(&new).exists() && !Path::new(&old).exists());
    }

    /// 正在用的配置里有、记录却丢了的列表：定时更新下载失败时照用文件里记的那份，不从配置里掉出去
    /// A list the config in use holds but whose record was lost: when its scheduled download fails, the copy the file
    /// names stays and the list does not drop out of the config
    #[tokio::test]
    async fn a_lost_record_comes_back_from_the_file_in_use() {
        let directory = tempdir().unwrap();
        let manager = manager(directory.path()).await;
        manager.hold_for_tests(A, "||ads.example^\n").await;
        let sha_c = manager.hold_for_tests(C, "||other.example^\n").await;
        let in_use = build(
            &manager,
            vec![subscription(A, true), subscription(C, true)],
            &[],
        )
        .await
        .path
        .unwrap();
        // 记录丢了，比如面板的数据库换过 / The record is lost, the panel's database replaced, say
        let mut state = manager.state().await.unwrap();
        state.sources.remove(C);
        manager.store(&state).await.unwrap();
        let config = json!({ "settings": { "geosite_data_paths": [in_use] } });

        let refresh = manager.refresh_running(&config).await.unwrap().unwrap();
        assert_eq!(
            refresh,
            Refresh {
                replaced: None,
                failed: 2
            }
        );
        let recalled = &manager.state().await.unwrap().sources[C];
        assert_eq!(
            (recalled.sha256.as_deref(), recalled.summary.rules),
            (Some(sha_c.as_str()), 1)
        );
        assert!(recalled.downloaded_at.is_some() && recalled.last_error.is_some());
    }

    /// 下载到的列表要是文本、读得出规则 / A downloaded list must be text and hold rules
    #[test]
    fn a_download_must_read() {
        assert_eq!(read_list(b"||a.example^\n").unwrap().rules, 1);
        assert_eq!(
            read_list(&[0xff, 0xfe]),
            Err("下载到的不是文本文件".to_owned())
        );
        assert_eq!(
            read_list(b"! only a comment\n"),
            Err("这个链接里没有读得懂的规则".to_owned())
        );
    }

    /// 比在用的那份少了一半以上先不换；上次因此没换上的同一份这次换上
    /// Under half of the copy in use is held back; the same copy held back last time is taken now
    #[test]
    fn a_list_that_shrinks_by_half_waits_for_a_second_download() {
        let held = SourceStatus {
            sha256: Some("a".repeat(64)),
            summary: ListSummary {
                rules: 4,
                ..ListSummary::default()
            },
            ..SourceStatus::default()
        };
        let smaller = "b".repeat(64);
        assert_eq!(
            shrink_reason(1, &smaller, None),
            None,
            "nothing held, nothing to compare"
        );
        assert_eq!(
            shrink_reason(2, &smaller, Some(&held)),
            None,
            "exactly half is kept"
        );
        assert_eq!(
            shrink_reason(1, &smaller, Some(&held)).as_deref(),
            Some(
                "这次下载的规则比上一份少了一半以上（4 条变成 1 条），先接着用上一份；下次下载还是这样就换上"
            )
        );
        let held_back = SourceStatus {
            rejected_sha256: Some(smaller.clone()),
            ..held.clone()
        };
        assert_eq!(
            shrink_reason(1, &smaller, Some(&held_back)),
            None,
            "the same copy again is taken"
        );
        assert!(
            shrink_reason(1, &"c".repeat(64), Some(&held_back)).is_some(),
            "another small copy waits again"
        );
    }

    /// 配置里找得到、换得掉拦截列表的文件，Geo 的文件不动 / The blocklists' file in a config is found and replaced,
    /// leaving Geo files alone
    #[test]
    fn the_blocklist_file_in_a_config_is_found_and_replaced() {
        let old = format!(
            "/var/lib/kixdns-panel/geo/blocklist-{}.json",
            "a".repeat(64)
        );
        let new = format!(
            "/var/lib/kixdns-panel/geo/blocklist-{}.json",
            "b".repeat(64)
        );
        let geosite = format!("/var/lib/kixdns-panel/geo/geosite-{}.dat", "c".repeat(64));
        let mut config = json!({ "settings": { "geosite_data_paths": [geosite, old] } });
        assert_eq!(blocklist_path(&config), Some(old.clone()));
        assert!(replace_blocklist_path(&mut config, &old, &new));
        assert_eq!(
            config["settings"]["geosite_data_paths"],
            json!([geosite, new])
        );
        assert!(!replace_blocklist_path(&mut config, &old, &new));
        assert_eq!(
            blocklist_path(&json!({ "settings": { "geosite_data_paths": [geosite] } })),
            None
        );
        // 原始列表不是合并文件 / A raw list is no merged file
        let raw = format!(
            "/var/lib/kixdns-panel/geo/blocklist-src-{}.txt",
            "d".repeat(64)
        );
        assert_eq!(
            blocklist_path(&json!({ "settings": { "geosite_data_paths": [raw] } })),
            None
        );
    }

    /// 订阅的链接去掉空白、重复的只留第一个，写错一个整个请求不收 / Links are trimmed, repeats keep the first, and one
    /// bad link refuses the whole request
    #[test]
    fn subscriptions_are_trimmed_and_deduplicated() {
        let subscription = |url: &str, enabled| Subscription {
            url: url.to_owned(),
            enabled,
        };
        let normalized = normalize_subscriptions(vec![
            subscription(" https://lists.example/a.txt ", true),
            subscription("https://lists.example/a.txt", false),
            subscription("https://lists.example/b.txt", false),
        ])
        .unwrap();
        assert_eq!(
            normalized,
            vec![
                subscription("https://lists.example/a.txt", true),
                subscription("https://lists.example/b.txt", false)
            ]
        );
        assert!(
            normalize_subscriptions(vec![subscription("http://lists.example/a.txt", true)])
                .is_err()
        );
        let too_many = (0..=MAX_SUBSCRIPTIONS)
            .map(|i| subscription(&format!("https://lists.example/{i}.txt"), true))
            .collect();
        assert!(normalize_subscriptions(too_many).is_err());
    }
}
