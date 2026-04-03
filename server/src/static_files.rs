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
  .card {
    text-align: center;
    padding: 48px 40px;
    max-width: 380px;
    width: 100%;
  }
  .icon {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 20px;
  }
  .icon-success {
    background: rgba(52, 211, 153, 0.1);
    border: 1px solid rgba(52, 211, 153, 0.2);
  }
  .icon-error {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.2);
  }
  .icon svg {
    width: 24px;
    height: 24px;
  }
  .icon-success svg { color: #34d399; }
  .icon-error svg { color: #f87171; }
  #status {
    font-size: 16px;
    font-weight: 600;
    line-height: 1.5;
    margin-bottom: 8px;
  }
  #detail {
    font-size: 13px;
    color: #64748b;
    line-height: 1.5;
    margin-bottom: 24px;
  }
  #close-btn {
    display: none;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #e2e8f0;
    padding: 8px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  #close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.18);
  }
  @keyframes fade-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .card { animation: fade-in 0.3s ease-out; }
</style>
</head>
<body>
<div class="card">
  <div id="icon" class="icon icon-success">
    <svg id="icon-check" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
    <svg id="icon-x" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" style="display:none"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
  </div>
  <p id="status">Completing authorization&hellip;</p>
  <p id="detail">This window will close automatically.</p>
  <button id="close-btn" onclick="window.close()">Close window</button>
</div>
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
