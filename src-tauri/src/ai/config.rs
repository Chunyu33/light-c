// ============================================================================
// AI 配置读写（多服务商档案）
//
// 存放位置：{数据目录}/ai/ai_settings.json（跟随主数据目录，便携版也能带走）
//
// 结构：
//   { "activeProfileId": "p_xxx", "profiles": [ { ...一份完整服务商配置 } ], "dataDir": "" }
//
// 为什么是"数组 + 当前选中"而不是一份配置：
//   用户可能同时有官方 API 和第三方中转、或者不同用途用不同模型。
//   拆成档案后，"再加一个服务商"就是加一个元素，"切换"只改 activeProfileId 一个字段。
//
// 关于密钥：当前与多数桌面工具一致，以明文保存在该文件里；但**绝不回传前端** ——
//   前端只拿得到掩码（sk-****1234），界面层无法取得可用密钥。
//   后续若要做到"拷走文件也解不开"，可接 Windows DPAPI（见 docs/dev/AI服务商与密钥存储方案.md），
//   本文件对外接口不用变。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// 一份服务商档案：一个密钥 + 一个地址 + 一个当前模型。
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    /// 稳定 id，切换与更新都靠它
    pub id: String,
    /// 用户可改的显示名；留空时界面回落到服务商名
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub provider_id: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    /// **上次成功拉取到的模型列表**。
    /// 必须缓存：否则界面只有一个孤零零的模型名，用户既看不到有几个可选，
    /// 也无法判断这个名字是不是还有效（历史问题：早期预设带过 default_model，
    /// 用户保存后一直显示那个名字，即使它早就不在该密钥可用的列表里）。
    #[serde(default)]
    pub models: Vec<String>,
    /// 模型列表的拉取时间（Unix 秒），0 表示从未拉过
    #[serde(default)]
    pub models_fetched_at: i64,
    /// 思考强度。**留空 = 不发送该参数** —— 不支持的模型收到它可能直接报错。
    #[serde(default)]
    pub reasoning_effort: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStoredConfig {
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    /// AI 数据目录（会话记录等）。**全局设置**，不属于某个服务商 ——
    /// 换服务商不该把聊天记录也搬走。
    #[serde(default)]
    pub data_dir: String,
}

impl AiStoredConfig {
    /// 当前生效的档案。id 找不到时回退到第一个 ——
    /// 配置还在却"用不了"是最难排查的状态，这里宁可退回一个能用的。
    pub fn active_profile(&self) -> Option<&AiProfile> {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.active_profile_id)
            .or_else(|| self.profiles.first())
    }

    pub fn active_profile_mut(&mut self) -> Option<&mut AiProfile> {
        let target = self
            .profiles
            .iter()
            .position(|profile| profile.id == self.active_profile_id)
            .or(if self.profiles.is_empty() { None } else { Some(0) })?;
        self.profiles.get_mut(target)
    }
}

/// 交给前端的档案视图：密钥只给掩码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPublicProfile {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
    pub api_key_masked: String,
    pub has_api_key: bool,
    pub models: Vec<String>,
    pub models_fetched_at: i64,
    pub reasoning_effort: String,
}

/// 交给前端的整体视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPublicConfig {
    pub active_profile_id: String,
    pub profiles: Vec<AiPublicProfile>,
    pub data_dir: String,
}

/// 解析后的 AI 数据根目录：配置为空时回落到「数据目录/ai」。
/// 会话落盘与"清空本地数据"都用它，保证两处永远指向同一个地方。
pub fn resolve_data_dir() -> PathBuf {
    let configured = read_config().data_dir;
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        crate::data_dir::get_data_dir().join("ai")
    } else {
        PathBuf::from(trimmed)
    }
}

/// 配置文件所在目录：{数据目录}/ai
fn config_dir() -> PathBuf {
    crate::data_dir::get_data_dir().join("ai")
}

