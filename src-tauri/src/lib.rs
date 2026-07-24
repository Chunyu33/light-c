// ============================================================================
// C盘清理工具 - 主入口
// Windows专属的智能磁盘清理工具
// ============================================================================

// 模块声明
mod ai_models;
mod cleaner;
mod commands;
mod data_dir;
mod disk_growth;
mod disk_health;
mod driver_cleanup;
mod health_score;
mod logger;
mod runtime;
mod scanner;
mod system_info;
mod system_slim;

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

    // 便携版必须在 Tauri 自动创建窗口前指定 WebView2 绝对数据目录，
    // 否则 localStorage 会继续落到 AppData，便携包移动后设置不会跟随。
    let portable_webview_data_directory = runtime::prepare_portable_webview_data_directory();
    let mut context = tauri::generate_context!();
    if portable_webview_data_directory.is_some() {
        for window_config in &mut context.config_mut().app.windows {
            window_config.create = false;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            if let Some(webview_data_directory) = portable_webview_data_directory.clone() {
                let window_configs = app.config().app.windows.clone();
                for window_config in window_configs {
                    tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                        .data_directory(webview_data_directory.join(&window_config.label))
                        .build()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 启动屏幕
            close_splashscreen,
            // 磁盘信息
            get_disk_info,
            get_local_drives,
            get_disk_health,
            // 扫描相关
            scan_junk_files,
            scan_deep_junk_files,
            cancel_deep_junk_scan,
            get_deep_junk_category_page,
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
            open_recycle_bin,
            // 系统瘦身
            check_admin_privilege,
            get_system_slim_status,
            disable_hibernation,
            enable_hibernation,
            cleanup_winsxs,
            cleanup_winsxs_resetbase,
            open_virtual_memory_settings,
            // 旧驱动清理
            scan_old_drivers,
            delete_old_drivers,
            restore_all_driver_backups,
            open_driver_backup_dir,
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
            delete_deep_junk_files,
            get_physical_size,
            check_admin_for_path,
            // 永久删除（深度清理）
            delete_leftovers_permanent,
            check_leftover_safety,
            // 系统信息
            get_system_info,
            get_distribution_channel,
            verify_integrity,
            // 清理日志
            record_cleanup_action,
            open_logs_folder,
            get_cleanup_history,
            // C盘热点扫描
            scan_hotspot,
            cancel_hotspot_scan,
            scan_path_direct,
            cleanup_directory_contents,
            // 右键菜单清理
            scan_context_menu,
            delete_context_menu_entries,
            // 系统快捷工具
            open_startup_manager,
            open_storage_settings,
            // C 盘全盘变化分析
            scan_disk_growth,
            cancel_disk_growth_scan,
            get_disk_growth_file_details,
            get_disk_growth_directory_details,
            // 数据目录管理
            get_data_directory,
            get_storage_location_info,
            migrate_legacy_portable_data,
            set_data_directory,
            clear_local_data,
            list_clearable_data_items,
            clear_selected_local_data,
            pick_folder_dialog,
            // AI 资产分析
            scan_ai_model_assets,
            delete_ai_model,
            // 外壳图标清理
            scan_shell_icons,
            remove_shell_icon,
            unlock_shell_icon,
            restore_shell_icon,
            restart_explorer,
            open_shell_icon_backup_dir,
            open_shell_icon_log,
            open_shell_icon_registry,
        ])
        .run(context)
        .expect("启动应用程序时发生错误");
}
