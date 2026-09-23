//! GitHub 访问：Token 的保存与校验、API 请求、工作流运行和产物列表。
//! GitHub access: storing and checking the token, API requests, workflow runs and artifact listings.

use super::ARTIFACT_PAGE_SIZE;
use super::Artifact;
use super::ArtifactList;
use super::CachedArtifacts;
use super::GithubRateLimit;
use super::GithubRateLimitResponse;
use super::GithubTokenStatus;
use super::MAX_ARTIFACT_PAGES;
use super::MAX_GITHUB_TOKEN_BYTES;
use super::REMOTE_CACHE_TTL;
use super::UpdateError;
use super::UpdateManager;
use super::VersionSource;
use super::WorkflowRun;
use super::WorkflowRuns;
use super::storage::ensure_directory;
use super::validation::persist;
use super::validation::sync_directory;
use super::validation::validate_commit;
use super::validation::write_private_file;
use secrecy::ExposeSecret;
use secrecy::SecretString;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

pub(super) fn artifact_page_count(total_count: usize) -> Result<usize, UpdateError> {
    let pages = total_count.div_ceil(ARTIFACT_PAGE_SIZE);
    if pages <= MAX_ARTIFACT_PAGES {
        return Ok(pages);
    }
    Err(UpdateError::Network(format!(
        "Artifact 数量超过分页安全上限（最多 {} 条）",
        ARTIFACT_PAGE_SIZE * MAX_ARTIFACT_PAGES
    )))
}

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
                "GitHub Token 文件权限过宽，请设置为 0600".to_owned(),
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

/// 只保留本仓库自己在目标分支上由 push、定时或手动触发的成功运行。
/// `branch=` 查询按 `head_branch` 匹配，fork 的 `main` 发来的 pull request
/// 同样叫 `main`，而且 `pull_request` 运行执行的是 PR 自带的工作流文件，
/// 可以去掉上传 Artifact 的守卫；这类运行一旦排在最前，面板就会把 fork
/// 构造的二进制当作最新版本安装。
/// Keep only successful runs of this repository's own branch triggered by
/// push, schedule or manual dispatch. The `branch=` query matches `head_branch`,
/// and a pull request from a fork's `main` is also called `main`; a
/// `pull_request` run executes the PR's own workflow file, which can drop the
/// guard around the artifact upload. Without this filter the newest such run
/// would be installed as the latest version.
pub(super) fn trusted_workflow_runs(
    runs: Vec<WorkflowRun>,
    repository: &str,
    branch: &str,
    limit: usize,
) -> Vec<WorkflowRun> {
    runs.into_iter()
        .filter(|run| validate_commit(&run.head_sha).is_ok())
        .filter(|run| {
            matches!(
                run.event.as_deref(),
                Some("push" | "schedule" | "workflow_dispatch")
            )
        })
        .filter(|run| run.head_branch.as_deref() == Some(branch))
        .filter(|run| {
            run.head_repository
                .as_ref()
                .and_then(|head| head.full_name.as_deref())
                .is_some_and(|name| name.eq_ignore_ascii_case(repository))
        })
        .take(limit)
        .collect()
}

/// 一次取满一页再过滤：按 limit 取，排在前面的不可信运行（fork 的 pull request
/// 等）会把可信运行挤出这一页，版本目录就少了甚至空了。
/// Fetch a full page and filter afterwards: fetching only `limit` runs lets
/// untrusted runs at the top (fork pull requests and the like) crowd trusted
/// ones out of the page, shrinking or emptying the catalogue.
pub(super) const WORKFLOW_RUN_PAGE_SIZE: usize = 100;

