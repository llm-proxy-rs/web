use crate::{
    VmRegistry,
    iam::{HostIamCredential, fetch_host_iam_credentials},
};
use anyhow::{Result, anyhow};
use firecracker_manager::{build_mmds_with_iam, put_mmds};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub async fn refresh_all_vm_mmds(
    vms: &VmRegistry,
    use_iam_creds: bool,
    iam_role_name: &str,
) -> Result<()> {
    if !use_iam_creds {
        return Ok(());
    }
    let host_iam_credential = fetch_host_iam_credentials(iam_role_name).await?;
    let vm_socket_paths: HashMap<String, PathBuf> = {
        let registry = vms
            .lock()
            .map_err(|_| anyhow!("vm registry mutex poisoned"))?;
        registry
            .iter()
            .filter(|(_, e)| e.has_iam_creds)
            .map(|(vm_id, e)| (vm_id.clone(), e.vm.socket_path()))
            .collect()
    };
    for (vm_id, socket_path) in vm_socket_paths {
        if refresh_vm_mmds(&vm_id, &socket_path, &host_iam_credential)
            .await
            .is_err()
        {
            tracing::warn!("mmds refresh failed");
        }
    }
    Ok(())
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
