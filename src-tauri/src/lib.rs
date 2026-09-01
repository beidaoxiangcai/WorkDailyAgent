mod collector;
mod generator;
mod merger;
mod secret_store;
mod storage;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use tokio::sync::watch;

const API_KEY_NOT_CONFIGURED: &str = "API_KEY_NOT_CONFIGURED";

/// 共享暂停状态（前端通过命令切换）
struct PausedState {
    current: Arc<AtomicBool>,
    changes: watch::Sender<bool>,
}

/// 查询某天的事件。date 格式 "YYYY-MM-DD"（本地时间），返回该日 0 点 ~ 次日 0 点的事件。
#[tauri::command]
fn query_events(
    date: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<storage::EventRow>, String> {
    let (start_ts, end_ts) = parse_day_range(&date).ok_or_else(|| format!("无效日期: {}", date))?;
    query_day_events(&state, start_ts, end_ts)
}

/// 生成日报：查指定日期事件 → 组装 Prompt → 调 LLM（失败降级模板）→ 存 reports 表 → 返回内容
/// date 参数为 "YYYY-MM-DD"，不传则用今天
#[tauri::command]
async fn generate_daily_report(
    date: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let api_key = secret_store::resolve_api_key()?
        .ok_or_else(|| API_KEY_NOT_CONFIGURED.to_string())?
        .value;
    let target_date = date.unwrap_or_else(today_str);
    let (start_ts, end_ts) =
        parse_day_range(&target_date).ok_or_else(|| format!("无效日期: {}", target_date))?;

    // 查当日事件
    let events = query_day_events(&state, start_ts, end_ts)?;

    if events.is_empty() {
        return Err(format!(
            "{} 无采集事件，请先使用一段时间后再生成日报",
            target_date
        ));
    }

    // 生成日报内容
    let report = generator::generate_daily_report(&events, &api_key).await;

    // 存入 reports 表
    let event_ids = serde_json::to_string(
        &events
            .iter()
            .filter(|e| e.id > 0)
            .map(|e| e.id)
            .collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    state
        .storage
        .save_report(
            "daily",
            &target_date,
            &report.content,
            &event_ids,
            report.llm_model.as_deref(),
        )
        .map_err(|e| e.to_string())?;

    log::info!("[generator] 日报已保存，日期={}", target_date);
    Ok(report.content)
}

// ── DeepSeek API Key ──

#[tauri::command]
fn get_api_key_status() -> Result<secret_store::ApiKeyStatus, String> {
    secret_store::get_api_key_status()
}

#[tauri::command]
async fn save_and_verify_api_key(api_key: String) -> Result<secret_store::ApiKeyStatus, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("请输入 API Key".to_string());
    }

    generator::validate_api_key(api_key).await?;
    secret_store::save_api_key(api_key)?;
    secret_store::get_api_key_status()
}

#[tauri::command]
async fn delete_api_key() -> Result<secret_store::ApiKeyStatus, String> {
    secret_store::delete_api_key()?;
    log::info!("[settings] DeepSeek API Key 已从 Keychain 移除");
    secret_store::get_api_key_status()
}

/// 查询日报/周报列表。type="daily"|"weekly"，可选 date 筛选。
#[tauri::command]
fn get_reports(
    report_type: String,
    date: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<storage::ReportRow>, String> {
    state
        .storage
        .get_reports(&report_type, date.as_deref())
        .map_err(|e| e.to_string())
}

/// 设置采集暂停状态。paused=true 暂停，false 恢复。
#[tauri::command]
fn set_paused(paused: bool, paused_state: tauri::State<'_, PausedState>) {
    paused_state.current.store(paused, Ordering::Relaxed);
    paused_state.changes.send_replace(paused);
    log::info!(
        "[collector] 采集状态: {}",
        if paused { "已暂停" } else { "采集中" }
    );
}

/// 读取当前采集是否暂停
#[tauri::command]
fn is_paused(paused_state: tauri::State<'_, PausedState>) -> bool {
    paused_state.current.load(Ordering::Relaxed)
}

// ── 黑名单管理 ──

/// 查询全部黑名单
#[tauri::command]
fn get_blacklist(state: tauri::State<'_, AppState>) -> Result<Vec<storage::BlacklistRow>, String> {
    state.storage.get_blacklist().map_err(|e| e.to_string())
}

/// 添加黑名单项
#[tauri::command]
fn add_blacklist(
    bundle_id: String,
    app_name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state
        .storage
        .add_blacklist(&bundle_id, &app_name)
        .map_err(|e| e.to_string())
}

/// 删除黑名单项
#[tauri::command]
fn remove_blacklist(bundle_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state
        .storage
        .remove_blacklist(&bundle_id)
        .map_err(|e| e.to_string())
}

// ── 数据清空 ──

/// 清空所有采集事件和日报（blacklist 保留）
#[tauri::command]
fn clear_all_data(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.storage.clear_all_data().map_err(|e| e.to_string())
}

// ── Accessibility 权限 ──

/// 检测 Accessibility 权限状态
#[tauri::command]
fn check_accessibility() -> bool {
    collector::macos::check_accessibility_trusted()
}

/// 打开系统设置「辅助功能」页（deep link）
#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn()
        .map_err(|e| format!("打开系统设置失败: {}", e))?;
    Ok(())
}

