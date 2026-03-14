use anyhow::Result;
use firecracker_client::{
    BootSource, Drive, MachineConfig, MmdsConfig, NetworkInterface, put_mmds, set_boot_source,
    set_drive, set_machine_config, set_mmds_config, set_network_interface,
};
use macaddr::MacAddr6;
use std::path::Path;

use crate::vm::VmConfig;

pub(crate) async fn configure_vm(
    socket_path: &Path,
    rootfs_copy: &Path,
    kernel_path: &Path,
    vm_config: &VmConfig,
    tap_name: &str,
    mac: &MacAddr6,
    boot_args: &str,
) -> Result<()> {
    configure_machine_config(socket_path, vm_config).await?;
    configure_boot_source(socket_path, kernel_path, boot_args).await?;
    configure_rootfs_drive(socket_path, rootfs_copy).await?;
    configure_network_interface(socket_path, tap_name, mac).await?;
    if let Some(metadata) = &vm_config.mmds_metadata {
        configure_mmds(socket_path, vm_config, metadata).await?;
    }
    Ok(())
}

async fn configure_machine_config(socket_path: &Path, vm_config: &VmConfig) -> Result<()> {
    set_machine_config(
        socket_path,
        &MachineConfig {
            vcpu_count: vm_config.vcpu_count,
            mem_size_mib: vm_config.mem_size_mib,
        },
    )
    .await
}

async fn configure_boot_source(
    socket_path: &Path,
    kernel_path: &Path,
    boot_args: &str,
) -> Result<()> {
    set_boot_source(
        socket_path,
        &BootSource {
            kernel_image_path: kernel_path.to_string_lossy().into_owned(),
            boot_args: boot_args.to_string(),
        },
    )
    .await
}

async fn configure_rootfs_drive(socket_path: &Path, rootfs_copy: &Path) -> Result<()> {
    set_drive(
        socket_path,
        &Drive {
            drive_id: "rootfs".to_string(),
            path_on_host: rootfs_copy.to_string_lossy().into_owned(),
            is_root_device: true,
            is_read_only: false,
        },
    )
    .await
}

async fn configure_network_interface(
    socket_path: &Path,
    tap_name: &str,
    mac: &MacAddr6,
) -> Result<()> {
    set_network_interface(
        socket_path,
        &NetworkInterface {
            iface_id: "net1".to_string(),
            guest_mac: mac.to_string(),
            host_dev_name: tap_name.to_string(),
        },
    )
    .await
}

async fn configure_mmds(
    socket_path: &Path,
    vm_config: &VmConfig,
    metadata: &serde_json::Value,
) -> Result<()> {
    set_mmds_config(
        socket_path,
        &MmdsConfig {
            version: vm_config.mmds_imds_compat.then(|| "V2".to_string()),
            network_interfaces: vec!["net1".to_string()],
            imds_compat: vm_config.mmds_imds_compat.then_some(true),
        },
    )
    .await?;
    put_mmds(socket_path, metadata).await
}
