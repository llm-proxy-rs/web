use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use bytes::Bytes;
use russh::ChannelMsg;
use ssh_client::{connect_ssh, open_exec_channel};
use std::{
    net::Ipv4Addr,
    path::{Path, PathBuf},
    str::from_utf8,
    time::Duration,
};
use tokio::time::timeout;

const GET_SETTINGS_CMD: &str = "cat ~/.claude/settings.json 2>/dev/null || echo '{}'";
const SET_SETTINGS_CMD: &str = "mkdir -p ~/.claude && cat > ~/.claude/settings.json";
const GET_CLAUDE_JSON_CMD: &str = "cat ~/.claude.json 2>/dev/null || echo '{}'";
const SET_CLAUDE_JSON_CMD: &str = "cat > ~/.claude.json";
const CHANNEL_SEND_TIMEOUT_SECS: u64 = 30;
const CHANNEL_WAIT_TIMEOUT_SECS: u64 = 30;
const TOTAL_OP_TIMEOUT_SECS: u64 = 60;

/// Abstraction over VM config file operations (read/write ~/.claude.json and ~/.claude/settings.json).
#[async_trait]
pub trait VmConfigOps: Send + Sync {
    async fn get_claude_json_raw(&self, guest_ip: Ipv4Addr) -> Result<String>;
    async fn set_claude_json(&self, guest_ip: Ipv4Addr, content: &str) -> Result<()>;
    async fn get_settings(&self, guest_ip: Ipv4Addr) -> Result<VmSettings>;
    async fn get_settings_raw(&self, guest_ip: Ipv4Addr) -> Result<String>;
    async fn set_settings(&self, guest_ip: Ipv4Addr, content: &str) -> Result<()>;
    /// Execute an arbitrary SSH command and return stdout.
    async fn exec_command(&self, guest_ip: Ipv4Addr, cmd: &str) -> Result<String>;
    /// Write content to a file via SSH using cat > path.
    async fn write_file(&self, guest_ip: Ipv4Addr, cmd: &str, content: &str) -> Result<()>;
}

/// Production implementation that delegates to SSH free functions.
pub struct SshVmConfigOps {
    pub ssh_key_path: PathBuf,
    pub ssh_user: String,
    pub vm_host_key_path: PathBuf,
}

#[async_trait]
impl VmConfigOps for SshVmConfigOps {
    async fn get_claude_json_raw(&self, guest_ip: Ipv4Addr) -> Result<String> {
        get_vm_claude_json_raw(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
        )
        .await
    }
    async fn set_claude_json(&self, guest_ip: Ipv4Addr, content: &str) -> Result<()> {
        set_vm_claude_json(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
            content,
        )
        .await
    }
    async fn get_settings(&self, guest_ip: Ipv4Addr) -> Result<VmSettings> {
        get_vm_settings(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
        )
        .await
    }
    async fn get_settings_raw(&self, guest_ip: Ipv4Addr) -> Result<String> {
        get_vm_settings_raw(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
        )
        .await
    }
    async fn set_settings(&self, guest_ip: Ipv4Addr, content: &str) -> Result<()> {
        set_vm_settings(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
            content,
        )
        .await
    }
    async fn exec_command(&self, guest_ip: Ipv4Addr, cmd: &str) -> Result<String> {
        exec_ssh_command(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
            cmd,
        )
        .await
    }
    async fn write_file(&self, guest_ip: Ipv4Addr, cmd: &str, content: &str) -> Result<()> {
        write_file_via_ssh(
            guest_ip,
            &self.ssh_key_path,
            &self.ssh_user,
            &self.vm_host_key_path,
            cmd,
            content,
        )
        .await
    }
}

pub struct VmSettings {
    pub has_api_key: bool,
    pub model: Option<String>,
}

