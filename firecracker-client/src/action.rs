use anyhow::Result;
use std::path::Path;

use crate::http::send_put;

pub async fn start_instance(socket_path: &Path) -> Result<()> {
    send_put(
        socket_path,
        "/actions",
        &serde_json::json!({"action_type": "InstanceStart"}),
    )
    .await
}

pub async fn stop_instance(socket_path: &Path) -> Result<()> {
    send_put(
        socket_path,
        "/actions",
        &serde_json::json!({"action_type": "SendCtrlAltDel"}),
    )
    .await
}
