use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr};
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use argon2::Argon2;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use getrandom::fill;
use ipnet::{IpNet, Ipv4Net};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::db::{Database, SessionRecord, UserRecord};
use crate::digest::sha256_hex;
use crate::error::{AppError, AppResult};

pub const SESSION_COOKIE: &str = "kixdns_session";
pub const CSRF_COOKIE: &str = "kixdns_csrf";
pub const CSRF_HEADER: &str = "x-csrf-token";
pub const SESSION_SECONDS: i64 = 12 * 60 * 60;
const MAX_ATTEMPTS: u32 = 5;
const ATTEMPT_WINDOW: StdDuration = StdDuration::from_mins(15);
const MAX_FORWARDED_HOPS: usize = 32;
const MAX_TRACKED_LOGIN_KEYS: usize = 10_000;
const MAX_USERNAMES_PER_BUCKET: usize = 20;

#[derive(Debug, Clone)]
pub struct TrustedProxies(Vec<IpNet>);

/// 默认谁都不信：只有写进 `KIXDNS_TRUSTED_PROXIES` 的代理带来的 `X-Forwarded-For` 才算数。以前默认信任回环地址，
/// frp、`ssh -R` 这类不改写这个头的本机转发会让客户端自己写的地址算数，每次换一个就是新的五次尝试
/// No proxy is trusted by default: `X-Forwarded-For` counts only from proxies written into `KIXDNS_TRUSTED_PROXIES`.
/// Loopback used to be trusted by default, so a local forwarder that does not rewrite the header (frp, `ssh -R`) made
/// the client's own value count, a fresh five tries with every new address
impl Default for TrustedProxies {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl FromStr for TrustedProxies {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let networks = value
            .split(',')
            .map(str::trim)
            .filter(|network| !network.is_empty())
            .map(|network| {
                network
                    .parse::<IpNet>()
                    .map(canonical_network)
                    .map_err(|error| format!("可信代理网段 {network} 无效：{error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if networks.len() > 64 {
            return Err("可信代理网段不能超过 64 个".to_owned());
        }
        Ok(Self(networks))
    }
}

/// IPv4 映射写法的网段（`::ffff:10.0.0.0/104`）换成 IPv4 网段：地址都按 IPv4 写法比，两种写法的网段才都认得。
/// A network in IPv4-mapped form (`::ffff:10.0.0.0/104`) becomes the IPv4 network: addresses are compared in IPv4
/// form, so a network written either way still matches.
fn canonical_network(network: IpNet) -> IpNet {
    match network {
        IpNet::V6(v6) if v6.prefix_len() >= 96 => v6
            .network()
            .to_ipv4_mapped()
            .and_then(|v4| Ipv4Net::new(v4, v6.prefix_len() - 96).ok())
            .map_or(network, IpNet::V4),
        _ => network,
    }
}

impl TrustedProxies {
    /// 地址一律按 IPv4 写法给出和比较：双栈监听时 IPv4 的对端以 `::ffff:a.b.c.d` 出现，不还原就对不上 `127.0.0.1/32`，
    /// 经代理来的人会全算到代理头上。
    /// Addresses are compared and returned in IPv4 form: on a dual-stack bind an IPv4 peer shows up as `::ffff:a.b.c.d`,
    /// which never matches `127.0.0.1/32` unless folded, and everyone coming through the proxy would count as the proxy.
    #[must_use]
    pub fn client_ip(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        let peer = peer.to_canonical();
        if !self.contains(peer) {
            if headers.contains_key("x-forwarded-for") {
                warn_untrusted_forwarding(peer);
            }
            return peer;
        }
        // 从右往左走：右边是可信代理追加的，左边是客户端自己能写的。遇到第一个
        // 不可信的合法地址就停，它左边的内容一律不解析，否则客户端只要在左边
        // 塞一项垃圾，就会被算成代理本身，连错几次锁住所有经代理登录的人。
        // 按字节切开、逐项解码也是为此：左边有一个非 ASCII 字节，整个头也不能作废。
        // Walk right to left: the right end is appended by trusted proxies,
        // the left end is whatever the client wrote. Stop at the first valid
        // untrusted address and never parse anything to its left; otherwise a
        // client prepending one junk entry is counted as the proxy itself and
        // a few failures lock out everyone who logs in through it. That is also
        // why the value is split as bytes and each entry decoded on its own: one
        // non-ASCII byte on the left must not void the whole header.
        let mut walked = 0;
        let mut leftmost_trusted = None;
        for value in headers.get_all("x-forwarded-for").iter().rev() {
            for address in value.as_bytes().rsplit(|byte| *byte == b',') {
                if walked == MAX_FORWARDED_HOPS {
                    return peer;
                }
                walked += 1;
                let Some(address) = std::str::from_utf8(address.trim_ascii())
                    .ok()
                    .and_then(|address| address.parse::<IpAddr>().ok())
                else {
                    return peer;
                };
                let address = address.to_canonical();
                if !self.contains(address) {
                    return address;
                }
                leftmost_trusted = Some(address);
            }
        }
        leftmost_trusted.unwrap_or(peer)
    }

    /// 地址按 IPv4 写法给进来；比 /96 短的 IPv6 网段（`::/0`、`::/80`）盖住的是映射写法，所以 IPv4 地址也拿
    /// `::ffff:a.b.c.d` 去对 IPv6 网段，写成哪种网段都认得
    /// Addresses come in IPv4 form; an IPv6 network shorter than /96 (`::/0`, `::/80`) covers the mapped form, so an IPv4
    /// address is also tried as `::ffff:a.b.c.d` against IPv6 networks, and a network matches however it is written
    fn contains(&self, address: IpAddr) -> bool {
        let mapped = match address {
            IpAddr::V4(v4) => Some(IpAddr::V6(v4.to_ipv6_mapped())),
            IpAddr::V6(_) => None,
        };
        self.0.iter().any(|network| {
            network.contains(&address) || mapped.is_some_and(|mapped| network.contains(&mapped))
        })
    }
}

/// 不可信的对端带来了 `X-Forwarded-For`：提醒一次。面板在反向代理后面却没写 `KIXDNS_TRUSTED_PROXIES` 时，所有人都算在
/// 代理头上，几次输错就锁住所有经代理登录的人；默认改成谁都不信以后，升级上来的反向代理部署靠这一行发现
/// `X-Forwarded-For` came from an untrusted peer: say so once. Behind a reverse proxy without `KIXDNS_TRUSTED_PROXIES`,
/// everyone counts against the proxy and a few failures lock out all who log in through it; with no proxy trusted by
/// default, an upgraded reverse-proxy deployment finds out from this line
fn warn_untrusted_forwarding(peer: IpAddr) {
    static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::warn!(
            %peer,
            "收到带 X-Forwarded-For 的请求，但对端不在可信代理里，登录限流按对端地址算；面板在反向代理后面时，把代理的地址写进 /etc/kixdns-panel/panel.env 的 KIXDNS_TRUSTED_PROXIES 并重启面板"
        );
    }
}

#[derive(Debug, Clone)]
struct AttemptState {
    failures: u32,
    started_at: Instant,
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct LoginKey {
    address: IpAddr,
    username_hash: [u8; 32],
}

impl LoginKey {
    fn new(address: IpAddr, username: &str) -> Self {
        let normalized = username.trim().to_ascii_lowercase();
        Self {
            address: address_bucket(address),
            username_hash: Sha256::digest(normalized.as_bytes()).into(),
        }
    }
}

/// IPv6 按 /64 计数：一台主机通常分到整个 /64，逐个换地址就能每次拿到新的
/// 五次预算。IPv4 映射地址还原成 IPv4，和直连的同一地址共用预算。
/// IPv6 is counted per /64: a host usually owns a whole /64 and could get a
/// fresh five-attempt budget per address. IPv4-mapped addresses fold back to
/// IPv4 so they share the budget of the same address reached directly.
fn address_bucket(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V4(_) => address,
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(
            || {
                let prefix = u128::from(v6) & !u128::from(u64::MAX);
                IpAddr::V6(Ipv6Addr::from(prefix))
            },
            IpAddr::V4,
        ),
    }
}

/// 追踪表：按键记录尝试，另按地址段记下各段占了几个键，淘汰时一起维护。
/// The tracking table: attempts per key, plus how many keys each address
/// bucket holds, kept in step on every insert and eviction.
#[derive(Default)]
struct AttemptTable {
    keys: HashMap<LoginKey, AttemptState>,
    per_bucket: HashMap<IpAddr, usize>,
}

impl AttemptTable {
    fn prune(&mut self) {
        let before = self.keys.len();
        self.keys
            .retain(|_, state| state.started_at.elapsed() < ATTEMPT_WINDOW);
        if self.keys.len() != before {
            self.recount();
        }
    }

