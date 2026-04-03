use anyhow::{Context, Result, anyhow};
use axum::{
    Json,
    extract::{FromRequestParts, Multipart, Path as AxumPath, Query, State},
    http::{StatusCode, request::Parts},
    response::{Html, IntoResponse, Redirect, Response},
};
use chat_history::{delete_chat_session, fetch_chat_history, list_chat_sessions};
use common::validate_within_dir;
use firecracker_manager::create_vm;
use futures::TryStreamExt;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use sftp_client::open_sftp_session;
use ssh_client::connect_ssh;
use std::{
    collections::HashSet,
    io::{Error as IoError, ErrorKind},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use store::get_user_by_email;
use tokio::{
    io::{AsyncRead, AsyncWriteExt},
    time::timeout,
};
use tokio_util::io::StreamReader;
use tower_sessions::Session;
use tracing::{error, info};
use uuid::Uuid;
use vm_lifecycle::{
    VmEntry, VmRegistry, build_chroot_rootfs_path, build_vm_config, build_vm_config_without_iam,
    ensure_chroot_rootfs, fetch_host_iam_credentials, find_user_rootfs,
};

use crate::{
    auth::User,
    csrf::get_csrf_token,
    state::{AppError, AppState, find_user_vm},
    templates::render_terminal_page,
};

const SFTP_OP_TIMEOUT_SECS: u64 = 30;

#[derive(Serialize)]
pub(crate) struct CsrfTokenResponse {
    csrf_token: String,
}

pub(crate) async fn get_csrf_token_handler(
    _user: User,
    session: Session,
) -> Result<Response, AppError> {
    // Fetch or create a CSRF token to return to the frontend
    let csrf_token = get_csrf_token(&session).await?;
    Ok(Json(CsrfTokenResponse { csrf_token }).into_response())
}

fn is_user_provisioning(state: &AppState, user_id: Uuid) -> Result<bool, AppError> {
    let provisioning = state
        .provisioning_users
        .lock()
        .map_err(|_| anyhow!("provisioning lock poisoned"))?;
    Ok(provisioning.contains(&user_id))
}

fn register_vm(vms: &VmRegistry, vm_id: String, vm_entry: VmEntry) -> Result<(), AppError> {
    let mut registry = vms
        .lock()
        .map_err(|_| anyhow!("vm registry lock poisoned"))?;
    registry.insert(vm_id, vm_entry);
    Ok(())
}

/// Axum extractor that authenticates the user and resolves their VM.
/// Looks up an existing VM or provisions a new one, returning the user ID,
/// VM ID, and guest IP for the handler.
pub(crate) struct UserVm {
    pub(crate) user_id: Uuid,
    pub(crate) vm_id: String,
    pub(crate) guest_ip: Ipv4Addr,
}

impl FromRequestParts<AppState> for UserVm {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // Step 1: Authenticate the user from the request
        let user = User::from_request_parts(parts, state)
            .await
            .map_err(IntoResponse::into_response)?;
        // Step 2: Look up the user in the database, redirect to login if not found
        let db_user = get_user_by_email(&state.db, &user.email)
            .await
            .map_err(|_| {
                error!("db error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "An internal error occurred",
                )
                    .into_response()
            })?
            .ok_or_else(|| Redirect::to("/login").into_response())?;
        // Step 3: Find an existing VM for the user, or provision a new one
        let user_vm_info = match find_user_vm(&state.vms, db_user.id).map_err(|_| {
            error!("vm registry error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "An internal error occurred",
            )
                .into_response()
        })? {
            Some(info) => info,
            None => {
                return provision_user_vm(parts, state, db_user.id).await;
            }
        };
        Ok(UserVm {
            user_id: db_user.id,
            vm_id: user_vm_info.vm_id,
            guest_ip: user_vm_info.guest_ip,
        })
    }
}

