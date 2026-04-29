// ============================================================================
// 文件删除命令
// ============================================================================

use crate::cleaner::{
    DeleteEngine, EnhancedDeleteEngine, EnhancedDeleteResult, PermanentDeleteEngine,
    PermanentDeleteResult, SafetyCheckResult,
};
use crate::scanner::DeleteResult;
use log::info;
use serde::Deserialize;

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
pub async fn enhanced_delete_files(paths: Vec<String>) -> Result<EnhancedDeleteResult, String> {
    info!("增强删除: 开始删除 {} 个文件", paths.len());

    let result = tokio::task::spawn_blocking(move || {
        let engine = EnhancedDeleteEngine::new();
        engine.delete_files(&paths)
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
