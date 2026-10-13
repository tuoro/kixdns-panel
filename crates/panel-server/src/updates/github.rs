//! GitHub 访问：Token 的保存与校验、API 请求。
//! GitHub access: storing and checking the token, and API requests.

use super::GithubRateLimit;
use super::GithubRateLimitResponse;
use super::GithubTokenStatus;
use super::MAX_GITHUB_TOKEN_BYTES;
use super::UpdateError;
use super::UpdateManager;
use super::storage::ensure_directory;
use super::validation::persist;
use super::validation::sync_directory;
use super::validation::write_private_file;
use secrecy::ExposeSecret;
use secrecy::SecretString;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

pub(super) fn parse_rate_limit(headers: &reqwest::header::HeaderMap) -> Option<GithubRateLimit> {
    let limit = headers
        .get("x-ratelimit-limit")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    let remaining = headers
        .get("x-ratelimit-remaining")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    let reset_at = headers
        .get("x-ratelimit-reset")?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    Some(GithubRateLimit {
        limit,
        remaining,
        reset_at,
    })
}

pub(super) fn validate_github_token(token: &str) -> Result<(), UpdateError> {
    if token.is_empty() || token.len() > MAX_GITHUB_TOKEN_BYTES {
        return Err(UpdateError::Invalid("GitHub Token 长度无效".to_owned()));
    }
    if !token
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(UpdateError::Invalid(
            "GitHub Token 只能包含 ASCII 字母、数字、下划线或短横线".to_owned(),
        ));
    }
    if !(token.starts_with("github_pat_")
        || ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]
            .iter()
            .any(|prefix| token.starts_with(prefix)))
    {
        return Err(UpdateError::Invalid(
            "GitHub Token 格式无效，支持 Fine-grained PAT 和 Classic PAT".to_owned(),
        ));
    }
    Ok(())
}

pub(super) fn read_github_token(path: &Path) -> Result<Option<SecretString>, UpdateError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(UpdateError::Invalid(error.to_string())),
    };
    if !metadata.file_type().is_file() {
        return Err(UpdateError::Invalid(
            "GitHub Token 路径必须是普通文件".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(UpdateError::Invalid(
                "GitHub Token 文件权限太宽，要设成 0600".to_owned(),
            ));
        }
    }
    if metadata.len() > MAX_GITHUB_TOKEN_BYTES as u64 + 1 {
        return Err(UpdateError::Invalid("GitHub Token 文件过大".to_owned()));
    }
    let token =
        fs::read_to_string(path).map_err(|error| UpdateError::Invalid(error.to_string()))?;
    let token = token.strip_suffix('\n').unwrap_or(&token);
    let token = token.strip_suffix('\r').unwrap_or(token);
    validate_github_token(token)?;
    Ok(Some(SecretString::from(token.to_owned())))
}

pub(super) fn write_github_token(path: &Path, token: &str) -> Result<(), UpdateError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| UpdateError::Invalid("GitHub Token 路径缺少父目录".to_owned()))?;
    ensure_directory(parent)?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && !metadata.file_type().is_file()
    {
        return Err(UpdateError::Invalid(
            "GitHub Token 路径必须是普通文件".to_owned(),
        ));
    }
    let temporary = write_private_file(parent, ".github-token-", token.as_bytes())?;
    persist(temporary, path)?;
    sync_directory(parent)
}

pub(super) fn remove_github_token(path: &Path) -> Result<(), UpdateError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| UpdateError::Invalid("GitHub Token 路径缺少父目录".to_owned()))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(path).map_err(|error| UpdateError::Install(error.to_string()))?;
            sync_directory(parent)
        }
        Ok(_) => Err(UpdateError::Invalid(
            "GitHub Token 路径必须是普通文件".to_owned(),
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(UpdateError::Install(error.to_string())),
    }
}

impl UpdateManager {
    pub async fn github_token_status(&self) -> GithubTokenStatus {
        GithubTokenStatus {
            configured: self.github_token.read().await.is_some(),
            rate_limit: self.github_rate_limit.read().await.clone(),
        }
    }

    pub async fn save_github_token(&self, token: String) -> Result<GithubTokenStatus, UpdateError> {
        validate_github_token(&token)?;
        let (rate_limit, status) = self.verify_github_token(&token).await?;
        write_github_token(&self.github_token_path, &token)?;
        *self.github_token.write().await = Some(SecretString::from(token));
        *self.github_rate_limit.write().await = Some(rate_limit);
        self.clear_remote_caches().await;
        Ok(status)
    }

    pub async fn delete_github_token(&self) -> Result<GithubTokenStatus, UpdateError> {
        remove_github_token(&self.github_token_path)?;
        *self.github_token.write().await = None;
        *self.github_rate_limit.write().await = None;
        self.clear_remote_caches().await;
        Ok(self.github_token_status().await)
    }

