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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialize_text_content() {
        let json = r#""hello world""#;
        let content: Content = serde_json::from_str(json).unwrap();
        match content {
            Content::Text(s) => assert_eq!(s, "hello world"),
            _ => panic!("expected Text variant"),
        }
    }

    #[test]
    fn deserialize_content_blocks() {
        let json = r#"[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1"}]"#;
        let content: Content = serde_json::from_str(json).unwrap();
        match content {
            Content::ContentBlocks(blocks) => {
                assert_eq!(blocks.len(), 2);
                assert_eq!(blocks[0].type_, "text");
                assert_eq!(blocks[0].text.as_deref(), Some("hello"));
                assert_eq!(blocks[1].type_, "tool_use");
                assert!(blocks[1].text.is_none());
                assert_eq!(blocks[1].fields["id"], "t1");
            }
            _ => panic!("expected ContentBlocks variant"),
        }
    }

    #[test]
    fn serialize_text_content() {
        let content = Content::Text("test".to_string());
        let json = serde_json::to_string(&content).unwrap();
        assert_eq!(json, r#""test""#);
    }

    #[test]
    fn serialize_content_blocks_skips_none_text() {
        let block = ContentBlock {
            type_: "tool_use".to_string(),
            text: None,
            fields: serde_json::Map::new(),
        };
        let json = serde_json::to_string(&block).unwrap();
        assert!(!json.contains("text"));
        assert!(json.contains("tool_use"));
    }

    #[test]
    fn empty_content_blocks_array() {
        let json = "[]";
        let content: Content = serde_json::from_str(json).unwrap();
        match content {
            Content::ContentBlocks(blocks) => assert!(blocks.is_empty()),
            _ => panic!("expected ContentBlocks variant"),
        }
    }

    #[test]
    fn content_block_preserves_extra_fields() {
        let json = r#"{"type":"thinking","thinking":"hmm","redacted":true}"#;
        let block: ContentBlock = serde_json::from_str(json).unwrap();
        assert_eq!(block.type_, "thinking");
        assert_eq!(block.fields["thinking"], "hmm");
        assert_eq!(block.fields["redacted"], true);
    }
}
