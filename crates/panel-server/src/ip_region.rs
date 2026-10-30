//! 地址的地区：查询详情和诊断里给回答的地址、客户端标上 US、CN 这样的代码。按配置里的 `GeoIP` 数据现查，查完就放，
//! 面板不常驻任何 `GeoIP` 数据；每次只查一条查询用到的几个地址。读法和内核按地区匹配时一样：
//! - 内网地址先认出来，和内核「回答的是内网地址」同一个判断；
//! - 配了 MMDB 而且打得开时，地区只看它（内核这时国家代码也只查它），它给的代码照写，`GOOGLE` 这类名字也是；
//! - 否则读 DAT（扩展名 `.dat`，其余按 JSON），只看两个字母的国家代码；一个地址同时列在几个国家下时都给出来，因为
//!   这几个国家的规则都会命中它。
//!
//! An address's region: the query detail and the diagnostics mark the addresses of an answer and the client with codes
//! such as US or CN. They are looked up in the configured `GeoIP` data when asked and dropped after, so the panel keeps no
//! `GeoIP` data resident; each lookup covers the few addresses of one query. They are read the way the kernel matches
//! regions:
//! - local addresses are recognised first, by the same test as the kernel's 回答的是内网地址;
//! - with an MMDB configured that opens, the region comes from it alone (the kernel then looks country codes up there
//!   alone), and its code is written as it is, names such as `GOOGLE` included;
//! - otherwise the DAT (a `.dat` extension; anything else is JSON) is read for two-letter country codes only; an
//!   address listed under several countries gets all of them, since a rule for any of them matches it.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, BufRead, BufReader, ErrorKind, Read};
use std::net::IpAddr;
use std::path::Path;

use ipnet::IpNet;
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::protobuf::{Fields, Value};

/// 一次最多查多少个地址：一条查询日志最多 8 条回答加一个客户端，诊断的回答也在这个数以内
/// The most addresses one lookup takes: a query-log record keeps at most 8 answers plus the client, and a diagnosis
/// answers within that too
pub const MAX_ADDRESSES: usize = 32;

/// 读 JSON 格式的数据时接受的最大文件，和下载 Geo 数据的上限一样 / The largest JSON data file read, the same as the
/// Geo download limit
const MAX_JSON_BYTES: u64 = 128 * 1024 * 1024;

/// 一个地址的地区 / An address's region
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpRegion {
    /// 内网地址 / A local network address
    Local,
    /// `GeoIP` 数据给它的代码，大写；DAT 里列在几个国家下时几个，按字母排 / The codes the `GeoIP` data gives it, in upper
    /// case; several, in alphabetical order, when a DAT lists it under several countries
    Codes(Vec<String>),
}

/// 写成 `{"local": true}` 或 `{"codes": ["US"]}` / Written as `{"local": true}` or `{"codes": ["US"]}`
impl Serialize for IpRegion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            Self::Local => map.serialize_entry("local", &true)?,
            Self::Codes(codes) => map.serialize_entry("codes", codes)?,
        }
        map.end()
    }
}

/// 配置里的两份 `GeoIP` 数据 / The two `GeoIP` files of a configuration
#[derive(Debug, Default)]
pub struct GeoIpFiles<'a> {
    pub mmdb: Option<&'a Path>,
    pub dat: Option<&'a Path>,
}

/// `ips` 里每个地址的地区，一一对应；查不到的、没配 `GeoIP` 数据的是 None。数据文件读不了时只记日志，地区留空：
/// 标签只是说明，不该让页面报错
/// The region of each address in `ips`, in order; None for one the data does not place, or without `GeoIP` data. A data
/// file that cannot be read is only logged and leaves the regions empty: the labels are an explanation and should
/// never make the page fail
pub fn regions(ips: &[IpAddr], files: &GeoIpFiles<'_>) -> Vec<Option<IpRegion>> {
    let mut found: Vec<Option<IpRegion>> = ips
        .iter()
        .map(|ip| is_local(*ip).then_some(IpRegion::Local))
        .collect();
    let open: Vec<usize> = (0..ips.len()).filter(|at| found[*at].is_none()).collect();
    if open.is_empty() {
        return found;
    }
    let wanted: Vec<IpAddr> = open.iter().map(|at| ips[*at]).collect();
    // MMDB 打不开时内核不用它，国家代码改从 DAT 里查，这里也一样 / When the MMDB does not open the kernel does without
    // it and looks country codes up in the DAT, and so does this
    let codes = files
        .mmdb
        .and_then(|path| logged(path, mmdb_codes(path, &wanted)))
        .or_else(|| {
            files
                .dat
                .and_then(|path| logged(path, data_file_codes(path, &wanted)))
        });
    for (at, codes) in open.into_iter().zip(codes.unwrap_or_default()) {
        if !codes.is_empty() {
            found[at] = Some(IpRegion::Codes(codes));
        }
    }
    found
}

