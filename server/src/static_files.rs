use anyhow::Context;
use axum::{
    body::Body,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::state::{AppError, AppState};

pub(crate) struct StaticAssets {
    pub(crate) app_js_path: PathBuf,
    pub(crate) styles_css_path: PathBuf,
}

pub(crate) fn load_static_assets(static_dir: &Path) -> StaticAssets {
    StaticAssets {
        app_js_path: static_dir.join("app.js"),
        styles_css_path: static_dir.join("styles.css"),
    }
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
