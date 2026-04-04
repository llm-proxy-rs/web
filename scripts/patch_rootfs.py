#!/usr/bin/env python3
"""Patch agent.py and MCP config in existing user rootfs images.

User data (home directory, installed packages, conversations, etc.) is preserved.

What gets updated:
  - /opt/agent.py                              (agent daemon)
  - /etc/systemd/system/agent.service          (agent service unit)
  - /etc/systemd/system/claude-update.service  (Claude CLI update on boot)
  - /home/ubuntu/.ssh/authorized_keys          (client SSH public key)
  - /etc/ssh/ssh_host_ed25519_key{,.pub}       (host SSH key)
  - /etc/systemd/system/mcp-proxy.service      (MCP proxy, if --mcp-base-url set)

Usage:
  sudo python3 scripts/patch_rootfs.py [options]

Options:
  --rootfs <path>         Patch a single rootfs image
  --chroot-base <path>    Patch all user rootfs images under the chroot base
                          (default: /srv/jailer)
  --mcp-base-url <url>    Configure MCP proxy (e.g. https://mcp.example.com)
  --dry-run               Show what would be patched without making changes

Examples:
  sudo python3 scripts/patch_rootfs.py
  sudo python3 scripts/patch_rootfs.py --rootfs /srv/jailer/firecracker/<user-id>/root/rootfs.ext4
  sudo python3 scripts/patch_rootfs.py --mcp-base-url https://mcp.example.com
"""

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent
ROOTFS_DIR = REPO_ROOT / "rootfs"
AGENT_PY = ROOTFS_DIR / "agent.py"
AGENT_SERVICE = ROOTFS_DIR / "agent.service"
CLAUDE_UPDATE_SERVICE = ROOTFS_DIR / "claude-update.service"
SKILLS_DIR = ROOTFS_DIR / "skills"
INSTALL_DIR = Path("/var/lib/fc")


