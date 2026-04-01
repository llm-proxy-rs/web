use anyhow::{Context, Result};
use firecracker_client::{start_instance, stop_instance};
use nix::{
    sys::signal::{Signal, kill},
    unistd::{Gid, Pid, Uid},
};
use std::{
    collections::BTreeSet,
    fs::Permissions,
    net::Ipv4Addr,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tracing::warn;

use crate::{
    configure::configure_vm,
    network::{
        create_tap, delete_tap, format_guest_ip, format_guest_mac, format_tap_ip, format_tap_name,
    },
    process::{
        build_chroot_dir, build_vm_boot_args, prepare_jail_resources, spawn_firecracker_jailed,
        wait_for_socket,
    },
};

static VM_NET_INDICES: Mutex<BTreeSet<u8>> = Mutex::new(BTreeSet::new());

fn acquire_net_idx() -> Result<Option<u8>> {
    let mut used = VM_NET_INDICES
        .lock()
        .map_err(|_| anyhow::anyhow!("VM network index lock poisoned"))?;
    let idx = (0..254u8).find(|i| !used.contains(i));
    if let Some(i) = idx {
        used.insert(i);
    }
    Ok(idx)
}

fn release_net_idx(idx: u8) {
    match VM_NET_INDICES.lock() {
        Ok(mut used) => {
            used.remove(&idx);
        }
        Err(_) => warn!("VM network index lock poisoned on release"),
    }
}

pub struct JailerConfig {
    pub jailer_path: PathBuf,
    pub firecracker_path: PathBuf,
    pub uid: u32,
    pub gid: u32,
    pub chroot_base: PathBuf,
}

pub struct VmConfig {
    pub id: String,
    pub kernel_path: PathBuf,
    pub rootfs_path: PathBuf,
    pub net_helper_path: PathBuf,
    pub vcpu_count: u8,
    pub mem_size_mib: u32,
    pub boot_args: String,
    pub mmds_metadata: Option<serde_json::Value>,
    pub mmds_imds_compat: bool,
    pub jailer: JailerConfig,
}

pub struct Vm {
    pub id: String,
    pub pid: u32,
    net_idx: u8,
    net_helper_path: PathBuf,
    chroot_dir: PathBuf,
}

impl Vm {
    pub fn guest_ip(&self) -> Ipv4Addr {
        format_guest_ip(self.net_idx)
    }

    pub fn socket_path(&self) -> PathBuf {
        self.chroot_dir.join("run/firecracker.socket")
    }

    /// Gracefully stops the VM so the guest flushes its filesystem.
    /// The rootfs remains in the chroot — no copy needed.
    pub async fn stop(&self) {
        stop_vm(&self.socket_path(), self.pid).await;
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        if let Ok(raw_pid) = i32::try_from(self.pid) {
            // Kill the entire process group (sudo + jailer + firecracker),
            // then the individual process as a fallback in case it isn't
            // the process group leader.
            let _ = kill(Pid::from_raw(-raw_pid), Signal::SIGKILL);
            let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
        }
        let tap_name = format_tap_name(self.net_idx);
        let _ = std::process::Command::new(&self.net_helper_path)
            .args(["tap-delete", &tap_name])
            .status();
        cleanup_chroot(&self.chroot_dir);
        release_net_idx(self.net_idx);
    }
}

/// Removes everything in the chroot directory except rootfs.ext4 and vmlinux.
pub(crate) fn cleanup_chroot(chroot_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(chroot_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == "rootfs.ext4" || name == "vmlinux" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

async fn stop_vm(socket_path: &Path, pid: u32) {
    if stop_instance(socket_path).await.is_err() {
        warn!("failed to stop VM instance gracefully");
    }
    if tokio::time::timeout(Duration::from_secs(10), wait_for_process_exit(pid))
        .await
        .is_err()
    {
        // Process didn't exit in time — force kill the process group and individual process.
        if let Ok(raw_pid) = i32::try_from(pid) {
            let _ = kill(Pid::from_raw(-raw_pid), Signal::SIGKILL);
            let _ = kill(Pid::from_raw(raw_pid), Signal::SIGKILL);
        }
    }
}

async fn wait_for_process_exit(pid: u32) {
    loop {
        if !Path::new(&format!("/proc/{pid}")).exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn create_vm(vm_config: &VmConfig) -> Result<Vm> {
    let net_idx =
        acquire_net_idx()?.context("no free network indices (254 VMs already running)")?;
    let tap_name = format_tap_name(net_idx);
    let chroot_dir = build_chroot_dir(&vm_config.jailer.chroot_base, &vm_config.id);
    let result = launch_vm(vm_config, net_idx, &tap_name, &chroot_dir).await;
    if result.is_err() {
        delete_tap(&vm_config.net_helper_path, &tap_name).await;
        release_net_idx(net_idx);
        cleanup_chroot(&chroot_dir);
    }
    result
}

async fn launch_vm(
    vm_config: &VmConfig,
    net_idx: u8,
    tap_name: &str,
    chroot_dir: &Path,
) -> Result<Vm> {
    create_tap(
        &vm_config.net_helper_path,
        tap_name,
        &format_tap_ip(net_idx)?,
    )
    .await?;
    let mac = format_guest_mac(net_idx);
    let boot_args = build_vm_boot_args(&vm_config.boot_args, &format_guest_ip(net_idx), net_idx);
    let kernel_path_in_jail = PathBuf::from("/vmlinux");
    let rootfs_path_in_jail = PathBuf::from("/rootfs.ext4");
    let socket_path = chroot_dir.join("run/firecracker.socket");

    prepare_jail_resources(chroot_dir, &vm_config.kernel_path).await?;
    // Set rootfs permissions for the jailer user (rootfs is already in the chroot)
    let rootfs_in_chroot = chroot_dir.join("rootfs.ext4");
    std::fs::set_permissions(&rootfs_in_chroot, Permissions::from_mode(0o644))
        .context("failed to set rootfs permissions")?;
    nix::unistd::chown(
        &rootfs_in_chroot,
        Some(Uid::from_raw(vm_config.jailer.uid)),
        Some(Gid::from_raw(vm_config.jailer.gid)),
    )
    .context("failed to chown rootfs for jailer")?;
    let child = spawn_firecracker_jailed(&vm_config.id, &vm_config.jailer)?;
    let pid = child
        .id()
        .context("process exited before pid was available")?;
    wait_for_socket(&socket_path).await?;
    configure_vm(
        &socket_path,
        &rootfs_path_in_jail,
        &kernel_path_in_jail,
        vm_config,
        tap_name,
        &mac,
        &boot_args,
    )
    .await?;
    start_instance(&socket_path).await?;

    Ok(Vm {
        id: vm_config.id.clone(),
        pid,
        net_idx,
        net_helper_path: vm_config.net_helper_path.clone(),
        chroot_dir: chroot_dir.to_path_buf(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_chroot_preserves_rootfs_and_vmlinux() {
        let tmp = std::env::temp_dir().join("test_cleanup_preserve");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("rootfs.ext4"), b"rootfs").unwrap();
        std::fs::write(tmp.join("vmlinux"), b"kernel").unwrap();
        std::fs::write(tmp.join("other.file"), b"x").unwrap();
        std::fs::create_dir_all(tmp.join("subdir")).unwrap();

        cleanup_chroot(&tmp);

        assert!(tmp.join("rootfs.ext4").exists());
        assert!(tmp.join("vmlinux").exists());
        assert!(!tmp.join("other.file").exists());
        assert!(!tmp.join("subdir").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cleanup_chroot_removes_dev_and_run_dirs() {
        let tmp = std::env::temp_dir().join("test_cleanup_dev_run");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("dev/net")).unwrap();
        std::fs::write(tmp.join("dev/net/tun"), b"").unwrap();
        std::fs::create_dir_all(tmp.join("run")).unwrap();
        std::fs::write(tmp.join("run/firecracker.socket"), b"").unwrap();

        cleanup_chroot(&tmp);

        assert!(!tmp.join("dev").exists());
        assert!(!tmp.join("run").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cleanup_chroot_handles_empty_dir() {
        let tmp = std::env::temp_dir().join("test_cleanup_empty");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        cleanup_chroot(&tmp); // should not panic

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cleanup_chroot_handles_missing_dir() {
        let tmp = std::env::temp_dir().join("test_cleanup_missing_nonexistent");
        let _ = std::fs::remove_dir_all(&tmp);

        cleanup_chroot(&tmp); // should not panic
    }
}
