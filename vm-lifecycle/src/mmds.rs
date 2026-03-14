use anyhow::Result;
use firecracker_manager::{build_mmds_with_iam, put_mmds};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tracing::warn;

use crate::VmRegistry;
use crate::iam::{HostIamCredential, fetch_host_iam_credentials};

pub async fn refresh_all_vm_mmds(vms: &VmRegistry, use_iam_creds: bool, iam_role_name: &str) {
    if !use_iam_creds {
        return;
    }
    let Some(host_iam_credential) = fetch_host_iam_credentials(iam_role_name)
        .await
        .map_err(|e| warn!("failed to fetch host IAM credentials: {e}"))
        .ok()
    else {
        return;
    };
    let vm_socket_paths: HashMap<String, PathBuf> = {
        let Ok(registry) = vms.lock() else {
            warn!("vm registry mutex poisoned");
            return;
        };
        registry
            .iter()
            .filter(|(_, e)| e.has_iam_creds)
            .map(|(vm_id, e)| (vm_id.clone(), e.vm.socket_path()))
            .collect()
    };
    for (vm_id, socket_path) in vm_socket_paths {
        refresh_vm_mmds(&vm_id, &socket_path, &host_iam_credential)
            .await
            .unwrap_or_else(|e| warn!("failed to refresh mmds: {e}"));
    }
}

async fn refresh_vm_mmds(
    vm_id: &str,
    socket_path: &Path,
    host_iam_credential: &HostIamCredential,
) -> Result<()> {
    let metadata = build_mmds_with_iam(
        vm_id,
        &host_iam_credential.role_name,
        &host_iam_credential.credential,
    )?;
    put_mmds(socket_path, &metadata).await
}
