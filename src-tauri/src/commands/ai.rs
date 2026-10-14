// ============================================================================
// AI 助手命令
//
// 这一层只做三件事：整形参数、调用 ai 模块、把错误转成可展示的字符串。
// 真正的业务逻辑都在 src/ai/ 下，不要写在这里。
// ============================================================================

use crate::ai::{AiChatReply, AiChatRequest, AiProviderPreset, AiPublicConfig, AiStoredConfig};

/// 返回内置服务商预设，供设置页渲染下拉框。
#[tauri::command]
pub fn list_ai_providers() -> Vec<AiProviderPreset> {
    crate::ai::list_providers()
}

/// 读取当前 AI 配置。**密钥以掩码返回**，原文永远不出后端。
#[tauri::command]
pub fn get_ai_config() -> AiPublicConfig {
    crate::ai::read_public_config()
}

/// 保存 AI 配置。
///
/// 约定：前端传来的 apiKey 为空字符串时表示"不改动已保存的密钥" ——
/// 否则用户每次只想换个模型，都得把密钥重新粘贴一遍。
#[tauri::command]
pub fn save_ai_config(config: AiStoredConfig) -> Result<AiPublicConfig, String> {
    let mut next = config;
    if next.api_key.trim().is_empty() {
        next.api_key = crate::ai::read_config().api_key;
    }
    crate::ai::save_config(next)?;
    Ok(crate::ai::read_public_config())
}

/// 测试连通性：能成功拉到模型列表，说明地址、密钥、网络三者都通了。
#[tauri::command]
pub async fn test_ai_connection() -> Result<Vec<String>, String> {
    crate::ai::fetch_models().await
}

/// 发一次对话（非流式）。
/// 流式输出与「按当前模块注入上下文」属于后续阶段，这里先保证能问能答。
#[tauri::command]
pub async fn ai_chat(request: AiChatRequest) -> Result<AiChatReply, String> {
    crate::ai::chat_once(request).await
}
