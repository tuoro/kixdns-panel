//! 内核编好的查询记录（`querylog_records_v1`）：内核在请求结束时就把一条记录编成一小段字节，交给面板时原样交出，
//! 面板在这里读出要看的几项，再写成和内核一样的一行 JSON 存下。内核答 DNS 的线程上不再为面板写文字；面板也不必
//! 再从 JSON 里把编号、域名这些找出来。编法见 `docs/control-protocol-v1.md`；和内核写的 JSON 逐字节一样，由内核
//! 生成的样本保证（见测试）
//!
//! The kernel's encoded query records (`querylog_records_v1`): the kernel encodes a record into a few
//! bytes when its request ends and hands them over as they are; the panel reads the items it looks at here
//! and writes the same line of JSON the kernel would, which it stores. The kernel's DNS threads no longer
//! write text for the panel, and the panel no longer finds the number and domain inside JSON. The encoding
//! is in `docs/control-protocol-v1.md`; that the JSON equals the kernel's byte for byte is held by a
//! sample the kernel generates (see the tests)

use std::borrow::Cow;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::ops::Range;

/// 二进制的一页开头的几个字节：名字和版本 / The leading bytes of a binary page: a name and the version
pub const MAGIC: &[u8; 5] = b"KXQL\x01";

/// 二进制的一页：页头那几项，和每条记录在原文里的位置 / A binary page: its head items and where each record
/// sits in the body
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordsPage {
    pub protocol_version: u8,
    pub instance: u64,
    pub newest_seq: u64,
    pub missed: u64,
    pub untracked: u64,
    pub more: bool,
    /// 第一条的序号，往后一条一个 / The first record's number, one more for each after it
    pub first: u64,
    pub records: Vec<Range<usize>>,
}

impl RecordsPage {
    /// 读二进制的一页（[`MAGIC`] 开头）；读不通时为 None / Reads a binary page (starting with [`MAGIC`]); None
    /// when it does not read
    #[must_use]
    pub fn read(body: &[u8]) -> Option<Self> {
        Self::parse(body).ok()
    }

    fn parse(body: &[u8]) -> Read<Self> {
        let mut input = Decoder(body.strip_prefix(MAGIC).ok_or(Unreadable)?);
        let protocol_version = u8::try_from(input.number()?).map_err(|_| Unreadable)?;
        let instance = input.number()?;
        let _capacity = input.number()?;
        let newest_seq = input.number()?;
        let missed = input.number()?;
        let untracked = input.number()?;
        let more = match input.byte()? {
            0 => false,
            1 => true,
            _ => return Err(Unreadable),
        };
        let first = input.number()?;
        let count = input.length()?;
        let mut records = Vec::with_capacity(count.min(body.len()));
        for _ in 0..count {
            let len = input.length()?;
            let start = body.len() - input.0.len();
            input.take(len)?;
            records.push(start..start + len);
        }
        if !input.0.is_empty() {
            return Err(Unreadable);
        }
        Ok(Self {
            protocol_version,
            instance,
            newest_seq,
            missed,
            untracked,
            more,
            first,
            records,
        })
    }
}

/// 写一条记录时顺带读出的几项：时刻、域名、结果、响应码 / The items read while writing a record: time, domain,
/// outcome and response code
#[derive(Debug, PartialEq, Eq)]
pub struct Summary<'a> {
    pub time_unix_ms: u64,
    pub qname: &'a str,
    pub outcome: &'static str,
    pub rcode: Option<Cow<'static, str>>,
}

/// 把编好的一条记录写成一行 JSON（接在 `json` 后面），和内核写的一字不差，交回读出的几项。读不通时交回 None，
/// `json` 里可能已经写了一半
/// Writes an encoded record as one line of JSON (appended to `json`), exactly as the kernel writes it,
/// and returns the items read. None when it does not read, with `json` perhaps half written
pub fn write_record<'a>(seq: u64, record: &'a [u8], json: &mut Vec<u8>) -> Option<Summary<'a>> {
    write_fields(seq, record, json).ok()
}

