use anyhow::{Context, Result, bail};
use ipnetwork::Ipv4Network;
use macaddr::MacAddr6;
use std::{net::Ipv4Addr, path::Path};
use tokio::process::Command;
use tracing::warn;

pub(crate) async fn create_tap(
    net_helper_path: &Path,
    tap_name: &str,
    tap_ip: &Ipv4Network,
) -> Result<()> {
    let status = Command::new(net_helper_path)
        .args(["tap-create", tap_name, &tap_ip.to_string()])
        .status()
        .await
        .context("failed to create tap interface")?;
    if !status.success() {
        bail!("net-helper tap-create failed for {tap_name}: {status}");
    }
    Ok(())
}

pub(crate) async fn delete_tap(net_helper_path: &Path, tap_name: &str) {
    if Command::new(net_helper_path)
        .args(["tap-delete", tap_name])
        .status()
        .await
        .is_err()
    {
        warn!("failed to delete tap {tap_name}");
    }
}

pub(crate) fn format_tap_name(idx: u8) -> String {
    format!("tap{idx}")
}

pub(crate) fn format_tap_ip(idx: u8) -> Result<Ipv4Network> {
    Ipv4Network::new(Ipv4Addr::new(172, 16, idx, 1), 30).context("invalid network prefix")
}

pub(crate) fn format_guest_ip(idx: u8) -> Ipv4Addr {
    Ipv4Addr::new(172, 16, idx, 2)
}

pub(crate) fn format_guest_mac(idx: u8) -> MacAddr6 {
    MacAddr6::new(0x06, 0x00, 0xAC, 0x10, idx, 0x02)
}

pub async fn setup_host_networking(net_helper_path: &Path) -> Result<()> {
    let host_iface = fetch_host_iface_name().await?;
    run_nat_setup(net_helper_path, &host_iface).await
}

async fn run_nat_setup(net_helper_path: &Path, host_iface: &str) -> Result<()> {
    let status = Command::new(net_helper_path)
        .args(["setup-nat", host_iface])
        .status()
        .await
        .context("failed to run net-helper setup-nat")?;
    if !status.success() {
        bail!("net-helper setup-nat failed: {status}");
    }
    Ok(())
}

async fn fetch_host_iface_name() -> Result<String> {
    let output = Command::new("ip")
        .args(["route", "list", "default"])
        .output()
        .await
        .context("failed to run 'ip route list default'")?;
    let route_output = String::from_utf8_lossy(&output.stdout);
    let mut tokens = route_output.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == "dev"
            && let Some(iface) = tokens.next()
        {
            return Ok(iface.to_string());
        }
    }
    bail!("no default route interface found in 'ip route list default' output")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── format_tap_name ───────────────────────────────────────────────────────

    #[test]
    fn test_format_tap_name_single_digit() {
        assert_eq!(format_tap_name(0), "tap0");
        assert_eq!(format_tap_name(9), "tap9");
    }

    #[test]
    fn test_format_tap_name_multi_digit() {
        assert_eq!(format_tap_name(10), "tap10");
        assert_eq!(format_tap_name(253), "tap253");
    }

    // ── format_tap_ip ─────────────────────────────────────────────────────────

    #[test]
    fn test_format_tap_ip_structure() {
        assert_eq!(
            format_tap_ip(0).unwrap(),
            Ipv4Network::new(Ipv4Addr::new(172, 16, 0, 1), 30).unwrap()
        );
        assert_eq!(
            format_tap_ip(1).unwrap(),
            Ipv4Network::new(Ipv4Addr::new(172, 16, 1, 1), 30).unwrap()
        );
        assert_eq!(
            format_tap_ip(255).unwrap(),
            Ipv4Network::new(Ipv4Addr::new(172, 16, 255, 1), 30).unwrap()
        );
    }

    // ── format_guest_ip ───────────────────────────────────────────────────────

    #[test]
    fn test_format_guest_ip_structure() {
        assert_eq!(format_guest_ip(0), Ipv4Addr::new(172, 16, 0, 2));
        assert_eq!(format_guest_ip(1), Ipv4Addr::new(172, 16, 1, 2));
        assert_eq!(format_guest_ip(255), Ipv4Addr::new(172, 16, 255, 2));
    }

    #[test]
    fn test_tap_and_guest_ip_share_same_subnet_for_same_idx() {
        // For each idx, tap (.1) and guest (.2) are in the same /30 block.
        for idx in [0u8, 1, 128, 253] {
            let tap_ip = format_tap_ip(idx).unwrap();
            let guest_ip = format_guest_ip(idx);
            assert!(
                tap_ip.contains(guest_ip),
                "idx={idx}: guest_ip not in tap subnet"
            );
        }
    }

    // ── format_guest_mac ─────────────────────────────────────────────────────

    #[test]
    fn test_format_guest_mac_zero_padded_for_low_idx() {
        assert_eq!(
            format_guest_mac(0),
            MacAddr6::new(0x06, 0x00, 0xAC, 0x10, 0x00, 0x02)
        );
        assert_eq!(
            format_guest_mac(1),
            MacAddr6::new(0x06, 0x00, 0xAC, 0x10, 0x01, 0x02)
        );
        assert_eq!(
            format_guest_mac(15),
            MacAddr6::new(0x06, 0x00, 0xAC, 0x10, 0x0F, 0x02)
        );
    }

    #[test]
    fn test_format_guest_mac_two_hex_digits_for_high_idx() {
        assert_eq!(
            format_guest_mac(16),
            MacAddr6::new(0x06, 0x00, 0xAC, 0x10, 0x10, 0x02)
        );
        assert_eq!(
            format_guest_mac(255),
            MacAddr6::new(0x06, 0x00, 0xAC, 0x10, 0xFF, 0x02)
        );
    }

    #[test]
    fn test_format_guest_mac_uses_uppercase_hex() {
        let mac = format_guest_mac(0xAB);
        assert!(
            mac.to_string().contains("AB"),
            "expected uppercase hex in {mac}"
        );
    }
}
