mod collector;
mod generator;
mod merger;
mod storage;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Manager;

/// 共享暂停状态（前端通过命令切换）
struct PausedState(Arc<AtomicBool>);

/// 查询某天的事件。date 格式 "YYYY-MM-DD"（本地时间），返回该日 0 点 ~ 次日 0 点的事件。
#[tauri::command]
fn query_events(date: String, state: tauri::State<'_, AppState>) -> Result<Vec<storage::EventRow>, String> {
    let (start_ts, end_ts) = parse_day_range(&date).ok_or_else(|| format!("无效日期: {}", date))?;
    state.storage.query_events(start_ts, end_ts).map_err(|e| e.to_string())
}

/// 生成日报：查指定日期事件 → 组装 Prompt → 调 LLM（失败降级模板）→ 存 reports 表 → 返回内容
/// date 参数为 "YYYY-MM-DD"，不传则用今天
#[tauri::command]
async fn generate_daily_report(date: Option<String>, state: tauri::State<'_, AppState>) -> Result<String, String> {
    let target_date = date.unwrap_or_else(today_str);
    let (start_ts, end_ts) = parse_day_range(&target_date)
        .ok_or_else(|| format!("无效日期: {}", target_date))?;

    // 查当日事件
    let events = state
        .storage
        .query_events(start_ts, end_ts)
        .map_err(|e| e.to_string())?;

    if events.is_empty() {
        return Err(format!("{} 无采集事件，请先使用一段时间后再生成日报", target_date));
    }

    // 生成日报内容
    let report = generator::generate_daily_report(&events).await;

    // 存入 reports 表
    let event_ids = serde_json::to_string(
        &events.iter().map(|e| e.id).collect::<Vec<_>>(),
    )
    .unwrap_or_else(|_| "[]".to_string());

    state
        .storage
        .save_report("daily", &target_date, &report.content, &event_ids, report.llm_model.as_deref())
        .map_err(|e| e.to_string())?;

    log::info!("[generator] 日报已保存，日期={}", target_date);
    Ok(report.content)
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
    paused_state.0.store(paused, Ordering::Relaxed);
    log::info!("[collector] 采集状态: {}", if paused { "已暂停" } else { "采集中" });
}

/// 读取当前采集是否暂停
#[tauri::command]
fn is_paused(paused_state: tauri::State<'_, PausedState>) -> bool {
    paused_state.0.load(Ordering::Relaxed)
}

// ── 黑名单管理 ──

/// 查询全部黑名单
#[tauri::command]
fn get_blacklist(state: tauri::State<'_, AppState>) -> Result<Vec<storage::BlacklistRow>, String> {
    state.storage.get_blacklist().map_err(|e| e.to_string())
}

/// 添加黑名单项
#[tauri::command]
fn add_blacklist(bundle_id: String, app_name: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.storage.add_blacklist(&bundle_id, &app_name).map_err(|e| e.to_string())
}

/// 删除黑名单项
#[tauri::command]
fn remove_blacklist(bundle_id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.storage.remove_blacklist(&bundle_id).map_err(|e| e.to_string())
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
}

/// 今天日期字符串 "YYYY-MM-DD"（本地时间，UTC+8）
fn today_str() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
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

    tauri::Builder::default()
        .manage(PausedState(paused.clone()))
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
            app.manage(AppState { storage });

            // 启动采集后台任务（tokio 运行时由 tauri 管理）
            let paused_clone = paused.clone();
            tauri::async_runtime::spawn(async move {
                collector::Collector::new(
                    storage::Storage::open(&db_path).expect("reopen db"),
                    paused_clone,
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
            get_reports,
            get_blacklist,
            add_blacklist,
            remove_blacklist,
            clear_all_data,
            check_accessibility,
            open_accessibility_settings,
            get_active_app_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
