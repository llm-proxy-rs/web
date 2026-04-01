use std::time::Duration;
use tracing::{info, warn};

use crate::VmRegistry;

const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Stops idle VMs. The rootfs remains in the chroot — no copy needed.
pub async fn sweep_idle_vms(vms: &VmRegistry) {
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

    info!("stopping {} idle vm(s)", stale_vms.len());
    for vm_entry in &stale_vms {
        vm_entry.vm.stop().await;
    }
    // VmEntry drop will clean up chroot artifacts (socket, kernel) but preserve rootfs
}
