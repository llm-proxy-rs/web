"""Build the Firecracker rootfs for WebCode.

Must be run as root. Because sudo resets PATH, pass uv's full path:

    sudo $(which uv) run scripts/build_rootfs.py

Use --workdir to keep artifacts between runs (avoids re-downloading):

    sudo $(which uv) run scripts/build_rootfs.py --workdir /tmp/fc-build

Use --no-test to skip the Firecracker smoke test after building:

    sudo $(which uv) run scripts/build_rootfs.py --no-test
"""

import argparse
import http.client
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

# ── constants ────────────────────────────────────────────────────────────────

S3_BUCKET = "https://s3.amazonaws.com/spec.ccfc.min"
S3_ARTIFACTS = f"{S3_BUCKET}/firecracker-ci"
INSTALL_DIR = Path("/var/lib/fc")
ROOTFS_DIR = Path(__file__).parent.parent / "rootfs"
AGENT_PY = ROOTFS_DIR / "agent.py"
AGENT_SERVICE = ROOTFS_DIR / "agent.service"

# Runs as root inside the chroot.
CHROOT_ROOT_SCRIPT = """\
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl logrotate socat
# TODO: Supply-chain risk — piping curl to bash executes unverified remote code.
# Ideally, pin to a specific version and verify with a checksum/signature.
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
"""

LOGROTATE_CONF = """\
/home/ubuntu/agent.log {
    rotate 5
    size 10M
    compress
    missingok
    notifempty
}
"""


# Runs as the ubuntu user inside the chroot.
CHROOT_USER_SCRIPT = """\
set -e
# TODO: Supply-chain risk — piping curl to bash executes unverified remote code.
# Ideally, pin to a specific version and verify with a checksum/signature.
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
"""

# ── shell helpers ─────────────────────────────────────────────────────────────


def run(cmd: list, **kwargs) -> None:
    print(f"+ {' '.join(str(c) for c in cmd)}")
    subprocess.run(cmd, check=True, **kwargs)


def chroot_as_root(rootfs: Path, script: str) -> None:
    run(["chroot", str(rootfs), "bash", "-c", script])


def chroot_as_ubuntu(rootfs: Path, script: str) -> None:
    script_path = rootfs / "tmp/_build.sh"
    script_path.write_text(script)
    run(["chroot", str(rootfs), "su", "-", "ubuntu", "-c", "bash /tmp/_build.sh"])
    script_path.unlink()


# ── version discovery ─────────────────────────────────────────────────────────


def fetch_arch() -> str:
    return subprocess.check_output(["uname", "-m"], text=True).strip()


def fetch_latest_fc_version() -> str:
    url = "https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "build-rootfs"})
    with urllib.request.urlopen(req) as resp:
        tag = json.loads(resp.read())["tag_name"]  # e.g. "v1.14.0"
    major, minor, _patch = tag.lstrip("v").split(".")
    return f"v{major}.{minor}"


def list_s3_keys(fc_version: str, arch: str, prefix: str) -> list[str]:
    url = f"{S3_BUCKET}/?prefix=firecracker-ci/{fc_version}/{arch}/{prefix}&list-type=2"
    with urllib.request.urlopen(url) as resp:
        raw_xml = resp.read()
        # Guard against XML bombs: reject unreasonably large responses before parsing.
        if len(raw_xml) > 10 * 1024 * 1024:  # 10 MB
            sys.exit("error: S3 listing response exceeds 10 MB, refusing to parse")
        xml = ET.fromstring(raw_xml)
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    return [el.text for el in xml.findall(".//s3:Key", ns) if el.text]


def is_versioned_kernel(s3_key: str) -> bool:
    """Return True for plain version kernels like vmlinux-6.1.155 (not vmlinux-acpi-*)."""
    name = Path(s3_key).name  # e.g. "vmlinux-6.1.155"
    version = name.split("-", 1)[1]  # e.g. "6.1.155"
    return name.count("-") == 1 and all(part.isdigit() for part in version.split("."))