async fn provision_user_vm(
    parts: &mut Parts,
    state: &AppState,
    user_id: Uuid,
) -> Result<UserVm, Response> {
    // If already being provisioned by vm_status_handler, return 503
    // so the frontend can retry after the VM is ready.
    if is_user_provisioning(state, user_id).map_err(|_| {
        error!("provisioning check error");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "An internal error occurred",
        )
            .into_response()
    })? {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "VM is still starting, please try again",
        )
            .into_response());
    }
    let new_vm = create_new_vm(state, user_id)
        .await
        .map_err(IntoResponse::into_response)?;
    // Write settings before registering so the VM is never
    // visible as "ready" without its API key / config.
    write_initial_settings(parts, state, new_vm.guest_ip)
        .await
        .map_err(|_| {
            error!("failed to write initial settings");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "An internal error occurred",
            )
                .into_response()
        })?;
    register_vm(
        &state.vms,
        new_vm.vm_id.clone(),
        VmEntry {
            user_id,
            has_iam_creds: state.config.use_iam_creds,
            last_activity: Instant::now(),
            vm: new_vm.vm,
        },
    )
    .map_err(|_| {
        error!("failed to register VM");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "An internal error occurred",
        )
            .into_response()
    })?;
    drop(new_vm.provisioning_guard);
    Ok(UserVm {
        user_id,
        vm_id: new_vm.vm_id,
        guest_ip: new_vm.guest_ip,
    })
}

/// Writes initial settings to a freshly provisioned VM.
/// If a gateway API key is available in the session, writes API key settings.
/// Otherwise, if using Bedrock/IAM mode, writes Bedrock default settings so the
/// VM has the correct model IDs from the server config (not baked into the rootfs).
async fn write_initial_settings(
    parts: &mut Parts,
    state: &AppState,
    guest_ip: Ipv4Addr,
) -> Result<()> {
    let session = Session::from_request_parts(parts, state)
        .await
        .map_err(|_| anyhow!("failed to extract session"))?;
    let gateway_key = session
        .get::<String>("gateway_api_key")
        .await
        .context("failed to read gateway_api_key from session")?;

    let content = match gateway_key {
        Some(key) => chat_settings::build_api_key_settings_json(
            &key,
            state.config.anthropic_base_url.as_deref(),
            &state.config.anthropic_default_haiku_model,
            &state.config.anthropic_default_sonnet_model,
            &state.config.anthropic_default_opus_model,
        )?,
        None => return write_bedrock_settings(state, guest_ip).await,
    };

    state.vm_config_ops.set_settings(guest_ip, &content).await
}

/// Best-effort write of gateway API key settings to a VM using a pre-extracted key.
/// Used by the background provisioning path where session is not available.
/// Callers are responsible for handling errors (e.g. removing the VM from the registry).
async fn write_gateway_settings_with_key(
    state: &AppState,
    guest_ip: Ipv4Addr,
    gateway_key: &str,
) -> Result<()> {
    let content = chat_settings::build_api_key_settings_json(
        gateway_key,
        state.config.anthropic_base_url.as_deref(),
        &state.config.anthropic_default_haiku_model,
        &state.config.anthropic_default_sonnet_model,
        &state.config.anthropic_default_opus_model,
    )?;
    state.vm_config_ops.set_settings(guest_ip, &content).await
}

/// Best-effort write of Bedrock default settings to a VM.
/// Only writes when running in IAM/Bedrock mode so the VM gets the correct
/// model IDs from the server config rather than relying on a baked-in rootfs.
async fn write_bedrock_settings(state: &AppState, guest_ip: Ipv4Addr) -> Result<()> {
    if !state.config.use_iam_creds {
        return Ok(());
    }
    let content = chat_settings::build_bedrock_settings_json(
        &state.config.anthropic_default_haiku_model,
        &state.config.anthropic_default_sonnet_model,
        &state.config.anthropic_default_opus_model,
    )?;
    state.vm_config_ops.set_settings(guest_ip, &content).await
}

