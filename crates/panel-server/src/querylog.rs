//! 查询日志：面板每秒从内核取走的查询，按小时分段写在数据库旁边的 `querylog/` 目录里。
//!
//! 每段一个文件，名字是开段时刻和第一条的编号（`{start_ms}-{first_id}.jsonl`）。正在写的那段是纯文本，
//! 过了这个小时（或写满）就关上、压成 `.jsonl.gz`。一行一条记录，带面板自己的编号 `id`：内核的 `seq`
//! 在内核重启后从头数，翻页和新条目的判断都用 `id`。空间上限按磁盘上的字节数算，超了先删最早的一段；
//! 保留时间按段删，读的时候再按条过滤，所以「保留 6 小时」也是准的。
//!
//! The query log: the queries the panel takes from the kernel every second, written next to the
//! database in `querylog/`, one segment per hour.
//!
//! Each segment is a file named by the moment it opened and its first id (`{start_ms}-{first_id}.jsonl`).
//! The segment being written is plain text; once its hour has passed (or it is full) it is closed and
//! compressed to `.jsonl.gz`. One record per line, carrying the panel's own `id`: the kernel's `seq`
//! starts over when the kernel restarts, so paging and new-entry checks use `id`. The space cap counts
//! bytes on disk and drops the oldest segment first; retention drops whole segments and is applied per
//! record on read, so 「keep 6 hours」 holds exactly.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::net::IpAddr;
use std::ops::ControlFlow;
use std::os::unix::fs::{FileExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use anyhow::Context;
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 默认保留 90 天 / Kept for 90 days by default
pub const DEFAULT_RETENTION_HOURS: u32 = 2_160;
/// 保留时间最长一年 / Retention is at most a year
pub const MAX_RETENTION_HOURS: u32 = 8_760;
/// 默认最多占 500 MiB / At most 500 MiB by default
pub const DEFAULT_MAX_BYTES: u64 = 500 * MIB;
/// 空间上限最少 10 MiB，最多 100 GiB / The space cap is at least 10 MiB and at most 100 GiB
pub const MIN_MAX_BYTES: u64 = 10 * MIB;
pub const MAX_MAX_BYTES: u64 = 100 * 1024 * MIB;
/// 忽略的域名最多这么多个 / At most this many ignored domains
pub const MAX_IGNORED_DOMAINS: usize = 1_000;
/// 一页默认 200 条，最多 500 条 / 200 records per page by default, 500 at most
pub const DEFAULT_PAGE_SIZE: usize = 200;
pub const MAX_PAGE_SIZE: usize = 500;

const MIB: u64 = 1024 * 1024;
const HOUR_MS: u64 = 3_600_000;
/// 正在写的一段最大多少：上限的八分之一，在 1 MiB 到 32 MiB 之间
/// How large the segment being written may grow: an eighth of the cap, between 1 MiB and 32 MiB
const SEGMENT_MIN_BYTES: u64 = MIB;
const SEGMENT_MAX_BYTES: u64 = 32 * MIB;
/// 一次查询最多看这么多条、这么久：条件很少命中时分几次往前找，不让一次请求扫遍几十天
/// One read looks at no more records and no longer than this: a rarely matching filter searches back in
/// several steps instead of one request scanning weeks
const SCAN_RECORDS: usize = 200_000;
const SCAN_TIME: Duration = Duration::from_millis(1_500);
const STATE_FILE: &str = "state.json";
/// 只挪了游标时，最多这么久落一次盘：它只影响重启后漏记行准不准，不值得每秒写一回
/// How often a cursor that merely moved reaches disk at most: it only affects how exact the gap row is after a
/// restart, which is not worth a write every second
const CURSOR_SAVE_INTERVAL: Duration = Duration::from_mins(1);

/// 内核的游标：哪个内核进程（`instance`）、取到了第几条（`seq`）
/// The kernel cursor: which kernel process (`instance`) and the last `seq` taken
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub instance: u64,
    pub seq: u64,
}

/// 内核说是 `static` 的回答，在面板里是拦截还是自定义回答
/// Whether an answer the kernel calls `static` is a block or a custom answer in the panel's terms
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaticKind {
    Blocked,
    Answered,
}

impl StaticKind {
    fn label(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Answered => "answered",
        }
    }
}

/// 要写下的一条 / One record to write
#[derive(Debug, Clone)]
pub enum Record {
    /// 内核给的一条查询，字段原样保留 / One query from the kernel, its fields kept as they are
    Entry {
        instance: u64,
        entry: Map<String, Value>,
        static_kind: Option<StaticKind>,
    },
    /// 这里漏记了几条；`seq` 是漏记之后的游标 / This many went unrecorded here; `seq` is the cursor after the gap
    Gap {
        instance: u64,
        seq: u64,
        time_unix_ms: u64,
        count: u64,
    },
}

impl Record {
    fn time_unix_ms(&self) -> Option<u64> {
        match self {
            Self::Entry { entry, .. } => entry.get("time_unix_ms").and_then(Value::as_u64),
            Self::Gap { time_unix_ms, .. } => Some(*time_unix_ms),
        }
    }

    fn cursor(&self) -> Option<Cursor> {
        match self {
            Self::Entry {
                instance, entry, ..
            } => entry.get("seq").and_then(Value::as_u64).map(|seq| Cursor {
                instance: *instance,
                seq,
            }),
            Self::Gap { instance, seq, .. } => Some(Cursor {
                instance: *instance,
                seq: *seq,
            }),
        }
    }

    fn to_line(&self, id: u64) -> Map<String, Value> {
        let mut line = Map::new();
        line.insert("id".to_owned(), id.into());
        match self {
            Self::Entry {
                instance,
                entry,
                static_kind,
            } => {
                line.insert("instance".to_owned(), (*instance).into());
                for (key, value) in entry {
                    if !matches!(key.as_str(), "id" | "instance" | "static_kind") {
                        line.insert(key.clone(), value.clone());
                    }
                }
                if let Some(kind) = static_kind {
                    line.insert("static_kind".to_owned(), kind.label().into());
                }
            }
            Self::Gap {
                instance,
                seq,
                time_unix_ms,
                count,
            } => {
                line.insert("instance".to_owned(), (*instance).into());
                line.insert("seq".to_owned(), (*seq).into());
                line.insert("time_unix_ms".to_owned(), (*time_unix_ms).into());
                line.insert("gap".to_owned(), (*count).into());
            }
        }
        line
    }
}

/// 存多久、最多占多少、哪些域名不记 / How long to keep, how much space at most, which domains not to record
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryLogSettings {
    pub retention_hours: u32,
    pub max_bytes: u64,
    #[serde(default)]
    pub ignored_domains: Vec<String>,
}

