use crate::{
    Content,
    history::{is_interrupted_request, is_local_command_output, is_slash_command},
    journal::JournalEntry,
    project::find_all_project_dirs,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use russh_sftp::client::{SftpSession, fs::DirEntry};
use serde::{Deserialize, Serialize};
use sftp_client::open_sftp_session;
use ssh_client::connect_ssh;
use std::{net::Ipv4Addr, path::Path};
use tokio::io::AsyncReadExt;

#[derive(Serialize)]
pub struct ChatSession {
    pub session_id: String,
    pub project_dir: String,
    pub title: String,
    pub last_active_at: DateTime<Utc>,
}

pub async fn list_chat_sessions(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    ssh_user_home: &Path,
) -> Result<Vec<ChatSession>> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let sftp = open_sftp_session(&mut ssh_handle).await?;
    let project_dirs = find_all_project_dirs(&sftp, ssh_user_home).await?;
    let mut all_chat_sessions = Vec::new();
    for project_dir in &project_dirs {
        let dir_entries: Vec<DirEntry> = sftp
            .read_dir(project_dir.to_str().context("path is not valid UTF-8")?)
            .await?
            .collect();
        for dir_entry in &dir_entries {
            let name = dir_entry.file_name();
            let Some(session_id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if let Some(chat_session) =
                build_chat_session_with_title(&sftp, dir_entry, session_id, project_dir).await?
            {
                all_chat_sessions.push(chat_session);
            }
        }
    }
    all_chat_sessions.sort_by_key(|b| std::cmp::Reverse(b.last_active_at));
    Ok(all_chat_sessions)
}

pub async fn delete_chat_session(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    session_id: &str,
    project_dir: &Path,
) -> Result<()> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let sftp = open_sftp_session(&mut ssh_handle).await?;
    let path = project_dir.join(Path::new(session_id).with_extension("jsonl"));
    sftp.remove_file(path.to_str().context("path is not valid UTF-8")?)
        .await?;
    delete_session_dir(&sftp, project_dir, session_id).await
}

async fn delete_session_dir(
    sftp: &SftpSession,
    project_dir: &Path,
    session_id: &str,
) -> Result<()> {
    let dir_path = project_dir.join(session_id);
    if let Ok(true) = sftp
        .try_exists(dir_path.to_str().context("path is not valid UTF-8")?)
        .await
    {
        remove_dir_all(sftp, &dir_path, 2).await
    } else {
        Ok(())
    }
}

fn remove_dir_all<'a>(
    sftp: &'a SftpSession,
    path: &'a Path,
    max_depth: usize,
) -> BoxFuture<'a, Result<()>> {
    Box::pin(async move {
        let entries = list_dir_entries(sftp, path).await?;
        for entry in &entries {
            let entry_path = path.join(entry.file_name());
            if entry.file_type().is_dir() {
                if max_depth == 0 {
                    continue;
                }
                remove_dir_all(sftp, &entry_path, max_depth - 1).await?;
            } else {
                sftp.remove_file(entry_path.to_str().context("path is not valid UTF-8")?)
                    .await?;
            }
        }
        remove_sftp_dir(sftp, path).await
    })
}

async fn list_dir_entries(sftp: &SftpSession, path: &Path) -> Result<Vec<DirEntry>> {
    Ok(sftp
        .read_dir(path.to_str().context("path is not valid UTF-8")?)
        .await?
        .collect())
}