pub(super) fn workflow_runs_url(repository: &str, workflow: &str, branch: &str) -> String {
    format!(
        "https://api.github.com/repos/{repository}/actions/workflows/{workflow}/runs?branch={branch}&status=success&exclude_pull_requests=true&per_page={WORKFLOW_RUN_PAGE_SIZE}"
    )
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
            .map_err(|error| {
                UpdateError::Network(format!("GitHub API connection failed: {error}"))
            })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UpdateError::Invalid(
                "GitHub Token 无效，请检查后重试".to_owned(),
            ));
        }
        let rate_limit = parse_rate_limit(response.headers());
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            let message = if rate_limit.as_ref().is_some_and(|rate| rate.remaining == 0) {
                "GitHub Token 的 API 配额已用尽，请等待重置或更换 Token"
            } else {
                "GitHub 拒绝验证该 Token，请检查访问策略"
            };
            return Err(UpdateError::Network(message.to_owned()));
        }
        let payload = response
            .error_for_status()
            .map_err(|error| UpdateError::Network(error.to_string()))?
            .json::<GithubRateLimitResponse>()
            .await
            .map_err(|error| {
                UpdateError::Network(format!("GitHub API response invalid: {error}"))
            })?;
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

    pub(super) async fn workflow_runs(
        &self,
        source: VersionSource,
        limit: usize,
    ) -> Result<Vec<WorkflowRun>, UpdateError> {
        let limit = limit.clamp(1, 30);
        let workflow = match source {
            VersionSource::Action => &self.workflow,
            VersionSource::Release => &self.release_workflow,
        };
        self.workflow_runs_for(workflow, limit).await
    }

    pub(super) async fn workflow_runs_for(
        &self,
        workflow: &str,
        limit: usize,
    ) -> Result<Vec<WorkflowRun>, UpdateError> {
        let limit = limit.clamp(1, 30);
        let runs_url = workflow_runs_url(&self.repository, workflow, &self.branch);
        let runs = self.get_json::<WorkflowRuns>(&runs_url).await?;
        Ok(trusted_workflow_runs(
            runs.workflow_runs,
            &self.repository,
            &self.branch,
            limit,
        ))
    }

    pub(super) async fn repository_artifacts(&self) -> Result<Vec<Artifact>, UpdateError> {
        let mut cache = self.artifact_cache.write().await;
        if let Some(cached) = cache.as_ref()
            && cached.loaded_at.elapsed() < REMOTE_CACHE_TTL
        {
            return Ok(cached.artifacts.clone());
        }

        let mut artifacts = Vec::new();
        let mut artifact_ids = HashSet::new();
        let mut total_count = 0;
        for page in 1..=MAX_ARTIFACT_PAGES {
            let artifacts_url = format!(
                "https://api.github.com/repos/{}/actions/artifacts?per_page={ARTIFACT_PAGE_SIZE}&page={page}",
                self.repository
            );
            let response = self.get_json::<ArtifactList>(&artifacts_url).await?;
            total_count = total_count.max(response.total_count);
            artifact_page_count(total_count)?;
            artifacts.extend(
                response
                    .artifacts
                    .into_iter()
                    .filter(|artifact| artifact_ids.insert(artifact.id)),
            );
            if artifacts.len() >= total_count {
                cache.replace(CachedArtifacts {
                    loaded_at: Instant::now(),
                    artifacts: artifacts.clone(),
                });
                return Ok(artifacts);
            }
        }

        Err(UpdateError::Network(
            "GitHub Artifact 分页结果不完整，请稍后重试".to_owned(),
        ))
    }

    pub(super) async fn get_json<T>(&self, url: &str) -> Result<T, UpdateError>
    where
        T: serde::de::DeserializeOwned,
    {
        self.github_response(url)
            .await?
            .json()
            .await
            .map_err(|error| UpdateError::Network(error.to_string()))
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

    pub(super) async fn github_response(
        &self,
        url: &str,
    ) -> Result<reqwest::Response, UpdateError> {
        self.github_response_optional(url)
            .await?
            .ok_or_else(|| UpdateError::Network("GitHub API 资源不存在".to_owned()))
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
        let response = request.send().await.map_err(|error| {
            UpdateError::Network(format!("GitHub API connection failed: {error}"))
        })?;
        if let Some(rate_limit) = parse_rate_limit(response.headers()) {
            *self.github_rate_limit.write().await = Some(rate_limit.clone());
            if response.status() == reqwest::StatusCode::FORBIDDEN && rate_limit.remaining == 0 {
                let message = if token.is_some() {
                    "GitHub Token 的 API 配额已用尽，请等待重置或更换 Token"
                } else {
                    "GitHub 匿名 API 配额已用尽，请在系统页配置 GitHub Token"
                };
                return Err(UpdateError::Network(message.to_owned()));
            }
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(UpdateError::Network(
                "GitHub Token 已失效，请在系统页重新配置".to_owned(),
            ));
        }
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        response
            .error_for_status()
            .map(Some)
            .map_err(|error| UpdateError::Network(format!("GitHub API request failed: {error}")))
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
