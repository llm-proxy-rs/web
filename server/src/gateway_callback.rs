use anyhow::Context;
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Redirect, Response},
};
use chat_settings::{build_api_key_settings_json, set_vm_settings};
use serde::Deserialize;
use tower_sessions::Session;
use tracing::{error, info};

use crate::{
    gateway_auth::{exchange_gateway_code, provision_gateway_api_key},
    handlers::UserVm,
    state::{AppError, AppState},
};

#[derive(Deserialize)]
pub(crate) struct GatewayCallbackQuery {
    code: String,
    state: String,
}

/// GET /callback/gateway
///
/// Handles the redirect back from gateway Cognito after OAuth authorization.
/// Validates the state nonce, exchanges the code for an access token,
/// provisions an API key via the gateway, and writes it to the VM.
pub(crate) async fn gateway_callback_handler(
    query: Query<GatewayCallbackQuery>,
    user_vm: UserVm,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    // Validate state nonce
    let stored_state = session
        .remove::<String>("gateway_oauth_state")
        .await
        .ok()
        .flatten();

    if stored_state.as_deref() != Some(&query.state) {
        error!("gateway oauth state mismatch");
        return Ok(Redirect::to("/").into_response());
    }

    // Retrieve PKCE verifier
    let pkce_verifier = session
        .remove::<String>("gateway_oauth_pkce_verifier")
        .await
        .map_err(|_| anyhow::anyhow!("failed to retrieve PKCE verifier from session"))?
        .context("PKCE verifier missing from session")?;

    // Remove stored nonce (validated implicitly via the token exchange)
    let _ = session.remove::<String>("gateway_oauth_nonce").await;

    // Exchange code for access token
    let access_token = exchange_gateway_code(&query.code, &pkce_verifier, &state.config).await?;

    // Provision API key
    let api_key = provision_gateway_api_key(&access_token, &state.config.gateway_api_url).await?;

    info!("gateway API key provisioned successfully");

    // Store access token and key in session for future use
    session
        .insert("gateway_access_token", &access_token)
        .await
        .map_err(|_| anyhow::anyhow!("failed to store gateway_access_token in session"))?;
    session
        .insert("gateway_api_key", &api_key)
        .await
        .map_err(|_| anyhow::anyhow!("failed to store gateway_api_key in session"))?;
    session
        .insert("gateway_key_provisioned", true)
        .await
        .map_err(|_| anyhow::anyhow!("failed to store gateway_key_provisioned in session"))?;

    // Write key to VM
    let content = build_api_key_settings_json(
        &api_key,
        state.config.anthropic_base_url.as_deref(),
        &state.config.anthropic_default_haiku_model,
        &state.config.anthropic_default_sonnet_model,
        &state.config.anthropic_default_opus_model,
        state.config.enable_mcp,
    )?;

    set_vm_settings(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &content,
    )
    .await?;

    Ok(Redirect::to("/").into_response())
}
