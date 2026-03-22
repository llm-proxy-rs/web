use crate::{
    handlers::UserVm,
    state::{AppConfig, AppError, AppState},
};
use anyhow::{Context, Result};
use authorize::AuthorizeUrlBuilder;
use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use chat_settings::{build_api_key_settings_json, set_vm_settings};
use serde::Deserialize;
use token::TokenRequestBuilder;
use tower_sessions::Session;

/// Builds the Pool B (gateway Cognito) authorize URL and stores a random `state`
/// nonce in the session. The `identity_provider` hint triggers silent SSO so users
/// who already authenticated with Pool A won't see a second login prompt.
pub(crate) async fn initiate_gateway_login(
    session: &Session,
    config: &AppConfig,
) -> Result<String> {
    let builder = AuthorizeUrlBuilder::new()
        .client_id(&config.gateway_cognito_client_id)
        .domain(&config.gateway_cognito_domain)
        .region(&config.gateway_cognito_region)
        .redirect_uri(&config.gateway_cognito_redirect_uri)
        .identity_provider(&config.gateway_identity_provider);

    let (url, csrf_token, nonce, pkce_verifier) = builder.build()?;

    session
        .insert("gateway_oauth_state", csrf_token.secret())
        .await
        .context("failed to store gateway oauth state in session")?;
    session
        .insert("gateway_oauth_nonce", &nonce)
        .await
        .context("failed to store gateway oauth nonce in session")?;
    session
        .insert("gateway_oauth_pkce_verifier", pkce_verifier.secret())
        .await
        .context("failed to store gateway oauth pkce verifier in session")?;

    Ok(url.to_string())
}

/// Exchanges an authorization code for an access token at Pool B's token endpoint.
pub(crate) async fn exchange_gateway_code(
    code: &str,
    pkce_verifier: &str,
    config: &AppConfig,
) -> Result<String> {
    let resp = TokenRequestBuilder::new()
        .client_id(&config.gateway_cognito_client_id)
        .client_secret(&config.gateway_cognito_client_secret)
        .domain(&config.gateway_cognito_domain)
        .region(&config.gateway_cognito_region)
        .redirect_uri(&config.gateway_cognito_redirect_uri)
        .code(code)
        .code_verifier(pkce_verifier)
        .build()
        .context("failed to build gateway token request")?
        .send()
        .await
        .context("failed to call gateway cognito token endpoint")?
        .error_for_status()
        .context("gateway cognito token endpoint returned error")?;

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        id_token: Option<String>,
    }

    let token_resp: TokenResponse = resp
        .json()
        .await
        .context("failed to parse gateway cognito token response")?;

    // Prefer id_token as some gateways validate identity claims rather than
    // access token scopes.
    Ok(token_resp.id_token.unwrap_or(token_resp.access_token))
}

/// Calls the gateway's `POST /api/v1/api-keys` endpoint with a Bearer token.
/// Returns the provisioned API key string.
pub(crate) async fn provision_gateway_api_key(
    access_token: &str,
    gateway_api_url: &str,
) -> Result<String> {
    let url = format!("{}/api/v1/api-key", gateway_api_url);

    let client = reqwest::Client::builder()
        .build()
        .context("failed to build HTTP client")?;
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("failed to call gateway api-keys endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        anyhow::bail!("gateway api-keys endpoint returned {status}");
    }

    #[derive(Deserialize)]
    struct ApiKeyResponse {
        api_key: String,
    }

    let key_resp: ApiKeyResponse = resp
        .json()
        .await
        .context("failed to parse gateway api-keys response")?;

    Ok(key_resp.api_key)
}

/// Returns true if the gateway federation is configured.
pub(crate) fn is_gateway_configured(config: &AppConfig) -> bool {
    !config.gateway_cognito_client_id.is_empty()
        && !config.gateway_api_url.is_empty()
        && !config.gateway_identity_provider.is_empty()
}

/// Provisions a new gateway API key and writes settings to the VM.
async fn provision_and_write_settings(
    access_token: &str,
    config: &AppConfig,
    user_vm: &UserVm,
) -> Result<String> {
    let api_key = provision_gateway_api_key(access_token, &config.gateway_api_url).await?;
    let content = build_api_key_settings_json(
        &api_key,
        config.anthropic_base_url.as_deref(),
        &config.anthropic_default_haiku_model,
        &config.anthropic_default_sonnet_model,
        &config.anthropic_default_opus_model,
        config.enable_mcp,
    )?;
    set_vm_settings(
        user_vm.guest_ip,
        &config.ssh_key_path,
        &config.ssh_user,
        &config.vm_host_key_path,
        &content,
    )
    .await?;
    Ok(api_key)
}

/// Stores the gateway API key in the session.
async fn store_key_in_session(session: &Session, api_key: &str) -> Result<()> {
    session
        .insert("gateway_api_key", api_key)
        .await
        .map_err(|e| anyhow::anyhow!("failed to store gateway_api_key in session: {e}"))
}

/// POST /api/renew-gateway-key
///
/// Renews the user's gateway API key. If a gateway access token is stored in
/// session, reuse it to provision a new key. Otherwise, redirect through the
/// gateway OAuth flow.
pub(crate) async fn renew_gateway_key_handler(
    user_vm: UserVm,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    if !is_gateway_configured(&state.config) {
        return Ok((
            axum::http::StatusCode::BAD_REQUEST,
            "Gateway not configured",
        )
            .into_response());
    }

    let access_token = session
        .get::<String>("gateway_access_token")
        .await
        .ok()
        .flatten();

    match access_token {
        Some(token) => {
            let api_key = provision_and_write_settings(&token, &state.config, &user_vm).await?;
            store_key_in_session(&session, &api_key).await?;
            Ok(Json(serde_json::json!({"status": "ok"})).into_response())
        }
        None => {
            let authorize_url = initiate_gateway_login(&session, &state.config).await?;
            Ok(Json(serde_json::json!({"redirect": authorize_url})).into_response())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(client_id: &str, api_url: &str, identity_provider: &str) -> AppConfig {
        AppConfig {
            gateway_cognito_client_id: client_id.to_string(),
            gateway_api_url: api_url.to_string(),
            gateway_identity_provider: identity_provider.to_string(),
            ..default_config()
        }
    }

    fn default_config() -> AppConfig {
        serde_json::from_str("{}").unwrap()
    }

    #[test]
    fn is_gateway_configured_all_set() {
        let config = make_config("client-id", "https://gw.example.com", "PoolA");
        assert!(is_gateway_configured(&config));
    }

    #[test]
    fn is_gateway_configured_missing_client_id() {
        let config = make_config("", "https://gw.example.com", "PoolA");
        assert!(!is_gateway_configured(&config));
    }

    #[test]
    fn is_gateway_configured_missing_api_url() {
        let config = make_config("client-id", "", "PoolA");
        assert!(!is_gateway_configured(&config));
    }

    #[test]
    fn is_gateway_configured_missing_identity_provider() {
        let config = make_config("client-id", "https://gw.example.com", "");
        assert!(!is_gateway_configured(&config));
    }

    #[test]
    fn is_gateway_configured_all_empty() {
        let config = default_config();
        assert!(!is_gateway_configured(&config));
    }
}
