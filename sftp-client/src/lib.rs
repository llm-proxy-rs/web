use anyhow::{Context, Result};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use ssh_client::SshClient;
use std::time::Duration;
use tokio::time::timeout;

const SFTP_OP_TIMEOUT_SECS: u64 = 30;

pub async fn open_sftp_session(ssh_handle: &mut Handle<SshClient>) -> Result<SftpSession> {
    let ssh_channel = timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        ssh_handle.channel_open_session(),
    )
    .await
    .context("channel open timed out")?
    .context("channel open failed")?;
    timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        ssh_channel.request_subsystem(true, "sftp"),
    )
    .await
    .context("SFTP subsystem request timed out")?
    .context("SFTP subsystem request failed")?;
    let sftp_session = timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        SftpSession::new(ssh_channel.into_stream()),
    )
    .await
    .context("SFTP session init timed out")?
    .context("SFTP session init failed")?;
    Ok(sftp_session)
}
