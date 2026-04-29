// ============================================================================
// 卸载残留扫描与删除命令
// ============================================================================

use crate::scanner::{LeftoverScanResult, LeftoverScanner};
use log::info;

/// 扫描卸载残留
#[tauri::command]
pub async fn scan_uninstall_leftovers(
    deep_scan: Option<bool>,
) -> Result<LeftoverScanResult, String> {
    let is_deep = deep_scan.unwrap_or(false);
    info!("开始扫描卸载残留... 深度扫描: {}", is_deep);

    let result = tokio::task::spawn_blocking(move || {
        let scanner = LeftoverScanner::with_deep_scan(is_deep);
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务失败: {}", e))?;

    info!(
        "卸载残留扫描完成: 发现 {} 个残留, 总大小 {} 字节",
        result.leftovers.len(),
        result.total_size
    );

    Ok(result)
}

/// 删除卸载残留文件夹
#[tauri::command]
pub async fn delete_leftover_folders(
    paths: Vec<String>,
) -> Result<crate::scanner::LeftoverDeleteResult, String> {
    info!("开始删除 {} 个卸载残留文件夹...", paths.len());

    let result = tokio::task::spawn_blocking(move || crate::scanner::delete_folders(paths))
        .await
        .map_err(|e| format!("删除任务失败: {}", e))?;

    info!(
        "卸载残留删除完成: 成功 {}, 失败 {}",
        result.deleted_count,
        result.failed_paths.len()
    );

    Ok(result)
}
