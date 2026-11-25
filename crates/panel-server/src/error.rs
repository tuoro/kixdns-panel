use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use crate::control::CodedNotices;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{1}")]
    BadRequest(&'static str, String),
    #[error("未登录或会话已失效")]
    Unauthorized,
    #[error("用户名或密码错误")]
    InvalidCredentials,
    #[error("CSRF 校验失败")]
    Forbidden,
    #[error("{1}")]
    Conflict(&'static str, String),
    #[error("{1}")]
    NotFound(&'static str, String),
    #[error("操作太频繁，过一会儿再试")]
    TooManyRequests,
    #[error("{1}")]
    Unprocessable(&'static str, String),
    /// `KixDNS` 不接受一份配置：422，另带它逐条列出的原因（见 `control::Refusal::problems`）和带着代号的同样几条（见
    /// `control::Refusal::coded_problems`），页面按代号说成自己的话，一条条列出来
    /// `KixDNS` does not accept a configuration: a 422 carrying the reasons it lists one by one as well (see
    /// `control::Refusal::problems`) and the same ones coded (see `control::Refusal::coded_problems`), which the page says
    /// in its own words by the codes and lists item by item
    #[error("{1}")]
    Refused(&'static str, String, Vec<String>, CodedNotices),
    #[error("{1}")]
    ServiceUnavailable(&'static str, String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    /// 逐条的细节（见 [`AppError::Refused`]），没有时省略 / The details one by one (see [`AppError::Refused`]), left out
    /// when there are none
    #[serde(skip_serializing_if = "Vec::is_empty")]
    details: Vec<String>,
    /// `details` 带着代号的那一份，一条对一条（见 [`AppError::Refused`]），没有时省略 / The coded copy of `details`, one
    /// for one (see [`AppError::Refused`]), left out when there is none
    #[serde(skip_serializing_if = "Vec::is_empty")]
    coded_details: CodedNotices,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (mut details, mut coded_details) = (Vec::new(), Vec::new());
        let (status, code, message) = match self {
            Self::BadRequest(code, message) => (StatusCode::BAD_REQUEST, code, message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "未登录或会话已失效".to_owned(),
            ),
            Self::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "用户名或密码错误".to_owned(),
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "csrf_invalid",
                "CSRF 校验失败".to_owned(),
            ),
            Self::Conflict(code, message) => (StatusCode::CONFLICT, code, message),
            Self::NotFound(code, message) => (StatusCode::NOT_FOUND, code, message),
            Self::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "操作太频繁，过一会儿再试".to_owned(),
            ),
            Self::Unprocessable(code, message) => (StatusCode::UNPROCESSABLE_ENTITY, code, message),
            Self::Refused(code, message, reasons, coded) => {
                (details, coded_details) = (reasons, coded);
                (StatusCode::UNPROCESSABLE_ENTITY, code, message)
            }
            Self::ServiceUnavailable(code, message) => {
                (StatusCode::SERVICE_UNAVAILABLE, code, message)
            }
            Self::Internal(error) => {
                tracing::error!(error = ?error, "请求处理失败");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "服务器内部错误".to_owned(),
                )
            }
        };

        (
            status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code,
                    message,
                    details,
                    coded_details,
                },
            }),
        )
            .into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
