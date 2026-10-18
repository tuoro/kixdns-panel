//! 拦截列表的规则：AdGuard、Adblock 语法和 hosts 文件里 DNS 用得上的那部分，写法照
//! <https://adguard-dns.io/kb/general/dns-filtering-syntax/>。订阅的列表在这里解析，合并成一个内核认识的
//! `GeoSite` JSON 文件，分四个分类：拦截、放行、重要拦截、重要放行。页面上自己写的规则由
//! `web/src/config-model/blocklist.ts` 照同样的规则解析，两边共用 `testdata/blocklist-syntax.json` 里的用例。
//! Blocklist rules: the part of the `AdGuard` and Adblock syntax and of hosts files that DNS can use, as
//! <https://adguard-dns.io/kb/general/dns-filtering-syntax/> describes it. Subscribed lists are parsed here and
//! merged into one `GeoSite` JSON file the kernel reads, with four categories: block, allow, important block and
//! important allow. The page parses one's own rules by the same rules in `web/src/config-model/blocklist.ts`, and
//! both sides are tested on the cases in `testdata/blocklist-syntax.json`.

use std::collections::{BTreeSet, HashSet};
use std::net::IpAddr;

use serde::{Deserialize, Serialize};

/// 合并后的文件里四个分类的名字，和内核里别的 `GeoSite` 分类分开 / The four category names in the merged file,
/// kept apart from every other `GeoSite` category in the kernel
pub const TAG_BLOCK: &str = "kixdns-panel-block";
pub const TAG_ALLOW: &str = "kixdns-panel-allow";
pub const TAG_BLOCK_IMPORTANT: &str = "kixdns-panel-block-important";
pub const TAG_ALLOW_IMPORTANT: &str = "kixdns-panel-allow-important";

/// 一个列表最多记下几行没用上的，给页面举例 / How many unused lines of one list are kept as examples for the page
const SKIPPED_SAMPLES: usize = 20;
/// 举例的一行最多留这么多字 / How much of an example line is kept
const SAMPLE_CHARS: usize = 200;
/// 一个列表最多用这么多条通配符和正则规则：内核对每个没拦下的域名都要比一遍正则，几万条会让每次查询慢到几毫秒。
/// 主流列表最多六七百条；一行一个 `*.域名` 的列表请换成同一列表的 Adblock 格式
/// The most wildcard and regex rules one list may use: the kernel tries the regexes on every name nothing else
/// blocked, and tens of thousands slow each query to milliseconds. Common lists hold six or seven hundred at most; a
/// list written as one `*.name` per line should be swapped for the same list's Adblock format
pub const MAX_PATTERNS_PER_LIST: usize = 1000;

/// hosts 文件里的本机条目：不是拦截规则，读到就略过 / Local entries in hosts files: no blocking rules, passed over
const LOCAL_NAMES: [&str; 12] = [
    "localhost",
    "localhost.localdomain",
    "local",
    "broadcasthost",
    "ip6-localhost",
    "ip6-loopback",
    "ip6-localnet",
    "ip6-mcastprefix",
    "ip6-allnodes",
    "ip6-allrouters",
    "ip6-allhosts",
    "0.0.0.0",
];

/// 认识、但还不支持的修饰符：带它们的规则整条不用 / Modifiers known but not yet supported: rules carrying them go unused whole
const UNSUPPORTED_MODIFIERS: [&str; 6] = [
    "client",
    "ctag",
    "dnstype",
    "dnsrewrite",
    "denyallow",
    "respgeo",
];

/// 只管网页里的请求（第三方、脚本、图片……）的修饰符：DNS 查询里没有这些信息，带它们的规则整条不用。和页面同一份名单
/// Modifiers about requests inside web pages (third-party, scripts, images…): a DNS query carries none of that, so
/// rules with them go unused whole. The same list as the page's
const BROWSER_MODIFIERS: [&str; 26] = [
    "third-party",
    "3p",
    "first-party",
    "1p",
    "script",
    "image",
    "stylesheet",
    "css",
    "media",
    "font",
    "object",
    "xmlhttprequest",
    "xhr",
    "subdocument",
    "frame",
    "document",
    "doc",
    "popup",
    "websocket",
    "ping",
    "other",
    "domain",
    "match-case",
    "redirect",
    "removeparam",
    "csp",
];

