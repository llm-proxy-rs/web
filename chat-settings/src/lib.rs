use anyhow::{Context, Result, anyhow};
use bytes::Bytes;
use russh::{ChannelMsg, client};
use ssh_client::{SshClient, connect_ssh, open_exec_channel};
use std::{net::Ipv4Addr, path::Path, str::from_utf8, time::Duration};
use tokio::time::timeout;

const GET_SETTINGS_CMD: &str = "cat ~/.claude/settings.json 2>/dev/null || echo '{}'";
const SET_SETTINGS_CMD: &str = "mkdir -p ~/.claude && cat > ~/.claude/settings.json";
const CHANNEL_SEND_TIMEOUT_SECS: u64 = 30;
const CHANNEL_WAIT_TIMEOUT_SECS: u64 = 30;

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

pub async fn get_vm_settings(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<VmSettings> {
    let raw = get_vm_settings_raw(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    parse_vm_settings(raw.trim())
}

pub async fn get_vm_settings_raw(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
) -> Result<String> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    let mut channel = open_exec_channel(&mut ssh_handle, GET_SETTINGS_CMD).await?;
    let mut stdout = String::new();
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

pub async fn set_vm_settings(
    guest_ip: Ipv4Addr,
    ssh_key_path: &Path,
    ssh_user: &str,
    vm_host_key_path: &Path,
    content: &str,
) -> Result<()> {
    let mut ssh_handle = connect_ssh(guest_ip, ssh_key_path, ssh_user, vm_host_key_path).await?;
    write_settings_file(&mut ssh_handle, content).await
}

async fn write_settings_file(
    ssh_handle: &mut client::Handle<SshClient>,
    content: &str,
) -> Result<()> {
    let mut channel = open_exec_channel(ssh_handle, SET_SETTINGS_CMD).await?;
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