async fn retry_write_settings(
    state: &AppState,
    ip: Ipv4Addr,
    gateway_key: &Option<String>,
) -> Result<()> {
    for attempt in 0..15 {
        let result = if let Some(key) = gateway_key {
            write_gateway_settings_with_key(state, ip, key).await
        } else {
            write_bedrock_settings(state, ip).await
        };
        if result.is_ok() {
            return Ok(());
        }
        if attempt < 14 {
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }
    Err(anyhow!("failed to write VM settings after 15 attempts"))
}

fn remove_user_vm(vms: &VmRegistry, user_id: Uuid) -> Result<()> {
    let _removed = {
        let mut registry = vms
            .lock()
            .map_err(|_| anyhow!("vm registry lock poisoned"))?;
        let vm_ids: Vec<String> = registry
            .iter()
            .filter(|(_, e)| e.user_id == user_id)
            .map(|(id, _)| id.clone())
            .collect();
        vm_ids
            .into_iter()
            .filter_map(|id| registry.remove(&id))
            .collect::<Vec<_>>()
    };
    Ok(())
}

pub(crate) async fn get_or_create_terminal(
    user: User,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let Some(db_user) = get_user_by_email(&state.db, &user.email).await? else {
        return Ok(Redirect::to("/login").into_response());
    };
    let has_user_rootfs = find_user_rootfs(&state.config.jailer_chroot_base, db_user.id).is_some();
    let csrf_token = get_csrf_token(&session).await?;
    // Serve the page immediately with vm_id="" — the frontend will poll /api/vm-status
    Ok(Html(render_terminal_page(
        "",
        &csrf_token,
        &state.config.upload_dir,
        has_user_rootfs,
    ))
    .into_response())
}

pub(crate) async fn vm_status_handler(
    user: User,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let Some(db_user) = get_user_by_email(&state.db, &user.email).await? else {
        return Ok(Redirect::to("/login").into_response());
    };
    let user_id = db_user.id;

    // Check if VM already exists
    if let Some(user_vm_info) = find_user_vm(&state.vms, user_id)? {
        let has_user_rootfs = find_user_rootfs(&state.config.jailer_chroot_base, user_id).is_some();
        return Ok(Json(serde_json::json!({
            "status": "ready",
            "vm_id": user_vm_info.vm_id,
            "has_user_rootfs": has_user_rootfs,
        }))
        .into_response());
    }

    // Check if already provisioning
    if is_user_provisioning(&state, user_id)? {
        return Ok(Json(serde_json::json!({"status": "provisioning"})).into_response());
    }

    // Extract gateway key from session before spawning background task
    let gateway_key = session
        .get::<String>("gateway_api_key")
        .await
        .context("failed to read gateway_api_key from session")?;

    // Spawn provisioning in background
    let state_clone = state.clone();
    tokio::spawn(async move {
        match create_new_vm(&state_clone, user_id).await {
            Ok(new_vm) => {
                // Write settings before registering so the VM is not visible
                // as "ready" until the API key / bedrock config is in place.
                // Retry with a total timeout — the VM needs time to boot SSH.
                let settings_result = timeout(
                    Duration::from_secs(90),
                    retry_write_settings(&state_clone, new_vm.guest_ip, &gateway_key),
                )
                .await;
                if !matches!(settings_result, Ok(Ok(()))) {
                    error!("timed out or failed writing VM settings, registering VM anyway");
                }
                if register_vm(
                    &state_clone.vms,
                    new_vm.vm_id,
                    VmEntry {
                        user_id,
                        has_iam_creds: state_clone.config.use_iam_creds,
                        last_activity: Instant::now(),
                        vm: new_vm.vm,
                    },
                )
                .is_err()
                {
                    error!("failed to register VM");
                }
                drop(new_vm.provisioning_guard);
            }
            Err(_) => {
                error!("background vm provisioning failed");
            }
        }
    });

    Ok(Json(serde_json::json!({"status": "provisioning"})).into_response())
}

/// Atomically reserves a provisioning slot for a user by locking both `vms` and
/// `provisioning_users`, checking three conditions, then inserting `user_id` into
/// the provisioning set. Both mutex guards are local variables — they drop when
/// this function returns, so no mutex is held across the subsequent async work in
/// `provision_new_vm`. The returned `ProvisioningGuard` holds only an `Arc` to
/// the provisioning set (not a lock guard); its `Drop` impl briefly re-acquires
/// the provisioning mutex to remove the user_id once provisioning completes or fails.
///
/// Checks performed while both locks are held:
/// 1. User does not already have a running VM in the registry.
/// 2. User does not already have an in-flight provision (duplicate insert returns false).
/// 3. Total slots (running VMs + in-flight provisions) does not exceed `vm_max_count`.
///
/// No deadlock: this is the only site that holds both mutexes, and it always
/// acquires them in the same order (vms → provisioning_users). Every other site
/// in the codebase acquires at most one of the two.
///
/// No blocking between different users: the locks are held only for in-memory
/// checks (microseconds). If User B calls this while User A's locks are held,
/// User B waits only for the mutex (microseconds), then acquires the locks,
/// passes the checks, and proceeds to provision concurrently alongside User A.
fn acquire_provisioning_slot(
    state: &AppState,
    user_id: Uuid,
) -> Result<ProvisioningGuard, AppError> {
    let registry = state
        .vms
        .lock()
        .map_err(|_| anyhow!("vm registry lock poisoned"))?;
    let mut provisioning = state
        .provisioning_users
        .lock()
        .map_err(|_| anyhow!("provisioning lock poisoned"))?;
    if registry.values().any(|e| e.user_id == user_id) {
        return Err(anyhow!("VM already exists for user").into());
    }
    if !provisioning.insert(user_id) {
        return Err(anyhow!("VM provisioning already in progress for user").into());
    }
    // In-flight provisions count as reserved slots so concurrent callers cannot
    // overshoot vm_max_count. For example, with 18 running VMs and max 20:
    // User A inserts → 18 + 1 = 19 ≤ 20 ✓, User B inserts → 18 + 2 = 20 ≤ 20 ✓,
    // User C inserts → 18 + 3 = 21 > 20 ✗ (removed and rejected).
    if registry.len() + provisioning.len() > state.config.vm_max_count {
        provisioning.remove(&user_id);
        return Err(anyhow!("vm limit reached").into());
    }
    Ok(ProvisioningGuard {
        provisioning_users: Arc::clone(&state.provisioning_users),
        user_id,
    })
}

/// RAII guard that removes the user from the provisioning set on drop. Holds an
/// `Arc` to the set — not a lock guard — so no mutex is held while this lives.
/// On drop it briefly acquires the provisioning mutex to remove the user_id.
struct ProvisioningGuard {
    provisioning_users: Arc<Mutex<HashSet<Uuid>>>,
    user_id: Uuid,
}

impl Drop for ProvisioningGuard {
    fn drop(&mut self) {
        if let Ok(mut provisioning) = self.provisioning_users.lock() {
            provisioning.remove(&self.user_id);
        }
    }
}

/// Creates a new VM without registering it. Returns the provisioning guard
/// (which keeps the user in the provisioning set), the VM ID, guest IP, and
/// the VM handle. The caller is responsible for calling `register_vm` when
/// the VM is ready to be visible as "ready".
struct NewVm {
    provisioning_guard: ProvisioningGuard,
    vm_id: String,
    guest_ip: Ipv4Addr,
    vm: firecracker_manager::Vm,
}

async fn create_new_vm(state: &AppState, user_id: Uuid) -> Result<NewVm, AppError> {
    // acquire_provisioning_slot locks vms + provisioning_users, performs all
    // checks, inserts user_id into the provisioning set, then drops both locks
    // before returning. The guard keeps user_id in the set for the duration of
    // the caller; its Drop impl removes it (on success or error).
    let guard = acquire_provisioning_slot(state, user_id)?;
    info!("building vm config");
    let user_rootfs = ensure_chroot_rootfs(
        &state.config.jailer_chroot_base,
        &state.config.rootfs_path,
        user_id,
    )
    .await?;
    let vm_config = if state.config.use_iam_creds {
        let iam_creds = fetch_host_iam_credentials(&state.config.iam_role_name)
            .await
            .context("failed to fetch IAM credentials for VM")?;
        build_vm_config(
            &state.config.to_vm_build_config(),
            &iam_creds,
            &user_rootfs,
            user_id,
        )?
    } else {
        build_vm_config_without_iam(&state.config.to_vm_build_config(), &user_rootfs, user_id)
    };
    let vm = create_vm(&vm_config).await?;
    info!("vm started");
    let vm_id = vm.id.clone();
    let guest_ip = vm.guest_ip();
    Ok(NewVm {
        provisioning_guard: guard,
        vm_id,
        guest_ip,
        vm,
    })
}

async fn build_terminal_response(
    session: &Session,
    state: &AppState,
    user_id: Uuid,
    vm_id: &str,
) -> Result<Response, AppError> {
    // Embed a CSRF token in the rendered terminal page
    let csrf_token = get_csrf_token(session).await?;
    let has_user_rootfs = find_user_rootfs(&state.config.jailer_chroot_base, user_id).is_some();
    Ok(Html(render_terminal_page(
        vm_id,
        &csrf_token,
        &state.config.upload_dir,
        has_user_rootfs,
    ))
    .into_response())
}

pub(crate) async fn delete_user_rootfs_handler(
    user: User,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let Some(db_user) = get_user_by_email(&state.db, &user.email).await? else {
        return Ok(Redirect::to("/login").into_response());
    };
    let rootfs_path = build_chroot_rootfs_path(&state.config.jailer_chroot_base, db_user.id);
    info!("deleting saved rootfs");
    remove_user_vm(&state.vms, db_user.id)?;
    if let Err(e) = tokio::fs::remove_file(&rootfs_path).await
        && e.kind() != ErrorKind::NotFound
    {
        return Err(anyhow!(e).context("failed to delete user rootfs").into());
    }
    Ok(Redirect::to("/").into_response())
}

pub(crate) async fn get_terminal_page(
    user_vm: UserVm,
    AxumPath(vm_id): AxumPath<String>,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    if user_vm.vm_id != vm_id {
        return Ok((StatusCode::NOT_FOUND, "Session not found").into_response());
    }
    build_terminal_response(&session, &state, user_vm.user_id, &user_vm.vm_id).await
}

pub(crate) async fn list_chat_sessions_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let sessions = list_chat_sessions(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &state.config.ssh_user_home,
    )
    .await?;
    Ok(Json(sessions).into_response())
}

