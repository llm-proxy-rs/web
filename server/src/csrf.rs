use anyhow::{Context, Result};
use axum::{
    extract::Request,
    http::{Method, StatusCode, header::HeaderValue},
    middleware::Next,
    response::{IntoResponse, Response},
};
use subtle::ConstantTimeEq;
use tower_sessions::Session;
use uuid::Uuid;

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
    let new_token = match validate_csrf(&session, &submitted).await {
        Ok(Some(token)) => token,
        Ok(None) => return (StatusCode::FORBIDDEN, "Forbidden").into_response(),
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Internal error").into_response(),
    };
    let mut response = next.run(request).await;
    attach_csrf_token(&mut response, &new_token);
    response
}

pub(crate) async fn get_csrf_token(session: &Session) -> Result<String> {
    let token = session
        .get::<String>("csrf_token")
        .await
        .context("failed to read csrf_token from session")?
        .unwrap_or_else(|| Uuid::new_v4().to_string().replace('-', ""));
    session
        .insert("csrf_token", &token)
        .await
        .context("failed to store CSRF token")?;
    Ok(token)
}

async fn validate_csrf(session: &Session, submitted: &str) -> Result<Option<String>> {
    let stored = match session
        .get::<String>("csrf_token")
        .await
        .context("failed to read CSRF token from session")?
    {
        Some(s) => s,
        None => return Ok(None),
    };
    if stored.len() != submitted.len()
        || stored.as_bytes().ct_eq(submitted.as_bytes()).unwrap_u8() != 1
    {
        return Ok(None);
    }
    let new_token = Uuid::new_v4().to_string().replace('-', "");
    session
        .insert("csrf_token", &new_token)
        .await
        .context("failed to store CSRF token")?;
    Ok(Some(new_token))
}

fn attach_csrf_token(response: &mut Response, csrf_token: &str) {
    if let Ok(value) = csrf_token.parse::<HeaderValue>() {
        response.headers_mut().insert("x-csrf-token", value);
    }
}