def kernel_version_tuple(s3_key: str) -> tuple[int, ...]:
    version = Path(s3_key).name.split("-", 1)[1]  # e.g. "6.1.155"
    return tuple(int(x) for x in version.split("."))


def fetch_latest_kernel_key(fc_version: str, arch: str) -> str:
    all_keys = list_s3_keys(fc_version, arch, "vmlinux-")
    versioned_keys = [k for k in all_keys if is_versioned_kernel(k)]
    if not versioned_keys:
        sys.exit(f"error: no kernel images found for Firecracker {fc_version}/{arch}")
    return max(versioned_keys, key=kernel_version_tuple)


def fetch_latest_ubuntu_key(fc_version: str, arch: str) -> str:
    all_keys = list_s3_keys(fc_version, arch, "ubuntu-")
    squashfs_keys = [k for k in all_keys if k.endswith(".squashfs")]
    if not squashfs_keys:
        sys.exit(f"error: no Ubuntu squashfs found for Firecracker {fc_version}/{arch}")
    return sorted(squashfs_keys)[
        -1
    ]  # e.g. "firecracker-ci/v1.14/x86_64/ubuntu-24.04.squashfs"


# ── build steps ───────────────────────────────────────────────────────────────


def download_artifacts(
    workdir: Path, fc_version: str, arch: str, kernel_key: str, ubuntu_key: str
) -> tuple[Path, Path]:
    base_url = f"{S3_ARTIFACTS}/{fc_version}/{arch}"
    kernel_name = Path(kernel_key).name  # e.g. "vmlinux-6.1.155"
    ubuntu_name = Path(ubuntu_key).stem  # e.g. "ubuntu-24.04"

    kernel = workdir / kernel_name
    squashfs = workdir / f"{ubuntu_name}.squashfs.upstream"

    if not kernel.exists():
        run(["wget", "-O", str(kernel), f"{base_url}/{kernel_name}"])
    if not squashfs.exists():
        run(["wget", "-O", str(squashfs), f"{base_url}/{ubuntu_name}.squashfs"])

    return kernel, squashfs


def unpack_squashfs(workdir: Path, squashfs: Path) -> Path:
    rootfs = workdir / "squashfs-root"
    if rootfs.exists():
        run(["rm", "-rf", str(rootfs)])
    run(["unsquashfs", "-d", str(rootfs), str(squashfs)])
    run(["chown", "-R", "root:root", str(rootfs)])
    run(["chown", "-R", "1000:1000", str(rootfs / "home/ubuntu")])
    return rootfs


def setup_client_ssh_key(workdir: Path, rootfs: Path) -> Path:
    """Generate the keypair the server uses to SSH into the VM.

    Private key → returned (installed to /var/lib/fc/ later).
    Public key  → baked into the rootfs as ubuntu's authorized_keys.
    """
    private_key = workdir / "id_ed25519"
    public_key = workdir / "id_ed25519.pub"
    authorized_keys = rootfs / "home/ubuntu/.ssh/authorized_keys"
    ssh_dir = rootfs / "home/ubuntu/.ssh"

    private_key.unlink(missing_ok=True)
    public_key.unlink(missing_ok=True)
    run(["ssh-keygen", "-t", "ed25519", "-f", str(private_key), "-N", ""])

    ssh_dir.mkdir(mode=0o700, exist_ok=True)
    shutil.copy(public_key, authorized_keys)
    run(["chmod", "700", str(ssh_dir)])
    run(["chmod", "600", str(authorized_keys)])
    run(["chown", "-R", "1000:1000", str(ssh_dir)])

    return private_key


