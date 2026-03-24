use anyhow::{Context, Result};
use common::validate_within_dir;
use russh_sftp::client::SftpSession;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncWriteExt, copy};

pub async fn write_file_via_sftp(
    sftp: &SftpSession,
    remote_path: &Path,
    upload_dir: &Path,
    source: &mut (impl AsyncRead + Unpin),
) -> Result<()> {
    let resolved = resolve_upload_path(sftp, remote_path, upload_dir).await?;
    let resolved_str = resolved
        .to_str()
        .context("resolved path is not valid UTF-8")?;
    let mut file = sftp
        .create(resolved_str)
        .await
        .context("failed to create remote file")?;
    copy(source, &mut file)
        .await
        .context("failed to write file data")?;
    file.shutdown()
        .await
        .context("failed to close remote file")?;
    Ok(())
}

async fn resolve_upload_path(
    sftp: &SftpSession,
    remote_path: &Path,
    upload_dir: &Path,
) -> Result<PathBuf> {
    let parent = remote_path
        .parent()
        .and_then(|p| p.to_str())
        .context("upload path has no valid parent directory")?;
    let filename = remote_path
        .file_name()
        .context("upload path has no filename")?;
    let canonical_parent = sftp
        .canonicalize(parent)
        .await
        .context("failed to resolve upload directory")?;
    let resolved = PathBuf::from(canonical_parent).join(filename);
    validate_within_dir(&resolved, upload_dir)?;
    Ok(resolved)
}
