use anyhow::Context;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use std::path;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::state::{AppError, AppState};

pub(crate) async fn serve_app_js(State(state): State<AppState>) -> Result<Response, AppError> {
    let file = File::open(state.config.static_dir.join("app.js"))
        .await
        .context("failed to open app.js")?;
    let body = Body::from_stream(ReaderStream::new(file));
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        body,
    )
        .into_response())
}

pub(crate) async fn serve_styles_css(State(state): State<AppState>) -> Result<Response, AppError> {
    let file = File::open(state.config.static_dir.join("styles.css"))
        .await
        .context("failed to open styles.css")?;
    let body = Body::from_stream(ReaderStream::new(file));
    Ok((
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        body,
    )
        .into_response())
}

pub(crate) async fn serve_oauth_close(State(state): State<AppState>) -> Result<Response, AppError> {
    let file = File::open(state.config.static_dir.join("oauth-close.js"))
        .await
        .context("failed to open oauth-close.js")?;
    let body = Body::from_stream(ReaderStream::new(file));
    Ok((
        [
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response())
}

pub(crate) fn render_oauth_close_page() -> String {
    r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OAuth</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #0a0c10;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  p { font-size: 13px; color: #64748b; }
</style>
</head>
<body>
<p>Closing&hellip;</p>
<script src="/static/oauth-close.js"></script>
</body>
</html>"##
        .to_string()
}

pub(crate) async fn serve_font(
    Path(filename): Path<String>,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let file_path = path::Path::new(&filename);
    // Only allow .woff2 files with safe filenames (no path traversal)
    if file_path.extension().and_then(|e| e.to_str()) != Some("woff2")
        || file_path.file_name().map(path::Path::new) != Some(file_path)
    {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let fonts_dir = state.config.static_dir.join("fonts");
    let fonts_dir = match fonts_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(StatusCode::NOT_FOUND.into_response()),
    };
    let font_path = fonts_dir.join(file_path);
    let font_path = match font_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(StatusCode::NOT_FOUND.into_response()),
    };
    if !font_path.starts_with(&fonts_dir) {
        return Ok(StatusCode::NOT_FOUND.into_response());
    }
    let file = match File::open(&font_path).await {
        Ok(f) => f,
        Err(_) => return Ok(StatusCode::NOT_FOUND.into_response()),
    };
    let body = Body::from_stream(ReaderStream::new(file));
    Ok((
        [
            (header::CONTENT_TYPE, "font/woff2"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        body,
    )
        .into_response())
}