def setup_host_ssh_key(workdir: Path, rootfs: Path) -> Path:
    """Generate a fixed SSH host key for the VM's sshd.

    Private key → baked into the rootfs at /etc/ssh/ so sshd presents a known identity.
    Public key  → returned (installed to /var/lib/fc/vm_host_key.pub so the server
                  can verify the VM and prevent MITM on the TAP network).
    """
    private_key = workdir / "ssh_host_ed25519_key"
    public_key = workdir / "ssh_host_ed25519_key.pub"
    etc_ssh = rootfs / "etc/ssh"

    private_key.unlink(missing_ok=True)
    public_key.unlink(missing_ok=True)
    run(["ssh-keygen", "-t", "ed25519", "-f", str(private_key), "-N", ""])

    etc_ssh.mkdir(parents=True, exist_ok=True)
    shutil.copy(private_key, etc_ssh / "ssh_host_ed25519_key")
    shutil.copy(public_key, etc_ssh / "ssh_host_ed25519_key.pub")
    run(["chmod", "600", str(etc_ssh / "ssh_host_ed25519_key")])

    return public_key


def prepare_rootfs(rootfs: Path) -> None:
    run(["chmod", "1777", str(rootfs / "tmp")])
    (rootfs / "var/cache/apt/archives/partial").mkdir(parents=True, exist_ok=True)
    (rootfs / "var/log/apt").mkdir(parents=True, exist_ok=True)
    (rootfs / "etc/logrotate.d/agent").write_text(LOGROTATE_CONF)

    # Allow direct-streamlocal (Unix domain socket forwarding) so the relay can
    # open a channel to /tmp/agent.sock without exec'ing a proxy process.
    sshd_config_d = rootfs / "etc/ssh/sshd_config.d"
    sshd_config_d.mkdir(parents=True, exist_ok=True)
    (sshd_config_d / "50-agent.conf").write_text("AllowStreamLocalForwarding yes\n")


def mount_binds(rootfs: Path) -> list[Path]:
    # Replace any symlink at etc/resolv.conf with a plain file so the bind
    # mount has a regular file target (bind-mounting onto a symlink fails).
    resolv_conf = rootfs / "etc/resolv.conf"
    if resolv_conf.is_symlink():
        resolv_conf.unlink()
        resolv_conf.touch()

    mounts = [rootfs / "proc", rootfs / "sys", rootfs / "dev", resolv_conf]
    for mount_point in mounts[:-1]:
        run(["mount", "--bind", f"/{mount_point.name}", str(mount_point)])
    run(["mount", "--bind", "/etc/resolv.conf", str(resolv_conf)])
    return mounts


def unmount_binds(mounts: list[Path]) -> None:
    for mount_point in reversed(mounts):
        subprocess.run(["umount", str(mount_point)], check=False)
    # After unmounting, write a static Cloudflare resolv.conf for runtime DNS
    # and mask systemd-resolved so it cannot recreate the symlink at boot.
    resolv_conf = mounts[-1]
    resolv_conf.write_text("nameserver 1.1.1.1\nnameserver 1.0.0.1\n")
    resolved_mask = (
        resolv_conf.parent.parent / "etc/systemd/system/systemd-resolved.service"
    )
    if not resolved_mask.exists():
        resolved_mask.symlink_to("/dev/null")


def install_system_packages(rootfs: Path) -> None:
    chroot_as_root(rootfs, CHROOT_ROOT_SCRIPT)


def install_claude_code(rootfs: Path) -> None:
    chroot_as_ubuntu(rootfs, CHROOT_USER_SCRIPT)


