//! 查询日志的接口和采集任务：每秒从内核取走新的查询写进 [`QueryLogStore`]，页面按条件往前翻。
//! The query log's endpoints and collector: every second the new queries are taken from the kernel into
//! [`QueryLogStore`], and the page reads back through them with filters.

use std::borrow::Cow;
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use serde::de::IgnoredAny;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::auth::{authenticate, unix_timestamp, verify_csrf};
use crate::control::{ControlError, QueryLogEntries, QueryLogPage as KernelPage, QueryLogWait};
use crate::db::Database;
use crate::error::{AppError, AppResult};
use crate::querylog::{
    Cursor, DEFAULT_PAGE_SIZE, Filter, KernelEntry, MAX_PAGE_SIZE, Page, PageQuery,
    QueryLogSettings, QueryLogStore, Record, RuleFilter, RuleIndex, StaticKind,
};
use crate::querylog_records;

use super::AppState;

const QUERYLOG_CAPABILITY: &str = "querylog_v1";
/// 内核会等着交：攒不满一页时先挂着，攒满或到时间再回 / The kernel can make the panel wait: short of a page it holds the
/// request until the page fills or the time is up
const QUERYLOG_WAIT_CAPABILITY: &str = "querylog_wait_v1";
/// 内核分得清存好的和取走的：面板说存好到哪一条，内核只删这些，于是几页可以同时取
/// The kernel tells what is stored from what is taken: it deletes only what the panel says is stored, so several pages
/// can be taken at once
const QUERYLOG_STORED_CAPABILITY: &str = "querylog_stored_v1";
/// 内核能只交到某个序号为止：同时取的相邻几页，前面被挤掉一截时也各管各的，不重叠
/// The kernel can stop at a given number: neighbouring pages taken at once keep to their own ranges and never overlap,
/// even with a stretch before them pushed out
const QUERYLOG_UNTIL_CAPABILITY: &str = "querylog_until_v1";
/// 内核能把编好的记录原样交出来：它不用再写 JSON，面板也不用再解析 / The kernel can hand over its encoded records as
/// they are: it no longer writes JSON, and the panel no longer parses it
const QUERYLOG_RECORDS_CAPABILITY: &str = "querylog_records_v1";
const SETTINGS_KEY: &str = "querylog_settings_v1";
/// 一次向不会等的内核要多少条：每条最多 64 步，250 条也在控制接口 8 MiB 的应答上限以内
/// How many records to ask a kernel that cannot wait for at once: an entry has at most 64 steps, so 250 stay within
/// the control socket's 8 MiB reply cap
const KERNEL_PAGE: usize = 250;
/// 一轮最多接着取这么多页：一页 250 条时一轮 5000 条，比不会等的内核那 4096 条的交接区多
/// At most this many pages a round: at 250 a page that is 5000 records, more than the 4096-record ring of a kernel that
/// cannot wait
const PAGES_PER_TICK: usize = 20;
/// 内核会等着交时一页取多少：流量一来，攒满这么多就交出来。内核拼一页 JSON 的那几毫秒里，它那颗核答不了 DNS，
/// 一页小些，DNS 的尾延迟就低；每秒四万条也只取八十来次
/// How many records a page holds from a kernel that can make the panel wait: once traffic brings this many, it hands
/// them over. While the kernel builds a page's JSON, its core answers no DNS for those milliseconds, so smaller pages
/// keep DNS tail latency low; even forty thousand records a second take only some eighty pages
const WAITING_PAGE: usize = 500;
/// 内核能交编好的记录时一页取多少：一页只是复制字节，不占它那颗核几毫秒。一页大些，每条分摊的请求和系统调用就少，内核和
/// 面板都省；再大尾延迟反而变差
/// How many records a page holds from a kernel handing over encoded records: a page is only copied
/// bytes and takes its core no milliseconds. With a larger page each record bears less of the request and
/// the system calls, on the kernel and the panel alike; larger still and tail latency gets worse
const RECORDS_PAGE: usize = 1_000;
/// 内核会等着交时，攒不满一页最多等多久 / How long a kernel that can make the panel wait holds a page that has not filled
const WAIT: Duration = Duration::from_secs(1);
/// 积压时同时要着几页：每页在后台线程上读，几页一起读；写还是按编号一页接一页
/// How many pages are asked for at once while records pile up: each is read on a blocking thread, several together;
/// writing still goes one page after another, in order
const IN_FLIGHT: usize = 4;
/// 几页同时取时，一轮最多要这么多页（三万二千条，编好的记录六万四千条），然后照常收拾一次
/// At most this many pages a round when several are taken at once (32,000 records, 64,000 encoded ones), then
/// tidying comes round as usual
const PIPELINE_PAGES: usize = 64;
/// 没有积压时多久取一次，也是收拾（保留时间、空间上限）的间隔
/// How often to collect with nothing piling up, and how often to tidy (retention, space cap)
const COLLECT_EVERY: Duration = Duration::from_secs(1);
/// 两轮之间最多让内核攒这么多条：按上一轮的速率定下一轮什么时候来，内核的交接区再小也装得下
/// At most this many records are left to pile up in the kernel between rounds: the next round is
/// timed from the last one's rate, well within even a small hand-off ring
const BACKLOG: u128 = 1_000;
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

/// 跟着内核取：有积压就接着取，没有时按速率隔一会儿，最长一秒（见 [`next_round`]）。内核停着、不支持都是常态，
/// 只在调试日志里说
/// Keeps up with the kernel: while records wait it takes again at once, otherwise it waits a while
/// set by the rate, a second at most (see [`next_round`]). A stopped or unsupporting kernel is
/// normal and only mentioned at debug level
pub(super) fn spawn_querylog_collector(state: AppState) {
    tokio::spawn(async move {
        let mut collector = Collector::default();
        loop {
            let pause = collector.tick(&state).await.unwrap_or_else(|error| {
                tracing::debug!(%error, "查询日志这一轮没取到");
                COLLECT_EVERY
            });
            tokio::time::sleep(pause).await;
        }
    });
}

