//! DeepSeek API Key 的安全存储边界。
//!
//! Keychain 优先，环境变量仅作为开发兼容后备；状态接口永不返回完整 Key。

use keyring::{Entry, Error as KeyringError};

const KEYCHAIN_SERVICE: &str = "com.workdaily.agent.llm";
const KEYCHAIN_ACCOUNT: &str = "deepseek-api-key";
const ENV_API_KEY: &str = "DEEPSEEK_API_KEY";

pub struct ResolvedApiKey {
    pub value: String,
    pub source: ApiKeySource,
}

pub enum ApiKeySource {
    Keychain,
    Environment,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyStatus {
    pub configured: bool,
    pub source: Option<&'static str>,
    pub last_four: Option<String>,
}

pub fn resolve_api_key() -> Result<Option<ResolvedApiKey>, String> {
    match entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => {
            return Ok(Some(ResolvedApiKey {
                value,
                source: ApiKeySource::Keychain,
            }));
        }
        Ok(_) | Err(KeyringError::NoEntry) => {}
        Err(_) => return Err("无法读取 macOS 钥匙串中的 API Key".to_string()),
    }

    Ok(std::env::var(ENV_API_KEY)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| ResolvedApiKey {
            value,
            source: ApiKeySource::Environment,
        }))
}

pub fn get_api_key_status() -> Result<ApiKeyStatus, String> {
    let Some(resolved) = resolve_api_key()? else {
        return Ok(ApiKeyStatus {
            configured: false,
            source: None,
            last_four: None,
        });
    };

    Ok(ApiKeyStatus {
        configured: true,
        source: Some(match resolved.source {
            ApiKeySource::Keychain => "keychain",
            ApiKeySource::Environment => "environment",
        }),
        last_four: Some(last_four(&resolved.value)),
    })
}

pub fn save_api_key(api_key: &str) -> Result<(), String> {
    entry()?
        .set_password(api_key)
        .map_err(|_| "无法将 API Key 保存到 macOS 钥匙串".to_string())
}

pub fn delete_api_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(_) => Err("无法从 macOS 钥匙串删除 API Key".to_string()),
    }
}

fn entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|_| "无法访问 macOS 钥匙串".to_string())
}

fn last_four(value: &str) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::last_four;

    #[test]
    fn masks_with_last_four_unicode_safe() {
        assert_eq!(last_four("sk-12345678"), "5678");
        assert_eq!(last_four("密钥"), "密钥");
    }
}