def install_agent(rootfs: Path, mcp_base_url: str | None = None) -> None:
    opt = rootfs / "opt"
    opt.mkdir(exist_ok=True)
    agent_dest = opt / "agent.py"
    shutil.copy(str(AGENT_PY), str(agent_dest))

    # Patch MCP_SERVERS in agent.py when an MCP base URL is configured so the
    # agent knows to connect to the socat proxy baked into the image.
    if mcp_base_url:
        MCP_SERVERS_VALUE = (
            '{\n    "gemini-websearch": {\n'
            '        "type": "http",\n'
            '        "url": f"http://localhost:{MCP_PROXY_PORT}/mcp",\n'
            "    },\n}"
        )
        agent_text = agent_dest.read_text()
        agent_text = agent_text.replace(
            "MCP_SERVERS: dict = {}",
            f"MCP_SERVERS: dict = {MCP_SERVERS_VALUE}",
        )
        agent_dest.write_text(agent_text)

    run(["chown", "-R", "1000:1000", str(opt)])

    # Install and enable the agent systemd service so agent.py starts on boot.
    systemd_system = rootfs / "etc/systemd/system"
    systemd_system.mkdir(parents=True, exist_ok=True)
    service_dest = systemd_system / "agent.service"
    shutil.copy(str(AGENT_SERVICE), str(service_dest))

    multi_user_wants = systemd_system / "multi-user.target.wants"
    multi_user_wants.mkdir(exist_ok=True)
    service_link = multi_user_wants / "agent.service"
    if not service_link.exists():
        service_link.symlink_to("../agent.service")

    # Install socat MCP proxy service when an MCP base URL is configured.
    if mcp_base_url:
        from urllib.parse import urlparse

        parsed = urlparse(mcp_base_url)
        host = parsed.hostname
        # Validate hostname to prevent injection into the systemd service file.
        if not host or not re.match(r'^[a-zA-Z0-9._-]+$', host):
            sys.exit(f"error: invalid hostname in --mcp-base-url: {host!r}")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if parsed.scheme == "https":
            # verify=0 disables TLS certificate validation. This is required
            # because the upstream MCP server uses an internal/self-signed cert.
            # TODO: Switch to verify=1 with a cafile= once the upstream provides
            # a valid certificate or we bundle the internal CA.
            upstream = f"OPENSSL:{host}:{port},verify=0"
        else:
            upstream = f"TCP:{host}:{port}"
        service_text = f"""\
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
        (systemd_system / "mcp-proxy.service").write_text(service_text)
        proxy_link = multi_user_wants / "mcp-proxy.service"
        if not proxy_link.exists():
            proxy_link.symlink_to("../mcp-proxy.service")

    # Pre-warm the uv package cache as the ubuntu user so the first VM startup
    # is instant.  Running any script with the same dependency set populates
    # uv's global package cache; subsequent `uv run /opt/agent.py` calls
    # install from the cache (no network needed).
    # Non-fatal: the agent works without the cache; deps install on first run.
    result = subprocess.run(
        [
            "chroot",
            str(rootfs),
            "su",
            "-",
            "ubuntu",
            "-c",
            "bash -lc '/usr/local/bin/uv run --with claude-agent-sdk"
            ' python3 -c "import claude_agent_sdk"\'',
        ],
    )
    if result.returncode != 0:
        print("warning: uv prewarm failed (agent will install deps on first run)")


def ensure_claude_dir(rootfs: Path) -> None:
    claude_dir = rootfs / "home/ubuntu/.claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    run(["chown", "-R", "1000:1000", str(claude_dir)])


def build_ext4_image(workdir: Path, rootfs: Path, ubuntu_name: str) -> Path:
    ext4 = workdir / f"{ubuntu_name}.ext4"
    ext4.unlink(missing_ok=True)
    run(["truncate", "-s", "10G", str(ext4)])
    run(["mkfs.ext4", "-d", str(rootfs), "-F", str(ext4)])
    run(["rm", "-rf", str(rootfs)])
    return ext4


def install_artifacts(
    kernel: Path,
    ext4: Path,
    client_ssh_key: Path,
    host_ssh_key_pub: Path,
    ubuntu_name: str,
) -> tuple[Path, Path, Path, Path]:
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)

    kernel_dest = INSTALL_DIR / kernel.name
    ext4_dest = INSTALL_DIR / ext4.name
    client_key_dest = INSTALL_DIR / f"{ubuntu_name}.id_ed25519"
    host_key_pub_dest = INSTALL_DIR / "vm_host_key.pub"

    shutil.move(str(kernel), str(kernel_dest))
    shutil.move(str(ext4), str(ext4_dest))
    shutil.move(str(client_ssh_key), str(client_key_dest))
    shutil.copy(str(host_ssh_key_pub), str(host_key_pub_dest))

    run(["chown", "-R", "ubuntu:ubuntu", str(INSTALL_DIR)])
    client_key_dest.chmod(0o600)

    return kernel_dest, ext4_dest, client_key_dest, host_key_pub_dest


# ── smoke test ────────────────────────────────────────────────────────────────


def smoke_test(kernel: Path, ext4: Path, client_key: Path, host_key_pub: Path) -> None:
    """Boot a temporary Firecracker VM and verify SSH authentication works."""
    if not shutil.which("firecracker"):
        print("Skipping smoke test: firecracker not found in PATH")
        return

    print("\nRunning smoke test...")
    tap = "tap-fctest"
    host_ip = "10.123.0.1"
    guest_ip = "10.123.0.2"

    with tempfile.TemporaryDirectory(prefix="fc-test-") as tmp:
        socket_path = Path(tmp) / "firecracker.socket"
        test_rootfs = Path(tmp) / "rootfs.ext4"

        print("  Copying rootfs for test (sparse)...")
        run(["cp", "--sparse=always", str(ext4), str(test_rootfs)])

        setup_test_tap(tap, host_ip)
        fc_proc = None
        try:
            fc_proc = boot_vm(kernel, test_rootfs, tap, host_ip, guest_ip, socket_path)
            verify_ssh(guest_ip, client_key, host_key_pub)
        finally:
            if fc_proc:
                fc_proc.terminate()
                fc_proc.wait()
            teardown_test_tap(tap)


def setup_test_tap(tap: str, host_ip: str) -> None:
    subprocess.run(["ip", "tuntap", "del", tap, "mode", "tap"], check=False)
    run(["ip", "tuntap", "add", tap, "mode", "tap"])
    run(["ip", "addr", "add", f"{host_ip}/30", "dev", tap])
    run(["ip", "link", "set", tap, "up"])


def teardown_test_tap(tap: str) -> None:
    subprocess.run(["ip", "link", "delete", tap], check=False)


def boot_vm(
    kernel: Path,
    rootfs: Path,
    tap: str,
    host_ip: str,
    guest_ip: str,
    socket_path: Path,
) -> subprocess.Popen:
    fc_proc = subprocess.Popen(
        ["firecracker", "--api-sock", str(socket_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    wait_for_socket(socket_path, fc_proc)

    boot_args = (
        "console=ttyS0 reboot=k panic=1 pci=off "
        f"ip={guest_ip}::{host_ip}:255.255.255.252::eth0:none"
    )
    fc_api(
        socket_path,
        "PUT",
        "/boot-source",
        {
            "kernel_image_path": str(kernel),
            "boot_args": boot_args,
        },
    )
    fc_api(
        socket_path,
        "PUT",
        "/drives/rootfs",
        {
            "drive_id": "rootfs",
            "path_on_host": str(rootfs),
            "is_root_device": True,
            "is_read_only": False,
        },
    )
    fc_api(
        socket_path,
        "PUT",
        "/network-interfaces/eth0",
        {
            "iface_id": "eth0",
            "guest_mac": "AA:FC:00:00:00:01",
            "host_dev_name": tap,
        },
    )
    fc_api(socket_path, "PUT", "/actions", {"action_type": "InstanceStart"})
    return fc_proc


def wait_for_socket(socket_path: Path, fc_proc: subprocess.Popen) -> None:
    for _ in range(50):
        if socket_path.exists():
            return
        if fc_proc.poll() is not None:
            sys.exit("error: firecracker exited unexpectedly before socket appeared")
        time.sleep(0.1)
    sys.exit("error: firecracker socket not ready within 5s")


def verify_ssh(guest_ip: str, client_key: Path, host_key_pub: Path) -> None:
    # Build a known_hosts line from the bare public key file.
    # .pub format:  "ssh-ed25519 AAAA... comment"
    # known_hosts:  "ip ssh-ed25519 AAAA... comment"
    known_hosts_line = f"{guest_ip} {host_key_pub.read_text().strip()}\n"

    print(f"  VM started, waiting for SSH at {guest_ip}...")
    print(
        f"  To test manually: ssh -i {client_key} -o UserKnownHostsFile={host_key_pub} -o StrictHostKeyChecking=yes ubuntu@{guest_ip}"
    )
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".known_hosts", delete=False
    ) as kh:
        kh.write(known_hosts_line)
        known_hosts_path = kh.name

    try:
        for _ in range(60):
            time.sleep(1)
            result = subprocess.run(
                [
                    "ssh",
                    "-i",
                    str(client_key),
                    "-o",
                    f"UserKnownHostsFile={known_hosts_path}",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ConnectTimeout=2",
                    "-o",
                    "BatchMode=yes",
                    f"ubuntu@{guest_ip}",
                    "echo ok",
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0 and "ok" in result.stdout:
                print("  SSH authentication: OK")
                print("Smoke test passed.")
                return
    finally:
        Path(known_hosts_path).unlink(missing_ok=True)

    sys.exit("error: smoke test failed — SSH did not succeed within 60s")


def fc_api(socket_path: Path, method: str, path: str, body: dict) -> None:
    class UnixConn(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(str(socket_path))

    conn = UnixConn("localhost")
    conn.request(method, path, json.dumps(body), {"Content-Type": "application/json"})
    resp = conn.getresponse()
    resp.read()
    if resp.status >= 300:
        sys.exit(f"error: Firecracker API {method} {path} returned {resp.status}")


# ── main ──────────────────────────────────────────────────────────────────────


def main() -> None:
    if sys.platform != "linux":
        sys.exit("error: rootfs build requires Linux (for chroot and bind mounts)")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--workdir",
        type=Path,
        default=None,
        help="Directory for intermediate files (default: a fresh temp dir)",
    )
    parser.add_argument(
        "--no-test",
        action="store_true",
        help="Skip the Firecracker smoke test after building",
    )
    parser.add_argument(
        "--mcp-base-url",
        default=None,
        help="MCP server base URL for socat reverse proxy (e.g. https://34.49.122.135)",
    )
    args = parser.parse_args()

    workdir = args.workdir or Path(tempfile.mkdtemp(prefix="fc-build-"))
    workdir.mkdir(parents=True, exist_ok=True)
    print(f"Working directory: {workdir}")

    arch = fetch_arch()
    print(f"Architecture: {arch}")

    print("Fetching latest versions...")
    fc_version = fetch_latest_fc_version()
    kernel_key = fetch_latest_kernel_key(fc_version, arch)
    ubuntu_key = fetch_latest_ubuntu_key(fc_version, arch)
    ubuntu_name = Path(ubuntu_key).stem  # e.g. "ubuntu-24.04"
    print(
        f"Firecracker {fc_version}, kernel {Path(kernel_key).name}, rootfs {ubuntu_name}"
    )

    kernel, squashfs = download_artifacts(
        workdir, fc_version, arch, kernel_key, ubuntu_key
    )

    rootfs = unpack_squashfs(workdir, squashfs)
    client_ssh_key = setup_client_ssh_key(workdir, rootfs)
    host_ssh_key_pub = setup_host_ssh_key(workdir, rootfs)
    prepare_rootfs(rootfs)

    mounts = mount_binds(rootfs)
    try:
        install_system_packages(rootfs)
        install_claude_code(rootfs)
        install_agent(rootfs, mcp_base_url=args.mcp_base_url)
    finally:
        unmount_binds(mounts)

    ensure_claude_dir(rootfs)
    ext4 = build_ext4_image(workdir, rootfs, ubuntu_name)
    kernel_dest, ext4_dest, client_key_dest, host_key_pub_dest = install_artifacts(
        kernel, ext4, client_ssh_key, host_ssh_key_pub, ubuntu_name
    )

    print(f"\nDone. Artifacts installed to {INSTALL_DIR}/:")
    print(f"  {kernel_dest}")
    print(f"  {ext4_dest}")
    print(f"  {client_key_dest}")
    print(f"  {host_key_pub_dest}")

    if not args.no_test:
        smoke_test(kernel_dest, ext4_dest, client_key_dest, host_key_pub_dest)


if __name__ == "__main__":
    main()