/// 配置文件路径。
pub fn config_path() -> PathBuf {
    config_dir().join("ai_settings.json")
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// 把旧版单配置结构迁移成一份档案。
///
/// 旧文件长这样：`{ "providerId": "...", "baseUrl": "...", "model": "...", "apiKey": "..." }`
/// 没有 profiles 字段。**必须迁移**：否则升级后用户的密钥与模型全部"消失"。
fn migrate_legacy(value: &serde_json::Value) -> Option<AiStoredConfig> {
    let text = |key: &str| -> String {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string()
    };

    let api_key = text("apiKey");
    let provider_id = text("providerId");
    let base_url = text("baseUrl");
    let model = text("model");
    // 旧配置里连密钥都没有，就是没配过，不必造一个空档案
    if api_key.trim().is_empty() && provider_id.trim().is_empty() {
        return None;
    }

    let profile = AiProfile {
        id: "p_migrated".to_string(),
        name: String::new(),
        provider_id,
        base_url,
        model,
        models: value
            .get("models")
            .and_then(|item| item.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|item| item.to_string())
                    .collect()
            })
            .unwrap_or_default(),
        models_fetched_at: value
            .get("modelsFetchedAt")
            .and_then(|item| item.as_i64())
            .unwrap_or(0),
        api_key,
        reasoning_effort: String::new(),
    };

    Some(AiStoredConfig {
        active_profile_id: profile.id.clone(),
        profiles: vec![profile],
        data_dir: text("dataDir"),
    })
}

/// 读配置。文件不存在、内容损坏都回退到默认值 —— 配置读不出来不该让界面打不开。
pub fn read_config() -> AiStoredConfig {
    let path = config_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return AiStoredConfig::default();
    };

    // 先当通用 JSON 读：这样才能判断是旧结构（需要迁移）还是新结构
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        log::warn!("AI 配置不是合法 JSON，已回退默认值: {}", path.display());
        return AiStoredConfig::default();
    };

    if value.get("profiles").is_some() {
        return serde_json::from_value(value).unwrap_or_else(|error| {
            log::warn!("AI 配置解析失败，已回退默认值: {} ({})", path.display(), error);
            AiStoredConfig::default()
        });
    }

    // 旧结构：迁移并**立即写回**，避免每次启动都判断一次；
    // 用户不一定会再点保存，不写回就会一直停在"看似没有配置"的状态。
    match migrate_legacy(&value) {
        Some(migrated) => {
            log::info!("检测到旧版 AI 配置，已迁移为单档案结构");
            if let Err(error) = save_config(migrated.clone()) {
                log::warn!("迁移后的配置写回失败（本次仍按迁移结果使用）: {}", error);
            }
            migrated
        }
        None => AiStoredConfig::default(),
    }
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

/// 新增或更新一份档案（按 id 匹配）。返回更新后的整体配置。
pub fn upsert_profile(profile: AiProfile) -> Result<AiStoredConfig, String> {
    let mut config = read_config();
    match config.profiles.iter_mut().find(|item| item.id == profile.id) {
        Some(existing) => {
            // 密钥留空 = 不改动已保存的密钥（前端只拿得到掩码，回传不了明文）
            let previous_key = existing.api_key.clone();
            let keep_key = profile.api_key.trim().is_empty();
            *existing = profile;
            if keep_key {
                existing.api_key = previous_key;
            }
        }
        None => {
            let mut created = profile;
            if created.id.trim().is_empty() {
                created.id = format!("p_{}", now_seconds());
            }
            // ⚠️ 新建的档案**必须设为当前**。
            // 否则：界面里的表单永远编辑"当前档案"，用户新建后填的密钥会被存进旧档案，
            // 新档案永远是空的（这是实现时靠读流程发现的一个真 bug）。
            config.active_profile_id = created.id.clone();
            config.profiles.push(created);
        }
    }
    save_config(config.clone())?;
    Ok(config)
}

/// 删除一份档案。删掉的正好是当前档案时，自动切到剩下的第一份。
pub fn delete_profile(profile_id: &str) -> Result<AiStoredConfig, String> {
    let mut config = read_config();
    config.profiles.retain(|profile| profile.id != profile_id);
    if config.active_profile_id == profile_id {
        config.active_profile_id = config
            .profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_default();
    }
    save_config(config.clone())?;
    Ok(config)
}