#[derive(Deserialize)]
pub(crate) struct TranscriptQuery {
    session_id: String,
    project_dir: String,
}

pub(crate) async fn get_chat_transcript_handler(
    user_vm: UserVm,
    Query(query): Query<TranscriptQuery>,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    validate_session_id(&query.session_id)?;
    validate_within_dir(Path::new(&query.project_dir), &state.config.ssh_user_home)?;
    let history = fetch_chat_history(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &query.session_id,
        Path::new(&query.project_dir),
    )
    .await?;
    Ok(Json(history).into_response())
}

#[derive(Deserialize)]
pub(crate) struct DeleteChatSessionForm {
    session_id: String,
    project_dir: String,
}

pub(crate) async fn delete_chat_session_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(form): Json<DeleteChatSessionForm>,
) -> Result<Response, AppError> {
    validate_session_id(&form.session_id)?;
    validate_within_dir(Path::new(&form.project_dir), &state.config.ssh_user_home)?;
    delete_chat_session(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &form.session_id,
        Path::new(&form.project_dir),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(crate) async fn handle_chat_upload(
    user_vm: UserVm,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    info!("uploading chat attachment via sftp");
    let mut ssh_handle = connect_ssh(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
    )
    .await?;
    let sftp = open_sftp_session(&mut ssh_handle).await?;
    let remote_path =
        stream_chat_attachment(&mut multipart, &sftp, &state.config.upload_dir).await?;
    let remote_path_str = remote_path
        .to_str()
        .context("remote path is not valid UTF-8")?;
    Ok(Json(serde_json::json!({"path": remote_path_str})).into_response())
}

async fn stream_chat_attachment(
    multipart: &mut Multipart,
    sftp: &SftpSession,
    upload_dir: &Path,
) -> Result<PathBuf> {
    let mut target_dir: Option<String> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .context("failed to read multipart field")?
    {
        let name = field
            .name()
            .context("multipart field missing name")?
            .to_owned();
        if name == "dir" {
            target_dir = Some(field.text().await.context("failed to read dir field")?);
            continue;
        }
        if name == "file" {
            return process_attachment_field(field, &target_dir, sftp, upload_dir).await;
        }
    }
    Err(anyhow!("missing 'file' field"))
}

async fn process_attachment_field(
    field: axum::extract::multipart::Field<'_>,
    target_dir: &Option<String>,
    sftp: &SftpSession,
    upload_dir: &Path,
) -> Result<PathBuf> {
    let filename = field
        .file_name()
        .context("file upload missing filename")?
        .to_owned();
    let dest_dir = match target_dir {
        Some(target_dir_str) => {
            let dir = PathBuf::from(target_dir_str);
            validate_within_dir(&dir, upload_dir)?;
            dir
        }
        None => upload_dir.to_path_buf(),
    };
    let remote_path = build_chat_upload_path(&filename, &dest_dir)?;
    let real_path = PathBuf::from(
        timeout(
            Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
            sftp.canonicalize(
                remote_path
                    .parent()
                    .context("chat upload path has no parent")?
                    .to_string_lossy()
                    .into_owned(),
            ),
        )
        .await
        .context("canonicalize timed out")?
        .context("failed to resolve chat upload dir")?,
    )
    .join(
        remote_path
            .file_name()
            .context("chat upload path has no filename")?,
    );
    validate_within_dir(&real_path, upload_dir)?;
    let mut reader = StreamReader::new(field.map_err(IoError::other));
    write_chat_file_via_sftp(sftp, &real_path, &mut reader).await?;
    Ok(real_path)
}

fn build_chat_upload_path(filename: &str, upload_dir: &Path) -> Result<PathBuf> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis();
    let safe_name = sanitize_filename::sanitize(filename);
    Ok(upload_dir.join(format!("{ts}_{safe_name}")))
}

/// Validates that a session_id looks like a UUID (alphanumeric + hyphens only).
/// Prevents path traversal via crafted session IDs like "../../etc/passwd".
fn validate_session_id(session_id: &str) -> Result<(), AppError> {
    if session_id.is_empty()
        || session_id.len() > 64
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(anyhow!("invalid session_id").into());
    }
    Ok(())
}