/// 一条规则管哪些域名 / Which names one rule covers
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Match {
    /// 域名本身和所有子域名 / The name itself and every subdomain
    Suffix(String),
    /// 只有域名本身 / The name itself only
    Exact(String),
    /// 按正则匹配整个域名（内核的正则写法） / The whole name matched by a regex (the kernel's regex syntax)
    Regex(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub allow: bool,
    /// 带 `$important`：拦截时普通的放行管不了它，放行时连重要拦截也放 / Carries `$important`: as a block, plain
    /// allows cannot lift it; as an allow, it lifts important blocks too
    pub important: bool,
    pub matcher: Match,
}

/// 一行没用上的原因 / Why a line went unused
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", content = "modifier", rename_all = "kebab-case")]
pub enum Skip {
    /// 元素隐藏这类只对浏览器有用的规则 / A rule for browsers only, such as element hiding
    Cosmetic,
    /// hosts 里写的不是拦截用的地址：那是要回答这个地址，用域名映射 / A hosts line with an address other than a
    /// blocking one: it means answering that address, which is what mappings are for
    HostsAddress,
    /// 认识、但还不支持的修饰符 / A modifier known but not yet supported
    UnsupportedModifier(String),
    /// 只对浏览器有用的修饰符 / A modifier for browsers only
    BrowserModifier(String),
    /// 不认识的修饰符：照 `AdGuard` 的说明整条不用 / A modifier not known at all: the rule is ignored whole, as `AdGuard`
    /// specifies
    UnknownModifier(String),
    /// 内核的正则不支持这种写法（前后断言、反向引用等） / A regex the kernel's syntax does not support (lookaround,
    /// backreferences and the like)
    BadRegex,
    /// 这个列表的通配符和正则规则已经用满 [`MAX_PATTERNS_PER_LIST`] 条 / The list has used up its
    /// [`MAX_PATTERNS_PER_LIST`] wildcard and regex rules
    TooManyPatterns,
    /// 带网址路径（`||example.com/ads.js`）：只对浏览器有用，DNS 查询里没有路径 / A rule with a URL path
    /// (`||example.com/ads.js`): only browsers can use it, since a DNS query carries no path
    UrlPath,
    /// 看不懂这一行 / A line that cannot be read
    Unreadable,
}

/// 一行读出来是什么 / What one line turns out to be
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// 注释、空行、hosts 的本机条目：不算规则 / A comment, a blank, a local hosts entry: no rule
    Ignored,
    /// hosts 的一行可以写几个域名，所以是几条 / A hosts line may name several hosts, hence several rules
    Rules(Vec<Rule>),
    /// `$badfilter`：停用写法完全相同的那条规则，这里是那条规则的写法 / `$badfilter`: disables the rule written exactly
    /// so, given here as that rule's text
    Badfilter(String),
    Skipped(Skip),
}

/// 读一行规则 / Reads one line
#[must_use]
pub fn parse_line(raw: &str) -> Line {
    let line = raw.trim();
    if line.is_empty() || line.starts_with(['!', '#', '[']) {
        return Line::Ignored;
    }
    if let Some(hosts) = parse_hosts(line) {
        return hosts;
    }
    if ["##", "#@#", "#?#", "#$#", "#%#", "$$"]
        .iter()
        .any(|mark| line.contains(mark))
    {
        return Line::Skipped(Skip::Cosmetic);
    }
    let (allow, body) = match line.strip_prefix("@@") {
        Some(rest) => (true, rest),
        None => (false, line),
    };
    let Some((pattern, modifiers)) = split_modifiers(body) else {
        return Line::Skipped(Skip::Unreadable);
    };

    let mut important = false;
    let mut badfilter = false;
    let mut kept = Vec::new();
    for modifier in modifiers.iter().map(|m| m.trim()) {
        let name = modifier
            .trim_start_matches('~')
            .split('=')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match name.as_str() {
            "important" => important = true,
            "badfilter" => {
                badfilter = true;
                continue;
            }
            "" => return Line::Skipped(Skip::Unreadable),
            _ if UNSUPPORTED_MODIFIERS.contains(&name.as_str()) => {
                return Line::Skipped(Skip::UnsupportedModifier(name));
            }
            _ if BROWSER_MODIFIERS.contains(&name.as_str()) => {
                return Line::Skipped(Skip::BrowserModifier(name));
            }
            _ => return Line::Skipped(Skip::UnknownModifier(name)),
        }
        kept.push(modifier);
    }
    if badfilter {
        let rest = if kept.is_empty() {
            String::new()
        } else {
            format!("${}", kept.join(","))
        };
        return Line::Badfilter(format!("{}{pattern}{rest}", if allow { "@@" } else { "" }));
    }

    match parse_pattern(pattern) {
        Ok(matcher) => Line::Rules(vec![Rule {
            allow,
            important,
            matcher,
        }]),
        Err(skip) => Line::Skipped(skip),
    }
}