/// 切换当前档案。
pub fn set_active_profile(profile_id: &str) -> Result<AiStoredConfig, String> {
    let mut config = read_config();
    if !config.profiles.iter().any(|profile| profile.id == profile_id) {
        return Err(format!("要切换的服务商配置不存在: {}", profile_id));
    }
    config.active_profile_id = profile_id.to_string();
    save_config(config.clone())?;
    Ok(config)
}

/// 缓存模型列表到**当前档案**：拉取成功后调用。
/// 只改这两个字段，其余配置原样保留 —— 这个函数不该有别的副作用。
pub fn cache_fetched_models(models: Vec<String>) -> Result<(), String> {
    let mut config = read_config();
    let Some(profile) = config.active_profile_mut() else {
        return Ok(());
    };
    profile.models = models;
    profile.models_fetched_at = now_seconds();
    save_config(config)
}

/// 给前端的公开视图：密钥只给掩码，另有布尔标记表示是否已配置。
pub fn read_public_config() -> AiPublicConfig {
    let stored = read_config();
    AiPublicConfig {
        active_profile_id: stored.active_profile_id.clone(),
        profiles: stored
            .profiles
            .iter()
            .map(|profile| AiPublicProfile {
                id: profile.id.clone(),
                name: profile.name.clone(),
                provider_id: profile.provider_id.clone(),
                base_url: profile.base_url.clone(),
                model: profile.model.clone(),
                api_key_masked: mask_api_key(&profile.api_key),
                has_api_key: !profile.api_key.trim().is_empty(),
                models: profile.models.clone(),
                models_fetched_at: profile.models_fetched_at,
                reasoning_effort: profile.reasoning_effort.clone(),
            })
            .collect(),
        data_dir: stored.data_dir,
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

/// 全局数据目录设置（不属于任何档案）。
pub fn set_data_dir(data_dir: String) -> Result<AiStoredConfig, String> {
    let mut config = read_config();
    config.data_dir = data_dir;
    save_config(config.clone())?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_single_config_migrates_into_one_profile() {
        // 旧文件没有 profiles 字段；不迁移就等于用户配置全丢
        let legacy = serde_json::json!({
            "providerId": "deepseek",
            "baseUrl": "https://api.deepseek.com",
            "model": "deepseek-chat",
            "apiKey": "sk-abcdefghijklmn",
            "models": ["deepseek-chat", "deepseek-reasoner"]
        });
        let migrated = migrate_legacy(&legacy).expect("有密钥就该迁移");
        assert_eq!(migrated.profiles.len(), 1);
        assert_eq!(migrated.profiles[0].model, "deepseek-chat");
        assert_eq!(migrated.profiles[0].models.len(), 2);
        // 迁移出来的档案必须是当前档案，否则用户保存了却不生效
        assert_eq!(migrated.active_profile_id, migrated.profiles[0].id);
    }

    #[test]
    fn empty_legacy_config_is_not_migrated_into_a_ghost_profile() {
        let legacy = serde_json::json!({});
        assert!(migrate_legacy(&legacy).is_none());
    }

    #[test]
    fn active_profile_falls_back_to_first_when_id_is_stale() {
        let config = AiStoredConfig {
            active_profile_id: "p_missing".to_string(),
            profiles: vec![AiProfile {
                id: "p_1".to_string(),
                provider_id: "deepseek".to_string(),
                ..Default::default()
            }],
            data_dir: String::new(),
        };
        assert_eq!(config.active_profile().map(|p| p.id.as_str()), Some("p_1"));
    }

    #[test]
    fn masking_keeps_edges_but_hides_the_middle() {
        assert_eq!(mask_api_key("sk-abcdefghijklmn"), "sk-****klmn");
        assert_eq!(mask_api_key("short"), "****");
        assert_eq!(mask_api_key(""), "");
    }
}
