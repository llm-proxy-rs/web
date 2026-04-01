use anyhow::{Context, Result, anyhow};
use common::copy_sparse;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tokio::fs;
use tracing::info;
use uuid::Uuid;

use crate::{VmEntry, VmRegistry};

/// Returns the path where a user's rootfs lives inside the jailer chroot:
/// `{chroot_base}/firecracker/{user_id}/root/rootfs.ext4`
pub fn build_chroot_rootfs_path(chroot_base: &Path, user_id: Uuid) -> PathBuf {
    chroot_base
        .join("firecracker")
        .join(user_id.to_string())
        .join("root")
        .join("rootfs.ext4")
}

/// Returns the rootfs path if the user already has one in the chroot.
pub fn find_user_rootfs(chroot_base: &Path, user_id: Uuid) -> Option<PathBuf> {
    let rootfs_path = build_chroot_rootfs_path(chroot_base, user_id);
    rootfs_path.exists().then_some(rootfs_path)
}

/// Ensures a rootfs exists in the jailer chroot for this user.
/// Copies the base image on first use; subsequent calls are a no-op.
pub async fn ensure_chroot_rootfs(
    chroot_base: &Path,
    base_rootfs_path: &Path,
    user_id: Uuid,
) -> Result<PathBuf> {
    let rootfs_path = build_chroot_rootfs_path(chroot_base, user_id);
    if rootfs_path.exists() {
        return Ok(rootfs_path);
    }
    if let Some(parent) = rootfs_path.parent() {
        fs::create_dir_all(parent)
            .await
            .context("failed to create chroot rootfs dir")?;
    }
    copy_sparse(base_rootfs_path, &rootfs_path)
        .await
        .context("failed to copy base rootfs to chroot")?;
    Ok(rootfs_path)
}

/// Stops all running VMs so their writes are flushed.
/// No rootfs copy is needed — writes go directly to the persistent chroot path.
pub async fn save_all_vm_rootfs(vms: &VmRegistry) -> Result<()> {
    let vm_entries: HashMap<String, VmEntry> = {
        let mut registry = vms
            .lock()
            .map_err(|_| anyhow!("vm registry mutex poisoned"))?;
        registry.drain().collect()
    };
    if vm_entries.is_empty() {
        return Ok(());
    }
    info!(
        "stopping {} running vm(s) before shutdown",
        vm_entries.len()
    );
    for vm_entry in vm_entries.values() {
        vm_entry.vm.stop().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_chroot_rootfs_path_format() {
        let user_id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let path = build_chroot_rootfs_path(Path::new("/srv/jailer"), user_id);
        assert_eq!(
            path,
            PathBuf::from(
                "/srv/jailer/firecracker/550e8400-e29b-41d4-a716-446655440000/root/rootfs.ext4"
            )
        );
    }

    #[test]
    fn find_user_rootfs_returns_none_for_missing_file() {
        let user_id = Uuid::parse_str("ffffffff-ffff-ffff-ffff-ffffffffffff").unwrap();
        assert!(find_user_rootfs(Path::new("/nonexistent"), user_id).is_none());
    }
}
