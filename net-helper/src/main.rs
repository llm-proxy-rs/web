use anyhow::{Context, Result, anyhow, bail};
use caps::{CapSet, Capability};
use clap::{Parser, Subcommand};
use ipnet::Ipv4Net;
use std::process::Command;

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    TapCreate {
        #[arg(value_parser = parse_tap_name)]
        tap_name: String,
        cidr: Ipv4Net,
    },
    TapDelete {
        #[arg(value_parser = parse_tap_name)]
        tap_name: String,
    },
    SetupNat {
        #[arg(value_parser = parse_iface_name)]
        host_iface: String,
    },
}

fn main() {
    let args = Args::parse();
    if run(args).is_err() {
        eprintln!("error");
        std::process::exit(1);
    }
}

fn run(args: Args) -> Result<()> {
    raise_ambient_net_admin()
        .context("failed to raise ambient cap_net_admin — deploy with 'sudo setcap cap_net_admin=eip /usr/local/bin/net-helper'")?;
    match args.command {
        Cmd::TapCreate { tap_name, cidr } => cmd_tap_create(&tap_name, &cidr),
        Cmd::TapDelete { tap_name } => cmd_tap_delete(&tap_name),
        Cmd::SetupNat { host_iface } => cmd_setup_nat(&host_iface),
    }
}

fn parse_tap_name(name: &str) -> Result<String> {
    let digits = name
        .strip_prefix("tap")
        .ok_or_else(|| anyhow!("must start with 'tap'"))?;
    if digits.is_empty() || digits.len() > 3 {
        bail!("digits part must be 1-3 characters");
    }
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        bail!("digits part must be numeric");
    }
    if digits.len() > 1 && digits.starts_with('0') {
        bail!("no leading zeros in tap index");
    }
    let n: u32 = digits.parse().context("invalid number")?;
    if n > 253 {
        bail!("tap index must be 0-253");
    }
    Ok(name.to_owned())
}

fn parse_iface_name(name: &str) -> Result<String> {
    if name.is_empty() || name.len() > 15 {
        bail!("interface name must be 1-15 characters");
    }
    if name == "." || name == ".." {
        bail!("interface name must not be '.' or '..'");
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '@' | '.'))
    {
        bail!("interface name contains invalid characters");
    }
    Ok(name.to_owned())
}

fn run_cmd(prog: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(prog)
        .args(args)
        .status()
        .with_context(|| format!("failed to run {prog}"))?;
    if !status.success() {
        bail!("{prog} {:?} failed: {status}", args);
    }
    Ok(())
}

fn cmd_tap_create(tap_name: &str, cidr: &Ipv4Net) -> Result<()> {
    let _ = Command::new("ip").args(["link", "del", tap_name]).status();
    run_cmd("ip", &["tuntap", "add", "dev", tap_name, "mode", "tap"])?;
    run_cmd("ip", &["addr", "add", &cidr.to_string(), "dev", tap_name])?;
    run_cmd("ip", &["link", "set", "dev", tap_name, "up"])
}

fn cmd_tap_delete(tap_name: &str) -> Result<()> {
    run_cmd("ip", &["link", "del", tap_name])
}

