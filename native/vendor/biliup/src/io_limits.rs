//! Shared media-I/O budgets. Zero means unlimited. Settings wake pending work.
use std::sync::{Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

pub const CHUNK: usize = 64 * 1024;
pub const DEFAULT_READ_BPS: u64 = 29_000_000;
pub static READ: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter::new(DEFAULT_READ_BPS));
pub static WRITE: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter::new(0));
struct State {
    rate: u64,
    next: Instant,
    version: u64,
    last: Instant,
    active: bool,
}
pub struct RateLimiter {
    state: Mutex<State>,
    changed: Notify,
    changed_sync: Condvar,
}
impl RateLimiter {
    pub fn new(rate: u64) -> Self {
        Self {
            state: Mutex::new(State {
                rate,
                next: Instant::now(),
                version: 0,
                last: Instant::now(),
                active: false,
            }),
            changed: Notify::new(),
            changed_sync: Condvar::new(),
        }
    }
    pub fn set_rate(&self, rate: u64) {
        let mut state = self.state.lock().unwrap();
        if state.rate == rate {
            return;
        }
        state.rate = rate;
        state.next = Instant::now();
        state.active = false;
        state.version = state.version.wrapping_add(1);
        drop(state);
        self.changed.notify_waiters();
        self.changed_sync.notify_all();
    }
    pub fn rate(&self) -> u64 {
        self.state.lock().unwrap().rate
    }
    fn reserve(state: &mut State, bytes: usize) -> Option<(Instant, u64)> {
        if state.rate == 0 {
            return None;
        }
        let now = Instant::now();
        if !state.active
            || (now > state.next && now.duration_since(state.last) > Duration::from_millis(100))
        {
            state.next = now;
        } else {
            // Carry scheduler lateness instead of paying a new Windows timer
            // tick per 64 KiB. Credit stays below 20 ms, with no initial burst.
            state.next = state
                .next
                .max(now.checked_sub(Duration::from_millis(20)).unwrap_or(now));
        }
        state.active = true;
        state.last = now;
        state.next += Duration::from_secs_f64(bytes as f64 / state.rate as f64);
        Some((state.next, state.version))
    }
    pub async fn wait(&self, bytes: usize) {
        for part in (0..bytes).step_by(CHUNK) {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let Some((until, version)) =
                    Self::reserve(&mut self.state.lock().unwrap(), (bytes - part).min(CHUNK))
                else {
                    break;
                };
                tokio::select! {
                    _ = tokio::time::sleep_until(until.into()) => { if self.state.lock().unwrap().version == version { break; } }
                    _ = changed => {}
                }
            }
        }
    }
    pub fn wait_blocking(&self, bytes: usize) {
        for part in (0..bytes).step_by(CHUNK) {
            loop {
                let mut state = self.state.lock().unwrap();
                let Some((until, version)) = Self::reserve(&mut state, (bytes - part).min(CHUNK))
                else {
                    break;
                };
                while state.version == version && Instant::now() < until {
                    state = self
                        .changed_sync
                        .wait_timeout(state, until.saturating_duration_since(Instant::now()))
                        .unwrap()
                        .0;
                }
                if state.version == version {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn late_wakeup_keeps_budget_and_idle_start_has_no_free_burst() {
        let limiter = RateLimiter::new(DEFAULT_READ_BPS);
        let now = Instant::now();
        let mut state = limiter.state.lock().unwrap();
        let deadline = RateLimiter::reserve(&mut state, CHUNK).unwrap().0;
        assert!(deadline > now);
        state.next = Instant::now() - Duration::from_millis(15);
        state.last = state.next;
        assert!(RateLimiter::reserve(&mut state, CHUNK).unwrap().0 < Instant::now());
        state.last = Instant::now() - Duration::from_secs(1);
        state.next = state.last;
        assert!(RateLimiter::reserve(&mut state, CHUNK).unwrap().0 > Instant::now());
    }
    #[tokio::test]
    async fn concurrent_consumers_share_one_budget() {
        let limiter = Arc::new(RateLimiter::new(512_000));
        let start = Instant::now();
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let limiter = limiter.clone();
            tasks.push(tokio::spawn(async move { limiter.wait(32_000).await }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert!(start.elapsed() >= Duration::from_millis(250));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
    #[tokio::test]
    async fn unlimited_and_empty_do_not_wait() {
        let limiter = RateLimiter::new(0);
        tokio::time::timeout(Duration::from_millis(30), limiter.wait(CHUNK * 20))
            .await
            .unwrap();
        limiter.set_rate(1);
        tokio::time::timeout(Duration::from_millis(30), limiter.wait(0))
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn changing_limit_wakes_async_and_blocking_waiters() {
        let limiter = Arc::new(RateLimiter::new(1));
        let a = limiter.clone();
        let b = limiter.clone();
        let a = tokio::spawn(async move { a.wait(CHUNK).await });
        let b = tokio::task::spawn_blocking(move || b.wait_blocking(CHUNK));
        tokio::time::sleep(Duration::from_millis(40)).await;
        limiter.set_rate(0);
        tokio::time::timeout(Duration::from_secs(1), a)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), b)
            .await
            .unwrap()
            .unwrap();
    }
    #[test]
    fn blocking_reads_are_paced_before_io() {
        let limiter = RateLimiter::new(256_000);
        let start = Instant::now();
        limiter.wait_blocking(32_000);
        assert!(start.elapsed() >= Duration::from_millis(125));
    }
}
