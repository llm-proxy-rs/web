use anyhow::{Context, Result, bail};
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, body::Bytes, client::conn::http1};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use std::path::Path;
use tokio::net::UnixStream;

pub(crate) async fn send_put(socket_path: &Path, uri: &str, body: &impl Serialize) -> Result<()> {
    send_request(socket_path, Method::PUT, uri, body).await
}

async fn send_request(
    socket_path: &Path,
    method: Method,
    uri: &str,
    body: &impl Serialize,
) -> Result<()> {
    let bytes = serde_json::to_vec(body).context("failed to serialize request body")?;
    let stream = UnixStream::connect(socket_path).await.with_context(|| {
        format!(
            "failed to connect to firecracker socket {}",
            socket_path.display()
        )
    })?;
    let (mut sender, conn) = http1::handshake(TokioIo::new(stream))
        .await
        .context("HTTP handshake failed")?;
    tokio::spawn(async move {
        if let Err(_err) = conn.await {
            tracing::debug!("firecracker connection closed");
        }
    });

    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("Host", "localhost")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(Full::new(Bytes::from(bytes)))
        .context("failed to build request")?;

    let response = sender
        .send_request(request)
        .await
        .context("failed to send request to firecracker")?;

    if !response.status().is_success() {
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .context("failed to read response body")?
            .to_bytes();
        let body = String::from_utf8_lossy(&bytes).into_owned();
        bail!("firecracker api returned {status}: {body}");
    }

    Ok(())
}
