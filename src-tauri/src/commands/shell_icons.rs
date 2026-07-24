// ============================================================================
// 外壳图标清理命令
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
    // 后台任务需要取得目标所有权，但日志仍需使用原始目标，因此保留一份副本。
    let target_for_task = target.clone();
    let result =
        tokio::task::spawn_blocking(move || scanner::remove_shell_icon(&target_for_task, mode))
            .await
            .map_err(|error| format!("虚拟磁盘处理任务失败: {}", error))?;
    scanner::record_shell_icon_operation(
        &target,
        if mode == 2 { "彻底删除" } else { "删除" },
        &result,
    );
    result
}

#[tauri::command]
pub async fn unlock_shell_icon(
    target: ShellIconTarget,
) -> Result<ShellIconOperationResult, String> {
    // 解锁操作同样在阻塞线程执行，复制目标避免影响后续操作记录。
    let target_for_task = target.clone();
    let result = tokio::task::spawn_blocking(move || scanner::unlock_shell_icon(&target_for_task))
        .await
        .map_err(|error| format!("解锁虚拟磁盘任务失败: {}", error))?;
    scanner::record_shell_icon_operation(&target, "解除防复活", &result);
    result
}

#[tauri::command]
pub async fn restore_shell_icon(
    target: ShellIconTarget,
) -> Result<ShellIconOperationResult, String> {
    // 恢复操作可能包含注册表导入，复制目标后再交给阻塞线程执行。
    let target_for_task = target.clone();
    let result = tokio::task::spawn_blocking(move || scanner::restore_shell_icon(&target_for_task))
        .await
        .map_err(|error| format!("恢复虚拟磁盘任务失败: {}", error))?;
    scanner::record_shell_icon_operation(&target, "恢复节点", &result);
    result
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
pub fn open_shell_icon_log() -> Result<(), String> {
    scanner::open_shell_icon_log()
}

#[tauri::command]
pub fn open_shell_icon_registry(target: ShellIconTarget) -> Result<(), String> {
    scanner::open_shell_icon_registry(&target)
}
