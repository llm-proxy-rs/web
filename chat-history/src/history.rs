use anyhow::Result;
use serde::Serialize;
use sftp_client::open_sftp_session;
use ssh_client::connect_ssh;
use std::{net::Ipv4Addr, path::Path};
use tokio::io::AsyncReadExt;

use crate::{Content, journal::JournalEntry};

#[derive(Serialize)]
pub struct ChatHistory {
    pub messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Content,
    #[serde(rename = "isCompactSummary")]
    pub is_compact_summary: bool,
}

pub async fn fetch_chat_history(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    session_id: &str,
    project_dir: &Path,
) -> Result<ChatHistory> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let sftp = open_sftp_session(&mut ssh_handle).await?;
    let path = project_dir.join(Path::new(session_id).with_extension("jsonl"));
    let mut file = sftp
        .open(path.to_str().expect("path is valid UTF-8"))
        .await?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).await?;
    Ok(parse_chat_history(&contents))
}

pub(crate) fn parse_chat_history(contents: &str) -> ChatHistory {
    let mut messages = Vec::new();
    let mut skip_next_assistant = false;
    for entry in contents
        .lines()
        .filter_map(|line| serde_json::from_str::<JournalEntry>(line).ok())
        .filter(|e| matches!(e.type_.as_str(), "user" | "assistant"))
        // isMeta entries (e.g. <local-command-caveat>) are injected by Claude
        // Code as bookkeeping markers, not real conversation messages.
        .filter(|e| !e.is_meta)
    {
        if entry.is_compact_summary {
            messages.push(build_compact_summary_message(entry));
            continue;
        }
        if is_slash_command(&entry.message.content) {
            // Skip the next assistant entry too: Claude Code writes a synthetic
            // assistant reply (e.g. "No response requested.") after every slash
            // command. That reply is an internal acknowledgment, not real output.
            skip_next_assistant = true;
            continue;
        }
        if is_local_command_output(&entry.message.content) {
            continue;
        }
        if is_interrupted_request(&entry.message.content) {
            continue;
        }
        if entry.type_ == "assistant" && skip_next_assistant {
            skip_next_assistant = false;
            continue;
        }
        skip_next_assistant = false;
        messages.push(build_chat_message(entry));
    }
    ChatHistory { messages }
}

pub(crate) fn is_slash_command(content: &Content) -> bool {
    match content {
        Content::Text(text) => text.starts_with("<command-name>"),
        Content::ContentBlocks(_) => false,
    }
}

pub(crate) fn is_local_command_output(content: &Content) -> bool {
    // <local-command-stdout> is injected by Claude Code when local commands
    // run and is not a real user message.
    match content {
        Content::Text(text) => text.starts_with("<local-command-stdout>"),
        Content::ContentBlocks(_) => false,
    }
}

pub(crate) fn is_interrupted_request(content: &Content) -> bool {
    match content {
        Content::Text(_) => false,
        Content::ContentBlocks(blocks) => blocks.iter().all(|b| {
            b.text
                .as_deref()
                .is_some_and(|t| t.starts_with("[Request interrupted by user"))
        }),
    }
}

fn build_chat_message(entry: JournalEntry) -> ChatMessage {
    ChatMessage {
        role: entry.message.role,
        content: entry.message.content,
        is_compact_summary: false,
    }
}

