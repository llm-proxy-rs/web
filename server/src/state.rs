use anyhow::{Result, anyhow};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};
use config::{Config, Environment, File};
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use store::PgPool;
use tokio::sync::Mutex as AsyncMutex;
use tracing::error;
use uuid::Uuid;
use vm_lifecycle::{VmBuildConfig, VmRegistry};

use crate::static_files::StaticAssets;

#[derive(Clone, Deserialize)]
pub(crate) struct AppConfig {
    #[serde(default = "default_kernel_path")]
    pub(crate) kernel_path: PathBuf,
    #[serde(default = "default_rootfs_path")]
    pub(crate) rootfs_path: PathBuf,
    #[serde(default = "default_net_helper_path")]
    pub(crate) net_helper_path: PathBuf,
    #[serde(default = "default_ssh_key_path")]
    pub(crate) ssh_key_path: PathBuf,
    #[serde(default = "default_ssh_user")]
    pub(crate) ssh_user: String,
    #[serde(default = "default_ssh_user_home")]
    pub(crate) ssh_user_home: PathBuf,
    #[serde(default = "default_vm_host_key_path")]
    pub(crate) vm_host_key_path: PathBuf,
    #[serde(default)]
    pub(crate) cognito_client_id: String,
    #[serde(default)]
    pub(crate) cognito_client_secret: String,
    #[serde(default)]
    pub(crate) cognito_domain: String,
    #[serde(default = "default_cognito_redirect_uri")]
    pub(crate) cognito_redirect_uri: String,
    #[serde(default)]
    pub(crate) cognito_region: String,
    #[serde(default)]
    pub(crate) cognito_user_pool_id: String,
    #[serde(default)]
    pub(crate) gateway_cognito_client_id: String,
    #[serde(default)]
    pub(crate) gateway_cognito_client_secret: String,
    #[serde(default)]
    pub(crate) gateway_cognito_domain: String,
    #[serde(default)]
    pub(crate) gateway_cognito_redirect_uri: String,
    #[serde(default)]
    pub(crate) gateway_cognito_region: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) gateway_cognito_user_pool_id: String,
    #[serde(default)]
    pub(crate) gateway_api_url: String,
    #[serde(default)]
    pub(crate) gateway_tls_accept_invalid_certs: bool,
    #[serde(default)]
    pub(crate) gateway_identity_provider: String,
    #[serde(default = "default_user_rootfs_dir")]
    pub(crate) user_rootfs_dir: PathBuf,
    #[serde(default = "default_upload_dir")]
    pub(crate) upload_dir: PathBuf,
    #[serde(default = "default_database_url")]
    pub(crate) database_url: String,
    #[serde(default = "default_port")]
    pub(crate) port: u16,
    #[serde(default = "default_jailer_path")]
    pub(crate) jailer_path: PathBuf,
    #[serde(default = "default_firecracker_path")]
    pub(crate) firecracker_path: PathBuf,
    #[serde(default)]
    pub(crate) jailer_uid: u32,
    #[serde(default)]
    pub(crate) jailer_gid: u32,
    #[serde(default = "default_jailer_chroot_base")]
    pub(crate) jailer_chroot_base: PathBuf,
    #[serde(default = "default_vm_vcpu_count")]
    pub(crate) vm_vcpu_count: u8,
    #[serde(default = "default_vm_mem_size_mib")]
    pub(crate) vm_mem_size_mib: u32,
    #[serde(default = "default_vm_max_count")]
    pub(crate) vm_max_count: usize,
    #[serde(default = "default_true")]
    pub(crate) use_iam_creds: bool,
    #[serde(default = "default_iam_role_name")]
    pub(crate) iam_role_name: String,
    #[serde(default)]
    pub(crate) anthropic_base_url: Option<String>,
    #[serde(default = "default_anthropic_default_haiku_model")]
    pub(crate) anthropic_default_haiku_model: String,
    #[serde(default = "default_anthropic_default_sonnet_model")]
    pub(crate) anthropic_default_sonnet_model: String,
    #[serde(default = "default_anthropic_default_opus_model")]
    pub(crate) anthropic_default_opus_model: String,
    #[serde(default = "default_static_dir")]
    pub(crate) static_dir: PathBuf,
}

