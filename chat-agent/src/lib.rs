mod channel;
mod relay;

pub use channel::send_agent_message;
pub use relay::stream_task_sse;

#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    Query {
        task_id: String,
        conversation_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        work_dir: Option<String>,
    },
    Hello {
        task_id: String,
        conversation_id: String,
    },
    #[serde(rename = "answer_question")]
    QuestionAnswer {
        request_id: String,
        answers: serde_json::Value,
    },
    Interrupt {
        task_id: String,
    },
}