fn build_compact_summary_message(entry: JournalEntry) -> ChatMessage {
    ChatMessage {
        role: entry.message.role,
        content: entry.message.content,
        is_compact_summary: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_FIRST_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","message":{"role":"user","content":"first message"},"uuid":"00000000-0000-0000-0000-000000000002","timestamp":"2020-01-01T00:00:00.000Z","todos":[],"permissionMode":"default"}"#;
    const FIXTURE_TOOL_RESULT_USER: &str = r#"{"parentUuid":"00000000-0000-0000-0000-000000000003","isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","slug":"dummy-slug","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"some error","is_error":true,"tool_use_id":"tooluse_dummy"}]},"uuid":"00000000-0000-0000-0000-000000000004","timestamp":"2020-01-01T00:00:01.000Z","toolUseResult":"some error","sourceToolAssistantUUID":"00000000-0000-0000-0000-000000000003"}"#;
    const FIXTURE_IS_META_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"},"uuid":"00000000-0000-0000-0000-000000000002","timestamp":"2020-01-01T00:00:00.000Z"}"#;
    const FIXTURE_SLASH_COMMAND_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"},"uuid":"00000000-0000-0000-0000-000000000003","timestamp":"2020-01-01T00:00:01.000Z"}"#;
    const FIXTURE_LOCAL_COMMAND_STDOUT_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to Default</local-command-stdout>"},"uuid":"00000000-0000-0000-0000-000000000003","timestamp":"2020-01-01T00:00:01.000Z"}"#;

    fn make_interrupted_request_line() -> String {
        serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "[Request interrupted by user]" }]
            }
        })
        .to_string()
    }

    fn make_interrupted_tool_use_line() -> String {
        serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": "[Request interrupted by user for tool use]" }]
            }
        })
        .to_string()
    }

    fn make_assistant_line(text: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": text }]
            }
        })
        .to_string()
    }

    #[test]
    fn test_user_string_content_is_rendered() {
        let chat_history = parse_chat_history(FIXTURE_FIRST_USER);
        assert_eq!(chat_history.messages.len(), 1);
        assert_eq!(chat_history.messages[0].role, "user");
        let Content::Text(ref text) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(text, "first message");
    }

    #[test]
    fn test_tool_result_user_messages_are_included() {
        let chat_history = parse_chat_history(FIXTURE_TOOL_RESULT_USER);
        assert_eq!(chat_history.messages.len(), 1);
        let Content::ContentBlocks(ref blocks) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(blocks[0].type_, "tool_result");
    }

    #[test]
    fn test_thinking_blocks_included_in_assistant() {
        let jsonl = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "hmm" },
                    { "type": "text", "text": "answer" }
                ]
            }
        })
        .to_string();
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
        let Content::ContentBlocks(ref blocks) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].type_, "thinking");
        assert_eq!(blocks[1].text.as_deref(), Some("answer"));
    }

    #[test]
    fn test_invalid_lines_are_skipped() {
        let jsonl = ["not json", FIXTURE_FIRST_USER, "also not json"].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
    }

    #[test]
    fn test_empty_chat_history() {
        let chat_history = parse_chat_history("");
        assert!(chat_history.messages.is_empty());
    }

    #[test]
    fn test_is_meta_user_entries_are_excluded() {
        let jsonl = [FIXTURE_IS_META_USER, FIXTURE_FIRST_USER].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
        let Content::Text(ref text) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(text, "first message");
    }

    #[test]
    fn test_slash_command_user_entries_are_excluded() {
        let jsonl = [FIXTURE_SLASH_COMMAND_USER, FIXTURE_FIRST_USER].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
        let Content::Text(ref text) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(text, "first message");
    }

    #[test]
    fn test_assistant_response_to_slash_command_is_excluded() {
        let assistant_response = make_assistant_line("No response requested.");
        let jsonl = [
            FIXTURE_SLASH_COMMAND_USER,
            &assistant_response,
            FIXTURE_FIRST_USER,
            &make_assistant_line("hello"),
        ]
        .join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 2);
        assert_eq!(chat_history.messages[0].role, "user");
        assert_eq!(chat_history.messages[1].role, "assistant");
    }

    #[test]
    fn test_interrupted_request_entries_are_excluded() {
        let jsonl = [FIXTURE_FIRST_USER, &make_interrupted_request_line()].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
        assert_eq!(chat_history.messages[0].role, "user");
    }

    #[test]
    fn test_interrupted_tool_use_entries_are_excluded() {
        let jsonl = [FIXTURE_FIRST_USER, &make_interrupted_tool_use_line()].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
        assert_eq!(chat_history.messages[0].role, "user");
    }

    #[test]
    fn test_compact_summary_is_included_with_flag() {
        let compact_summary_text = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n...";
        let compact_summary = serde_json::json!({
            "type": "user",
            "isCompactSummary": true,
            "message": { "role": "user", "content": compact_summary_text }
        })
        .to_string();
        let jsonl = [&compact_summary, FIXTURE_FIRST_USER].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 2);
        assert!(chat_history.messages[0].is_compact_summary);
        let Content::Text(ref text) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(text, compact_summary_text);
        assert!(!chat_history.messages[1].is_compact_summary);
    }

    #[test]
    fn test_local_command_stdout_entries_are_excluded() {
        let jsonl = [FIXTURE_LOCAL_COMMAND_STDOUT_USER, FIXTURE_FIRST_USER].join("\n");
        let chat_history = parse_chat_history(&jsonl);
        assert_eq!(chat_history.messages.len(), 1);
        let Content::Text(ref text) = chat_history.messages[0].content else {
            panic!()
        };
        assert_eq!(text, "first message");
    }
}
