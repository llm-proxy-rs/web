use anyhow::Result;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use ssh_client::SshClient;

pub async fn open_sftp_session(ssh_handle: &mut Handle<SshClient>) -> Result<SftpSession> {
    let ssh_channel = ssh_handle.channel_open_session().await?;
    ssh_channel.request_subsystem(true, "sftp").await?;
    let sftp_session = SftpSession::new(ssh_channel.into_stream()).await?;
    Ok(sftp_session)
}
