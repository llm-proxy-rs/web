use axum::{
    extract::{FromRequestParts, Query, State},
    http::{StatusCode, request::Parts},
    response::{Html, IntoResponse, Redirect, Response},
};
use handlers::{AppState as CognitoState, CallbackQuery, callback, login};
use store::upsert_user;
use tower_sessions::Session;
use tracing::error;

use crate::{
    gateway_auth::{initiate_gateway_login, is_gateway_configured},
    state::{AppError, AppState},
    templates::render_login_page,
};

pub(crate) struct User {
    pub(crate) email: String,
}

impl<S: Send + Sync> FromRequestParts<S> for User {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let session = Session::from_request_parts(parts, state)
            .await
            .map_err(|session_error| session_error.into_response())?;
        let email = session.get::<String>("email").await.map_err(|_| {
            error!("session lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "An internal error occurred",
            )
                .into_response()
        })?;
        email
            .map(|email| User { email })
            .ok_or_else(|| Redirect::to("/login").into_response())
    }
}

fn build_cognito_state(state: &AppState) -> CognitoState {
    CognitoState {
        client_id: state.config.cognito_client_id.clone(),
        client_secret: state.config.cognito_client_secret.clone(),
        domain: state.config.cognito_domain.clone(),
        redirect_uri: state.config.cognito_redirect_uri.clone(),
        region: state.config.cognito_region.clone(),
        user_pool_id: state.config.cognito_user_pool_id.clone(),
    }
}

pub(crate) async fn get_login_handler() -> Html<String> {
    Html(render_login_page())
}

pub(crate) async fn get_cognito_login_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let cognito_state = build_cognito_state(&state);
    Ok(login(session, State(cognito_state)).await?)
}

pub(crate) async fn get_callback_handler(
    query: Query<CallbackQuery>,
    session: Session,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let cognito_state = build_cognito_state(&state);
    let _response = callback(query, session.clone(), State(cognito_state)).await?;
    let email = session
        .get::<String>("email")
        .await
        .map_err(|_| anyhow::anyhow!("session lookup failed"))?;
    if let Some(email) = email
        && upsert_user(&state.db, &email).await.is_err()
    {
        return Err(anyhow::anyhow!("upsert_user failed").into());
    }

    // If gateway federation is configured, redirect to gateway Cognito for
    // silent SSO to provision an API key automatically.
    if is_gateway_configured(&state.config) {
        match initiate_gateway_login(&session, &state.config).await {
            Ok(authorize_url) => return Ok(Redirect::to(&authorize_url).into_response()),
            Err(_) => {
                return Err(anyhow::anyhow!("failed to initiate gateway login").into());
            }
        }
    }

    Ok(Redirect::to("/").into_response())
}

pub(crate) async fn get_logout_handler(session: Session) -> Result<Response, AppError> {
    session
        .delete()
        .await
        .map_err(|_| anyhow::anyhow!("session delete failed during logout"))?;
    Ok(Redirect::to("/login").into_response())
}
