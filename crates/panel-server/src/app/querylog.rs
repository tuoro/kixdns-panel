//! 查询日志的接口和采集任务：每秒从内核取走新的查询写进 [`QueryLogStore`]，页面按条件往前翻。
//! The query log's endpoints and collector: every second the new queries are taken from the kernel into
//! [`QueryLogStore`], and the page reads back through them with filters.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::control::{ControlError, QueryLogPage as KernelPage};
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::querylog::{
    Cursor, DEFAULT_PAGE_SIZE, Filter, MAX_PAGE_SIZE, Page, PageQuery, QueryLogSettings,
    QueryLogStore, Record, RuleFilter, RuleIndex, StaticKind,
};

use super::AppState;

const QUERYLOG_CAPABILITY: &str = "querylog_v1";
const SETTINGS_KEY: &str = "querylog_settings_v1";
/// 一次向内核要多少条：每条最多 64 步，250 条也在控制接口 8 MiB 的应答上限以内
/// How many records to ask the kernel for at once: an entry has at most 64 steps, so 250 stay within the control
/// socket's 8 MiB reply cap
const KERNEL_PAGE: usize = 250;
/// 一秒最多接着取这么多页，比内核的 4096 条交接区多 / At most this many pages a second, more than the kernel's 4096-record ring
const PAGES_PER_TICK: usize = 20;
const CAPABILITY_RECHECK: Duration = Duration::from_secs(30);
const RULES_RECHECK: Duration = Duration::from_secs(5);
/// 结果的面板叫法 / The outcomes in the panel's words
const OUTCOMES: [&str; 8] = [
    "forwarded",
    "cached",
    "stale",
    "joined",
    "blocked",
    "answered",
    "failed",
    "cancelled",
];
const MAX_FILTER_TEXT: usize = 512;

/// 内核支不支持查询日志：还不知道、不支持、支持 / Whether the kernel has the query log: not known yet, no, yes
const SUPPORT_UNKNOWN: u8 = 0;
const SUPPORT_NO: u8 = 1;
const SUPPORT_YES: u8 = 2;

/// 查询日志在面板里的状态：文件、设置、内核支不支持 / The query log's state in the panel: files, settings, kernel support
#[derive(Clone)]
pub(crate) struct QueryLog {
    /// 目录打不开时为 `None`：面板照常启动，只是这次不记查询日志 / `None` when the directory cannot be opened: the panel
    /// starts as usual and simply records no query log this run
    pub(super) store: Option<QueryLogStore>,
    settings: Arc<RwLock<QueryLogSettings>>,
    support: Arc<AtomicU8>,
}

impl QueryLog {
    /// 打开数据库旁边的 `querylog/` 目录，读回保存的设置
    /// Opens `querylog/` next to the database and reads the saved settings back
    pub(crate) async fn open(database_path: &Path, database: &Database) -> anyhow::Result<Self> {
        let root = database_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join("querylog");
        let store = match tokio::task::spawn_blocking(move || QueryLogStore::open(root)).await {
            Ok(Ok(store)) => Some(store),
            Ok(Err(error)) => {
                tracing::error!(error = ?error, "查询日志的目录打不开，这次运行不记查询日志");
                None
            }
            Err(error) => {
                tracing::error!(%error, "打开查询日志的任务异常结束，这次运行不记查询日志");
                None
            }
        };
        let settings = match database.get_setting(SETTINGS_KEY).await? {
            Some(saved) => serde_json::from_str::<QueryLogSettings>(&saved)
                .map_err(|error| error.to_string())
                .and_then(QueryLogSettings::normalized)
                .unwrap_or_else(|error| {
                    tracing::warn!(%error, "查询日志设置已损坏，改用默认值");
                    QueryLogSettings::default()
                }),
            None => QueryLogSettings::default(),
        };
        Ok(Self {
            store,
            settings: Arc::new(RwLock::new(settings)),
            support: Arc::new(AtomicU8::new(SUPPORT_UNKNOWN)),
        })
    }

    fn store(&self) -> AppResult<QueryLogStore> {
        self.store.clone().ok_or_else(|| {
            AppError::ServiceUnavailable(
                "querylog_unavailable",
                "查询日志的目录打不开，原因在面板自己的日志里（journalctl -u kixdns-panel）；处理好以后重启面板".to_owned(),
            )
        })
    }

