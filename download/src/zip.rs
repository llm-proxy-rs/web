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
    match write_zip_entries(&sftp, &dir_path, &upload_dir, &mut zip).await {
        Err(err) => tracing::warn!("zip write failed: {err}"),
        Ok(()) => {
            if let Err(err) = zip.close().await.context("failed to close zip archive") {
                tracing::warn!("zip close failed: {err}");
            }
        }
    }
}

struct ZipContext<'a> {
    sftp: &'a SftpSession,
    dir_path: &'a Path,
    upload_dir: &'a Path,
    zip: &'a mut ZipFileWriter<DuplexStream>,
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
        let mut ctx = ZipContext {
            sftp,
            dir_path,
            upload_dir,
            zip,
        };
        for entry in read_dir {
            total_bytes += process_zip_entry(
                &mut ctx,
                &entry,
                &dir,
                depth,
                &mut dirs_to_visit,
                total_bytes,
            )
            .await?;
        }
    }
    Ok(())
}

async fn process_zip_entry(
    ctx: &mut ZipContext<'_>,
    entry: &russh_sftp::client::fs::DirEntry,
    dir: &Path,
    depth: usize,
    dirs_to_visit: &mut Vec<(PathBuf, usize)>,
    total_bytes: usize,
) -> Result<usize> {
    let file_name = entry.file_name();
    if file_name == "." || file_name == ".." {
        return Ok(0);
    }
    let child_path = dir.join(&file_name);
    if entry.file_type().is_symlink() {
        return Ok(0);
    }
    if validate_within_dir(&child_path, ctx.upload_dir).is_err() {
        return Ok(0);
    }
    if entry.file_type().is_dir() {
        if depth + 1 < MAX_ZIP_DEPTH {
            dirs_to_visit.push((child_path, depth + 1));
        }
        return Ok(0);
    }
    // No canonicalization needed: both paths share a consistent prefix from the traversal
    let relative = child_path
        .strip_prefix(ctx.dir_path)
        .unwrap_or(&child_path)
        .to_str()
        .context("file path is not valid UTF-8")?
        .to_owned();
    stream_sftp_file_to_zip_entry(ctx.sftp, &child_path, &relative, ctx.zip, total_bytes).await
}

async fn stream_sftp_file_to_zip_entry(
    sftp: &SftpSession,
    path: &Path,
    relative: &str,
    zip: &mut ZipFileWriter<DuplexStream>,
    total_bytes: usize,
) -> Result<usize> {
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
    let mut bytes_written: usize = 0;
    loop {
        let bytes_read = file
            .read(&mut buf)
            .await
            .context("failed to read remote file")?;
        if bytes_read == 0 {
            break;
        }
        bytes_written += bytes_read;
        if total_bytes + bytes_written > MAX_DOWNLOAD_BYTES {
            bail!("download size limit exceeded");
        }
        entry_writer
            .write_all(&buf[..bytes_read])
            .await
            .context("failed to write to zip entry")?;
    }
    entry_writer
        .close()
        .await
        .context("failed to close zip entry")?;
    Ok(bytes_written)
}