    fn recount(&mut self) {
        self.per_bucket.clear();
        for key in self.keys.keys() {
            *self.per_bucket.entry(key.address).or_default() += 1;
        }
    }

    fn remove(&mut self, key: &LoginKey) {
        if self.keys.remove(key).is_none() {
            return;
        }
        if let Some(count) = self.per_bucket.get_mut(&key.address) {
            *count -= 1;
            if *count == 0 {
                self.per_bucket.remove(&key.address);
            }
        }
    }

    /// 最早出现的一项让位。过期项已经由 prune 清掉，剩下的都在窗口内。
    /// The entry seen first makes room. prune already dropped expired ones,
    /// so everything left is inside the window.
    fn evict_oldest(&mut self) {
        let oldest = self
            .keys
            .iter()
            .min_by_key(|(_, state)| state.started_at)
            .map(|(key, _)| *key);
        if let Some(key) = oldest {
            self.remove(&key);
        }
    }
}

#[derive(Default)]
pub struct LoginLimiter {
    attempts: Mutex<AttemptTable>,
}

impl LoginLimiter {
    /// 只读检查，给不消耗登录预算的初始化接口用。
    /// Read-only check for setup, which does not spend the login budget.
    pub fn check(&self, address: IpAddr, username: &str) -> AppResult<()> {
        let key = LoginKey::new(address, username);
        let mut attempts = self
            .attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        attempts.prune();
        if attempts
            .keys
            .get(&key)
            .is_some_and(|state| state.failures >= MAX_ATTEMPTS)
        {
            return Err(AppError::TooManyRequests);
        }
        Ok(())
    }

