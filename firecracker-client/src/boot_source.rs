use anyhow::Result;
use serde::Serialize;
use std::path::Path;

use crate::http::send_put;

#[derive(Serialize)]
pub struct BootSource {
    pub kernel_image_path: String,
    pub boot_args: String,
}

pub async fn set_boot_source(socket_path: &Path, boot_source: &BootSource) -> Result<()> {
    send_put(socket_path, "/boot-source", boot_source).await
}
