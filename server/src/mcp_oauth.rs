use anyhow::Context;
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chat_settings::upsert_mcp_server;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;
use subtle::ConstantTimeEq;
use tower_sessions::Session;
use tracing::{error, info};
use url::Url;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState},
};

/// Session data persisted between the OAuth start and callback requests.
#[derive(Serialize, Deserialize)]
struct McpOAuthSession {
    state: String,
    pkce_verifier: String,
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    mcp_url: String,
    redirect_uri: String,
    server_name: String,
}

const MCP_OAUTH_SESSION_KEY: &str = "mcp_oauth";

// ── PKCE helpers ─────────────────────────────────────────────────────────

/// Generate a cryptographically random code_verifier (43–128 chars, unreserved charset).
fn generate_code_verifier() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Compute S256 code_challenge from a code_verifier.
fn compute_code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Generate a random state nonce for CSRF protection.
fn generate_state() -> String {
    let bytes: [u8; 16] = rand::rng().random();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Extract origin (scheme + host + port) and path component from a URL.
/// Path has trailing slash stripped. Returns (origin, path) where path may be empty.
fn origin_and_path(raw_url: &str) -> Result<(String, String), url::ParseError> {
    let parsed = Url::parse(raw_url)?;
    let mut origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    let path = parsed.path().trim_end_matches('/').to_string();
    Ok((origin, path))
}

/// Reject URLs that target internal/metadata IP ranges (SSRF protection).
fn is_safe_url(raw_url: &str) -> bool {
    let Ok(parsed) = Url::parse(raw_url) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            !ip.is_loopback()
                && !ip.is_private()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                // AWS metadata endpoint
                && ip != Ipv4Addr::new(169, 254, 169, 254)
        }
        Some(url::Host::Ipv6(ip)) => !ip.is_loopback() && !ip.is_unspecified(),
        Some(url::Host::Domain(d)) => d != "localhost",
        None => false,
    }
}

/// Build RFC 9728 protected resource discovery URLs for a given MCP resource URL.
fn build_protected_resource_urls(origin: &str, path: &str) -> Vec<String> {
    if path.is_empty() {
        vec![format!("{origin}/.well-known/oauth-protected-resource")]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-protected-resource{path}"),
            format!("{origin}/.well-known/oauth-protected-resource"),
        ]
    }
}

/// Build RFC 8414 / OIDC authorization server metadata discovery URLs.
fn build_auth_server_discovery_urls(origin: &str, path: &str, full_url: &str) -> Vec<String> {
    if path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server{path}"),
            format!("{origin}/.well-known/openid-configuration{path}"),
            format!("{full_url}/.well-known/openid-configuration"),
        ]
    }
}

/// Redirect to a minimal close page that broadcasts the result via BroadcastChannel.
fn oauth_close_page(result: &str, reason: Option<&str>) -> Response {
    let reason_param = reason.map(|r| format!("&reason={r}")).unwrap_or_default();
    axum::response::Redirect::to(&format!("/oauth-close?mcp_oauth={result}{reason_param}"))
        .into_response()
}

// ── Types ────────────────────────────────────────────────────────────────

/// OAuth 2.0 Authorization Server Metadata (subset we care about).
#[derive(Deserialize, Serialize, Clone, Debug)]
struct OAuthMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    #[serde(default)]
    scopes_supported: Option<Vec<String>>,
    #[serde(default)]
    code_challenge_methods_supported: Option<Vec<String>>,
    #[serde(default)]
    grant_types_supported: Option<Vec<String>>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

/// Protected Resource Metadata per RFC 9728.
#[derive(Deserialize, Debug)]
struct ProtectedResourceMetadata {
    #[serde(default)]
    authorization_servers: Vec<String>,
}

#[derive(Serialize)]
struct DiscoverResponse {
    oauth: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<OAuthMetadata>,
}

#[derive(Deserialize)]
pub(crate) struct DiscoverQuery {
    url: String,
}

