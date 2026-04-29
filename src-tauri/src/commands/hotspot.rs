// ============================================================================
// 大目录分析与下钻命令
// ============================================================================

use log::info;
use serde::{Deserialize, Serialize};

/// 目录清理结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupDirectoryResult {
    pub deleted_count: usize,
    pub failed_count: usize,
    pub freed_size: u64,
    pub errors: Vec<String>,
}

/// 取消大目录扫描
#[tauri::command]
pub fn cancel_hotspot_scan() {
    crate::scanner::cancel_hotspot_scan();
}

/// 扫描大目录
#[tauri::command]
pub async fn scan_hotspot(
    app: tauri::AppHandle,
    top_n: Option<usize>,
    full_scan: Option<bool>,
) -> Result<crate::scanner::HotspotScanResult, String> {
    use crate::scanner::HotspotScanner;

    let n = top_n.unwrap_or(20);
    let is_full_scan = full_scan.unwrap_or(false);

    if is_full_scan {
        info!("开始全盘深度扫描，Top {}", n);
        crate::scanner::reset_hotspot_cancelled();
    } else {
        info!("开始扫描 AppData 目录，Top {}", n);
    }

    let result = tokio::task::spawn_blocking(move || {
        let scanner = HotspotScanner::new(is_full_scan, n);
        scanner.scan_with_ui(&app)
    })
    .await
    .map_err(|e| format!("扫描任务执行失败: {}", e))?;

    match &result {
        Ok(scan_result) => {
            info!(
                "大目录扫描完成: {} 个目录，耗时 {}ms，扫描范围总大小 {} bytes，深度扫描: {}",
                scan_result.entries.len(),
                scan_result.scan_duration_ms,
                scan_result.appdata_total_size,
                scan_result.is_full_scan
            );
        }
        Err(e) => {
            log::warn!("大目录扫描失败: {}", e);
        }
    }

    result
}

/// 单层路径钻取扫描
#[tauri::command]
pub async fn scan_path_direct(
    path: String,
) -> Result<crate::scanner::HotspotScanResult, String> {
    use crate::scanner::HotspotScanner;

    info!("路径钻取扫描: {}", path);

    let result = tokio::task::spawn_blocking(move || HotspotScanner::scan_path_direct(&path))
        .await
        .map_err(|e| format!("路径钻取扫描任务执行失败: {}", e))?;

    match &result {
        Ok(scan_result) => {
            info!(
                "路径钻取扫描完成: {} 个子目录，耗时 {}ms",
                scan_result.entries.len(),
                scan_result.scan_duration_ms,
            );
        }
        Err(e) => {
            log::warn!("路径钻取扫描失败: {}", e);
        }
    }

    result
}

/// 清理目录内容（保留根目录）
#[tauri::command]
pub async fn cleanup_directory_contents(path: String) -> Result<CleanupDirectoryResult, String> {
    use std::fs;
    use walkdir::WalkDir;

    info!("开始清理目录内容: {}", path);

    let target_path = std::path::PathBuf::from(&path);

    if !target_path.exists() {
        return Err(format!("目录不存在: {}", path));
    }
    if !target_path.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }

    let result = tokio::task::spawn_blocking(move || {
        let mut deleted_count: usize = 0;
        let mut failed_count: usize = 0;
        let mut freed_size: u64 = 0;
        let mut errors: Vec<String> = Vec::new();

        let mut entries: Vec<_> = WalkDir::new(&target_path)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.path() != target_path)
            .collect();

        entries.sort_by(|a, b| b.depth().cmp(&a.depth()));

        for entry in entries {
            let entry_path = entry.path();

            let file_size = if entry_path.is_file() {
                entry_path.metadata().map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };

            let delete_result = if entry_path.is_dir() {
                fs::remove_dir(entry_path)
            } else {
                fs::remove_file(entry_path)
            };

            match delete_result {
                Ok(_) => {
                    deleted_count += 1;
                    freed_size += file_size;
                }
                Err(e) => {
                    failed_count += 1;
                    if errors.len() < 10 {
                        errors.push(format!("{}: {}", entry_path.display(), e));
                    }
                }
            }
        }

        CleanupDirectoryResult {
            deleted_count,
            failed_count,
            freed_size,
            errors,
        }
    })
    .await
    .map_err(|e| format!("清理任务执行失败: {}", e))?;

    info!(
        "目录清理完成: 删除 {} 项，失败 {} 项，释放 {} 字节",
        result.deleted_count, result.failed_count, result.freed_size
    );

    Ok(result)
}
