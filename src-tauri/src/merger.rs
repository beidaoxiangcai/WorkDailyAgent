//! 合并引擎：将采集模块每 3 秒产出的 RawEvent 合并为带时长的 MergedEvent。
//!
//! 核心逻辑：
//! - **累加**：app + title 相同 → 更新 end_ts，不产生新事件
//! - **闭合**：app / title 变化 → 闭合上一条，开启新事件
//! - **去抖动**：A→B→A 在 3 秒内 → 合并为一条 A（忽略 B 抖动）
//! - **空闲检测**：显示器休眠 → 闭合当前事件，标记离开；恢复时生成"(空闲)"事件
//!
//! 输出：MergedEvent（闭合事件），由 storage 批量写入 SQLite。

use log::info;

/// 采集原始事件（每 3 秒一条）
pub struct RawEvent {
    pub ts: i64, // Unix 时间戳（秒）
    pub app: String,
    pub bundle_id: String,
    #[allow(dead_code)]
    pub pid: i32,
    pub window_title: Option<String>,
}

/// 合并后事件（闭合，含时长）
pub struct MergedEvent {
    pub app: String,
    pub bundle_id: String,
    pub window_title: Option<String>,
    pub start_ts: i64,
    pub end_ts: i64,
    pub duration_ms: i64,
}

/// 正在跟踪的活跃事件
struct ActiveEvent {
    app: String,
    bundle_id: String,
    title: Option<String>,
    start_ts: i64,
    last_ts: i64,
}

impl ActiveEvent {
    fn close(&self) -> MergedEvent {
        MergedEvent {
            app: self.app.clone(),
            bundle_id: self.bundle_id.clone(),
            window_title: self.title.clone(),
            start_ts: self.start_ts,
            end_ts: self.last_ts,
            duration_ms: (self.last_ts - self.start_ts) * 1000,
        }
    }
}

pub struct Merger {
    /// 当前活跃事件
    current: Option<ActiveEvent>,
    /// 上一个事件（暂存，用于去抖动判定 A→B→A）
    prev: Option<ActiveEvent>,
    /// 已闭合、待 flush 的事件缓冲
    completed: Vec<MergedEvent>,
    /// 是否处于空闲状态
    is_idle: bool,
    /// 空闲开始时间戳（最后一次实际活动时间）
    idle_start_ts: Option<i64>,
    /// 去抖动阈值（秒）：A→B→A 间隔 ≤ 此值则合并
    debounce_secs: i64,
}

impl Merger {
    pub fn new() -> Self {
        Self {
            current: None,
            prev: None,
            completed: Vec::new(),
            is_idle: false,
            idle_start_ts: None,
            debounce_secs: 3,
        }
    }

