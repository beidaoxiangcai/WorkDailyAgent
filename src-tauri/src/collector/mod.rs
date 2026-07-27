//! 采集模块：3 秒轮询当前活跃应用 + 窗口标题，经合并引擎去抖动/空闲检测后批量写入 SQLite。
//!
//! 数据流：Collector 轮询 → RawEvent → Merger（去抖动+空闲检测）→ MergedEvent → Storage（批量写入）
//! 暂停状态通过共享 Arc<AtomicBool> 暴露，供 Tauri 命令切换。

pub mod macos;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};

use crate::merger::{Merger, RawEvent};
use crate::storage::Storage;

pub struct Collector {
    interval_secs: u64,
    /// 黑名单 bundle_id 列表（从 SQLite 加载，定期刷新）
    blacklist: Vec<String>,
    merger: Merger,
    storage: Storage,
    flush_interval_secs: u64,
    /// 黑名单刷新间隔（秒）
    blacklist_refresh_secs: u64,
    /// 共享暂停标志（true = 暂停）
    paused: Arc<AtomicBool>,
}

impl Collector {
    pub fn new(storage: Storage, paused: Arc<AtomicBool>) -> Self {
        Self {
            interval_secs: 3,
            blacklist: Vec::new(),
            merger: Merger::new(),
            storage,
            flush_interval_secs: 10,
            blacklist_refresh_secs: 30,
            paused,
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
        let mut blacklist_ticker = tokio::time::interval(Duration::from_secs(self.blacklist_refresh_secs));

        loop {
            tokio::select! {
                _ = poll_ticker.tick() => {
                    if self.paused.load(Ordering::Relaxed) {
                        continue;
                    }
                    if let Some(raw) = self.poll_once() {
                        let idle_secs = macos::get_system_idle_secs();
                        self.merger.on_event(&raw, idle_secs);
                    }
                }
                _ = flush_ticker.tick() => {
                    let events = self.merger.drain_completed();
                    if !events.is_empty() {
                        match self.storage.insert_events(&events) {
                            Ok(n) => info!("[storage] 批量写入 {} 条事件", n),
                            Err(e) => warn!("[storage] 写入失败: {}", e),
                        }
                    }
                }
                _ = blacklist_ticker.tick() => {
                    // 定期重新加载黑名单，使设置页的增删实时生效
                    self.reload_blacklist();
                }
            }
        }
    }

    /// 轮询一次：读取活跃应用，黑名单过滤，返回 RawEvent
    fn poll_once(&self) -> Option<RawEvent> {
        match macos::get_active_app() {
            Some(app) => {
                if self.blacklist.iter().any(|b| b == &app.bundle_id) {
                    info!(
                        "[collector] (黑名单过滤) app={} bundle={}",
                        app.app_name, app.bundle_id
                    );
                    return None;
                }
                let ts = now_secs();
                Some(RawEvent {
                    ts,
                    app: app.app_name,
                    bundle_id: app.bundle_id,
                    pid: app.pid,
                    window_title: app.window_title,
                })
            }
            None => {
                warn!("[collector] 读取活跃应用失败");
                None
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
