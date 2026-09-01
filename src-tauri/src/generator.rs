//! 日报生成模块：组装 Prompt → 调 DeepSeek API → 解析返回 → 失败降级模板填充。
//!
//! - API Key 由调用方从 Keychain 或环境变量解析后传入
//! - API 失败时，降级为规则模板（应用名 + 时长列表）
//! - 隐私：只传应用名 + 时长 + 窗口标题，不传原始文件内容

use log::{info, warn};

use crate::storage::EventRow;

const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";

/// 生成日报结果
pub struct GeneratedReport {
    pub content: String,
    pub llm_model: Option<String>,
}

/// 生成今日日报：事件列表 → 时间线文本 → LLM（或降级模板）
pub async fn generate_daily_report(events: &[EventRow], api_key: &str) -> GeneratedReport {
    if events.is_empty() {
        return GeneratedReport {
            content: "今日无采集事件，无法生成日报。".to_string(),
            llm_model: None,
        };
    }

    let timeline = build_timeline(events);

    // 尝试调 LLM
    match call_deepseek(&timeline, api_key).await {
        Ok(content) => {
            info!("[generator] LLM 日报生成成功，长度 {} 字", content.len());
            GeneratedReport {
                content,
                llm_model: Some(DEEPSEEK_MODEL.to_string()),
            }
        }
        Err(e) => {
            warn!("[generator] LLM 调用失败（{}），降级模板生成", e);
            GeneratedReport {
                content: fallback_template(events),
                llm_model: None,
            }
        }
    }
}

/// 把事件列表转为时间线文本：`10:02 VS Code - xxx.java (18min)`
fn build_timeline(events: &[EventRow]) -> String {
    // 按时间正序排列（events 从 DB 取是倒序，反转为正序）
    let mut sorted: Vec<&EventRow> = events.iter().collect();
    sorted.sort_by_key(|e| e.start_ts);

    sorted
        .iter()
        .map(|e| {
            let time = format_hm(e.start_ts);
            let duration = format_duration(e.duration_ms);
            let title = e.window_title.as_deref().unwrap_or("(无标题)");
            format!("{} {} - {} ({})", time, e.app, title, duration)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 调 DeepSeek API（OpenAI 兼容协议）
async fn call_deepseek(timeline: &str, api_key: &str) -> Result<String, String> {
    let system_prompt =
        "你是一个工作日报助手。根据用户今日的电脑活动时间线，生成\"今日完成\"部分。\n\
        要求：\n\
        1. 严格基于时间线中真实出现过的应用名和窗口标题，不得编造、臆测或联想未出现的应用或活动。\n\
        2. 按项目或时间组织，2~5 条，精炼自然，突出关键产出。\n\
        3. 只输出日报内容，不要额外解释。";

    let user_prompt = format!("用户时间线：\n{}", timeline);

    let body = serde_json::json!({
        "model": DEEPSEEK_MODEL,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt },
        ],
        "stream": false,
        "temperature": 0,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(DEEPSEEK_API_URL)
        .bearer_auth(api_key)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(provider_error(status.as_u16()));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    json["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "响应中无 content 字段".to_string())
}

/// 用最小生成请求验证候选 Key；验证成功后调用方才会写入 Keychain。
pub async fn validate_api_key(api_key: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "model": DEEPSEEK_MODEL,
        "messages": [
            { "role": "user", "content": "回复 OK" },
        ],
        "thinking": { "type": "disabled" },
        "max_tokens": 4,
        "stream": false,
    });

    let resp = reqwest::Client::new()
        .post(DEEPSEEK_API_URL)
        .bearer_auth(api_key)
        .json(&body)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "无法连接 DeepSeek，请检查网络后重试".to_string())?;

    if resp.status().is_success() {
        Ok(())
    } else {
        Err(provider_error(resp.status().as_u16()))
    }
}

fn provider_error(status: u16) -> String {
    match status {
        401 => "API Key 无效，请检查后重试".to_string(),
        402 => "DeepSeek 账户余额不足".to_string(),
        429 => "DeepSeek 请求过于频繁，请稍后重试".to_string(),
        500 | 503 => "DeepSeek 服务暂时不可用，请稍后重试".to_string(),
        _ => format!("DeepSeek 请求失败（HTTP {}）", status),
    }
}

/// 降级模板：LLM 失败时用规则生成
fn fallback_template(events: &[EventRow]) -> String {
    let mut sorted: Vec<&EventRow> = events.iter().collect();
    sorted.sort_by_key(|e| e.start_ts);

    let mut lines = vec!["【今日完成】".to_string()];
    let total_mins: i64 = events.iter().map(|e| e.duration_ms / 60000).sum();

    for e in &sorted {
        let time = format_hm(e.start_ts);
        let duration = format_duration(e.duration_ms);
        let title = e.window_title.as_deref().unwrap_or("");
        let detail = if title.is_empty() {
            format!("{} 使用 {}（{}）", time, e.app, duration)
        } else {
            format!("{} {} - {}（{}）", time, e.app, title, duration)
        };
        lines.push(format!("- {}", detail));
    }

    lines.push(format!(
        "\n（总活动时长 {}）",
        format_duration(total_mins * 60000)
    ));
    lines.join("\n")
}

fn format_hm(ts: i64) -> String {
    let secs = ts;
    // 本地时间：用 chrono 风格手动算太繁，这里简单按 UTC+8 处理（中国时区）
    let local = secs + 8 * 3600;
    let h = (local / 3600) % 24;
    let m = (local / 60) % 60;
    format!("{:02}:{:02}", h, m)
}

fn format_duration(ms: i64) -> String {
    let mins = (ms + 59999) / 60000; // 向上取整
    if mins < 60 {
        format!("{}min", mins)
    } else {
        let h = mins / 60;
        let m = mins % 60;
        if m > 0 {
            format!("{}h{}min", h, m)
        } else {
            format!("{}h", h)
        }
    }
}
