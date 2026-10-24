// ============================================================================
// AI 工具清理命令
// ============================================================================

use crate::scanner::{AiCacheFile, AiToolScanner, AiToolScanResult};
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

/// 删除选中的缓存目录，返回实际删掉的目录数。
///
/// 每个路径都先过 `is_managed_cache_dir` 校验 —— 前端传来的路径不可信，
/// 而删目录没有回收站可退，所以宁可多校验一次。
#[tauri::command]
pub async fn delete_ai_tool_caches(paths: Vec<String>) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    info!("准备删除 {} 个 AI 工具缓存目录", paths.len());

    let deleted = tokio::task::spawn_blocking(move || {
        let scanner = AiToolScanner::new();
        let mut deleted = 0usize;
        for raw in paths {
            let path = std::path::PathBuf::from(&raw);
            if !scanner.is_managed_cache_dir(&path) {
                // 不在管理范围内：跳过而不是报错，避免一个非法路径打断整批删除
                log::warn!("拒绝删除非托管路径: {raw}");
                continue;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    deleted += 1;
                    info!("已删除缓存目录: {raw}");
                }
                Err(error) => {
                    // 目录被占用是常见情况（工具还开着），记录后继续删其它目录
                    log::warn!("删除失败 {raw}: {error}");
                }
            }
        }
        deleted
    })
    .await
    .map_err(|e| format!("删除任务异常: {}", e))?;

    info!("AI 工具缓存删除完成，共 {} 个目录", deleted);
    Ok(deleted)
}

/// 列出某个缓存目录下的全部文件（明细弹窗用）。
///
/// 同样要校验路径归属：这个接口虽然只读，但也不该让前端用它去遍历任意目录。
#[tauri::command]
pub async fn list_ai_cache_files(path: String) -> Result<Vec<AiCacheFile>, String> {
    let target = std::path::PathBuf::from(&path);
    let files = tokio::task::spawn_blocking(move || {
        let scanner = AiToolScanner::new();
        if !scanner.is_managed_cache_dir(&target) {
            return Err(format!("不是 AI 工具缓存目录: {}", target.display()));
        }
        Ok(scanner.list_files(&target))
    })
    .await
    .map_err(|e| format!("读取任务异常: {}", e))??;
    Ok(files)
}