pub fn build_api_key_settings_json(
    api_key: &str,
    base_url: Option<&str>,
    haiku_model: &str,
    sonnet_model: &str,
    opus_model: &str,
) -> Result<String> {
    let mut env = serde_json::json!({
        "ANTHROPIC_AUTH_TOKEN": api_key,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku_model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": sonnet_model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": opus_model,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    });
    if let Some(url) = base_url {
        env["ANTHROPIC_BASE_URL"] = serde_json::Value::String(url.to_string());
    }
    let settings = serde_json::json!({
        "$schema": "https://json.schemastore.org/claude-code-settings.json",
        "env": env,
        "permissions": {
            "deny": ["WebSearch"]
        },
        "skipWebFetchPreflight": true,
    });
    serde_json::to_string_pretty(&settings).context("settings serialization failed")
}

pub fn build_bedrock_settings_json(
    haiku_model: &str,
    sonnet_model: &str,
    opus_model: &str,
) -> Result<String> {
    let settings = serde_json::json!({
        "$schema": "https://json.schemastore.org/claude-code-settings.json",
        "env": {
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku_model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": sonnet_model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": opus_model,
            "CLAUDE_CODE_USE_BEDROCK": "1",
        },
    });
    serde_json::to_string_pretty(&settings).context("settings serialization failed")
}

pub async fn get_vm_settings_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<VmSettings> {
    let raw =
        get_vm_settings_raw_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    parse_vm_settings(raw.trim())
}

pub async fn get_vm_settings(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<VmSettings> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        get_vm_settings_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path),
    )
    .await
    .context("get_vm_settings timed out")?
}

pub async fn get_vm_settings_raw_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<String> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let mut channel = open_exec_channel(&mut ssh_handle, GET_SETTINGS_CMD).await?;
    let mut stdout = String::new();
    // No total timeout — callers must wrap in their own timeout.
    loop {
        match timeout(
            Duration::from_secs(CHANNEL_WAIT_TIMEOUT_SECS),
            channel.wait(),
        )
        .await
        {
            Ok(Some(ChannelMsg::Data { ref data })) => {
                stdout.push_str(from_utf8(data).context("SSH channel returned non-UTF-8 data")?);
            }
            Ok(Some(ChannelMsg::ExitStatus { .. })) | Ok(None) => break,
            Ok(_) => {}
            Err(_) => return Err(anyhow!("SSH channel read timed out")),
        }
    }
    Ok(stdout)
}

pub async fn get_vm_settings_raw(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<String> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        get_vm_settings_raw_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path),
    )
    .await
    .context("get_vm_settings_raw timed out")?
}

fn parse_vm_settings(stdout: &str) -> Result<VmSettings> {
    let settings: serde_json::Value =
        serde_json::from_str(stdout).context("failed to parse settings JSON")?;
    let env = settings.get("env");
    Ok(VmSettings {
        has_api_key: env
            .and_then(|v| v.get("ANTHROPIC_AUTH_TOKEN"))
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty()),
        model: settings
            .get("model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

pub async fn set_vm_settings_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    content: &str,
) -> Result<()> {
    write_file_via_ssh_unbounded(
        guest_ip,
        ssh_key_path,
        ssh_user,
        vm_host_key_path,
        SET_SETTINGS_CMD,
        content,
    )
    .await
}

pub async fn set_vm_settings(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    content: &str,
) -> Result<()> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        set_vm_settings_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path, content),
    )
    .await
    .context("set_vm_settings timed out")?
}

pub async fn get_vm_claude_json_raw_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<String> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let mut channel = open_exec_channel(&mut ssh_handle, GET_CLAUDE_JSON_CMD).await?;
    let mut stdout = String::new();
    // No total timeout — callers must wrap in their own timeout.
    loop {
        match timeout(
            Duration::from_secs(CHANNEL_WAIT_TIMEOUT_SECS),
            channel.wait(),
        )
        .await
        {
            Ok(Some(ChannelMsg::Data { ref data })) => {
                stdout.push_str(from_utf8(data).context("SSH channel returned non-UTF-8 data")?);
            }
            Ok(Some(ChannelMsg::ExitStatus { .. })) | Ok(None) => break,
            Ok(_) => {}
            Err(_) => return Err(anyhow!("SSH channel read timed out")),
        }
    }
    Ok(stdout)
}