    fn settings(&self) -> QueryLogSettings {
        self.settings
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(super) fn set_settings(&self, settings: QueryLogSettings) {
        *self
            .settings
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
    }

    /// 只有确知内核不支持时才说不支持：内核停着的时候，已经记下的照样能看
    /// Unsupported only when the kernel is known to lack it: with the kernel stopped, what was recorded can still be read
    pub(super) fn supported(&self) -> bool {
        self.support.load(Ordering::Relaxed) != SUPPORT_NO
    }
}

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/querylog", get(query_log))
        .route("/querylog/settings", get(get_settings).put(save_settings))
        .route("/querylog/clear", post(clear))
}

#[derive(Debug, Deserialize)]
struct QueryLogQuery {
    q: Option<String>,
    /// 逗号分隔 / Comma-separated
    pipelines: Option<String>,
    /// 逗号分隔，面板的叫法 / Comma-separated, in the panel's words
    outcomes: Option<String>,
    client: Option<String>,
    rule: Option<String>,
    rule_pipeline: Option<String>,
    /// `request`（默认）或 `response` / `request` (default) or `response`
    rule_phase: Option<String>,
    upstream: Option<String>,
    before: Option<u64>,
    /// 只要比它新的（页面轮询用） / Only newer than this (the page's poll)
    after: Option<u64>,
    #[serde(default = "default_page_size")]
    limit: usize,
}

const fn default_page_size() -> usize {
    DEFAULT_PAGE_SIZE
}

#[derive(Debug, Serialize)]
struct QueryLogResponse {
    #[serde(flatten)]
    page: Page,
    supported: bool,
}

#[derive(Debug, Serialize)]
struct SettingsView {
    #[serde(flatten)]
    settings: QueryLogSettings,
    used_bytes: u64,
    /// 能看到的最早那一刻：最早一段开始的时候，或者保留时间的起点，取晚的 / The earliest moment that can be seen:
    /// when the oldest segment opened or where retention begins, whichever is later
    oldest_unix_ms: Option<u64>,
    supported: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsPatch {
    retention_hours: Option<u32>,
    max_bytes: Option<u64>,
    ignored_domains: Option<Vec<String>>,
}

async fn query_log(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<QueryLogQuery>,
) -> AppResult<Json<QueryLogResponse>> {
    authenticate(&state.database, &jar).await?;
    if !(1..=MAX_PAGE_SIZE).contains(&query.limit) {
        return Err(AppError::BadRequest(
            "querylog_limit_invalid",
            format!("每页条数要在 1 到 {MAX_PAGE_SIZE} 之间"),
        ));
    }
    let filter = parse_filter(&query)?;
    let settings = state.querylog.settings();
    let page_query = PageQuery {
        filter,
        before: query.before,
        after: query.after,
        limit: query.limit,
        cutoff_ms: now_ms().saturating_sub(u64::from(settings.retention_hours) * 3_600_000),
    };
    let store = state.querylog.store()?;
    let page = tokio::task::spawn_blocking(move || store.read_page(&page_query))
        .await
        .map_err(|error| AppError::Internal(error.into()))?;
    Ok(Json(QueryLogResponse {
        page,
        supported: state.querylog.supported(),
    }))
}

fn parse_filter(query: &QueryLogQuery) -> AppResult<Filter> {
    let text = |value: &Option<String>| -> AppResult<Option<String>> {
        let Some(value) = value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        if value.len() > MAX_FILTER_TEXT {
            return Err(AppError::BadRequest(
                "querylog_filter_invalid",
                "筛选条件太长了".to_owned(),
            ));
        }
        Ok(Some(value.to_owned()))
    };
    let list = |value: &Option<String>| -> AppResult<Option<HashSet<String>>> {
        Ok(text(value)?.map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        }))
    };
    let outcomes = list(&query.outcomes)?;
    if let Some(unknown) = outcomes
        .iter()
        .flatten()
        .find(|outcome| !OUTCOMES.contains(&outcome.as_str()))
    {
        return Err(AppError::BadRequest(
            "querylog_filter_invalid",
            format!("不认识的结果：{unknown}"),
        ));
    }
    let response = match query.rule_phase.as_deref().map(str::trim) {
        None | Some("" | "request") => false,
        Some("response") => true,
        Some(_) => {
            return Err(AppError::BadRequest(
                "querylog_filter_invalid",
                "规则阶段只能是 request 或 response".to_owned(),
            ));
        }
    };
    let rule_pipeline = text(&query.rule_pipeline)?;
    Ok(Filter {
        q: text(&query.q)?.map(|q| q.to_lowercase()),
        pipelines: list(&query.pipelines)?,
        outcomes,
        client: text(&query.client)?,
        rule: text(&query.rule)?.map(|name| RuleFilter {
            name,
            pipeline: rule_pipeline,
            response,
        }),
        upstream: text(&query.upstream)?,
    })
}

