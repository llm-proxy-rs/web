use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use chat_settings::{build_api_key_settings_json, get_vm_settings, set_vm_settings};
use serde::{Deserialize, Serialize};

use crate::{
    handlers::UserVm,
    state::{AppError, AppState},
};

#[derive(Serialize)]
pub(crate) struct SettingsResponse {
    uses_bedrock: bool,
    has_api_key: bool,
    base_url: Option<String>,
}

pub(crate) async fn get_settings_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    if state.config.use_iam_creds {
        return Ok(Json(SettingsResponse {
            uses_bedrock: true,
            has_api_key: false,
            base_url: state.config.anthropic_base_url.clone(),
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
    })
    .into_response())
}

#[derive(Deserialize)]
pub(crate) struct SetSettingsBody {
    api_key: String,
}

pub(crate) async fn put_settings_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<SetSettingsBody>,
) -> Result<Response, AppError> {
    if state.config.use_iam_creds {
        return Ok(Json("API key not applicable in Bedrock mode").into_response());
    }
    let content = build_api_key_settings_json(
        &body.api_key,
        state.config.anthropic_base_url.as_deref(),
        &state.config.anthropic_default_haiku_model,
        &state.config.anthropic_default_sonnet_model,
        &state.config.anthropic_default_opus_model,
    );
    set_vm_settings(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        &content,
    )
    .await?;
    Ok(Json("").into_response())
}
