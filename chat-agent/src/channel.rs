use anyhow::{Context, Result};
use bytes::Bytes;
use russh::{Channel, client};
use ssh_client::{SshClient, connect_ssh};
use std::net::Ipv4Addr;
use std::path::Path;
use tokio::time::{Duration, sleep, timeout};
use tracing::info;

use crate::AgentMessage;

const AGENT_SOCKET_WAIT_SECS: u64 = 60;

pub struct SshConnection {
    pub ssh_handle: client::Handle<SshClient>,
    pub ssh_channel: Channel<client::Msg>,
}

pub async fn connect_ssh_and_open_channel(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<SshConnection> {
    let ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    info!("agent ssh connected");
    let ssh_channel = open_agent_channel(&ssh_handle).await?;
    Ok(SshConnection {
        ssh_handle,
        ssh_channel,
    })
}

pub async fn send_agent_message(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    message: &AgentMessage,
) -> Result<()> {
    let conn =
        connect_ssh_and_open_channel(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let line = format!(
        "{}\n",
        serde_json::to_string(message).context("failed to serialize agent message")?
    );
    conn.ssh_channel
        .data(Bytes::from(line).as_ref())
        .await
        .context("failed to write to agent socket")?;
    Ok(())
}

async fn open_agent_channel(
    ssh_handle: &client::Handle<SshClient>,
) -> Result<Channel<client::Msg>> {
    timeout(
        Duration::from_secs(AGENT_SOCKET_WAIT_SECS),
        poll_agent_channel(ssh_handle),
    )
    .await
    .context("timed out waiting for agent socket")?
}

async fn poll_agent_channel(
    ssh_handle: &client::Handle<SshClient>,
) -> Result<Channel<client::Msg>> {
    loop {
        match ssh_handle
            .channel_open_direct_streamlocal("/tmp/agent.sock")
            .await
        {
            Ok(channel) => {
                info!("agent socket channel opened");
                return Ok(channel);
            }
            Err(_) => {
                sleep(Duration::from_millis(500)).await;
            }
        }
    }
}
