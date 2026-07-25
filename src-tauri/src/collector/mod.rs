//! 采集模块：3 秒轮询当前活跃应用 + 窗口标题，做黑名单过滤后输出日志。
//!
//! S1 阶段仅采集并打印（验证 F1/F2），合并/入库/空闲检测在 S2 实现。

pub mod macos;

use std::time::Duration;

use log::{info, warn};

pub struct Collector {
    interval_secs: u64,
    /// S1: 硬编码黑名单 bundle_id（基础版）；S5 改为 SQLite 持久化 + 设置页管理
    blacklist: Vec<String>,
    paused: bool,
}

impl Collector {
    pub fn new() -> Self {
        // 默认黑名单：密码管理器 / 钥匙串等敏感应用，避免采集其标题
        let blacklist = vec![
            "com.agilebits.onepassword-osx".to_string(), // 1Password
            "com.apple.keychainaccess".to_string(),      // 钥匙串访问
            "com.apple.SecurityAgent".to_string(),       // 系统安全代理
        ];
        Self {
            interval_secs: 3,
            blacklist,
            paused: false,
        }
    }

    /// 启动采集循环。在 tauri 的异步运行时（tokio）上跑。
    pub async fn run(self) {
        info!(
            "[collector] 采集模块启动 | 轮询间隔={}s | 黑名单={} 项",
            self.interval_secs,
            self.blacklist.len()
        );

        // 首次启动打印 Accessibility 权限状态（S1 仅日志；S5 做引导 UI）
        let trusted = macos::check_accessibility_trusted();
        info!(
            "[collector] Accessibility 权限: {}",
            if trusted {
                "已授权"
            } else {
                "未授权（窗口标题将采集不到，仅应用级可用）"
            }
        );

        let mut ticker = tokio::time::interval(Duration::from_secs(self.interval_secs));
        // 首次 tick 立即触发，启动即打印一次
        loop {
            ticker.tick().await;
            if self.paused {
                continue;
            }
            self.poll_once();
        }
    }

    fn poll_once(&self) {
        match macos::get_active_app() {
            Some(app) => {
                // 黑名单过滤：bundle_id 命中则跳过，不采集
                if self.blacklist.iter().any(|b| b == &app.bundle_id) {
                    info!(
                        "[collector] (黑名单过滤) app={} bundle={}",
                        app.app_name, app.bundle_id
                    );
                    return;
                }
                info!(
                    "[collector] app={} | bundle={} | pid={} | title={}",
                    app.app_name,
                    app.bundle_id,
                    app.pid,
                    app.window_title.as_deref().unwrap_or("(空)")
                );
            }
            None => warn!("[collector] 读取活跃应用失败"),
        }
    }

    #[allow(dead_code)]
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
        info!("[collector] 采集状态: {}", if paused { "已暂停" } else { "采集中" });
    }
}