    /// 在同一把锁里检查并占用一次尝试。密码校验在 4 个槽位后面排队，
    /// 先检查、校验失败后再记数会让并发请求一起挤过检查（200 个并发错误
    /// 登录实测 135 次进入校验）。成功登录由 clear 归还预算，失败保留占用。
    /// 一个地址段在窗口内最多占 `MAX_USERNAMES_PER_BUCKET` 个用户名，超出只拒绝
    /// 这一段；总表满了就淘汰最早的一项，绝不因为别人把表占满而拒绝新来的段。
    /// Check and take one attempt under the same lock. Password verification
    /// queues behind four slots, so checking first and counting after a
    /// failed verify let parallel requests slip past together (200 parallel
    /// bad logins produced 135 verifications). A successful login returns the
    /// budget through clear; a failed one keeps its reservation. One address
    /// bucket may hold at most `MAX_USERNAMES_PER_BUCKET` usernames per window
    /// and only that bucket is refused beyond it; a full table evicts its
    /// oldest entry, so nobody filling it can lock out a newcomer.
    pub fn reserve(&self, address: IpAddr, username: &str) -> AppResult<()> {
        let key = LoginKey::new(address, username);
        let mut attempts = self
            .attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        attempts.prune();
        if let Some(state) = attempts.keys.get_mut(&key) {
            if state.failures >= MAX_ATTEMPTS {
                return Err(AppError::TooManyRequests);
            }
            state.failures += 1;
            return Ok(());
        }
        if attempts.per_bucket.get(&key.address).copied().unwrap_or(0) >= MAX_USERNAMES_PER_BUCKET {
            return Err(AppError::TooManyRequests);
        }
        while attempts.keys.len() >= MAX_TRACKED_LOGIN_KEYS {
            attempts.evict_oldest();
        }
        attempts.keys.insert(
            key,
            AttemptState {
                failures: 1,
                started_at: Instant::now(),
            },
        );
        *attempts.per_bucket.entry(key.address).or_default() += 1;
        Ok(())
    }

    pub fn clear(&self, address: IpAddr, username: &str) {
        self.attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&LoginKey::new(address, username));
    }

    #[cfg(test)]
    fn tracked(&self) -> usize {
        self.attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys
            .len()
    }
}

pub fn validate_username(username: &str) -> AppResult<String> {
    let username = username.trim();
    if !(3..=64).contains(&username.len())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(AppError::BadRequest(
            "invalid_username",
            "用户名需为 3 至 64 位字母、数字、点、下划线或连字符".to_owned(),
        ));
    }
    Ok(username.to_owned())
}

