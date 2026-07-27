mod collector;
mod merger;
mod storage;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
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

            // 启动采集后台任务（tokio 运行时由 tauri 管理）
            tauri::async_runtime::spawn(async move {
                collector::Collector::new(storage).run().await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
