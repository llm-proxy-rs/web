use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_credential_types::{Credentials, provider::ProvideCredentials};
use chrono::{DateTime, Utc};
use firecracker_manager::ImdsCredential;
use std::time::SystemTime;
use tracing::info;

pub struct HostIamCredential {
    pub role_name: String,
    pub credential: ImdsCredential,
}

pub async fn fetch_host_iam_credentials(role_name: &str) -> Result<HostIamCredential> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let credentials = config
        .credentials_provider()
        .context("no credentials provider configured")?
        .provide_credentials()
        .await
        .context("failed to fetch host IAM credentials")?;
    let expiration = format_credential_expiry(&credentials)?;
    info!("fetched host IAM credentials");
    Ok(HostIamCredential {
        role_name: role_name.to_owned(),
        credential: build_imds_credential(&credentials, &expiration)?,
    })
}

fn system_time_to_iso8601(t: SystemTime) -> Result<String> {
    let dt: DateTime<Utc> = t.into();
    Ok(dt.to_rfc3339())
}

fn format_credential_expiry(credentials: &Credentials) -> Result<String> {
    credentials
        .expiry()
        .map(system_time_to_iso8601)
        .transpose()?
        .context("missing credential expiry")
}

fn build_imds_credential(credentials: &Credentials, expiration: &str) -> Result<ImdsCredential> {
    let session_token = credentials
        .session_token()
        .context("missing session token")?;
    Ok(ImdsCredential::new(
        credentials.access_key_id(),
        credentials.secret_access_key(),
        session_token,
        expiration,
    ))
}
