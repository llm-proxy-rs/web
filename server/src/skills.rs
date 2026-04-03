use axum::{
    Json,
    extract::{Path as RoutePath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use validator::Validate;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState},
};

#[derive(Serialize)]
struct SkillEntry {
    name: String,
    content: String,
}

#[derive(Deserialize, Validate)]
pub(crate) struct CreateSkillBody {
    #[validate(length(min = 1, max = 64))]
    name: String,
    #[validate(length(min = 1, max = 102400))]
    content: String,
}

fn is_valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

pub(crate) async fn list_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let output = state
        .vm_config_ops
        .exec_command(
            user_vm.guest_ip,
            r#"find ~/.claude/skills -name '*.md' -exec echo '---FILE:{}---' \; -exec cat {} \; 2>/dev/null || echo ''"#,
        )
        .await?;

    let mut entries = Vec::new();
    let parts: Vec<&str> = output.split("---FILE:").collect();
    for part in parts.iter().skip(1) {
        if let Some(end_marker) = part.find("---\n") {
            let filename = &part[..end_marker];
            let content = &part[end_marker + 4..];
            let name = filename
                .rsplit('/')
                .next()
                .unwrap_or(filename)
                .trim_end_matches(".md");
            entries.push(SkillEntry {
                name: name.to_string(),
                content: content.to_string(),
            });
        }
    }
    Ok(Json(entries).into_response())
}

pub(crate) async fn create_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<CreateSkillBody>,
) -> Result<Response, AppError> {
    if let Err(e) = body.validate() {
        return Ok((StatusCode::BAD_REQUEST, e.to_string()).into_response());
    }
    if !is_valid_skill_name(&body.name) {
        return Ok((
            StatusCode::BAD_REQUEST,
            "Skill name must be alphanumeric, dashes, or underscores (max 64 chars)",
        )
            .into_response());
    }
    let cmd = format!(
        "mkdir -p ~/.claude/skills && cat > ~/.claude/skills/{}.md",
        body.name
    );
    state
        .vm_config_ops
        .write_file(user_vm.guest_ip, &cmd, &body.content)
        .await?;
    Ok(StatusCode::CREATED.into_response())
}

pub(crate) async fn delete_handler(
    user_vm: UserVm,
    State(state): State<AppState>,
    RoutePath(name): RoutePath<String>,
) -> Result<Response, AppError> {
    if !is_valid_skill_name(&name) {
        return Ok((StatusCode::BAD_REQUEST, "Invalid skill name").into_response());
    }
    let cmd = format!("rm -f ~/.claude/skills/{}.md", name);
    state
        .vm_config_ops
        .exec_command(user_vm.guest_ip, &cmd)
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
