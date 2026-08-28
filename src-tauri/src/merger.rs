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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedEvent {
    pub app: String,
    pub bundle_id: String,
    pub window_title: Option<String>,
    pub start_ts: i64,
    pub end_ts: i64,
    pub duration_ms: i64,
}

/// 供查询层读取的未落库事件。
#[derive(Clone, Debug)]
pub struct RuntimeEvent {
    pub event: MergedEvent,
    pub ongoing: bool,
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
        self.close_at(self.last_ts)
    }

    fn close_at(&self, end_ts: i64) -> MergedEvent {
        let end_ts = end_ts.max(self.start_ts);
        MergedEvent {
            app: self.app.clone(),
            bundle_id: self.bundle_id.clone(),
            window_title: self.title.clone(),
            start_ts: self.start_ts,
            end_ts,
            duration_ms: (end_ts - self.start_ts) * 1000,
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
    /// 已处理到的时间水位，防止系统空闲时间回溯后重复生成历史区间。
    recorded_until_ts: i64,
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
            recorded_until_ts: 0,
            debounce_secs: 3,
        }
    }

    /// 使用存储层最后一条事件的结束时间初始化采集水位。
    pub fn initialize_recorded_until(&mut self, recorded_until_ts: i64) {
        self.recorded_until_ts = self.recorded_until_ts.max(recorded_until_ts);
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
                    info!("[merger] 空闲结束: {}s，生成空闲事件", duration_ms / 1000);
                    self.push_completed(idle_event(start, idle_end));
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

    /// 写入失败时将事件放回缓冲区，等待下次 flush。
    pub fn restore_completed(&mut self, mut events: Vec<MergedEvent>) {
        events.append(&mut self.completed);
        self.completed = events;
    }

    /// 暂停、进入黑名单或退出时在指定时刻强制闭合运行态。
    pub fn force_boundary(&mut self, at_ts: i64) {
        if let Some(p) = self.prev.take() {
            let event = p.close();
            self.push_completed(event);
        }
        if let Some(c) = self.current.take() {
            let event = c.close_at(at_ts);
            self.push_completed(event);
        }
        if self.is_idle {
            if let Some(start_ts) = self.idle_start_ts.take() {
                if at_ts > start_ts {
                    self.push_completed(idle_event(start_ts, at_ts));
                }
            }
            self.is_idle = false;
        }
        self.recorded_until_ts = self.recorded_until_ts.max(at_ts);
    }

    /// 闭合所有未完成事件（用于退出时 flush）。
    pub fn flush_remaining(&mut self, at_ts: i64) {
        self.force_boundary(at_ts);
    }

    /// 返回已闭合待写、去抖待确认和当前进行事件的快照。
    pub fn runtime_events(&self, now_ts: i64) -> Vec<RuntimeEvent> {
        let mut events = self
            .completed
            .iter()
            .cloned()
            .map(|event| RuntimeEvent {
                event,
                ongoing: false,
            })
            .collect::<Vec<_>>();

        if let Some(p) = &self.prev {
            events.push(RuntimeEvent {
                event: p.close(),
                ongoing: false,
            });
        }
        if let Some(c) = &self.current {
            events.push(RuntimeEvent {
                event: c.close_at(now_ts),
                ongoing: true,
            });
        }
        if self.is_idle {
            if let Some(start_ts) = self.idle_start_ts {
                if now_ts > start_ts {
                    events.push(RuntimeEvent {
                        event: idle_event(start_ts, now_ts),
                        ongoing: true,
                    });
                }
            }
        }

        events
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
            self.push_completed(event);
        }
    }

    fn enter_idle(&mut self, now: i64, idle_secs: f64) {
        self.is_idle = true;
        // 最后一次实际活动时间 = 当前时间 - 空闲时长
        let last_activity = (now - idle_secs as i64).clamp(0, now);

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
            self.push_completed(event);
        }
        // prev 中暂存的事件也一并闭合
        if let Some(p) = self.prev.take() {
            self.push_completed(p.close());
        }

        // 显示器可能在没有新 HID 输入时反复睡眠/唤醒，此时系统返回的
        // last_activity 不变。水位保证新的空闲区间不会回溯覆盖已记录数据。
        self.idle_start_ts = Some(last_activity.max(self.recorded_until_ts));
    }

    fn push_completed(&mut self, event: MergedEvent) {
        if event.duration_ms <= 0 || event.end_ts <= event.start_ts {
            return;
        }
        self.recorded_until_ts = self.recorded_until_ts.max(event.end_ts);
        self.completed.push(event);
    }
}

