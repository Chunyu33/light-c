// ============================================================================
// AI 工具清理命令
// ============================================================================

use crate::scanner::{AiCacheDeleteResult, AiCacheFileList, AiToolScanner, AiToolScanResult};
use log::info;

/// 扫描各家 AI 工具的缓存。扫描要遍历目录，放阻塞线程池里跑，避免卡住 UI。
#[tauri::command]
pub async fn scan_ai_tool_caches() -> Result<AiToolScanResult, String> {
    info!("开始扫描 AI 工具缓存");

    let result = tokio::task::spawn_blocking(|| {
        let scanner = AiToolScanner::new();
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务异常: {}", e))?;

    info!(
        "AI 工具缓存扫描完成：{} 个工具，{} 个文件",
        result.groups.len(),
        result.total_files
    );
    Ok(result)
}

/// 删除选中的缓存目录，返回成功数与失败明细。
///
/// 每个路径都会在 `AiToolScanner::delete_dirs` 里重新校验归属 —— 前端传来的路径不可信，
/// 而删目录没有回收站可退，所以宁可多校验一次。
///
/// 返回值必须带失败列表：工具开着时缓存文件常被占用，只回一个成功数会让界面
/// 显示"已删除 N 个"，而实际占用一点没降。
#[tauri::command]
pub async fn delete_ai_tool_caches(paths: Vec<String>) -> Result<AiCacheDeleteResult, String> {
    if paths.is_empty() {
        return Ok(AiCacheDeleteResult {
            deleted: 0,
            failed: Vec::new(),
        });
    }
    info!("准备删除 {} 个 AI 工具缓存目录", paths.len());

    let result = tokio::task::spawn_blocking(move || {
        let scanner = AiToolScanner::new();
        scanner.delete_dirs(&paths)
    })
    .await
    .map_err(|e| format!("删除任务异常: {}", e))?;

    info!(
        "AI 工具缓存删除完成：成功 {} 个，失败 {} 个",
        result.deleted,
        result.failed.len()
    );
    Ok(result)
}

/// 列出某个缓存目录下的全部文件（明细弹窗用）。
///
/// 同样要校验路径归属：这个接口虽然只读，但也不该让前端用它去遍历任意目录。
#[tauri::command]
pub async fn list_ai_cache_files(path: String) -> Result<AiCacheFileList, String> {
    let target = std::path::PathBuf::from(&path);
    let listing = tokio::task::spawn_blocking(move || {
        let scanner = AiToolScanner::new();
        if !scanner.is_managed_cache_dir(&target) {
            return Err(format!("不是 AI 工具缓存目录: {}", target.display()));
        }
        Ok(scanner.list_files(&target))
    })
    .await
    .map_err(|e| format!("读取任务异常: {}", e))??;
    Ok(listing)
}