async fn remove_sftp_dir(sftp: &SftpSession, path: &Path) -> Result<()> {
    sftp.remove_dir(path.to_str().context("path is not valid UTF-8")?)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct CustomTitleEntry {
    #[serde(rename = "type")]
    type_: String,
    #[serde(rename = "customTitle")]
    custom_title: Option<String>,
}

fn extract_custom_title(contents: &str) -> Option<String> {
    contents
        .lines()
        .rev()
        // JSONL file contains mixed event types; skip lines that don't match.
        .filter_map(
            |line| match serde_json::from_str::<CustomTitleEntry>(line) {
                Ok(entry) => Some(entry),
                Err(err) => {
                    tracing::warn!("failed to parse custom title entry: {err}");
                    None
                }
            },
        )
        .filter(|e| e.type_ == "custom-title")
        .find_map(|e| e.custom_title.filter(|t| !t.is_empty()))
}

pub(crate) fn extract_session_title(contents: &str) -> Option<String> {
    extract_custom_title(contents).or_else(|| extract_last_user_title(contents))
}

pub(crate) fn extract_last_user_title(contents: &str) -> Option<String> {
    contents
        .lines()
        .rev()
        .filter_map(|line| match serde_json::from_str::<JournalEntry>(line) {
            Ok(entry) => Some(entry),
            Err(err) => {
                tracing::warn!("failed to parse journal entry: {err}");
                None
            }
        })
        .filter(|e| e.type_ == "user")
        // isMeta entries (e.g. <local-command-caveat>) are injected by Claude
        // Code as bookkeeping markers, not real conversation messages.
        .filter(|e| !e.is_meta)
        // Compact summary entries have type "user" but contain the boilerplate
        // "This session is being continued..." text, not a real user message.
        .filter(|e| !e.is_compact_summary)
        .filter_map(|e| e.message)
        .filter(|m| !is_slash_command(&m.content))
        .filter(|m| !is_local_command_output(&m.content))
        .filter(|m| !is_interrupted_request(&m.content))
        .find_map(|m| extract_user_title(m.content))
}

fn extract_user_title(content: Content) -> Option<String> {
    match content {
        Content::Text(text) => Some(text),
        Content::ContentBlocks(blocks) => blocks.into_iter().find_map(|b| b.text),
    }
}

async fn build_chat_session_with_title(
    sftp: &SftpSession,
    dir_entry: &DirEntry,
    session_id: &str,
    project_dir: &Path,
) -> Result<Option<ChatSession>> {
    let mtime = dir_entry
        .metadata()
        .mtime
        .context("missing mtime on session file")?;
    let last_active_at = DateTime::from_timestamp(i64::from(mtime), 0)
        .context("mtime is out of range for a timestamp")?;
    let path = project_dir.join(Path::new(session_id).with_extension("jsonl"));
    let Some(title) = fetch_session_title(sftp, &path).await? else {
        return Ok(None);
    };
    Ok(Some(ChatSession {
        session_id: session_id.to_owned(),
        project_dir: project_dir
            .to_str()
            .context("path is not valid UTF-8")?
            .to_owned(),
        title,
        last_active_at,
    }))
}

async fn fetch_session_title(sftp: &SftpSession, path: &Path) -> Result<Option<String>> {
    let mut file = sftp
        .open(path.to_str().context("path is not valid UTF-8")?)
        .await?;
    let mut contents = String::new();
    file.read_to_string(&mut contents).await?;
    Ok(extract_session_title(&contents))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_FIRST_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","message":{"role":"user","content":"first message"},"uuid":"00000000-0000-0000-0000-000000000002","timestamp":"2020-01-01T00:00:00.000Z","todos":[],"permissionMode":"default"}"#;
    const FIXTURE_TOOL_RESULT_USER: &str = r#"{"parentUuid":"00000000-0000-0000-0000-000000000003","isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","slug":"dummy-slug","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"some error","is_error":true,"tool_use_id":"tooluse_dummy"}]},"uuid":"00000000-0000-0000-0000-000000000004","timestamp":"2020-01-01T00:00:01.000Z","toolUseResult":"some error","sourceToolAssistantUUID":"00000000-0000-0000-0000-000000000003"}"#;
    const FIXTURE_LAST_USER: &str = r#"{"parentUuid":"00000000-0000-0000-0000-000000000005","isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","slug":"dummy-slug","type":"user","message":{"role":"user","content":"last message"},"uuid":"00000000-0000-0000-0000-000000000006","timestamp":"2020-01-01T00:00:02.000Z","todos":[],"permissionMode":"plan"}"#;
    const FIXTURE_IS_META_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"},"uuid":"00000000-0000-0000-0000-000000000002","timestamp":"2020-01-01T00:00:00.000Z"}"#;
    const FIXTURE_SLASH_COMMAND_USER: &str = r#"{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/home/user/project","sessionId":"00000000-0000-0000-0000-000000000001","version":"0.0.0","gitBranch":"main","type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>"},"uuid":"00000000-0000-0000-0000-000000000003","timestamp":"2020-01-01T00:00:01.000Z"}"#;

    #[test]
    fn test_title_is_last_user_message() {
        let jsonl = [
            FIXTURE_FIRST_USER,
            FIXTURE_TOOL_RESULT_USER,
            FIXTURE_LAST_USER,
        ]
        .join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("last message")
        );
    }

    #[test]
    fn test_title_skips_tool_result_user_entries() {
        let jsonl = [FIXTURE_FIRST_USER, FIXTURE_TOOL_RESULT_USER].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_title_returns_none_for_empty_chat_history() {
        assert_eq!(extract_last_user_title(""), None);
    }

    #[test]
    fn test_title_skips_is_meta_entries() {
        let jsonl = [FIXTURE_IS_META_USER, FIXTURE_FIRST_USER].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_title_skips_is_meta_entries_when_last() {
        // is_meta entry is last in file so the reverse iterator encounters it
        // first — proves it is actually filtered and not just bypassed.
        let jsonl = [FIXTURE_FIRST_USER, FIXTURE_IS_META_USER].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_title_skips_slash_command_entries() {
        let jsonl = [FIXTURE_FIRST_USER, FIXTURE_SLASH_COMMAND_USER].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_title_skips_compact_summary_entries() {
        let compact_summary = serde_json::json!({
            "type": "user",
            "isCompactSummary": true,
            "message": { "role": "user", "content": "This session is being continued.\n\nSummary:\nThe user asked about widgets." }
        })
        .to_string();
        let jsonl = [FIXTURE_FIRST_USER, &compact_summary].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_title_skips_local_command_stdout_entries() {
        let local_cmd = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": "<local-command-stdout>Set model to Default</local-command-stdout>" }
        })
        .to_string();
        let jsonl = [FIXTURE_FIRST_USER, &local_cmd].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_title_skips_interrupted_request_entries() {
        let interrupted = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": "[Request interrupted by user]" }] }
        })
        .to_string();
        let jsonl = [FIXTURE_FIRST_USER, &interrupted].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    const FIXTURE_CUSTOM_TITLE: &str = r#"{"type":"custom-title","customTitle":"my-custom-title"}"#;

    #[test]
    fn test_custom_title_preferred_over_user_message() {
        let jsonl = [FIXTURE_FIRST_USER, FIXTURE_CUSTOM_TITLE].join("\n");
        assert_eq!(
            extract_session_title(&jsonl).as_deref(),
            Some("my-custom-title")
        );
    }

    #[test]
    fn test_custom_title_empty_falls_back() {
        let empty_title = r#"{"type":"custom-title","customTitle":""}"#;
        let jsonl = [FIXTURE_FIRST_USER, empty_title].join("\n");
        assert_eq!(
            extract_session_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_custom_title_missing_falls_back() {
        let jsonl = FIXTURE_FIRST_USER.to_string();
        assert_eq!(
            extract_session_title(&jsonl).as_deref(),
            Some("first message")
        );
    }

    #[test]
    fn test_multiple_custom_titles_uses_last() {
        let first_title = r#"{"type":"custom-title","customTitle":"old-title"}"#;
        let last_title = r#"{"type":"custom-title","customTitle":"new-title"}"#;
        let jsonl = [FIXTURE_FIRST_USER, first_title, last_title].join("\n");
        assert_eq!(extract_session_title(&jsonl).as_deref(), Some("new-title"));
    }

    #[test]
    fn test_entries_without_message_field_are_skipped() {
        let no_message = r#"{"type":"file-history-snapshot","files":[]}"#;
        let jsonl = [no_message, FIXTURE_FIRST_USER].join("\n");
        assert_eq!(
            extract_last_user_title(&jsonl).as_deref(),
            Some("first message")
        );
    }
}
