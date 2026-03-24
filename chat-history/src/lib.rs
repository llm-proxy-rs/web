mod content;
mod history;
mod journal;
mod project;
mod session;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    System,
    #[serde(other)]
    Other,
}

pub use content::{Content, ContentBlock};
pub use history::{ChatHistory, ChatMessage, fetch_chat_history};
pub use session::{ChatSession, delete_chat_session, list_chat_sessions};
