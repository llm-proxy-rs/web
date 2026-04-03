use anyhow::{Context, Result, bail};
use axum::{
    Error as AxumError,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::{SinkExt, StreamExt, stream::SplitSink};
use russh::{Channel, ChannelMsg, client::Msg};
use ssh_client::{connect_ssh, open_terminal_channel};
use std::{net::Ipv4Addr, time::Duration};
use tokio::time::timeout;
use tracing::{error, info, warn};
use url::Url;
use uuid::Uuid;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState, update_vm_last_activity},
};

const SEND_TIMEOUT_SECS: u64 = 30;

pub(crate) async fn handle_ws_upgrade(
    user_vm: UserVm,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    // Validate Origin header to prevent cross-site WebSocket hijacking.
    // Browsers always send Origin on WebSocket upgrades; reject if it
    // doesn't match the Host header.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok())
        && let Ok(origin_url) = Url::parse(origin)
        && let Some(host) = headers.get("host").and_then(|v| v.to_str().ok())
    {
        let Some(origin_name) = origin_url.host_str() else {
            warn!("ws origin has no host");
            return Ok((StatusCode::FORBIDDEN, "Origin mismatch").into_response());
        };
        // Host header is just hostname[:port], not a full URL
        let host_name = host.split(':').next().unwrap_or(host);
        if origin_name != host_name {
            warn!("ws origin mismatch");
            return Ok((StatusCode::FORBIDDEN, "Origin mismatch").into_response());
        }
    }
    let vm_id = user_vm.vm_id.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        run_terminal_session(socket, &state, &vm_id, user_vm.user_id, user_vm.guest_ip).await
    }))
}

async fn run_terminal_session(
    ws: WebSocket,
    state: &AppState,
    vm_id: &str,
    user_id: Uuid,
    guest_ip: Ipv4Addr,
) {
    if update_vm_last_activity(&state.vms, vm_id).is_err() {
        error!("vm registry lock poisoned, aborting terminal session");
        return;
    }
    if run_ssh_relay(guest_ip, state, vm_id, ws).await.is_err() {
        error!("terminal session error");
    }
    if save_and_drop_vm(state, vm_id, user_id).await.is_err() {
        error!("save and drop vm failed");
    }
}

async fn save_and_drop_vm(state: &AppState, vm_id: &str, user_id: Uuid) -> Result<()> {
    let vm_entry = {
        let mut registry = state
            .vms
            .lock()
            .map_err(|_| anyhow::anyhow!("vm registry lock poisoned on disconnect"))?;

        // Mark the user as "provisioning" BEFORE removing the VM from the
        // registry.  This prevents a race where the frontend polls
        // /api/vm-status, sees no VM (registry empty), and triggers a new
        // provisioning while the old VM's stop() + Drop cleanup is still
        // running — which causes "Text file busy" and "Cannot find device
        // tap" errors.
        if let Ok(mut provisioning) = state.provisioning_users.lock() {
            provisioning.insert(user_id);
        }

        registry.remove(vm_id)
    };
    if let Some(vm_entry) = vm_entry {
        info!("stopping vm on disconnect");
        // Stop the VM and wait for the process to fully exit before
        // dropping. This ensures cleanup_chroot + release_net_idx in
        // Vm::Drop run before a new VM can be provisioned for the same
        // user (preventing "Text file busy" and tap index conflicts).
        vm_entry.vm.stop().await;
        drop(vm_entry);
    }

    // Release the provisioning guard so a new VM can be created for this user.
    if let Ok(mut provisioning) = state.provisioning_users.lock() {
        provisioning.remove(&user_id);
    }

    Ok(())
}

async fn run_ssh_relay(
    guest_ip: Ipv4Addr,
    state: &AppState,
    vm_id: &str,
    ws: WebSocket,
) -> Result<()> {
    let mut ssh_handle = connect_ssh(
        guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
    )
    .await
    .context("ssh connect failed")?;
    let mut ssh_channel = open_terminal_channel(&mut ssh_handle)
        .await
        .context("open terminal channel failed")?;
    let (mut ws_sender, ws_receiver) = ws.split();
    let (ws_tx, mut ws_rx) = tokio::sync::mpsc::channel(4);
    tokio::spawn(async move {
        let mut ws_receiver = ws_receiver;
        while let Some(msg) = ws_receiver.next().await {
            match timeout(Duration::from_secs(SEND_TIMEOUT_SECS), ws_tx.send(msg)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => break,
                Err(_) => {
                    warn!("ws mpsc send timed out, consumer likely stuck");
                    break;
                }
            }
        }
    });
    let mut keepalive = tokio::time::interval(Duration::from_secs(30));
    keepalive.tick().await; // skip the immediate first tick
    loop {
        tokio::select! {
            msg = ssh_channel.wait() => {
                relay_ssh_to_ws(msg, &mut ws_sender).await?;
                let _ = update_vm_last_activity(&state.vms, vm_id);
            }
            ws_msg = ws_rx.recv() => {
                relay_ws_to_ssh(ws_msg, &mut ssh_channel, &mut ws_sender).await?;
                let _ = update_vm_last_activity(&state.vms, vm_id);
            }
            _ = keepalive.tick() => {
                send_ws_keepalive(&mut ws_sender).await?;
                let _ = update_vm_last_activity(&state.vms, vm_id);
            }
        }
    }
}