fn write_fields<'a>(seq: u64, record: &'a [u8], json: &mut Vec<u8>) -> Read<Summary<'a>> {
    let mut input = Decoder(record);
    let mut json = Json(json);
    json.raw("{\"seq\":");
    json.number(seq);
    json.key("time_unix_ms");
    let time_unix_ms = input.number()?;
    json.number(time_unix_ms);
    json.key("client");
    json.address(input.address()?);
    if let Some(transport) = input.optional_label(&CLIENT_TRANSPORTS)? {
        json.key("transport");
        json.label(transport);
    }
    json.key("qname");
    let qname = input.text()?;
    json.text(qname);
    json.key("qtype");
    json.text(input.text()?);
    json.key("latency_us");
    json.number(input.number()?);
    json.key("status");
    json.label(input.label(&STATUSES)?);
    json.key("outcome");
    let outcome = input.label(&OUTCOMES)?;
    json.label(outcome);
    let rcode = input.rcode()?;
    if let Some(rcode) = &rcode {
        json.key("rcode");
        json.label(rcode);
    }
    json.key("answers");
    json.raw("[");
    for index in 0..input.number()? {
        if index > 0 {
            json.raw(",");
        }
        match input.byte()? {
            ANSWER_V4 => json.ipv4(Ipv4Addr::from(input.octets::<4>()?)),
            ANSWER_V6 => json.address(IpAddr::V6(Ipv6Addr::from(input.octets::<16>()?))),
            ANSWER_TEXT => json.text(input.text()?),
            _ => return Err(Unreadable),
        }
    }
    json.raw("]");
    for key in ["error", "pipeline", "rule", "upstream"] {
        if let Some(text) = input.optional_text()? {
            json.key(key);
            json.text(text);
        }
    }
    json.key("steps");
    json.raw("[");
    for index in 0..input.number()? {
        if index > 0 {
            json.raw(",");
        }
        write_step(&mut input, &mut json)?;
    }
    json.raw("]");
    if input.byte()? != 0 {
        json.key("steps_truncated");
        json.raw("true");
    }
    json.raw("}");
    if !input.0.is_empty() {
        return Err(Unreadable);
    }
    Ok(Summary {
        time_unix_ms,
        qname,
        outcome,
        rcode,
    })
}

const STEP_PIPELINE: u8 = 0;
const STEP_RULE: u8 = 1;
const STEP_DECISION: u8 = 2;
const STEP_CACHE: u8 = 3;
const STEP_JOINED: u8 = 4;
const STEP_UPSTREAM: u8 = 5;
const STEP_UPSTREAM_SKIPPED: u8 = 6;
const ANSWER_TEXT: u8 = 0;
const ANSWER_V4: u8 = 4;
const ANSWER_V6: u8 = 6;

/// 各个枚举的标签，下标就是它在记录里的那个字节 / The labels of each enum, indexed by its byte in a record
const CLIENT_TRANSPORTS: [&str; 3] = ["udp", "tcp", "doh"];
const STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];
const OUTCOMES: [&str; 7] = [
    "forwarded",
    "cached",
    "stale",
    "joined",
    "static",
    "failed",
    "cancelled",
];
const PHASES: [&str; 2] = ["request", "response"];
const DECISIONS: [&str; 4] = ["static", "forward", "jump", "continue"];
const CACHE_RESULTS: [&str; 4] = ["fresh", "stale", "stale_timeout", "stale_failure"];
const TRANSPORTS: [&str; 6] = ["udp", "tcp", "tcp_udp", "doh", "dot", "doq"];
const UPSTREAM_RESULTS: [&str; 5] = ["success", "rejected", "error", "aborted", "throttled"];
const SKIP_REASONS: [&str; 1] = ["throttled"];

