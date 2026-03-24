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
use anyhow::{Context, Result};
use common::copy_sparse;
use firecracker_client::{start_instance, stop_instance};
use nix::{
    sys::signal::{Signal, kill},
    unistd::{Gid, Pid, Uid},
};
use std::{
    collections::BTreeSet,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tokio::fs::rename;
use tracing::{info, warn};

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

    fn rootfs_copy(&self) -> PathBuf {
        self.chroot_dir.join("rootfs.ext4")
    }

    pub async fn save_rootfs(&self, dest: &Path) -> Result<()> {
        stop_vm(&self.socket_path(), self.pid).await;
        let rootfs_copy = self.rootfs_copy();
        if rename(&rootfs_copy, dest).await.is_err() {
            copy_sparse(&rootfs_copy, dest)
                .await
                .with_context(|| format!("failed to copy rootfs to {}", dest.display()))?;
        }
        Ok(())
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        if let Ok(raw_pid) = i32::try_from(self.pid) {
            let _ = kill(Pid::from_raw(raw_pid), Signal::SIGTERM);
        }
        let tap_name = format_tap_name(self.net_idx);
        let _ = std::process::Command::new(&self.net_helper_path)
            .args(["tap-delete", &tap_name])
            .status();
        let _ = std::fs::remove_dir_all(&self.chroot_dir);
        release_net_idx(self.net_idx);
    }
}

async fn stop_vm(socket_path: &Path, pid: u32) {
    if stop_instance(socket_path).await.is_err() {
        warn!("failed to stop VM instance gracefully");
    }
    if tokio::time::timeout(Duration::from_secs(10), wait_for_process_exit(pid))
        .await
        .is_err()
        && let Ok(raw_pid) = i32::try_from(pid)
        && let Err(_) = kill(Pid::from_raw(raw_pid), Signal::SIGKILL)
    {
        warn!("failed to SIGKILL process {pid}");
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
        let _ = tokio::fs::remove_dir_all(&chroot_dir).await;
    }
    result
}

async fn prepare_vm_rootfs(
    source_rootfs: &Path,
    rootfs_copy: &Path,
    jailer: &JailerConfig,
) -> Result<()> {
    info!("copying rootfs");
    copy_sparse(source_rootfs, rootfs_copy).await?;
    nix::unistd::chown(
        rootfs_copy,
        Some(Uid::from_raw(jailer.uid)),
        Some(Gid::from_raw(jailer.gid)),
    )
    .context("failed to chown rootfs copy for jailer")?;
    Ok(())
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
    let rootfs_copy = chroot_dir.join("rootfs.ext4");
    let socket_path = chroot_dir.join("run/firecracker.socket");

    prepare_jail_resources(chroot_dir, &vm_config.kernel_path).await?;
    prepare_vm_rootfs(&vm_config.rootfs_path, &rootfs_copy, &vm_config.jailer).await?;
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
