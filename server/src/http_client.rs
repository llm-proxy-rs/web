use anyhow::{Context, Result};
use async_trait::async_trait;
use bytes::Bytes;
use reqwest::StatusCode;
use std::time::Duration;

/// Response from an HTTP request, abstracting over the concrete HTTP client.
pub(crate) struct HttpResponse {
    pub status: StatusCode,
    pub body: Bytes,
}

impl HttpResponse {
    pub fn is_success(&self) -> bool {
        self.status.is_success()
    }

    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_slice(&self.body).context("failed to parse response JSON")
    }
}

/// Abstraction over outbound HTTP requests for testability.
#[async_trait]
pub(crate) trait HttpClient: Send + Sync {
    async fn get(&self, url: &str) -> Result<HttpResponse>;
    async fn post_form(&self, url: &str, params: &[(&str, String)]) -> Result<HttpResponse>;
    async fn post_json(
        &self,
        url: &str,
        body: serde_json::Value,
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse>;
}

/// Production implementation wrapping `reqwest::Client`.
pub(crate) struct ReqwestHttpClient {
    client: reqwest::Client,
}

impl ReqwestHttpClient {
    pub fn new(timeout: Duration) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .context("failed to build HTTP client")?;
        Ok(Self { client })
    }
}

#[async_trait]
impl HttpClient for ReqwestHttpClient {
    async fn get(&self, url: &str) -> Result<HttpResponse> {
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .context("HTTP GET request failed")?;
        let status = resp.status();
        let body = resp.bytes().await.context("failed to read response body")?;
        Ok(HttpResponse { status, body })
    }

    async fn post_form(&self, url: &str, params: &[(&str, String)]) -> Result<HttpResponse> {
        let resp = self
            .client
            .post(url)
            .form(params)
            .send()
            .await
            .context("HTTP POST form request failed")?;
        let status = resp.status();
        let body = resp.bytes().await.context("failed to read response body")?;
        Ok(HttpResponse { status, body })
    }

    async fn post_json(
        &self,
        url: &str,
        body: serde_json::Value,
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse> {
        let mut req = self.client.post(url).json(&body);
        for (key, value) in headers {
            req = req.header(*key, *value);
        }
        let resp = req.send().await.context("HTTP POST JSON request failed")?;
        let status = resp.status();
        let body = resp.bytes().await.context("failed to read response body")?;
        Ok(HttpResponse { status, body })
    }
}
