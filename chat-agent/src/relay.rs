use anyhow::{Context, Result};
use bytes::Bytes;
use futures::stream::Stream;
use russh::{Channel, ChannelMsg, client};
use ssh_client::SshClient;
use std::{net::Ipv4Addr, path::PathBuf};
use tokio::{
    sync::mpsc,
    time::{Duration, interval, timeout},
};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{error, info};

use crate::{AgentMessage, channel::connect_ssh_and_open_channel};

const HEARTBEAT_SECS: u64 = 60;
const SEND_TIMEOUT_SECS: u64 = 30;
const SSE_CHANNEL_CAPACITY: usize = 16;

pub fn stream_task_sse(
    guest_ip: Ipv4Addr,
    ssh_key_path: PathBuf,
    ssh_user: String,
    vm_host_key_path: PathBuf,
    message: AgentMessage,
) -> impl Stream<Item = Bytes> + use<> {
    let (tx, rx) = mpsc::channel::<Bytes>(SSE_CHANNEL_CAPACITY);
    tokio::spawn(run_task_stream(
        guest_ip,
        ssh_key_path,
        ssh_user,
        vm_host_key_path,
        message,
        tx,
    ));
    ReceiverStream::new(rx)
}

async fn run_task_stream(
    guest_ip: Ipv4Addr,
    ssh_key_path: PathBuf,
    ssh_user: String,
    vm_host_key_path: PathBuf,
    message: AgentMessage,
    tx: mpsc::Sender<Bytes>,
) {
    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    // connect_ssh retries the TCP connection for up to 60s (VM SSH daemon may still be starting),
    // then open_agent_channel retries the Unix socket for another 60s (agent process may still be
    // starting). Total worst-case connect time is ~120s.
    let connect_future =
        connect_ssh_and_open_channel(guest_ip, &ssh_key_path, &ssh_user, &vm_host_key_path);
    tokio::pin!(connect_future);
    let connect_result = loop {
        tokio::select! {
            result = &mut connect_future => break result,
            _ = heartbeat.tick() => {
                if !send_sse(&tx, Bytes::from_static(b": keep-alive\n\n")).await {
                    return;
                }
            }
        }
    };
    match connect_result {
        Err(e) => {
            send_sse(&tx, build_sse_error_event(e)).await;
        }
        Ok((ssh_handle, ssh_channel)) => {
            let line = match serde_json::to_string(&message) {
                Ok(s) => format!("{s}\n"),
                Err(e) => {
                    send_sse(
                        &tx,
                        build_sse_error_event(anyhow::anyhow!("failed to serialize message: {e}")),
                    )
                    .await;
                    return;
                }
            };
            if let Err(e) = ssh_channel
                .data(Bytes::from(line).as_ref())
                .await
                .context("failed to write message to agent socket")
            {
                send_sse(&tx, build_sse_error_event(e)).await;
                return;
            }
            if let Err(e) = stream_ssh_channel(ssh_handle, ssh_channel, &tx).await {
                send_sse(&tx, build_sse_error_event(e)).await;
            }
        }
    }
}

async fn send_sse(tx: &mpsc::Sender<Bytes>, data: Bytes) -> bool {
    match timeout(Duration::from_secs(SEND_TIMEOUT_SECS), tx.send(data)).await {
        Ok(Ok(())) => true,
        Ok(Err(_)) => false,
        Err(_) => {
            error!("sse send timed out");
            false
        }
    }
}

fn build_sse_error_event(e: anyhow::Error) -> Bytes {
    let payload = serde_json::json!({ "message": e.to_string() });
    Bytes::from(format!(
        "event: error_event\ndata: {}\n\n",
        serde_json::to_string(&payload).unwrap_or_default()
    ))
}

async fn stream_ssh_channel(
    _ssh_handle: client::Handle<SshClient>,
    mut ssh_channel: Channel<client::Msg>,
    tx: &mpsc::Sender<Bytes>,
) -> Result<()> {
    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    loop {
        tokio::select! {
            msg = ssh_channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        info!("received stdout from agent");
                        if !send_sse(tx, Bytes::copy_from_slice(data)).await {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { .. }) => {}
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        info!("agent exited  status={exit_status}");
                        break;
                    }
                    None => {
                        info!("ssh channel closed");
                        break;
                    }
                    Some(other) => {
                        info!("unexpected ssh channel message  msg={other:?}");
                    }
                }
            }
            _ = heartbeat.tick() => {
                if !send_sse(tx, Bytes::from_static(b": keep-alive\n\n")).await {
                    break;
                }
            }
        }
    }
    info!("agent stream ended");
    Ok(())
}