    /// 处理一条 RawEvent。
    /// `idle_secs` 为系统空闲时间（秒），用于计算最后一次实际活动时间。
    /// `display_asleep` 为显示器是否休眠（true = 用户离开）。
    pub fn on_event(&mut self, raw: &RawEvent, idle_secs: f64, display_asleep: bool) {
        // ── 空闲检测：显示器休眠 = 真正离开（看视频时浏览器阻止休眠，不会误判）──
        if display_asleep {
            if !self.is_idle {
                self.enter_idle(raw.ts, idle_secs);
            }
            return;
        }

        // 从空闲恢复：生成"(空闲)"事件，开始新事件
        if self.is_idle {
            self.is_idle = false;
            let idle_end = raw.ts;
            if let Some(start) = self.idle_start_ts.take() {
                if idle_end > start {
                    let duration_ms = (idle_end - start) * 1000;
                    info!(
                        "[merger] 空闲结束: {}s，生成空闲事件",
                        duration_ms / 1000
                    );
                    self.completed.push(MergedEvent {
                        app: "(空闲)".to_string(),
                        bundle_id: String::new(),
                        window_title: Some("系统空闲".to_string()),
                        start_ts: start,
                        end_ts: idle_end,
                        duration_ms,
                    });
                }
            }
            info!("[merger] 用户恢复活动，开始新事件");
            self.start_new(raw);
            return;
        }

        // ── 同一应用+标题：累加时长 ──
        if let Some(ref cur) = self.current {
            if cur.app == raw.app && cur.title == raw.window_title {
                self.current.as_mut().unwrap().last_ts = raw.ts;
                // 去抖动窗口已过，确认 prev 为真实事件并闭合
                if self.prev.is_some() {
                    let cur_start = self.current.as_ref().unwrap().start_ts;
                    if raw.ts - cur_start > self.debounce_secs {
                        self.close_prev();
                    }
                }
                return;
            }
        }

        // ── 无当前事件：开启第一条 ──
        if self.current.is_none() {
            self.start_new(raw);
            return;
        }

        // ── 应用切换：检查去抖动 A→B→A ──
        if let Some(ref prev) = self.prev {
            if prev.app == raw.app && prev.title == raw.window_title {
                let cur_start = self.current.as_ref().unwrap().start_ts;
                let cur_duration = raw.ts - cur_start;
                if cur_duration <= self.debounce_secs {
                    // B 是抖动，丢弃 B，恢复 A
                    info!(
                        "[merger] 去抖动合并: {} → {} → {} ({}s ≤ {}s)，合并为一条 {}",
                        prev.app,
                        self.current.as_ref().unwrap().app,
                        raw.app,
                        cur_duration,
                        self.debounce_secs,
                        raw.app
                    );
                    self.current = Some(ActiveEvent {
                        app: prev.app.clone(),
                        bundle_id: prev.bundle_id.clone(),
                        title: prev.title.clone(),
                        start_ts: prev.start_ts,
                        last_ts: raw.ts,
                    });
                    self.prev = None;
                    return;
                }
            }
        }

        // ── 正常切换：闭合 prev（如有），当前移入 prev，开启新事件 ──
        if self.prev.is_some() {
            self.close_prev();
        }
        let mut old = self.current.take().unwrap();
        old.last_ts = raw.ts; // 当前事件在切换时刻结束
        self.prev = Some(old);
        self.start_new(raw);
    }

    /// 取出所有已闭合事件（供 storage 批量写入）
    pub fn drain_completed(&mut self) -> Vec<MergedEvent> {
        std::mem::take(&mut self.completed)
    }

    /// 闭合所有未完成事件（用于退出时 flush）
    #[allow(dead_code)]
    pub fn flush_remaining(&mut self) {
        if let Some(p) = self.prev.take() {
            self.completed.push(p.close());
        }
        if let Some(c) = self.current.take() {
            self.completed.push(c.close());
        }
    }

    fn start_new(&mut self, raw: &RawEvent) {
        self.current = Some(ActiveEvent {
            app: raw.app.clone(),
            bundle_id: raw.bundle_id.clone(),
            title: raw.window_title.clone(),
            start_ts: raw.ts,
            last_ts: raw.ts,
        });
    }

    fn close_prev(&mut self) {
        if let Some(p) = self.prev.take() {
            let event = p.close();
            info!(
                "[merger] 事件闭合: app={} | title={} | start={} | end={} | duration={}s",
                event.app,
                event.window_title.as_deref().unwrap_or("(空)"),
                event.start_ts,
                event.end_ts,
                event.duration_ms / 1000
            );
            self.completed.push(event);
        }
    }

    fn enter_idle(&mut self, now: i64, idle_secs: f64) {
        self.is_idle = true;
        // 最后一次实际活动时间 = 当前时间 - 空闲时长
        let last_activity = (now - idle_secs as i64).max(0);
        self.idle_start_ts = Some(last_activity);

        // 闭合当前事件，end_ts 修正为最后一次实际活动时间
        if let Some(cur) = self.current.take() {
            let end_ts = last_activity.max(cur.start_ts);
            let mut event = cur.close();
            event.end_ts = end_ts;
            event.duration_ms = (end_ts - event.start_ts) * 1000;
            info!(
                "[merger] 空闲检测: 显示器休眠，闭合事件 app={} | duration={}s",
                event.app,
                event.duration_ms / 1000
            );
            if event.duration_ms > 0 {
                self.completed.push(event);
            }
        }
        // prev 中暂存的事件也一并闭合
        if let Some(p) = self.prev.take() {
            self.completed.push(p.close());
        }
    }
}
