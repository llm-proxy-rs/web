use anyhow::{Context, Result};
use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    fs::{copy, create_dir_all, hard_link},
    process::{Child, Command},
    time::{sleep, timeout},
};

use crate::vm::JailerConfig;

pub(crate) fn spawn_firecracker_jailed(vm_id: &str, jailer: &JailerConfig) -> Result<Child> {
    Ok(Command::new(&jailer.jailer_path)
        .args([
            "--id",
            vm_id,
            "--exec-file",
            &jailer.firecracker_path.to_string_lossy(),
            "--uid",
            &jailer.uid.to_string(),
            "--gid",
            &jailer.gid.to_string(),
            "--chroot-base-dir",
            &jailer.chroot_base.to_string_lossy(),
            "--",
            "--api-sock",
            "/run/firecracker.socket",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(false)
        .process_group(0)
        .spawn()?)
}

pub(crate) async fn wait_for_socket(socket_path: &Path) -> Result<()> {
    timeout(Duration::from_secs(5), async {
        loop {
            if socket_path.exists() {
                return;
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .context("timed out waiting for firecracker socket")
}

pub(crate) fn build_vm_boot_args(base_boot_args: &str, guest_ip: &Ipv4Addr, net_idx: u8) -> String {
    format!(
        "{base_boot_args} ip={guest_ip}::172.16.{net_idx}.1:255.255.255.252::eth0:none:1.1.1.1:1.0.0.1"
    )
}

pub(crate) fn build_chroot_dir(chroot_base: &Path, vm_id: &str) -> PathBuf {
    chroot_base.join("firecracker").join(vm_id).join("root")
}

// Prepares the jail directory. Layout on disk (chroot_dir = <chroot_base>/firecracker/<vm_id>/root/):
//
//   run/
//       firecracker.socket   <- created by firecracker after spawn
//   vmlinux                  <- kernel (hard-linked from host, or copied)
//   rootfs.ext4              <- rootfs copy (written separately by copy_rootfs)
pub(crate) async fn prepare_jail_resources(chroot_dir: &Path, kernel_src: &Path) -> Result<()> {
    create_dir_all(chroot_dir.join("run")).await?;
    let kernel_dst = chroot_dir.join("vmlinux");
    if hard_link(kernel_src, &kernel_dst).await.is_err() {
        copy(kernel_src, &kernel_dst).await.with_context(|| {
            format!(
                "failed to copy kernel from {} to {}",
                kernel_src.display(),
                kernel_dst.display()
            )
        })?;
    }
    Ok(())
}