/// 没有这个文件不必说（配置里写了、还没下载好）；别的读不了记一条告警 / A missing file needs no word (configured but
/// not downloaded yet); any other failure to read is logged as a warning
fn logged<T>(path: &Path, result: io::Result<T>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            tracing::warn!(path = %path.display(), error = %error, "读不了 GeoIP 数据，地址不标地区");
            None
        }
    }
}

/// 内核 `geoip_private` 眼里的内网地址：IPv4 的私有网段、回环、链路本地和受限广播，IPv6 的回环、未指定地址、ULA、
/// 链路本地。0.0.0.0 不算，`::` 算，和内核一样
/// A local network address as the kernel's `geoip_private` sees it: for IPv4 the private networks, loopback,
/// link-local and the limited broadcast; for IPv6 loopback, the unspecified address, ULA and link-local. 0.0.0.0 does
/// not count and `::` does, as in the kernel
fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_broadcast()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

/// 两个字母的国家代码；只有它们会去查 MMDB，DAT 里也只看它们 / A two-letter country code: only these are looked up
/// in the MMDB, and only these are read from a DAT
fn is_country_code(code: &str) -> bool {
    code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_alphabetic())
}

#[derive(Deserialize)]
struct CountryRecord<'a> {
    #[serde(borrow)]
    country: Option<Country<'a>>,
    #[serde(borrow)]
    registered_country: Option<Country<'a>>,
    #[serde(borrow)]
    represented_country: Option<Country<'a>>,
}

#[derive(Deserialize)]
struct Country<'a> {
    iso_code: Option<&'a str>,
}

/// MMDB 给每个地址的代码：先看 `country`，没有再看 `registered_country`、`represented_country`，和内核一样；查不到、
/// 解不出来的没有
/// The MMDB's code for each address: `country` first, then `registered_country`, then `represented_country`, as in the
/// kernel; none for an address it lacks or a record that cannot be decoded
fn mmdb_codes(path: &Path, ips: &[IpAddr]) -> io::Result<Vec<Vec<String>>> {
    let reader = maxminddb::Reader::open_readfile(path).map_err(|error| match error {
        maxminddb::MaxMindDbError::Io(error) => error,
        other => io::Error::new(ErrorKind::InvalidData, other.to_string()),
    })?;
    Ok(ips
        .iter()
        .map(|ip| {
            let found = reader.lookup(*ip).ok();
            let record = found.and_then(|found| found.decode::<CountryRecord>().ok().flatten());
            record
                .and_then(|record| {
                    record
                        .country
                        .or(record.registered_country)
                        .or(record.represented_country)
                })
                .and_then(|country| country.iso_code)
                .filter(|code| !code.is_empty())
                .map(|code| vec![code.to_ascii_uppercase()])
                .unwrap_or_default()
        })
        .collect())
}

/// 数据文件里列着每个地址的国家代码：扩展名是 `.dat`（不分大小写）按 protobuf 读，其余按 JSON，和内核一样
/// The country codes a data file lists each address under: a `.dat` extension (any case) is read as protobuf and
/// anything else as JSON, as in the kernel
fn data_file_codes(path: &Path, ips: &[IpAddr]) -> io::Result<Vec<Vec<String>>> {
    let is_dat = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("dat"));
    let file = File::open(path)?;
    let sets = if is_dat {
        let length = file.metadata()?.len();
        dat_codes(&mut BufReader::with_capacity(64 * 1024, file), length, ips)
    } else {
        json_codes(file, ips)
    }
    .map_err(|message| io::Error::new(ErrorKind::InvalidData, message))?;
    Ok(sets
        .into_iter()
        .map(|set| set.into_iter().collect())
        .collect())
}

