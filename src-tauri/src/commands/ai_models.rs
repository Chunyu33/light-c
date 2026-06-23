use crate::ai_models::{scan_ai_model_assets as scan_ai_model_assets_impl, AiModelScanResult};
use std::path::PathBuf;

#[tauri::command]
pub async fn scan_ai_model_assets(
    custom_paths: Option<Vec<String>>,
) -> Result<AiModelScanResult, String> {
    let paths = custom_paths
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();

    tokio::task::spawn_blocking(move || scan_ai_model_assets_impl(paths))
        .await
        .map_err(|error| format!("AI 资产扫描任务异常：{}", error))
}