pub async fn get_vm_claude_json_raw(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<String> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        get_vm_claude_json_raw_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path),
    )
    .await
    .context("get_vm_claude_json_raw timed out")?
}

pub async fn set_vm_claude_json_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    content: &str,
) -> Result<()> {
    write_file_via_ssh_unbounded(
        guest_ip,
        ssh_key_path,
        ssh_user,
        vm_host_key_path,
        SET_CLAUDE_JSON_CMD,
        content,
    )
    .await
}

pub async fn set_vm_claude_json(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    content: &str,
) -> Result<()> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        set_vm_claude_json_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path, content),
    )
    .await
    .context("set_vm_claude_json timed out")?
}

/// Extract the `mcpServers` map from raw `~/.claude.json` content.
pub fn parse_mcp_servers(raw: &str) -> Result<serde_json::Map<String, serde_json::Value>> {
    let root: serde_json::Value =
        serde_json::from_str(raw).context("failed to parse ~/.claude.json")?;
    // unwrap_or_default returns an empty Map when mcpServers is missing or not an object
    Ok(root
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default())
}

/// Upsert an MCP server entry into raw `~/.claude.json` content and return the updated JSON string.
pub fn upsert_mcp_server(raw: &str, name: &str, server: serde_json::Value) -> Result<String> {
    let mut root: serde_json::Value =
        serde_json::from_str(raw).context("failed to parse ~/.claude.json")?;
    let mcp = root
        .as_object_mut()
        .context("~/.claude.json is not an object")?
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    mcp.as_object_mut()
        .context("mcpServers is not an object")?
        .insert(name.to_owned(), server);
    serde_json::to_string_pretty(&root).context("serialization failed")
}

/// Remove an MCP server entry from raw `~/.claude.json` content and return the updated JSON string.
/// Returns `Ok(None)` if the server was not found.
pub fn remove_mcp_server(raw: &str, name: &str) -> Result<Option<String>> {
    let mut root: serde_json::Value =
        serde_json::from_str(raw).context("failed to parse ~/.claude.json")?;
    let Some(mcp) = root
        .as_object_mut()
        .and_then(|o| o.get_mut("mcpServers"))
        .and_then(|v| v.as_object_mut())
    else {
        return Ok(None);
    };
    if mcp.remove(name).is_none() {
        return Ok(None);
    }
    serde_json::to_string_pretty(&root)
        .context("serialization failed")
        .map(Some)
}

async fn write_file_via_ssh_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    cmd: &str,
    content: &str,
) -> Result<()> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let mut channel = open_exec_channel(&mut ssh_handle, cmd).await?;
    timeout(
        Duration::from_secs(CHANNEL_SEND_TIMEOUT_SECS),
        channel.data(Bytes::copy_from_slice(content.as_bytes()).as_ref()),
    )
    .await
    .context("SSH channel send timed out")?
    .context("SSH channel send failed")?;
    timeout(
        Duration::from_secs(CHANNEL_SEND_TIMEOUT_SECS),
        channel.eof(),
    )
    .await
    .context("SSH channel eof timed out")?
    .context("SSH channel eof failed")?;
    // No total timeout — callers must wrap in their own timeout.
    loop {
        match timeout(
            Duration::from_secs(CHANNEL_WAIT_TIMEOUT_SECS),
            channel.wait(),
        )
        .await
        {
            Ok(Some(ChannelMsg::ExitStatus { .. })) | Ok(None) => break,
            Ok(_) => {}
            Err(_) => return Err(anyhow!("SSH channel read timed out")),
        }
    }
    Ok(())
}

