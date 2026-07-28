use std::collections::HashMap;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration as StdDuration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::http::HeaderMap;
use axum_extra::extract::CookieJar;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use getrandom::fill;
use ipnet::IpNet;
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

#[derive(Debug, Clone)]
pub struct TrustedProxies(Vec<IpNet>);

impl Default for TrustedProxies {
    fn default() -> Self {
        Self(vec![
            "127.0.0.1/32".parse().expect("固定 IPv4 网段有效"),
            "::1/128".parse().expect("固定 IPv6 网段有效"),
        ])
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
                    .map_err(|error| format!("可信代理网段 {network} 无效：{error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if networks.is_empty() {
            return Err("至少需要一个可信代理网段".to_owned());
        }
        if networks.len() > 64 {
            return Err("可信代理网段不能超过 64 个".to_owned());
        }
        Ok(Self(networks))
    }
}

impl TrustedProxies {
    #[must_use]
    pub fn client_ip(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        if !self.contains(peer) {
            return peer;
        }
        let mut forwarded = Vec::new();
        for value in headers.get_all("x-forwarded-for") {
            let Ok(value) = value.to_str() else {
                return peer;
            };
            for address in value.split(',').map(str::trim) {
                if forwarded.len() == MAX_FORWARDED_HOPS || address.is_empty() {
                    return peer;
                }
                let Ok(address) = address.parse() else {
                    return peer;
                };
                forwarded.push(address);
            }
        }
        forwarded
            .iter()
            .rev()
            .copied()
            .find(|address| !self.contains(*address))
            .or_else(|| forwarded.first().copied())
            .unwrap_or(peer)
    }

    fn contains(&self, address: IpAddr) -> bool {
        self.0.iter().any(|network| network.contains(&address))
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
            address,
            username_hash: Sha256::digest(normalized.as_bytes()).into(),
        }
    }
}

#[derive(Default)]
pub struct LoginLimiter {
    attempts: Mutex<HashMap<LoginKey, AttemptState>>,
}

impl LoginLimiter {
    pub fn check(&self, address: IpAddr, username: &str) -> AppResult<()> {
        let key = LoginKey::new(address, username);
        let mut attempts = self
            .attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        attempts.retain(|_, state| state.started_at.elapsed() < ATTEMPT_WINDOW);
        if attempts
            .get(&key)
            .is_some_and(|state| state.failures >= MAX_ATTEMPTS)
        {
            return Err(AppError::TooManyRequests);
        }
        Ok(())
    }

    pub fn record_failure(&self, address: IpAddr, username: &str) {
        let key = LoginKey::new(address, username);
        let mut attempts = self
            .attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        attempts.retain(|_, state| state.started_at.elapsed() < ATTEMPT_WINDOW);
        let state = attempts.entry(key).or_insert_with(|| AttemptState {
            failures: 0,
            started_at: Instant::now(),
        });
        state.failures = state.failures.saturating_add(1);
    }

    pub fn clear(&self, address: IpAddr, username: &str) {
        self.attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&LoginKey::new(address, username));
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

pub async fn hash_password(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let params = Params::new(19_456, 2, 1, None).context("Argon2 参数无效")?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut salt_bytes = [0_u8; 16];
        fill(&mut salt_bytes).map_err(|error| anyhow::anyhow!("生成密码盐失败：{error}"))?;
        let salt = SaltString::encode_b64(&salt_bytes).context("编码密码盐失败")?;
        argon
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .context("计算密码哈希失败")
    })
    .await
    .context("密码哈希任务异常结束")?
}

pub async fn verify_password(password: String, encoded: String) -> anyhow::Result<bool> {
    tokio::task::spawn_blocking(move || {
        let Ok(hash) = PasswordHash::new(&encoded) else {
            return Ok(false);
        };
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &hash)
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

    use super::{LoginLimiter, TrustedProxies, token_hash, validate_password, validate_username};
    use crate::error::AppError;

    #[test]
    fn validates_credentials() {
        assert!(validate_username("admin.user").is_ok());
        assert!(validate_username("a/").is_err());
        assert!(validate_password("long-enough-password").is_ok());
        assert!(validate_password("short").is_err());
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
            limiter.record_failure(address, "admin");
        }
        assert!(matches!(
            limiter.check(address, "ADMIN"),
            Err(AppError::TooManyRequests)
        ));
        assert!(limiter.check(address, "other-admin").is_ok());
        limiter.clear(address, "admin");
        assert!(limiter.check(address, "admin").is_ok());
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
}
