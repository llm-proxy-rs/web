use anyhow::{Context, Result, anyhow};
use common::copy_sparse;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{fs, sync::Mutex as AsyncMutex, time::timeout};
use tracing::info;
use uuid::Uuid;

use crate::{VmEntry, VmRegistry};

const LOCK_TIMEOUT_SECS: u64 = 30;

pub fn build_user_rootfs_path(user_rootfs_dir: &Path, user_id: Uuid) -> PathBuf {
    user_rootfs_dir.join(format!("{user_id}.ext4"))
}

pub fn find_user_rootfs(user_rootfs_dir: &Path, user_id: Uuid) -> Option<PathBuf> {
    let rootfs_path = build_user_rootfs_path(user_rootfs_dir, user_id);
    rootfs_path.exists().then_some(rootfs_path)
}

// Creates a per-user rootfs by copying the base image if one does not already exist.
pub async fn ensure_user_rootfs(
    user_rootfs_dir: &Path,
    base_rootfs_path: &Path,
    user_id: Uuid,
    rootfs_lock: &AsyncMutex<()>,
) -> Result<PathBuf> {
    let rootfs_path = build_user_rootfs_path(user_rootfs_dir, user_id);
    let _guard = timeout(Duration::from_secs(LOCK_TIMEOUT_SECS), rootfs_lock.lock())
        .await
        .context("timed out waiting for rootfs lock")?;
    if rootfs_path.exists() {
        return Ok(rootfs_path);
    }
    fs::create_dir_all(user_rootfs_dir)
        .await
        .context("failed to create user rootfs dir")?;
    copy_sparse(base_rootfs_path, &rootfs_path)
        .await
        .context("failed to copy base rootfs")?;
    Ok(rootfs_path)
}

pub async fn save_all_vm_rootfs(
    vms: &VmRegistry,
    user_rootfs_dir: &Path,
    rootfs_lock: &AsyncMutex<()>,
) -> Result<()> {
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
        "saving rootfs for {} running vm(s) before shutdown",
        vm_entries.len()
    );
    save_vm_rootfs_to_dir(vm_entries.values(), user_rootfs_dir, rootfs_lock).await
}

async fn save_vm_rootfs_to_dir(
    vm_entries: impl Iterator<Item = &VmEntry>,
    user_rootfs_dir: &Path,
    rootfs_lock: &AsyncMutex<()>,
) -> Result<()> {
    fs::create_dir_all(user_rootfs_dir)
        .await
        .context("failed to create user rootfs dir on shutdown")?;
    let _guard = timeout(Duration::from_secs(LOCK_TIMEOUT_SECS), rootfs_lock.lock())
        .await
        .context("timed out waiting for rootfs lock")?;
    for vm_entry in vm_entries {
        let rootfs_path = build_user_rootfs_path(user_rootfs_dir, vm_entry.user_id);
        info!(dest = %rootfs_path.display(), "saving rootfs on shutdown");
        vm_entry
            .vm
            .save_rootfs(&rootfs_path)
            .await
            .context("failed to save rootfs on shutdown")?;
    }
    Ok(())
}