// ── 当前活跃应用（供时间轴页"正在记录"展示） ──

/// 获取当前活跃应用名 + 窗口标题
#[tauri::command]
fn get_active_app_info() -> Option<ActiveAppInfo> {
    collector::macos::get_active_app().map(|app| ActiveAppInfo {
        app_name: app.app_name,
        window_title: app.window_title,
    })
}

#[derive(serde::Serialize)]
struct ActiveAppInfo {
    app_name: String,
    window_title: Option<String>,
}

/// 持有 Storage 供命令使用
struct AppState {
    storage: storage::Storage,
    runtime_events: collector::SharedRuntimeEvents,
}

fn query_day_events(
    state: &AppState,
    start_ts: i64,
    end_ts: i64,
) -> Result<Vec<storage::EventRow>, String> {
    let mut rows = state
        .storage
        .query_events(start_ts, end_ts)
        .map_err(|e| e.to_string())?;
    let now = now_secs();
    let runtime = state
        .runtime_events
        .lock()
        .map_err(|e| format!("读取运行态失败: {}", e))?
        .clone();
    merge_runtime_events(&mut rows, runtime, start_ts, end_ts, now);
    rows = normalize_idle_events(rows);

    rows.sort_by(|a, b| {
        b.start_ts
            .cmp(&a.start_ts)
            .then_with(|| b.end_ts.cmp(&a.end_ts))
    });
    Ok(rows)
}

fn normalize_idle_events(rows: Vec<storage::EventRow>) -> Vec<storage::EventRow> {
    let (mut idle_rows, mut regular_rows): (Vec<_>, Vec<_>) =
        rows.into_iter().partition(is_idle_row);
    if idle_rows.is_empty() {
        return regular_rows;
    }

    let occupied_ranges = merge_ranges(
        regular_rows
            .iter()
            .map(|row| (row.start_ts, row.end_ts))
            .collect(),
    );

    idle_rows.sort_by(|a, b| {
        a.start_ts
            .cmp(&b.start_ts)
            .then_with(|| a.end_ts.cmp(&b.end_ts))
    });
    let mut merged_idle: Vec<storage::EventRow> = Vec::new();
    for row in idle_rows {
        if let Some(previous) = merged_idle.last_mut() {
            if row.start_ts <= previous.end_ts {
                previous.end_ts = previous.end_ts.max(row.end_ts);
                previous.duration_ms = (previous.end_ts - previous.start_ts) * 1000;
                previous.ongoing |= row.ongoing;
                if previous.id <= 0 && row.id > 0 {
                    previous.id = row.id;
                }
                continue;
            }
        }
        merged_idle.push(row);
    }

    for idle in merged_idle {
        for (start_ts, end_ts) in subtract_ranges(idle.start_ts, idle.end_ts, &occupied_ranges) {
            regular_rows.push(storage::EventRow {
                id: idle.id,
                start_ts,
                end_ts,
                app: idle.app.clone(),
                bundle_id: idle.bundle_id.clone(),
                window_title: idle.window_title.clone(),
                duration_ms: (end_ts - start_ts) * 1000,
                ongoing: idle.ongoing && end_ts == idle.end_ts,
            });
        }
    }

    regular_rows
}

fn is_idle_row(row: &storage::EventRow) -> bool {
    row.app == "(空闲)" || (row.bundle_id.is_empty() && row.app == "系统空闲")
}

