use crate::ai_models::{
    is_model_package_directory, is_supported_model_extension,
    scan_ai_model_assets_with_progress as scan_ai_model_assets_impl, AiModelScanResult,
};
use crate::cleaner::{
    DeleteFailureReason, EnhancedDeleteEngine, EnhancedDeleteResult, FileDeleteResult,
};
use std::path::Path;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

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

/// 删除单个 AI 模型（模型文件或 .mlpackage 模型包目录），限制路径必须是支持的模型格式。
#[tauri::command]
pub async fn delete_ai_model(path: String) -> Result<EnhancedDeleteResult, String> {
    tokio::task::spawn_blocking(move || {
        let model_path = Path::new(path.trim());

        // Core ML 的 .mlpackage 是目录包，扫描时按整包统计，删除也必须支持整包，
        // 否则用户能看到体积却没有任何清理手段。
        if model_path.is_dir() {
            if !is_model_package_directory(model_path) {
                return Err("当前目录不是可删除的 AI 模型包".to_string());
            }
            return delete_model_package(model_path);
        }

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

/// 删除 .mlpackage 模型包目录。
///
/// 删除前先统计体积（删除后路径就不存在了），失败时给出可定位的原因，
/// 返回结构与单文件删除保持一致，前端无需区分两种模型。
fn delete_model_package(model_path: &Path) -> Result<EnhancedDeleteResult, String> {
    let logical_size = directory_logical_size(model_path);

    let mut result = EnhancedDeleteResult::new();
    match std::fs::remove_dir_all(model_path) {
        Ok(()) => {
            result.success_count = 1;
            result.freed_logical_size = logical_size;
            // 物理占用按簇对齐无法精确还原，用逻辑大小作为释放量，避免向用户虚报
            result.freed_physical_size = logical_size;
            result.file_results.push(FileDeleteResult {
                path: model_path.to_string_lossy().into_owned(),
                success: true,
                logical_size,
                physical_size: logical_size,
                failure_reason: None,
                marked_for_reboot: false,
            });
        }
        Err(error) => {
            let reason = error.to_string();
            result.failed_count = 1;
            result.skipped_size = logical_size;
            result.file_results.push(FileDeleteResult {
                path: model_path.to_string_lossy().into_owned(),
                success: false,
                logical_size,
                physical_size: logical_size,
                failure_reason: Some(DeleteFailureReason::Other(reason)),
                marked_for_reboot: false,
            });
        }
    }

    result.generate_summary();
    Ok(result)
}

/// 统计模型包目录的逻辑体积，用于删除结果展示。
fn directory_logical_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}
