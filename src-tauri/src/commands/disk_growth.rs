// ============================================================================
// C 盘全盘变化分析命令
//
// MFT 枚举和文件大小聚合属于长耗时阻塞任务，因此放到 spawn_blocking 中执行，
// 避免占用 Tauri 异步运行时线程导致前端 IPC 响应变慢。
// ============================================================================

use log::info;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn cancel_disk_growth_scan() {
    crate::disk_growth::cancel_disk_growth_scan();
}

#[tauri::command]
pub async fn get_disk_growth_file_details(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    drive_letter: Option<String>,
) -> Result<crate::disk_growth::DiskGrowthFileDetailsResponse, String> {
    tokio::task::spawn_blocking(move || {
        crate::disk_growth::get_file_change_details(path, offset, limit, drive_letter)
    })
    .await
    .map_err(|error| format!("读取文件级变化明细失败: {}", error))?
}

#[tauri::command]
pub async fn get_disk_growth_directory_details(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    drive_letter: Option<String>,
) -> Result<crate::disk_growth::DiskGrowthDirectoryDetailsResponse, String> {
    tokio::task::spawn_blocking(move || {
        crate::disk_growth::get_directory_change_details(path, offset, limit, drive_letter)
    })
    .await
    .map_err(|error| format!("读取目录级变化明细失败: {}", error))?
}

#[tauri::command]
pub async fn scan_disk_growth(
    app_handle: AppHandle,
    max_change_entries: Option<usize>,
    drive_letter: Option<String>,
) -> Result<crate::disk_growth::DiskScanAndAnalyzeResponse, String> {
    let log_drive = drive_letter.as_deref().unwrap_or("系统盘").to_string();
    info!("开始执行 {} 全盘空间变化分析", log_drive);
    crate::disk_growth::reset_disk_growth_cancelled();

    let result = tokio::task::spawn_blocking(move || {
        crate::disk_growth::scan_and_analyze_drive_with_progress(
            &|progress| {
                // 扫描发生在阻塞线程里，通过事件把阶段进度送回前端，避免 IPC 长时间“无声”等待。
                let _ = app_handle.emit("disk-growth:progress", &progress);
            },
            max_change_entries,
            drive_letter,
        )
    })
    .await
    .map_err(|error| format!("全盘分析任务执行失败: {}", error))??;

    info!(
        "{} 全盘分析完成: {} 个目录变化，扫描 {} 个文件，耗时 {}ms",
        result.drive_letter,
        result.growth.entries.len(),
        result.total_files_scanned,
        result.scan_duration_ms
    );

    Ok(result)
}
