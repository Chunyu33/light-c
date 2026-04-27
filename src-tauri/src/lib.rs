// ============================================================================
// C盘清理工具 - 主入口
// Windows专属的智能磁盘清理工具
// ============================================================================

// 模块声明
mod cleaner;
mod commands;
mod logger;
mod scanner;

// 导出命令模块
use commands::*;
use tauri::Manager;

// ============================================================================
// 启动屏幕窗口管理
// ============================================================================

/// 关闭启动屏幕并显示主窗口
#[tauri::command]
async fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    // 关闭 splashscreen 窗口
    if let Some(splash) = app.get_webview_window("splashscreen") {
        splash.close().map_err(|e| e.to_string())?;
    }

    // 显示主窗口
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// 应用程序入口点
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 初始化日志
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // .plugin(tauri_plugin_updater::Builder::new().build()) // 自动更新功能已停用
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            // 启动屏幕
            close_splashscreen,
            // 磁盘信息
            get_disk_info,
            // 扫描相关
            scan_junk_files,
            scan_category,
            scan_large_files,
            cancel_large_file_scan,
            scan_social_cache,
            scan_social_cache_v2,
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
            // 永久删除（深度清理）
            delete_leftovers_permanent,
            check_leftover_safety,
            // 系统信息
            get_system_info,
            // 清理日志
            record_cleanup_action,
            open_logs_folder,
            get_cleanup_history,
            // C盘热点扫描
            scan_hotspot,
            scan_path_direct,
            cleanup_directory_contents,
            // 右键菜单清理
            scan_context_menu,
            delete_context_menu_entries,
            // 系统快捷工具
            open_startup_manager,
            open_storage_settings,
            // ProgramData 分析
            scan_programdata,
            analyze_programdata,
            diff_programdata,
            clean_programdata,
        ])
        .run(tauri::generate_context!())
        .expect("启动应用程序时发生错误");
}
