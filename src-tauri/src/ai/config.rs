// ============================================================================
// AI 配置读写
//
// 存放位置：{数据目录}/ai/ai_settings.json（跟随主数据目录，便携版也能带走）
//
// 关于密钥：当前与多数桌面工具一致，以明文保存在该文件里；但**绝不回传前端** ——
// 前端只拿得到掩码（sk-****1234），因此界面层无法取得可用密钥。
// 后续若要更严格，可换成系统凭据管理器，本文件对外接口不用变。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 落盘的完整配置（含明文密钥）。**只在 Rust 侧流转，不要序列化给前端。**
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStoredConfig {
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

/// 可以安全交给前端的配置视图（密钥已掩码）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPublicConfig {
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    /// 掩码后的密钥，仅用于界面显示
    pub api_key_masked: String,
    /// 是否已存过密钥，界面据此显示"已配置 / 未配置"
    pub has_api_key: bool,
}

/// 配置文件所在目录：{数据目录}/ai
fn config_dir() -> PathBuf {
    crate::data_dir::get_data_dir().join("ai")
}

/// 配置文件路径。
pub fn config_path() -> PathBuf {
    config_dir().join("ai_settings.json")
}

/// 读配置。文件不存在、内容损坏都回退到默认值 —— 配置读不出来不该让界面打不开。
pub fn read_config() -> AiStoredConfig {
    let path = config_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return AiStoredConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_else(|error| {
        log::warn!("AI 配置解析失败，已回退默认值: {} ({})", path.display(), error);
        AiStoredConfig::default()
    })
}

/// 写配置。只写一个小 JSON，直接落盘即可；目录不存在时先建。
pub fn save_config(config: AiStoredConfig) -> Result<(), String> {
    let directory = config_dir();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建 AI 配置目录失败 {}: {}", directory.display(), error))?;

    let text = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("序列化 AI 配置失败: {}", error))?;
    let path = config_path();
    fs::write(&path, text)
        .map_err(|error| format!("写入 AI 配置失败 {}: {}", path.display(), error))?;
    Ok(())
}

/// 给前端的公开视图：密钥只给掩码，另有布尔标记表示是否已配置。
pub fn read_public_config() -> AiPublicConfig {
    let stored = read_config();
    AiPublicConfig {
        provider_id: stored.provider_id,
        base_url: stored.base_url,
        model: stored.model,
        api_key_masked: mask_api_key(&stored.api_key),
        has_api_key: !stored.api_key.trim().is_empty(),
    }
}

/// 掩码规则：保留前 3 位与后 4 位，中间用固定四个星号。
/// 太短（少于 12 位）就整体打码，避免把密钥本身泄露出去。
pub fn mask_api_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.chars().count() < 12 {
        return "****".to_string();
    }
    let prefix: String = trimmed.chars().take(3).collect();
    let suffix: String = trimmed
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{}****{}", prefix, suffix)
}
