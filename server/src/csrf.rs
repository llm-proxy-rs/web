use anyhow::{Context, Result};
use axum::{
    extract::Request,
    http::{Method, StatusCode, header::HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rand::RngCore;
use subtle::ConstantTimeEq;
use tower_sessions::Session;

pub(crate) async fn csrf_middleware(session: Session, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    if method == Method::GET || method == Method::HEAD || method == Method::OPTIONS {
        return next.run(request).await;
    }
    let submitted = match request
        .headers()
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
    {
        Some(token) => token.to_owned(),
        None => return (StatusCode::FORBIDDEN, "Forbidden").into_response(),
    };
    // Atomically consume the stored token so it cannot be reused.
    let stored = match session.remove::<String>("csrf_token").await {
        Ok(Some(s)) => s,
        Ok(None) => return (StatusCode::FORBIDDEN, "Forbidden").into_response(),
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response(),
    };
    if !constant_time_eq(&stored, &submitted) {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    // Rotate: generate a fresh token for the next request.
    let new_token = generate_token();
    if session.insert("csrf_token", &new_token).await.is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response();
    }
    let mut response = next.run(request).await;
    attach_csrf_token(&mut response, &new_token);
    response
}

pub(crate) async fn get_csrf_token(session: &Session) -> Result<String> {
    let token = session
        .remove::<String>("csrf_token")
        .await
        .context("failed to read csrf_token from session")?
        .unwrap_or_else(generate_token);
    session
        .insert("csrf_token", &token)
        .await
        .context("failed to store CSRF token")?;
    Ok(token)
}

fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.as_bytes().ct_eq(b.as_bytes()).unwrap_u8() == 1
}

fn attach_csrf_token<B>(response: &mut axum::http::Response<B>, csrf_token: &str) {
    if let Ok(value) = csrf_token.parse::<HeaderValue>() {
        response.headers_mut().insert("x-csrf-token", value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Response as HttpResponse;
    use std::collections::HashSet;

    // --- constant_time_eq tests ---

    #[test]
    fn constant_time_eq_equal_strings() {
        assert!(constant_time_eq("hello", "hello"));
    }

    #[test]
    fn constant_time_eq_unequal_strings() {
        assert!(!constant_time_eq("hello", "world"));
    }

    #[test]
    fn constant_time_eq_different_lengths() {
        assert!(!constant_time_eq("short", "longer_string"));
    }

    #[test]
    fn constant_time_eq_empty_strings() {
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn constant_time_eq_single_char() {
        assert!(constant_time_eq("a", "a"));
        assert!(!constant_time_eq("a", "b"));
    }

    #[test]
    fn constant_time_eq_one_empty() {
        assert!(!constant_time_eq("", "a"));
        assert!(!constant_time_eq("a", ""));
    }

    // --- generate_token tests ---

    #[test]
    fn generate_token_is_64_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn generate_token_no_hyphens() {
        let token = generate_token();
        assert!(!token.contains('-'));
    }

    #[test]
    fn generate_token_is_unique_each_call() {
        let mut tokens = HashSet::new();
        for _ in 0..100 {
            tokens.insert(generate_token());
        }
        assert_eq!(tokens.len(), 100);
    }

    // --- attach_csrf_token tests ---

    #[test]
    fn attach_csrf_token_sets_header() {
        let mut response = HttpResponse::builder().body(()).unwrap();
        let token = "abc123def456";
        attach_csrf_token(&mut response, token);
        assert_eq!(
            response
                .headers()
                .get("x-csrf-token")
                .unwrap()
                .to_str()
                .unwrap(),
            token
        );
    }

    #[test]
    fn attach_csrf_token_overwrites_existing_header() {
        let mut response = HttpResponse::builder()
            .header("x-csrf-token", "old_value")
            .body(())
            .unwrap();
        attach_csrf_token(&mut response, "new_value");
        assert_eq!(
            response
                .headers()
                .get("x-csrf-token")
                .unwrap()
                .to_str()
                .unwrap(),
            "new_value"
        );
    }
}
