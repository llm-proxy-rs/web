use anyhow::{Context, Result};
use axum::{
    Json,
    extract::{Query, State},
    response::IntoResponse,
};
use common::validate_within_dir;
use futures::future::BoxFuture;
use russh_sftp::client::{SftpSession, fs::DirEntry};
use serde::{Deserialize, Serialize};
use sftp_client::open_sftp_session;
use ssh_client::connect_ssh;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
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

#[derive(Deserialize)]
pub(crate) struct DeleteRequest {
    path: String,
}

pub(crate) async fn delete_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<DeleteRequest>,
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
            sftp.canonicalize(&body.path),
        )
        .await
        .context("canonicalize timed out")?
        .context("failed to resolve remote path")?,
    );
    validate_within_dir(&real_path, &state.config.upload_dir)?;
    // Prevent deleting the upload_dir itself
    if real_path == state.config.upload_dir {
        return Err(anyhow::anyhow!("cannot delete root upload directory").into());
    }
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
    if metadata.file_type().is_dir() {
        remove_dir_all(&sftp, &real_path, 10).await?;
    } else {
        timeout(
            Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
            sftp.remove_file(&real_path_str),
        )
        .await
        .context("remove_file timed out")?
        .context("failed to remove file")?;
    }
    Ok(Json(serde_json::json!({ "ok": true })).into_response())
}

fn remove_dir_all<'a>(
    sftp: &'a SftpSession,
    path: &'a Path,
    max_depth: usize,
) -> BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let path_str = path.to_str().context("path is not valid UTF-8")?;
        let entries: Vec<DirEntry> = timeout(
            Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
            sftp.read_dir(path_str),
        )
        .await
        .context("read_dir timed out")?
        .context("failed to read directory")?
        .collect();
        for entry in &entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let entry_path = path.join(&name);
            if entry.metadata().file_type().is_dir() {
                if max_depth == 0 {
                    anyhow::bail!("directory too deeply nested");
                }
                remove_dir_all(sftp, &entry_path, max_depth - 1).await?;
            } else {
                let entry_str = entry_path.to_str().context("path is not valid UTF-8")?;
                sftp.remove_file(entry_str)
                    .await
                    .context("failed to remove file")?;
            }
        }
        sftp.remove_dir(path_str)
            .await
            .context("failed to remove directory")?;
        Ok(())
    })
}