fn idle_event(start_ts: i64, end_ts: i64) -> MergedEvent {
    MergedEvent {
        app: "(空闲)".to_string(),
        bundle_id: String::new(),
        window_title: Some("系统空闲".to_string()),
        start_ts,
        end_ts,
        duration_ms: (end_ts - start_ts) * 1000,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(ts: i64, app: &str, title: &str) -> RawEvent {
        RawEvent {
            ts,
            app: app.to_string(),
            bundle_id: format!("com.test.{}", app.to_lowercase()),
            pid: 1,
            window_title: Some(title.to_string()),
        }
    }

    #[test]
    fn force_boundary_closes_current_at_requested_time() {
        let mut merger = Merger::new();
        merger.on_event(&raw(100, "Editor", "file"), 0.0, false);
        merger.on_event(&raw(103, "Editor", "file"), 0.0, false);

        merger.force_boundary(110);

        let completed = merger.drain_completed();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].start_ts, 100);
        assert_eq!(completed[0].end_ts, 110);
        assert_eq!(completed[0].duration_ms, 10_000);
        assert!(merger.runtime_events(120).is_empty());
    }

    #[test]
    fn force_boundary_prevents_debounce_across_gap() {
        let mut merger = Merger::new();
        merger.on_event(&raw(100, "Editor", "file"), 0.0, false);
        merger.force_boundary(105);
        merger.on_event(&raw(108, "Editor", "file"), 0.0, false);
        merger.flush_remaining(112);

        let completed = merger.drain_completed();
        assert_eq!(completed.len(), 2);
        assert_eq!((completed[0].start_ts, completed[0].end_ts), (100, 105));
        assert_eq!((completed[1].start_ts, completed[1].end_ts), (108, 112));
    }

    #[test]
    fn runtime_snapshot_contains_pending_and_ongoing_events() {
        let mut merger = Merger::new();
        merger.on_event(&raw(100, "Editor", "file"), 0.0, false);
        merger.on_event(&raw(110, "Browser", "page"), 0.0, false);

        let snapshot = merger.runtime_events(115);
        assert_eq!(snapshot.len(), 2);
        assert!(!snapshot[0].ongoing);
        assert_eq!(
            (snapshot[0].event.start_ts, snapshot[0].event.end_ts),
            (100, 110)
        );
        assert!(snapshot[1].ongoing);
        assert_eq!(
            (snapshot[1].event.start_ts, snapshot[1].event.end_ts),
            (110, 115)
        );
    }

    #[test]
    fn flush_remaining_closes_current_at_exit_time() {
        let mut merger = Merger::new();
        merger.on_event(&raw(100, "Editor", "file"), 0.0, false);

        merger.flush_remaining(109);

        let completed = merger.drain_completed();
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].end_ts, 109);
        assert_eq!(completed[0].duration_ms, 9_000);
    }

    #[test]
    fn repeated_sleep_without_new_input_does_not_repeat_idle_history() {
        let mut merger = Merger::new();
        merger.on_event(&raw(100, "Editor", "file"), 0.0, false);

        merger.on_event(&raw(200, "loginwindow", "login"), 100.0, true);
        merger.on_event(&raw(300, "loginwindow", "login"), 200.0, false);
        merger.on_event(&raw(310, "loginwindow", "login"), 210.0, true);
        merger.on_event(&raw(400, "loginwindow", "login"), 300.0, false);

        let idle = merger
            .drain_completed()
            .into_iter()
            .filter(|event| event.app == "(空闲)")
            .collect::<Vec<_>>();
        assert_eq!(idle.len(), 2);
        assert_eq!((idle[0].start_ts, idle[0].end_ts), (100, 300));
        assert_eq!((idle[1].start_ts, idle[1].end_ts), (300, 400));
    }

    #[test]
    fn restored_watermark_prevents_idle_backfill_after_restart() {
        let mut merger = Merger::new();
        merger.initialize_recorded_until(250);

        merger.on_event(&raw(300, "loginwindow", "login"), 200.0, true);
        merger.on_event(&raw(400, "loginwindow", "login"), 300.0, false);

        let completed = merger.drain_completed();
        assert_eq!(completed.len(), 1);
        assert_eq!((completed[0].start_ts, completed[0].end_ts), (250, 400));
    }
}
