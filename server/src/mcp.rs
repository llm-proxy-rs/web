use axum::{
    Json,
    extract::{Path as RoutePath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chat_settings::{parse_mcp_servers, remove_mcp_server, upsert_mcp_server};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use url::Url;
use validator::Validate;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState},
};

#[derive(Deserialize)]
struct McpServerValue {
    #[serde(rename = "type", default = "default_mcp_type")]
    type_: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

fn default_mcp_type() -> String {
    "http".into()
}

#[derive(Serialize)]
struct McpServerEntry {
    name: String,
    #[serde(rename = "type")]
    type_: String,
    url: String,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    headers: HashMap<String, String>,
}

#[derive(Deserialize, Validate)]
pub(crate) struct AddMcpServerBody {
    #[validate(length(min = 1, max = 128), custom(function = "validate_server_name"))]
    name: String,
    #[validate(length(min = 1, max = 2048), custom(function = "validate_url"))]
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

fn validate_server_name(name: &str) -> Result<(), validator::ValidationError> {
    if is_valid_server_name(name) {
        Ok(())
    } else {
        Err(validator::ValidationError::new("invalid_server_name"))
    }
}

fn validate_url(url: &str) -> Result<(), validator::ValidationError> {
    let parsed = Url::parse(url).map_err(|_| validator::ValidationError::new("invalid_url"))?;
    let scheme = parsed.scheme();
    if (scheme != "https" && scheme != "http")
        || (parsed.as_str() != url && parsed.as_str() != format!("{url}/"))
    {
        return Err(validator::ValidationError::new("invalid_url"));
    }
    Ok(())
}

fn is_valid_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Only allow header keys/values that are safe ASCII strings.
fn is_valid_header(key: &str, value: &str) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && key.chars().all(|c| c.is_ascii_graphic())
        && value.len() <= 4096
        && value.chars().all(|c| c.is_ascii_graphic() || c == ' ')
}

pub(crate) async fn list_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let raw = state
        .vm_config_ops
        .get_claude_json_raw(user_vm.guest_ip)
        .await?;
    let servers = parse_mcp_servers(raw.trim())?;
    let entries: Vec<McpServerEntry> = servers
        .into_iter()
        .filter_map(|(name, val)| {
            let server: McpServerValue = serde_json::from_value(val).ok()?;
            Some(McpServerEntry {
                name,
                type_: server.type_,
                url: server.url,
                headers: server.headers,
            })
        })
        .collect();
    Ok(Json(entries).into_response())
}

pub(crate) async fn add_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<AddMcpServerBody>,
) -> Result<Response, AppError> {
    if body.validate().is_err() {
        return Ok((StatusCode::BAD_REQUEST, "Invalid server name or URL").into_response());
    }
    for (key, value) in &body.headers {
        if !is_valid_header(key, value) {
            return Ok((StatusCode::BAD_REQUEST, "Invalid header").into_response());
        }
    }

    let raw = state
        .vm_config_ops
        .get_claude_json_raw(user_vm.guest_ip)
        .await?;

    let existing = parse_mcp_servers(raw.trim())?;
    if existing.contains_key(&body.name) {
        return Ok((StatusCode::CONFLICT, "Server name already exists").into_response());
    }

    let mut server = serde_json::json!({
        "type": "http",
        "url": body.url,
    });
    if !body.headers.is_empty() {
        server["headers"] = serde_json::to_value(&body.headers)?;
    }

    let updated = upsert_mcp_server(raw.trim(), &body.name, server)?;
    state
        .vm_config_ops
        .set_claude_json(user_vm.guest_ip, &updated)
        .await?;
    Ok(StatusCode::CREATED.into_response())
}