/// hosts 文件的一行（「地址 域名…」）；不是这种写法时为 None / A hosts-file line (「address name…」); None when the line
/// is not written so
fn parse_hosts(line: &str) -> Option<Line> {
    let mut tokens = line.split_whitespace();
    let address = tokens.next()?;
    // 带网卡的 IPv6（fe80::1%lo0）：网卡不算地址 / An IPv6 address with a zone (fe80::1%lo0): the zone is no part of it
    let address: IpAddr = address.split('%').next()?.parse().ok()?;
    let names: Vec<&str> = tokens
        .take_while(|token| !token.starts_with('#'))
        .filter(|name| {
            !LOCAL_NAMES
                .iter()
                .any(|local| local.eq_ignore_ascii_case(name))
        })
        .collect();
    if names.is_empty() {
        return Some(Line::Ignored);
    }
    // 0.0.0.0、:: 和本机地址就是拦截；别的地址是要回答它 / 0.0.0.0, :: and loopback addresses block; any other
    // address means answering it
    if !(address.is_unspecified() || address.is_loopback()) {
        return Some(Line::Skipped(Skip::HostsAddress));
    }
    let mut rules = Vec::with_capacity(names.len());
    for name in names {
        let Some(name) = normalize_domain(name) else {
            return Some(Line::Skipped(Skip::Unreadable));
        };
        rules.push(Rule {
            allow: false,
            important: false,
            matcher: Match::Exact(name),
        });
    }
    Some(Line::Rules(rules))
}

/// 把规则和修饰符分开。正则（`/…/`）自己可能带 `$`，所以修饰符只认最后一个 `/` 后面的；看不懂时为 None
/// Splits a rule from its modifiers. A regex (`/…/`) may hold a `$` of its own, so its modifiers are only what follows
/// its last `/`; None when the line cannot be read
fn split_modifiers(body: &str) -> Option<(&str, Vec<&str>)> {
    let (pattern, modifiers) = if body.starts_with('/') {
        let end = body.rfind('/').filter(|&at| at > 0)?;
        let tail = &body[end + 1..];
        let modifiers = if tail.is_empty() {
            None
        } else {
            Some(tail.strip_prefix('$')?)
        };
        (&body[..=end], modifiers)
    } else {
        match body.rfind('$') {
            Some(at) => (&body[..at], Some(&body[at + 1..])),
            None => (body, None),
        }
    };
    Some((
        pattern,
        modifiers
            .map(|m| m.split(',').collect())
            .unwrap_or_default(),
    ))
}

/// 规则本身（去掉 `@@` 和修饰符以后）管哪些域名 / Which names the rule itself covers (once `@@` and modifiers are off)
fn parse_pattern(pattern: &str) -> Result<Match, Skip> {
    if let Some(regex) = pattern.strip_prefix('/').and_then(|p| p.strip_suffix('/')) {
        if regex.is_empty() {
            return Err(Skip::Unreadable);
        }
        // 内核按 Rust 的正则读：前后断言、反向引用这些写法它不认 / The kernel reads Rust regex syntax, which has no
        // lookaround or backreferences
        return match regex_syntax::Parser::new().parse(regex) {
            Ok(_) => Ok(Match::Regex(ignoring_case(regex))),
            Err(_) => Err(Skip::BadRegex),
        };
    }
    let mut lower = pattern.to_lowercase();
    // AdGuard 拿「http://域名」去匹配 DNS 查询，所以开头的 `://` 和 `|` 一样是域名的开头
    // AdGuard matches a DNS query as 「http://name」, so a leading `://` marks the start of the name as `|` does
    if let Some(rest) = lower.strip_prefix("://") {
        lower = format!("|{rest}");
    }
    if let Some(name) = lower
        .strip_prefix("||")
        .and_then(|p| p.strip_suffix("^|").or_else(|| p.strip_suffix('^')))
        && let Some(name) = normalize_domain(name)
    {
        return Ok(Match::Suffix(name));
    }
    if let Some(name) = lower
        .strip_prefix('|')
        .filter(|p| !p.starts_with('|'))
        .and_then(|p| {
            p.strip_suffix("^|")
                .or_else(|| p.strip_suffix('^'))
                .or_else(|| p.strip_suffix('|'))
        })
        && let Some(name) = normalize_domain(name)
    {
        return Ok(Match::Exact(name));
    }
    if let Some(name) = normalize_domain(&lower) {
        return Ok(Match::Exact(name));
    }
    pattern_regex(&lower)
        .map(Match::Regex)
        .ok_or(if lower.contains('/') {
            Skip::UrlPath
        } else {
            Skip::Unreadable
        })
}