async fn get_settings(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<Json<SettingsView>> {
    authenticate(&state.database, &jar).await?;
    Ok(Json(settings_view(&state.querylog)))
}

async fn save_settings(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
    Json(patch): Json<SettingsPatch>,
) -> AppResult<Json<SettingsView>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let before = state.querylog.settings();
    let settings = QueryLogSettings {
        retention_hours: patch.retention_hours.unwrap_or(before.retention_hours),
        max_bytes: patch.max_bytes.unwrap_or(before.max_bytes),
        ignored_domains: patch
            .ignored_domains
            .unwrap_or_else(|| before.ignored_domains.clone()),
    }
    .normalized()
    .map_err(|message| AppError::BadRequest("querylog_settings_invalid", message))?;
    let serialized =
        serde_json::to_string(&settings).map_err(|error| AppError::Internal(error.into()))?;
    state
        .database
        .set_setting(SETTINGS_KEY, serialized, unix_timestamp())
        .await
        .map_err(AppError::Internal)?;
    state.querylog.set_settings(settings.clone());
    state
        .database
        .audit(
            Some(session.username),
            "querylog.settings".to_owned(),
            describe_settings(&settings),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(settings_view(&state.querylog)))
}

async fn clear(
    State(state): State<AppState>,
    jar: CookieJar,
    headers: HeaderMap,
) -> AppResult<Json<SettingsView>> {
    let session = authenticate(&state.database, &jar).await?;
    verify_csrf(&session, &jar, &headers)?;
    let store = state.querylog.store()?;
    tokio::task::spawn_blocking(move || store.clear())
        .await
        .map_err(|error| AppError::Internal(error.into()))?
        .map_err(|error| {
            AppError::Internal(anyhow::Error::new(error).context("清空查询日志失败"))
        })?;
    state
        .database
        .audit(
            Some(session.username),
            "querylog.clear".to_owned(),
            "清空查询日志".to_owned(),
            unix_timestamp(),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(settings_view(&state.querylog)))
}

fn settings_view(querylog: &QueryLog) -> SettingsView {
    let settings = querylog.settings();
    let usage = querylog.store.as_ref().map(QueryLogStore::usage);
    let cutoff = now_ms().saturating_sub(u64::from(settings.retention_hours) * 3_600_000);
    SettingsView {
        used_bytes: usage.map_or(0, |usage| usage.bytes),
        oldest_unix_ms: usage
            .and_then(|usage| usage.oldest_start_ms)
            .map(|start| start.max(cutoff)),
        settings,
        supported: querylog.supported(),
    }
}

/// 审计里的一句，用设置页上的说法：保存多久、最多占用、不记录几个域名 / One line for the audit log in the settings' words: how long, how much, how many not recorded
fn describe_settings(settings: &QueryLogSettings) -> String {
    let retention = if settings.retention_hours.is_multiple_of(24) {
        format!("保存 {} 天", settings.retention_hours / 24)
    } else {
        format!("保存 {} 小时", settings.retention_hours)
    };
    let mib = settings.max_bytes / (1024 * 1024);
    let cap = if mib.is_multiple_of(1024) {
        format!("最多 {} GB", mib / 1024)
    } else {
        format!("最多 {mib} MB")
    };
    let ignored = match settings.ignored_domains.len() {
        0 => "每个域名都记".to_owned(),
        count => format!("不记录 {count} 个域名"),
    };
    format!("{retention}，{cap}，{ignored}")
}

/// 每秒从内核取一次。内核停着、不支持都是常态，只在调试日志里说
/// Takes from the kernel once a second. A stopped or unsupporting kernel is normal and only mentioned at debug level
pub(super) fn spawn_querylog_collector(state: AppState) {
    tokio::spawn(async move {
        let mut collector = Collector::default();
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(error) = collector.tick(&state).await {
                tracing::debug!(%error, "查询日志这一轮没取到");
            }
        }
    });
}

