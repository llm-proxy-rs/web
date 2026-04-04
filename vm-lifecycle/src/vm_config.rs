use anyhow::Result;
use firecracker_manager::{JailerConfig, VmConfig, build_mmds_with_iam};
use std::path::Path;
use tracing::info;
use uuid::Uuid;

use crate::{VmBuildConfig, iam::HostIamCredential};

const BOOT_ARGS: &str = "reboot=k panic=1 quiet loglevel=3 selinux=0 8250.nr_uarts=0";

pub fn build_vm_config(
    vm_build_config: &VmBuildConfig,
    iam_creds: &HostIamCredential,
    user_rootfs: &Path,
    user_id: Uuid,
) -> Result<VmConfig> {
    let vm_id = user_id.to_string();
    let mmds_metadata = build_mmds_with_iam(&vm_id, &iam_creds.role_name, &iam_creds.credential)?;
    info!("configured mmds");
    Ok(VmConfig {
        id: vm_id,
        kernel_path: vm_build_config.kernel_path.clone(),
        rootfs_path: user_rootfs.to_path_buf(),
        net_helper_path: vm_build_config.net_helper_path.clone(),
        vcpu_count: vm_build_config.vcpu_count,
        mem_size_mib: vm_build_config.mem_size_mib,
        boot_args: BOOT_ARGS.to_string(),
        mmds_metadata: Some(mmds_metadata),
        mmds_imds_compat: true,
        jailer: JailerConfig {
            jailer_path: vm_build_config.jailer_path.clone(),
            firecracker_path: vm_build_config.firecracker_path.clone(),
            uid: vm_build_config.jailer_uid,
            gid: vm_build_config.jailer_gid,
            chroot_base: vm_build_config.jailer_chroot_base.clone(),
        },
    })
}

pub fn build_vm_config_without_iam(
    vm_build_config: &VmBuildConfig,
    user_rootfs: &Path,
    user_id: Uuid,
) -> VmConfig {
    let vm_id = user_id.to_string();
    VmConfig {
        id: vm_id,
        kernel_path: vm_build_config.kernel_path.clone(),
        rootfs_path: user_rootfs.to_path_buf(),
        net_helper_path: vm_build_config.net_helper_path.clone(),
        vcpu_count: vm_build_config.vcpu_count,
        mem_size_mib: vm_build_config.mem_size_mib,
        boot_args: BOOT_ARGS.to_string(),
        mmds_metadata: None,
        mmds_imds_compat: false,
        jailer: JailerConfig {
            jailer_path: vm_build_config.jailer_path.clone(),
            firecracker_path: vm_build_config.firecracker_path.clone(),
            uid: vm_build_config.jailer_uid,
            gid: vm_build_config.jailer_gid,
            chroot_base: vm_build_config.jailer_chroot_base.clone(),
        },
    }
}
