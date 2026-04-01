use anyhow::{Context, Result};
use bytes::Bytes;
use futures::stream::Stream;
use russh::{Channel, ChannelMsg, client};
use ssh_client::SshClient;
use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
};
use tokio::{
    sync::mpsc,
    time::{Duration, interval, timeout},
};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{error, info, warn};

use crate::{
    AgentMessage,
    channel::{SshConnection, connect_ssh_and_open_channel},
};

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
    tokio::spawn(async move {
        if let Err(e) = run_task_stream(
            guest_ip,
            &ssh_key_path,
            &ssh_user,
            &vm_host_key_path,
            message,
            tx.clone(),
        )
        .await
        {
            send_sse_error(&tx, e).await;
        }
    });
    ReceiverStream::new(rx)
}

async fn run_task_stream(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    message: AgentMessage,
    tx: mpsc::Sender<Bytes>,
) -> Result<()> {
    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await;
    // connect_ssh retries the TCP connection for up to 60s (VM SSH daemon may still be starting),
    // then open_agent_channel retries the Unix socket for another 60s (agent process may still be
    // starting). Total worst-case connect time is ~120s.
    let connect_future =
        connect_ssh_and_open_channel(guest_ip, ssh_key_path, ssh_user, vm_host_key_path);
    tokio::pin!(connect_future);
    let connect_result = loop {
        tokio::select! {
            result = &mut connect_future => break result,
            _ = heartbeat.tick() => {
                if !send_sse(&tx, Bytes::from_static(b": keep-alive\n\n")).await {
                    return Ok(());
                }
            }
            _ = tx.closed() => {
                info!("client disconnected during connect");
                return Ok(());
            }
        }
    };
    match connect_result {
        Err(e) => {
            send_sse_error(&tx, e).await;
        }
        Ok(conn) => {
            stream_ssh_output(conn, &message, &tx).await;
        }
    }
    Ok(())
}

async fn stream_ssh_output(conn: SshConnection, message: &AgentMessage, tx: &mpsc::Sender<Bytes>) {
    let line = match serde_json::to_string(message) {
        Ok(s) => format!("{s}\n"),
        Err(_) => {
            send_sse_error(tx, anyhow::anyhow!("failed to serialize message")).await;
            return;
        }
    };
    if let Err(e) = conn
        .ssh_channel
        .data(Bytes::from(line).as_ref())
        .await
        .context("failed to write message to agent socket")
    {
        send_sse_error(tx, e).await;
        return;
    }
    if let Err(e) = stream_ssh_channel(conn.ssh_handle, conn.ssh_channel, tx).await {
        send_sse_error(tx, e).await;
    }
}

async fn send_sse_error(tx: &mpsc::Sender<Bytes>, e: anyhow::Error) {
    error!("task stream error");
    match build_sse_error_event(e) {
        Ok(event) => {
            send_sse(tx, event).await;
        }
        Err(_) => warn!("failed to build sse error event"),
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

fn build_sse_error_event(e: anyhow::Error) -> Result<Bytes> {
    let payload = serde_json::json!({ "message": e.to_string() });
    let serialized = serde_json::to_string(&payload)?;
    Ok(Bytes::from(format!(
        "event: error_event\ndata: {serialized}\n\n"
    )))
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
                        let is_terminal = data_contains_terminal_event(data);
                        if !send_sse(tx, Bytes::copy_from_slice(data)).await {
                            break;
                        }
                        // Stop streaming after forwarding done/error — the task
                        // is finished and the client doesn't need more data.
                        if is_terminal {
                            info!("terminal event forwarded, closing stream");
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
            // Detect when the HTTP response body (receiver) is dropped —
            // e.g. client disconnected or frontend aborted the request.
            _ = tx.closed() => {
                info!("client disconnected, closing agent stream");
                break;
            }
        }
    }
    info!("agent stream ended");
    Ok(())
}

/// Check if the raw SSE data contains a `done` or `error_event` line,
/// indicating the task is finished and the stream should close.
fn data_contains_terminal_event(data: &[u8]) -> bool {
    data.windows(b"event: done\n".len())
        .any(|w| w == b"event: done\n")
        || data
            .windows(b"event: error_event\n".len())
            .any(|w| w == b"event: error_event\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_event_done() {
        assert!(data_contains_terminal_event(b"event: done\n"));
    }

    #[test]
    fn terminal_event_error() {
        assert!(data_contains_terminal_event(b"event: error_event\n"));
    }

    #[test]
    fn terminal_event_random_data() {
        assert!(!data_contains_terminal_event(b"some random data here"));
    }

    #[test]
    fn terminal_event_embedded_in_larger_data() {
        assert!(data_contains_terminal_event(
            b"data: {\"foo\":1}\n\nevent: done\ndata: {}\n\n"
        ));
        assert!(data_contains_terminal_event(
            b"data: {\"bar\":2}\n\nevent: error_event\ndata: {}\n\n"
        ));
    }

    #[test]
    fn terminal_event_empty_data() {
        assert!(!data_contains_terminal_event(b""));
    }

    #[test]
    fn build_sse_error_event_produces_valid_sse() {
        let err = anyhow::anyhow!("something went wrong");
        let result = build_sse_error_event(err).unwrap();
        let s = std::str::from_utf8(&result).unwrap();
        assert!(s.starts_with("event: error_event\n"));
        assert!(s.contains("data: "));
        assert!(s.ends_with("\n\n"));
        // Verify the data portion is valid JSON containing the message
        let data_line = s.lines().find(|l| l.starts_with("data: ")).unwrap();
        let json_str = data_line.strip_prefix("data: ").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json_str).unwrap();
        assert_eq!(parsed["message"], "something went wrong");
    }
}
