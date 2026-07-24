// ============================================================================
// 数据目录管理命令
// ============================================================================

/// 获取当前数据目录路径
#[tauri::command]
pub fn get_data_directory() -> Result<String, String> {
    Ok(crate::data_dir::get_data_dir()
        .to_string_lossy()
        .to_string())
}

/// 获取统一的发行模式、配置路径、数据路径和便携迁移状态。
#[tauri::command]
pub fn get_storage_location_info() -> crate::data_dir::StorageLocationInfo {
    crate::data_dir::get_storage_location_info()
}

/// 重试便携版旧 AppData 数据迁移，源数据始终保留。
#[tauri::command]
pub fn migrate_legacy_portable_data() -> Result<crate::data_dir::StorageLocationInfo, String> {
    crate::data_dir::migrate_legacy_portable_data()
}

/// 设置数据目录并迁移数据
#[tauri::command]
pub fn set_data_directory(path: String) -> Result<String, String> {
    let new_path = std::path::Path::new(&path);
    crate::data_dir::set_data_dir(new_path)?;
    Ok(format!(
        "数据目录已更改为: {}",
        crate::data_dir::get_data_dir().display()
    ))
}

/// 清空本地数据白名单项；模块专属日志和备份由数据目录统一清理清单管理。
#[tauri::command]
pub fn clear_local_data() -> Result<(usize, u64), String> {
    crate::data_dir::clear_local_data()
}

#[tauri::command]
pub fn list_clearable_data_items() -> Result<Vec<crate::data_dir::ClearableDataItem>, String> {
    crate::data_dir::list_clearable_data_items()
}

#[tauri::command]
pub fn clear_selected_local_data(
    item_ids: Vec<String>,
) -> Result<crate::data_dir::ClearLocalDataResult, String> {
    crate::data_dir::clear_selected_local_data(&item_ids)
}

/// 打开系统文件夹选择对话框
#[tauri::command]
pub async fn pick_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("选择数据存储目录")
        .blocking_pick_folder();

    Ok(result.map(|p| p.to_string()))
}
