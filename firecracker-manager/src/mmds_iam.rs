use anyhow::Result;
use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct ImdsCredential {
    pub code: String,
    pub last_updated: String,
    #[serde(rename = "Type")]
    pub type_: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub token: String,
    pub expiration: String,
}

impl ImdsCredential {
    pub fn new(
        access_key_id: impl Into<String>,
        secret_access_key: impl Into<String>,
        token: impl Into<String>,
        expiration: impl Into<String>,
    ) -> Self {
        Self {
            code: "Success".to_string(),
            last_updated: format_iso8601_now(),
            type_: "AWS-HMAC".to_string(),
            access_key_id: access_key_id.into(),
            secret_access_key: secret_access_key.into(),
            token: token.into(),
            expiration: expiration.into(),
        }
    }
}

fn format_iso8601_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn build_mmds_with_iam(
    instance_id: &str,
    role_name: &str,
    credential: &ImdsCredential,
) -> Result<serde_json::Value> {
    // Credentials are stored as a JSON string (leaf node) rather than a nested object.
    // MMDS treats nested objects as directories and returns key listings instead of JSON,
    // which breaks the AWS SDK credential parser.
    let cred_str = serde_json::to_string(credential)?;
    let mut security_credentials = serde_json::Map::new();
    security_credentials.insert(role_name.to_string(), serde_json::Value::String(cred_str));
    Ok(serde_json::json!({
        "latest": {
            "meta-data": {
                "instance-id": instance_id,
                "iam": {
                    "security-credentials": security_credentials,
                }
            }
        }
    }))
}