/// 下一轮隔多久：还有没取完的就马上接着取；否则按这一轮的速率，让内核那边攒不到 [`BACKLOG`] 条，最长
/// [`COLLECT_EVERY`]。`since` 是离上一轮开始过了多久，`taken` 是这一轮取了几条
/// How long until the next round: at once while records remain; otherwise, by this round's rate,
/// before the kernel piles up [`BACKLOG`], at most [`COLLECT_EVERY`]. `since` is the time since the
/// previous round began and `taken` how many this round took
fn next_round(taken: usize, since: Option<Duration>, more: bool) -> Duration {
    if more {
        return Duration::ZERO;
    }
    let taken = u128::try_from(taken).unwrap_or(u128::MAX);
    match since {
        Some(since) if taken > 0 => {
            let millis = BACKLOG.saturating_mul(since.as_millis()) / taken;
            Duration::from_millis(u64::try_from(millis).unwrap_or(u64::MAX)).min(COLLECT_EVERY)
        }
        _ => COLLECT_EVERY,
    }
}

/// 采集任务记着的东西：内核支不支持（隔一会儿再问）、按哪份配置判断拦截、内核那边没记下的累计数从多少开始算
/// What the collector keeps: whether the kernel supports it (asked again now and then), the config that tells blocks
/// apart, and where the kernel's count of unrecorded requests started
#[derive(Default)]
pub(super) struct Collector {
    capability_checked: Option<Instant>,
    handover: Handover,
    /// 内核上回说的最新编号，连同是哪个进程：这之前的页不用等，可以先要着
    /// The newest number the kernel last gave, with its process: pages before it need no waiting and can be asked for
    /// ahead
    newest: Option<(u64, u64)>,
    rules: Option<(String, Arc<RuleIndex>)>,
    rules_checked: Option<Instant>,
    untracked: Option<(u64, u64)>,
    /// 上一轮什么时候开始的 / When the previous round began
    round_started: Option<Instant>,
    /// 上次收拾是什么时候 / When the last tidying was
    tidied: Option<Instant>,
    /// 后台正在做的那次收拾：关段要落盘、过期的要删，旧版留下的纯文本段还要压缩，可能要一两秒，采集不能停下来等，
    /// 否则内核那边的交接区会满
    /// The tidying under way in the background: closing a segment syncs it, expired ones are removed and an older
    /// version's plain segments are compressed, which can take a second or two, and collecting must not stop to wait
    /// for it, or the kernel's hand-off ring would fill
    tidying: Option<tokio::task::JoinHandle<()>>,
}

/// 内核怎么交查询日志，一级比一级多 / How the kernel hands over its query log, each level adding to the last
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Handover {
    /// 没有查询日志 / No query log
    #[default]
    None,
    /// 按游标交（`querylog_v1`）/ By cursor (`querylog_v1`)
    Cursor,
    /// 还会等着交（`querylog_wait_v1`）/ Also waiting for the panel (`querylog_wait_v1`)
    Waits,
    /// 还只删面板说存好了的、能只交到某个序号为止，于是相邻的几页可以同时取（`querylog_stored_v1`、
    /// `querylog_until_v1`）
    /// Also deleting only what the panel says is stored and stopping at a given number, so neighbouring pages can be
    /// taken at once (`querylog_stored_v1`, `querylog_until_v1`)
    Ranges,
    /// 还能把编好的记录原样交出来（`querylog_records_v1`）/ Also handing over its encoded records as they are
    /// (`querylog_records_v1`)
    Records,
}

