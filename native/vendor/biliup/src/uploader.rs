use crate::uploader::bilibili::Studio;
use crate::uploader::util::SubmitOption;
use crate::{Stream, error};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::io::{ErrorKind, Read, Seek};
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

pub mod bilibili;
pub mod credential;
pub mod credential_store;
pub mod line;
pub mod season;
pub mod util;

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "lowercase")]
pub enum Uploader {
    Upos,
    // Kodo,
    // Bos,
    // Gcs,
    // Cos,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub account: Account,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub user: Option<User>,
    pub line: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_submit")]
    pub submit: SubmitOption,
    pub streamers: HashMap<String, Studio>,
}

fn default_limit() -> usize {
    3
}

fn default_submit() -> SubmitOption {
    SubmitOption::App
}

pub fn load_config(config: &Path) -> error::Result<Config> {
    let file = std::fs::File::open(config).map_err(|e| {
        error::Kind::Custom(format!("无法打开配置文件 '{}': {}", config.display(), e))
    })?;

    let config: Config = serde_yaml::from_reader(file)
        .map_err(|e| {
            let location = e.location()
                .map(|loc| format!(" (第 {} 行，第 {} 列)", loc.line(), loc.column()))
                .unwrap_or_default();
            error::Kind::Custom(
                format!(
                    "配置文件 '{}' 格式错误{}: {}\n\n提示：请检查 YAML 格式是否正确（缩进、冒号、引号等），参考示例: examples/config.yaml.example",
                    config.display(),
                    location,
                    e
                )
            )
        })?;
    Ok(config)
}

pub struct VideoStream {
    pub capacity: usize,
    buffer: Vec<u8>,
    pub file: std::fs::File,
    pending: Option<tokio::task::JoinHandle<io::Result<Option<Bytes>>>>,
    finished: bool,
}

impl VideoStream {
    pub fn with_capacity(file: std::fs::File, capacity: usize) -> Self {
        // self.capacity = capacity;
        // self.buffer = vec![0u8; capacity];
        // self.buf = BytesMut::with_capacity(capacity);
        VideoStream {
            capacity,
            buffer: vec![0u8; capacity],
            file,
            pending: None,
            finished: false,
        }
    }

    pub fn read(&mut self) -> io::Result<Option<Bytes>> {
        let mut len = 0;
        let remaining = self.file.metadata()?.len().saturating_sub(self.file.stream_position()?);
        let count = remaining.min(self.buffer.len() as u64) as usize;
        let mut buf = &mut self.buffer[..count];
        while !buf.is_empty() {
            let count = buf.len().min(crate::io_limits::CHUNK);
            crate::io_limits::READ.wait_blocking(count);
            match self.file.read(&mut buf[..count]) {
                Ok(0) => break,
                Ok(n) => {
                    let tmp = buf;
                    len += n;
                    buf = &mut tmp[n..];
                }
                Err(ref e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        if len == 0 {
            Ok(None)
        } else {
            Ok(Some(Bytes::copy_from_slice(&self.buffer[..len])))
        }
    }
}

impl Stream for VideoStream {
    type Item = io::Result<Bytes>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.finished { return Poll::Ready(None); }
        if self.pending.is_none() {
            let file = self.file.try_clone()?;
            let capacity = self.capacity;
            // Disk reads and pacing must never sleep on a runtime worker.
            self.pending = Some(tokio::task::spawn_blocking(move || Self::with_capacity(file, capacity).read()));
        }
        match Pin::new(self.pending.as_mut().unwrap()).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                self.pending = None;
                match result.map_err(io::Error::other)? {
                    Ok(Some(bytes)) => Poll::Ready(Some(Ok(bytes))),
                    Ok(None) => { self.finished = true; Poll::Ready(None) },
                    Err(e) => { self.finished = true; Poll::Ready(Some(Err(e))) },
                }
            }
        }
    }
}

pub struct VideoFile {
    pub total_size: u64,
    pub file_name: String,
    pub filepath: std::path::PathBuf,
    pub file: std::fs::File,
}

impl VideoFile {
    pub fn new(filepath: &std::path::Path) -> io::Result<Self> {
        let file = std::fs::File::open(filepath)?;
        let total_size = file.metadata()?.len();
        let file_name = filepath
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "the path terminates in .."))?;
        Ok(Self {
            file,
            // capacity: 10485760,
            total_size,
            file_name: file_name.into(),
            filepath: filepath.into(),
        })
    }

    pub fn get_stream(&self, capacity: usize) -> io::Result<VideoStream> {
        Ok(VideoStream::with_capacity(self.file.try_clone()?, capacity))
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;
    use futures::StreamExt;
    #[tokio::test(flavor = "current_thread")]
    async fn throttled_file_stream_keeps_runtime_responsive_and_preserves_chunks() {
        use std::io::Write;
        struct Restore(u64);
        impl Drop for Restore { fn drop(&mut self) { crate::io_limits::READ.set_rate(self.0); } }
        let _restore=Restore(crate::io_limits::READ.rate());
        crate::io_limits::READ.set_rate(256_000);
        let mut file=tempfile::tempfile().unwrap();
        let data=vec![13;64_000+517];file.write_all(&data).unwrap();
        std::io::Seek::rewind(&mut file).unwrap();
        let mut stream=VideoStream::with_capacity(file,64_000);let mut ticks=0;let mut bytes=Vec::new();
        let mut timer=tokio::time::interval(std::time::Duration::from_millis(10));
        loop {tokio::select! {part=stream.next()=>match part {Some(part)=>bytes.extend_from_slice(&part.unwrap()),None=>break},_=timer.tick()=>{ticks+=1;}}}
        assert_eq!(bytes,data);assert!(ticks>=10,"file pacing blocked the runtime");
    }
}
