use crate::{
    gateway_auth::is_gateway_configured,
    handlers::UserVm,
    state::{AppError, AppState},
};
use anyhow::{Context, Result};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chat_settings::{
    build_api_key_settings_json, get_vm_settings, get_vm_settings_raw, set_vm_settings,
};
use serde::{Deserialize, Serialize};

/// Only allow model identifiers that look like valid model strings.
/// Rejects arbitrary user input to prevent abuse.
fn is_valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '/'))
}

/// API keys must be 1..=256 printable ASCII characters (no spaces, control chars, or newlines).
fn is_valid_api_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 256 && key.chars().all(|c| c.is_ascii_graphic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_model_simple() {
        assert!(is_valid_model("claude-3-opus"));
    }

    #[test]
    fn valid_model_with_dots_and_colons() {
        assert!(is_valid_model("us.anthropic.claude-sonnet-4-6"));
    }

    #[test]
    fn valid_model_with_slash_and_colon() {
        assert!(is_valid_model("model/v1:latest"));
    }

    #[test]
    fn valid_model_with_underscores() {
        assert!(is_valid_model("my_model_v2"));
    }

    #[test]
    fn invalid_model_empty() {
        assert!(!is_valid_model(""));
    }

    #[test]
    fn invalid_model_too_long() {
        let long = "a".repeat(129);
        assert!(!is_valid_model(&long));
    }

    #[test]
    fn valid_model_at_max_length() {
        let max = "a".repeat(128);
        assert!(is_valid_model(&max));
    }

    #[test]
    fn invalid_model_with_spaces() {
        assert!(!is_valid_model("claude 3 opus"));
    }

    #[test]
    fn invalid_model_with_semicolons() {
        assert!(!is_valid_model("model;drop table"));
    }

    #[test]
    fn invalid_model_with_newlines() {
        assert!(!is_valid_model("model\ninjection"));
    }

    #[test]
    fn invalid_model_with_backticks() {
        assert!(!is_valid_model("model`whoami`"));
    }

    #[test]
    fn invalid_model_with_special_chars() {
        assert!(!is_valid_model("model$(cmd)"));
        assert!(!is_valid_model("model&other"));
        assert!(!is_valid_model("model|pipe"));
    }

    // ── API key validation ─────────────────────────────────────────────

    #[test]
    fn valid_api_key_simple() {
        assert!(is_valid_api_key("sk-ant-api03-abc123"));
    }

    #[test]
    fn invalid_api_key_empty() {
        assert!(!is_valid_api_key(""));
    }

    #[test]
    fn valid_api_key_at_max_length() {
        let key = "a".repeat(256);
        assert!(is_valid_api_key(&key));
    }

    #[test]
    fn invalid_api_key_too_long() {
        let key = "a".repeat(257);
        assert!(!is_valid_api_key(&key));
    }

    #[test]
    fn invalid_api_key_with_newline() {
        assert!(!is_valid_api_key("sk-ant\ninjection"));
    }

    #[test]
    fn invalid_api_key_with_control_char() {
        assert!(!is_valid_api_key("sk-ant\x00key"));
        assert!(!is_valid_api_key("sk-ant\x1Fkey"));
    }

    #[test]
    fn invalid_api_key_with_space() {
        assert!(!is_valid_api_key("sk ant key"));
    }

    #[test]
    fn invalid_api_key_with_tab() {
        assert!(!is_valid_api_key("sk\tant"));
    }
}

#[derive(Serialize)]
pub(crate) struct SettingsResponse {
    uses_bedrock: bool,
    has_api_key: bool,
    base_url: Option<String>,
    model: Option<String>,
    gateway_configured: bool,
}

pub(crate) async fn get_settings_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    // In Bedrock/IAM mode, skip the SSH round-trip since we don't need VM settings
    if state.config.use_iam_creds {
        return Ok(Json(SettingsResponse {
            uses_bedrock: true,
            has_api_key: false,
            base_url: state.config.anthropic_base_url.clone(),
            model: None,
            gateway_configured: is_gateway_configured(&state.config),
        })
        .into_response());
    }
    let vm_settings = get_vm_settings(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
    )
    .await?;
    Ok(Json(SettingsResponse {
        uses_bedrock: false,
        has_api_key: vm_settings.has_api_key,
        base_url: state.config.anthropic_base_url.clone(),
        model: vm_settings.model,
        gateway_configured: is_gateway_configured(&state.config),
    })
    .into_response())
}

#[derive(Deserialize)]
pub(crate) struct SetSettingsBody {
    api_key: Option<String>,
    model: Option<String>,
}

pub(crate) async fn put_settings_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<SetSettingsBody>,
) -> Result<Response, AppError> {
    // Validate model if provided
    if let Some(model) = &body.model
        && !is_valid_model(model)
    {
        return Ok((StatusCode::BAD_REQUEST, "Invalid model identifier").into_response());
    }
    if let Some(api_key) = &body.api_key {
        if !is_valid_api_key(api_key) {
            return Ok((StatusCode::BAD_REQUEST, "Invalid API key").into_response());
        }
        if state.config.use_iam_creds {
            return Ok(Json("API key not applicable in Bedrock mode").into_response());
        }
        update_api_key_setting(&user_vm, &state, api_key).await?;
    } else if let Some(model) = &body.model {
        update_model_setting(&user_vm, &state, model).await?;
    }
    Ok(Json("").into_response())
}

async fn update_api_key_setting(user_vm: &UserVm, state: &AppState, api_key: &str) -> Result<()> {
    let content = build_api_key_settings_json(
        api_key,
        state.config.anthropic_base_url.as_deref(),
        &state.config.anthropic_default_haiku_model,
        &state.config.anthropic_default_sonnet_model,
        &state.config.anthropic_default_opus_model,
    )?;
    set_vm_settings(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &content,
    )
    .await
}

async fn update_model_setting(user_vm: &UserVm, state: &AppState, model: &str) -> Result<()> {
    // Model-only update: read current settings, patch the model field, write back
    let raw = get_vm_settings_raw(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
    )
    .await?;
    let mut settings: serde_json::Value =
        serde_json::from_str(raw.trim()).context("failed to parse settings JSON")?;
    settings["model"] = serde_json::Value::String(model.to_owned());
    let content = settings.to_string();
    set_vm_settings(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &content,
    )
    .await
}
