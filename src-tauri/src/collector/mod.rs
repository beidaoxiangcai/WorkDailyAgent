//! 采集模块：3 秒轮询当前活跃应用 + 窗口标题，经合并引擎去抖动/空闲检测后批量写入 SQLite。
//!
//! 数据流：Collector 轮询 → RawEvent → Merger（去抖动+空闲检测）→ MergedEvent → Storage（批量写入）

pub mod macos;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};

use crate::merger::{Merger, RawEvent};
use crate::storage::Storage;

pub struct Collector {
    interval_secs: u64,
    /// S1: 硬编码黑名单 bundle_id（基础版）；S5 改为 SQLite 持久化 + 设置页管理
    blacklist: Vec<String>,
    merger: Merger,
    storage: Storage,
    flush_interval_secs: u64,
}

impl Collector {
    pub fn new(storage: Storage) -> Self {
        let blacklist = vec![
            "com.agilebits.onepassword-osx".to_string(), // 1Password
            "com.apple.keychainaccess".to_string(),      // 钥匙串访问
            "com.apple.SecurityAgent".to_string(),       // 系统安全代理
        ];
        Self {
            interval_secs: 3,
            blacklist,
            merger: Merger::new(),
            storage,
            flush_interval_secs: 10,
        }
    }

    /// 启动采集循环。在 tauri 的异步运行时（tokio）上跑。
    pub async fn run(mut self) {
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

        loop {
            tokio::select! {
                _ = poll_ticker.tick() => {
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
