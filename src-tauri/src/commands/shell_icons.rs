// ============================================================================
// 虚拟磁盘管理命令
// 命令层只负责异步调度和错误边界，注册表安全校验集中在 scanner::shell_icons。
// ============================================================================

use crate::scanner::{self, ShellIconOperationResult, ShellIconTarget};
use log::info;

#[tauri::command]
pub async fn scan_shell_icons() -> Result<Vec<scanner::ShellIconInfo>, String> {
    tokio::task::spawn_blocking(scanner::scan_shell_icons)
        .await
        .map_err(|error| format!("虚拟磁盘扫描任务失败: {}", error))?
}

#[tauri::command]
pub async fn remove_shell_icon(
    target: ShellIconTarget,
    mode: u8,
) -> Result<ShellIconOperationResult, String> {
    info!("处理虚拟磁盘节点: {} / {}", target.hive, target.clsid);
    tokio::task::spawn_blocking(move || scanner::remove_shell_icon(&target, mode))
        .await
        .map_err(|error| format!("虚拟磁盘处理任务失败: {}", error))?
}

#[tauri::command]
pub async fn unlock_shell_icon(
    target: ShellIconTarget,
) -> Result<ShellIconOperationResult, String> {
    tokio::task::spawn_blocking(move || scanner::unlock_shell_icon(&target))
        .await
        .map_err(|error| format!("解锁虚拟磁盘任务失败: {}", error))?
}

#[tauri::command]
pub async fn restore_shell_icon(
    target: ShellIconTarget,
) -> Result<ShellIconOperationResult, String> {
    tokio::task::spawn_blocking(move || scanner::restore_shell_icon(&target))
        .await
        .map_err(|error| format!("恢复虚拟磁盘任务失败: {}", error))?
}

#[tauri::command]
pub fn restart_explorer() -> Result<(), String> {
    scanner::restart_explorer()
}

#[tauri::command]
pub fn open_shell_icon_backup_dir() -> Result<(), String> {
    scanner::open_shell_icon_backup_dir()
}

#[tauri::command]
pub fn open_shell_icon_registry(target: ShellIconTarget) -> Result<(), String> {
    scanner::open_shell_icon_registry(&target)
}
