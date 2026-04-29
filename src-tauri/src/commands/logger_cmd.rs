// ============================================================================
// 清理日志命令
// ============================================================================

pub use crate::logger::{CleanupHistorySummary, CleanupLogEntryInput};

/// 记录清理操作到日志文件
#[tauri::command]
pub async fn record_cleanup_action(
    entries: Vec<CleanupLogEntryInput>,
) -> Result<String, String> {
    let app_data_dir = crate::data_dir::get_data_dir();
    crate::logger::record_cleanup_action(&app_data_dir, entries).await
}

/// 打开日志文件夹
#[tauri::command]
pub async fn open_logs_folder() -> Result<(), String> {
    let app_data_dir = crate::data_dir::get_data_dir();
    crate::logger::open_logs_folder(&app_data_dir)
}

/// 获取清理历史记录列表
#[tauri::command]
pub async fn get_cleanup_history() -> Result<Vec<CleanupHistorySummary>, String> {
    let app_data_dir = crate::data_dir::get_data_dir();
    crate::logger::get_cleanup_history(&app_data_dir)
}