impl Default for QueryLogSettings {
    fn default() -> Self {
        Self {
            retention_hours: DEFAULT_RETENTION_HOURS,
            max_bytes: DEFAULT_MAX_BYTES,
            ignored_domains: Vec::new(),
        }
    }
}

impl QueryLogSettings {
    /// 检查并整理：保留时间、空间上限在范围内；域名小写、去掉结尾的点、去重。错误说的是页面上的话。
    /// Checks and tidies: retention and cap in range; domains lowercased, trailing dot dropped, deduplicated.
    /// Errors speak the page's words.
    pub fn normalized(mut self) -> Result<Self, String> {
        if !(1..=MAX_RETENTION_HOURS).contains(&self.retention_hours) {
            return Err(format!("保存多久要在 1 到 {MAX_RETENTION_HOURS} 小时之间"));
        }
        if !(MIN_MAX_BYTES..=MAX_MAX_BYTES).contains(&self.max_bytes) {
            return Err("最多占用要在 10 MB 到 100 GB 之间".to_owned());
        }
        let mut seen = HashSet::new();
        let mut domains = Vec::new();
        for raw in self.ignored_domains {
            let domain = normalize_domain(&raw);
            if domain.is_empty() {
                continue;
            }
            if domain.len() > 253
                || !domain
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            {
                return Err(format!("「{}」不是域名", raw.trim()));
            }
            if seen.insert(domain.clone()) {
                domains.push(domain);
            }
        }
        if domains.len() > MAX_IGNORED_DOMAINS {
            return Err(format!("不记录的域名最多 {MAX_IGNORED_DOMAINS} 个"));
        }
        self.ignored_domains = domains;
        Ok(self)
    }

    /// 这个查询名在不在忽略的域名里（含子域名） / Whether this query name is ignored (subdomains included)
    #[must_use]
    pub fn ignores(&self, qname: &str) -> bool {
        if self.ignored_domains.is_empty() {
            return false;
        }
        let name = normalize_domain(qname);
        self.ignored_domains.iter().any(|domain| {
            name == *domain
                || name
                    .strip_suffix(domain.as_str())
                    .is_some_and(|rest| rest.ends_with('.'))
        })
    }

    fn segment_limit(&self) -> u64 {
        (self.max_bytes / 8).clamp(SEGMENT_MIN_BYTES, SEGMENT_MAX_BYTES)
    }

    fn retention_ms(&self) -> u64 {
        u64::from(self.retention_hours) * HOUR_MS
    }
}

/// 小写，去掉两头的点；`*.example.com` 和 `.example.com` 都当 `example.com`（本来就含子域名）
/// Lowercased with the dots at both ends dropped; `*.example.com` and `.example.com` both mean `example.com`
/// (subdomains are included anyway)
fn normalize_domain(raw: &str) -> String {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("*.")
        .unwrap_or(trimmed)
        .trim_matches('.')
        .to_ascii_lowercase()
}

/// 读的时候按什么筛 / What a read filters on
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// 域名或客户端里含有这段（不分大小写） / Domain or client containing this (case-insensitive)
    pub q: Option<String>,
    /// 最后进入的 Pipeline 是其中之一 / The pipeline entered last is one of these
    pub pipelines: Option<HashSet<String>>,
    /// 结果是其中之一（面板的叫法） / The outcome is one of these (the panel's words)
    pub outcomes: Option<HashSet<String>>,
    pub client: Option<String>,
    pub rule: Option<RuleFilter>,
    /// 问过这个上游（不一定是它回答的） / This upstream was asked (not necessarily the one that answered)
    pub upstream: Option<String>,
}

/// 按规则筛：和规则列表上的命中数同一个算法 / Filter by rule: the same basis as the rule list's hit counts
#[derive(Debug, Clone)]
pub struct RuleFilter {
    /// 规则名，内核拆开的 `名字#N` 算同一条 / The rule name; the kernel's split `name#N` counts as the same rule
    pub name: String,
    pub pipeline: Option<String>,
    /// 回答后检查：只算条件命中的那一步 / Answer check: only the step whose condition matched counts
    pub response: bool,
}

impl Filter {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.q.is_none()
            && self.pipelines.is_none()
            && self.outcomes.is_none()
            && self.client.is_none()
            && self.rule.is_none()
            && self.upstream.is_none()
    }

    /// 不解析整行就能排除的：要找的字符串（JSON 转义后）不在这一行里
    /// What can be ruled out without parsing the line: a sought string (JSON-escaped) is not in it
    fn may_match(&self, line: &[u8]) -> bool {
        let contains = |needle: &str| match serde_json::to_string(needle) {
            // 去掉两边的引号，剩下的就是它在行里的样子 / Without its quotes it reads as it does in the line
            Ok(escaped) => contains_bytes(line, &escaped.as_bytes()[1..escaped.len() - 1]),
            Err(_) => true,
        };
        if self
            .client
            .as_deref()
            .is_some_and(|client| !contains(client))
            || self
                .upstream
                .as_deref()
                .is_some_and(|upstream| !contains(upstream))
            || self.rule.as_ref().is_some_and(|rule| !contains(&rule.name))
        {
            return false;
        }
        // 搜索词要转义时（非 ASCII、引号、反斜杠、控制字符）在行里换了样子，这时不预筛
        // A search term that needs escaping (non-ASCII, quotes, backslashes, control characters) looks different
        // in the line, so it is not prefiltered
        match &self.q {
            Some(q)
                if q.bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\') =>
            {
                contains_ascii_ignore_case(line, q.as_bytes())
            }
            _ => true,
        }
    }

    fn matches(&self, record: &Map<String, Value>) -> bool {
        if record.contains_key("gap") {
            return self.is_empty();
        }
        let text = |key: &str| record.get(key).and_then(Value::as_str);
        if let Some(q) = &self.q {
            let in_name = text("qname").is_some_and(|name| name.to_lowercase().contains(q));
            let in_client = text("client").is_some_and(|client| client.to_lowercase().contains(q));
            if !in_name && !in_client {
                return false;
            }
        }
        if let Some(pipelines) = &self.pipelines
            && !text("pipeline").is_some_and(|pipeline| pipelines.contains(pipeline))
        {
            return false;
        }
        if let Some(outcomes) = &self.outcomes
            && !outcomes.contains(outcome_of(record))
        {
            return false;
        }
        if let Some(client) = &self.client
            && text("client") != Some(client.as_str())
        {
            return false;
        }
        let steps = || {
            record
                .get("steps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
        };
        if let Some(rule) = &self.rule {
            let phase = if rule.response { "response" } else { "request" };
            let hit = steps().any(|step| {
                let field = |key: &str| step.get(key).and_then(Value::as_str);
                field("kind") == Some("rule")
                    && field("phase") == Some(phase)
                    && (!rule.response || step.get("matched") == Some(&Value::Bool(true)))
                    && field("rule").map(rule_base_name) == Some(rule.name.as_str())
                    && rule
                        .pipeline
                        .as_deref()
                        .is_none_or(|pipeline| field("pipeline") == Some(pipeline))
            });
            if !hit {
                return false;
            }
        }
        if let Some(upstream) = &self.upstream {
            let asked = steps().any(|step| {
                step.get("kind").and_then(Value::as_str) == Some("upstream")
                    && step.get("upstream").and_then(Value::as_str) == Some(upstream.as_str())
            });
            if !asked {
                return false;
            }
        }
        true
    }
}