impl Handover {
    /// 内核会等着交时一页取多少 / How many records a page holds from a kernel that can make the panel wait
    fn waiting_page(self) -> usize {
        if self == Self::Records {
            RECORDS_PAGE
        } else {
            WAITING_PAGE
        }
    }
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
    /// 取一轮，到了时候就收拾一次；返回下一轮隔多久（见 [`next_round`]）
    /// Collects one round and tidies when due; returns how long until the next round (see [`next_round`])
    pub(super) async fn tick(&mut self, state: &AppState) -> Result<Duration, CollectError> {
        let Some(store) = state.querylog.store.clone() else {
            return Ok(COLLECT_EVERY);
        };
        let result = self.collect(state, &store).await;
        // 内核停着也照样按保留时间和空间上限收拾；一直在取时也是一秒最多一次，上一次还没做完就不再起
        // Retention and the cap are applied even while the kernel is stopped, no more than once a second
        // while collecting goes on and on, and not again while the last one is still running
        let due = self
            .tidied
            .is_none_or(|tidied| tidied.elapsed() >= COLLECT_EVERY);
        let idle = self
            .tidying
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished);
        if due && idle {
            self.tidied = Some(Instant::now());
            let settings = state.querylog.settings();
            self.tidying = Some(tokio::task::spawn_blocking(move || {
                if let Err(error) = store.maintain(&settings, now_ms()) {
                    tracing::debug!(%error, "查询日志这一回没收拾好");
                }
            }));
        }
        result
    }

    async fn collect(
        &mut self,
        state: &AppState,
        store: &QueryLogStore,
    ) -> Result<Duration, CollectError> {
        if !self.supported(state).await? {
            return Ok(COLLECT_EVERY);
        }
        let started = Instant::now();
        let since = self
            .round_started
            .replace(started)
            .map(|previous| started - previous);
        let mut taken = 0;
        // 已经有游标时几页同时取；面板第一次取、一页超过应答上限时照一页页的办法
        // With a cursor already, several pages are taken at once; the panel's very first take and a page over the reply
        // cap go the page-by-page way
        if self.handover >= Handover::Ranges
            && let Some(cursor) = store.cursor()
        {
            let (moved, too_large) = self.collect_parallel(state, store, cursor).await?;
            if !too_large {
                return Ok(self.pause(moved, started, since, false));
            }
            taken = moved;
        }
        let mut more = false;
        let waits = self.handover >= Handover::Waits;
        let full_page = if waits {
            self.handover.waiting_page()
        } else {
            KERNEL_PAGE
        };
        let mut walk = Walk {
            cursor: store.cursor(),
            full_page,
            page_size: full_page,
            pages: 0,
            skipped: 0,
            skips_count: true,
        };
        while walk.pages < PAGES_PER_TICK {
            let after = walk.cursor.map_or(0, |cursor| cursor.seq);
            // 内核攒不满一页才会等：「还有」时接着取的那几页本来就是满的 / The kernel waits only short of a page: the pages
            // taken next for 「more」 are full anyway
            let waiting = waits.then(|| QueryLogWait {
                instance: walk.cursor.map(|cursor| cursor.instance),
                stored: None,
                until: None,
                records: self.handover == Handover::Records,
                wait: WAIT,
            });
            let mut page = match state.control.querylog(after, walk.page_size, waiting).await {
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
            walk.page_size = walk.full_page;
            // 内核换了进程：它的编号从头数，按旧游标取会漏掉开头那些，从头再取一次。进程的时刻碰巧一样时，编号比游标
            // 还小也说明换过了
            // The kernel restarted: its numbers start over and the old cursor would skip the first ones, so take again
            // from the start. Should the process time happen to match, numbers below the cursor still give it away
            let restarted = walk.cursor.is_some_and(|cursor| {
                cursor.instance != page.instance || page.newest_seq < cursor.seq
            });
            if restarted && after != 0 {
                walk.start_over(self.start_over(store, page.instance));
                continue;
            }
            let settings = state.querylog.settings();
            let entries =
                read_entries(&mut page, &settings).map_err(|error| self.unreadable(&error))?;
            taken += entries.len();
            more = page.more;
            let oversized = if walk.skips_count { walk.skipped } else { 0 };
            let next = self
                .store_page(state, store, &page, entries, walk.cursor, oversized)
                .await?;
            walk.skipped = 0;
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
        Ok(self.pause(taken, started, since, more))
    }

    /// 积压时几页同时取：已知攒满了的页先要着，每页只到它自己的末尾（`until`），同时最多 [`IN_FLIGHT`] 页，各自在
    /// 后台线程读好；写还是按编号一页接一页，写好一页游标才往前挪。每次都告诉内核存好到哪一条，内核只删这些，要着
    /// 还没写的不算。只有不知道有没有的那页让内核等，它回来之前不再往后要。整页都被挤掉了的，漏掉的并进下一行，和
    /// 后面的记录一起写。一页的起点和游标对不上（不该有），后面要着的都不要了，从游标重新要。交回游标挪了多远，和是
    /// 不是有一页超过了应答上限、余下的要照一页页的办法取
    /// Several pages taken at once while records pile up: pages known to be full are asked for ahead, each only up to
    /// its own end (`until`), at most [`IN_FLIGHT`] at a time, each read on a blocking thread; writing still goes one
    /// page after another in order, and the cursor moves only once a page is written. Every request tells the kernel
    /// how far is stored, and it deletes only that, not what is asked for and not yet written. Only the page not known
    /// to exist lets the kernel wait, and nothing further is asked for until it returns. Pages pushed out whole have
    /// their gap folded into the next row, written with the records after them. A page that does not start at the
    /// cursor (which should not happen) drops all asked for after it, and asking starts again at the cursor. Returns
    /// how far the cursor moved, and whether a page was over the reply cap so the rest must go the page-by-page way
    async fn collect_parallel(
        &mut self,
        state: &AppState,
        store: &QueryLogStore,
        mut cursor: Cursor,
    ) -> Result<(usize, bool), CollectError> {
        let mut in_flight = InFlight::default();
        let page_size = self.handover.waiting_page();
        let (mut moved, mut asked, mut caught_up) = (0, 0, false);
        // 整页都被挤掉了、还没写下的那几页：最后一页，和更早几页漏掉的条数。游标写下时才存，中途出错的话下一轮从存下的
        // 游标重取，内核照样说漏了几条
        // Pages pushed out whole and not yet written: the last of them, and how many the earlier ones missed. The
        // cursor is saved only once written, so after an error midway the next round takes again from the saved one
        // and the kernel tells the gap once more
        let mut gone: Option<(KernelPage, u64, u64)> = None;
        loop {
            let mut next = in_flight.next(page_size).unwrap_or(cursor.seq);
            while !caught_up
                && !in_flight.waiting()
                && in_flight.0.len() < IN_FLIGHT
                && asked < PIPELINE_PAGES
            {
                let full = self.newest.is_some_and(|(instance, newest)| {
                    instance == cursor.instance && newest >= next + page_size as u64
                });
                // 存好的说写下了的游标：整页被挤掉、还没写下的那几页不算 / What is stored is the cursor written down:
                // pages pushed out whole and not yet written do not count
                let stored = store.cursor().map_or(0, |stored| stored.seq);
                in_flight.0.push_back((
                    next,
                    !full,
                    fetch(
                        state,
                        Take {
                            instance: cursor.instance,
                            stored,
                            after: next,
                            page_size,
                            waits: !full,
                            records: self.handover == Handover::Records,
                        },
                    ),
                ));
                asked += 1;
                next += page_size as u64;
            }
            let Some((after, _, fetching)) = in_flight.0.pop_front() else {
                break;
            };
            let (page, entries) = match fetching.await? {
                Ok(fetched) => fetched,
                // 整页被挤掉、还没写下的那几页不写：一页页取的时候从存下的游标重取，内核照样说漏了几条
                // Pages pushed out whole and not yet written are left: the page-by-page way takes again from the
                // saved cursor, and the kernel tells the gap once more
                Err(CollectError::Control(ControlError::TooLarge(_))) => {
                    return Ok((usize::try_from(moved).unwrap_or(usize::MAX), true));
                }
                Err(error @ CollectError::Control(_)) => {
                    self.capability_checked = None;
                    return Err(error);
                }
                Err(error) => return Err(error),
            };
            self.newest = Some(match self.newest {
                Some((instance, newest)) if instance == page.instance => {
                    (instance, newest.max(page.newest_seq))
                }
                _ => (page.instance, page.newest_seq),
            });
            // 起点和游标对不上，只会是前面那页交得比要的多，越过了它的末尾：后面要着的都和它重叠，不要了。先对起点：
            // 先要着的一页可能比它前面那页拼得早，那时的最新编号比现在的游标还小，不说明内核换过进程
            // A start off the cursor can only mean the page before handed over more than asked, past its end: the
            // pages asked for after it overlap it and are dropped. The start is checked first: a page asked for ahead
            // may have been built before the one in front of it, with a newest number below today's cursor, which
            // does not mean the kernel restarted
            if after != cursor.seq {
                in_flight.clear();
                continue;
            }
            let restarted = cursor.instance != page.instance || page.newest_seq < cursor.seq;
            if restarted && after != 0 {
                in_flight.clear();
                gone = None;
                self.newest = Some((page.instance, page.newest_seq));
                cursor = self.start_over(store, page.instance);
                continue;
            }
            let entries = entries.map_err(|error| self.unreadable(&error))?;
            caught_up = !page.more;
            let earlier = gone
                .as_ref()
                .map_or(0, |(gone, _, earlier)| earlier + gone.missed);
            let next = if entries.is_empty() && page.missed > 0 {
                let next = Cursor {
                    seq: after + page.missed,
                    ..cursor
                };
                gone = Some((page, after, earlier));
                next
            } else {
                gone = None;
                self.store_page(state, store, &page, entries, Some(cursor), earlier)
                    .await?
            };
            moved += next.seq.saturating_sub(cursor.seq);
            cursor = next;
        }
        if let Some((page, after, earlier)) = gone {
            let at = Cursor {
                seq: after,
                ..cursor
            };
            self.store_page(state, store, &page, Vec::new(), Some(at), earlier)
                .await?;
        }
        Ok((usize::try_from(moved).unwrap_or(usize::MAX), false))
    }

    /// 读好的一页写下，交回这一页之后的游标 / Writes a page that has been read; returns the cursor past it
    async fn store_page(
        &mut self,
        state: &AppState,
        store: &QueryLogStore,
        page: &KernelPage,
        entries: Vec<Scanned>,
        cursor: Option<Cursor>,
        oversized: u64,
    ) -> Result<Cursor, CollectError> {
        let rules = if entries.iter().any(|entry| entry.candidate != Candidate::No) {
            self.rules(state).await
        } else {
            None
        };
        let after = cursor.map_or(0, |cursor| cursor.seq);
        let (records, next, untracked) =
            self.records(page, entries, cursor, after, rules.as_deref(), oversized);
        write(store, records, state.querylog.settings()).await?;
        // 写成了才算报过：写失败的那一批下回连同没记下的数一起再来 / Counted as reported only once written: a failed
        // batch comes back next time together with its unrecorded count
        self.untracked = Some(untracked);
        store.set_cursor(next);
        Ok(next)
    }

    /// 有一条读不懂就当内核出了问题，下回先重新问它支持什么 / A record that cannot be read means trouble with the
    /// kernel, whose support is asked again next time
    fn unreadable(&mut self, error: &serde_json::Error) -> CollectError {
        self.capability_checked = None;
        ControlError::Protocol(format!("查询日志里有一条读不懂：{error}")).into()
    }

    /// 下一轮隔多久。内核替面板等着：取到了就马上接着取；空手而回时至少隔满一个等待时间，内核没真等也不会空转。
    /// 内核不会等时按速率算（见 [`next_round`]）
    /// How long until the next round. A kernel waiting for the panel: having taken records it takes again at
    /// once; coming back empty, it lets a whole wait pass, so a kernel that did not wait cannot make it spin. A
    /// kernel that cannot wait goes by the rate (see [`next_round`])
    fn pause(
        &self,
        taken: usize,
        started: Instant,
        since: Option<Duration>,
        more: bool,
    ) -> Duration {
        if self.handover < Handover::Waits {
            return next_round(taken, since, more);
        }
        if taken > 0 {
            Duration::ZERO
        } else {
            WAIT.saturating_sub(started.elapsed())
        }
    }

    /// 内核支不支持查询日志：隔一会儿问一次，结果也告诉页面 / Whether the kernel has the query log: asked now and then, the
    /// answer passed on to the page
    async fn supported(&mut self, state: &AppState) -> Result<bool, CollectError> {
        if self
            .capability_checked
            .is_none_or(|checked| checked.elapsed() >= CAPABILITY_RECHECK)
        {
            let health = state.control.health().await?;
            let has = |wanted: &str| {
                health
                    .capabilities
                    .iter()
                    .any(|capability| capability == wanted)
            };
            self.handover = if !has(QUERYLOG_CAPABILITY) {
                Handover::None
            } else if !has(QUERYLOG_WAIT_CAPABILITY) {
                Handover::Cursor
            } else if !(has(QUERYLOG_STORED_CAPABILITY) && has(QUERYLOG_UNTIL_CAPABILITY)) {
                Handover::Waits
            } else if has(QUERYLOG_RECORDS_CAPABILITY) {
                Handover::Records
            } else {
                Handover::Ranges
            };
            state.querylog.support.store(
                if self.handover > Handover::None {
                    SUPPORT_YES
                } else {
                    SUPPORT_NO
                },
                Ordering::Relaxed,
            );
            self.capability_checked = Some(Instant::now());
        }
        Ok(self.handover > Handover::None)
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
            // 不说游标是哪个进程的：这一问不是存好了什么，内核不能删 / The cursor's process goes unsaid: this question
            // says nothing was stored, and the kernel must delete nothing
            let probe = match state.control.querylog(u64::MAX / 2, 1, None).await {
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
                walk.start_over(self.start_over(store, probe.instance));
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

    /// 内核换了进程：从它的第一条重新取，交回新的游标 / The kernel restarted: take again from its first record;
    /// returns the new cursor
    fn start_over(&mut self, store: &QueryLogStore, instance: u64) -> Cursor {
        let fresh = Cursor { instance, seq: 0 };
        store.set_cursor(fresh);
        self.untracked = Some((instance, 0));
        fresh
    }

    /// 一页内核记录变成要写下的几条，外加取完这一页后的游标和内核没记下的累计数
    /// Turns one kernel page into the records to write, plus the cursor after it and the kernel's unrecorded count
    fn records(
        &self,
        page: &KernelPage,
        entries: Vec<Scanned>,
        cursor: Option<Cursor>,
        after: u64,
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
        let mut records = Vec::with_capacity(entries.len() + 1);
        if gap > 0 {
            records.push(Record::Gap {
                instance: page.instance,
                seq: after + missed,
                time_unix_ms: entries
                    .first()
                    .and_then(|entry| entry.entry.time_unix_ms())
                    .unwrap_or_else(now_ms),
                count: gap,
            });
        }
        let mut next = Cursor {
            instance: page.instance,
            seq: after + page.missed,
        };
        for Scanned {
            entry,
            ignored,
            candidate,
        } in entries
        {
            if let Some(seq) = entry.seq() {
                next.seq = seq;
            }
            if ignored {
                continue;
            }
            // 只有可能是规则直接给的回答才整条解析，找定下它的那条规则
            // Only a possible rule-given answer is parsed whole, to find the rule that decided it
            let classified = || {
                let fields = entry.fields().ok()?;
                rules.and_then(|rules| rules.classify(&fields))
            };
            let static_kind = match candidate {
                Candidate::Static => classified(),
                // 「拦截 · SERVFAIL」：内核把 SERVFAIL 排在固定回答前面，记成了失败；按定下它的规则认回拦截
                // 「Block · SERVFAIL」: the kernel ranks SERVFAIL above a fixed answer and calls it failed; the rule
                // that decided it makes it a block again
                Candidate::Servfail => classified().filter(|kind| *kind == StaticKind::Blocked),
                Candidate::No => None,
            };
            records.push(Record::Entry {
                instance: page.instance,
                entry,
                static_kind,
            });
        }
        // 几页同时取时，后写的一页可能先拼好、累计数反而小：只往大里记，不然下一页会把差的那些再算一遍
        // With several pages taken at once, a page written later may have been built earlier with a smaller count: it
        // is only ever raised, or the next page would count the difference again
        (records, next, (page.instance, page.untracked.max(base)))
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Candidate {
    No,
    Static,
    Servfail,
}

impl Candidate {
    fn of(outcome: Option<&str>, rcode: Option<&str>) -> Self {
        match (outcome, rcode) {
            (Some("static"), _) => Self::Static,
            (Some("failed"), Some("SERVFAIL")) => Self::Servfail,
            _ => Self::No,
        }
    }
}

/// 内核的一条记录，读过了面板要看的几项 / A kernel record with the items the panel looks at read
struct Scanned {
    entry: KernelEntry,
    /// 设置里说这个域名不记 / The settings say this domain is not recorded
    ignored: bool,
    candidate: Candidate,
}

/// 读出来的那几项：编号、时刻、这个域名记不记、可能是不是规则直接给的回答
/// The items read: the number, the time, whether the domain is ignored, and whether a rule may have answered
type Summary = (Option<u64>, Option<u64>, bool, Candidate);

impl Scanned {
    /// 只读面板要看的几项，原文照留。带了面板自己的字段名，或者那几项的类型出乎意料时，整条解析，照原来的办法
    /// Reads only the items the panel looks at and keeps the text. With the panel's own field names, or
    /// those items of an unexpected type, the record is parsed whole, the old way
    fn read(text: Box<str>, settings: &QueryLogSettings) -> serde_json::Result<Self> {
        let summary = text
            .starts_with('{')
            .then(|| serde_json::from_str::<Glance<'_>>(&text).ok())
            .flatten()
            .and_then(|fields| Self::summary(&fields, settings));
        Self::with(text, summary, settings)
    }

    /// 整页原文里的记录，一条条读：`serde_json` 读完一个值就停下、交出读到哪儿，于是读那几项时就找到了这一条的
    /// 结尾，每条只扫一遍，也照样把整条校验了。页的样子出乎意料，或者有一条那几项的类型不对时交回 None，整页照常解析
    /// The records in a page's text, read one by one: `serde_json` stops after one value and says how far it read, so
    /// reading the items finds where the record ends; each is scanned once and still checked whole. A page shaped
    /// otherwise, or a record with those items of an unexpected type, gives None, and the page is parsed whole
    fn read_text(page: &str, at: usize, settings: &QueryLogSettings) -> Option<Vec<Self>> {
        let skip = |at: usize| {
            page[at..]
                .find(|character: char| !character.is_ascii_whitespace())
                .map_or(page.len(), |offset| at + offset)
        };
        let mut entries = Vec::new();
        let mut at = skip(at);
        if page[at..].starts_with(']') {
            at += 1;
        } else {
            loop {
                if !page[at..].starts_with('{') {
                    return None;
                }
                let mut stream =
                    serde_json::Deserializer::from_str(&page[at..]).into_iter::<Glance<'_>>();
                let fields = stream.next()?.ok()?;
                let end = at + stream.byte_offset();
                let summary = Self::summary(&fields, settings);
                entries.push(Self::with(page[at..end].into(), summary, settings).ok()?);
                at = skip(end);
                match page.as_bytes().get(at) {
                    Some(b',') => at = skip(at + 1),
                    Some(b']') => {
                        at += 1;
                        break;
                    }
                    _ => return None,
                }
            }
        }
        // 记录之后只该剩下 `}` / Only `}` should follow the records
        (page[at..].trim() == "}").then_some(entries)
    }

    /// 内核编好的记录一条条写成 JSON，写的时候就读到了要看的几项；有一条读不通就算这一页读不懂
    /// The kernel's encoded records written as JSON one by one, the items being read along the way; one that does not
    /// read makes the page unreadable
    fn read_records(
        page: &[u8],
        first: u64,
        records: &[std::ops::Range<usize>],
        settings: &QueryLogSettings,
    ) -> serde_json::Result<Vec<Self>> {
        // 一页的 JSON 写进同一块内存，各条只记自己在哪一段 / A page's JSON goes into one block of memory, each record
        // keeping only where its stretch is
        let mut text = Vec::with_capacity(records.len() * 512);
        let mut read = Vec::with_capacity(records.len());
        for (seq, range) in (first..).zip(records) {
            let start = text.len();
            let summary = querylog_records::write_record(seq, &page[range.clone()], &mut text)
                .ok_or_else(|| serde::de::Error::custom(format!("第 {seq} 条编好的记录读不通")))?;
            read.push((
                seq,
                start..text.len(),
                summary.time_unix_ms,
                settings.ignores(summary.qname),
                Candidate::of(Some(summary.outcome), summary.rcode.as_deref()),
            ));
        }
        let text = Arc::new(text);
        Ok(read
            .into_iter()
            .map(|(seq, range, time_unix_ms, ignored, candidate)| Self {
                entry: KernelEntry::in_page(Arc::clone(&text), range, seq, time_unix_ms),
                ignored,
                candidate,
            })
            .collect())
    }

    /// 那几项；带了面板自己的字段名时为 None，整条解析 / The items; None with the panel's own field names, and the
    /// record is parsed whole
    fn summary(fields: &Glance<'_>, settings: &QueryLogSettings) -> Option<Summary> {
        if fields.id.0 || fields.instance.0 || fields.static_kind.0 {
            return None;
        }
        Some((
            fields.seq,
            fields.time_unix_ms,
            settings.ignores(fields.qname.as_deref().unwrap_or_default()),
            Candidate::of(fields.outcome.as_deref(), fields.rcode.as_deref()),
        ))
    }

    fn with(
        text: Box<str>,
        summary: Option<Summary>,
        settings: &QueryLogSettings,
    ) -> serde_json::Result<Self> {
        if let Some((seq, time_unix_ms, ignored, candidate)) = summary {
            return Ok(Self {
                entry: KernelEntry::new(text, seq, time_unix_ms),
                ignored,
                candidate,
            });
        }
        let fields: serde_json::Map<String, Value> = serde_json::from_str(&text)?;
        let field = |key: &str| fields.get(key).and_then(Value::as_str);
        let ignored = settings.ignores(field("qname").unwrap_or_default());
        let candidate = Candidate::of(field("outcome"), field("rcode"));
        Ok(Self {
            entry: KernelEntry::from_map(fields),
            ignored,
            candidate,
        })
    }
}

/// 一条记录里面板要看的几项；别的字段只跳过，不解析
/// The items of a record the panel looks at; the other fields are skipped, not parsed
#[derive(Deserialize)]
struct Glance<'a> {
    seq: Option<u64>,
    time_unix_ms: Option<u64>,
    #[serde(borrow)]
    qname: Option<Cow<'a, str>>,
    #[serde(borrow)]
    outcome: Option<Cow<'a, str>>,
    #[serde(borrow)]
    rcode: Option<Cow<'a, str>>,
    #[serde(default)]
    id: Present,
    #[serde(default)]
    instance: Present,
    #[serde(default)]
    static_kind: Present,
}

/// 有这个字段，不管值是什么 / The field is there, whatever its value
#[derive(Default)]
struct Present(bool);

impl<'de> Deserialize<'de> for Present {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        IgnoredAny::deserialize(deserializer)?;
        Ok(Self(true))
    }
}

/// 一轮采集走到哪儿了 / How far one round of collecting has got
struct Walk {
    cursor: Option<Cursor>,
    /// 一页满满的条数 / How many records a full page holds
    full_page: usize,
    page_size: usize,
    pages: usize,
    /// 这一轮跳过的、一条也放不下的记录，合成一行漏记 / Records skipped this round because not even one fits, made into one gap row
    skipped: u64,
    /// 面板还没有游标时跳过的不算：那时还分不清是太大的，还是面板开始记之前就挤掉的
    /// Skips made before the panel had a cursor do not count: it cannot tell then whether they were too large or pushed
    /// out before it began
    skips_count: bool,
}

impl Walk {
    /// 内核换了进程，从新的游标取：页回到满满一页，跳过的不再算 / The kernel restarted and taking goes on from the new
    /// cursor: back to full pages, the skips no longer counted
    fn start_over(&mut self, fresh: Cursor) {
        self.cursor = Some(fresh);
        self.page_size = self.full_page;
        self.skipped = 0;
    }
}

/// 一页内核记录和读好的那几项；读不懂时交回错误，等轮到这一页时再说
/// A kernel page and its records as read; one that cannot be read gives the error, dealt with when the page's turn comes
type Fetched = Result<(KernelPage, serde_json::Result<Vec<Scanned>>), CollectError>;

/// 积压时先要着的那几页，按编号排着：每页的起点、是不是让内核等着的那页；丢下时没回来的都不要了
/// The pages asked for ahead while records pile up, in order: each page's start and whether it lets the kernel wait;
/// dropped, those not back yet are abandoned
#[derive(Default)]
struct InFlight(VecDeque<(u64, bool, tokio::task::JoinHandle<Fetched>)>);

impl InFlight {
    /// 下一页从哪儿要；一页也没要着时为 None / Where the next page is asked from; None with no page asked for
    fn next(&self, page_size: usize) -> Option<u64> {
        self.0.back().map(|(after, _, _)| after + page_size as u64)
    }

    /// 最后要的那页让内核等着：它回来之前不知道后面还有没有 / The last page asked for lets the kernel wait: until it
    /// returns, whether more follow is unknown
    fn waiting(&self) -> bool {
        self.0.back().is_some_and(|(_, waits, _)| *waits)
    }

    fn clear(&mut self) {
        for (_, _, fetching) in self.0.drain(..) {
            fetching.abort();
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.clear();
    }
}

/// 要一页时说的那些：游标是哪个内核进程的、存好到哪、从哪往后取；`waits` 的那页让内核攒不满一页先等着，别的页已知
/// 攒满了，只要到这一页的末尾；`records` 时要编好的记录
/// What asking for a page says: the kernel process the cursor belongs to, how far is stored, where to take from.
/// The page that `waits` lets the kernel hold it while it has not filled, and the others are known to be full and ask
/// only up to their own end; with `records`, the encoded records are asked for
#[derive(Clone, Copy)]
struct Take {
    instance: u64,
    stored: u64,
    after: u64,
    page_size: usize,
    waits: bool,
    records: bool,
}

/// 在后台要一页、回来就在后台线程读好 / Asks for a page in the background and reads it on a blocking thread once it
/// arrives
fn fetch(state: &AppState, take: Take) -> tokio::task::JoinHandle<Fetched> {
    let control = state.control.clone();
    let settings = state.querylog.settings();
    let Take {
        instance,
        stored,
        after,
        page_size,
        waits,
        records,
    } = take;
    let waiting = QueryLogWait {
        instance: Some(instance),
        stored: Some(stored),
        until: (!waits).then_some(after + page_size as u64),
        records,
        wait: if waits { WAIT } else { Duration::ZERO },
    };
    tokio::spawn(async move {
        let mut page = control.querylog(after, page_size, Some(waiting)).await?;
        Ok(tokio::task::spawn_blocking(move || {
            let entries = read_entries(&mut page, &settings);
            (page, entries)
        })
        .await?)
    })
}

/// 一页的记录只读面板要看的几项（见 [`Scanned::read`]）/ A page's records read for the items the panel looks at (see
/// [`Scanned::read`])
fn read_entries(
    page: &mut KernelPage,
    settings: &QueryLogSettings,
) -> serde_json::Result<Vec<Scanned>> {
    let entries = std::mem::replace(&mut page.entries, QueryLogEntries::Raw(Vec::new()));
    // 编好的记录：写成 JSON 时顺带读出要看的几项，不用再解析 / Encoded records: writing the JSON reads the items along the
    // way, with nothing to parse
    if let QueryLogEntries::Records {
        page,
        first,
        records,
    } = &entries
    {
        return Scanned::read_records(page, *first, records, settings);
    }
    // 整页原文一遍读完；读不下去就整页照常解析，再一条条读 / The page's text read in one pass; failing that, the page is
    // parsed whole and read record by record
    let entries = match entries {
        QueryLogEntries::Text { page, at } => match Scanned::read_text(&page, at, settings) {
            Some(entries) => return Ok(entries),
            None => QueryLogEntries::Text { page, at }.into_raw(),
        },
        entries => entries.into_raw(),
    };
    entries?
        .into_iter()
        .map(|raw| Scanned::read(raw.into(), settings))
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(text: &str) -> Box<str> {
        text.into()
    }

    /// 一遍读出来的和一条条读出来的完全一样 / What one pass reads is exactly what record-by-record reading gives
    fn same(left: &[Scanned], right: &[Scanned]) {
        assert_eq!(left.len(), right.len());
        for (left, right) in left.iter().zip(right) {
            assert_eq!(left.entry.seq(), right.entry.seq());
            assert_eq!(left.entry.time_unix_ms(), right.entry.time_unix_ms());
            assert_eq!(left.entry.fields().unwrap(), right.entry.fields().unwrap());
            assert_eq!(left.ignored, right.ignored);
            assert_eq!(left.candidate, right.candidate);
        }
    }

    /// 整页原文一遍读完：空白、字符串里的括号和转义引号、嵌套的数组都不会让它找错一条的结尾；结果和一条条读一样。
    /// 带了面板自己字段名的那条单独整条解析
    /// The page's text read in one pass: whitespace, brackets and escaped quotes inside strings and nested arrays do
    /// not make it miss where a record ends, and the result equals reading record by record. A record carrying the
    /// panel's own field names is parsed whole on its own
    #[test]
    fn a_page_is_read_in_one_pass_as_record_by_record_reading_would() {
        let settings = ignoring("quiet.example");
        let records = [
            r#"{"seq":1,"time_unix_ms":5,"qname":"a]}.example","outcome":"forwarded","rcode":"NOERROR","steps":[{"kind":"rule","x":[1,[2]]}]}"#,
            r#"{"seq":2,"qname":"q\"uote\\.quiet.example","outcome":"static"}"#,
            r#"{"seq":3,"id":99,"instance":4,"qname":"b.example","outcome":"failed","rcode":"SERVFAIL"}"#,
        ];
        let page = format!(
            " \n {} ,\t{},{} ]\n}}\n",
            records[0], records[1], records[2]
        );
        let one_pass = Scanned::read_text(&page, 0, &settings).expect("read in one pass");
        let one_by_one: Vec<Scanned> = records
            .iter()
            .map(|text| Scanned::read(raw(text), &settings).unwrap())
            .collect();
        same(&one_pass, &one_by_one);
        assert_eq!(one_pass[2].entry.fields().unwrap().get("id"), None);
        assert!(one_pass[1].ignored);
        assert!(Scanned::read_text("]}", 0, &settings).unwrap().is_empty());
    }

    /// 同一批记录，从内核编好的字节读和从 JSON 读，读出来的完全一样：编号、时刻、原文、这个域名记不记、可能不可能是规则
    /// 直接给的回答（样本是内核生成的）
    /// The same records read from the kernel's encoded bytes and from JSON give exactly the same: number, time, text,
    /// whether the domain is recorded and whether a rule may have answered (the sample was generated by the kernel)
    #[test]
    fn encoded_records_read_as_their_text_does() {
        const RECORDS: &[u8] = include_bytes!("../../tests/fixtures/querylog-records1.bin");
        const TEXT: &str = include_str!("../../tests/fixtures/querylog-records1.json");
        const KEY: &str = ",\"entries\":[";
        let settings = ignoring("x.example");
        let page = querylog_records::RecordsPage::read(RECORDS).unwrap();
        let from_records =
            Scanned::read_records(RECORDS, page.first, &page.records, &settings).unwrap();
        let at = TEXT.find(KEY).unwrap() + KEY.len();
        let from_text = Scanned::read_text(TEXT, at, &settings).expect("read in one pass");
        same(&from_records, &from_text);
        assert!(from_records.iter().any(|record| record.ignored));
        for candidate in [Candidate::No, Candidate::Static, Candidate::Servfail] {
            assert!(
                from_records
                    .iter()
                    .any(|record| record.candidate == candidate)
            );
        }
        let broken = page.records[0].start..page.records[0].end - 1;
        assert!(Scanned::read_records(RECORDS, page.first, &[broken], &settings).is_err());
    }

    /// 页的样子出乎意料，或者有一条那几项的类型不对时一遍读不下去，交回去整页照常解析
    /// A page shaped otherwise, or a record with those items of an unexpected type, stops the single pass and goes
    /// back to be parsed whole
    #[test]
    fn an_odd_page_is_not_read_in_one_pass() {
        let settings = QueryLogSettings::default();
        for page in [
            r#"{"seq":1}],"padding":"x"}"#,
            r#"{"seq":1}]"#,
            r#"[1],{"seq":2}]}"#,
            r#"{"seq":"1"}]}"#,
            r#"{"seq":1};{"seq":2}]}"#,
            r#"{"seq":1"#,
        ] {
            assert!(Scanned::read_text(page, 0, &settings).is_none(), "{page}");
        }
    }

    fn ignoring(domain: &str) -> QueryLogSettings {
        QueryLogSettings {
            ignored_domains: vec![domain.to_owned()],
            ..QueryLogSettings::default()
        }
    }

    /// 一条记录只读面板要看的几项，原文留着：编号、时刻、该不该记、可能不可能是规则直接给的回答
    /// A record is read for the items the panel looks at and its text kept: number, time, whether it is
    /// recorded, whether it may be a rule-given answer
    #[test]
    fn a_record_is_read_without_taking_it_apart() {
        let settings = ignoring("quiet.example");
        let read = |text: &str| Scanned::read(raw(text), &settings).unwrap();
        let forwarded = read(
            r#"{"seq":5,"time_unix_ms":9,"qname":"a.example","outcome":"forwarded","rcode":"NOERROR"}"#,
        );
        assert_eq!(forwarded.entry.seq(), Some(5));
        assert_eq!(forwarded.entry.time_unix_ms(), Some(9));
        assert!(!forwarded.ignored);
        assert_eq!(forwarded.candidate, Candidate::No);
        assert!(read(r#"{"seq":6,"qname":"quiet.example"}"#).ignored);
        assert_eq!(read(r#"{"outcome":"static"}"#).candidate, Candidate::Static);
        assert_eq!(
            read(r#"{"outcome":"failed","rcode":"SERVFAIL"}"#).candidate,
            Candidate::Servfail
        );
        assert_eq!(
            read(r#"{"outcome":"failed","rcode":"REFUSED"}"#).candidate,
            Candidate::No
        );
    }

    /// 那几项的类型出乎意料、带了面板自己的字段名时整条解析，结果和原来一样：读不出的编号、时刻当没有，
    /// 不是文字的域名当空；不是对象的记录读不了
    /// With those items of an unexpected type or the panel's own field names the record is parsed whole,
    /// as before: an unreadable number or time counts as none and a domain that is no text as empty; a
    /// record that is no object cannot be read
    #[test]
    fn odd_records_are_read_the_old_way() {
        let settings = ignoring("quiet.example");
        let read = |text: &str| Scanned::read(raw(text), &settings);
        let odd = read(r#"{"seq":"5","time_unix_ms":1.5,"qname":7,"outcome":"static"}"#).unwrap();
        assert_eq!(odd.entry.seq(), None);
        assert_eq!(odd.entry.time_unix_ms(), None);
        assert!(!odd.ignored);
        assert_eq!(odd.candidate, Candidate::Static);
        let own = read(r#"{"id":null,"seq":2,"qname":"quiet.example"}"#).unwrap();
        assert_eq!(own.entry.seq(), Some(2));
        assert!(own.ignored);
        assert!(!own.entry.fields().unwrap().contains_key("id"));
        assert!(read("[1,2]").is_err());
        assert!(read(r#""text""#).is_err());
    }

    /// 还有没取完的马上接着取；否则按这一轮的速率，让内核攒不到 `BACKLOG` 条，最长一秒
    /// While records remain the next round is at once; otherwise, by this round's rate, before the kernel
    /// piles up `BACKLOG`, a second at most
    #[test]
    fn rounds_keep_up_with_the_rate() {
        let second = Duration::from_secs(1);
        assert_eq!(next_round(5_000, Some(second), true), Duration::ZERO);
        assert_eq!(next_round(10, None, false), COLLECT_EVERY);
        assert_eq!(next_round(0, Some(second), false), COLLECT_EVERY);
        assert_eq!(next_round(10, Some(second), false), COLLECT_EVERY);
        assert_eq!(
            next_round(8_000, Some(second), false),
            Duration::from_millis(125)
        );
        assert_eq!(
            next_round(40_000, Some(second), false),
            Duration::from_millis(25)
        );
    }
}
