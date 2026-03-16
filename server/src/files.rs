use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use common::validate_within_dir;
use russh_sftp::client::fs::DirEntry;
use serde::{Deserialize, Serialize};
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
pub(crate) struct ListQuery {
    path: String,
}

#[derive(Serialize)]
struct FileEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
struct ListResponse {
    entries: Vec<FileEntry>,
}

pub(crate) async fn list_files_handler(
    user_vm: UserVm,
    Query(query): Query<ListQuery>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
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
    validate_within_dir(&real_path, &state.config.upload_dir)?;
    let real_path_str = real_path
        .to_str()
        .context("resolved path is not valid UTF-8")?
        .to_owned();
    let read_dir = timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        sftp.read_dir(&real_path_str),
    )
    .await
    .context("read_dir timed out")?
    .context("failed to read remote directory")?;
    let entries = collect_file_entries(read_dir.collect()).await?;
    Ok(Json(ListResponse { entries }).into_response())
}

async fn collect_file_entries(raw_entries: Vec<DirEntry>) -> Result<Vec<FileEntry>> {
    let mut dirs: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();
    for entry in raw_entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let metadata = entry.metadata();
        let is_dir = metadata.file_type().is_dir();
        let size = metadata.size.context("missing file size")?;
        let file_entry = FileEntry { name, is_dir, size };
        if is_dir {
            dirs.push(file_entry);
        } else {
            files.push(file_entry);
        }
    }
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.extend(files);
    Ok(dirs)
}