    pub(super) async fn verify_github_token(
        &self,
        token: &str,
    ) -> Result<(GithubRateLimit, GithubTokenStatus), UpdateError> {
        let response = self
            .client
            .get("https://api.github.com/rate_limit")
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| github_unreachable(&error))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UpdateError::Invalid(
                "GitHub Token 无效，换一个再试".to_owned(),
            ));
        }
        let rate_limit = parse_rate_limit(response.headers());
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            let message = if rate_limit.as_ref().is_some_and(|rate| rate.remaining == 0) {
                "GitHub Token 的访问次数用完了，等次数重置或换一个 Token"
            } else {
                "GitHub 拒绝了这个 Token：检查它的访问策略"
            };
            return Err(UpdateError::Network(message.to_owned()));
        }
        let payload = response
            .error_for_status()
            .map_err(|error| github_refused(&error))?
            .json::<GithubRateLimitResponse>()
            .await
            .map_err(|error| github_unreadable(&error))?;
        let rate_limit = rate_limit.unwrap_or(GithubRateLimit {
            limit: payload.resources.core.limit,
            remaining: payload.resources.core.remaining,
            reset_at: payload.resources.core.reset,
        });
        Ok((
            rate_limit.clone(),
            GithubTokenStatus {
                configured: true,
                rate_limit: Some(rate_limit),
            },
        ))
    }

    pub(super) async fn get_json_optional<T>(&self, url: &str) -> Result<Option<T>, UpdateError>
    where
        T: serde::de::DeserializeOwned,
    {
        let response = self.github_response_optional(url).await?;
        let Some(response) = response else {
            return Ok(None);
        };
        response
            .json()
            .await
            .map(Some)
            .map_err(|error| UpdateError::Network(error.to_string()))
    }

    pub(super) async fn github_response_optional(
        &self,
        url: &str,
    ) -> Result<Option<reqwest::Response>, UpdateError> {
        if !url.starts_with("https://api.github.com/") {
            return Err(UpdateError::Invalid("GitHub API 地址不可信".to_owned()));
        }
        let token = self.github_token.read().await.clone();
        let mut request = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json");
        if let Some(token) = token.as_ref() {
            request = request.bearer_auth(token.expose_secret());
        }
        let response = request
            .send()
            .await
            .map_err(|error| github_unreachable(&error))?;
        if let Some(rate_limit) = parse_rate_limit(response.headers()) {
            *self.github_rate_limit.write().await = Some(rate_limit.clone());
            if response.status() == reqwest::StatusCode::FORBIDDEN && rate_limit.remaining == 0 {
                let message = if token.is_some() {
                    "GitHub Token 的访问次数用完了，等次数重置或换一个 Token"
                } else {
                    "GitHub 匿名访问次数用完了"
                };
                return Err(UpdateError::Network(message.to_owned()));
            }
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UpdateError::Network(
                "GitHub Token 已失效，换一个新的 Token 后再检查".to_owned(),
            ));
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        response
            .error_for_status()
            .map(Some)
            .map_err(|error| github_refused(&error))
    }

    pub(super) fn http_client(
        api_timeout: Duration,
        connect_timeout: Duration,
        read_timeout: Duration,
    ) -> Result<reqwest::Client, UpdateError> {
        reqwest::Client::builder()
            .user_agent(concat!("kixdns-panel/", env!("CARGO_PKG_VERSION")))
            .timeout(api_timeout)
            .connect_timeout(connect_timeout)
            .read_timeout(read_timeout)
            .build()
            .map_err(|error| UpdateError::Invalid(error.to_string()))
    }
}

// GitHub 出错时给人看的是中文的原因和下一步，原始错误写进日志 / A GitHub failure shows a Chinese reason and next step; the raw error goes to the log
fn github_unreachable(error: &reqwest::Error) -> UpdateError {
    tracing::warn!(%error, "连不上 GitHub API");
    UpdateError::Network("连不上 GitHub，稍后再检查".to_owned())
}

fn github_unreadable(error: &reqwest::Error) -> UpdateError {
    tracing::warn!(%error, "GitHub API 返回的内容无法解析");
    UpdateError::Network("GitHub 返回的内容读不懂，稍后再检查".to_owned())
}

fn github_refused(error: &reqwest::Error) -> UpdateError {
    tracing::warn!(%error, "GitHub API 返回错误状态");
    UpdateError::Network(error.status().map_or_else(
        || "GitHub 没有正常回应，稍后再检查".to_owned(),
        |status| format!("GitHub 返回了错误（{}），稍后再检查", status.as_u16()),
    ))
}
