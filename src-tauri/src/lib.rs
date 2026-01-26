// ============================================================================
// C盘清理工具 - 主入口
// Windows专属的智能磁盘清理工具
// ============================================================================

// 模块声明
mod scanner;
mod cleaner;
mod commands;

// 导出命令模块
use commands::*;

/// 应用程序入口点
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // 磁盘信息
            get_disk_info,
            // 扫描相关
            scan_junk_files,
            scan_category,
            get_categories,
            // 删除相关
            delete_files,
            // 工具函数
            format_size,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用程序时发生错误");
}
