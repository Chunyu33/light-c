// ============================================================================
// AI 助手命令
//
// 这一层只做三件事：整形参数、调用 ai 模块、把错误转成可展示的字符串。
// 真正的业务逻辑都在 src/ai/ 下，不要写在这里。
// ============================================================================

use crate::ai::{
    AiChatReply, AiChatRequest, AiProfile, AiProviderPreset, AiPublicConfig, AiSessionMessage,
};

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
pub fn save_ai_profile(profile: AiProfile) -> Result<AiPublicConfig, String> {
    crate::ai::upsert_profile(profile)?;
    Ok(crate::ai::read_public_config())
}

/// 删除一份服务商档案。删掉的正好是当前档案时，后端会自动切到剩下的第一份。
#[tauri::command]
pub fn delete_ai_profile(profile_id: String) -> Result<AiPublicConfig, String> {
    crate::ai::delete_profile(&profile_id)?;
    Ok(crate::ai::read_public_config())
}

/// 切换当前使用的服务商档案。
#[tauri::command]
pub fn set_active_ai_profile(profile_id: String) -> Result<AiPublicConfig, String> {
    crate::ai::set_active_profile(&profile_id)?;
    Ok(crate::ai::read_public_config())
}

/// 设置 AI 数据目录（全局，不属于任何服务商 —— 换服务商不该把聊天记录搬走）。
#[tauri::command]
pub fn set_ai_data_dir(data_dir: String) -> Result<AiPublicConfig, String> {
    crate::ai::set_data_dir(data_dir)?;
    Ok(crate::ai::read_public_config())
}

/// 测试连通性：能成功拉到模型列表，说明地址、密钥、网络三者都通了。
#[tauri::command]
pub async fn test_ai_connection() -> Result<Vec<String>, String> {
    let models = crate::ai::fetch_models().await?;
    // 拉到了就缓存：设置页与面板都要显示"有哪些模型可选"，
    // 不能只让它在这一次会话里可见。缓存失败不影响本次测试的成功结论。
    if let Err(error) = crate::ai::cache_fetched_models(models.clone()) {
        log::warn!("缓存模型列表失败: {}", error);
    }
    Ok(models)
}

/// 发一次对话（非流式）。
/// 流式版本见 ai_chat_stream；非流式保留下来，便于排查"是不是流式解析的问题"。
#[tauri::command]
pub async fn ai_chat(request: AiChatRequest) -> Result<AiChatReply, String> {
    crate::ai::chat_once(request).await
}

/// 流式增量的推送数据体。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDelta {
    /// 与发起请求时传入的一致；前端据此过滤（同一时刻只允许一个流，加上更稳妥）
    pub stream_id: String,
    pub text: String,
}

/// 保存一张对话里的图片附件，返回文件名（前端把它写进会话记录）。
#[tauri::command]
pub fn save_ai_attachment(data_base64: String, media_type: String) -> Result<String, String> {
    crate::ai::save_attachment(&data_base64, &media_type)
}

/// 读回一张附件，返回可直接放进 <img src> 的 data URL；文件不在时返回空串。
#[tauri::command]
pub fn read_ai_attachment(name: String) -> Result<String, String> {
    crate::ai::read_attachment(&name)
}

/// 追加一条会话消息。
/// 模块 id 与日期由前端给出（后端不为此引入日期库），语义与安全校验在 ai::session 里。
#[tauri::command]
pub fn append_ai_session_message(
    module_id: String,
    date: String,
    message: AiSessionMessage,
) -> Result<(), String> {
    crate::ai::append_message(&module_id, &date, message)
}

/// 清空某模块某天的会话历史（界面的「清空对话」）。
/// 只删当天的文件：更早的历史留给'按日期清理'，不做隐式的大范围删除。
#[tauri::command]
pub fn clear_ai_session(module_id: String, date: String) -> Result<(), String> {
    crate::ai::clear_session(&module_id, &date)
}

/// 读取某模块某天的会话历史。文件不存在返回空列表（"还没有历史"是正常状态）。
#[tauri::command]
pub fn load_ai_session(module_id: String, date: String) -> Result<Vec<AiSessionMessage>, String> {
    crate::ai::load_session(&module_id, &date)
}

/// 流式对话：增量通过事件推送，命令最终返回完整正文。
///
/// 为什么用事件而不是"返回值就是流"：Tauri 命令只能返回一次性结果，
/// 要"边生成边显示"就必须在生成过程中主动往前端推。
/// 命令返回的完整正文还能兜底 —— 即使前端漏掉了事件，也不会丢内容。
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    request: AiChatRequest,
    stream_id: String,
) -> Result<AiChatReply, String> {
    use tauri::Emitter;

    let emitter = app.clone();
    let event_stream_id = stream_id.clone();
    crate::ai::chat_stream(request, move |delta: &str| {
        // 事件发送失败不作为致命错误：命令的返回值里还有完整正文
        let _ = emitter.emit(
            "ai-stream-delta",
            AiStreamDelta {
                stream_id: event_stream_id.clone(),
                text: delta.to_string(),
            },
        );
    })
    .await
}
