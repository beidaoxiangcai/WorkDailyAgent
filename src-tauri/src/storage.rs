//! 存储层：SQLite（rusqlite）事件持久化。
//!
//! - WAL 模式：支持并发读 + 高频写无阻塞
//! - 批量写入：由调用方攒满后一次 flush，减少 IO
//! - 表结构：events（采集事件）、blacklist（黑名单）、reports（日报/周报）

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::merger::MergedEvent;

/// 查询返回的事件（供前端展示）
#[derive(Debug, serde::Serialize)]
pub struct EventRow {
    pub id: i64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub app: String,
    pub bundle_id: String,
    pub window_title: Option<String>,
    pub duration_ms: i64,
}

/// 查询返回的日报/周报（供前端展示）
#[derive(Debug, serde::Serialize)]
pub struct ReportRow {
    pub id: i64,
    #[serde(rename = "type")]
    pub report_type: String,
    pub period_date: String,
    pub generated_at: i64,
    pub content: String,
    pub llm_model: Option<String>,
}

/// 查询返回的黑名单项（供前端展示）
#[derive(Debug, serde::Serialize)]
pub struct BlacklistRow {
    pub id: i64,
    pub bundle_id: String,
    pub app_name: String,
    pub created_at: i64,
}

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

            CREATE TABLE IF NOT EXISTS reports (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                type         TEXT    NOT NULL,
                period_date  TEXT    NOT NULL,
                generated_at INTEGER NOT NULL,
                content      TEXT    NOT NULL,
                event_ids    TEXT,
                llm_model    TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_reports_type_date ON reports(type, period_date);
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

    /// 查询某天 [start, end) 时间范围内的事件，按开始时间倒序返回。
    /// `start_ts` / `end_ts` 为 Unix 秒（本地 0 点 ~ 次日 0 点）。
    pub fn query_events(&self, start_ts: i64, end_ts: i64) -> rusqlite::Result<Vec<EventRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, start_ts, end_ts, app, bundle_id, window_title, duration_ms
             FROM events
             WHERE start_ts >= ?1 AND start_ts < ?2
             ORDER BY start_ts DESC",
        )?;
        let rows = stmt.query_map(params![start_ts, end_ts], |row| {
            Ok(EventRow {
                id: row.get(0)?,
                start_ts: row.get(1)?,
                end_ts: row.get(2)?,
                app: row.get(3)?,
                bundle_id: row.get(4)?,
                window_title: row.get(5)?,
                duration_ms: row.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// 保存生成的日报/周报
    pub fn save_report(
        &self,
        report_type: &str,
        period_date: &str,
        content: &str,
        event_ids: &str,
        llm_model: Option<&str>,
    ) -> rusqlite::Result<i64> {
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reports (type, period_date, generated_at, content, event_ids, llm_model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![report_type, period_date, now, content, event_ids, llm_model],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 查询某类型的报告，按生成时间倒序。可选按 period_date 筛选。
    pub fn get_reports(
        &self,
        report_type: &str,
        period_date: Option<&str>,
    ) -> rusqlite::Result<Vec<ReportRow>> {
        let conn = self.conn.lock().unwrap();
        let sql = if period_date.is_some() {
            "SELECT id, type, period_date, generated_at, content, llm_model
             FROM reports WHERE type = ?1 AND period_date = ?2
             ORDER BY generated_at DESC"
        } else {
            "SELECT id, type, period_date, generated_at, content, llm_model
             FROM reports WHERE type = ?1
             ORDER BY generated_at DESC"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = if let Some(date) = period_date {
            stmt.query_map(params![report_type, date], map_report_row)?.collect()
        } else {
            stmt.query_map(params![report_type], map_report_row)?.collect()
        };
        rows
    }

    /// 查询全部黑名单
    pub fn get_blacklist(&self) -> rusqlite::Result<Vec<BlacklistRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, bundle_id, app_name, created_at FROM blacklist ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(BlacklistRow {
                id: row.get(0)?,
                bundle_id: row.get(1)?,
                app_name: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// 添加黑名单项（bundle_id 唯一，重复时忽略）
    pub fn add_blacklist(&self, bundle_id: &str, app_name: &str) -> rusqlite::Result<()> {
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO blacklist (bundle_id, app_name, created_at) VALUES (?1, ?2, ?3)",
            params![bundle_id, app_name, now],
        )?;
        Ok(())
    }

    /// 删除黑名单项
    pub fn remove_blacklist(&self, bundle_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM blacklist WHERE bundle_id = ?1", params![bundle_id])?;
        Ok(())
    }

    /// 清空所有数据（events + reports），blacklist 保留
    pub fn clear_all_data(&self) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM events", [])?;
        tx.execute("DELETE FROM reports", [])?;
        tx.commit()?;
        Ok(())
    }
}

fn map_report_row(row: &rusqlite::Row) -> rusqlite::Result<ReportRow> {
    Ok(ReportRow {
        id: row.get(0)?,
        report_type: row.get(1)?,
        period_date: row.get(2)?,
        generated_at: row.get(3)?,
        content: row.get(4)?,
        llm_model: row.get(5)?,
    })
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
