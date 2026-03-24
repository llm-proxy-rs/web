use anyhow::Context;
use axum::{
    extract::{Query, State},
    http::Response,
};
use common::validate_within_dir;
use download::{file::build_streaming_file_response, zip::build_streaming_zip_response};
use serde::Deserialize;
use sftp_client::open_sftp_session;
use ssh_client::connect_ssh;
use std::{path::PathBuf, time::Duration};
use tokio::time::timeout;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState},
};

const SFTP_OP_TIMEOUT_SECS: u64 = 30;

#[derive(Deserialize)]
pub(crate) struct DownloadQuery {
    path: String,
}

pub(crate) async fn download_file_handler(
    user_vm: UserVm,
    Query(query): Query<DownloadQuery>,
    State(state): State<AppState>,
) -> Result<Response<axum::body::Body>, AppError> {
    let mut ssh_handle = connect_ssh(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
    )
    .await?;
    let sftp = open_sftp_session(&mut ssh_handle).await?;
    let real_path = PathBuf::from(
        timeout(
            Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
            sftp.canonicalize(&query.path),
        )
        .await
        .context("canonicalize timed out")?
        .context("failed to resolve remote path")?,
    );
    let upload_dir = &state.config.upload_dir;
    validate_within_dir(&real_path, upload_dir)?;
    let real_path_str = real_path
        .to_str()
        .context("resolved path is not valid UTF-8")?
        .to_owned();
    let metadata = timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        sftp.symlink_metadata(&real_path_str),
    )
    .await
    .context("symlink_metadata timed out")?
    .context("failed to stat remote path")?;
    if metadata.is_dir() {
        let dirname = real_path
            .file_name()
            .and_then(|f| f.to_str())
            .context("path has no final component")?
            .to_owned();
        Ok(build_streaming_zip_response(
            sftp,
            &real_path,
            upload_dir,
            &format!("{dirname}.zip"),
        )?)
    } else {
        Ok(build_streaming_file_response(sftp, &real_path)
            .await
            .context("failed to build file response")?)
    }
}