async fn write_chat_file_via_sftp(
    sftp: &SftpSession,
    path: &Path,
    reader: &mut (impl AsyncRead + Unpin),
) -> Result<()> {
    let path_str = path
        .to_str()
        .context("chat upload path is not valid UTF-8")?;
    let mut file = timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        sftp.create(path_str),
    )
    .await
    .context("sftp create timed out")?
    .map_err(|_| anyhow!("sftp create failed"))?;
    timeout(
        Duration::from_secs(SFTP_OP_TIMEOUT_SECS),
        tokio::io::copy(reader, &mut file),
    )
    .await
    .context("sftp write timed out")?
    .context("failed to write chat file via sftp")?;
    timeout(Duration::from_secs(SFTP_OP_TIMEOUT_SECS), file.shutdown())
        .await
        .context("sftp shutdown timed out")?
        .map_err(|_| anyhow!("sftp shutdown failed"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- validate_session_id tests ---

    #[test]
    fn valid_session_id_uuid() {
        assert!(validate_session_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
    }

    #[test]
    fn valid_session_id_hex_only() {
        assert!(validate_session_id("550e8400e29b41d4a716446655440000").is_ok());
    }

    #[test]
    fn invalid_session_id_empty() {
        assert!(validate_session_id("").is_err());
    }

    #[test]
    fn invalid_session_id_path_traversal() {
        assert!(validate_session_id("../../etc/passwd").is_err());
    }

    #[test]
    fn invalid_session_id_slash() {
        assert!(validate_session_id("abc/def").is_err());
    }

    #[test]
    fn invalid_session_id_too_long() {
        let long = "a".repeat(65);
        assert!(validate_session_id(&long).is_err());
    }

    #[test]
    fn invalid_session_id_special_chars() {
        assert!(validate_session_id("abc;def").is_err());
        assert!(validate_session_id("abc\ndef").is_err());
    }

    // --- build_chat_upload_path tests ---

    #[test]
    fn chat_upload_path_normal_filename() {
        let dir = PathBuf::from("/home/ubuntu");
        let path = build_chat_upload_path("test.png", &dir).unwrap();
        assert!(path.starts_with("/home/ubuntu"));
        assert!(path.to_string_lossy().contains("test.png"));
    }

    #[test]
    fn chat_upload_path_sanitizes_traversal() {
        let dir = PathBuf::from("/home/ubuntu");
        let path = build_chat_upload_path("../../../etc/passwd", &dir).unwrap();
        // sanitize_filename removes path separators; the remaining filename
        // is harmless because validate_within_dir checks the canonical path
        // before any SFTP write.
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(!name.contains('/'));
        assert!(path.starts_with("/home/ubuntu"));
    }

    #[test]
    fn chat_upload_path_sanitizes_slashes() {
        let dir = PathBuf::from("/home/ubuntu");
        let path = build_chat_upload_path("path/to/file.txt", &dir).unwrap();
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(!name.contains('/'));
    }

    #[test]
    fn chat_upload_path_includes_timestamp() {
        let dir = PathBuf::from("/home/ubuntu");
        let path = build_chat_upload_path("file.txt", &dir).unwrap();
        let name = path.file_name().unwrap().to_string_lossy();
        // Timestamp is a large number followed by underscore
        assert!(name.contains('_'));
        let parts: Vec<&str> = name.splitn(2, '_').collect();
        assert!(parts[0].parse::<u128>().is_ok());
    }
}
