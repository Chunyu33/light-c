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

/// 清空本地数据（安装历史缓存 + 清理日志）
#[tauri::command]
pub fn clear_local_data() -> Result<(usize, u64), String> {
    crate::data_dir::clear_local_data()
}

/// 打开系统文件夹选择对话框
#[tauri::command]
pub async fn pick_folder_dialog(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("选择数据存储目录")
        .blocking_pick_folder();

    Ok(result.map(|p| p.to_string()))
}