fn write_step(input: &mut Decoder<'_>, json: &mut Json<'_>) -> Read<()> {
    json.raw("{\"at_us\":");
    json.number(input.number()?);
    json.key("kind");
    match input.byte()? {
        STEP_PIPELINE => {
            json.label("pipeline");
            json.key("pipeline");
            json.text(input.text()?);
        }
        STEP_RULE => {
            json.label("rule");
            json.key("pipeline");
            json.text(input.text()?);
            json.key("rule");
            json.text(input.text()?);
            json.key("phase");
            json.label(input.label(&PHASES)?);
            match input.byte()? {
                0 => {}
                1 => {
                    json.key("matched");
                    json.raw("false");
                }
                2 => {
                    json.key("matched");
                    json.raw("true");
                }
                _ => return Err(Unreadable),
            }
            if let Some(decision) = input.optional_label(&DECISIONS)? {
                json.key("decision");
                json.label(decision);
            }
            if let Some(target) = input.optional_text()? {
                json.key("target");
                json.text(target);
            }
        }
        STEP_DECISION => {
            json.label("decision");
            json.key("pipeline");
            json.text(input.text()?);
            if let Some(rule) = input.optional_text()? {
                json.key("rule");
                json.text(rule);
            }
            json.key("phase");
            json.label(input.label(&PHASES)?);
            json.key("decision");
            json.label(input.label(&DECISIONS)?);
            if let Some(target) = input.optional_text()? {
                json.key("target");
                json.text(target);
            }
        }
        STEP_CACHE => {
            json.label("cache");
            json.key("result");
            json.label(input.optional_label(&CACHE_RESULTS)?.unwrap_or("miss"));
            if let Some(source) = input.optional_text()? {
                json.key("source");
                json.text(source);
            }
        }
        STEP_JOINED => json.label("joined"),
        STEP_UPSTREAM => {
            json.label("upstream");
            json.key("upstream");
            json.text(input.text()?);
            json.key("transport");
            json.label(input.label(&TRANSPORTS)?);
            json.key("via");
            json.label(input.label(&TRANSPORTS)?);
            json.key("result");
            json.label(input.label(&UPSTREAM_RESULTS)?);
            json.key("latency_us");
            json.number(input.number()?);
            if let Some(rcode) = input.rcode()? {
                json.key("rcode");
                json.label(&rcode);
            }
            if let Some(error) = input.optional_text()? {
                json.key("error");
                json.text(error);
            }
        }
        STEP_UPSTREAM_SKIPPED => {
            json.label("upstream_skipped");
            json.key("upstream");
            json.text(input.text()?);
            json.key("transport");
            json.label(input.label(&TRANSPORTS)?);
            json.key("reason");
            json.label(input.label(&SKIP_REASONS)?);
        }
        _ => return Err(Unreadable),
    }
    json.raw("}");
    Ok(())
}

/// 响应码的助记名（NOERROR、NXDOMAIN……），和内核写的一样 / The response code mnemonic (NOERROR, NXDOMAIN, …),
/// as the kernel writes it
fn rcode_name(code: u16) -> Cow<'static, str> {
    const NAMES: [&str; 11] = [
        "NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED", "YXDOMAIN", "YXRRSET",
        "NXRRSET", "NOTAUTH", "NOTZONE",
    ];
    NAMES.get(usize::from(code)).map_or_else(
        || Cow::Owned(format!("RCODE{code}")),
        |name| Cow::Borrowed(*name),
    )
}

/// 读编好的记录：数字是变长整数（每个字节七位，高位说后面还有），文字是长度加原文；可有可无的项，文字和枚举前面
/// 一个 0 表示没有，数字加一、0 表示没有
/// Reads an encoded record: numbers are variable-length integers (seven bits a byte, the high bit saying
/// more follow), text is its length and then itself; for optional items, text and enums are preceded by 0
/// when absent, and numbers are stored plus one with 0 for none
struct Decoder<'a>(&'a [u8]);

/// 字节读不通（和「这一项没有」是两回事）/ The bytes do not read (which is not the same as an item being absent)
#[derive(Debug)]
struct Unreadable;

type Read<T> = Result<T, Unreadable>;

impl<'a> Decoder<'a> {
    fn byte(&mut self) -> Read<u8> {
        let (&byte, rest) = self.0.split_first().ok_or(Unreadable)?;
        self.0 = rest;
        Ok(byte)
    }