#[derive(Deserialize)]
pub(crate) struct RegisterBody {
    registration_endpoint: String,
    client_name: String,
    redirect_uri: String,
    #[serde(default)]
    scope: Option<String>,
    /// From the server's metadata — used to pick the right auth method.
    #[serde(default)]
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize)]
struct RegisterResponse {
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct OAuthStartBody {
    authorization_endpoint: String,
    token_endpoint: String,
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    scopes: Option<String>,
    redirect_uri: String,
    mcp_url: String,
    server_name: String,
}

#[derive(Deserialize)]
pub(crate) struct OAuthCallbackQuery {
    code: String,
    state: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

// ── Handlers ─────────────────────────────────────────────────────────────

/// GET /api/mcp-servers/oauth-discover?url=<mcp_url>
///
/// Probe an MCP server for OAuth authorization server metadata.
/// Follows the MCP spec: RFC 9728 (protected resource) then RFC 8414 (auth server).
pub(crate) async fn discover_handler(
    _user_vm: UserVm,
    State(state): State<AppState>,
    Query(query): Query<DiscoverQuery>,
) -> Result<Response, AppError> {
    if !is_safe_url(&query.url) {
        return Ok((StatusCode::BAD_REQUEST, "Invalid URL").into_response());
    }

    // ── Step 1: Protected Resource Discovery (RFC 9728) ──────────────────
    // Discover which authorization server protects this MCP resource.
    let (resource_origin, resource_path) =
        origin_and_path(&query.url).map_err(|_| anyhow::anyhow!("invalid URL"))?;

    let protected_resource_urls = build_protected_resource_urls(&resource_origin, &resource_path);

    let mut auth_server_url: Option<String> = None;
    for url in &protected_resource_urls {
        info!("mcp oauth discover: trying protected resource metadata at {url}");
        if let Ok(resp) = state.http_client.get(url).await {
            if resp.is_success() {
                if let Ok(meta) = resp.json::<ProtectedResourceMetadata>() {
                    info!(
                        "mcp oauth discover: found authorization_servers: {:?}",
                        meta.authorization_servers
                    );
                    if let Some(first) = meta.authorization_servers.into_iter().next()
                        && is_safe_url(&first)
                    {
                        auth_server_url = Some(first);
                        break;
                    }
                }
            } else {
                info!("mcp oauth discover: {url} returned {}", resp.status);
            }
        }
    }

    // Fallback: treat the MCP server's base URL as the authorization server
    let auth_server_url = auth_server_url.unwrap_or_else(|| {
        info!("mcp oauth discover: no protected resource metadata found, falling back to {resource_origin}");
        resource_origin.clone()
    });

    // ── Step 2: Authorization Server Metadata Discovery (RFC 8414 / OIDC) ─
    let (auth_origin, auth_path) = origin_and_path(&auth_server_url)
        .map_err(|_| anyhow::anyhow!("invalid auth server URL"))?;

    let discovery_urls =
        build_auth_server_discovery_urls(&auth_origin, &auth_path, &auth_server_url);

    for url in &discovery_urls {
        info!("mcp oauth discover: trying auth server metadata at {url}");
        if let Ok(resp) = state.http_client.get(url).await {
            if resp.is_success() {
                if let Ok(metadata) = resp.json::<OAuthMetadata>() {
                    info!(
                        "mcp oauth discover: found metadata — auth={}, token={}, register={:?}",
                        metadata.authorization_endpoint,
                        metadata.token_endpoint,
                        metadata.registration_endpoint,
                    );
                    return Ok(Json(DiscoverResponse {
                        oauth: true,
                        metadata: Some(metadata),
                    })
                    .into_response());
                }
            } else {
                info!("mcp oauth discover: {url} returned {}", resp.status);
            }
        }
    }

    Ok(Json(DiscoverResponse {
        oauth: false,
        metadata: None,
    })
    .into_response())
}

/// POST /api/mcp-servers/oauth-register
///
/// Dynamic Client Registration per RFC 7591.
pub(crate) async fn register_handler(
    _user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<RegisterBody>,
) -> Result<Response, AppError> {
    if !is_safe_url(&body.registration_endpoint) {
        return Ok((StatusCode::BAD_REQUEST, "Invalid registration endpoint").into_response());
    }

    // Pick token_endpoint_auth_method based on what the server supports.
    // Default to client_secret_post (most common for MCP servers like Figma).
    // RFC 8414 says the default is client_secret_basic when not specified.
    let auth_method = body
        .token_endpoint_auth_methods_supported
        .as_ref()
        .and_then(|methods| {
            // Prefer in order: client_secret_post, client_secret_basic, none
            for preferred in &["client_secret_post", "client_secret_basic", "none"] {
                if methods.iter().any(|m| m == preferred) {
                    return Some(preferred.to_string());
                }
            }
            methods.first().cloned()
        })
        .unwrap_or_else(|| "client_secret_post".to_string());

    let mut reg_request = serde_json::json!({
        "client_name": body.client_name,
        "redirect_uris": [body.redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": auth_method,
    });
    if let Some(ref scope) = body.scope {
        reg_request["scope"] = serde_json::Value::String(scope.clone());
    }

    info!(
        "mcp oauth register: POST {} with auth_method={}, redirect_uri={}, scope={:?}",
        body.registration_endpoint, auth_method, body.redirect_uri, body.scope
    );

    let resp = state
        .http_client
        .post_json(
            &body.registration_endpoint,
            reg_request,
            &[
                ("Content-Type", "application/json"),
                ("MCP-Protocol-Version", "2025-03-26"),
            ],
        )
        .await
        .context("registration request failed")?;

    if !resp.is_success() {
        error!("mcp oauth registration failed: {}", resp.status);
        return Ok((
            StatusCode::BAD_GATEWAY,
            format!("registration failed: {}", resp.status),
        )
            .into_response());
    }

    let reg_resp: RegisterResponse = resp
        .json()
        .context("failed to parse registration response")?;

    Ok(Json(reg_resp).into_response())
}

/// POST /api/mcp-servers/oauth-start
///
/// Generate PKCE parameters, store state in session, return authorization URL.
pub(crate) async fn start_handler(
    _user_vm: UserVm,
    session: Session,
    Json(body): Json<OAuthStartBody>,
) -> Result<Response, AppError> {
    if !is_safe_url(&body.token_endpoint) {
        return Ok((StatusCode::BAD_REQUEST, "Invalid token endpoint").into_response());
    }
    if !is_safe_url(&body.authorization_endpoint) {
        return Ok((StatusCode::BAD_REQUEST, "Invalid authorization endpoint").into_response());
    }

    let code_verifier = generate_code_verifier();
    let code_challenge = compute_code_challenge(&code_verifier);
    let state = generate_state();

    let redirect_uri = &body.redirect_uri;

    let oauth_session = McpOAuthSession {
        state: state.clone(),
        pkce_verifier: code_verifier,
        token_endpoint: body.token_endpoint.clone(),
        client_id: body.client_id.clone(),
        client_secret: body.client_secret.clone(),
        mcp_url: body.mcp_url.clone(),
        redirect_uri: redirect_uri.clone(),
        server_name: body.server_name.clone(),
    };
    session
        .insert(MCP_OAUTH_SESSION_KEY, &oauth_session)
        .await
        .context("failed to store mcp oauth session")?;

    // Build authorization URL
    let mut auth_url =
        Url::parse(&body.authorization_endpoint).context("invalid authorization endpoint URL")?;
    auth_url
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &body.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    if let Some(ref scopes) = body.scopes {
        auth_url.query_pairs_mut().append_pair("scope", scopes);
    }

    Ok(Json(serde_json::json!({ "redirect": auth_url.to_string() })).into_response())
}

/// GET /callback/mcp-oauth?code=...&state=...
///
/// Handle the OAuth callback: validate state, exchange code for token, store MCP server config.
pub(crate) async fn callback_handler(
    query: Query<OAuthCallbackQuery>,
    user_vm: UserVm,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    // Retrieve and remove all OAuth session data atomically
    let oauth_session = session
        .remove::<McpOAuthSession>(MCP_OAUTH_SESSION_KEY)
        .await
        .context("failed to retrieve oauth session")?;

    let Some(oauth_session) = oauth_session else {
        error!("mcp oauth session missing");
        return Ok(oauth_close_page("error", Some("state_mismatch")));
    };

    // Validate state nonce
    if oauth_session.state.len() != query.state.len()
        || oauth_session
            .state
            .as_bytes()
            .ct_eq(query.state.as_bytes())
            .unwrap_u8()
            != 1
    {
        error!("mcp oauth state mismatch");
        return Ok(oauth_close_page("error", Some("state_mismatch")));
    }

    // Exchange authorization code for tokens
    let mut token_params = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", query.code.clone()),
        ("redirect_uri", oauth_session.redirect_uri),
        ("code_verifier", oauth_session.pkce_verifier),
        ("client_id", oauth_session.client_id),
    ];
    if let Some(secret) = oauth_session.client_secret {
        token_params.push(("client_secret", secret));
    }

    let token_resp = state
        .http_client
        .post_form(&oauth_session.token_endpoint, &token_params)
        .await
        .context("token exchange request failed")?;

    if !token_resp.is_success() {
        error!("token exchange failed");
        return Ok(oauth_close_page("error", Some("token_exchange")));
    }

    let tokens: TokenResponse = token_resp
        .json()
        .context("failed to parse token response")?;

    info!(
        "mcp oauth token exchange successful for server: {}",
        oauth_session.server_name
    );

    // Read current ~/.claude.json from VM (UserVm extractor handles auth + VM provisioning)
    let raw = match state
        .vm_config_ops
        .get_claude_json_raw(user_vm.guest_ip)
        .await
    {
        Ok(r) => r,
        Err(_) => {
            error!("failed to read VM claude.json");
            return Ok(oauth_close_page("error", Some("config_read")));
        }
    };

    // Reject if server name already exists
    let existing = match chat_settings::parse_mcp_servers(raw.trim()) {
        Ok(servers) => servers,
        Err(_) => {
            error!("failed to parse MCP servers");
            return Ok(oauth_close_page("error", Some("config_parse")));
        }
    };
    if existing.contains_key(&oauth_session.server_name) {
        return Ok(oauth_close_page("error", Some("name_exists")));
    }

    // Build MCP server entry with OAuth token
    let mut server = serde_json::json!({
        "type": "http",
        "url": oauth_session.mcp_url,
        "headers": {
            "Authorization": format!("Bearer {}", tokens.access_token),
        },
    });
    if let Some(ref refresh) = tokens.refresh_token {
        server["_refresh_token"] = serde_json::Value::String(refresh.clone());
    }

    // Upsert and write back
    let updated = upsert_mcp_server(raw.trim(), &oauth_session.server_name, server)
        .context("failed to upsert MCP server config")?;

    if state
        .vm_config_ops
        .set_claude_json(user_vm.guest_ip, &updated)
        .await
        .is_err()
    {
        error!("mcp oauth callback: failed to write ~/.claude.json to VM");
        return Ok(oauth_close_page("error", Some("write_failed")));
    }

    info!(
        "mcp oauth: successfully wrote server '{}' config to VM",
        oauth_session.server_name
    );

    Ok(oauth_close_page("success", None))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── PKCE tests ──────────────────────────────────────────────────────

    #[test]
    fn code_verifier_has_valid_length() {
        let verifier = generate_code_verifier();
        // 32 bytes → 43 base64url chars (no padding)
        assert_eq!(verifier.len(), 43);
    }

    #[test]
    fn code_verifier_is_url_safe() {
        let verifier = generate_code_verifier();
        assert!(
            verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn code_challenge_is_deterministic_for_same_verifier() {
        let challenge1 = compute_code_challenge("test_verifier_123");
        let challenge2 = compute_code_challenge("test_verifier_123");
        assert_eq!(challenge1, challenge2);
    }

    #[test]
    fn code_challenge_differs_for_different_verifiers() {
        let c1 = compute_code_challenge("verifier_a");
        let c2 = compute_code_challenge("verifier_b");
        assert_ne!(c1, c2);
    }

    #[test]
    fn code_challenge_is_base64url_encoded() {
        let challenge = compute_code_challenge("my_verifier");
        assert!(
            challenge
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        // SHA256 → 32 bytes → 43 base64url chars
        assert_eq!(challenge.len(), 43);
    }

    // ── State tests ─────────────────────────────────────────────────────

    #[test]
    fn state_nonce_has_valid_length() {
        let state = generate_state();
        // 16 bytes → 22 base64url chars
        assert_eq!(state.len(), 22);
    }

    #[test]
    fn state_nonce_is_url_safe() {
        let state = generate_state();
        assert!(
            state
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn state_nonces_are_unique() {
        let s1 = generate_state();
        let s2 = generate_state();
        assert_ne!(s1, s2);
    }

    // ── origin_and_path tests ──────────────────────────────────────────

    #[test]
    fn origin_and_path_extracts_both() {
        let (origin, path) = origin_and_path("https://api.example.com/v1/mcp").unwrap();
        assert_eq!(origin, "https://api.example.com");
        assert_eq!(path, "/v1/mcp");
    }

    #[test]
    fn origin_and_path_strips_trailing_slash() {
        let (origin, path) = origin_and_path("https://example.com/mcp/").unwrap();
        assert_eq!(origin, "https://example.com");
        assert_eq!(path, "/mcp");
    }

    #[test]
    fn origin_and_path_root_url() {
        let (origin, path) = origin_and_path("https://mcp.figma.com").unwrap();
        assert_eq!(origin, "https://mcp.figma.com");
        assert_eq!(path, "");
    }

    #[test]
    fn origin_and_path_preserves_port() {
        let (origin, path) = origin_and_path("https://localhost:8443/mcp").unwrap();
        assert_eq!(origin, "https://localhost:8443");
        assert_eq!(path, "/mcp");
    }

    #[test]
    fn origin_and_path_rejects_invalid() {
        assert!(origin_and_path("not a url").is_err());
    }

    // ── protected resource discovery URL tests ─────────────────────────

    #[test]
    fn protected_resource_urls_root_url() {
        let urls = build_protected_resource_urls("https://mcp.figma.com", "");
        assert_eq!(
            urls,
            vec!["https://mcp.figma.com/.well-known/oauth-protected-resource",]
        );
    }

    #[test]
    fn protected_resource_urls_with_path() {
        let urls = build_protected_resource_urls("https://mcp.figma.com", "/v1");
        assert_eq!(
            urls,
            vec![
                "https://mcp.figma.com/.well-known/oauth-protected-resource/v1",
                "https://mcp.figma.com/.well-known/oauth-protected-resource",
            ]
        );
    }

    #[test]
    fn protected_resource_urls_with_deep_path() {
        let urls = build_protected_resource_urls("https://example.com", "/api/v2/mcp");
        assert_eq!(
            urls,
            vec![
                "https://example.com/.well-known/oauth-protected-resource/api/v2/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
    }

    // ── auth server discovery URL tests ────────────────────────────────

    #[test]
    fn auth_server_urls_root_url() {
        let urls = build_auth_server_discovery_urls(
            "https://auth.example.com",
            "",
            "https://auth.example.com",
        );
        assert_eq!(
            urls,
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server",
                "https://auth.example.com/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn auth_server_urls_with_path() {
        let urls = build_auth_server_discovery_urls(
            "https://auth.example.com",
            "/v1",
            "https://auth.example.com/v1",
        );
        assert_eq!(
            urls,
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/v1",
                "https://auth.example.com/.well-known/openid-configuration/v1",
                "https://auth.example.com/v1/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn auth_server_urls_with_port() {
        let urls = build_auth_server_discovery_urls(
            "https://localhost:8443",
            "/mcp",
            "https://localhost:8443/mcp",
        );
        assert_eq!(
            urls,
            vec![
                "https://localhost:8443/.well-known/oauth-authorization-server/mcp",
                "https://localhost:8443/.well-known/openid-configuration/mcp",
                "https://localhost:8443/mcp/.well-known/openid-configuration",
            ]
        );
    }

    // ── McpOAuthSession serialization tests ────────────────────────────

    #[test]
    fn oauth_session_roundtrip() {
        let session = McpOAuthSession {
            state: "abc123".to_string(),
            pkce_verifier: "verifier".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            client_id: "client-1".to_string(),
            client_secret: Some("secret".to_string()),
            mcp_url: "https://mcp.example.com/v1".to_string(),
            redirect_uri: "https://app.example.com/callback".to_string(),
            server_name: "my-server".to_string(),
        };
        let json = serde_json::to_string(&session).unwrap();
        let restored: McpOAuthSession = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.state, "abc123");
        assert_eq!(restored.pkce_verifier, "verifier");
        assert_eq!(restored.token_endpoint, "https://auth.example.com/token");
        assert_eq!(restored.client_id, "client-1");
        assert_eq!(restored.client_secret.as_deref(), Some("secret"));
        assert_eq!(restored.mcp_url, "https://mcp.example.com/v1");
        assert_eq!(restored.redirect_uri, "https://app.example.com/callback");
        assert_eq!(restored.server_name, "my-server");
    }

    #[test]
    fn oauth_session_roundtrip_no_secret() {
        let session = McpOAuthSession {
            state: "state".to_string(),
            pkce_verifier: "verifier".to_string(),
            token_endpoint: "https://auth.example.com/token".to_string(),
            client_id: "client-1".to_string(),
            client_secret: None,
            mcp_url: "https://mcp.example.com".to_string(),
            redirect_uri: "https://app.example.com/callback".to_string(),
            server_name: "server".to_string(),
        };
        let json = serde_json::to_string(&session).unwrap();
        let restored: McpOAuthSession = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.client_secret, None);
    }

    // ── is_safe_url tests ──────────────────────────────────────────────

    #[test]
    fn safe_url_accepts_valid_https() {
        assert!(is_safe_url("https://example.com/token"));
        assert!(is_safe_url("https://auth.example.com/oauth/token"));
        // Public IP should be accepted
        assert!(is_safe_url("https://8.8.8.8/token"));
    }

    #[test]
    fn safe_url_rejects_private_ips() {
        assert!(!is_safe_url("https://127.0.0.1/token"));
        assert!(!is_safe_url("https://10.0.0.1/token"));
        assert!(!is_safe_url("https://192.168.1.1/token"));
    }

    #[test]
    fn safe_url_rejects_link_local_and_special_ips() {
        assert!(!is_safe_url("https://169.254.1.1/token"));
        assert!(!is_safe_url("https://169.254.169.254/token")); // AWS metadata
        assert!(!is_safe_url("https://0.0.0.0/token"));
        assert!(!is_safe_url("https://255.255.255.255/token"));
    }

    #[test]
    fn safe_url_rejects_localhost_domain() {
        assert!(!is_safe_url("https://localhost/token"));
    }

    #[test]
    fn safe_url_rejects_ipv6_loopback_and_unspecified() {
        assert!(!is_safe_url("https://[::1]/token"));
        assert!(!is_safe_url("https://[::]/token"));
    }

    #[test]
    fn safe_url_accepts_ipv6_public() {
        assert!(is_safe_url("https://[2607:f8b0:4004:800::200e]/token"));
    }

    #[test]
    fn safe_url_rejects_non_https() {
        assert!(!is_safe_url("http://example.com/token"));
        assert!(!is_safe_url("ftp://example.com/token"));
    }

    #[test]
    fn safe_url_rejects_invalid() {
        assert!(!is_safe_url("not-a-url"));
        assert!(!is_safe_url(""));
    }

    // ── handler integration tests ─────────────────────────────────────

    use axum::extract::State;
    use std::sync::Arc;
    use uuid::Uuid;

    use crate::handlers::UserVm;
    use crate::http_client::HttpResponse as MockHttpResponse;
    use crate::test_helpers::{MockHttpClient, MockVmConfigOps, test_app_state};

    fn test_user_vm() -> UserVm {
        UserVm {
            user_id: Uuid::nil(),
            vm_id: "test-vm".into(),
            guest_ip: Ipv4Addr::new(10, 0, 0, 1),
        }
    }

    fn mock_http_response(status: u16, body: &str) -> MockHttpResponse {
        MockHttpResponse {
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            body: bytes::Bytes::from(body.to_string()),
        }
    }

    #[tokio::test]
    async fn discover_rejects_unsafe_url() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let query = Query(DiscoverQuery {
            url: "http://localhost/mcp".into(),
        });
        let resp = discover_handler(test_user_vm(), State(state), query)
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn discover_finds_metadata() {
        // Mock responses: protected resource returns auth server, then auth server returns metadata
        let protected_resp = mock_http_response(
            200,
            r#"{"authorization_servers":["https://auth.example.com"]}"#,
        );
        let auth_metadata = mock_http_response(
            200,
            r#"{
                "authorization_endpoint": "https://auth.example.com/authorize",
                "token_endpoint": "https://auth.example.com/token"
            }"#,
        );
        let http = Arc::new(MockHttpClient::new(vec![protected_resp, auth_metadata]));
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, http);
        let query = Query(DiscoverQuery {
            url: "https://mcp.example.com/v1".into(),
        });
        let resp = discover_handler(test_user_vm(), State(state), query)
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn discover_no_oauth() {
        // All discovery URLs return 404
        let responses: Vec<MockHttpResponse> =
            (0..5).map(|_| mock_http_response(404, "")).collect();
        let http = Arc::new(MockHttpClient::new(responses));
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, http);
        let query = Query(DiscoverQuery {
            url: "https://mcp.example.com/v1".into(),
        });
        let resp = discover_handler(test_user_vm(), State(state), query)
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn register_rejects_unsafe_endpoint() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let body = Json(RegisterBody {
            registration_endpoint: "https://10.0.0.1/register".into(),
            client_name: "test".into(),
            redirect_uri: "https://example.com/callback".into(),
            scope: None,
            token_endpoint_auth_methods_supported: None,
        });
        let resp = register_handler(test_user_vm(), State(state), body)
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn register_success() {
        let reg_resp = mock_http_response(
            200,
            r#"{"client_id":"client-123","client_secret":"secret-456"}"#,
        );
        let http = Arc::new(MockHttpClient::new(vec![reg_resp]));
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, http);
        let body = Json(RegisterBody {
            registration_endpoint: "https://auth.example.com/register".into(),
            client_name: "test".into(),
            redirect_uri: "https://example.com/callback".into(),
            scope: None,
            token_endpoint_auth_methods_supported: None,
        });
        let resp = register_handler(test_user_vm(), State(state), body)
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn start_rejects_unsafe_token_endpoint() {
        let session = tower_sessions::Session::new(
            None,
            std::sync::Arc::new(tower_sessions::MemoryStore::default()),
            None,
        );
        let body = Json(OAuthStartBody {
            token_endpoint: "https://10.0.0.1/token".into(),
            authorization_endpoint: "https://auth.example.com/authorize".into(),
            client_id: "client-1".into(),
            client_secret: None,
            redirect_uri: "https://example.com/callback".into(),
            mcp_url: "https://mcp.example.com".into(),
            server_name: "test".into(),
            scopes: None,
        });
        let resp = start_handler(test_user_vm(), session, body).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn start_rejects_unsafe_authorization_endpoint() {
        let session = tower_sessions::Session::new(
            None,
            std::sync::Arc::new(tower_sessions::MemoryStore::default()),
            None,
        );
        let body = Json(OAuthStartBody {
            token_endpoint: "https://auth.example.com/token".into(),
            authorization_endpoint: "https://127.0.0.1/authorize".into(),
            client_id: "client-1".into(),
            client_secret: None,
            redirect_uri: "https://example.com/callback".into(),
            mcp_url: "https://mcp.example.com".into(),
            server_name: "test".into(),
            scopes: None,
        });
        let resp = start_handler(test_user_vm(), session, body).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
