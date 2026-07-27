mod collector;
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

/// 持有 Storage 供命令使用
struct AppState {
    storage: storage::Storage,
}

/// 把 "YYYY-MM-DD"（本地时间）转为当天的 Unix 秒区间 [start, end)
fn parse_day_range(date: &str) -> Option<(i64, i64)> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let d: u32 = parts[2].parse().ok()?;
    // 用 chrono 风格手动算太繁；这里用 time crate 的 days_from_civil 算法（Howard Hinnant）
    let start = days_from_civil(y, m, d) * 86400;
    Some((start, start + 86400))
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

            // Storage 注册为 Tauri 状态供命令使用
            app.manage(AppState { storage });

            // 启动采集后台任务（tokio 运行时由 tauri 管理）
            let paused_clone = paused.clone();
            tauri::async_runtime::spawn(async move {
                collector::Collector::new(
                    // Collector 需要 Storage，但 AppState 也持有一份——这里用一个新连接
                    storage::Storage::open(&db_path).expect("reopen db"),
                    paused_clone,
                )
                .run()
                .await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![query_events, set_paused, is_paused])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