async fn relay_ssh_to_ws(
    msg: Option<ChannelMsg>,
    ws_sender: &mut SplitSink<WebSocket, Message>,
) -> Result<()> {
    match msg {
        Some(ChannelMsg::Data { ref data }) => {
            timeout(
                Duration::from_secs(SEND_TIMEOUT_SECS),
                ws_sender.send(Message::Binary(Bytes::copy_from_slice(data))),
            )
            .await
            .context("ws send timed out, consumer likely stuck")?
            .context("ws receiver dropped")?;
            Ok(())
        }
        Some(ChannelMsg::ExitStatus { .. }) | None => bail!("ssh channel closed"),
        _ => Ok(()),
    }
}

async fn relay_ws_to_ssh(
    msg: Option<Result<Message, AxumError>>,
    ssh_channel: &mut Channel<Msg>,
    ws_sender: &mut SplitSink<WebSocket, Message>,
) -> Result<()> {
    match msg {
        Some(Ok(Message::Binary(data))) => {
            timeout(
                Duration::from_secs(SEND_TIMEOUT_SECS),
                ssh_channel.data(&data[..]),
            )
            .await
            .context("ssh channel send timed out, consumer likely stuck")?
            .context("ssh channel closed")?;
            Ok(())
        }
        Some(Ok(Message::Text(text))) => {
            if handle_resize_message(ssh_channel, &text).await.is_err() {
                warn!("handle_resize_message failed");
            }
            Ok(())
        }
        Some(Ok(Message::Ping(data))) => {
            timeout(
                Duration::from_secs(SEND_TIMEOUT_SECS),
                ws_sender.send(Message::Pong(data)),
            )
            .await
            .context("ws pong send timed out, consumer likely stuck")?
            .context("ws receiver dropped during pong")?;
            Ok(())
        }
        Some(Ok(Message::Pong(_))) => Ok(()),
        _ => bail!("ws connection closed"),
    }
}

async fn send_ws_keepalive(ws_sender: &mut SplitSink<WebSocket, Message>) -> Result<()> {
    timeout(
        Duration::from_secs(SEND_TIMEOUT_SECS),
        ws_sender.send(Message::Ping(Bytes::new())),
    )
    .await
    .context("ws keepalive send timed out, consumer likely stuck")?
    .context("ws receiver dropped during keepalive")?;
    Ok(())
}

const MAX_TERMINAL_COLS: u32 = 500;
const MAX_TERMINAL_ROWS: u32 = 500;

#[derive(Debug, PartialEq)]
struct TerminalSize {
    cols: u32,
    rows: u32,
}

/// Parse a resize JSON message and return validated terminal size, or None if
/// the message is not a resize or has invalid values.
fn parse_resize_message(text: &str) -> Option<TerminalSize> {
    let json = serde_json::from_str::<serde_json::Value>(text).ok()?;
    if json["type"] != "resize" {
        return None;
    }
    let cols = u32::try_from(json["cols"].as_u64()?).ok()?;
    let rows = u32::try_from(json["rows"].as_u64()?).ok()?;
    if !(1..=MAX_TERMINAL_COLS).contains(&cols) || !(1..=MAX_TERMINAL_ROWS).contains(&rows) {
        return None;
    }
    Some(TerminalSize { cols, rows })
}

async fn handle_resize_message(ssh_channel: &mut Channel<Msg>, text: &str) -> Result<()> {
    if let Some(terminal_size) = parse_resize_message(text) {
        timeout(
            Duration::from_secs(SEND_TIMEOUT_SECS),
            ssh_channel.window_change(terminal_size.cols, terminal_size.rows, 0, 0),
        )
        .await
        .context("window_change timed out")?
        .context("window_change failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_valid_cols_rows() {
        let msg = r#"{"type":"resize","cols":80,"rows":24}"#;
        let terminal_size = parse_resize_message(msg).unwrap();
        assert_eq!(terminal_size.cols, 80);
        assert_eq!(terminal_size.rows, 24);
    }

    #[test]
    fn resize_cols_zero_rejected() {
        let msg = r#"{"type":"resize","cols":0,"rows":24}"#;
        assert_eq!(parse_resize_message(msg), None);
    }

    #[test]
    fn resize_rows_zero_rejected() {
        let msg = r#"{"type":"resize","cols":80,"rows":0}"#;
        assert_eq!(parse_resize_message(msg), None);
    }

    #[test]
    fn resize_cols_over_max_rejected() {
        let msg = r#"{"type":"resize","cols":501,"rows":24}"#;
        assert_eq!(parse_resize_message(msg), None);
    }

    #[test]
    fn resize_rows_over_max_rejected() {
        let msg = r#"{"type":"resize","cols":80,"rows":501}"#;
        assert_eq!(parse_resize_message(msg), None);
    }

    #[test]
    fn resize_at_max_accepted() {
        let msg = r#"{"type":"resize","cols":500,"rows":500}"#;
        let terminal_size = parse_resize_message(msg).unwrap();
        assert_eq!(terminal_size.cols, 500);
        assert_eq!(terminal_size.rows, 500);
    }

    #[test]
    fn non_resize_message_ignored() {
        let msg = r#"{"type":"input","data":"hello"}"#;
        assert_eq!(parse_resize_message(msg), None);
    }

    #[test]
    fn invalid_json_ignored() {
        assert_eq!(parse_resize_message("not json at all"), None);
    }

    #[test]
    fn resize_missing_cols_ignored() {
        let msg = r#"{"type":"resize","rows":24}"#;
        assert_eq!(parse_resize_message(msg), None);
    }

    #[test]
    fn resize_huge_values_rejected() {
        let msg = r#"{"type":"resize","cols":4294967295,"rows":4294967295}"#;
        assert_eq!(parse_resize_message(msg), None);
    }
}