/// 网段里有没有这个地址：主机位清掉（1.2.3.4/24 就是 1.2.3.0/24），超过位数的前缀按单个地址算，/0 是整个空间，和内核一样
/// Whether a network holds the address: host bits are cleared (1.2.3.4/24 is 1.2.3.0/24), a prefix over the width is
/// one address and /0 the whole space, as in the kernel
fn holds(network: &[u8], prefix: u32, ip: IpAddr) -> bool {
    match (ip, network.len()) {
        (IpAddr::V4(ip), 4) => {
            let mask = u32::MAX.checked_shl(32 - prefix.min(32)).unwrap_or(0);
            let start = u32::from_be_bytes(network.try_into().unwrap_or_default());
            u32::from(ip) & mask == start & mask
        }
        (IpAddr::V6(ip), 16) => {
            let mask = u128::MAX.checked_shl(128 - prefix.min(128)).unwrap_or(0);
            let start = u128::from_be_bytes(network.try_into().unwrap_or_default());
            u128::from(ip) & mask == start & mask
        }
        _ => false,
    }
}

/// 文件里一段 protobuf，边读边解。不把条目整个读进内存：最大的国家（US）一条就四 MB 多，读进来以后分配器会留着这块，
/// 查一次就多占几 MB；这里只拿每个网段的几十个字节
/// A stretch of protobuf in a file, decoded as it is read. Entries are never read whole: the largest country (US)
/// takes over four MB, which the allocator would keep after a lookup; only each network's few dozen bytes are taken
struct Stream<'r, R> {
    reader: &'r mut R,
    left: u64,
}

