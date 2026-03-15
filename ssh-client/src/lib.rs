use anyhow::{Context, Result, bail};
use chrono::{TimeDelta, Utc};
use russh::{
    Channel,
    client::{Config, Handle, Handler, Msg, connect},
    keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey, load_public_key, load_secret_key},
};
use std::{
    future::Future,
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};

const TERMINAL_EXEC_CMD: &str = "bash -ic 'claude; exec bash'";

pub struct SshClient {
    vm_host_key: Option<PublicKey>,
}

impl Handler for SshClient {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        let matches = self
            .vm_host_key
            .as_ref()
            .map_or(true, |key| server_public_key == key);
        async move { Ok(matches) }
    }
}

pub async fn connect_ssh(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<Handle<SshClient>> {
    let vm_host_key = load_vm_host_key(vm_host_key_path)?;
    let ssh_keypair = Arc::new(load_ssh_keypair(ssh_key_path)?);
    let ssh_config = Arc::new(Config::default());
    let guest_addr = SocketAddr::from((guest_ip, 22));
    let connect_deadline = Utc::now()
        .checked_add_signed(TimeDelta::seconds(60))
        .context("connect deadline overflow")?;
    let mut ssh_handle = loop {
        let ssh_client = SshClient {
            vm_host_key: vm_host_key.clone(),
        };
        match connect(ssh_config.clone(), guest_addr, ssh_client).await {
            Ok(ssh_handle) => break ssh_handle,
            Err(_) if Utc::now() < connect_deadline => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(connect_error) => bail!("SSH connect timed out: {connect_error}"),
        }
    };
    authenticate_ssh_handle(&mut ssh_handle, ssh_user, ssh_keypair).await?;
    Ok(ssh_handle)
}

fn load_vm_host_key(vm_host_key_path: &Path) -> Result<Option<PublicKey>> {
    if vm_host_key_path.as_os_str().is_empty() {
        return Ok(None);
    }
    let vm_host_key = load_public_key(vm_host_key_path).context("failed to load VM host key")?;
    Ok(Some(vm_host_key))
}

fn load_ssh_keypair(ssh_key_path: &Path) -> Result<PrivateKey> {
    load_secret_key(ssh_key_path, None).context("failed to load SSH key")
}

async fn authenticate_ssh_handle(
    ssh_handle: &mut Handle<SshClient>,
    ssh_user: &str,
    ssh_keypair: Arc<PrivateKey>,
) -> Result<()> {
    let auth_result = ssh_handle
        .authenticate_publickey(ssh_user, PrivateKeyWithHashAlg::new(ssh_keypair, None))
        .await?;
    if !auth_result.success() {
        bail!("SSH authentication rejected for user={ssh_user}");
    }
    Ok(())
}

pub async fn open_terminal_channel(ssh_handle: &mut Handle<SshClient>) -> Result<Channel<Msg>> {
    let ssh_channel = ssh_handle.channel_open_session().await?;
    ssh_channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await?;
    ssh_channel.exec(false, TERMINAL_EXEC_CMD).await?;
    Ok(ssh_channel)
}

pub async fn open_exec_channel(
    ssh_handle: &mut Handle<SshClient>,
    command: &str,
) -> Result<Channel<Msg>> {
    let ssh_channel = ssh_handle.channel_open_session().await?;
    ssh_channel.exec(false, command).await?;
    Ok(ssh_channel)
}

pub async fn open_direct_streamlocal_channel(
    ssh_handle: &Handle<SshClient>,
    socket_path: &str,
) -> Result<Channel<Msg>> {
    ssh_handle
        .channel_open_direct_streamlocal(socket_path)
        .await
        .with_context(|| format!("failed to open direct-streamlocal channel to {socket_path}"))
}
