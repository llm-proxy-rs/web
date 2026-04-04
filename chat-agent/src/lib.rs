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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn query_serializes_with_all_fields() {
        let msg = AgentMessage::Query {
            task_id: "t1".into(),
            conversation_id: "c1".into(),
            content: "hello".into(),
            session_id: Some("s1".into()),
            work_dir: Some("/tmp".into()),
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "query");
        assert_eq!(v["task_id"], "t1");
        assert_eq!(v["conversation_id"], "c1");
        assert_eq!(v["content"], "hello");
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["work_dir"], "/tmp");
    }

    #[test]
    fn query_omits_none_session_id_and_work_dir() {
        let msg = AgentMessage::Query {
            task_id: "t1".into(),
            conversation_id: "c1".into(),
            content: "hello".into(),
            session_id: None,
            work_dir: None,
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "query");
        assert!(v.get("session_id").is_none());
        assert!(v.get("work_dir").is_none());
    }

    #[test]
    fn hello_serializes_with_type_hello() {
        let msg = AgentMessage::Hello {
            task_id: "t1".into(),
            conversation_id: "c1".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "hello");
        assert_eq!(v["task_id"], "t1");
        assert_eq!(v["conversation_id"], "c1");
    }

    #[test]
    fn question_answer_serializes_with_custom_rename() {
        let msg = AgentMessage::QuestionAnswer {
            request_id: "r1".into(),
            answers: json!({"a": 1}),
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "answer_question");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["answers"], json!({"a": 1}));
    }

    #[test]
    fn interrupt_serializes_with_type_interrupt() {
        let msg = AgentMessage::Interrupt {
            task_id: "t1".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(v["type"], "interrupt");
        assert_eq!(v["task_id"], "t1");
    }
}
