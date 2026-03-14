use std::time::Duration;
use tracing::warn;

use crate::VmRegistry;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn sweep_idle_vms(vms: &VmRegistry) {
    let _stale_vms = {
        let Ok(mut registry) = vms.lock() else {
            warn!("vm registry mutex poisoned");
            return;
        };
        let stale_ids: Vec<String> = registry
            .iter()
            .filter(|(_, e)| !e.ws_connected && e.created_at.elapsed() > CONNECT_TIMEOUT)
            .map(|(id, _)| id.clone())
            .collect();
        stale_ids
            .into_iter()
            .filter_map(|id| registry.remove(&id))
            .collect::<Vec<_>>()
    };
}
