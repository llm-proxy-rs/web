use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState},
};

#[derive(Serialize)]
struct MemoryResponse {
    content: String,
}

pub(crate) async fn get_memory_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let content = state
        .vm_config_ops
        .exec_command(
            user_vm.guest_ip,
            "cat ~/.claude/CLAUDE.md 2>/dev/null || echo ''",
        )
        .await?;
    Ok(Json(MemoryResponse { content }).into_response())
}
