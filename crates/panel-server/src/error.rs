use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{1}")]
    BadRequest(&'static str, String),
    #[error("未登录或会话已失效")]
    Unauthorized,
    #[error("CSRF 校验失败")]
    Forbidden,
    #[error("{1}")]
    Conflict(&'static str, String),
    #[error("{1}")]
    NotFound(&'static str, String),
    #[error("请求过于频繁，请稍后重试")]
    TooManyRequests,
    #[error("{1}")]
    Unprocessable(&'static str, String),
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
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Self::BadRequest(code, message) => (StatusCode::BAD_REQUEST, code, message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "未登录或会话已失效".to_owned(),
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
                "请求过于频繁，请稍后重试".to_owned(),
            ),
            Self::Unprocessable(code, message) => (StatusCode::UNPROCESSABLE_ENTITY, code, message),
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
                error: ErrorBody { code, message },
            }),
        )
            .into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