/// `AdGuard` 的规则不分大小写，内核拿小写的域名去比：写了大写字母（转义里的不算）的正则加上 `(?i)`，不然永远匹配
/// 不上
/// `AdGuard` rules ignore case and the kernel compares lower-cased names, so a regex with a capital letter (outside
/// escapes) gets `(?i)`, or it would never match
fn ignoring_case(regex: &str) -> String {
    let mut escaped = false;
    let capital = regex.chars().any(|c| {
        let capital = !escaped && c.is_ascii_uppercase();
        escaped = !escaped && c == '\\';
        capital
    });
    if capital {
        format!("(?i){regex}")
    } else {
        regex.to_owned()
    }
}

/// 带通配符或锚点的写法换成整个域名上的正则：`||` 是某一级域名的开头，`|` 是开头，结尾的 `^` 或 `|` 是结尾，`*` 是任意字符。
/// 域名里不会有分隔符，所以中间的 `^`、`|` 什么都匹配不上，算看不懂
/// A pattern with wildcards or anchors as a regex over the whole name: `||` starts at a label, `|` at the start, a
/// trailing `^` or `|` is the end, and `*` is any run of characters. Names hold no separators, so a `^` or `|` in the
/// middle could never match and counts as unreadable
fn pattern_regex(pattern: &str) -> Option<String> {
    let (start, rest) = if let Some(rest) = pattern.strip_prefix("||") {
        (r"^(?:.*\.)?", rest)
    } else if let Some(rest) = pattern.strip_prefix('|') {
        ("^", rest)
    } else {
        ("", pattern)
    };
    let (body, end) = match rest
        .strip_suffix("^|")
        .or_else(|| rest.strip_suffix('^'))
        .or_else(|| rest.strip_suffix('|'))
    {
        Some(body) => (body, "$"),
        None => (rest, ""),
    };
    if !body.chars().any(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    // 锚定的开头是点、或者中间空着一级（`||.example^`、`ads..example`），永远匹配不上 / A dot at an anchored start, or an
    // empty label inside (`||.example^`, `ads..example`), could never match
    if body.contains("..") || (!start.is_empty() && body.starts_with('.')) {
        return None;
    }
    let mut regex = String::with_capacity(start.len() + body.len() * 2 + end.len());
    regex.push_str(start);
    for c in body.chars() {
        match c {
            '*' => regex.push_str(".*"),
            '.' => regex.push_str(r"\."),
            'a'..='z' | '0'..='9' | '-' | '_' => regex.push(c),
            _ => return None,
        }
    }
    regex.push_str(end);
    Some(regex)
}

/// 规整成内核比较用的写法：小写、去掉末尾的点、中文等域名换成 punycode；不像域名时为 None
/// The form the kernel compares: lower case, no trailing dot, non-ASCII names in punycode; None when it is no name
fn normalize_domain(name: &str) -> Option<String> {
    let name = name.strip_suffix('.').unwrap_or(name);
    let name = if name.is_ascii() {
        name.to_ascii_lowercase()
    } else {
        idna::domain_to_ascii(name).ok()?
    };
    let valid_label = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    (name.len() <= 253 && name.split('.').all(valid_label)).then_some(name)
}

/// 一个列表的各行；文件开头的 BOM 不算进第一行 / A list's lines; a byte order mark at the start is not part of the first line
fn lines(text: &str) -> std::str::Lines<'_> {
    text.strip_prefix('\u{feff}').unwrap_or(text).lines()
}

/// 一个列表里所有 `$badfilter` 停用的规则写法：合并时它们在每个列表里都不算 / Every rule text a list's `$badfilter`
/// lines disable: when merging they count in no list
#[must_use]
pub fn badfilters(text: &str) -> HashSet<String> {
    lines(text)
        .filter_map(|line| match parse_line(line) {
            Line::Badfilter(rule) => Some(rule),
            _ => None,
        })
        .collect()
}