def run(cmd: list) -> None:
    print(f"  + {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True)


def build_patched_agent(mcp_base_url: str | None) -> str:
    content = AGENT_PY.read_text()
    if mcp_base_url:
        mcp_servers_value = (
            '{\n    "gemini-websearch": {\n'
            '        "type": "http",\n'
            '        "url": f"http://localhost:{MCP_PROXY_PORT}/mcp",\n'
            "    },\n}"
        )
        content = content.replace(
            "MCP_SERVERS: dict = {}",
            f"MCP_SERVERS: dict = {mcp_servers_value}",
        )
    return content


def build_mcp_proxy_service(mcp_base_url: str) -> str:
    parsed = urlparse(mcp_base_url)
    host = parsed.hostname
    if not host or not re.match(r"^[a-zA-Z0-9._-]+$", host):
        sys.exit(f"error: invalid hostname in --mcp-base-url: {host!r}")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed.scheme == "https":
        upstream = f"OPENSSL:{host}:{port},verify=0"
    else:
        upstream = f"TCP:{host}:{port}"
    return f"""\
[Unit]
Description=MCP reverse proxy (socat)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:8443,fork,reuseaddr,bind=127.0.0.1 {upstream}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""


def install_service(mountpoint: Path, service_src: Path, service_name: str) -> None:
    systemd = mountpoint / "etc/systemd/system"
    systemd.mkdir(parents=True, exist_ok=True)
    wants = systemd / "multi-user.target.wants"
    wants.mkdir(exist_ok=True)
    shutil.copy(str(service_src), str(systemd / service_name))
    link = wants / service_name
    if not link.exists():
        link.symlink_to(f"../{service_name}")
    print(f"  updated /etc/systemd/system/{service_name}")


def patch_ssh_keys(mountpoint: Path) -> None:
    # Client key: derive public key and write authorized_keys
    client_key = INSTALL_DIR / "ubuntu-24.04.id_ed25519"
    if client_key.exists():
        ssh_dir = mountpoint / "home/ubuntu/.ssh"
        ssh_dir.mkdir(parents=True, exist_ok=True)
        auth_keys = ssh_dir / "authorized_keys"
        result = subprocess.run(
            ["ssh-keygen", "-y", "-f", str(client_key)],
            check=True,
            capture_output=True,
            text=True,
        )
        auth_keys.write_text(result.stdout)
        os.chmod(ssh_dir, 0o700)
        os.chmod(auth_keys, 0o600)
        run(["chown", "-R", "1000:1000", str(ssh_dir)])
        print("  updated /home/ubuntu/.ssh/authorized_keys")

    # Host key: copy private + public
    host_priv = INSTALL_DIR / "vm_host_ed25519_key"
    host_pub = INSTALL_DIR / "vm_host_key.pub"
    if host_priv.exists() and host_pub.exists():
        etc_ssh = mountpoint / "etc/ssh"
        etc_ssh.mkdir(parents=True, exist_ok=True)
        shutil.copy(str(host_priv), str(etc_ssh / "ssh_host_ed25519_key"))
        shutil.copy(str(host_pub), str(etc_ssh / "ssh_host_ed25519_key.pub"))
        os.chmod(etc_ssh / "ssh_host_ed25519_key", 0o600)
        print("  updated /etc/ssh/ssh_host_ed25519_key{,.pub}")


def patch_one(rootfs_path: Path, mcp_base_url: str | None, dry_run: bool) -> None:
    print(f"PATCH {rootfs_path}")

    if dry_run:
        print("  [dry-run] would mount, patch agent + services + keys, unmount")
        if mcp_base_url:
            print("  [dry-run] would patch mcp-proxy.service")
        return

    mountpoint = Path(tempfile.mkdtemp())
    try:
        run(["mount", str(rootfs_path), str(mountpoint)])

        # Patch agent.py
        opt = mountpoint / "opt"
        opt.mkdir(exist_ok=True)
        agent_dest = opt / "agent.py"
        agent_dest.write_text(build_patched_agent(mcp_base_url))
        run(["chown", "1000:1000", str(agent_dest)])
        print("  updated /opt/agent.py")

        # Patch services
        install_service(mountpoint, AGENT_SERVICE, "agent.service")
        install_service(mountpoint, CLAUDE_UPDATE_SERVICE, "claude-update.service")

        # Patch SSH keys
        patch_ssh_keys(mountpoint)

        # Install built-in skills (/commit, /review, etc.)
        if SKILLS_DIR.is_dir():
            skills_dest = mountpoint / "home/ubuntu/.claude/skills"
            if skills_dest.exists():
                shutil.rmtree(str(skills_dest))
            shutil.copytree(str(SKILLS_DIR), str(skills_dest))
            run(["chown", "-R", "1000:1000", str(mountpoint / "home/ubuntu/.claude")])
            print(f"  installed {len(list(SKILLS_DIR.iterdir()))} skill(s)")

        # Patch MCP proxy service
        if mcp_base_url:
            systemd = mountpoint / "etc/systemd/system"
            wants = systemd / "multi-user.target.wants"
            (systemd / "mcp-proxy.service").write_text(
                build_mcp_proxy_service(mcp_base_url)
            )
            link = wants / "mcp-proxy.service"
            if not link.exists():
                link.symlink_to("../mcp-proxy.service")
            print("  updated /etc/systemd/system/mcp-proxy.service")

        print("  done")
    finally:
        subprocess.run(["umount", str(mountpoint)], check=False)
        mountpoint.rmdir()


def main() -> None:
    parser = argparse.ArgumentParser(description="Patch user rootfs images")
    parser.add_argument("--rootfs", help="Patch a single rootfs image")
    parser.add_argument(
        "--chroot-base",
        default="/srv/jailer",
        help="Chroot base directory (default: /srv/jailer)",
    )
    parser.add_argument("--mcp-base-url", help="MCP proxy base URL")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be patched",
    )
    args = parser.parse_args()

    for f in (AGENT_PY, AGENT_SERVICE, CLAUDE_UPDATE_SERVICE):
        if not f.exists():
            sys.exit(f"ERROR: {f} not found")

    patched = 0

    if args.rootfs:
        rootfs = Path(args.rootfs)
        if not rootfs.exists():
            sys.exit(f"ERROR: rootfs not found: {rootfs}")
        patch_one(rootfs, args.mcp_base_url, args.dry_run)
        patched = 1
    else:
        fc_dir = Path(args.chroot_base) / "firecracker"
        if not fc_dir.is_dir():
            print(f"No user chroots found under {fc_dir}")
            return
        for rootfs_path in sorted(fc_dir.glob("*/root/rootfs.ext4")):
            patch_one(rootfs_path, args.mcp_base_url, args.dry_run)
            patched += 1

    print(f"\nPatched {patched} rootfs image(s).")


if __name__ == "__main__":
    main()