/// 采集任务记着的东西：内核支不支持（隔一会儿再问）、按哪份配置判断拦截、内核那边没记下的累计数从多少开始算
/// What the collector keeps: whether the kernel supports it (asked again now and then), the config that tells blocks
/// apart, and where the kernel's count of unrecorded requests started
#[derive(Default)]
pub(super) struct Collector {
    capability_checked: Option<Instant>,
    supported: bool,
    rules: Option<(String, Arc<RuleIndex>)>,
    rules_checked: Option<Instant>,
    untracked: Option<(u64, u64)>,
}

#[derive(Debug, thiserror::Error)]
pub(super) enum CollectError {
    #[error(transparent)]
    Control(#[from] ControlError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("后台任务异常结束：{0}")]
    Join(#[from] tokio::task::JoinError),
}

impl Collector {
    pub(super) async fn tick(&mut self, state: &AppState) -> Result<(), CollectError> {
        let Some(store) = state.querylog.store.clone() else {
            return Ok(());
        };
        let result = self.collect(state, &store).await;
        // 内核停着也照样按保留时间和空间上限收拾 / Retention and the cap are applied even while the kernel is stopped
        let settings = state.querylog.settings();
        tokio::task::spawn_blocking(move || store.maintain(&settings, now_ms())).await??;
        result
    }

    async fn collect(
        &mut self,
        state: &AppState,
        store: &QueryLogStore,
    ) -> Result<(), CollectError> {
        if !self.supported(state).await? {
            return Ok(());
        }
        let mut walk = Walk {
            cursor: store.cursor(),
            page_size: KERNEL_PAGE,
            pages: 0,
            skipped: 0,
            skips_count: true,
        };
        while walk.pages < PAGES_PER_TICK {
            let after = walk.cursor.map_or(0, |cursor| cursor.seq);
            let page = match state.control.querylog(after, walk.page_size).await {
                Ok(page) => page,
                // 一页超过 8 MiB 的应答上限：减半再取 / A page over the 8 MiB reply cap: take half as many
                Err(ControlError::TooLarge(_)) if walk.page_size > 1 => {
                    walk.page_size /= 2;
                    continue;
                }
                Err(ControlError::TooLarge(_)) => {
                    self.skip_oversized(state, store, &mut walk, after).await?;
                    continue;
                }
                Err(error) => {
                    // 下回先重新问一遍支持什么：可能换了不支持的内核 / Ask about support again next time: the kernel may have
                    // been replaced by one without it
                    self.capability_checked = None;
                    return Err(error.into());
                }
            };
            walk.pages += 1;
            walk.page_size = KERNEL_PAGE;
            // 内核换了进程：它的编号从头数，按旧游标取会漏掉开头那些，从头再取一次。进程的时刻碰巧一样时，编号比游标
            // 还小也说明换过了
            // The kernel restarted: its numbers start over and the old cursor would skip the first ones, so take again
            // from the start. Should the process time happen to match, numbers below the cursor still give it away
            let restarted = walk.cursor.is_some_and(|cursor| {
                cursor.instance != page.instance || page.newest_seq < cursor.seq
            });
            if restarted && after != 0 {
                self.start_over(store, &mut walk, page.instance);
                continue;
            }
            let rules = if page.entries.iter().any(may_be_static) {
                self.rules(state).await
            } else {
                None
            };
            let settings = state.querylog.settings();
            let oversized = if walk.skips_count { walk.skipped } else { 0 };
            let (records, next, untracked) = self.records(
                &page,
                walk.cursor,
                after,
                &settings,
                rules.as_deref(),
                oversized,
            );
            write(store, records, settings).await?;
            // 写成了才算报过：写失败的那一批下回连同没记下的数一起再来 / Counted as reported only once written: a failed
            // batch comes back next time together with its unrecorded count
            self.untracked = Some(untracked);
            walk.skipped = 0;
            store.set_cursor(next);
            walk.cursor = Some(next);
            if !page.more {
                break;
            }
        }
        // 这一轮停在跳过的中途：跳过的照样记下 / The round ended mid-skip: the skipped ones are recorded all the same
        if let Some(cursor) = walk.cursor.filter(|_| walk.skipped > 0 && walk.skips_count) {
            let gap = Record::Gap {
                instance: cursor.instance,
                seq: cursor.seq,
                time_unix_ms: now_ms(),
                count: walk.skipped,
            };
            write(store, vec![gap], state.querylog.settings()).await?;
        }
        Ok(())
    }

    /// 内核支不支持查询日志：隔一会儿问一次，结果也告诉页面 / Whether the kernel has the query log: asked now and then, the
    /// answer passed on to the page
    async fn supported(&mut self, state: &AppState) -> Result<bool, CollectError> {
        if self
            .capability_checked
            .is_none_or(|checked| checked.elapsed() >= CAPABILITY_RECHECK)
        {
            let health = state.control.health().await?;
            self.supported = health
                .capabilities
                .iter()
                .any(|capability| capability == QUERYLOG_CAPABILITY);
            state.querylog.support.store(
                if self.supported {
                    SUPPORT_YES
                } else {
                    SUPPORT_NO
                },
                Ordering::Relaxed,
            );
            self.capability_checked = Some(Instant::now());
        }
        Ok(self.supported)
    }

    /// 一条也放不下：应答这么大，说明游标后面确实有记录，游标往前挪一格。挪过的若是早被挤掉的，本来也该算漏记。
    /// 这一轮第一次跳过时先问清是哪个内核进程：游标放到远超最新编号的地方，内核只回进程、不回记录
    /// Not even one record fits: a reply that large proves a record follows the cursor, which moves on by one. Any it
    /// passes that were already pushed out would count as gaps anyway. The first skip of a round first learns which
    /// kernel process this is: with the cursor far past the newest number, the kernel answers with the process and no
    /// records
    async fn skip_oversized(
        &mut self,
        state: &AppState,
        store: &QueryLogStore,
        walk: &mut Walk,
        after: u64,
    ) -> Result<(), CollectError> {
        walk.pages += 1;
        let instance = if walk.skipped == 0 {
            let probe = match state.control.querylog(u64::MAX / 2, 1).await {
                Ok(probe) => probe,
                Err(error) => {
                    self.capability_checked = None;
                    return Err(error.into());
                }
            };
            if walk
                .cursor
                .is_some_and(|cursor| cursor.instance != probe.instance)
            {
                self.start_over(store, walk, probe.instance);
                return Ok(());
            }
            walk.skips_count = walk.cursor.is_some();
            probe.instance
        } else {
            walk.cursor.map_or(0, |cursor| cursor.instance)
        };
        walk.skipped += 1;
        let next = Cursor {
            instance,
            seq: after + 1,
        };
        store.set_cursor(next);
        walk.cursor = Some(next);
        Ok(())
    }

    /// 内核换了进程：从它的第一条重新取 / The kernel restarted: take again from its first record
    fn start_over(&mut self, store: &QueryLogStore, walk: &mut Walk, instance: u64) {
        let fresh = Cursor { instance, seq: 0 };
        store.set_cursor(fresh);
        walk.cursor = Some(fresh);
        walk.page_size = KERNEL_PAGE;
        walk.skipped = 0;
        self.untracked = Some((instance, 0));
    }

    /// 一页内核记录变成要写下的几条，外加取完这一页后的游标和内核没记下的累计数
    /// Turns one kernel page into the records to write, plus the cursor after it and the kernel's unrecorded count
    fn records(
        &self,
        page: &KernelPage,
        cursor: Option<Cursor>,
        after: u64,
        settings: &QueryLogSettings,
        rules: Option<&RuleIndex>,
        oversized: u64,
    ) -> (Vec<Record>, Cursor, (u64, u64)) {
        let same_instance = cursor.is_some_and(|cursor| cursor.instance == page.instance);
        // 内核没记下的累计数：面板刚启动时不知道之前算到哪，从这一页起算；内核换了进程从零算
        // The kernel's running count of unrecorded requests: right after the panel starts the earlier count is unknown,
        // so counting starts at this page; a restarted kernel counts from zero
        let base = match self.untracked {
            Some((instance, count)) if instance == page.instance => count,
            Some(_) => 0,
            None => page.untracked,
        };
        let busy = page.untracked.saturating_sub(base);
        // 面板第一次取（还没有游标）时，交接区里早就挤掉的不算漏记：那时面板还没开始记
        // On the panel's very first take (no cursor yet), what the ring had already dropped is not a gap: the panel was
        // not recording yet
        let missed = if same_instance { page.missed } else { 0 };
        let gap = missed + busy + oversized;
        let mut records = Vec::with_capacity(page.entries.len() + 1);
        if gap > 0 {
            records.push(Record::Gap {
                instance: page.instance,
                seq: after + missed,
                time_unix_ms: page
                    .entries
                    .first()
                    .and_then(|entry| entry.get("time_unix_ms"))
                    .and_then(Value::as_u64)
                    .unwrap_or_else(now_ms),
                count: gap,
            });
        }
        let mut next = Cursor {
            instance: page.instance,
            seq: after + page.missed,
        };
        for entry in &page.entries {
            if let Some(seq) = entry.get("seq").and_then(Value::as_u64) {
                next.seq = seq;
            }
            let qname = entry
                .get("qname")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if settings.ignores(qname) {
                continue;
            }
            let classified = || rules.and_then(|rules| rules.classify(entry));
            let static_kind = match entry.get("outcome").and_then(Value::as_str) {
                Some("static") => classified(),
                // 「拦截 · SERVFAIL」：内核把 SERVFAIL 排在固定回答前面，记成了失败；按定下它的规则认回拦截
                // 「Block · SERVFAIL」: the kernel ranks SERVFAIL above a fixed answer and calls it failed; the rule
                // that decided it makes it a block again
                Some("failed") if may_be_static(entry) => {
                    classified().filter(|kind| *kind == StaticKind::Blocked)
                }
                _ => None,
            };
            records.push(Record::Entry {
                instance: page.instance,
                entry: entry.clone(),
                static_kind,
            });
        }
        (records, next, (page.instance, page.untracked))
    }

    /// 内核正在用的配置建的规则表；内核换了配置（摘要变了）才重建，和磁盘上的对不上时不用它
    /// The rule table built from the config the kernel is using; rebuilt only when the kernel's config changes (its
    /// digest), and not used when it does not match the file on disk
    async fn rules(&mut self, state: &AppState) -> Option<Arc<RuleIndex>> {
        let fresh = self
            .rules_checked
            .is_some_and(|checked| checked.elapsed() < RULES_RECHECK);
        if !fresh {
            self.rules_checked = Some(Instant::now());
            if let Ok(active) = state.control.active_config().await
                && self
                    .rules
                    .as_ref()
                    .is_none_or(|(sha256, _)| *sha256 != active.sha256)
            {
                self.rules = match state.config.current().await {
                    Ok(document) if document.sha256 == active.sha256 => Some((
                        active.sha256,
                        Arc::new(RuleIndex::from_config(&document.content)),
                    )),
                    // 磁盘上那份和内核在用的对不上（正在应用、刚退回）：这回不用，过一会儿再对
                    // The file on disk and the kernel's config differ (an apply under way, a rollback just made): not
                    // used this time, and checked again shortly
                    _ => None,
                };
            }
        }
        self.rules.as_ref().map(|(_, index)| Arc::clone(index))
    }
}

/// 这一条可能是规则直接给的回答：内核记成 `static` 的，和记成 SERVFAIL 失败的（可能是「拦截 · SERVFAIL」）
/// Whether this may be an answer a rule gave directly: what the kernel calls `static`, and SERVFAIL failures (which may
/// be 「Block · SERVFAIL」)
fn may_be_static(entry: &serde_json::Map<String, Value>) -> bool {
    match entry.get("outcome").and_then(Value::as_str) {
        Some("static") => true,
        Some("failed") => entry.get("rcode").and_then(Value::as_str) == Some("SERVFAIL"),
        _ => false,
    }
}

/// 一轮采集走到哪儿了 / How far one round of collecting has got
struct Walk {
    cursor: Option<Cursor>,
    page_size: usize,
    pages: usize,
    /// 这一轮跳过的、一条也放不下的记录，合成一行漏记 / Records skipped this round because not even one fits, made into one gap row
    skipped: u64,
    /// 面板还没有游标时跳过的不算：那时还分不清是太大的，还是面板开始记之前就挤掉的
    /// Skips made before the panel had a cursor do not count: it cannot tell then whether they were too large or pushed
    /// out before it began
    skips_count: bool,
}

async fn write(
    store: &QueryLogStore,
    records: Vec<Record>,
    settings: QueryLogSettings,
) -> Result<(), CollectError> {
    let writer = store.clone();
    tokio::task::spawn_blocking(move || writer.append(&records, &settings, now_ms())).await??;
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}