/// 一个列表读下来的情况 / How one list read
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListSummary {
    /// 用上的规则条数（hosts 的一行写几个域名就算几条） / Rules in use (a hosts line naming several hosts counts each)
    pub rules: usize,
    /// 没用上的行数 / Lines left unused
    pub skipped: usize,
    /// 没用上的前几行，给页面举例 / The first few unused lines, as examples for the page
    pub samples: Vec<SkippedLine>,
    /// 列表开头注释里写的标题（`! Title: …`、`# Title: …`）：自己粘贴的列表用它起名 / The title in the list's opening
    /// comments (`! Title: …`, `# Title: …`), which names a pasted list
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// 标题只在前这么多行里找，最长这么多字 / A title is looked for only in these first lines, and kept to this many characters
const TITLE_LINES: usize = 50;
const TITLE_CHARS: usize = 80;

/// 注释行里的标题；不是 `Title:` 这一行时为 None / The title on a comment line; None unless the line is `Title:`
fn header_title(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix(['!', '#'])?.trim_start();
    let (key, value) = rest.split_once(':')?;
    if !key.trim_end().eq_ignore_ascii_case("title") {
        return None;
    }
    let title: String = value.trim().chars().take(TITLE_CHARS).collect();
    (!title.is_empty()).then_some(title)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedLine {
    /// 第几行，从 1 数 / The line number, counted from 1
    pub line: usize,
    pub text: String,
    #[serde(flatten)]
    pub skip: Skip,
}

/// 只看一个列表读得怎么样，不留规则：下载以后用它检查列表能不能用 / How one list reads, keeping no rules: used to check a
/// list right after downloading it
#[must_use]
pub fn summarize(text: &str) -> ListSummary {
    scan(text, &HashSet::new(), |_| {})
}

/// 逐行读一个列表，用上的规则交给 `on_rule`；通配符和正则规则只用前 [`MAX_PATTERNS_PER_LIST`] 条
/// Reads a list line by line, handing each rule in use to `on_rule`; only the first [`MAX_PATTERNS_PER_LIST`]
/// wildcard and regex rules are used
fn scan(text: &str, badfilters: &HashSet<String>, mut on_rule: impl FnMut(Rule)) -> ListSummary {
    let mut summary = ListSummary::default();
    let mut patterns = 0;
    for (index, raw) in lines(text).enumerate() {
        if index < TITLE_LINES && summary.title.is_none() {
            summary.title = header_title(raw);
        }
        if badfilters.contains(raw.trim()) {
            continue;
        }
        let line = match parse_line(raw) {
            Line::Rules(rules) => {
                let added = rules
                    .iter()
                    .filter(|rule| matches!(rule.matcher, Match::Regex(_)))
                    .count();
                if added > 0 && patterns + added > MAX_PATTERNS_PER_LIST {
                    Line::Skipped(Skip::TooManyPatterns)
                } else {
                    patterns += added;
                    Line::Rules(rules)
                }
            }
            line => line,
        };
        match line {
            Line::Ignored | Line::Badfilter(_) => {}
            Line::Rules(rules) => {
                summary.rules += rules.len();
                rules.into_iter().for_each(&mut on_rule);
            }
            Line::Skipped(skip) => {
                summary.skipped += 1;
                if summary.samples.len() < SKIPPED_SAMPLES {
                    summary.samples.push(SkippedLine {
                        line: index + 1,
                        text: raw.trim().chars().take(SAMPLE_CHARS).collect(),
                        skip,
                    });
                }
            }
        }
    }
    summary
}

/// 合并文件由哪个列表的哪一份合成：写在文件里，定时更新据此知道正在用的是哪些列表
/// Which copy of which list a merged file was built from: written into the file, so the scheduled update knows
/// which lists are in use
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub url: String,
    pub sha256: String,
}

/// 读出合并文件里记的来源；不是合并文件、或者读不懂时为 None / Reads the sources a merged file records; None when the
/// bytes are no merged file or cannot be read
#[must_use]
pub fn read_sources(json: &[u8]) -> Option<Vec<SourceRef>> {
    #[derive(Deserialize)]
    struct Panel {
        sources: Vec<SourceRef>,
    }
    #[derive(Deserialize)]
    struct File {
        kixdns_panel: Panel,
    }
    serde_json::from_slice::<File>(json)
        .ok()
        .map(|file| file.kixdns_panel.sources)
}

/// 合并的四个分类，每个分类里的条目已经写成内核的 `GeoSite` 写法（`domain:`、`full:`、`regexp:`），排好序、不重复
/// The four merged categories, their entries already in the kernel's `GeoSite` form (`domain:`, `full:`, `regexp:`),
/// sorted and without repeats
#[derive(Debug, Clone, Default)]
pub struct Merged {
    block: BTreeSet<String>,
    allow: BTreeSet<String>,
    block_important: BTreeSet<String>,
    allow_important: BTreeSet<String>,
}

impl Merged {
    /// 加进一个列表的内容；写法和 `badfilters` 里某条一模一样的规则不算 / Adds one list's content; rules written exactly
    /// like one in `badfilters` do not count
    pub fn add(&mut self, text: &str, badfilters: &HashSet<String>) -> ListSummary {
        scan(text, badfilters, |rule| self.insert(rule))
    }

    fn insert(&mut self, rule: Rule) {
        let entry = match rule.matcher {
            Match::Suffix(name) => format!("domain:{name}"),
            Match::Exact(name) => format!("full:{name}"),
            Match::Regex(regex) => format!("regexp:{regex}"),
        };
        let set = match (rule.allow, rule.important) {
            (false, false) => &mut self.block,
            (true, false) => &mut self.allow,
            (false, true) => &mut self.block_important,
            (true, true) => &mut self.allow_important,
        };
        set.insert(entry);
    }

    /// 合并后一条拦截也没有 / Nothing to block after merging
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.block.is_empty() && self.block_important.is_empty()
    }

    /// 内核读的 `GeoSite` JSON：同样的内容总是同样的字节，按内容命名的文件因此不会白换
    /// The `GeoSite` JSON the kernel reads: the same content always gives the same bytes, so a file named by its
    /// content is never replaced for nothing
    ///
    /// # Panics
    ///
    /// 不会：字符串写成 JSON 不会失败 / Never: writing strings as JSON cannot fail
    #[must_use]
    pub fn geosite_json(&self, sources: &[SourceRef]) -> String {
        #[derive(Serialize)]
        struct Entry<'a> {
            tag: &'a str,
            domains: &'a BTreeSet<String>,
        }
        #[derive(Serialize)]
        struct Panel<'a> {
            sources: &'a [SourceRef],
        }
        // 内核只读 entries，多出来的 kixdns_panel 它不管 / The kernel reads entries only and passes over kixdns_panel
        #[derive(Serialize)]
        struct File<'a> {
            entries: Vec<Entry<'a>>,
            kixdns_panel: Panel<'a>,
        }
        let entries = [
            (TAG_BLOCK, &self.block),
            (TAG_ALLOW, &self.allow),
            (TAG_BLOCK_IMPORTANT, &self.block_important),
            (TAG_ALLOW_IMPORTANT, &self.allow_important),
        ]
        .into_iter()
        .filter(|(_, domains)| !domains.is_empty())
        .map(|(tag, domains)| Entry { tag, domains })
        .collect();
        serde_json::to_string(&File {
            entries,
            kixdns_panel: Panel { sources },
        })
        .expect("serializing strings cannot fail")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Cases {
        lines: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct Case {
        line: String,
        rules: Option<Vec<ExpectedRule>>,
        skip: Option<String>,
        modifier: Option<String>,
        badfilter: Option<String>,
    }

    #[derive(Deserialize, PartialEq, Debug)]
    struct ExpectedRule {
        allow: bool,
        important: bool,
        #[serde(rename = "match")]
        kind: String,
        value: String,
    }

    fn expected(rule: &Rule) -> ExpectedRule {
        let (kind, value) = match &rule.matcher {
            Match::Suffix(name) => ("suffix", name),
            Match::Exact(name) => ("exact", name),
            Match::Regex(regex) => ("regex", regex),
        };
        ExpectedRule {
            allow: rule.allow,
            important: rule.important,
            kind: kind.to_owned(),
            value: value.clone(),
        }
    }

    fn skip_code(skip: &Skip) -> (&'static str, Option<&str>) {
        match skip {
            Skip::Cosmetic => ("cosmetic", None),
            Skip::HostsAddress => ("hosts-address", None),
            Skip::UnsupportedModifier(name) => ("unsupported-modifier", Some(name)),
            Skip::BrowserModifier(name) => ("browser-modifier", Some(name)),
            Skip::UnknownModifier(name) => ("unknown-modifier", Some(name)),
            Skip::BadRegex => ("bad-regex", None),
            Skip::TooManyPatterns => ("too-many-patterns", None),
            Skip::UrlPath => ("url-path", None),
            Skip::Unreadable => ("unreadable", None),
        }
    }

    /// 和页面共用的用例：每一行读出来的规则、跳过的原因、停用的规则都要对上
    /// The cases shared with the page: each line's rules, skip reason and disabled rule must match
    #[test]
    fn every_shared_case_reads_as_expected() {
        let cases: Cases =
            serde_json::from_str(include_str!("../../../testdata/blocklist-syntax.json")).unwrap();
        assert!(cases.lines.len() > 40);
        for case in &cases.lines {
            let got = parse_line(&case.line);
            match (&case.rules, &case.skip, &case.badfilter) {
                (Some(rules), None, None) => {
                    let got_rules = match &got {
                        Line::Rules(rules) => rules.iter().map(expected).collect(),
                        Line::Ignored => Vec::new(),
                        other => panic!("{:?}: expected rules, got {other:?}", case.line),
                    };
                    assert_eq!(&got_rules, rules, "{:?}", case.line);
                }
                (None, Some(skip), None) => {
                    let Line::Skipped(got_skip) = &got else {
                        panic!("{:?}: expected a skip, got {got:?}", case.line)
                    };
                    assert_eq!(
                        skip_code(got_skip),
                        (skip.as_str(), case.modifier.as_deref()),
                        "{:?}",
                        case.line
                    );
                }
                (None, None, Some(rule)) => {
                    assert_eq!(got, Line::Badfilter(rule.clone()), "{:?}", case.line);
                }
                _ => panic!(
                    "{:?}: a case needs exactly one of rules, skip or badfilter",
                    case.line
                ),
            }
        }
    }

    /// 文件开头的 BOM 不挡第一行 / A byte order mark does not hide the first line
    #[test]
    fn a_byte_order_mark_does_not_hide_the_first_line() {
        let summary = summarize("\u{feff}||ads.example^\n||more.example^$badfilter\n");
        assert_eq!((summary.rules, summary.skipped), (1, 0));
        assert_eq!(
            badfilters("\u{feff}||ads.example^$badfilter"),
            HashSet::from(["||ads.example^".to_owned()])
        );
    }

    /// 一个列表里的 `$badfilter` 停用另一个列表里写法相同的规则 / A list's `$badfilter` disables the same rule in another list
    #[test]
    fn a_badfilter_in_one_list_disables_the_rule_in_another() {
        let first = "||ads.example^\n||keep.example^\n";
        let second = "||ads.example^$badfilter\n";
        let disabled: HashSet<String> = [first, second]
            .iter()
            .flat_map(|text| badfilters(text))
            .collect();
        let mut merged = Merged::default();
        assert_eq!(merged.add(first, &disabled).rules, 1);
        assert_eq!(merged.add(second, &disabled).rules, 0);
        assert_eq!(
            merged.geosite_json(&[]),
            r#"{"entries":[{"tag":"kixdns-panel-block","domains":["domain:keep.example"]}],"kixdns_panel":{"sources":[]}}"#
        );
    }

    /// 几个列表合在一起，同一个域名只留一份，四个分类各归各 / Merged lists keep one copy per entry, each in its own category
    #[test]
    fn merging_keeps_one_copy_per_entry_in_its_category() {
        let none = HashSet::new();
        let mut merged = Merged::default();
        merged.add(
            "||b.example^\n||a.example^\n@@||ok.example^\n0.0.0.0 host.example\n",
            &none,
        );
        merged.add(
            "||a.example^\n||imp.example^$important\n@@||vip.example^$important\n/^ads\\./\n",
            &none,
        );
        let sources = [SourceRef {
            url: "https://lists.example/a.txt".to_owned(),
            sha256: "ab".repeat(32),
        }];
        let json = merged.geosite_json(&sources);
        assert_eq!(read_sources(json.as_bytes()), Some(sources.to_vec()));
        assert_eq!(read_sources(br#"{"entries":[]}"#), None);
        assert_eq!(
            json,
            concat!(
                r#"{"entries":["#,
                r#"{"tag":"kixdns-panel-block","domains":["domain:a.example","domain:b.example","full:host.example","regexp:^ads\\."]},"#,
                r#"{"tag":"kixdns-panel-allow","domains":["domain:ok.example"]},"#,
                r#"{"tag":"kixdns-panel-block-important","domains":["domain:imp.example"]},"#,
                r#"{"tag":"kixdns-panel-allow-important","domains":["domain:vip.example"]}"#,
                r#"],"kixdns_panel":{"sources":[{"url":"https://lists.example/a.txt","sha256":""#,
                "abababababababababababababababababababababababababababababababab",
                r#""}]}}"#
            )
        );
        assert!(!merged.is_empty());
        assert!(Merged::default().is_empty());
    }

    /// 一个列表的通配符和正则规则只用前 1000 条，多的记成没用上；举例的行截短
    /// A list uses only its first 1000 wildcard and regex rules, the rest counted as unused; example lines are cut short
    #[test]
    fn a_list_uses_a_limited_number_of_patterns() {
        let text: String = (0..=MAX_PATTERNS_PER_LIST)
            .map(|i| format!("||ad{i}*.example^\n"))
            .chain([
                "||plain.example^\n".to_owned(),
                format!("||{}^$client=1.2.3.4\n", "a".repeat(300)),
            ])
            .collect();
        let summary = summarize(&text);
        assert_eq!(
            (summary.rules, summary.skipped),
            (MAX_PATTERNS_PER_LIST + 1, 2)
        );
        assert_eq!(summary.samples[0].skip, Skip::TooManyPatterns);
        assert_eq!(summary.samples[0].line, MAX_PATTERNS_PER_LIST + 1);
        assert_eq!(summary.samples[1].text.chars().count(), SAMPLE_CHARS);
        assert_eq!(
            serde_json::to_value(Skip::TooManyPatterns).unwrap(),
            serde_json::json!({ "reason": "too-many-patterns" })
        );
    }

    /// 没用上的行计数，只留前 20 行作例子，行号从 1 数 / Unused lines are counted, the first 20 kept as examples, numbered from 1
    #[test]
    fn unused_lines_are_counted_and_the_first_few_kept() {
        let text: String = std::iter::once("! header\n".to_owned())
            .chain((0..30).map(|i| format!("||x{i}.example^$client=10.0.0.{i}\n")))
            .chain(std::iter::once("||kept.example^\n".to_owned()))
            .collect();
        let summary = summarize(&text);
        assert_eq!(summary, Merged::default().add(&text, &HashSet::new()));
        assert_eq!(
            (summary.rules, summary.skipped, summary.samples.len()),
            (1, 30, SKIPPED_SAMPLES)
        );
        assert_eq!(summary.samples[0].line, 2);
        assert_eq!(
            summary.samples[0].skip,
            Skip::UnsupportedModifier("client".to_owned())
        );
        assert_eq!(
            serde_json::to_value(&summary.samples[0]).unwrap(),
            serde_json::json!({ "line": 2, "text": "||x0.example^$client=10.0.0.0", "reason": "unsupported-modifier", "modifier": "client" })
        );
    }

    #[test]
    fn a_title_in_the_opening_comments_names_the_list() {
        let adblock = "[Adblock Plus]\n! Title: HaGeZi's Pro DNS Blocklist\n! Expires: 1 day\n||ads.example^\n";
        assert_eq!(
            summarize(adblock).title.as_deref(),
            Some("HaGeZi's Pro DNS Blocklist")
        );
        let hosts = "# Title: StevenBlack/hosts\n#\n0.0.0.0 ads.example\n";
        assert_eq!(summarize(hosts).title.as_deref(), Some("StevenBlack/hosts"));
        // 没有标题、标题空着、或者很靠后的不算 / No title, an empty one, or one far down does not count
        assert_eq!(summarize("||ads.example^\n").title, None);
        assert_eq!(summarize("! Title:\n||ads.example^\n").title, None);
        let late = format!("{}! Title: Late\n", "||ads.example^\n".repeat(TITLE_LINES));
        assert_eq!(summarize(&late).title, None);
        // 记录里没有标题时不写这一项，旧记录照样读得进来 / With no title the field is left out, and old records still read
        let summary: ListSummary =
            serde_json::from_value(serde_json::json!({ "rules": 1, "skipped": 0, "samples": [] }))
                .unwrap();
        assert_eq!(summary.title, None);
        assert!(
            serde_json::to_value(&summary)
                .unwrap()
                .get("title")
                .is_none()
        );
    }
}