fn default_kernel_path() -> PathBuf {
    PathBuf::from("/var/lib/fc/vmlinux")
}
fn default_rootfs_path() -> PathBuf {
    PathBuf::from("/var/lib/fc/rootfs.ext4")
}
fn default_net_helper_path() -> PathBuf {
    PathBuf::from("/usr/local/bin/net-helper")
}
fn default_ssh_key_path() -> PathBuf {
    PathBuf::from("/var/lib/fc/id_rsa")
}
fn default_ssh_user() -> String {
    "ubuntu".to_string()
}
fn default_ssh_user_home() -> PathBuf {
    PathBuf::from("/home/ubuntu")
}
fn default_vm_host_key_path() -> PathBuf {
    PathBuf::from("/var/lib/fc/vm_host_ed25519_key.pub")
}
fn default_cognito_redirect_uri() -> String {
    "http://localhost:3000/callback".to_string()
}
fn default_user_rootfs_dir() -> PathBuf {
    PathBuf::from("/home/ubuntu/fc-users")
}
fn default_upload_dir() -> PathBuf {
    PathBuf::from("/home/ubuntu")
}
fn default_database_url() -> String {
    "postgres://localhost/web".to_string()
}
fn default_port() -> u16 {
    3000
}
fn default_jailer_path() -> PathBuf {
    PathBuf::from("/usr/local/bin/jailer")
}
fn default_firecracker_path() -> PathBuf {
    PathBuf::from("/usr/local/bin/firecracker")
}
fn default_jailer_chroot_base() -> PathBuf {
    PathBuf::from("/srv/jailer")
}
fn default_vm_vcpu_count() -> u8 {
    2
}
fn default_vm_mem_size_mib() -> u32 {
    4096
}
fn default_vm_max_count() -> usize {
    20
}
fn default_iam_role_name() -> String {
    "fc-role".to_string()
}
fn default_true() -> bool {
    true
}
fn default_anthropic_default_haiku_model() -> String {
    "us.anthropic.claude-haiku-4-5-20251001-v1:0".to_string()
}
fn default_anthropic_default_sonnet_model() -> String {
    "us.anthropic.claude-sonnet-4-6".to_string()
}
fn default_anthropic_default_opus_model() -> String {
    "us.anthropic.claude-opus-4-6-v1".to_string()
}
fn default_static_dir() -> PathBuf {
    PathBuf::from("frontend/dist")
}

pub(crate) fn load_config() -> Result<AppConfig> {
    let app_config: AppConfig = Config::builder()
        .add_source(File::with_name("config").required(false))
        .add_source(Environment::default())
        .build()?
        .try_deserialize()?;
    tracing::info!("config loaded");
    Ok(app_config)
}

impl AppConfig {
    pub(crate) fn to_vm_build_config(&self) -> VmBuildConfig {
        VmBuildConfig {
            kernel_path: self.kernel_path.clone(),
            net_helper_path: self.net_helper_path.clone(),
            vcpu_count: self.vm_vcpu_count,
            mem_size_mib: self.vm_mem_size_mib,
            jailer_path: self.jailer_path.clone(),
            firecracker_path: self.firecracker_path.clone(),
            jailer_uid: self.jailer_uid,
            jailer_gid: self.jailer_gid,
            jailer_chroot_base: self.jailer_chroot_base.clone(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: AppConfig,
    pub(crate) db: PgPool,
    pub(crate) vms: VmRegistry,
    pub(crate) provisioning_users: Arc<Mutex<HashSet<Uuid>>>,
    pub(crate) rootfs_lock: Arc<AsyncMutex<()>>,
    pub(crate) static_assets: Arc<StaticAssets>,
}

impl AppState {
    pub(crate) fn new(config: AppConfig, pg_pool: PgPool, static_assets: StaticAssets) -> Self {
        AppState {
            config,
            db: pg_pool,
            vms: Arc::new(Mutex::new(HashMap::new())),
            provisioning_users: Arc::new(Mutex::new(HashSet::new())),
            rootfs_lock: Arc::new(AsyncMutex::new(())),
            static_assets: Arc::new(static_assets),
        }
    }
}

pub(crate) struct AppError(pub(crate) anyhow::Error);

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        error!("internal error: {}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "An internal error occurred",
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(app_error: E) -> Self {
        AppError(app_error.into())
    }
}

pub(crate) fn update_vm_last_activity(vms: &VmRegistry, vm_id: &str) -> Result<()> {
    let mut registry = vms
        .lock()
        .map_err(|_| anyhow!("vm registry lock poisoned"))?;
    if let Some(entry) = registry.get_mut(vm_id) {
        entry.last_activity = Instant::now();
    }
    Ok(())
}

pub(crate) fn find_user_vm(vms: &VmRegistry, user_id: Uuid) -> Result<Option<(String, Ipv4Addr)>> {
    let registry = vms
        .lock()
        .map_err(|_| anyhow!("vm registry lock poisoned"))?;
    Ok(registry
        .iter()
        .find(|(_, e)| e.user_id == user_id)
        .map(|(id, e)| (id.clone(), e.vm.guest_ip())))
}
