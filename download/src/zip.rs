use anyhow::{Context, Result, bail};
use async_zip::tokio::write::ZipFileWriter;
use async_zip::{Compression, ZipEntryBuilder};
use axum::{
    body::Body,
    http::{HeaderValue, Response, header},
};
use common::validate_within_dir;
use futures_lite::io::AsyncWriteExt;
use russh_sftp::client::SftpSession;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, DuplexStream};
use tokio_util::io::ReaderStream;

const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024; // 100 MB
const MAX_ZIP_DEPTH: usize = 10;
const FILE_CHUNK_SIZE: usize = 64 * 1024; // 64 KB

pub fn build_streaming_zip_response(
    // owned because it is moved into the tokio::spawn future, which requires 'static — a
    // reference would not satisfy that bound, and SftpSession does not implement Clone.
    sftp: SftpSession,
    dir_path: &Path,
    upload_dir: &Path,
    filename: &str,
) -> Result<Response<Body>> {
    let (zip_writer, zip_reader) = tokio::io::duplex(FILE_CHUNK_SIZE);
    tokio::spawn(write_zip(
        sftp,
        dir_path.to_owned(),
        upload_dir.to_owned(),
        zip_writer,
    ));
    let content_disposition =
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .context("failed to build content disposition header")?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/zip")
        .header(header::CONTENT_DISPOSITION, content_disposition)
        .body(Body::from_stream(ReaderStream::new(zip_reader)))
        .context("failed to build zip response")
}

async fn write_zip(
    sftp: SftpSession,
    dir_path: PathBuf,
    upload_dir: PathBuf,
    writer: DuplexStream,
) {
    let mut zip = ZipFileWriter::with_tokio(writer);
    let result = write_zip_entries(&sftp, &dir_path, &upload_dir, &mut zip).await;
    let _ = zip.close().await;
    if let Err(e) = result {
        tracing::warn!("zip write failed: {e}");
    }
}

async fn write_zip_entries(
    sftp: &SftpSession,
    dir_path: &Path,
    upload_dir: &Path,
    zip: &mut ZipFileWriter<DuplexStream>,
) -> Result<()> {
    let mut total_bytes: usize = 0;
    let mut dirs_to_visit: Vec<(PathBuf, usize)> = vec![(dir_path.to_owned(), 0)];
    while let Some((dir, depth)) = dirs_to_visit.pop() {
        let dir_str = dir.to_str().context("directory path is not valid UTF-8")?;
        let read_dir = match sftp.read_dir(dir_str).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in read_dir {
            let file_name = entry.file_name();
            if file_name == "." || file_name == ".." {
                continue;
            }
            let child_path = dir.join(&file_name);
            if entry.file_type().is_symlink() {
                continue;
            }
            if validate_within_dir(&child_path, upload_dir).is_err() {
                continue;
            }
            if entry.file_type().is_dir() {
                if depth + 1 < MAX_ZIP_DEPTH {
                    dirs_to_visit.push((child_path, depth + 1));
                }
                continue;
            }
            // No canonicalization needed: both paths share a consistent prefix from the traversal
            let relative = child_path
                .strip_prefix(dir_path)
                .unwrap_or(&child_path)
                .to_str()
                .context("file path is not valid UTF-8")?
                .to_owned();
            stream_sftp_file_to_zip_entry(sftp, &child_path, &relative, zip, &mut total_bytes)
                .await?;
        }
    }
    Ok(())
}

async fn stream_sftp_file_to_zip_entry(
    sftp: &SftpSession,
    path: &Path,
    relative: &str,
    zip: &mut ZipFileWriter<DuplexStream>,
    total_bytes: &mut usize,
) -> Result<()> {
    let path_str = path.to_str().context("invalid file path")?;
    let mut file = sftp
        .open(path_str)
        .await
        .context("failed to open remote file")?;
    let entry = ZipEntryBuilder::new(relative.into(), Compression::Deflate);
    let mut entry_writer = zip
        .write_entry_stream(entry)
        .await
        .context("failed to start zip entry")?;
    let mut buf = vec![0u8; FILE_CHUNK_SIZE];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .context("failed to read remote file")?;
        if n == 0 {
            break;
        }
        *total_bytes += n;
        if *total_bytes > MAX_DOWNLOAD_BYTES {
            bail!("download size limit exceeded");
        }
        entry_writer
            .write_all(&buf[..n])
            .await
            .context("failed to write to zip entry")?;
    }
    entry_writer
        .close()
        .await
        .context("failed to close zip entry")?;
    Ok(())
}
