//! 存储层：SQLite（rusqlite）事件持久化。
//!
//! - WAL 模式：支持并发读 + 高频写无阻塞
//! - 批量写入：由调用方攒满后一次 flush，减少 IO
//! - 表结构：events（采集事件）、blacklist（黑名单）

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::merger::MergedEvent;

pub struct Storage {
    conn: Mutex<Connection>,
}

impl Storage {
    /// 打开数据库并初始化表结构。首次运行自动建表。
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;

        // WAL 模式：并发读 + 高频写无阻塞
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                start_ts     INTEGER NOT NULL,
                end_ts       INTEGER NOT NULL,
                app          TEXT    NOT NULL,
                bundle_id    TEXT    NOT NULL,
                window_title TEXT,
                duration_ms  INTEGER NOT NULL,
                category     TEXT,
                source       TEXT    NOT NULL DEFAULT 'system',
                created_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_start_ts ON events(start_ts);

            CREATE TABLE IF NOT EXISTS blacklist (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id  TEXT    NOT NULL UNIQUE,
                app_name   TEXT    NOT NULL,
                created_at INTEGER NOT NULL
            );
            ",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 批量写入已闭合事件（事务包裹，失败整体回滚）
    pub fn insert_events(&self, events: &[MergedEvent]) -> rusqlite::Result<usize> {
        if events.is_empty() {
            return Ok(0);
        }
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut count = 0;
        for event in events {
            tx.execute(
                "INSERT INTO events
                    (start_ts, end_ts, app, bundle_id, window_title, duration_ms, source, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    event.start_ts,
                    event.end_ts,
                    event.app,
                    event.bundle_id,
                    event.window_title,
                    event.duration_ms,
                    "system",
                    now,
                ],
            )?;
            count += 1;
        }
        tx.commit()?;
        Ok(count)
    }

    /// 查询 WAL 模式状态（自测用）
    #[allow(dead_code)]
    pub fn journal_mode(&self) -> rusqlite::Result<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
