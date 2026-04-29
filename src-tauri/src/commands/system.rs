// ============================================================================
// 系统相关命令（系统瘦身 + 健康评分 + 系统信息）
// ============================================================================

use log::info;
use tauri::Window;

// 重新导出供前端使用
pub use crate::health_score::HealthScoreResult;
pub use crate::system_info::SystemInfo;
pub use crate::system_slim::SystemSlimStatus;

// ============================================================================
// 系统瘦身
// ============================================================================

/// 检查是否以管理员权限运行
#[tauri::command]
pub fn check_admin_privilege() -> bool {
    crate::system_slim::check_admin()
}

/// 获取系统瘦身状态
#[tauri::command]
pub fn get_system_slim_status() -> SystemSlimStatus {
    crate::system_slim::get_status()
}

/// 关闭休眠功能
#[tauri::command]
pub fn disable_hibernation() -> Result<String, String> {
    crate::system_slim::disable_hibernation()
}

/// 开启休眠功能
#[tauri::command]
pub fn enable_hibernation() -> Result<String, String> {
    crate::system_slim::enable_hibernation()
}

/// 清理 WinSxS 组件存储
#[tauri::command]
pub async fn cleanup_winsxs(window: Window) -> Result<String, String> {
    crate::system_slim::cleanup_winsxs(&window).await
}

/// 打开系统虚拟内存设置
#[tauri::command]
pub fn open_virtual_memory_settings() -> Result<(), String> {
    crate::system_slim::open_virtual_memory_settings()
}

// ============================================================================
// 健康评分
// ============================================================================

/// 计算系统健康评分
#[tauri::command]
pub fn get_health_score() -> HealthScoreResult {
    crate::health_score::calculate()
}

// ============================================================================
// 系统信息
// ============================================================================

/// 获取系统信息
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    info!("获取系统信息");
    crate::system_info::gather()
}