/// 内核把一条规则拆成几条时叫它们 `名字#N` / The kernel names the parts of a split rule `name#N`
fn rule_base_name(name: &str) -> &str {
    match name.rsplit_once('#') {
        Some((base, number))
            if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) =>
        {
            base
        }
        _ => name,
    }
}

/// 一条记录在面板里的结果：内核的 `static` 分成拦截和自定义回答，其余照内核的说法
/// A record's outcome in the panel's words: the kernel's `static` splits into blocked and answered, the rest
/// keep the kernel's words
fn outcome_of(record: &Map<String, Value>) -> &str {
    let kind = record.get("static_kind").and_then(Value::as_str);
    match record.get("outcome").and_then(Value::as_str) {
        Some("static") => match kind {
            Some("blocked") => "blocked",
            Some("answered") => "answered",
            _ => static_kind_from_answer(record).label(),
        },
        // 「拦截 · SERVFAIL」：内核把 SERVFAIL 排在固定回答前面，记成了失败
        // 「Block · SERVFAIL」: the kernel ranks SERVFAIL above a fixed answer and calls it failed
        Some("failed") if kind == Some("blocked") => "blocked",
        Some(outcome) => outcome,
        None => "failed",
    }
}

/// 找不到定下回答的规则时，只能看回答本身：错误码不是 NOERROR、或者只回了 0.0.0.0 / :: 就算拦截
/// Without the rule that decided, only the answer itself can tell: an rcode other than NOERROR, or nothing
/// but 0.0.0.0 / ::, counts as a block
#[must_use]
pub fn static_kind_from_answer(entry: &Map<String, Value>) -> StaticKind {
    if entry
        .get("rcode")
        .and_then(Value::as_str)
        .is_some_and(|rcode| rcode != "NOERROR")
    {
        return StaticKind::Blocked;
    }
    let answers = entry
        .get("answers")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    if !answers.is_empty()
        && answers.iter().all(|answer| {
            answer
                .as_str()
                .and_then(|text| text.parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_unspecified())
        })
    {
        return StaticKind::Blocked;
    }
    StaticKind::Answered
}

/// 配置里每条规则的固定回答是哪一种，按内核写回答的那一份配置建 / What kind of fixed answer each rule gives,
/// built from the config the kernel answered with
#[derive(Debug, Default)]
pub struct RuleIndex {
    /// 同一个列表里重名、回答又不一样的规则分不清是哪条，记成 `None`
    /// Same-named rules in one list that answer differently cannot be told apart and are kept as `None`
    rules: HashMap<(String, String), Option<RuleStatics>>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct RuleStatics {
    actions: Option<StaticKind>,
    on_match: Option<StaticKind>,
    on_miss: Option<StaticKind>,
}

impl RuleIndex {
    #[must_use]
    pub fn from_config(content: &Value) -> Self {
        let mut rules = HashMap::new();
        let pipelines = content
            .get("pipelines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten();
        for pipeline in pipelines {
            let Some(id) = pipeline.get("id").and_then(Value::as_str) else {
                continue;
            };
            let pipeline_rules = pipeline
                .get("rules")
                .and_then(Value::as_array)
                .into_iter()
                .flatten();
            for rule in pipeline_rules {
                let Some(name) = rule.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let statics = RuleStatics {
                    actions: first_static(rule.get("actions")),
                    on_match: first_static(rule.get("response_actions_on_match")),
                    on_miss: first_static(rule.get("response_actions_on_miss")),
                };
                rules
                    .entry((id.to_owned(), name.to_owned()))
                    .and_modify(|known: &mut Option<RuleStatics>| {
                        if *known != Some(statics) {
                            *known = None;
                        }
                    })
                    .or_insert(Some(statics));
            }
        }
        Self { rules }
    }

    /// 定下这条 `static` 回答的规则给的是哪一种回答；找不到那条规则时为 `None`
    /// Which kind of answer the rule that decided this `static` answer gives; `None` when that rule cannot be found
    #[must_use]
    pub fn classify(&self, entry: &Map<String, Value>) -> Option<StaticKind> {
        let steps: Vec<&Map<String, Value>> = entry
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .collect();
        let field = |step: &Map<String, Value>, key: &str| {
            step.get(key).and_then(Value::as_str).map(str::to_owned)
        };
        let (index, decided) = steps
            .iter()
            .enumerate()
            .rev()
            .find(|(_, step)| step.get("decision").and_then(Value::as_str) == Some("static"))?;
        let pipeline = field(decided, "pipeline")?;
        let rule = field(decided, "rule")?;
        let statics = (*self.rules.get(&(pipeline.clone(), rule.clone()))?)?;
        if field(decided, "phase").as_deref() != Some("response") {
            return statics.actions;
        }
        // 回答后检查：条件命中用命中时的动作，没命中用没命中时的动作。单记的决定往前找这条规则那一步的结果
        // Answer check: a matched condition uses the on-match actions, an unmatched one the on-miss actions. A
        // decision recorded on its own looks back for this rule's step to learn which
        let matched = if field(decided, "kind").as_deref() == Some("rule") {
            decided.get("matched").and_then(Value::as_bool)
        } else {
            steps[..index].iter().rev().find_map(|step| {
                (field(step, "kind").as_deref() == Some("rule")
                    && field(step, "phase").as_deref() == Some("response")
                    && field(step, "pipeline").as_deref() == Some(pipeline.as_str())
                    && field(step, "rule").as_deref() == Some(rule.as_str()))
                .then(|| step.get("matched").and_then(Value::as_bool))
                .flatten()
            })
        };
        if matched == Some(false) {
            statics.on_miss
        } else {
            statics.on_match
        }
    }
}

/// 一组动作里第一个固定回答是哪一种，和面板读入内核配置时的认法一样（importer.ts 的 staticOutcome）：
/// `deny` 和各种错误码的 `static_response` 都是拦截（面板的「空回答」就是 NOERROR）；`static_ip_response` 只有
/// 正好是 0.0.0.0 和 :: 两个地址时才是拦截（「空地址」），其余都是自定义回答
/// Which kind the first fixed answer in a list of actions is, read the way the panel reads a kernel config
/// (importer.ts staticOutcome): `deny` and `static_response` with any rcode are blocks (the panel's 「空回答」
/// is NOERROR); `static_ip_response` is a block only when it is exactly 0.0.0.0 and :: (「空地址」), and
/// everything else is a custom answer
fn first_static(actions: Option<&Value>) -> Option<StaticKind> {
    actions
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|action| {
            let text = |key: &str| action.get(key).and_then(Value::as_str);
            match text("type")? {
                "deny" | "static_response" => Some(StaticKind::Blocked),
                "static_ip_response" => {
                    let addresses: Vec<IpAddr> = text("ip")
                        .unwrap_or_default()
                        .split(',')
                        .map(str::trim)
                        .filter(|address| !address.is_empty())
                        .filter_map(|address| address.parse().ok())
                        .collect();
                    let zero = addresses.len() == 2
                        && addresses.iter().all(IpAddr::is_unspecified)
                        && addresses.iter().any(IpAddr::is_ipv4)
                        && addresses.iter().any(IpAddr::is_ipv6);
                    Some(if zero {
                        StaticKind::Blocked
                    } else {
                        StaticKind::Answered
                    })
                }
                "static_cname_response" | "static_txt_response" => Some(StaticKind::Answered),
                _ => None,
            }
        })
}

/// 一页查询日志 / One page of the query log
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Page {
    pub items: Vec<Value>,
    /// 往前接着翻用的编号；`None` 表示再往前没有了 / The id to page further back from; `None` when nothing older exists
    pub next_before: Option<u64>,
    /// 最新一条的编号，有新的时它会变大 / The newest id, which grows when new records arrive
    pub newest_id: Option<u64>,
    /// 整个日志最新一条的时间，不管筛选；保留时间以外的不算 / When the log's newest record was written, whatever the filter;
    /// nothing outside retention counts
    pub newest_unix_ms: Option<u64>,
    /// 这次找到哪一刻为止（扫到上限还没凑满一页时有用） / How far back this read got (useful when it stopped short)
    pub scanned_to_unix_ms: Option<u64>,
}

/// 一次读：按什么筛、从哪个编号往前、要几条、早于哪一刻的不要
/// One read: the filter, the id to read back from, how many, and the moment before which nothing counts
#[derive(Debug, Clone)]
pub struct PageQuery {
    pub filter: Filter,
    pub before: Option<u64>,
    /// 只看比它新的：页面轮询新查询时带上它见过的最新编号，扫到它就停，不必把整个筛选再扫一遍
    /// Only records newer than this: the page polls for new queries with the newest id it has seen, and the scan stops
    /// there instead of running the whole filter again
    pub after: Option<u64>,
    pub limit: usize,
    pub cutoff_ms: u64,
}

/// 占了多少、最早一段从哪一刻开始 / How much space is used and when the oldest segment opened
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub bytes: u64,
    pub oldest_start_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Segment {
    start_ms: u64,
    first_id: u64,
    compressed: bool,
    /// 正在往里写 / Being written to
    open: bool,
    bytes: u64,
}

impl Segment {
    fn stem(&self) -> String {
        format!("{:013}-{:016}", self.start_ms, self.first_id)
    }

