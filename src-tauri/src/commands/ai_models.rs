use crate::ai_models::{
    is_supported_model_extension, scan_ai_model_assets_with_progress as scan_ai_model_assets_impl,
    AiModelScanResult,
};
use crate::cleaner::{EnhancedDeleteEngine, EnhancedDeleteResult};
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub async fn scan_ai_model_assets(
    app_handle: AppHandle,
    enable_deep_discovery: Option<bool>,
) -> Result<AiModelScanResult, String> {
    let deep_discovery = enable_deep_discovery.unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        scan_ai_model_assets_impl(deep_discovery, &|progress| {
            // AI 模型深度发现可能触发 MFT 兜底，阶段事件能让前端在长 IO 期间保持可解释反馈。
            let _ = app_handle.emit("ai-models:progress", &progress);
        })
    })
    .await
    .map_err(|error| format!("AI 资产扫描任务异常：{}", error))
}

/// 删除单个 AI 模型文件，限制路径必须是支持的模型文件格式。
#[tauri::command]
pub async fn delete_ai_model(path: String) -> Result<EnhancedDeleteResult, String> {
    tokio::task::spawn_blocking(move || {
        let model_path = Path::new(path.trim());
        if !model_path.is_file() {
            return Err("模型文件不存在，或当前路径不是普通文件".to_string());
        }
        if !is_supported_model_extension(model_path) {
            return Err("当前文件格式不在 AI 模型删除范围内".to_string());
        }

        // 模型文件被占用时直接返回失败，避免未明确同意就安排重启删除。
        let engine = EnhancedDeleteEngine::new().with_reboot_delete(false);
        let mut result = engine.delete_files(&[model_path.to_string_lossy().into_owned()]);
        result.generate_summary();
        Ok(result)
    })
    .await
    .map_err(|error| format!("AI 模型删除任务异常：{}", error))?
}
