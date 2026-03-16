use anyhow::{Context, Result};
use axum::{
    Error as AxumError,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::{SinkExt, StreamExt, stream::SplitSink};
use russh::{Channel, ChannelMsg, client::Msg};
use ssh_client::{connect_ssh, open_terminal_channel};
use std::{net::Ipv4Addr, time::Duration};
use tokio::time::timeout;
use tracing::{error, info, warn};
use uuid::Uuid;
use vm_lifecycle::{VmEntry, build_user_rootfs_path};

use crate::{
    handlers::UserVm,
    state::{AppError, AppState, update_vm_last_activity},
};

const LOCK_TIMEOUT_SECS: u64 = 30;
const SEND_TIMEOUT_SECS: u64 = 30;

pub(crate) async fn handle_ws_upgrade(
    user_vm: UserVm,
    Path(vm_id): Path<String>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    if user_vm.vm_id != vm_id {
        return Ok((StatusCode::NOT_FOUND, "Session not found").into_response());
    }
    Ok(ws.on_upgrade(move |socket| async move {
        run_terminal_session(
            socket,
            state,
            user_vm.vm_id.clone(),
            user_vm.user_id,
            user_vm.guest_ip,
        )
        .await
    }))
}

async fn run_terminal_session(
    ws: WebSocket,
    state: AppState,
    vm_id: String,
    user_id: Uuid,
    guest_ip: Ipv4Addr,
) {
    if let Err(e) = update_vm_last_activity(&state.vms, &vm_id) {
        error!("vm registry lock poisoned, aborting terminal session: {e}");
        return;
    }
    run_ssh_relay(guest_ip, &state, ws)
        .await
        .unwrap_or_else(|e| error!("terminal session error: {e}"));
    save_and_drop_vm(&state, &vm_id, user_id).await;
}

async fn save_and_drop_vm(state: &AppState, vm_id: &str, user_id: Uuid) {
    let vm_entry = {
        let Ok(mut registry) = state.vms.lock() else {
            error!("vm registry lock poisoned on disconnect");
            return;
        };
        registry.remove(vm_id)
    };
    let Some(vm_entry) = vm_entry else { return };
    save_vm_rootfs_on_disconnect(state, user_id, vm_entry)
        .await
        .unwrap_or_else(|e| error!("failed to save rootfs on disconnect: {e}"));
}

async fn save_vm_rootfs_on_disconnect(
    state: &AppState,
    user_id: Uuid,
    vm_entry: VmEntry,
) -> Result<()> {
    tokio::fs::create_dir_all(&state.config.user_rootfs_dir)
        .await
        .context("failed to create user rootfs dir on disconnect")?;
    let user_rootfs = build_user_rootfs_path(&state.config.user_rootfs_dir, user_id);
    let _guard = timeout(
        Duration::from_secs(LOCK_TIMEOUT_SECS),
        state.rootfs_lock.lock(),
    )
    .await
    .context("timed out waiting for rootfs lock")?;
    info!("saving rootfs on disconnect");
    vm_entry
        .vm
        .save_rootfs(&user_rootfs)
        .await
        .context("failed to save rootfs")
}

async fn run_ssh_relay(guest_ip: Ipv4Addr, state: &AppState, ws: WebSocket) -> Result<()> {
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
    let (mut ws_sender, mut ws_receiver) = ws.split();
    let mut keepalive = tokio::time::interval(Duration::from_secs(30));
    keepalive.tick().await; // skip the immediate first tick
    loop {
        tokio::select! {
            msg = ssh_channel.wait() => {
                if !relay_ssh_to_ws(msg, &mut ws_sender).await { break; }
            }
            ws_msg = ws_receiver.next() => {
                if !relay_ws_to_ssh(ws_msg, &mut ssh_channel, &mut ws_sender).await { break; }
            }
            _ = keepalive.tick() => {
                if !send_ws_keepalive(&mut ws_sender).await { break; }
            }
        }
    }
    Ok(())
}

async fn relay_ssh_to_ws(
    msg: Option<ChannelMsg>,
    ws_sender: &mut SplitSink<WebSocket, Message>,
) -> bool {
    match msg {
        Some(ChannelMsg::Data { ref data }) => {
            match timeout(
                Duration::from_secs(SEND_TIMEOUT_SECS),
                ws_sender.send(Message::Binary(Bytes::copy_from_slice(data))),
            )
            .await
            {
                Ok(Ok(())) => true,
                Ok(Err(_)) => {
                    info!("ws receiver dropped, ending relay");
                    false
                }
                Err(_) => {
                    error!("ws send timed out, consumer likely stuck");
                    false
                }
            }
        }
        Some(ChannelMsg::ExitStatus { .. }) | None => false,
        _ => true,
    }
}

async fn relay_ws_to_ssh(
    msg: Option<Result<Message, AxumError>>,
    ssh_channel: &mut Channel<Msg>,
    ws_sender: &mut SplitSink<WebSocket, Message>,
) -> bool {
    match msg {
        Some(Ok(Message::Binary(data))) => {
            match timeout(
                Duration::from_secs(SEND_TIMEOUT_SECS),
                ssh_channel.data(&data[..]),
            )
            .await
            {
                Ok(Ok(())) => true,
                Ok(Err(_)) => {
                    info!("ssh channel closed, ending relay");
                    false
                }
                Err(_) => {
                    error!("ssh channel send timed out, consumer likely stuck");
                    false
                }
            }
        }
        Some(Ok(Message::Text(text))) => {
            handle_resize_message(ssh_channel, &text)
                .await
                .unwrap_or_else(|e| warn!("handle_resize_message failed: {e}"));
            true
        }
        Some(Ok(Message::Ping(data))) => {
            match timeout(
                Duration::from_secs(SEND_TIMEOUT_SECS),
                ws_sender.send(Message::Pong(data)),
            )
            .await
            {
                Ok(Ok(())) => true,
                Ok(Err(_)) => {
                    info!("ws receiver dropped during pong, ending relay");
                    false
                }
                Err(_) => {
                    error!("ws pong send timed out, consumer likely stuck");
                    false
                }
            }
        }
        Some(Ok(Message::Pong(_))) => true,
        _ => false,
    }
}

async fn send_ws_keepalive(ws_sender: &mut SplitSink<WebSocket, Message>) -> bool {
    match timeout(
        Duration::from_secs(SEND_TIMEOUT_SECS),
        ws_sender.send(Message::Ping(Bytes::new())),
    )
    .await
    {
        Ok(Ok(())) => true,
        Ok(Err(_)) => {
            info!("ws receiver dropped during keepalive, ending relay");
            false
        }
        Err(_) => {
            error!("ws keepalive send timed out, consumer likely stuck");
            false
        }
    }
}

async fn handle_resize_message(ssh_channel: &mut Channel<Msg>, text: &str) -> Result<()> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return Ok(());
    };
    if json["type"] == "resize" {
        let cols = u32::try_from(
            json["cols"]
                .as_u64()
                .context("missing cols in resize message")?,
        )
        .context("cols out of u32 range")?;
        let rows = u32::try_from(
            json["rows"]
                .as_u64()
                .context("missing rows in resize message")?,
        )
        .context("rows out of u32 range")?;
        timeout(
            Duration::from_secs(SEND_TIMEOUT_SECS),
            ssh_channel.window_change(cols, rows, 0, 0),
        )
        .await
        .context("window_change timed out")?
        .context("window_change failed")?;
    }
    Ok(())
}