    fn plain_name(&self) -> String {
        format!("{}.jsonl", self.stem())
    }

    fn gz_name(&self) -> String {
        format!("{}.jsonl.gz", self.stem())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    next_id: u64,
    cursor: Option<Cursor>,
}

struct Inner {
    segments: Vec<Segment>,
    writer: Option<File>,
    next_id: u64,
    cursor: Option<Cursor>,
    /// 最新一条记录的时间（页头的「最近一条」） / The newest record's time (the page header's 最近一条)
    newest_ms: Option<u64>,
    /// 游标挪了、还没落到文件里（这一批全被忽略，或者内核换了进程）
    /// The cursor moved without reaching disk (a batch entirely ignored, or a kernel restart)
    cursor_dirty: bool,
    /// 上次写状态文件的时候 / When the state file was last written
    state_saved: Option<Instant>,
}

/// 查询日志的文件：一个写的人（采集任务），随时可以读 / The query log's files: one writer (the collector), reads at any time
#[derive(Clone)]
pub struct QueryLogStore {
    root: Arc<PathBuf>,
    inner: Arc<Mutex<Inner>>,
}

impl QueryLogStore {
    /// 打开目录，没有就建：清掉半截的临时文件和空段，接着上次写到的编号和游标往下写。单个文件坏了只跳过，
    /// 不影响打开。
    /// Opens the directory, creating it when absent: half-written temporary files and empty segments are removed and
    /// writing carries on from the last id and cursor. A single bad file is skipped and does not stop the opening.
    ///
    /// # Errors
    ///
    /// 目录建不了、读不了，或者是符号链接时出错。 / Fails when the directory cannot be created or read, or is a symlink.
    pub fn open(root: PathBuf) -> anyhow::Result<Self> {
        prepare_root(&root)?;
        let mut segments = Vec::new();
        for item in fs::read_dir(&root)
            .with_context(|| format!("读取查询日志目录失败：{}", root.display()))?
        {
            let item = item.context("读取查询日志目录失败")?;
            // 只认普通文件，符号链接不跟 / Only regular files; symlinks are not followed
            if !item.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            if Path::new(name)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
            {
                let _ = fs::remove_file(item.path());
                continue;
            }
            let Some(segment) = parse_segment_name(name) else {
                continue;
            };
            let bytes = item.metadata().map_or(0, |metadata| metadata.len());
            if bytes == 0 {
                // 开了还没写就断电的空段：不留，免得和下一段的编号撞上 / An empty segment from a power loss right after it
                // opened: removed, so its id cannot collide with the next segment's
                let _ = fs::remove_file(item.path());
                continue;
            }
            segments.push(Segment { bytes, ..segment });
        }
        // 按编号排，不按时刻：系统时钟往回调过时，开段时刻会倒着走，编号不会
        // Ordered by id, not by time: when the clock steps back, opening times run backwards but ids never do
        segments.sort_by_key(|segment| (segment.first_id, segment.start_ms, !segment.compressed));
        // 压缩到一半断电：压好的在、纯文本也还在，留压好的 / Power lost mid-compression: keep the compressed copy
        segments.dedup_by(|later, earlier| {
            let same = later.start_ms == earlier.start_ms && later.first_id == earlier.first_id;
            if same && !later.compressed {
                let _ = fs::remove_file(root.join(later.plain_name()));
            }
            same
        });
        let mut writer = None;
        if let Some(last) = segments.last_mut().filter(|last| !last.compressed) {
            let path = root.join(last.plain_name());
            match reopen_for_append(&path) {
                Ok((bytes, file)) => {
                    last.bytes = bytes;
                    last.open = true;
                    writer = Some(file);
                }
                // 接不上就当它已经关上，下一批开新的一段 / If it cannot be continued it counts as closed and the next batch opens a new segment
                Err(error) => tracing::warn!(error = ?error, "查询日志最后一段接不上，另开一段"),
            }
        }
        let state = read_state(&root);
        let mut last = None;
        for segment in segments.iter().rev() {
            match last_record(&root, segment) {
                Ok(Some(record)) => {
                    last = Some(record);
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(error = %error, segment = %segment.stem(), "查询日志有一段读不了，跳过");
                }
            }
        }
        let last_id = last
            .as_ref()
            .and_then(|record| record.get("id").and_then(Value::as_u64))
            .unwrap_or_default();
        // 最新那段读不了时，编号至少要越过每一段的开头，不然新写的会和它撞号
        // When the newest segment cannot be read, ids must at least pass every segment's first one, or new records
        // would reuse its numbers
        let past_segments = segments
            .iter()
            .map(|segment| segment.first_id + 1)
            .max()
            .unwrap_or(1);
        // 状态文件写下之后没再写过记录，它的游标就不比最后一条旧 / When nothing was written after the state file, its
        // cursor is no older than the last record's
        let cursor = if state.next_id > last_id {
            state.cursor
        } else {
            last.as_ref().and_then(record_cursor)
        };
        Ok(Self {
            root: Arc::new(root),
            inner: Arc::new(Mutex::new(Inner {
                segments,
                writer,
                next_id: (last_id + 1).max(state.next_id).max(past_segments),
                cursor,
                newest_ms: last
                    .as_ref()
                    .and_then(|record| record.get("time_unix_ms").and_then(Value::as_u64)),
                cursor_dirty: false,
                state_saved: None,
            })),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 最后取到内核的哪一条 / The last kernel record taken
    #[must_use]
    pub fn cursor(&self) -> Option<Cursor> {
        self.lock().cursor
    }

    /// 接着写一批：换了小时或者写满了就先开新的一段。写到一半出错时把这一段截回写之前，不留半行。
    /// Appends a batch: a new segment opens first when the hour changed or the current one is full. A failed
    /// write cuts the segment back to where it was, leaving no half line.
    ///
    /// # Errors
    ///
    /// 写文件出错时返回。 / Fails when writing the file fails.
    pub fn append(
        &self,
        records: &[Record],
        settings: &QueryLogSettings,
        now_ms: u64,
    ) -> io::Result<()> {
        if records.is_empty() {
            return Ok(());
        }
        // 记录的时刻不晚于写下的时刻，段的小时才管得住它的记录；采集那一两秒里时钟往回调了，就按记录的时刻算
        // A segment's hour only bounds its records if no record is later than the write; should the clock step back
        // during the second or so of collecting, the records' time counts
        let stamp = records
            .iter()
            .filter_map(Record::time_unix_ms)
            .fold(now_ms, u64::max);
        let mut inner = self.lock();
        let limit = settings.segment_limit();
        if inner.segments.last().is_some_and(|last| {
            last.open && (hour(last.start_ms) != hour(stamp) || last.bytes >= limit)
        }) {
            self.close_open(&mut inner);
        }
        if !inner.segments.last().is_some_and(|last| last.open) {
            let segment = Segment {
                start_ms: stamp,
                first_id: inner.next_id,
                compressed: false,
                open: true,
                bytes: 0,
            };
            let file = OpenOptions::new()
                .append(true)
                .create_new(true)
                .mode(0o600)
                .open(self.root.join(segment.plain_name()))?;
            inner.writer = Some(file);
            inner.segments.push(segment);
        }
        let mut buffer = Vec::with_capacity(records.len() * 1_024);
        let mut id = inner.next_id;
        let mut cursor = inner.cursor;
        for record in records {
            serde_json::to_writer(&mut buffer, &record.to_line(id))?;
            buffer.push(b'\n');
            id += 1;
            cursor = record.cursor().or(cursor);
        }
        let before = inner.segments.last().map_or(0, |last| last.bytes);
        let written = inner
            .writer
            .as_mut()
            .ok_or_else(|| io::Error::other("查询日志没有打开"))
            .and_then(|writer| writer.write_all(&buffer));
        if let Err(error) = written {
            if let Some(writer) = inner.writer.as_mut() {
                let _ = writer.set_len(before);
            }
            return Err(error);
        }
        inner.next_id = id;
        inner.cursor = cursor;
        inner.cursor_dirty = false;
        if let Some(newest) = records.iter().filter_map(Record::time_unix_ms).max() {
            inner.newest_ms = Some(inner.newest_ms.map_or(newest, |before| before.max(newest)));
        }
        if let Some(last) = inner.segments.last_mut() {
            last.bytes += buffer.len() as u64;
        }
        Ok(())
    }

    /// 没写进文件也要记住的游标（这一批全被忽略了，或者内核换了进程）；下次收拾时落盘
    /// A cursor to remember although nothing was written (the whole batch was ignored, or the kernel restarted);
    /// it reaches disk at the next housekeeping
    pub fn set_cursor(&self, cursor: Cursor) {
        let mut inner = self.lock();
        if inner.cursor != Some(cursor) {
            inner.cursor = Some(cursor);
            inner.cursor_dirty = true;
        }
    }

    /// 关上正在写的那段；一条也没写的空段直接删掉。关上时把编号落盘：这一段之后读不了，编号也不会往回走
    /// Closes the segment being written; an empty one is simply removed. Closing puts the ids on disk, so even if the
    /// segment later becomes unreadable, ids never go backwards
    fn close_open(&self, inner: &mut Inner) {
        inner.writer = None;
        if let Some(last) = inner.segments.last_mut().filter(|last| last.open) {
            last.open = false;
            if last.bytes == 0 {
                let _ = fs::remove_file(self.root.join(last.plain_name()));
                inner.segments.pop();
            } else {
                self.save_state_or_warn(inner);
            }
        }
    }

    /// 收拾：过了小时的那段关上，关上的压缩，再按保留时间和空间上限删最早的，最后把挪过的游标落盘。
    /// 哪一步出错都不挡后面几步：磁盘满了压缩不了，照样要删旧的腾地方。
    /// Housekeeping: a segment whose hour has passed is closed, closed ones are compressed, the oldest are dropped by
    /// retention and by the space cap, and a moved cursor reaches disk. No failing step stops the later ones: with a
    /// full disk nothing compresses, and old segments must still go to make room.
    ///
    /// # Errors
    ///
    /// 返回遇到的第一个错误。 / Returns the first error met.
    pub fn maintain(&self, settings: &QueryLogSettings, now_ms: u64) -> io::Result<()> {
        let closed: Vec<Segment> = {
            let mut inner = self.lock();
            if inner
                .segments
                .last()
                .is_some_and(|last| last.open && hour(last.start_ms) != hour(now_ms))
            {
                self.close_open(&mut inner);
            }
            inner
                .segments
                .iter()
                .filter(|segment| !segment.open && !segment.compressed)
                .copied()
                .collect()
        };
        let mut first_error = None;
        for segment in closed {
            match self.compress(segment) {
                Ok(()) => {}
                // 文件没了：这一段不再算 / The file is gone: the segment no longer counts
                Err(error) if error.kind() == ErrorKind::NotFound => self.forget(segment),
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Err(error) = self.enforce(settings, now_ms) {
            first_error.get_or_insert(error);
        }
        {
            let mut inner = self.lock();
            if inner.cursor_dirty
                && inner
                    .state_saved
                    .is_none_or(|saved| saved.elapsed() >= CURSOR_SAVE_INTERVAL)
                && let Err(error) = self.save_state(&mut inner)
            {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn forget(&self, segment: Segment) {
        self.lock().segments.retain(|entry| {
            entry.first_id != segment.first_id || entry.start_ms != segment.start_ms
        });
    }

    fn compress(&self, segment: Segment) -> io::Result<()> {
        let plain = self.root.join(segment.plain_name());
        let gz = self.root.join(segment.gz_name());
        let temporary = self.root.join(format!("{}.tmp", segment.gz_name()));
        let result = (|| {
            let mut input = File::open(&plain)?;
            let output = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            let mut encoder = GzEncoder::new(output, Compression::default());
            io::copy(&mut input, &mut encoder)?;
            encoder.finish()?.sync_all()?;
            fs::rename(&temporary, &gz)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
        let bytes = fs::metadata(&gz)?.len();
        let kept = {
            let mut inner = self.lock();
            inner
                .segments
                .iter_mut()
                .find(|entry| {
                    entry.start_ms == segment.start_ms && entry.first_id == segment.first_id
                })
                .map(|entry| {
                    entry.compressed = true;
                    entry.bytes = bytes;
                })
                .is_some()
        };
        if !kept {
            // 压缩时这段已经被删了 / The segment was dropped while it was compressed
            let _ = fs::remove_file(&gz);
        }
        match fs::remove_file(&plain) {
            Err(error) if error.kind() != ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    fn enforce(&self, settings: &QueryLogSettings, now_ms: u64) -> io::Result<()> {
        let cutoff = now_ms.saturating_sub(settings.retention_ms());
        let mut dropped = Vec::new();
        {
            let mut inner = self.lock();
            // 一段只收开段那个小时里写下的：那个小时过完、又过了保留时间，整段就全过期了。每段各按各的小时算，
            // 时钟往回调过、各段的时刻不按编号排时也对。正在写的那段不会过期（过了它的小时，收拾时先关上了），
            // 最新一段关上以后过期了也删：游标和编号在删之前写进了状态文件
            // A segment only takes what was written in the hour it opened in: once that hour has passed the cutoff, the
            // whole segment has expired. Each segment is judged by its own hour, which holds even after a clock step
            // left opening times out of id order. The segment being written cannot have expired (housekeeping closes it
            // once its hour passes), and a closed newest segment goes too once expired: the cursor and ids reach the
            // state file before it is removed
            inner.segments.retain(|segment| {
                let expired = !segment.open && segment_end(segment) <= cutoff;
                if expired {
                    dropped.push(*segment);
                }
                !expired
            });
            let mut total: u64 = inner.segments.iter().map(|segment| segment.bytes).sum();
            while total > settings.max_bytes && inner.segments.len() > 1 {
                let segment = inner.segments.remove(0);
                total -= segment.bytes;
                dropped.push(segment);
            }
            // 只剩一段还超：没压缩就先关上（下回压缩），压缩了还超就整段不要
            // Only one segment left and still over: an uncompressed one is closed (compressed next time); a
            // compressed one still over is dropped whole
            if total > settings.max_bytes
                && let Some(last) = inner.segments.last().copied()
            {
                if last.open {
                    self.close_open(&mut inner);
                } else if last.compressed {
                    dropped.push(inner.segments.remove(0));
                }
            }
            if dropped.is_empty() {
                return Ok(());
            }
            self.save_state_or_warn(&mut inner);
        }
        remove_all(&self.root, &dropped)
    }

    /// 全部清空；编号接着往下数，游标也留着，内核那边已经取过的不会再取一遍
    /// Clears everything; ids keep counting and the cursor is kept, so what was already taken from the kernel is
    /// not taken again
    ///
    /// # Errors
    ///
    /// 删文件出错时返回。 / Fails when removing a file fails.
    pub fn clear(&self) -> io::Result<()> {
        let dropped = {
            let mut inner = self.lock();
            inner.writer = None;
            let dropped = std::mem::take(&mut inner.segments);
            self.save_state_or_warn(&mut inner);
            dropped
        };
        remove_all(&self.root, &dropped)
    }

    /// 编号和游标写进状态文件；持着锁写，收拾和清空不会同时写它
    /// Writes the id and cursor to the state file; written under the lock, so housekeeping and clearing never write it at once
    fn save_state(&self, inner: &mut Inner) -> io::Result<()> {
        write_state(
            &self.root,
            &State {
                next_id: inner.next_id,
                cursor: inner.cursor,
            },
        )?;
        inner.cursor_dirty = false;
        inner.state_saved = Some(Instant::now());
        Ok(())
    }

    /// 删段之前写状态文件，写不成（比如磁盘满了）也照样删：腾地方要紧，丢的只是重启后的游标
    /// The state file is written before segments go, and they go even when it cannot be written (a full disk, say):
    /// making room matters more, and all that is lost is the cursor after a restart
    fn save_state_or_warn(&self, inner: &mut Inner) {
        if let Err(error) = self.save_state(inner) {
            tracing::warn!(%error, "查询日志的状态文件没写成");
        }
    }

    #[must_use]
    pub fn usage(&self) -> Usage {
        let inner = self.lock();
        Usage {
            bytes: inner.segments.iter().map(|segment| segment.bytes).sum(),
            oldest_start_ms: inner.segments.iter().map(|segment| segment.start_ms).min(),
        }
    }

    /// 从新往旧读一页。一次最多看 [`SCAN_RECORDS`] 条、[`SCAN_TIME`] 这么久，看完还没凑满就把看到哪儿
    /// 作为 `next_before` 交回去，下次接着找。读不了的段跳过，不让一个坏文件挡住整页。
    /// Reads one page from newest to oldest. A read looks at no more than [`SCAN_RECORDS`] records for no longer than
    /// [`SCAN_TIME`]; when that runs out before the page fills, how far it got goes back as `next_before` for the next
    /// read to continue from. An unreadable segment is skipped, so one bad file never blocks a page.
    #[must_use]
    pub fn read_page(&self, query: &PageQuery) -> Page {
        self.read_page_within(query, SCAN_RECORDS)
    }

    fn read_page_within(&self, query: &PageQuery, budget: usize) -> Page {
        let (segments, newest_id, newest_ms) = {
            let inner = self.lock();
            (
                inner.segments.clone(),
                inner.segments.last().map(|_| inner.next_id - 1),
                inner.segments.last().and(inner.newest_ms),
            )
        };
        let mut scan = Scan {
            query,
            limit: query.limit.clamp(1, MAX_PAGE_SIZE),
            newest_id: newest_id.unwrap_or_default(),
            budget,
            started: Instant::now(),
            items: Vec::new(),
            last_item: None,
            scanned: 0,
            scanned_to: None,
            stopped_at: None,
            next_before: None,
        };
        for segment in segments.iter().rev() {
            if query
                .before
                .is_some_and(|before| segment.first_id >= before)
            {
                continue;
            }
            // 整段都过期了就跳过；不在这里停，时钟往回调过的话更旧的编号里可能还有没过期的
            // A wholly expired segment is skipped, not a reason to stop: after a clock step older ids may still hold
            // records within retention
            if segment_end(segment) <= query.cutoff_ms {
                continue;
            }
            let walked = for_each_line_rev(&self.root, segment, |line| scan.line(line));
            if let Err(error) = walked {
                tracing::warn!(%error, segment = %segment.stem(), "查询日志有一段读不了，跳过");
            }
            // 只看新的：这一段已经到了见过的编号，更早的段都不用看 / Only newer ones: this segment reaches the seen id, so no
            // older segment needs reading
            if scan.next_before.is_some()
                || query.after.is_some_and(|after| segment.first_id <= after)
            {
                break;
            }
        }
        Page {
            items: scan.items,
            next_before: scan.next_before,
            newest_id,
            newest_unix_ms: newest_ms.filter(|&newest| newest >= query.cutoff_ms),
            scanned_to_unix_ms: scan.scanned_to,
        }
    }
}

/// 一次往前找的进度 / The progress of one read back
struct Scan<'a> {
    query: &'a PageQuery,
    limit: usize,
    /// 拿快照时最新的编号：之后才写的不算，这一页和 `newest_id` 说的一致
    /// The newest id at the snapshot: anything written later is left out, so the page agrees with `newest_id`
    newest_id: u64,
    budget: usize,
    started: Instant,
    items: Vec<Value>,
    last_item: Option<u64>,
    scanned: usize,
    scanned_to: Option<u64>,
    /// 看到上限时停在哪一条；后面还有能看的才把它交回去 / Where the budget ran out; handed back only when more remains
    stopped_at: Option<u64>,
    next_before: Option<u64>,
}

impl Scan<'_> {
    fn line(&mut self, line: &[u8]) -> ControlFlow<()> {
        let Ok(head) = serde_json::from_slice::<RecordHead>(line) else {
            return ControlFlow::Continue(());
        };
        if head.id > self.newest_id
            || self.query.before.is_some_and(|before| head.id >= before)
            || head.time_unix_ms < self.query.cutoff_ms
        {
            return ControlFlow::Continue(());
        }
        // 段里从新往旧走：到了见过的编号，后面的都见过 / A segment is walked newest first: once at the seen id, the rest were
        // seen too
        if self.query.after.is_some_and(|after| head.id <= after) {
            return ControlFlow::Break(());
        }
        if let Some(stopped) = self.stopped_at {
            // 停下之后还有一条能看的：交回停下的地方，下次接着找 / Something remains after the stop: hand back where it stopped
            self.next_before = Some(stopped);
            return ControlFlow::Break(());
        }
        self.scanned += 1;
        self.scanned_to = Some(head.time_unix_ms);
        if self.query.filter.may_match(line)
            && let Ok(Value::Object(record)) = serde_json::from_slice::<Value>(line)
            && self.query.filter.matches(&record)
        {
            if self.items.len() == self.limit {
                // 再往前还有合条件的 / More matches further back
                self.next_before = self.last_item;
                return ControlFlow::Break(());
            }
            self.last_item = Some(head.id);
            self.items.push(present(record));
        }
        if self.scanned >= self.budget
            || (self.scanned.is_multiple_of(4_096) && self.started.elapsed() >= SCAN_TIME)
        {
            self.stopped_at = Some(head.id);
        }
        ControlFlow::Continue(())
    }
}

#[derive(Deserialize)]
struct RecordHead {
    id: u64,
    #[serde(default)]
    time_unix_ms: u64,
}

/// 交给页面的一条：去掉面板内部用的字段，结果换成面板的叫法
/// One record for the page: internal fields removed, the outcome in the panel's words
fn present(mut record: Map<String, Value>) -> Value {
    if record.contains_key("gap") {
        let keep = |key: &str| record.get(key).cloned().unwrap_or(Value::Null);
        return serde_json::json!({
            "id": keep("id"),
            "time_unix_ms": keep("time_unix_ms"),
            "gap": keep("gap"),
        });
    }
    let outcome = outcome_of(&record).to_owned();
    record.remove("instance");
    record.remove("static_kind");
    record.insert("outcome".to_owned(), outcome.into());
    Value::Object(record)
}

fn record_cursor(record: &Map<String, Value>) -> Option<Cursor> {
    Some(Cursor {
        instance: record.get("instance").and_then(Value::as_u64)?,
        seq: record.get("seq").and_then(Value::as_u64)?,
    })
}

fn hour(unix_ms: u64) -> u64 {
    unix_ms / HOUR_MS
}

/// 一段里的记录都早于这一刻：段只收开段那个小时里写下的 / Every record in a segment is older than this: a segment only
/// takes what was written in the hour it opened in
fn segment_end(segment: &Segment) -> u64 {
    (hour(segment.start_ms) + 1) * HOUR_MS
}

fn parse_segment_name(name: &str) -> Option<Segment> {
    let (stem, compressed) = if let Some(stem) = name.strip_suffix(".jsonl.gz") {
        (stem, true)
    } else {
        (name.strip_suffix(".jsonl")?, false)
    };
    let (start, first) = stem.split_once('-')?;
    if start.len() != 13 || first.len() != 16 {
        return None;
    }
    Some(Segment {
        start_ms: start.parse().ok()?,
        first_id: first.parse().ok()?,
        compressed,
        open: false,
        bytes: 0,
    })
}

/// 正在写的那段从尾部一块一块往前读：翻最新一页时不用把整段读进来
/// The segment being written is read backwards from its end in blocks: the newest page never loads the whole segment
const TAIL_BLOCK: u64 = 256 * 1024;

/// 从新到旧把一段里的每一行交给 `visit`，它说停就停。纯文本的那段只读到拿快照时写完的地方（不读半批）；
/// 在读之前被压缩的换压缩后的那份，被删掉的就当没有。
/// Hands every line of a segment, newest first, to `visit`, stopping when it says so. A plain segment is read only up
/// to where the snapshot saw it end (never half a batch); one compressed just before the read is read from its
/// compressed copy, and one dropped counts as empty.
fn for_each_line_rev(
    root: &Path,
    segment: &Segment,
    mut visit: impl FnMut(&[u8]) -> ControlFlow<()>,
) -> io::Result<()> {
    if !segment.compressed {
        match File::open(root.join(segment.plain_name())) {
            Ok(file) => return lines_from_end(&file, segment.bytes, &mut visit),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let file = match File::open(root.join(segment.gz_name())) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    GzDecoder::new(BufReader::new(file)).read_to_end(&mut bytes)?;
    for line in bytes.split(|byte| *byte == b'\n').rev() {
        if !line.is_empty() && visit(line).is_break() {
            break;
        }
    }
    Ok(())
}

/// 文件前 `length` 个字节里的行，从后往前 / The lines in the first `length` bytes of a file, last first
fn lines_from_end(
    file: &File,
    length: u64,
    visit: &mut impl FnMut(&[u8]) -> ControlFlow<()>,
) -> io::Result<()> {
    let mut end = length.min(file.metadata()?.len());
    // 跨块的那半行，按读到的先后存成几块，找到它的开头时才拼起来，不反复拷贝
    // The half line spanning blocks, kept as pieces in the order read and joined only once its start is found, so
    // nothing is copied over and over
    let mut pieces: Vec<Vec<u8>> = Vec::new();
    while end > 0 {
        let start = end.saturating_sub(TAIL_BLOCK);
        let size = usize::try_from(end - start).map_err(io::Error::other)?;
        let mut block = vec![0; size];
        file.read_exact_at(&mut block, start)?;
        let first_newline = block.iter().position(|byte| *byte == b'\n');
        let complete_from = match (start, first_newline) {
            (0, _) => 0,
            (_, Some(newline)) => newline + 1,
            // 这一块里一个换行也没有：整块都是那半行的一部分，再往前读 / No newline in this block: all of it belongs to the
            // half line, so read further back
            (_, None) => {
                pieces.push(block);
                end = start;
                continue;
            }
        };
        let mut tail = block[complete_from..].to_vec();
        for piece in pieces.drain(..).rev() {
            tail.extend_from_slice(&piece);
        }
        for line in tail.split(|byte| *byte == b'\n').rev() {
            if !line.is_empty() && visit(line).is_break() {
                return Ok(());
            }
        }
        block.truncate(complete_from.saturating_sub(1));
        pieces.push(block);
        end = start;
    }
    Ok(())
}

fn last_record(root: &Path, segment: &Segment) -> io::Result<Option<Map<String, Value>>> {
    let mut last = None;
    for_each_line_rev(root, segment, |line| {
        match serde_json::from_slice::<Value>(line) {
            Ok(Value::Object(record)) => {
                last = Some(record);
                ControlFlow::Break(())
            }
            _ => ControlFlow::Continue(()),
        }
    })?;
    Ok(last)
}

/// 接着往最后那段里写：断电时可能留下半行，先截到最后一个换行
/// Continues the last segment: a power loss can leave half a line, so it is first cut back to the last newline
fn reopen_for_append(path: &Path) -> anyhow::Result<(u64, File)> {
    let file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(path)
        .with_context(|| format!("打开查询日志失败：{}", path.display()))?;
    let mut reader = BufReader::new(&file);
    let mut complete = 0u64;
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .context("读取查询日志失败")?;
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        complete += read as u64;
    }
    drop(reader);
    if file.metadata().context("读取查询日志失败")?.len() != complete {
        file.set_len(complete).context("截断查询日志失败")?;
    }
    Ok((complete, file))
}

fn read_state(root: &Path) -> State {
    fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_state(root: &Path, state: &State) -> io::Result<()> {
    let temporary = root.join(format!("{STATE_FILE}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        serde_json::to_writer(&mut file, state)?;
        file.sync_all()?;
        fs::rename(&temporary, root.join(STATE_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// 一段一段删，删不掉的不挡后面的，最后交回第一个错误 / Removes segment by segment; one that cannot go does not stop the
/// rest, and the first error comes back at the end
fn remove_all(root: &Path, segments: &[Segment]) -> io::Result<()> {
    let mut first_error = None;
    for segment in segments {
        for name in [segment.plain_name(), segment.gz_name()] {
            match fs::remove_file(root.join(name)) {
                Err(error) if error.kind() != ErrorKind::NotFound => {
                    first_error.get_or_insert(error);
                }
                _ => {}
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn prepare_root(root: &Path) -> anyhow::Result<()> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            anyhow::bail!(
                "查询日志路径必须是普通目录，不能是符号链接：{}",
                root.display()
            )
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(root)
                .with_context(|| format!("创建查询日志目录失败：{}", root.display()))?;
        }
        Err(error) => {
            return Err(error).with_context(|| format!("检查查询日志目录失败：{}", root.display()));
        }
    }
    // 查询日志里是谁查了什么：只给面板自己看。改不了权限（比如目录是别人建的）只提醒，不挡启动
    // The query log says who looked up what: for the panel's eyes only. Failing to set that (a directory someone
    // else created, say) is warned about and does not stop start-up
    if let Err(error) = fs::set_permissions(root, fs::Permissions::from_mode(0o700)) {
        tracing::warn!(%error, path = %root.display(), "没能把查询日志目录设成只有面板能读");
    }
    Ok(())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn contains_ascii_ignore_case(haystack: &[u8], needle: &[u8]) -> bool {
    needle.is_empty()
        || haystack
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
mod tests;
