use anyhow::anyhow;
use axum::{
    Json,
    body::Body,
    extract::{Path as RoutePath, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use chat_agent::{AgentMessage, send_agent_message, stream_task_sse};
use futures::StreamExt;
use serde::Deserialize;
use std::convert::Infallible;
use tracing::info;
use uuid::Uuid;

use crate::{
    handlers::UserVm,
    state::{AppError, AppState, update_vm_last_activity},
};

// Sends a fire-and-forget message to the agent (e.g. QuestionAnswer, Interrupt).
// The agent's response is streamed back over the existing SSE connection opened by handle_chat_query.
async fn dispatch_agent_message(
    user_vm: &UserVm,
    state: &AppState,
    message: &AgentMessage,
) -> Result<(), AppError> {
    send_agent_message(
        user_vm.guest_ip,
        &state.config.ssh_key_path,
        &state.config.ssh_user,
        &state.config.vm_host_key_path,
        message,
    )
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct QueryBody {
    conversation_id: String,
    content: String,
    session_id: Option<String>,
    work_dir: Option<String>,
}

pub(crate) async fn handle_chat_query(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<QueryBody>,
) -> Result<Response, AppError> {
    // Limit content size to prevent resource exhaustion (1MB)
    if body.content.len() > 1_000_000 {
        return Err(anyhow!("content exceeds maximum size").into());
    }
    let task_id = Uuid::new_v4().to_string();
    let conversation_id = Uuid::parse_str(&body.conversation_id)
        .map_err(|_| anyhow!("invalid conversation_id: expected UUID"))?
        .to_string();
    update_vm_last_activity(&state.vms, &user_vm.vm_id)?;
    let task_created_json = serde_json::to_string(
        &serde_json::json!({"type": "task_created", "task_id": &task_id, "conversation_id": &conversation_id}),
    )
    .map_err(|_| anyhow!("failed to serialize task_created event"))?;
    let task_created_event = Bytes::from(format!(
        "event: task_created\ndata: {task_created_json}\n\n",
    ));
    let agent_message = AgentMessage::Query {
        task_id: task_id.clone(),
        conversation_id,
        content: body.content,
        session_id: body.session_id,
        work_dir: body.work_dir,
    };
    info!("query starting");
    let event_stream = stream_task_sse(
        user_vm.guest_ip,
        state.config.ssh_key_path.clone(),
        state.config.ssh_user.clone(),
        state.config.vm_host_key_path.clone(),
        agent_message,
    );
    let prefixed = futures::stream::once(std::future::ready(task_created_event))
        .chain(event_stream)
        .map(Ok::<_, Infallible>);
    let body = Body::from_stream(prefixed);
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(body)
        .map_err(|_| anyhow!("failed to build SSE response"))?;
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct ReconnectQuery {
    conversation_id: String,
}

pub(crate) async fn handle_chat_reconnect(
    user_vm: UserVm,
    RoutePath(task_id): RoutePath<String>,
    Query(query): Query<ReconnectQuery>,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    update_vm_last_activity(&state.vms, &user_vm.vm_id)?;
    let task_id = Uuid::parse_str(&task_id)
        .map_err(|_| anyhow!("invalid task_id: expected UUID"))?
        .to_string();
    let conversation_id = Uuid::parse_str(&query.conversation_id)
        .map_err(|_| anyhow!("invalid conversation_id: expected UUID"))?
        .to_string();
    let agent_message = AgentMessage::Hello {
        task_id,
        conversation_id,
    };
    let event_stream = stream_task_sse(
        user_vm.guest_ip,
        state.config.ssh_key_path.clone(),
        state.config.ssh_user.clone(),
        state.config.vm_host_key_path.clone(),
        agent_message,
    );
    let body = Body::from_stream(event_stream.map(Ok::<_, Infallible>));
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(body)
        .map_err(|_| anyhow!("failed to build SSE response"))
        .map_err(AppError::from)
}

#[derive(Deserialize)]
pub(crate) struct QuestionAnswerBody {
    request_id: String,
    answers: serde_json::Value,
}

pub(crate) async fn handle_chat_question_answer(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<QuestionAnswerBody>,
) -> Result<Response, AppError> {
    let request_id = Uuid::parse_str(&body.request_id)
        .map_err(|_| anyhow!("invalid request_id: expected UUID"))?
        .to_string();
    let agent_message = AgentMessage::QuestionAnswer {
        request_id,
        answers: body.answers,
    };
    dispatch_agent_message(&user_vm, &state, &agent_message).await?;
    info!("question answer forwarded");
    Ok((StatusCode::OK, "").into_response())
}

#[derive(Deserialize)]
pub(crate) struct StopBody {
    task_id: String,
}

pub(crate) async fn handle_chat_stop(
    user_vm: UserVm,
    State(state): State<AppState>,
    Json(body): Json<StopBody>,
) -> Result<Response, AppError> {
    let task_id = Uuid::parse_str(&body.task_id)
        .map_err(|_| anyhow!("invalid task_id: expected UUID"))?
        .to_string();
    let agent_message = AgentMessage::Interrupt { task_id };
    dispatch_agent_message(&user_vm, &state, &agent_message).await?;
    info!("interrupt forwarded");
    Ok((StatusCode::OK, "").into_response())
}
