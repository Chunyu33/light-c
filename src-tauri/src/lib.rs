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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            // 磁盘信息
            get_disk_info,
            // 扫描相关
            scan_junk_files,
            scan_category,
            scan_large_files,
            cancel_large_file_scan,
            scan_social_cache,
            get_categories,
            // 删除相关
            delete_files,
            // 工具函数
            format_size,
            open_disk_cleanup,
            open_in_folder,
            open_file,
            // 系统瘦身
            check_admin_privilege,
            get_system_slim_status,
            disable_hibernation,
            enable_hibernation,
            cleanup_winsxs,
            open_virtual_memory_settings,
            // 健康评分
            get_health_score,
            // 卸载残留和注册表清理
            scan_uninstall_leftovers,
            delete_leftover_folders,
            scan_registry_redundancy,
            delete_registry_entries,
            open_registry_backup_dir,
            // 增强删除
            enhanced_delete_files,
            get_physical_size,
            check_admin_for_path,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用程序时发生错误");
}