pub fn validate_password(password: &str) -> AppResult<()> {
    let characters = password.chars().count();
    if !(12..=128).contains(&characters) || password.len() > 256 {
        return Err(AppError::BadRequest(
            "weak_password",
            "密码长度需为 12 至 128 个字符".to_owned(),
        ));
    }
    Ok(())
}

/// 用 argon2 的默认参数算出 PHC 串：Argon2id v19、19 MiB、两遍、单线程（OWASP 的推荐值），16 字节随机盐；测试钉住这些参数
/// The PHC string from argon2's default parameters: Argon2id v19, 19 MiB, two passes, one lane (OWASP's recommendation),
/// with a random 16-byte salt; a test pins these parameters
pub async fn hash_password(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|hash| hash.to_string())
            .context("计算密码哈希失败")
    })
    .await
    .context("密码哈希任务异常结束")?
}

/// 按 PHC 串里记下的算法和参数校验，存下来的串解析不了也算不对
/// Verifies with the algorithm and parameters recorded in the PHC string; one that does not parse is a mismatch too
pub async fn verify_password(password: String, encoded: String) -> anyhow::Result<bool> {
    tokio::task::spawn_blocking(move || {
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), encoded.as_str())
            .is_ok())
    })
    .await
    .context("密码校验任务异常结束")?
}

