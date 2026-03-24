use crate::{VmRegistry, build_user_rootfs_path};
use std::{path::Path, time::Duration};
use tokio::{fs, sync::Mutex as AsyncMutex, time::timeout};
use tracing::{info, warn};

const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const LOCK_TIMEOUT_SECS: u64 = 30;

// Save rootfs before dropping stale VMs. Vm::drop() is sync and kills the
// process, so the async save_rootfs must happen while the VM is still alive.
pub async fn sweep_idle_vms(
    vms: &VmRegistry,
    user_rootfs_dir: &Path,
    rootfs_lock: &AsyncMutex<()>,
) {
    let stale_vms = {
        let Ok(mut registry) = vms.lock() else {
            warn!("vm registry mutex poisoned");
            return;
        };
        let stale_ids: Vec<String> = registry
            .iter()
            .filter(|(_, e)| e.last_activity.elapsed() > IDLE_TIMEOUT)
            .map(|(id, _)| id.clone())
            .collect();
        stale_ids
            .into_iter()
            .filter_map(|id| registry.remove(&id))
            .collect::<Vec<_>>()
    };

    if stale_vms.is_empty() {
        return;
    }

    info!("saving rootfs for {} swept vm(s)", stale_vms.len());
    if let Err(e) = fs::create_dir_all(user_rootfs_dir).await {
        warn!("failed to create user rootfs dir during sweep: {e}");
        return;
    }
    let Ok(_guard) = timeout(Duration::from_secs(LOCK_TIMEOUT_SECS), rootfs_lock.lock()).await
    else {
        warn!("timed out waiting for rootfs lock during sweep");
        return;
    };
    for vm_entry in &stale_vms {
        let rootfs_path = build_user_rootfs_path(user_rootfs_dir, vm_entry.user_id);
        if let Err(e) = vm_entry.vm.save_rootfs(&rootfs_path).await {
            warn!(dest = %rootfs_path.display(), "failed to save rootfs during sweep: {e}");
        }
    }
}