fn cmd_setup_nat(iface: &str) -> Result<()> {
    std::fs::write("/proc/sys/net/ipv4/ip_forward", "1").context("failed to enable ip_forward")?;

    // ── FORWARD chain ────────────────────────────────────────────────
    // -I prepends, so the final rule order is the reverse of insertion.
    //
    // Final FORWARD chain order:
    //   1. DROP  172.16.0.0/16 → 169.254.0.0/16   (link-local)
    //   2. DROP  172.16.0.0/16 → 192.168.0.0/16   (RFC 1918)
    //   3. DROP  172.16.0.0/16 → 172.16.0.0/12    (RFC 1918)
    //   4. DROP  172.16.0.0/16 → 10.0.0.0/8       (RFC 1918)
    //   5. ACCEPT 172.16.0.0/16 -o <iface>         (internet-bound)
    //   6. ACCEPT conntrack ESTABLISHED,RELATED     (return traffic)
    //   policy: DROP
    //
    // Private-network DROPs match first, then internet-bound ACCEPT,
    // then conntrack for reply packets. Everything else hits DROP policy.

    // Default deny on FORWARD — only explicitly allowed traffic passes.
    run_cmd("iptables", &["-P", "FORWARD", "DROP"])?;

    ensure_rule(
        "iptables",
        &[
            "-I",
            "FORWARD",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        ],
    )?;
    ensure_rule(
        "iptables",
        &[
            "-I",
            "FORWARD",
            "-s",
            "172.16.0.0/16",
            "-o",
            iface,
            "-j",
            "ACCEPT",
        ],
    )?;
    ensure_rule(
        "iptables",
        &[
            "-I",
            "FORWARD",
            "-s",
            "172.16.0.0/16",
            "-d",
            "10.0.0.0/8",
            "-j",
            "DROP",
        ],
    )?;
    ensure_rule(
        "iptables",
        &[
            "-I",
            "FORWARD",
            "-s",
            "172.16.0.0/16",
            "-d",
            "172.16.0.0/12",
            "-j",
            "DROP",
        ],
    )?;
    ensure_rule(
        "iptables",
        &[
            "-I",
            "FORWARD",
            "-s",
            "172.16.0.0/16",
            "-d",
            "192.168.0.0/16",
            "-j",
            "DROP",
        ],
    )?;
    ensure_rule(
        "iptables",
        &[
            "-I",
            "FORWARD",
            "-s",
            "172.16.0.0/16",
            "-d",
            "169.254.0.0/16",
            "-j",
            "DROP",
        ],
    )?;

    // ── INPUT chain ─────────────────────────────────────────────────
    // Final INPUT chain order:
    //   1. ACCEPT 172.16.0.0/16 conntrack ESTABLISHED,RELATED
    //   2. DROP   172.16.0.0/16
    //
    // ESTABLISHED/RELATED is on top so the host can SSH into VMs
    // (reply packets are allowed). All other VM→host traffic is dropped.
    ensure_rule(
        "iptables",
        &["-I", "INPUT", "-s", "172.16.0.0/16", "-j", "DROP"],
    )?;
    ensure_rule(
        "iptables",
        &[
            "-I",
            "INPUT",
            "-s",
            "172.16.0.0/16",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        ],
    )?;

    ensure_rule(
        "iptables",
        &[
            "-t",
            "nat",
            "-A",
            "POSTROUTING",
            "-o",
            iface,
            "-j",
            "MASQUERADE",
        ],
    )
}

/// Add a rule only if it doesn't already exist (-C checks).
fn ensure_rule(prog: &str, args: &[&str]) -> Result<()> {
    let check_args: Vec<&str> = args
        .iter()
        .map(|a| if *a == "-I" || *a == "-A" { "-C" } else { a })
        .collect();
    let status = Command::new(prog)
        .args(&check_args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .with_context(|| format!("failed to run {prog}"))?;
    if status.success() {
        return Ok(());
    }
    run_cmd(prog, args)
}

fn raise_ambient_net_admin() -> Result<()> {
    caps::raise(None, CapSet::Inheritable, Capability::CAP_NET_ADMIN)
        .context("failed to raise CAP_NET_ADMIN inheritable")?;
    caps::raise(None, CapSet::Ambient, Capability::CAP_NET_ADMIN)
        .context("failed to raise CAP_NET_ADMIN ambient")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tap_name_valid() {
        assert!(parse_tap_name("tap0").is_ok());
        assert!(parse_tap_name("tap1").is_ok());
        assert!(parse_tap_name("tap9").is_ok());
        assert!(parse_tap_name("tap10").is_ok());
        assert!(parse_tap_name("tap99").is_ok());
        assert!(parse_tap_name("tap100").is_ok());
        assert!(parse_tap_name("tap253").is_ok());
    }

    #[test]
    fn tap_name_invalid() {
        assert!(parse_tap_name("").is_err());
        assert!(parse_tap_name("tap").is_err());
        assert!(parse_tap_name("eth0").is_err());
        assert!(parse_tap_name("tap00").is_err());
        assert!(parse_tap_name("tap01").is_err());
        assert!(parse_tap_name("tap254").is_err());
        assert!(parse_tap_name("tap999").is_err());
        assert!(parse_tap_name("tap1234").is_err());
        assert!(parse_tap_name("tapx").is_err());
        assert!(parse_tap_name("tap-1").is_err());
    }

    #[test]
    fn iface_name_valid() {
        assert!(parse_iface_name("eth0").is_ok());
        assert!(parse_iface_name("ens3").is_ok());
        assert!(parse_iface_name("wlan0").is_ok());
        assert!(parse_iface_name("lo").is_ok());
        assert!(parse_iface_name("docker0").is_ok());
        assert!(parse_iface_name("veth@if5").is_ok());
        assert!(parse_iface_name("a").is_ok());
        assert!(parse_iface_name("123456789012345").is_ok());
    }

    #[test]
    fn iface_name_invalid() {
        assert!(parse_iface_name("").is_err());
        assert!(parse_iface_name(".").is_err());
        assert!(parse_iface_name("..").is_err());
        assert!(parse_iface_name("1234567890123456").is_err());
        assert!(parse_iface_name("eth 0").is_err());
        assert!(parse_iface_name("eth/0").is_err());
    }
}
