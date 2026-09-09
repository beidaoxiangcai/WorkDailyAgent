//! 为本机 CLI 提供最小的数据桥接。
//!
//! 仅监听当前用户应用数据目录中的 Unix Socket，不开放 TCP 端口。

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::collector::SharedRuntimeEvents;
use crate::storage::Storage;
use crate::{parse_day_range, query_day_events, AppState};

const SOCKET_NAME: &str = "workdaily-agent.sock";
const MAX_REQUEST_BYTES: u64 = 1_100_000;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CliRequest {
    Ping,
    QueryEvents {
        date: String,
    },
    GetReports {
        report_type: String,
        date: Option<String>,
    },
    SaveReport {
        report_type: String,
        date: String,
        content: String,
        event_ids: Vec<i64>,
        llm_model: Option<String>,
    },
}

pub fn start(
    data_dir: &Path,
    db_path: PathBuf,
    runtime_events: SharedRuntimeEvents,
) -> Result<(), String> {
    let socket_path = data_dir.join(SOCKET_NAME);
    prepare_socket_path(&socket_path)?;
    let listener = UnixListener::bind(&socket_path)
        .map_err(|error| format!("创建 CLI Socket 失败: {error}"))?;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置 CLI Socket 权限失败: {error}"))?;

    std::thread::Builder::new()
        .name("workdaily-cli-bridge".to_string())
        .spawn(move || {
            let state = match Storage::open(&db_path) {
                Ok(storage) => AppState {
                    storage,
                    runtime_events,
                },
                Err(error) => {
                    log::warn!("[cli] 打开数据库失败: {error}");
                    return;
                }
            };

            for connection in listener.incoming() {
                match connection {
                    Ok(stream) => handle_connection(stream, &state),
                    Err(error) => log::warn!("[cli] 接收请求失败: {error}"),
                }
            }
        })
        .map_err(|error| format!("启动 CLI Socket 线程失败: {error}"))?;

    log::info!("[cli] 本机查询通道已启动: {}", socket_path.display());
    Ok(())
}

fn prepare_socket_path(socket_path: &Path) -> Result<(), String> {
    if !socket_path.exists() {
        return Ok(());
    }
    if UnixStream::connect(socket_path).is_ok() {
        return Err("CLI Socket 已被另一个 WorkDailyAgent 实例占用".to_string());
    }
    fs::remove_file(socket_path).map_err(|error| format!("移除失效 CLI Socket 失败: {error}"))
}

fn handle_connection(mut stream: UnixStream, state: &AppState) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let mut request_json = String::new();
    let read_result = Read::by_ref(&mut stream)
        .take(MAX_REQUEST_BYTES)
        .read_to_string(&mut request_json);
    if let Err(error) = read_result {
        write_response(&mut stream, Err(format!("读取请求失败: {error}")));
        return;
    }
    if request_json.trim().is_empty() {
        return;
    }

    let result = serde_json::from_str::<CliRequest>(&request_json)
        .map_err(|error| format!("无效请求: {error}"))
        .and_then(|request| handle_request(request, state));
    write_response(&mut stream, result);
}

fn handle_request(request: CliRequest, state: &AppState) -> Result<serde_json::Value, String> {
    match request {
        CliRequest::Ping => Ok(serde_json::json!({ "version": 1 })),
        CliRequest::QueryEvents { date } => {
            let (start_ts, end_ts) =
                parse_day_range(&date).ok_or_else(|| format!("无效日期: {date}"))?;
            let events = query_day_events(state, start_ts, end_ts)?;
            Ok(serde_json::json!({ "events": events }))
        }
        CliRequest::GetReports { report_type, date } => {
            validate_report_type(&report_type)?;
            if let Some(value) = date.as_deref() {
                parse_day_range(value).ok_or_else(|| format!("无效日期: {value}"))?;
            }
            let reports = state
                .storage
                .get_reports(&report_type, date.as_deref())
                .map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "reports": reports }))
        }
        CliRequest::SaveReport {
            report_type,
            date,
            content,
            event_ids,
            llm_model,
        } => {
            validate_report_type(&report_type)?;
            parse_day_range(&date).ok_or_else(|| format!("无效日期: {date}"))?;
            let content = content.trim();
            if content.is_empty() {
                return Err("日报内容不能为空".to_string());
            }
            if content.len() > 1_000_000 {
                return Err("日报内容不能超过 1 MB".to_string());
            }
            if llm_model.as_ref().is_some_and(|value| value.len() > 100) {
                return Err("生成来源不能超过 100 个字符".to_string());
            }
            let event_ids = event_ids
                .into_iter()
                .filter(|id| *id > 0)
                .collect::<Vec<_>>();
            let event_ids = serde_json::to_string(&event_ids).map_err(|error| error.to_string())?;
            let id = state
                .storage
                .save_report(
                    &report_type,
                    &date,
                    content,
                    &event_ids,
                    llm_model.as_deref(),
                )
                .map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "id": id }))
        }
    }
}

fn validate_report_type(report_type: &str) -> Result<(), String> {
    if matches!(report_type, "daily" | "weekly") {
        Ok(())
    } else {
        Err("报告类型只能是 daily 或 weekly".to_string())
    }
}

fn write_response(stream: &mut UnixStream, result: Result<serde_json::Value, String>) {
    let response = match result {
        Ok(data) => serde_json::json!({ "ok": true, "data": data }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    if let Ok(payload) = serde_json::to_vec(&response) {
        let _ = stream.write_all(&payload);
        let _ = stream.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_report_type() {
        assert!(validate_report_type("monthly").is_err());
        assert!(validate_report_type("daily").is_ok());
    }

    #[test]
    fn parses_supported_requests() {
        let request =
            serde_json::from_str::<CliRequest>(r#"{"action":"query_events","date":"2026-09-07"}"#);
        assert!(request.is_ok());
    }
}
