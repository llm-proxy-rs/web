mod auth;
mod chat;
mod csrf;
mod download;
mod files;
mod gateway_auth;
mod gateway_callback;
mod handlers;
mod http_client;
mod mcp;
mod mcp_oauth;
mod memory;
mod settings;
mod skills;
mod state;
mod static_files;
mod templates;
mod terminal;
mod upload;

#[cfg(test)]
mod test_helpers;

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request},
    http::HeaderValue,
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post},
};
use firecracker_manager::{clean_stale_vms, setup_host_networking};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use time::Duration;
use tokio::{net::TcpListener, signal, sync::oneshot, task::AbortHandle};
use tower_sessions::{ExpiredDeletion, Expiry, SessionManagerLayer, cookie::SameSite};
use tower_sessions_sqlx_store::PostgresStore;
use tracing::info;
use vm_lifecycle::{refresh_all_vm_mmds, save_all_vm_rootfs, sweep_idle_vms};

use crate::{
    auth::{
        get_callback_handler, get_cognito_login_handler, get_login_handler, get_logout_handler,
    },
    chat::{
        handle_chat_query, handle_chat_question_answer, handle_chat_reconnect, handle_chat_stop,
    },
    csrf::csrf_middleware,
    download::download_file_handler,
    files::{delete_handler, list_files_handler},
    gateway_auth::renew_gateway_key_handler,
    gateway_callback::gateway_callback_handler,
    handlers::{
        delete_chat_session_handler, delete_user_rootfs_handler, get_chat_transcript_handler,
        get_csrf_token_handler, get_or_create_terminal, get_terminal_page, handle_chat_upload,
        list_chat_sessions_handler, vm_status_handler,
    },
    mcp::{
        add_handler as mcp_add_handler, delete_handler as mcp_delete_handler,
        list_handler as mcp_list_handler,
    },
    mcp_oauth::{
        callback_handler as mcp_oauth_callback_handler,
        discover_handler as mcp_oauth_discover_handler,
        register_handler as mcp_oauth_register_handler, start_handler as mcp_oauth_start_handler,
    },
    memory::get_memory_handler,
    settings::{get_settings_handler, put_settings_handler},
    skills::{
        create_handler as skills_create_handler, delete_handler as skills_delete_handler,
        list_handler as skills_list_handler,
    },
    state::{AppState, load_config},
    static_files::{
        load_static_assets, render_oauth_close_page, serve_app_js, serve_font, serve_oauth_close,
        serve_styles_css,
    },
    terminal::handle_ws_upgrade,
    upload::upload_file_handler,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or(tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let app_config = load_config()?;
    let static_assets = load_static_assets(&app_config.static_dir)?;
    let pg_pool = store::connect_db(&app_config.database_url).await?;
    store::run_migrations(&pg_pool).await?;
    let session_store_handle = create_session_store(pg_pool.clone()).await?;
    let vm_config_ops: Arc<dyn chat_settings::VmConfigOps> =
        Arc::new(chat_settings::SshVmConfigOps {
            ssh_key_path: app_config.ssh_key_path.clone(),
            ssh_user: app_config.ssh_user.clone(),
            vm_host_key_path: app_config.vm_host_key_path.clone(),
        });
    let http_client: Arc<dyn http_client::HttpClient> = Arc::new(
        http_client::ReqwestHttpClient::new(std::time::Duration::from_secs(15))
            .expect("failed to build HTTP client"),
    );
    let app_state = AppState::new(
        app_config,
        pg_pool,
        static_assets,
        vm_config_ops,
        http_client,
    );
    let port = app_state.config.port;
    clean_stale_vms(
        &app_state.config.net_helper_path,
        &app_state.config.jailer_chroot_base,
    )
    .await;
    setup_host_networking(&app_state.config.net_helper_path).await?;
    let background_task_handles = spawn_background_tasks(&app_state);
    let router = build_router(app_state.clone(), session_store_handle.store);
    serve_router(
        router,
        port,
        app_state,
        session_store_handle.deletion_task.abort_handle(),
        background_task_handles.mmds_refresh,
        background_task_handles.idle_vm_sweep,
    )
    .await?;
    Ok(())
}

struct SessionStoreHandle {
    store: PostgresStore,
    deletion_task: tokio::task::JoinHandle<Result<(), tower_sessions::session_store::Error>>,
}

async fn create_session_store(pg_pool: store::PgPool) -> Result<SessionStoreHandle> {
    let session_store = PostgresStore::new(pg_pool);
    session_store
        .migrate()
        .await
        .context("failed to migrate session store")?;
    let deletion_task = tokio::task::spawn(
        session_store
            .clone()
            .continuously_delete_expired(tokio::time::Duration::from_secs(3600)),
    );
    Ok(SessionStoreHandle {
        store: session_store,
        deletion_task,
    })
}

struct BackgroundTaskHandles {
    mmds_refresh: Option<AbortHandle>,
    idle_vm_sweep: AbortHandle,
}

fn spawn_background_tasks(app_state: &AppState) -> BackgroundTaskHandles {
    let mmds_refresh = if app_state.config.use_iam_creds {
        Some(spawn_mmds_refresh_task(app_state.clone()).abort_handle())
    } else {
        None
    };
    let idle_vm_sweep = spawn_idle_vm_sweep_task(app_state.clone()).abort_handle();
    BackgroundTaskHandles {
        mmds_refresh,
        idle_vm_sweep,
    }
}

fn build_router(app_state: AppState, session_store: PostgresStore) -> Router {
    let session_layer = build_session_layer(session_store);
    Router::new()
        .route("/", get(get_or_create_terminal))
        .route("/chat", post(handle_chat_query))
        .route("/chat-stream/{taskId}", get(handle_chat_reconnect))
        .route("/chat-question-answer", post(handle_chat_question_answer))
        .route("/chat-stop", post(handle_chat_stop))
        .route("/chat-history", get(list_chat_sessions_handler))
        .route(
            "/chat-transcript",
            get(get_chat_transcript_handler).delete(delete_chat_session_handler),
        )
        .route(
            "/chat-upload",
            post(handle_chat_upload).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route("/ls", get(list_files_handler))
        .route("/delete", post(delete_handler))
        .route("/download", get(download_file_handler))
        .route(
            "/upload",
            post(upload_file_handler).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
        )
        .route(
            "/api/settings",
            get(get_settings_handler).put(put_settings_handler),
        )
        .route(
            "/api/mcp-servers",
            get(mcp_list_handler).post(mcp_add_handler),
        )
        .route("/api/mcp-servers/{name}", delete(mcp_delete_handler))
        .route(
            "/api/mcp-servers/oauth-discover",
            get(mcp_oauth_discover_handler),
        )
        .route(
            "/api/mcp-servers/oauth-register",
            post(mcp_oauth_register_handler),
        )
        .route(
            "/api/mcp-servers/oauth-start",
            post(mcp_oauth_start_handler),
        )
        .route("/api/vm-status", get(vm_status_handler))
        .route("/api/csrf-token", get(get_csrf_token_handler))
        .route("/api/memory", get(get_memory_handler))
        .route(
            "/api/skills",
            get(skills_list_handler).post(skills_create_handler),
        )
        .route("/api/skills/{name}", delete(skills_delete_handler))
        .route("/rootfs/delete", post(delete_user_rootfs_handler))
        .route("/terminal/{id}", get(get_terminal_page))
        .route("/ws", get(handle_ws_upgrade))
        .route("/login", get(get_login_handler))
        .route("/login/cognito", get(get_cognito_login_handler))
        .route(
            "/oauth-close",
            get(|| async { axum::response::Html(render_oauth_close_page()) }),
        )
        .route("/logout", post(get_logout_handler))
        .route("/callback", get(get_callback_handler))
        .route("/callback/gateway", get(gateway_callback_handler))
        .route("/callback/mcp-oauth", get(mcp_oauth_callback_handler))
        .route("/api/renew-gateway-key", post(renew_gateway_key_handler))
        .route("/static/app.js", get(serve_app_js))
        .route("/static/styles.css", get(serve_styles_css))
        .route("/static/oauth-close.js", get(serve_oauth_close))
        .route("/static/fonts/{filename}", get(serve_font))
        .with_state(app_state)
        .layer(middleware::from_fn(csrf_middleware))
        .layer(session_layer)
        .layer(middleware::from_fn(add_security_headers))
}

fn build_session_layer(session_store: PostgresStore) -> SessionManagerLayer<PostgresStore> {
    SessionManagerLayer::new(session_store)
        .with_secure(true)
        .with_http_only(true)
        .with_same_site(SameSite::Lax)
        .with_expiry(Expiry::OnInactivity(Duration::seconds(86400)))
}

async fn add_security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "referrer-policy",
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'self'; \
             script-src 'self'; \
             style-src 'self' 'unsafe-inline'; \
             connect-src 'self' wss:; \
             img-src 'self' data: blob:; \
             font-src 'self'",
        ),
    );
    response
}

