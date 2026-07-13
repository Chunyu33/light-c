// ============================================================================
// 旧驱动清理命令
// ============================================================================

use crate::driver_cleanup::{DriverDeleteResult, DriverRestoreResult, DriverScanResult};

/// 枚举并分析 Driver Store 中的第三方驱动包。
#[tauri::command]
pub async fn scan_old_drivers() -> Result<DriverScanResult, String> {
    tokio::task::spawn_blocking(crate::driver_cleanup::scan)
        .await
        .map_err(|error| format!("驱动扫描任务失败: {}", error))?
}

/// 备份并删除用户选中的安全候选驱动包。
#[tauri::command]
pub async fn delete_old_drivers(
    published_names: Vec<String>,
) -> Result<DriverDeleteResult, String> {
    tokio::task::spawn_blocking(move || crate::driver_cleanup::delete(published_names))
        .await
        .map_err(|error| format!("驱动清理任务失败: {}", error))?
}

/// 从当前数据目录的 driver_backups 中递归恢复全部驱动包。
#[tauri::command]
pub async fn restore_all_driver_backups() -> Result<DriverRestoreResult, String> {
    tokio::task::spawn_blocking(crate::driver_cleanup::restore_all_backups)
        .await
        .map_err(|error| format!("驱动恢复任务失败: {}", error))?
}

/// 打开驱动备份目录，便于用户自行查看已导出的 INF 包。
#[tauri::command]
pub fn open_driver_backup_dir() -> Result<(), String> {
    let directory = crate::driver_cleanup::backup_directory()?;
    crate::commands::tools::open_in_folder(directory)
}