impl<R: BufRead> Stream<'_, R> {
    fn byte(&mut self) -> Result<u8, String> {
        if self.left == 0 {
            return Err("数字在条目结尾处断开".to_owned());
        }
        // 直接从读缓冲里取，一个字节不走一次 read_exact / Taken straight from the read buffer, not one read_exact per byte
        let byte = *self
            .reader
            .fill_buf()
            .map_err(|_| "读文件出错")?
            .first()
            .ok_or("文件在条目中间断开")?;
        self.reader.consume(1);
        self.left -= 1;
        Ok(byte)
    }

    fn varint(&mut self) -> Result<u64, String> {
        // 快路径：整个数字都在读缓冲里，一次解完 / Fast path: the whole number sits in the read buffer and is decoded at once
        let buffer = self.reader.fill_buf().map_err(|_| "读文件出错")?;
        let room = buffer
            .len()
            .min(10)
            .min(usize::try_from(self.left).unwrap_or(usize::MAX));
        if let Some(last) = buffer[..room].iter().position(|byte| *byte < 0x80) {
            let value = buffer[..=last]
                .iter()
                .zip((0..64).step_by(7))
                .fold(0_u64, |value, (byte, shift)| {
                    value | u64::from(byte & 0x7f) << shift
                });
            self.reader.consume(last + 1);
            self.left -= last as u64 + 1;
            return Ok(value);
        }
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Ok(value);
            }
        }
        Err("数字太长".to_owned())
    }

    /// 下一个字段：编号，带长度的线型还有长度（别的线型的值已经跳过）；读完了是 None
    /// The next field: its number, with the length for a length-delimited one (the value of any other is skipped);
    /// None at the end
    fn field(&mut self) -> Result<Option<(u64, Option<u64>)>, String> {
        if self.left == 0 {
            return Ok(None);
        }
        let key = self.varint()?;
        let length = match key & 7 {
            0 => {
                self.varint()?;
                None
            }
            1 => {
                self.skip(8)?;
                None
            }
            2 => {
                let length = self.varint()?;
                if length > self.left {
                    return Err(format!(
                        "一个字段要 {length} 字节，条目里只剩 {} 字节",
                        self.left
                    ));
                }
                Some(length)
            }
            5 => {
                self.skip(4)?;
                None
            }
            wire => return Err(format!("不认识的字段类型 {wire}")),
        };
        Ok(Some((key >> 3, length)))
    }

    fn skip(&mut self, length: u64) -> Result<(), String> {
        if length > self.left {
            return Err("内容超出了条目长度".to_owned());
        }
        let skipped = io::copy(&mut self.reader.by_ref().take(length), &mut io::sink())
            .map_err(|_| "文件在条目中间断开")?;
        if skipped != length {
            return Err("文件在条目中间断开".to_owned());
        }
        self.left -= length;
        Ok(())
    }

    /// 把一段短的内容交给 `read`：整段都在读缓冲里时直接在缓冲上读，否则先拼进 `scratch`；超过 `limit` 的跳过，不交，
    /// 返回 None。网段不一个一个分配
    /// Hands a short stretch to `read`: straight from the read buffer when it is all there, otherwise gathered into
    /// `scratch` first; one over `limit` is skipped, not handed over, and gives None. No allocation per network
    fn with_bytes<T>(
        &mut self,
        length: u64,
        limit: u64,
        scratch: &mut Vec<u8>,
        read: impl FnOnce(&[u8]) -> T,
    ) -> Result<Option<T>, String> {
        if length > limit {
            self.skip(length)?;
            return Ok(None);
        }
        let size = usize::try_from(length).map_err(|_| "长度太大")?;
        let buffer = self.reader.fill_buf().map_err(|_| "读文件出错")?;
        let value = if buffer.len() >= size {
            let value = read(&buffer[..size]);
            self.reader.consume(size);
            value
        } else {
            scratch.clear();
            while scratch.len() < size {
                let buffer = self.reader.fill_buf().map_err(|_| "读文件出错")?;
                if buffer.is_empty() {
                    return Err("文件在条目中间断开".to_owned());
                }
                let take = buffer.len().min(size - scratch.len());
                scratch.extend_from_slice(&buffer[..take]);
                self.reader.consume(take);
            }
            read(scratch)
        };
        self.left -= length;
        Ok(Some(value))
    }

    /// 这个字段里面的一段，读完以后外面接着往下读 / The stretch inside this field; the outer one reads on after it
    fn inner(&mut self, length: u64) -> Stream<'_, R> {
        self.left -= length;
        Stream {
            reader: &mut *self.reader,
            left: length,
        }
    }
}

