use serde::Deserialize;

use crate::Content;

#[derive(Deserialize)]
pub(crate) struct JournalMessage {
    pub(crate) role: String,
    pub(crate) content: Content,
}

#[derive(Deserialize)]
pub(crate) struct JournalEntry {
    #[serde(rename = "type")]
    pub(crate) type_: String,
    #[serde(rename = "isMeta", default)]
    pub(crate) is_meta: bool,
    #[serde(rename = "isCompactSummary", default)]
    pub(crate) is_compact_summary: bool,
    pub(crate) message: JournalMessage,
}
