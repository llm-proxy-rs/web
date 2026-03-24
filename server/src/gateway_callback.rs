use crate::{
    auth::User,
    gateway_auth::{exchange_gateway_code, provision_gateway_api_key},
    state::{AppError, AppState},
};
use anyhow::Context;
use axum::{
    extract::{Query, State},
    response::{IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use tower_sessions::Session;
use tracing::{error, info};

#[derive(Deserialize)]
pub(crate) struct GatewayCallbackQuery {
    code: String,
    state: String,
}

/// GET /callback/gateway
///
/// Handles the redirect back from gateway Cognito after OAuth authorization.
/// Validates the state nonce, exchanges the code for an access token,
/// provisions an API key via the gateway, and stores it in the session.
/// The key is written to the VM later when it is provisioned via /api/vm-status.
pub(crate) async fn gateway_callback_handler(
    query: Query<GatewayCallbackQuery>,
    _user: User,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    // Validate state nonce
    let stored_state = session
        .remove::<String>("gateway_oauth_state")
        .await
        .context("failed to retrieve oauth state from session")?;

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
    let api_key = provision_gateway_api_key(
        &access_token,
        &state.config.gateway_api_url,
        state.config.gateway_tls_accept_invalid_certs,
    )
    .await?;

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

    // The API key is now stored in the session. The VM will pick it up when
    // provisioned via /api/vm-status (see write_initial_settings /
    // write_gateway_settings_with_key).
    Ok(Redirect::to("/").into_response())
}
