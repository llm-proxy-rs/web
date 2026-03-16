use std::time::Duration;
use tracing::warn;

use crate::VmRegistry;

const IDLE_TIMEOUT: Duration = Duration::from_secs(300);

pub async fn sweep_idle_vms(vms: &VmRegistry) {
    // Hold the removed entries in _stale_vms until after the lock is released
    // so that their Drop runs outside the registry lock.
    let _stale_vms = {
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
}
