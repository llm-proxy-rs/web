use std::path::Path;
use tokio::{fs, process::Command};
use tracing::warn;

use crate::{network::delete_tap, vm::cleanup_chroot};

pub async fn clean_stale_vms(net_helper_path: &Path, jailer_chroot_base: &Path) {
    stop_stale_firecracker_processes(jailer_chroot_base).await;
    delete_stale_tap_interfaces(net_helper_path).await;
    delete_stale_chroot_dirs(jailer_chroot_base).await;
}

/// Finds running firecracker VMs by their sockets and stops them gracefully.
async fn stop_stale_firecracker_processes(chroot_base: &Path) {
    let firecracker_dir = chroot_base.join("firecracker");
    let Ok(mut entries) = fs::read_dir(&firecracker_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let socket_path = entry.path().join("root/run/firecracker.socket");
        if socket_path.exists()
            && firecracker_client::stop_instance(&socket_path)
                .await
                .is_err()
        {
            warn!("failed to stop stale VM");
        }
    }
}

async fn delete_stale_tap_interfaces(net_helper_path: &Path) {
    let Ok(output) = Command::new("ip")
        .args(["link", "show", "type", "tun"])
        .output()
        .await
    else {
        return;
    };
    let output = String::from_utf8_lossy(&output.stdout);
    for line in output.lines() {
        let Some(name) = parse_tap_interface_name(line) else {
            continue;
        };
        delete_tap(net_helper_path, name).await;
    }
}

fn parse_tap_interface_name(line: &str) -> Option<&str> {
    // lines look like: "5: tap0: <...> ..."
    let name = line.split(':').nth(1)?.trim();
    name.starts_with("tap").then_some(name)
}

async fn delete_stale_chroot_dirs(chroot_base: &Path) {
    let firecracker_dir = chroot_base.join("firecracker");
    let Ok(mut entries) = fs::read_dir(&firecracker_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let root_dir = entry.path().join("root");
        cleanup_chroot(&root_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_valid_tap_interface_extracted() {
        assert_eq!(
            parse_tap_interface_name("5: tap0: <BROADCAST,MULTICAST,UP>"),
            Some("tap0")
        );
        assert_eq!(parse_tap_interface_name("12: tap99: <...>"), Some("tap99"));
    }

    #[test]
    fn test_non_tap_interface_returns_none() {
        assert_eq!(
            parse_tap_interface_name("3: eth0: <BROADCAST,MULTICAST,UP>"),
            None
        );
        assert_eq!(parse_tap_interface_name("1: lo: <LOOPBACK,UP>"), None);
        assert_eq!(parse_tap_interface_name("4: tun0: <...>"), None);
    }

    #[test]
    fn test_line_with_no_colon_returns_none() {
        assert_eq!(parse_tap_interface_name("somethingnocolon"), None);
        assert_eq!(parse_tap_interface_name(""), None);
    }

    #[test]
    fn test_whitespace_around_name_is_trimmed() {
        // ip link output always has a space after the index colon
        assert_eq!(parse_tap_interface_name("5:  tap1: <...>"), Some("tap1"));
    }

    #[test]
    fn test_line_with_only_one_colon_still_parses() {
        // no trailing section after the name colon — still works
        assert_eq!(parse_tap_interface_name("5: tap2"), Some("tap2"));
    }
}
