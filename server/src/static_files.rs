use crate::state::{AppError, AppState};
use anyhow::Context;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use std::path::{self, PathBuf};
use tokio::fs::File;
use tokio_util::io::ReaderStream;

pub(crate) struct StaticAssets {
    pub(crate) app_js_path: PathBuf,
    pub(crate) styles_css_path: PathBuf,
    pub(crate) fonts_dir: PathBuf,
}

pub(crate) fn load_static_assets(static_dir: &path::Path) -> anyhow::Result<StaticAssets> {
    let fonts_dir = static_dir.join("fonts");
    let fonts_dir = fonts_dir
        .canonicalize()
        .context("fonts directory does not exist")?;
    Ok(StaticAssets {
        app_js_path: static_dir.join("app.js"),
        styles_css_path: static_dir.join("styles.css"),
        fonts_dir,
    })
}

pub(crate) async fn serve_app_js(State(state): State<AppState>) -> Result<Response, AppError> {
    let file = File::open(&state.static_assets.app_js_path)
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
    let file = File::open(&state.static_assets.styles_css_path)
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
    let font_path = state.static_assets.fonts_dir.join(file_path);
    let font_path = match font_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(StatusCode::NOT_FOUND.into_response()),
    };
    if !font_path.starts_with(&state.static_assets.fonts_dir) {
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
