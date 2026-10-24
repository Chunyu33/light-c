// ============================================================================
// AI 工具清理命令
// ============================================================================

use crate::scanner::{AiToolScanner, AiToolScanResult};
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