async fn write_file_via_ssh(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    cmd: &str,
    content: &str,
) -> Result<()> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        write_file_via_ssh_unbounded(
            guest_ip,
            ssh_key_path,
            ssh_user,
            vm_host_key_path,
            cmd,
            content,
        ),
    )
    .await
    .context("write_file_via_ssh timed out")?
}

/// Generic SSH command execution - runs a command and returns stdout.
pub async fn exec_ssh_command_unbounded(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    cmd: &str,
) -> Result<String> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let mut channel = open_exec_channel(&mut ssh_handle, cmd).await?;
    let mut stdout = String::new();
    // No total timeout — callers must wrap in their own timeout.
    loop {
        match timeout(
            Duration::from_secs(CHANNEL_WAIT_TIMEOUT_SECS),
            channel.wait(),
        )
        .await
        {
            Ok(Some(ChannelMsg::Data { ref data })) => {
                stdout.push_str(from_utf8(data).context("SSH channel returned non-UTF-8 data")?);
            }
            Ok(Some(ChannelMsg::ExitStatus { .. })) | Ok(None) => break,
            Ok(_) => {}
            Err(_) => return Err(anyhow!("SSH channel read timed out")),
        }
    }
    Ok(stdout)
}

pub async fn exec_ssh_command(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    cmd: &str,
) -> Result<String> {
    timeout(
        Duration::from_secs(TOTAL_OP_TIMEOUT_SECS),
        exec_ssh_command_unbounded(guest_ip, ssh_key_path, ssh_user, vm_host_key_path, cmd),
    )
    .await
    .context("exec_ssh_command timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_vm_settings ---

    #[test]
    fn parse_settings_with_api_key() {
        let json = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-test-123"}}"#;
        let settings = parse_vm_settings(json).unwrap();
        assert!(settings.has_api_key);
        assert!(settings.model.is_none());
    }

    #[test]
    fn parse_settings_without_api_key() {
        let json = r#"{"env":{}}"#;
        let settings = parse_vm_settings(json).unwrap();
        assert!(!settings.has_api_key);
    }

    #[test]
    fn parse_settings_empty_api_key() {
        let json = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":""}}"#;
        let settings = parse_vm_settings(json).unwrap();
        assert!(!settings.has_api_key);
    }

    #[test]
    fn parse_settings_with_model() {
        let json = r#"{"model":"claude-3-opus"}"#;
        let settings = parse_vm_settings(json).unwrap();
        assert_eq!(settings.model.as_deref(), Some("claude-3-opus"));
    }

    #[test]
    fn parse_settings_no_env_key() {
        let json = r#"{}"#;
        let settings = parse_vm_settings(json).unwrap();
        assert!(!settings.has_api_key);
        assert!(settings.model.is_none());
    }

    #[test]
    fn parse_settings_invalid_json() {
        assert!(parse_vm_settings("not json").is_err());
    }

    // --- build_api_key_settings_json ---

    #[test]
    fn api_key_settings_contains_token() {
        let json = build_api_key_settings_json("sk-abc", None, "haiku", "sonnet", "opus").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-abc");
        assert_eq!(parsed["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "haiku");
        assert_eq!(parsed["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "sonnet");
        assert_eq!(parsed["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "opus");
        assert!(parsed["env"].get("ANTHROPIC_BASE_URL").is_none());
    }

    #[test]
    fn api_key_settings_with_base_url() {
        let json = build_api_key_settings_json(
            "sk-abc",
            Some("https://custom.api"),
            "haiku",
            "sonnet",
            "opus",
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["env"]["ANTHROPIC_BASE_URL"], "https://custom.api");
    }

    #[test]
    fn api_key_settings_has_schema_and_permissions() {
        let json = build_api_key_settings_json("sk-abc", None, "h", "s", "o").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["$schema"].is_string());
        assert!(parsed["permissions"]["deny"].is_array());
        assert_eq!(parsed["skipWebFetchPreflight"], true);
    }

    // --- build_bedrock_settings_json ---

    #[test]
    fn bedrock_settings_contains_models_and_bedrock_flag() {
        let json = build_bedrock_settings_json("haiku-br", "sonnet-br", "opus-br").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["env"]["CLAUDE_CODE_USE_BEDROCK"], "1");
        assert_eq!(parsed["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "haiku-br");
        assert_eq!(parsed["env"]["ANTHROPIC_DEFAULT_SONNET_MODEL"], "sonnet-br");
        assert_eq!(parsed["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "opus-br");
        // No API token should be present
        assert!(parsed["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
    }

    #[test]
    fn bedrock_settings_has_schema() {
        let json = build_bedrock_settings_json("h", "s", "o").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["$schema"].is_string());
    }

    // --- parse_mcp_servers ---

    #[test]
    fn parse_mcp_servers_empty_object() {
        let servers = parse_mcp_servers("{}").unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn parse_mcp_servers_with_entries() {
        let json =
            r#"{"mcpServers":{"my-server":{"type":"http","url":"https://example.com/mcp"}}}"#;
        let servers = parse_mcp_servers(json).unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("my-server"));
        assert_eq!(servers["my-server"]["url"], "https://example.com/mcp");
    }

    #[test]
    fn parse_mcp_servers_invalid_json() {
        assert!(parse_mcp_servers("not json").is_err());
    }

    #[test]
    fn parse_mcp_servers_no_mcp_key() {
        let servers = parse_mcp_servers(r#"{"env":{}}"#).unwrap();
        assert!(servers.is_empty());
    }

    // --- upsert_mcp_server ---

    #[test]
    fn upsert_into_empty() {
        let result = upsert_mcp_server(
            "{}",
            "test",
            serde_json::json!({"type":"http","url":"https://x.com/mcp"}),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["mcpServers"]["test"]["url"], "https://x.com/mcp");
    }

    #[test]
    fn upsert_preserves_existing_servers() {
        let existing = r#"{"mcpServers":{"old":{"type":"http","url":"https://old.com"}}}"#;
        let result = upsert_mcp_server(
            existing,
            "new",
            serde_json::json!({"type":"http","url":"https://new.com"}),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["mcpServers"]["old"]["url"], "https://old.com");
        assert_eq!(parsed["mcpServers"]["new"]["url"], "https://new.com");
    }

    #[test]
    fn upsert_preserves_other_fields() {
        let existing = r#"{"env":{"FOO":"bar"},"mcpServers":{}}"#;
        let result = upsert_mcp_server(
            existing,
            "s",
            serde_json::json!({"type":"http","url":"https://s.com"}),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["env"]["FOO"], "bar");
    }

    #[test]
    fn upsert_overwrites_existing_server() {
        let existing = r#"{"mcpServers":{"s":{"type":"http","url":"https://old.com"}}}"#;
        let result = upsert_mcp_server(
            existing,
            "s",
            serde_json::json!({"type":"http","url":"https://new.com"}),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["mcpServers"]["s"]["url"], "https://new.com");
    }

    // --- remove_mcp_server ---

    #[test]
    fn remove_existing_server() {
        let existing = r#"{"mcpServers":{"a":{"type":"http"},"b":{"type":"http"}}}"#;
        let result = remove_mcp_server(existing, "a").unwrap().unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert!(parsed["mcpServers"].get("a").is_none());
        assert!(parsed["mcpServers"].get("b").is_some());
    }

    #[test]
    fn remove_nonexistent_server() {
        let existing = r#"{"mcpServers":{"a":{"type":"http"}}}"#;
        assert!(remove_mcp_server(existing, "nope").unwrap().is_none());
    }

    #[test]
    fn remove_from_empty_mcp_servers() {
        assert!(remove_mcp_server("{}", "nope").unwrap().is_none());
    }

    #[test]
    fn remove_from_no_mcp_key() {
        let existing = r#"{"env":{}}"#;
        assert!(remove_mcp_server(existing, "nope").unwrap().is_none());
    }
}
