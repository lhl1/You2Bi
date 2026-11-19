use biliup::client::{StatefulClient, StatelessClient};
use std::process::Command;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const CHILD: &str = "BILIUP_UPLOAD_DIRECT_TEST_CHILD";

#[tokio::test]
async fn posting_ignores_inherited_proxy_but_recording_keeps_it() {
    if std::env::var_os(CHILD).is_some() {
        verify_clients().await;
        return;
    }

    // Set proxy variables before reqwest first reads the environment, without
    // mutating environment variables shared with other tests in this process.
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let proxy_task = tokio::spawn(serve(proxy, "proxy", 1));
    let result = tokio::task::spawn_blocking(move || {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "posting_ignores_inherited_proxy_but_recording_keeps_it",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    proxy_task.await.unwrap();
}

async fn verify_clients() {
    let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", origin.local_addr().unwrap());
    let origin_task = tokio::spawn(serve(origin, "origin", 3));
    let recording = StatelessClient::default();
    let upload = StatelessClient::for_upload(None);
    let account = StatefulClient::new(Default::default(), None);
    for (client, expected) in [
        (&recording.client, "proxy"),
        (&upload.client, "origin"),
        (&account.client, "origin"),
    ] {
        let response = client
            .get(&url)
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), expected);
    }
    let response = upload
        .client_with_middleware
        .get(&url)
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "origin");
    origin_task.await.unwrap();
}

async fn serve(listener: TcpListener, body: &str, request_count: usize) {
    for _ in 0..request_count {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(8), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            assert!(request.len() < 8192);
            request.push(stream.read_u8().await.unwrap());
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    }
}