    fn number(&mut self) -> Read<u64> {
        let mut value = 0;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7F) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(Unreadable)
    }

    fn length(&mut self) -> Read<usize> {
        usize::try_from(self.number()?).map_err(|_| Unreadable)
    }

    fn take(&mut self, len: usize) -> Read<&'a [u8]> {
        let (taken, rest) = self.0.split_at_checked(len).ok_or(Unreadable)?;
        self.0 = rest;
        Ok(taken)
    }

    fn text(&mut self) -> Read<&'a str> {
        let len = self.length()?;
        std::str::from_utf8(self.take(len)?).map_err(|_| Unreadable)
    }

    fn optional_text(&mut self) -> Read<Option<&'a str>> {
        match self.byte()? {
            0 => Ok(None),
            1 => self.text().map(Some),
            _ => Err(Unreadable),
        }
    }

    fn label(&mut self, labels: &[&'static str]) -> Read<&'static str> {
        labels
            .get(usize::from(self.byte()?))
            .copied()
            .ok_or(Unreadable)
    }

    /// 前面一个 0 表示没有，否则是编号加一 / 0 for none, otherwise the code plus one
    fn optional_label(&mut self, labels: &[&'static str]) -> Read<Option<&'static str>> {
        match self.byte()? {
            0 => Ok(None),
            code => labels
                .get(usize::from(code - 1))
                .copied()
                .map(Some)
                .ok_or(Unreadable),
        }
    }

    fn octets<const N: usize>(&mut self) -> Read<[u8; N]> {
        self.take(N)?.try_into().map_err(|_| Unreadable)
    }

    fn address(&mut self) -> Read<IpAddr> {
        match self.byte()? {
            ANSWER_V4 => Ok(IpAddr::V4(Ipv4Addr::from(self.octets::<4>()?))),
            ANSWER_V6 => Ok(IpAddr::V6(Ipv6Addr::from(self.octets::<16>()?))),
            _ => Err(Unreadable),
        }
    }

    fn rcode(&mut self) -> Read<Option<Cow<'static, str>>> {
        match self.number()?.checked_sub(1) {
            None => Ok(None),
            Some(rcode) => u16::try_from(rcode)
                .map(|rcode| Some(rcode_name(rcode)))
                .map_err(|_| Unreadable),
        }
    }
}

/// 写一行 JSON，写法和内核的一样：键名和标签原样写，外来的文字和数字由 `serde_json` 写，地址的写法和 `Display` 一样
/// Writes a line of JSON the way the kernel does: keys and labels as they are, outside text and numbers
/// by `serde_json`, addresses as `Display` writes them
struct Json<'a>(&'a mut Vec<u8>);

impl Json<'_> {
    fn raw(&mut self, text: &str) {
        self.0.extend_from_slice(text.as_bytes());
    }

    /// 下一个字段的键：前面总有别的字段，所以先写逗号 / The next field's key: another field always comes
    /// before, so a comma goes first
    fn key(&mut self, key: &str) {
        self.raw(",\"");
        self.raw(key);
        self.raw("\":");
    }

    fn label(&mut self, label: &str) {
        self.raw("\"");
        self.raw(label);
        self.raw("\"");
    }

    fn text(&mut self, text: &str) {
        // 写进 Vec 不会失败 / Writing into a Vec cannot fail
        let _ =
            serde::Serializer::serialize_str(&mut serde_json::Serializer::new(&mut *self.0), text);
    }

    fn number(&mut self, number: u64) {
        let _ = serde::Serializer::serialize_u64(
            &mut serde_json::Serializer::new(&mut *self.0),
            number,
        );
    }

    fn address(&mut self, address: IpAddr) {
        use std::io::Write as _;
        match address {
            IpAddr::V4(address) => self.ipv4(address),
            IpAddr::V6(address) => {
                let _ = write!(self.0, "\"{address}\"");
            }
        }
    }

    /// IPv4 地址一位位写出来，和 `Display` 一样 / An IPv4 address written digit by digit, as `Display` writes it
    fn ipv4(&mut self, address: Ipv4Addr) {
        self.0.push(b'"');
        for (index, octet) in address.octets().into_iter().enumerate() {
            if index > 0 {
                self.0.push(b'.');
            }
            if octet >= 100 {
                self.0.push(b'0' + octet / 100);
            }
            if octet >= 10 {
                self.0.push(b'0' + octet / 10 % 10);
            }
            self.0.push(b'0' + octet % 10);
        }
        self.0.push(b'"');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内核生成的样本：一页 150 条随机的记录（每种步骤、要转义的文字、截断的报错、IPv6 客户端、各种应答），二进制
    /// 和 JSON 各一份。内核那边的格式一改，样本就要重新生成，这里也跟着红
    /// The kernel's sample: a page of 150 random records (every kind of step, text that needs escaping,
    /// clipped errors, IPv6 clients, all sorts of responses), as binary and as JSON. When the kernel changes
    /// the encoding the sample must be generated again, and this turns red too
    const SAMPLE_RECORDS: &[u8] = include_bytes!("../tests/fixtures/querylog-records1.bin");
    const SAMPLE_JSON: &str = include_str!("../tests/fixtures/querylog-records1.json");

    #[derive(serde::Deserialize)]
    struct JsonPage<'a> {
        protocol_version: u8,
        instance: u64,
        newest_seq: u64,
        missed: u64,
        untracked: u64,
        more: bool,
        #[serde(borrow)]
        entries: Vec<&'a serde_json::value::RawValue>,
    }

    /// 内核编好的记录在面板写成的 JSON，和内核自己写的一字不差；页头和读出的几项也对得上
    /// The JSON the panel writes from the kernel's encoded records equals what the kernel writes byte for
    /// byte; the head and the items read agree as well
    #[test]
    fn records_are_written_exactly_as_the_kernel_writes_them() {
        let expected: JsonPage<'_> = serde_json::from_str(SAMPLE_JSON).unwrap();
        let page = RecordsPage::read(SAMPLE_RECORDS).expect("the sample reads");
        assert_eq!(page.protocol_version, expected.protocol_version);
        assert_eq!(page.instance, expected.instance);
        assert_eq!(page.newest_seq, expected.newest_seq);
        assert_eq!(page.missed, expected.missed);
        assert_eq!(page.untracked, expected.untracked);
        assert_eq!(page.more, expected.more);
        assert_eq!(page.records.len(), expected.entries.len());
        for ((seq, range), expected) in (page.first..).zip(&page.records).zip(&expected.entries) {
            let mut json = Vec::new();
            let summary = write_record(seq, &SAMPLE_RECORDS[range.clone()], &mut json)
                .unwrap_or_else(|| panic!("record {seq} reads"));
            assert_eq!(
                std::str::from_utf8(&json).unwrap(),
                expected.get(),
                "record {seq}"
            );
            let fields: serde_json::Value = serde_json::from_str(expected.get()).unwrap();
            assert_eq!(fields["time_unix_ms"], summary.time_unix_ms);
            assert_eq!(fields["qname"], summary.qname);
            assert_eq!(fields["outcome"], summary.outcome);
            assert_eq!(fields["rcode"].as_str(), summary.rcode.as_deref());
        }
    }

    /// 样本把每个标签都用到了：哪个编号表和内核的对不上，上面那个就会红
    /// The sample uses every label, so a code table out of step with the kernel turns the test above red
    #[test]
    fn the_sample_uses_every_label() {
        let tables: [(&str, &[&str]); 9] = [
            ("\"transport\":\"", &CLIENT_TRANSPORTS),
            ("\"status\":\"", &STATUSES),
            ("\"outcome\":\"", &OUTCOMES),
            ("\"phase\":\"", &PHASES),
            ("\"decision\":\"", &DECISIONS),
            ("\"result\":\"", &CACHE_RESULTS),
            ("\"via\":\"", &TRANSPORTS),
            ("\"result\":\"", &UPSTREAM_RESULTS),
            ("\"reason\":\"", &SKIP_REASONS),
        ];
        for (key, labels) in tables {
            for label in labels {
                let needle = format!("{key}{label}\"");
                assert!(SAMPLE_JSON.contains(&needle), "{needle}");
            }
        }
    }

    /// 读不通的都交回 None：短了一截、多了字节、开头不对 / Anything that does not read gives None: cut
    /// short, bytes left over, the wrong start
    #[test]
    fn broken_pages_and_records_do_not_read() {
        let page = RecordsPage::read(SAMPLE_RECORDS).unwrap();
        assert!(RecordsPage::read(&SAMPLE_RECORDS[..SAMPLE_RECORDS.len() - 1]).is_none());
        let mut longer = SAMPLE_RECORDS.to_vec();
        longer.push(0);
        assert!(RecordsPage::read(&longer).is_none());
        let mut other_version = SAMPLE_RECORDS.to_vec();
        other_version[4] = 2;
        assert!(RecordsPage::read(&other_version).is_none());
        let first = &SAMPLE_RECORDS[page.records[0].clone()];
        let mut longer = first.to_vec();
        longer.push(0);
        assert!(write_record(1, &longer, &mut Vec::new()).is_none());
        for cut in 0..first.len() {
            assert!(
                write_record(1, &first[..cut], &mut Vec::new()).is_none(),
                "cut at {cut}"
            );
        }
    }
}