/// `GeoIPList { repeated GeoIP entry = 1; }`，`GeoIP { string country_code = 1; repeated CIDR cidr = 2; … }`，
/// `CIDR { bytes ip = 1; uint32 prefix = 2; }`。国家代码写了两遍时后一个为准（和内核用的 prost 一样），写在网段后面也认
/// A country code written twice counts as the later one (as with the kernel's prost), and one written after the
/// networks still counts
fn dat_codes(
    reader: &mut impl BufRead,
    length: u64,
    ips: &[IpAddr],
) -> Result<Vec<BTreeSet<String>>, String> {
    let mut sets = vec![BTreeSet::new(); ips.len()];
    let (mut hits, mut scratch) = (vec![false; ips.len()], Vec::new());
    let mut list = Stream {
        reader,
        left: length,
    };
    while let Some((number, length)) = list.field()? {
        let length = match (number, length) {
            (1, Some(length)) => length,
            (1, None) => return Err("条目的字段类型不对".to_owned()),
            (_, Some(length)) => {
                list.skip(length)?;
                continue;
            }
            (_, None) => continue,
        };
        let mut entry = list.inner(length);
        let mut code = None;
        hits.fill(false);
        while let Some((number, length)) = entry.field()? {
            match (number, length) {
                (1, Some(length)) => {
                    // 长得不像国家代码的照样顶掉前一个，只是不算国家 / One too long for a country code still replaces the
                    // one before, it just counts as no country
                    code = entry
                        .with_bytes(length, 64, &mut scratch, |bytes| {
                            std::str::from_utf8(bytes).map(str::to_ascii_uppercase)
                        })?
                        .transpose()
                        .map_err(|_| "国家代码不是 UTF-8")?;
                }
                (2, Some(length)) => {
                    entry
                        .with_bytes(length, 4096, &mut scratch, |cidr| {
                            let (mut network, mut prefix) = (&[][..], 0_u64);
                            // 常见写法 0a len ip 10 prefix 直接取 / The usual layout taken directly
                            if let [0x0a, size @ (4 | 16), rest @ ..] = cidr
                                && let Some((ip, [0x10, last])) =
                                    rest.split_at_checked(usize::from(*size))
                                && *last < 0x80
                            {
                                let prefix = u32::from(*last);
                                for (hit, address) in hits.iter_mut().zip(ips) {
                                    *hit |= holds(ip, prefix, *address);
                                }
                                return Ok(());
                            }
                            for field in Fields::new(cidr) {
                                match field? {
                                    (1, Value::Bytes(bytes)) => network = bytes,
                                    (2, Value::Number(value)) => prefix = value,
                                    (1 | 2, _) => return Err("网段的字段类型不对".to_owned()),
                                    _ => {}
                                }
                            }
                            // uint32 照 prost 的读法只留低 32 位 / As prost reads a uint32, only the low 32 bits count
                            let prefix =
                                u32::try_from(prefix & u64::from(u32::MAX)).unwrap_or(u32::MAX);
                            for (hit, ip) in hits.iter_mut().zip(ips) {
                                *hit |= holds(network, prefix, *ip);
                            }
                            Ok(())
                        })?
                        .transpose()?;
                }
                (1 | 2, None) => return Err("网段或国家代码的字段类型不对".to_owned()),
                (_, Some(length)) => entry.skip(length)?,
                (_, None) => {}
            }
        }
        if let Some(code) = code.filter(|code| is_country_code(code)) {
            for (set, hit) in sets.iter_mut().zip(&hits) {
                if *hit {
                    set.insert(code.clone());
                }
            }
        }
    }
    Ok(sets)
}

#[derive(Deserialize)]
struct JsonList {
    entries: Vec<JsonEntry>,
}

#[derive(Deserialize)]
struct JsonEntry {
    country_code: String,
    ips: Vec<String>,
}

