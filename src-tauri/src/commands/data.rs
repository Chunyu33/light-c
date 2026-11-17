// ============================================================================
// 数据目录管理命令
// ============================================================================

use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 壁纸在数据目录中的固定文件名（不含扩展名）。
/// 用固定名而不是原文件名：选图后复制到数据目录，原图被用户删掉/移动也不影响。
/// 扩展名保留真实后缀——WebView 靠它判断 asset:// 资源的 MIME 类型，
/// 改成统一的 .img 会导致图片加载失败。
const WALLPAPER_FILE_STEM: &str = "wallpaper";

/// 壁纸允许的扩展名。用扩展名判断而不是读文件头：WebView 需要正确的扩展名才会
/// 按图片解码 asset:// 资源，改名的文件即使内容合法也加载不出来。
const WALLPAPER_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];

/// 壁纸文件大小上限（20MB）。超大图片会让 WebView 每次启动都解码一张巨图，
/// 且 asset 资源会整体进内存，代价远超一张背景图的价值。
const WALLPAPER_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// 列出数据目录里已安装的壁纸文件（换图时清掉旧后缀的那份）。
fn existing_wallpaper_paths() -> Vec<PathBuf> {
    let data_dir = crate::data_dir::get_data_dir();
    let Ok(entries) = fs::read_dir(&data_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(WALLPAPER_FILE_STEM))
        })
        .collect()
}

/// 当前壁纸的绝对路径；没有安装时返回 None。
fn current_wallpaper_path() -> Option<PathBuf> {
    existing_wallpaper_paths()
        .into_iter()
        .find(|path| path.is_file())
}

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

/// 检测便携目录写入能力，供设置页在"便携包放在不可写目录"时给出明确指引。
#[tauri::command]
pub fn get_storage_write_diagnostic() -> crate::data_dir::StorageWriteDiagnostic {
    crate::data_dir::get_storage_write_diagnostic()
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

/// 启动时把已安装的壁纸加入 asset 协议白名单。
/// asset scope 不跨进程持久化，每次启动都要重新授权，否则重启后壁纸裂图。
pub fn authorize_wallpaper(app: &tauri::AppHandle) {
    if let Some(path) = current_wallpaper_path() {
        if let Err(error) = app.asset_protocol_scope().allow_file(&path) {
            log::warn!("授权壁纸失败 {}: {}", path.display(), error);
        }
    }
}

/// 打开系统图片选择对话框。
/// 只放行常见静态图片格式：gif 也接受，WebView 能解码，但用户自己选的。
#[tauri::command]
pub async fn pick_wallpaper_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let result = app
        .dialog()
        .file()
        .set_title("选择背景壁纸")
        .add_filter("图片", WALLPAPER_EXTENSIONS)
        .blocking_pick_file();

    Ok(result.map(|p| p.to_string()))
}

/// 安装壁纸：校验文件 → 复制到数据目录 → 清掉旧后缀的壁纸。
/// 返回 asset:// 相对路径交给前端拼 convertFileSrc。
#[tauri::command]
pub fn install_wallpaper(app: tauri::AppHandle, source: String) -> Result<String, String> {
    let source_path = Path::new(&source);
    if !source_path.is_file() {
        return Err("选中的文件不存在".to_string());
    }

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !WALLPAPER_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!("不支持的图片格式：{}", extension));
    }

    let metadata = fs::metadata(source_path).map_err(|error| format!("读取图片失败：{}", error))?;
    if metadata.len() > WALLPAPER_MAX_BYTES {
        return Err("图片不能超过 20MB".to_string());
    }

    let data_dir = crate::data_dir::get_data_dir();
    fs::create_dir_all(&data_dir).map_err(|error| format!("创建数据目录失败：{}", error))?;

    // 先删旧壁纸再复制：新旧后缀不同时（如 png → jpg）不会两份并存。
    for old_path in existing_wallpaper_paths() {
        if let Err(error) = fs::remove_file(&old_path) {
            log::warn!("删除旧壁纸失败 {}: {}", old_path.display(), error);
        }
    }

    let target = data_dir.join(format!("{}.{}", WALLPAPER_FILE_STEM, extension));
    fs::copy(source_path, &target).map_err(|error| format!("保存壁纸失败：{}", error))?;

    // asset 协议默认禁用；只放行这一个文件，不给整个数据目录开权限。
    app.asset_protocol_scope()
        .allow_file(&target)
        .map_err(|error| format!("授权壁纸文件失败：{}", error))?;

    Ok(target.to_string_lossy().to_string())
}

/// 清除壁纸：只删数据目录里我们安装的壁纸文件，不碰用户其它数据。
#[tauri::command]
pub fn clear_wallpaper() -> Result<(), String> {
    for path in existing_wallpaper_paths() {
        fs::remove_file(&path).map_err(|error| format!("删除壁纸失败：{}", error))?;
    }
    Ok(())
}

/// 读取当前壁纸的绝对路径；没有则返回空字符串。
#[tauri::command]
pub fn get_wallpaper_path() -> String {
    current_wallpaper_path()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
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
