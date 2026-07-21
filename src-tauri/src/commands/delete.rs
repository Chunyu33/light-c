// ============================================================================
// 文件删除命令
// ============================================================================

use crate::cleaner::{
    DeleteEngine, EnhancedDeleteEngine, EnhancedDeleteProgress, EnhancedDeleteResult,
    PermanentDeleteEngine, PermanentDeleteResult, SafetyCheckResult,
};
use crate::scanner::{deep_junk, DeleteResult};
use log::info;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// 将删除进度发送给前端；事件失败不应中断实际删除任务。
fn emit_delete_progress(app: &AppHandle, progress: EnhancedDeleteProgress) {
    if let Err(error) = app.emit("junk-clean:delete-progress", progress) {
        log::warn!("发送垃圾清理删除进度失败: {}", error);
    }
}

/// 发送删除准备阶段，帮助前端在后端展开深度分类时也能立即给出反馈。
fn emit_delete_preparing(app: &AppHandle, total_count: usize) {
    emit_delete_progress(
        app,
        EnhancedDeleteProgress {
            phase: "preparing".to_string(),
            processed_count: 0,
            total_count,
            success_count: 0,
            failed_count: 0,
            reboot_pending_count: 0,
            freed_physical_size: 0,
            elapsed_ms: 0,
        },
    );
}

/// 删除请求参数
#[derive(Debug, Deserialize)]
pub struct DeleteRequest {
    pub paths: Vec<String>,
}

/// 删除指定文件
#[tauri::command]
pub async fn delete_files(request: DeleteRequest) -> Result<DeleteResult, String> {
    info!("开始删除 {} 个文件", request.paths.len());

    let result = tokio::task::spawn_blocking(move || {
        let engine = DeleteEngine::new();
        engine.delete_paths(&request.paths)
    })
    .await
    .map_err(|e| format!("删除任务异常: {}", e))?;

    info!(
        "删除完成: 成功 {}, 失败 {}, 释放 {} 字节",
        result.success_count, result.failed_count, result.freed_size
    );

    Ok(result)
}

/// 增强删除文件
#[tauri::command]
pub async fn enhanced_delete_files(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<EnhancedDeleteResult, String> {
    info!("增强删除: 开始删除 {} 个文件", paths.len());
    emit_delete_preparing(&app, paths.len());

    let progress_app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let engine = EnhancedDeleteEngine::new();
        engine.delete_files_with_progress(&paths, |progress| {
            emit_delete_progress(&progress_app, progress);
        })
    })
    .await
    .map_err(|e| format!("删除任务失败: {}", e))?;

    info!(
        "增强删除完成: 成功 {}, 失败 {}, 待重启 {}, 释放 {} 字节",
        result.success_count,
        result.failed_count,
        result.reboot_pending_count,
        result.freed_physical_size
    );

    Ok(result)
}

/// 删除深度扫描结果，后端再次校验路径规则，避免前端被篡改后删除任意文件。
#[tauri::command]
pub async fn delete_deep_junk_files(
    app: AppHandle,
    mut paths: Vec<String>,
    scan_id: Option<String>,
    category_names: Option<Vec<String>>,
    excluded_paths: Option<Vec<String>>,
) -> Result<EnhancedDeleteResult, String> {
    let category_names = category_names.unwrap_or_default();
    let excluded_paths = excluded_paths.unwrap_or_default();
    if !category_names.is_empty() {
        let scan_id = scan_id
            .as_deref()
            .ok_or_else(|| "缺少深度扫描会话，无法展开完整分类".to_string())?;
        // 深度扫描结果按页返回，删除时从后端会话恢复完整分类，避免前端只传首屏文件。
        paths.extend(deep_junk::get_paths_for_categories(
            scan_id,
            &category_names,
            &excluded_paths,
        )?);
    }

    let mut unique_paths = std::collections::HashSet::new();
    paths.retain(|path| unique_paths.insert(path.to_lowercase()));
    if paths.is_empty() {
        return Ok(EnhancedDeleteResult::new());
    }

    if let Some(invalid_path) = paths
        .iter()
        .find(|path| !deep_junk::is_deep_junk_path(path))
    {
        return Err(format!(
            "深度清理安全校验失败，拒绝删除路径: {}",
            invalid_path
        ));
    }

    info!("深度垃圾清理: 开始删除 {} 个文件", paths.len());
    emit_delete_preparing(&app, paths.len());
    let progress_app = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let engine = EnhancedDeleteEngine::new();
        engine.delete_files_with_progress(&paths, |progress| {
            emit_delete_progress(&progress_app, progress);
        })
    })
    .await
    .map_err(|error| format!("深度垃圾删除任务失败: {}", error))?;

    info!(
        "深度垃圾清理完成: 成功 {}, 失败 {}, 待重启 {}, 释放 {} 字节",
        result.success_count,
        result.failed_count,
        result.reboot_pending_count,
        result.freed_physical_size
    );
    Ok(result)
}

/// 获取文件的物理大小（按簇对齐）
#[tauri::command]
pub async fn get_physical_size(logical_size: u64) -> Result<u64, String> {
    let engine = EnhancedDeleteEngine::new();
    Ok(engine.calculate_physical_size(logical_size))
}

/// 检查是否需要管理员权限
#[tauri::command]
pub async fn check_admin_for_path(path: String) -> Result<bool, String> {
    let path_lower = path.to_lowercase();

    let admin_required_paths = [
        "c:\\windows\\",
        "c:\\program files",
        "c:\\programdata\\microsoft\\windows",
    ];

    for admin_path in &admin_required_paths {
        if path_lower.starts_with(admin_path) {
            return Ok(true);
        }
    }

    Ok(false)
}

/// 永久删除卸载残留（深度清理）
#[tauri::command]
pub async fn delete_leftovers_permanent(
    paths: Vec<String>,
) -> Result<PermanentDeleteResult, String> {
    info!("永久删除: 开始深度清理 {} 个卸载残留文件夹", paths.len());

    let result = tokio::task::spawn_blocking(move || {
        let engine = PermanentDeleteEngine::new();
        engine.delete_leftovers(paths)
    })
    .await
    .map_err(|e| format!("永久删除任务失败: {}", e))?;

    info!(
        "永久删除完成: 成功 {}, 失败 {}, 待审核 {}, 待重启 {}, 释放 {} 字节",
        result.success_count,
        result.failed_count,
        result.manual_review_count,
        result.reboot_pending_count,
        result.freed_size
    );

    Ok(result)
}

/// 执行单个路径的安全检查
#[tauri::command]
pub async fn check_leftover_safety(path: String) -> Result<SafetyCheckResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        let engine = PermanentDeleteEngine::new();
        let path = std::path::Path::new(&path);
        engine.perform_safety_checks(path)
    })
    .await
    .map_err(|e| format!("安全检查失败: {}", e))?;

    Ok(result)
}