pub(crate) async fn delete_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    RoutePath(name): RoutePath<String>,
) -> Result<Response, AppError> {
    if !is_valid_server_name(&name) {
        return Ok((StatusCode::BAD_REQUEST, "Invalid server name").into_response());
    }

    if name == "gemini-websearch" {
        return Ok((StatusCode::FORBIDDEN, "Cannot delete built-in server").into_response());
    }

    let raw = state
        .vm_config_ops
        .get_claude_json_raw(user_vm.guest_ip)
        .await?;

    let Some(updated) = remove_mcp_server(raw.trim(), &name)? else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };

    state
        .vm_config_ops
        .set_claude_json(user_vm.guest_ip, &updated)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_valid_url(url: &str) -> bool {
        url.len() <= 2048 && validate_url(url).is_ok()
    }

    // --- is_valid_server_name ---

    #[test]
    fn valid_server_names() {
        assert!(is_valid_server_name("my-server"));
        assert!(is_valid_server_name("server_1"));
        assert!(is_valid_server_name("server.v2"));
        assert!(is_valid_server_name("a"));
    }

    #[test]
    fn invalid_server_names() {
        assert!(!is_valid_server_name(""));
        assert!(!is_valid_server_name("my server"));
        assert!(!is_valid_server_name("server;drop"));
        assert!(!is_valid_server_name("server\nname"));
        assert!(!is_valid_server_name(&"a".repeat(129)));
    }

    #[test]
    fn server_name_at_max_length() {
        assert!(is_valid_server_name(&"a".repeat(128)));
    }

    // --- is_valid_url ---

    #[test]
    fn valid_urls() {
        assert!(is_valid_url("https://example.com/mcp"));
        assert!(is_valid_url("https://example.com/mcp/"));
        assert!(is_valid_url("https://example.com"));
        assert!(is_valid_url("http://localhost:8080/mcp"));
        assert!(is_valid_url("https://192.0.2.1/mcp"));
    }

    #[test]
    fn invalid_urls() {
        assert!(!is_valid_url(""));
        assert!(!is_valid_url("ftp://example.com"));
        assert!(!is_valid_url("not-a-url"));
        assert!(!is_valid_url("https://example.com/mcp with spaces"));
    }

    #[test]
    fn url_at_max_length() {
        let long_url = format!("https://example.com/{}", "a".repeat(2048 - 20));
        assert!(is_valid_url(&long_url));
    }

    #[test]
    fn url_over_max_length() {
        let long_url = format!("https://example.com/{}", "a".repeat(2049));
        assert!(!is_valid_url(&long_url));
    }

    // --- is_valid_header ---

    #[test]
    fn valid_headers() {
        assert!(is_valid_header("Authorization", "Bearer sk-abc123"));
        assert!(is_valid_header("X-API-Key", "my-key"));
        assert!(is_valid_header("Content-Type", "application/json"));
    }

    #[test]
    fn invalid_headers() {
        assert!(!is_valid_header("", "value"));
        assert!(!is_valid_header("key with space", "value"));
        assert!(!is_valid_header("key\nnewline", "value"));
        assert!(!is_valid_header("key", "value\nnewline"));
    }

    #[test]
    fn header_key_at_max_length() {
        assert!(is_valid_header(&"a".repeat(256), "value"));
        assert!(!is_valid_header(&"a".repeat(257), "value"));
    }

    #[test]
    fn header_value_at_max_length() {
        assert!(is_valid_header("key", &"a".repeat(4096)));
        assert!(!is_valid_header("key", &"a".repeat(4097)));
    }

    // ── handler integration tests ─────────────────────────────────────

    use axum::extract::State;
    use std::net::Ipv4Addr;
    use std::sync::Arc;
    use uuid::Uuid;

    use crate::handlers::UserVm;
    use crate::test_helpers::{MockHttpClient, MockVmConfigOps, test_app_state};

    fn test_user_vm() -> UserVm {
        UserVm {
            user_id: Uuid::nil(),
            vm_id: "test-vm".into(),
            guest_ip: Ipv4Addr::new(10, 0, 0, 1),
        }
    }

    #[tokio::test]
    async fn list_handler_returns_servers() {
        let json =
            r#"{"mcpServers":{"my-server":{"type":"http","url":"https://example.com/mcp"}}}"#;
        let mock = Arc::new(MockVmConfigOps::new(json, "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let resp = list_handler(test_user_vm(), State(state)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn list_handler_empty() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let resp = list_handler(test_user_vm(), State(state)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn add_handler_creates_server() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock.clone(), Arc::new(MockHttpClient::empty()));
        let body = AddMcpServerBody {
            name: "new-server".into(),
            url: "https://example.com/mcp".into(),
            headers: HashMap::new(),
        };
        let resp = add_handler(test_user_vm(), State(state), Json(body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let written = mock.claude_json.lock().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(
            parsed["mcpServers"]["new-server"]["url"],
            "https://example.com/mcp"
        );
    }

    #[tokio::test]
    async fn add_handler_rejects_duplicate() {
        let json = r#"{"mcpServers":{"my-server":{"type":"http","url":"https://old.com"}}}"#;
        let mock = Arc::new(MockVmConfigOps::new(json, "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let body = AddMcpServerBody {
            name: "my-server".into(),
            url: "https://new.com/mcp".into(),
            headers: HashMap::new(),
        };
        let resp = add_handler(test_user_vm(), State(state), Json(body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn add_handler_rejects_invalid_name() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let body = AddMcpServerBody {
            name: "bad name!".into(),
            url: "https://example.com/mcp".into(),
            headers: HashMap::new(),
        };
        let resp = add_handler(test_user_vm(), State(state), Json(body))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn delete_handler_removes_server() {
        let json = r#"{"mcpServers":{"my-server":{"type":"http","url":"https://old.com"}}}"#;
        let mock = Arc::new(MockVmConfigOps::new(json, "{}"));
        let state = test_app_state(mock.clone(), Arc::new(MockHttpClient::empty()));
        let resp = delete_handler(test_user_vm(), State(state), RoutePath("my-server".into()))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let written = mock.claude_json.lock().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert!(parsed["mcpServers"].get("my-server").is_none());
    }

    #[tokio::test]
    async fn delete_handler_not_found() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let resp = delete_handler(test_user_vm(), State(state), RoutePath("nope".into()))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_handler_rejects_builtin() {
        let mock = Arc::new(MockVmConfigOps::new("{}", "{}"));
        let state = test_app_state(mock, Arc::new(MockHttpClient::empty()));
        let resp = delete_handler(
            test_user_vm(),
            State(state),
            RoutePath("gemini-websearch".into()),
        )
        .await
        .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }
}