async fn serve_router(
    router: Router,
    port: u16,
    app_state: AppState,
    deletion_task_abort_handle: AbortHandle,
    mmds_refresh_abort_handle: Option<AbortHandle>,
    idle_vm_sweep_abort_handle: AbortHandle,
) -> Result<()> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
    let tcp_listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind to port {port}"))?;
    info!("listening on http://0.0.0.0:{port}");
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let serve_task = tokio::spawn(async move {
        axum::serve(tcp_listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
    });
    shutdown_signal(
        deletion_task_abort_handle,
        mmds_refresh_abort_handle,
        idle_vm_sweep_abort_handle,
    )
    .await;
    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(tokio::time::Duration::from_secs(5), serve_task).await;
    save_all_vm_rootfs(&app_state.vms).await?;
    Ok(())
}

fn spawn_idle_vm_sweep_task(app_state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
        interval.tick().await;
        loop {
            interval.tick().await;
            sweep_idle_vms(&app_state.vms).await;
        }
    })
}

fn spawn_mmds_refresh_task(app_state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(900));
        interval.tick().await;
        loop {
            interval.tick().await;
            if refresh_all_vm_mmds(
                &app_state.vms,
                app_state.config.use_iam_creds,
                &app_state.config.iam_role_name,
            )
            .await
            .is_err()
            {
                tracing::error!("mmds refresh failed");
            }
        }
    })
}

async fn shutdown_signal(
    deletion_task_abort_handle: AbortHandle,
    mmds_refresh_abort_handle: Option<AbortHandle>,
    idle_vm_sweep_abort_handle: AbortHandle,
) {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .unwrap_or_else(|_| tracing::error!("failed to install Ctrl+C handler"));
    };
    let terminate = async {
        let Ok(mut sig) = signal::unix::signal(signal::unix::SignalKind::terminate()) else {
            tracing::error!("failed to install SIGTERM handler");
            return;
        };
        sig.recv().await;
    };
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    info!("shutdown signal received, saving vm rootfs before exit");
    deletion_task_abort_handle.abort();
    if let Some(mmds_refresh_abort_handle) = mmds_refresh_abort_handle {
        mmds_refresh_abort_handle.abort();
    }
    idle_vm_sweep_abort_handle.abort();
}
