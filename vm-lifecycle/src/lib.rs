use firecracker_manager::Vm;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

mod iam;
mod mmds;
mod rootfs;
mod sweep;
mod vm_config;

pub use iam::{HostIamCredential, fetch_host_iam_credentials};
pub use mmds::refresh_all_vm_mmds;
pub use rootfs::{
    build_user_rootfs_path, ensure_user_rootfs, find_user_rootfs, save_all_vm_rootfs,
};
pub use sweep::sweep_idle_vms;
pub use vm_config::{build_vm_config, build_vm_config_without_iam};

pub struct VmBuildConfig {
    pub kernel_path: PathBuf,
    pub net_helper_path: PathBuf,
    pub vcpu_count: u8,
    pub mem_size_mib: u32,
    pub jailer_path: PathBuf,
    pub firecracker_path: PathBuf,
    pub jailer_uid: u32,
    pub jailer_gid: u32,
    pub jailer_chroot_base: PathBuf,
}

pub type VmRegistry = Arc<Mutex<HashMap<String, VmEntry>>>;

pub struct VmEntry {
    pub user_id: Uuid,
    pub has_iam_creds: bool,
    pub last_activity: Instant,
    pub vm: Vm,
}