/// `V2Ray` 的 JSON：`{"entries": [{"country_code": "cn", "ips": ["1.2.3.0/24"]}]}`；写不成网段的一行跳过，和内核一样
/// `V2Ray`'s JSON form; a line that is no network is skipped, as in the kernel
fn json_codes(file: File, ips: &[IpAddr]) -> Result<Vec<BTreeSet<String>>, String> {
    let mut data = Vec::new();
    file.take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.len() as u64 > MAX_JSON_BYTES {
        return Err("数据文件太大".to_owned());
    }
    let list: JsonList = serde_json::from_slice(&data).map_err(|error| error.to_string())?;
    let mut sets = vec![BTreeSet::new(); ips.len()];
    for entry in list.entries {
        let code = entry.country_code.to_ascii_uppercase();
        if !is_country_code(&code) {
            continue;
        }
        let networks: Vec<IpNet> = entry
            .ips
            .iter()
            .filter_map(|line| line.parse().ok())
            .collect();
        for (set, ip) in sets.iter_mut().zip(ips) {
            if networks.iter().any(|network| network.contains(ip)) {
                set.insert(code.clone());
            }
        }
    }
    Ok(sets)
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;
    use std::path::Path;

    use tempfile::tempdir;

    use super::{GeoIpFiles, IpRegion, regions};
    use crate::protobuf::test_data::{bytes_field, varint};

    fn cidr(ip: &str, prefix: u64) -> Vec<u8> {
        let ip: IpAddr = ip.parse().unwrap();
        let bytes = match ip {
            IpAddr::V4(v4) => v4.octets().to_vec(),
            IpAddr::V6(v6) => v6.octets().to_vec(),
        };
        let mut message = bytes_field(1, &bytes);
        message.extend(varint(2 << 3));
        message.extend(varint(prefix));
        message
    }

    /// 一个 `GeoIP` 条目：国家代码在前（`code_last` 时写在网段后面） / One `GeoIP` entry, the code first (after the
    /// networks with `code_last`)
    fn entry(code: &str, networks: &[Vec<u8>], code_last: bool) -> Vec<u8> {
        let mut message = Vec::new();
        if !code_last {
            message.extend(bytes_field(1, code.as_bytes()));
        }
        for network in networks {
            message.extend(bytes_field(2, network));
        }
        if code_last {
            message.extend(bytes_field(1, code.as_bytes()));
        }
        bytes_field(1, &message)
    }

    /// 一份像 Loyalsoldier 那样的 DAT：CN 和 HK 有一段重叠，带一个非国家标签，一个小写代码，一个代码写在网段后面，
    /// 一个主机位没清的网段，一个超过 32 的前缀，外加内核会跳过的字段
    /// A DAT shaped like Loyalsoldier's: CN and HK overlap, with one non-country tag, one lower-case code, one code
    /// written after its networks, one network with host bits set, one prefix over 32, and fields the kernel skips
    fn sample_dat() -> Vec<u8> {
        let mut data = entry("CN", &[cidr("1.2.3.0", 24), cidr("240e::", 20)], false);
        data.extend(entry("HK", &[cidr("1.2.3.128", 25)], false));
        data.extend(entry("us", &[cidr("8.8.8.0", 24)], false));
        data.extend(entry("GOOGLE", &[cidr("8.8.8.0", 24)], false));
        data.extend(entry("JP", &[cidr("9.9.9.9", 24)], true));
        data.extend(entry("SG", &[cidr("5.5.5.5", 40)], false));
        // reverse_match（字段 3）和顶层不认识的字段都跳过 / reverse_match (field 3) and an unknown top-level field are skipped
        let mut with_flag = bytes_field(1, b"DE");
        with_flag.extend(bytes_field(2, &cidr("7.7.7.0", 24)));
        with_flag.extend(varint(3 << 3));
        with_flag.extend(varint(1));
        data.extend(bytes_field(1, &with_flag));
        data.extend(bytes_field(9, b"ignored"));
        // 代码写了两遍，后一个为准；后一个长得不像国家代码时这一条就不算国家 / A code written twice counts as the later
        // one; when the later one is too long for a country code the entry counts as none
        let mut twice = bytes_field(1, b"AA");
        twice.extend(bytes_field(2, &cidr("6.6.6.0", 24)));
        twice.extend(bytes_field(1, b"FR"));
        data.extend(bytes_field(1, &twice));
        // 不是常见写法的网段走逐字段的读法：前缀写在地址前面，或者前缀要两个字节（200，超过 32 就是一个地址）
        // Networks not in the usual layout take the field-by-field path: the prefix before the address, or a prefix
        // needing two bytes (200, which over 32 is one address)
        let mut reversed = varint(2 << 3);
        reversed.extend(varint(24));
        reversed.extend(bytes_field(1, &[3, 3, 3, 0]));
        data.extend(entry("NO", &[reversed, cidr("2.2.2.2", 200)], false));
        let mut overlong = bytes_field(1, b"IT");
        overlong.extend(bytes_field(2, &cidr("4.4.4.0", 24)));
        overlong.extend(bytes_field(1, "X".repeat(100).as_bytes()));
        data.extend(bytes_field(1, &overlong));
        data
    }

    fn lookup(ips: &[&str], files: &GeoIpFiles<'_>) -> Vec<Option<IpRegion>> {
        let ips: Vec<IpAddr> = ips.iter().map(|ip| ip.parse().unwrap()).collect();
        regions(&ips, files)
    }

    fn codes(codes: &[&str]) -> IpRegion {
        IpRegion::Codes(codes.iter().map(|code| (*code).to_owned()).collect())
    }

    /// 和内核按地区匹配时读到的一样：重叠的两个国家都给出来，非国家标签不算，主机位清掉，超过 32 的前缀是一个地址
    /// What the kernel reads when matching regions: both overlapping countries come back, a non-country tag does not
    /// count, host bits are cleared, and a prefix over 32 is one address
    #[test]
    fn a_dat_gives_every_country_listing_the_address_as_the_kernel_reads_it() {
        let directory = tempdir().unwrap();
        let dat = directory.path().join("geoip.dat");
        std::fs::write(&dat, sample_dat()).unwrap();
        let files = GeoIpFiles {
            mmdb: None,
            dat: Some(&dat),
        };
        assert_eq!(
            lookup(
                &[
                    "1.2.3.200",
                    "1.2.3.5",
                    "8.8.8.8",
                    "9.9.9.1",
                    "5.5.5.5",
                    "5.5.5.6",
                    "240e::1",
                    "7.7.7.7",
                    "203.0.113.9",
                    "6.6.6.6",
                    "4.4.4.4",
                    "3.3.3.3",
                    "2.2.2.2",
                    "2.2.2.3",
                ],
                &files
            ),
            vec![
                Some(codes(&["CN", "HK"])),
                Some(codes(&["CN"])),
                Some(codes(&["US"])),
                Some(codes(&["JP"])),
                Some(codes(&["SG"])),
                None,
                Some(codes(&["CN"])),
                Some(codes(&["DE"])),
                None,
                Some(codes(&["FR"])),
                None,
                Some(codes(&["NO"])),
                Some(codes(&["NO"])),
                None,
            ]
        );
    }

    /// 内网和内核「回答的是内网地址」一个判断：0.0.0.0 不算、`::` 算、受限广播算；不读数据文件也认得出
    /// Local addresses as the kernel's 回答的是内网地址 judges them: 0.0.0.0 does not count, `::` and the limited
    /// broadcast do; recognised without any data file
    #[test]
    fn local_addresses_match_the_kernels_test_without_any_data() {
        assert_eq!(
            lookup(
                &[
                    "10.1.2.3",
                    "192.168.1.1",
                    "172.31.0.1",
                    "127.0.0.1",
                    "169.254.1.1",
                    "255.255.255.255",
                    "0.0.0.0",
                    "::",
                    "::1",
                    "fd00::1",
                    "fe80::1",
                    "100.64.0.1",
                ],
                &GeoIpFiles::default()
            ),
            vec![
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                None,
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                Some(IpRegion::Local),
                None,
            ]
        );
    }

    /// 截断、类型不对的 DAT 读不了：地区留空，不出错、不卡住 / A truncated or mistyped DAT cannot be read: the regions stay
    /// empty, with no error and no hang
    #[test]
    fn a_damaged_dat_leaves_the_regions_empty() {
        let directory = tempdir().unwrap();
        let mut truncated = sample_dat();
        truncated.truncate(truncated.len() - 12);
        // 条目写成了变长整数 / An entry written as a varint
        let mut mistyped = varint(1 << 3);
        mistyped.extend(varint(5));
        // 长度大得离谱 / A length far past the end
        let mut overlong = varint(1 << 3 | 2);
        overlong.extend(varint(u64::MAX));
        for (name, data) in [
            ("t.dat", truncated),
            ("m.dat", mistyped),
            ("o.dat", overlong),
        ] {
            let dat = directory.path().join(name);
            std::fs::write(&dat, data).unwrap();
            let files = GeoIpFiles {
                mmdb: None,
                dat: Some(&dat),
            };
            assert_eq!(
                lookup(&["1.2.3.5", "10.0.0.1"], &files),
                vec![None, Some(IpRegion::Local)],
                "{name}"
            );
        }
    }

    /// 扩展名不是 .dat 的按 JSON 读：代码不分大小写，写不成网段的一行跳过 / A file without a .dat extension is read as
    /// JSON: codes ignore case, and a line that is no network is skipped
    #[test]
    fn a_json_data_file_is_read_like_the_kernel_reads_it() {
        let directory = tempdir().unwrap();
        let json = directory.path().join("geoip.json");
        std::fs::write(
            &json,
            serde_json::json!({ "entries": [
                { "country_code": "cn", "ips": ["1.2.3.0/24", "not a network", "1.2.4.4"] },
                { "country_code": "HK", "ips": ["1.2.3.128/25"] },
                { "country_code": "telegram", "ips": ["1.2.3.0/24"] },
            ] })
            .to_string(),
        )
        .unwrap();
        let files = GeoIpFiles {
            mmdb: None,
            dat: Some(&json),
        };
        assert_eq!(
            lookup(&["1.2.3.200", "1.2.3.5", "1.2.4.4"], &files),
            vec![Some(codes(&["CN", "HK"])), Some(codes(&["CN"])), None]
        );
    }

    fn write_mmdb(path: &Path, countries: &[(&str, &str, u8)]) {
        use std::io::Write;

        use maxminddb_writer::Database;
        use maxminddb_writer::metadata::IpVersion;
        use maxminddb_writer::paths::IpAddrWithMask;

        #[derive(serde::Serialize)]
        struct Record {
            country: Country,
        }
        #[derive(serde::Serialize)]
        struct Country {
            iso_code: String,
        }

        let mut db = Database::default();
        db.metadata.database_type = "test".to_owned();
        db.metadata.ip_version = IpVersion::V6;
        db.metadata.binary_format_major_version = 2;
        db.metadata.build_epoch = 1;
        let mut inserts = Vec::new();
        for (code, network, prefix) in countries {
            let data = db
                .insert_value(&Record {
                    country: Country {
                        iso_code: (*code).to_owned(),
                    },
                })
                .unwrap();
            // IPv4 放在 ::/96 下面，读的时候从那里找；父网段先插（写库的这个包先子后父会丢子网）
            // IPv4 sits under ::/96, where readers look; parents go in first (this writer loses a child inserted first)
            let v4: std::net::Ipv4Addr = network.parse().unwrap();
            let mapped = std::net::Ipv6Addr::from(u128::from(u32::from(v4)));
            inserts.push((
                prefix + 96,
                data,
                IpAddrWithMask::new(IpAddr::V6(mapped), prefix + 96),
            ));
        }
        inserts.sort_by_key(|(mask, _, _)| *mask);
        for (_, data, path) in inserts {
            db.insert_node(path, data);
        }
        let mut file = std::fs::File::create(path).unwrap();
        db.write_to(&mut file).unwrap();
        file.flush().unwrap();
    }

    /// 配了 MMDB 而且打得开时只看它：它没有的地址不再去 DAT 里找，它给的名字照写；打不开或者不存在时改读 DAT，
    /// 和内核一样
    /// With an MMDB that opens only it counts: an address it lacks is not looked for in the DAT, and its names are
    /// written as they are; one that is missing or does not open gives way to the DAT, as in the kernel
    #[test]
    fn an_mmdb_that_opens_decides_alone_and_a_broken_one_gives_way_to_the_dat() {
        let directory = tempdir().unwrap();
        let dat = directory.path().join("geoip.dat");
        std::fs::write(&dat, sample_dat()).unwrap();
        let mmdb = directory.path().join("Country.mmdb");
        write_mmdb(&mmdb, &[("CN", "1.2.3.0", 24), ("GOOGLE", "8.8.8.0", 24)]);
        let ips = ["1.2.3.200", "8.8.8.8", "9.9.9.1", "192.168.1.1"];
        assert_eq!(
            lookup(
                &ips,
                &GeoIpFiles {
                    mmdb: Some(&mmdb),
                    dat: Some(&dat),
                }
            ),
            vec![
                Some(codes(&["CN"])),
                Some(codes(&["GOOGLE"])),
                None,
                Some(IpRegion::Local)
            ]
        );
        let broken = directory.path().join("broken.mmdb");
        std::fs::write(&broken, b"not a database").unwrap();
        let missing = directory.path().join("missing.mmdb");
        for mmdb in [&broken, &missing] {
            assert_eq!(
                lookup(
                    &ips,
                    &GeoIpFiles {
                        mmdb: Some(mmdb),
                        dat: Some(&dat),
                    }
                ),
                vec![
                    Some(codes(&["CN", "HK"])),
                    Some(codes(&["US"])),
                    Some(codes(&["JP"])),
                    Some(IpRegion::Local)
                ],
                "{}",
                mmdb.display()
            );
        }
    }

    #[test]
    fn regions_are_written_as_local_or_codes() {
        assert_eq!(
            serde_json::to_value([Some(IpRegion::Local), Some(codes(&["CN", "HK"])), None])
                .unwrap(),
            serde_json::json!([{ "local": true }, { "codes": ["CN", "HK"] }, null])
        );
    }
}
