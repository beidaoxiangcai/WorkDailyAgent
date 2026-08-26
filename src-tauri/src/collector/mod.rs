//! 采集模块：3 秒轮询当前活跃应用 + 窗口标题，经合并引擎去抖动/空闲检测后批量写入 SQLite。
//!
//! 数据流：Collector 轮询 → RawEvent → Merger（去抖动+空闲检测）→ MergedEvent → Storage（批量写入）
//! 暂停状态通过共享 Arc<AtomicBool> 暴露，供 Tauri 命令切换。

pub mod macos;

use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use tokio::sync::watch;

use crate::merger::{Merger, RawEvent, RuntimeEvent};
use crate::storage::Storage;

pub type SharedRuntimeEvents = Arc<Mutex<Vec<RuntimeEvent>>>;

enum PollResult {
    Tracked(RawEvent),
    Excluded(i64),
    Unavailable,
}

pub struct Collector {
    interval_secs: u64,
    /// 黑名单 bundle_id 列表（从 SQLite 加载，定期刷新）
    blacklist: Vec<String>,
    merger: Merger,
    storage: Storage,
    flush_interval_secs: u64,
    /// 黑名单刷新间隔（秒）
    blacklist_refresh_secs: u64,
    pause_rx: watch::Receiver<bool>,
    shutdown_rx: watch::Receiver<bool>,
    shutdown_done: mpsc::SyncSender<()>,
    runtime_events: SharedRuntimeEvents,
}

impl Collector {
    pub fn new(
        storage: Storage,
        pause_rx: watch::Receiver<bool>,
        shutdown_rx: watch::Receiver<bool>,
        shutdown_done: mpsc::SyncSender<()>,
        runtime_events: SharedRuntimeEvents,
    ) -> Self {
        Self {
            interval_secs: 3,
            blacklist: Vec::new(),
            merger: Merger::new(),
            storage,
            flush_interval_secs: 10,
            blacklist_refresh_secs: 30,
            pause_rx,
            shutdown_rx,
            shutdown_done,
            runtime_events,
        }
    }

    /// 从 SQLite 加载黑名单
    fn reload_blacklist(&mut self) {
        match self.storage.get_blacklist() {
            Ok(rows) => {
                self.blacklist = rows.iter().map(|r| r.bundle_id.clone()).collect();
                info!("[collector] 黑名单已加载: {} 项", self.blacklist.len());
            }
            Err(e) => warn!("[collector] 加载黑名单失败: {}", e),
        }
    }

    /// 启动采集循环。在 tauri 的异步运行时（tokio）上跑。
    pub async fn run(mut self) {
        // 启动时从 SQLite 加载黑名单
        self.reload_blacklist();

        info!(
            "[collector] 采集模块启动 | 轮询间隔={}s | flush 间隔={}s | 黑名单={} 项",
            self.interval_secs,
            self.flush_interval_secs,
            self.blacklist.len()
        );

        let trusted = macos::check_accessibility_trusted();
        info!(
            "[collector] Accessibility 权限: {}",
            if trusted {
                "已授权"
            } else {
                "未授权（窗口标题将采集不到，仅应用级可用）"
            }
        );

        let mut poll_ticker = tokio::time::interval(Duration::from_secs(self.interval_secs));
        let mut flush_ticker = tokio::time::interval(Duration::from_secs(self.flush_interval_secs));
        let mut blacklist_ticker =
            tokio::time::interval(Duration::from_secs(self.blacklist_refresh_secs));

        loop {
            tokio::select! {
                _ = poll_ticker.tick() => {
                    if *self.pause_rx.borrow() {
                        continue;
                    }
                    match self.poll_once() {
                        PollResult::Tracked(raw) => {
                            let idle_secs = macos::get_system_idle_secs();
                            let display_asleep = macos::is_display_asleep();
                            self.merger.on_event(&raw, idle_secs, display_asleep);
                        }
                        PollResult::Excluded(ts) => {
                            self.merger.force_boundary(ts);
                        }
                        PollResult::Unavailable => {}
                    }
                    self.publish_runtime(now_secs());
                }
                _ = flush_ticker.tick() => {
                    self.flush_completed();
                }
                changed = self.pause_rx.changed() => {
                    if changed.is_ok() && *self.pause_rx.borrow() {
                        self.merger.force_boundary(now_secs());
                        self.publish_runtime(now_secs());
                        self.flush_completed();
                    }
                }
                changed = self.shutdown_rx.changed() => {
                    if changed.is_err() || *self.shutdown_rx.borrow() {
                        self.merger.flush_remaining(now_secs());
                        self.publish_runtime(now_secs());
                        self.flush_completed();
                        let _ = self.shutdown_done.send(());
                        info!("[collector] 采集模块已停止，剩余事件已 flush");
                        break;
                    }
                }
                _ = blacklist_ticker.tick() => {
                    // 定期重新加载黑名单，使设置页的增删实时生效
                    self.reload_blacklist();
                }
            }
        }
    }

    fn publish_runtime(&self, now_ts: i64) {
        let snapshot = self.merger.runtime_events(now_ts);
        match self.runtime_events.lock() {
            Ok(mut shared) => *shared = snapshot,
            Err(e) => warn!("[collector] 更新运行态快照失败: {}", e),
        }
    }

    fn flush_completed(&mut self) {
        let events = self.merger.drain_completed();
        if events.is_empty() {
            self.publish_runtime(now_secs());
            return;
        }

        match self.storage.insert_events(&events) {
            Ok(n) => info!("[storage] 批量写入 {} 条事件", n),
            Err(e) => {
                warn!("[storage] 写入失败: {}", e);
                self.merger.restore_completed(events);
            }
        }
        self.publish_runtime(now_secs());
    }

    /// 轮询一次：返回可记录事件、黑名单边界或读取失败。
    fn poll_once(&self) -> PollResult {
        match macos::get_active_app() {
            Some(app) => {
                if self.blacklist.iter().any(|b| b == &app.bundle_id) {
                    info!(
                        "[collector] (黑名单过滤) app={} bundle={}",
                        app.app_name, app.bundle_id
                    );
                    return PollResult::Excluded(now_secs());
                }
                let ts = now_secs();
                PollResult::Tracked(RawEvent {
                    ts,
                    app: app.app_name,
                    bundle_id: app.bundle_id,
                    pid: app.pid,
                    window_title: app.window_title,
                })
            }
            None => {
                warn!("[collector] 读取活跃应用失败");
                PollResult::Unavailable
            }
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
