// ============================================================================
// 磁盘信息命令
// ============================================================================

/// 读取物理磁盘基础信息和 Windows Storage 健康状态。
#[tauri::command]
pub async fn get_disk_health() -> Result<Vec<crate::disk_health::DiskHealthInfo>, String> {
    // CIM 查询是阻塞 IO，放到专用线程，避免卡住 Tauri 的异步运行时。
    tokio::task::spawn_blocking(crate::disk_health::query_disk_health)
        .await
        .map_err(|error| format!("磁盘信息任务执行失败: {}", error))?
}
