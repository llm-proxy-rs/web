use anyhow::Result;
use async_trait::async_trait;
use std::{collections::VecDeque, net::Ipv4Addr, sync::Mutex};

use chat_settings::{VmConfigOps, VmSettings};

use crate::http_client::{HttpClient, HttpResponse};
use crate::state::{AppConfig, AppState};

/// Mock VM config operations that store state in memory.
pub(crate) struct MockVmConfigOps {
    pub claude_json: Mutex<String>,
    pub settings_json: Mutex<String>,
}

impl MockVmConfigOps {
    pub fn new(claude_json: &str, settings_json: &str) -> Self {
        Self {
            claude_json: Mutex::new(claude_json.to_string()),
            settings_json: Mutex::new(settings_json.to_string()),
        }
    }
}

#[async_trait]
impl VmConfigOps for MockVmConfigOps {
    async fn get_claude_json_raw(&self, _guest_ip: Ipv4Addr) -> Result<String> {
        Ok(self.claude_json.lock().unwrap().clone())
    }
    async fn set_claude_json(&self, _guest_ip: Ipv4Addr, content: &str) -> Result<()> {
        *self.claude_json.lock().unwrap() = content.to_string();
        Ok(())
    }
    async fn get_settings(&self, _guest_ip: Ipv4Addr) -> Result<VmSettings> {
        let raw = self.settings_json.lock().unwrap().clone();
        let settings: serde_json::Value = serde_json::from_str(raw.trim())?;
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
    async fn get_settings_raw(&self, _guest_ip: Ipv4Addr) -> Result<String> {
        Ok(self.settings_json.lock().unwrap().clone())
    }
    async fn set_settings(&self, _guest_ip: Ipv4Addr, content: &str) -> Result<()> {
        *self.settings_json.lock().unwrap() = content.to_string();
        Ok(())
    }
    async fn exec_command(&self, _guest_ip: Ipv4Addr, _cmd: &str) -> Result<String> {
        Ok(String::new())
    }
    async fn write_file(&self, _guest_ip: Ipv4Addr, _cmd: &str, _content: &str) -> Result<()> {
        Ok(())
    }
}

/// Mock HTTP client that returns pre-configured responses in FIFO order.
pub(crate) struct MockHttpClient {
    pub responses: Mutex<VecDeque<HttpResponse>>,
}

impl MockHttpClient {
    pub fn new(responses: Vec<HttpResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
        }
    }

    pub fn empty() -> Self {
        Self::new(vec![])
    }
}

#[async_trait]
impl HttpClient for MockHttpClient {
    async fn get(&self, _url: &str) -> Result<HttpResponse> {
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("MockHttpClient: no more responses"))
    }
    async fn post_form(&self, _url: &str, _params: &[(&str, String)]) -> Result<HttpResponse> {
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("MockHttpClient: no more responses"))
    }
    async fn post_json(
        &self,
        _url: &str,
        _body: serde_json::Value,
        _headers: &[(&str, &str)],
    ) -> Result<HttpResponse> {
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("MockHttpClient: no more responses"))
    }
}

/// Create a test AppState with mock VM config and HTTP client.
pub(crate) fn test_app_state(
    vm_config_ops: std::sync::Arc<dyn VmConfigOps>,
    http_client: std::sync::Arc<dyn HttpClient>,
) -> AppState {
    let config: AppConfig =
        serde_json::from_str("{}").expect("AppConfig should deserialize from empty JSON");
    AppState::new(
        config,
        sqlx::PgPool::connect_lazy("postgres://test:test@localhost/test")
            .expect("lazy pool creation should not fail"),
        crate::static_files::StaticAssets::default(),
        vm_config_ops,
        http_client,
    )
}