pub fn random_token() -> anyhow::Result<String> {
    let mut bytes = [0_u8; 32];
    fill(&mut bytes).map_err(|error| anyhow::anyhow!("生成安全随机令牌失败：{error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[must_use]
pub fn token_hash(token: &str) -> String {
    sha256_hex(token.as_bytes())
}

pub async fn authenticate(database: &Database, jar: &CookieJar) -> AppResult<SessionRecord> {
    let token = jar
        .get(SESSION_COOKIE)
        .map(axum_extra::extract::cookie::Cookie::value)
        .ok_or(AppError::Unauthorized)?;
    database
        .find_session(token_hash(token), unix_timestamp())
        .await
        .map_err(AppError::Internal)?
        .ok_or(AppError::Unauthorized)
}

pub fn verify_csrf(session: &SessionRecord, jar: &CookieJar, headers: &HeaderMap) -> AppResult<()> {
    let cookie = jar
        .get(CSRF_COOKIE)
        .map(axum_extra::extract::cookie::Cookie::value);
    let header = headers
        .get(CSRF_HEADER)
        .and_then(|value| value.to_str().ok());
    let (Some(cookie), Some(header)) = (cookie, header) else {
        return Err(AppError::Forbidden);
    };
    if cookie.as_bytes().ct_eq(header.as_bytes()).unwrap_u8() != 1 {
        return Err(AppError::Forbidden);
    }
    let candidate = token_hash(header);
    if candidate
        .as_bytes()
        .ct_eq(session.csrf_hash.as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

pub async fn issue_session(
    database: &Database,
    user: &UserRecord,
) -> anyhow::Result<(String, String, i64)> {
    let session_token = random_token()?;
    let csrf_token = random_token()?;
    let now = unix_timestamp();
    let expires_at = now.saturating_add(SESSION_SECONDS);
    database
        .create_session(
            user.id,
            token_hash(&session_token),
            token_hash(&csrf_token),
            expires_at,
            now,
        )
        .await?;
    Ok((session_token, csrf_token, expires_at))
}

#[must_use]
pub fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};

    use axum::http::{HeaderMap, HeaderValue};

    use super::{
        LoginLimiter, TrustedProxies, hash_password, token_hash, validate_password,
        validate_username, verify_password,
    };
    use crate::error::AppError;

    #[test]
    fn validates_credentials() {
        assert!(validate_username("admin.user").is_ok());
        assert!(validate_username("a/").is_err());
        assert!(validate_password("long-enough-password").is_ok());
        assert!(validate_password("short").is_err());
    }

    /// 新写的哈希和 argon2 0.5 时一样：Argon2id v19、m=19456、t=2、p=1，16 字节盐、32 字节输出，每次的盐都不同
    /// New hashes match those from argon2 0.5: Argon2id v19, m=19456, t=2, p=1, a 16-byte salt and a 32-byte output,
    /// with a fresh salt every time
    #[tokio::test]
    async fn new_hashes_keep_the_parameters_and_a_fresh_salt() {
        let first = hash_password("a-secure-password".to_owned()).await.unwrap();
        let second = hash_password("a-secure-password".to_owned()).await.unwrap();
        for hash in [&first, &second] {
            let fields = hash.split('$').collect::<Vec<_>>();
            assert_eq!(
                fields[..4],
                ["", "argon2id", "v=19", "m=19456,t=2,p=1"],
                "{hash}"
            );
            assert_eq!((fields[4].len(), fields[5].len()), (22, 43), "{hash}");
            assert!(
                verify_password("a-secure-password".to_owned(), hash.clone())
                    .await
                    .unwrap()
            );
        }
        assert_ne!(first, second);
        assert!(
            !verify_password(
                "a-secure-password".to_owned(),
                "not-a-phc-string".to_owned()
            )
            .await
            .unwrap()
        );
    }

    #[test]
    fn hashes_tokens_deterministically_without_storing_token() {
        let hash = token_hash("secret-token");
        assert_eq!(hash.len(), 64);
        assert!(!hash.contains("secret-token"));
    }

    #[test]
    fn limits_repeated_login_failures() {
        let limiter = LoginLimiter::default();
        let address = IpAddr::V4(Ipv4Addr::LOCALHOST);
        for _ in 0..5 {
            limiter.reserve(address, "admin").unwrap();
        }
        assert!(matches!(
            limiter.check(address, "ADMIN"),
            Err(AppError::TooManyRequests)
        ));
        assert!(matches!(
            limiter.reserve(address, "ADMIN"),
            Err(AppError::TooManyRequests)
        ));
        assert!(limiter.check(address, "other-admin").is_ok());
        limiter.clear(address, "admin");
        assert!(limiter.check(address, "admin").is_ok());
    }

    #[test]
    fn a_username_spray_exhausts_only_its_own_bucket() {
        let limiter = LoginLimiter::default();
        let sprayer = IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9));
        for index in 0..super::MAX_USERNAMES_PER_BUCKET {
            limiter.reserve(sprayer, &format!("guess-{index}")).unwrap();
        }

        // 同一段再换用户名：拒绝的是这一段。
        // A further username from the same bucket is refused for that bucket.
        assert!(matches!(
            limiter.reserve(sprayer, "guess-next"),
            Err(AppError::TooManyRequests)
        ));
        // 已经在窗口里的用户名照常消耗自己的五次。
        // A username already tracked keeps spending its own five attempts.
        assert!(limiter.reserve(sprayer, "guess-0").is_ok());
        // 别的地址上的管理员不受影响，照常进入密码校验。
        // The admin on another address still reaches password verification.
        let admin = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7));
        assert!(limiter.reserve(admin, "admin").is_ok());
    }

    #[test]
    fn a_full_tracking_table_still_admits_a_fresh_bucket() {
        let limiter = LoginLimiter::default();
        for index in 0..super::MAX_TRACKED_LOGIN_KEYS {
            let offset = u32::try_from(index).unwrap();
            let address = IpAddr::V4(Ipv4Addr::from(0x0a00_0000_u32 + offset));
            limiter.reserve(address, "admin").unwrap();
        }
        let newcomer = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7));

        assert!(limiter.reserve(newcomer, "admin").is_ok());
        // 内存仍有上限：最早的一项让了位。
        // Memory stays bounded: the oldest entry made room.
        assert_eq!(limiter.tracked(), super::MAX_TRACKED_LOGIN_KEYS);
        for _ in 1..5 {
            limiter.reserve(newcomer, "admin").unwrap();
        }
        assert!(matches!(
            limiter.reserve(newcomer, "admin"),
            Err(AppError::TooManyRequests)
        ));
    }

    #[test]
    fn trusts_forwarding_headers_only_from_configured_proxies() {
        let proxies: TrustedProxies = "127.0.0.1/32,10.0.0.0/8".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("198.51.100.7, 10.10.0.2"),
        );
        assert_eq!(
            proxies.client_ip(Ipv4Addr::LOCALHOST.into(), &headers),
            "198.51.100.7".parse::<IpAddr>().unwrap()
        );

        let untrusted_peer = "203.0.113.9".parse::<IpAddr>().unwrap();
        assert_eq!(proxies.client_ip(untrusted_peer, &headers), untrusted_peer);

        headers.insert("x-forwarded-for", HeaderValue::from_static("invalid"));
        assert_eq!(
            proxies.client_ip(Ipv4Addr::LOCALHOST.into(), &headers),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
    }

    #[test]
    fn junk_left_of_the_real_client_does_not_resolve_to_the_proxy() {
        let proxies: TrustedProxies = "127.0.0.1/32,10.0.0.0/8".parse().unwrap();
        let peer = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let client = "198.51.100.7".parse::<IpAddr>().unwrap();
        let resolve = |value: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-for", HeaderValue::from_str(value).unwrap());
            proxies.client_ip(peer, &headers)
        };

        // nginx 的 $proxy_add_x_forwarded_for 把真实地址追加在客户端自带的值右边。
        // nginx's $proxy_add_x_forwarded_for appends the real address to
        // whatever the client sent.
        assert_eq!(resolve("garbage, 198.51.100.7"), client);
        assert_eq!(resolve(", 198.51.100.7"), client);
        assert_eq!(resolve("x, 198.51.100.7, 10.0.0.1"), client);
        assert_eq!(resolve("198.51.100.7, 10.0.0.1"), client);
        let padded = format!("{}198.51.100.7", "203.0.113.1, ".repeat(40));
        assert_eq!(resolve(&padded), client);

        // 整条链都可信时仍取最左边一项；链上可信项之间夹着垃圾时退回对端。
        // An all-trusted chain still resolves to its leftmost entry; junk met
        // before any untrusted address falls back to the peer.
        assert_eq!(
            resolve("10.0.0.2, 10.0.0.1"),
            "10.0.0.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(resolve("198.51.100.7, junk, 10.0.0.1"), peer);
        let trusted_chain = format!("198.51.100.7, {}", "10.0.0.1, ".repeat(32));
        assert_eq!(resolve(trusted_chain.trim_end_matches(", ")), peer);

        // 多个头按出现顺序拼接，右边的头离面板最近。
        // Multiple headers concatenate in order; the last is nearest the panel.
        let mut headers = HeaderMap::new();
        headers.append("x-forwarded-for", HeaderValue::from_static("junk"));
        headers.append("x-forwarded-for", HeaderValue::from_static("198.51.100.7"));
        assert_eq!(proxies.client_ip(peer, &headers), client);
    }

    #[test]
    fn a_non_ascii_byte_left_of_the_real_client_is_never_decoded() {
        let proxies: TrustedProxies = "127.0.0.1/32,10.0.0.0/8".parse().unwrap();
        let peer = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let client = "198.51.100.7".parse::<IpAddr>().unwrap();
        let resolve = |values: &[&[u8]]| {
            let mut headers = HeaderMap::new();
            for value in values {
                headers.append("x-forwarded-for", HeaderValue::from_bytes(value).unwrap());
            }
            proxies.client_ip(peer, &headers)
        };

        // 客户端自己写在左边的字节，不管是不是可见 ASCII，都不该把整个请求算到代理头上。
        // Bytes the client wrote on the left, visible ASCII or not, must not charge the
        // whole request to the proxy.
        assert_eq!(resolve(&[b"\xff, 198.51.100.7"]), client);
        assert_eq!(resolve(&["é, 198.51.100.7, 10.0.0.1".as_bytes()]), client);
        assert_eq!(resolve(&[b"\x80", b"198.51.100.7"]), client);
        // 可信那一段里的坏字节照旧退回对端。
        // A bad byte inside the trusted part still falls back to the peer.
        assert_eq!(resolve(&[b"198.51.100.7, \xff, 10.0.0.1"]), peer);
    }

    /// 默认谁都不信：没写 `KIXDNS_TRUSTED_PROXIES` 时，回环地址带来的 `X-Forwarded-For` 也不算数，按对端地址限流。
    /// 以前默认信任回环，frp、`ssh -R` 这类不改写这个头的本机转发会让客户端自己写的地址算数，限流形同虚设
    /// No proxy is trusted by default: without `KIXDNS_TRUSTED_PROXIES`, `X-Forwarded-For` from a loopback peer does not
    /// count either, and the limiter keys on the peer. Loopback used to be trusted by default, so a local forwarder that
    /// does not rewrite the header (frp, `ssh -R`) made the client's own value count and voided the limiter
    #[test]
    fn no_proxy_is_trusted_unless_configured() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("198.51.100.7"));
        let loopback = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(
            TrustedProxies::default().client_ip(loopback, &headers),
            loopback
        );
        let empty: TrustedProxies = "".parse().expect("an empty list means no trusted proxy");
        assert_eq!(empty.client_ip(loopback, &headers), loopback);
        let configured: TrustedProxies = "127.0.0.1/32,::1/128".parse().unwrap();
        assert_eq!(
            configured.client_ip(loopback, &headers),
            "198.51.100.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn an_ipv4_mapped_address_counts_as_the_ipv4_address() {
        let proxies: TrustedProxies = "127.0.0.1/32,::1/128".parse().unwrap();
        let client = "198.51.100.7".parse::<IpAddr>().unwrap();
        let forwarded = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-for", HeaderValue::from_static(value));
            headers
        };

        // 双栈监听时，nginx 从 127.0.0.1 连进来，面板看到的对端是 ::ffff:127.0.0.1。
        // On a dual-stack bind, nginx connecting from 127.0.0.1 reaches the panel as
        // ::ffff:127.0.0.1.
        let mapped_loopback = "::ffff:127.0.0.1".parse::<IpAddr>().unwrap();
        assert_eq!(
            proxies.client_ip(mapped_loopback, &forwarded("198.51.100.7")),
            client
        );
        // 链上的一跳、客户端本身也一样，得到的是 IPv4 写法。
        // The same for a hop on the chain and for the client itself, which comes out in
        // IPv4 form.
        let proxies: TrustedProxies = "127.0.0.1/32,10.0.0.0/8".parse().unwrap();
        let peer = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert_eq!(
            proxies.client_ip(peer, &forwarded("198.51.100.7, ::ffff:10.0.0.1")),
            client
        );
        assert_eq!(
            proxies.client_ip(peer, &forwarded("::ffff:198.51.100.7")),
            client
        );
        // 不在可信网段里的对端照旧是它自己，同样用 IPv4 写法。
        // An untrusted peer is still itself, in IPv4 form too.
        assert_eq!(
            proxies.client_ip(
                "::ffff:203.0.113.9".parse().unwrap(),
                &forwarded("198.51.100.7")
            ),
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );

        // 可信网段写成映射形式时，两种写法的地址也都认。
        // A trusted network written in mapped form matches both spellings as well.
        let proxies: TrustedProxies = "::ffff:10.0.0.0/104".parse().unwrap();
        for proxy in ["10.0.0.1", "::ffff:10.0.0.1"] {
            assert_eq!(
                proxies.client_ip(proxy.parse().unwrap(), &forwarded("198.51.100.7")),
                client,
                "{proxy}"
            );
        }
    }

    /// 比 /96 短、盖住 `::ffff:0:0/96` 的 IPv6 网段（`::/0`、`::/80`）也照样认 IPv4 的对端和链上的 IPv4 地址：地址按 IPv4
    /// 写法比，网段却还是 IPv6，比的时候 IPv4 地址也拿它的映射写法去对 IPv6 网段
    /// An IPv6 network shorter than /96 that covers `::ffff:0:0/96` (`::/0`, `::/80`) still matches an IPv4 peer and an IPv4
    /// address on the chain: addresses are compared in IPv4 form while the network stays IPv6, so an IPv4 address is also tried
    /// in its mapped form against IPv6 networks
    #[test]
    fn a_short_ipv6_network_covers_mapped_ipv4_addresses() {
        let forwarded = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-for", HeaderValue::from_static(value));
            headers
        };
        let client = "198.51.100.7".parse::<IpAddr>().unwrap();
        for written in ["::/0", "::/80", "::ffff:0:0/96"] {
            let proxies: TrustedProxies = written.parse().unwrap();
            for peer in ["::ffff:127.0.0.1", "127.0.0.1"] {
                assert_eq!(
                    proxies.client_ip(peer.parse().unwrap(), &forwarded("198.51.100.7")),
                    client,
                    "{written} {peer}"
                );
            }
            // 链上的一跳也是 / So is a hop on the chain
            let proxies: TrustedProxies = format!("{written},2001:db8::/32").parse().unwrap();
            assert_eq!(
                proxies.client_ip(
                    "2001:db8::1".parse().unwrap(),
                    &forwarded("198.51.100.7, 10.0.0.1")
                ),
                client,
                "{written}"
            );
        }
        // 盖不住映射段的 IPv6 网段照旧不认 IPv4 / An IPv6 network that does not cover the mapped range still matches no IPv4
        let proxies: TrustedProxies = "2001:db8::/32".parse().unwrap();
        assert_eq!(
            proxies.client_ip(
                "::ffff:127.0.0.1".parse().unwrap(),
                &forwarded("198.51.100.7")
            ),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
    }
}