fn merge_ranges(mut ranges: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    ranges.retain(|(start, end)| end > start);
    ranges.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in ranges {
        if let Some(previous) = merged.last_mut() {
            if start <= previous.1 {
                previous.1 = previous.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

fn subtract_ranges(start_ts: i64, end_ts: i64, occupied: &[(i64, i64)]) -> Vec<(i64, i64)> {
    let mut cursor = start_ts;
    let mut remaining = Vec::new();
    for &(occupied_start, occupied_end) in occupied {
        if occupied_end <= cursor {
            continue;
        }
        if occupied_start >= end_ts {
            break;
        }
        if occupied_start > cursor {
            remaining.push((cursor, occupied_start.min(end_ts)));
        }
        cursor = cursor.max(occupied_end);
        if cursor >= end_ts {
            return remaining;
        }
    }
    if cursor < end_ts {
        remaining.push((cursor, end_ts));
    }
    remaining
}

fn merge_runtime_events(
    rows: &mut Vec<storage::EventRow>,
    runtime: Vec<merger::RuntimeEvent>,
    start_ts: i64,
    end_ts: i64,
    now: i64,
) {
    let mut seen = rows.iter().map(event_key).collect::<HashSet<_>>();

    for (index, runtime_event) in runtime.into_iter().enumerate() {
        let event = runtime_event.event;
        let event_end = if runtime_event.ongoing {
            now.max(event.end_ts)
        } else {
            event.end_ts
        };
        if event.start_ts >= end_ts || event_end <= start_ts {
            continue;
        }

        let clipped_start = event.start_ts.max(start_ts);
        let clipped_end = event_end.min(end_ts);
        let row = storage::EventRow {
            id: -((index as i64) + 1),
            start_ts: clipped_start,
            end_ts: clipped_end,
            app: event.app,
            bundle_id: event.bundle_id,
            window_title: event.window_title,
            duration_ms: (clipped_end - clipped_start) * 1000,
            ongoing: runtime_event.ongoing,
        };
        if seen.insert(event_key(&row)) {
            rows.push(row);
        }
    }
}

type EventKey = (i64, i64, String, String, Option<String>);

fn event_key(event: &storage::EventRow) -> EventKey {
    (
        event.start_ts,
        event.end_ts,
        event.app.clone(),
        event.bundle_id.clone(),
        event.window_title.clone(),
    )
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 今天日期字符串 "YYYY-MM-DD"（本地时间，UTC+8）
fn today_str() -> String {
    let now = now_secs();
    let local = now + 8 * 3600; // UTC+8
    let days = local / 86400;
    let remainder = local % 86400;
    let _hour = remainder / 3600;

    // 反推日期
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Unix 天数 → 公历日期（Howard Hinnant civil_from_days）
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (y as i32 + if m <= 2 { 1 } else { 0 }, m, d)
}

/// 把 "YYYY-MM-DD"（本地时间 UTC+8）转为当天的 Unix 秒区间 [start, end)
fn parse_day_range(date: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let d: u32 = parts[2].parse().ok()?;
    let utc_start = days_from_civil(y, m, d) * 86400;
    let tz_offset = 8 * 3600; // UTC+8
    Some((utc_start - tz_offset, utc_start - tz_offset + 86400))
}

/// Howard Hinnant days_from_civil：公历日期 → Unix 天数（1970-01-01 起）
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as i64 + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era as i64 * 146097 + doe - 719468
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let paused = Arc::new(AtomicBool::new(false));
    let (pause_tx, pause_rx) = watch::channel(false);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (shutdown_done_tx, shutdown_done_rx) = mpsc::sync_channel(1);
    let runtime_events: collector::SharedRuntimeEvents = Arc::new(Mutex::new(Vec::new()));

    let app = tauri::Builder::default()
        .manage(PausedState {
            current: paused.clone(),
            changes: pause_tx,
        })
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 在 app data 目录打开 SQLite 数据库
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("workdaily.db");
            let storage = storage::Storage::open(&db_path)?;
            log::info!("[storage] 数据库已打开: {}", db_path.display());

            // 首次启动时填充默认黑名单（blacklist 表为空才插入）
            seed_default_blacklist(&storage);

            // Storage 注册为 Tauri 状态供命令使用
            app.manage(AppState {
                storage,
                runtime_events: runtime_events.clone(),
            });

            // 启动采集后台任务（tokio 运行时由 tauri 管理）
            tauri::async_runtime::spawn(async move {
                collector::Collector::new(
                    storage::Storage::open(&db_path).expect("reopen db"),
                    pause_rx,
                    shutdown_rx,
                    shutdown_done_tx,
                    runtime_events,
                )
                .run()
                .await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            query_events,
            set_paused,
            is_paused,
            generate_daily_report,
            get_api_key_status,
            save_and_verify_api_key,
            delete_api_key,
            get_reports,
            get_blacklist,
            add_blacklist,
            remove_blacklist,
            clear_all_data,
            check_accessibility,
            open_accessibility_settings,
            get_active_app_info
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    let shutdown_started = Arc::new(AtomicBool::new(false));
    let mut shutdown_done_rx = Some(shutdown_done_rx);
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !shutdown_started.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let _ = shutdown_tx.send(true);
                if let Some(done_rx) = shutdown_done_rx.take() {
                    let app_handle = app_handle.clone();
                    std::thread::spawn(move || {
                        if done_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                            log::warn!("[collector] 退出 flush 超时，继续退出");
                        }
                        app_handle.exit(0);
                    });
                }
            }
        }
    });
}

/// 首次启动时填充默认黑名单（表为空才插入）
fn seed_default_blacklist(storage: &storage::Storage) {
    if let Ok(existing) = storage.get_blacklist() {
        if !existing.is_empty() {
            return; // 已有数据，不重复填充
        }
    }
    let defaults = [
        ("com.agilebits.onepassword-osx", "1Password"),
        ("com.apple.keychainaccess", "钥匙串访问"),
        ("com.apple.SecurityAgent", "系统安全代理"),
    ];
    for (bundle_id, app_name) in &defaults {
        let _ = storage.add_blacklist(bundle_id, app_name);
    }
    log::info!("[storage] 已填充默认黑名单 {} 项", defaults.len());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::merger::{MergedEvent, RuntimeEvent};

    fn row(id: i64, start_ts: i64, end_ts: i64) -> storage::EventRow {
        storage::EventRow {
            id,
            start_ts,
            end_ts,
            app: "Editor".to_string(),
            bundle_id: "com.test.editor".to_string(),
            window_title: Some("file".to_string()),
            duration_ms: (end_ts - start_ts) * 1000,
            ongoing: false,
        }
    }

    fn idle_row(id: i64, start_ts: i64, end_ts: i64) -> storage::EventRow {
        storage::EventRow {
            id,
            start_ts,
            end_ts,
            app: "(空闲)".to_string(),
            bundle_id: String::new(),
            window_title: Some("系统空闲".to_string()),
            duration_ms: (end_ts - start_ts) * 1000,
            ongoing: false,
        }
    }

    fn runtime(start_ts: i64, end_ts: i64, ongoing: bool) -> RuntimeEvent {
        RuntimeEvent {
            event: MergedEvent {
                app: "Editor".to_string(),
                bundle_id: "com.test.editor".to_string(),
                window_title: Some("file".to_string()),
                start_ts,
                end_ts,
                duration_ms: (end_ts - start_ts) * 1000,
            },
            ongoing,
        }
    }

    #[test]
    fn runtime_merge_deduplicates_pending_database_event() {
        let mut rows = vec![row(1, 100, 110)];
        merge_runtime_events(&mut rows, vec![runtime(100, 110, false)], 100, 200, 150);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, 1);
    }

    #[test]
    fn runtime_merge_extends_and_clips_ongoing_event() {
        let mut rows = Vec::new();
        merge_runtime_events(&mut rows, vec![runtime(90, 120, true)], 100, 200, 150);

        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].start_ts, rows[0].end_ts), (100, 150));
        assert_eq!(rows[0].duration_ms, 50_000);
        assert!(rows[0].ongoing);
    }

    #[test]
    fn runtime_merge_includes_previous_day_part_of_ongoing_event() {
        let mut rows = Vec::new();
        merge_runtime_events(&mut rows, vec![runtime(90, 120, true)], 0, 100, 150);

        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].start_ts, rows[0].end_ts), (90, 100));
        assert_eq!(rows[0].duration_ms, 10_000);
    }

    #[test]
    fn idle_normalization_merges_history_and_excludes_regular_events() {
        let rows = vec![
            idle_row(1, 0, 100),
            idle_row(2, 0, 200),
            idle_row(3, 150, 250),
            row(4, 160, 180),
        ];

        let mut normalized = normalize_idle_events(rows);
        normalized.sort_by_key(|event| event.start_ts);

        assert_eq!(
            normalized
                .iter()
                .map(|event| (event.app.as_str(), event.start_ts, event.end_ts))
                .collect::<Vec<_>>(),
            vec![
                ("(空闲)", 0, 160),
                ("Editor", 160, 180),
                ("(空闲)", 180, 250),
            ]
        );
        assert_eq!(
            normalized
                .iter()
                .filter(|event| event.app == "(空闲)")
                .map(|event| event.duration_ms)
                .sum::<i64>(),
            230_000
        );
    }

    #[test]
    fn idle_normalization_merges_adjacent_ranges() {
        let normalized = normalize_idle_events(vec![idle_row(1, 100, 150), idle_row(2, 150, 200)]);

        assert_eq!(normalized.len(), 1);
        assert_eq!((normalized[0].start_ts, normalized[0].end_ts), (100, 200));
        assert_eq!(normalized[0].duration_ms, 100_000);
    }
}
