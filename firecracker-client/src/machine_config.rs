use anyhow::Result;
use serde::Serialize;
use std::path::Path;

use crate::http::send_put;

#[derive(Serialize)]
pub struct MachineConfig {
    pub vcpu_count: u8,
    pub mem_size_mib: u32,
}

pub async fn set_machine_config(socket_path: &Path, machine_config: &MachineConfig) -> Result<()> {
    send_put(socket_path, "/machine-config", machine_config).await
}
