use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    ContentBlocks(Vec<ContentBlock>),
}

#[derive(Deserialize, Serialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(flatten)]
    fields: serde_json::Map<String, serde_json::Value>,
}
