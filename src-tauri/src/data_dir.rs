// ============================================================================
// 统一数据目录管理模块
//
// 管理 LightC 所有本地持久化数据的存储目录，包括：
//   - 清理日志 (logs/)
//   - 安装历史缓存 (install_history.json)
//   - ProgramData 快照
//
// 配置以 config.json 文件存储在默认目录 %LOCALAPPDATA%/LightC/ 下，
// 允许用户通过 UI 自定义数据目录路径。更改时自动迁移已有数据。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::RwLock;

use log;

// ============================================================================
// 常量
// ============================================================================

/// 基于 LOCALAPPDATA 的默认数据目录名
const APP_DATA_DIR_NAME: &str = "LightC";

/// 配置文件相对默认目录的文件名
const CONFIG_FILE: &str = "config.json";

// ============================================================================
// 运行时缓存
// ============================================================================

/// 全局数据目录路径缓存，避免每次读取磁盘
static DATA_DIR_CACHE: std::sync::LazyLock<RwLock<PathBuf>> = std::sync::LazyLock::new(|| {
    let path = load_or_create();
    RwLock::new(path)
});

// ============================================================================
// 数据结构
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DataDirConfig {
    data_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClearableDataItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub path: String,
    pub item_type: String,
    pub exists: bool,
    pub file_count: usize,
    pub size: u64,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClearLocalDataResult {
    pub deleted_files: usize,
    pub freed_bytes: u64,
}

struct ClearableDataDefinition {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    relative_path: &'static str,
    item_type: ClearableDataType,
    warning: Option<&'static str>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ClearableDataType {
    File,
    DirectoryContents,
}

const CLEARABLE_DATA_DEFINITIONS: [ClearableDataDefinition; 4] = [
    ClearableDataDefinition {
        id: "install_history",
        label: "安装历史缓存",
        description: "用于辅助卸载残留识别，删除后会重新学习历史安装路径。",
        relative_path: "install_history.json",
        item_type: ClearableDataType::File,
        warning: Some("可安全清理，但卸载残留模块的历史识别信号会重新建立。"),
    },
    ClearableDataDefinition {
        id: "logs",
        label: "清理日志",
        description: "记录历史清理明细，仅用于回看操作记录。",
        relative_path: "logs",
        item_type: ClearableDataType::DirectoryContents,
        warning: None,
    },
    ClearableDataDefinition {
        id: "reg_backups",
        label: "注册表备份",
        description: "右键菜单和注册表清理前生成的备份文件。",
        relative_path: "reg_backups",
        item_type: ClearableDataType::DirectoryContents,
        warning: Some("删除后无法再通过这些备份回溯旧注册表清理操作。"),
    },
    ClearableDataDefinition {
        id: "disk_growth_snapshots",
        label: "全盘分析快照",
        description: "用于 C 盘全盘分析的增长对比基线和分片明细。",
        relative_path: "disk_growth_snapshots",
        item_type: ClearableDataType::DirectoryContents,
        warning: Some("可安全清理；下次全盘分析会重新建立基线，第二次扫描后才会重新显示变化对比。"),
    },
];

// ============================================================================
// 内部函数
// ============================================================================

/// 默认数据目录路径（%LOCALAPPDATA%/LightC）
fn default_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(APP_DATA_DIR_NAME))
}

/// 配置文件存储路径（始终在默认目录下）
fn config_file_path() -> Option<PathBuf> {
    default_data_dir().map(|d| d.join(CONFIG_FILE))
}

/// 加载配置或创建默认配置
fn load_or_create() -> PathBuf {
    let default = default_data_dir().unwrap_or_else(|| PathBuf::from("."));

    // 尝试从配置文件读取
    if let Some(cfg_path) = config_file_path() {
        if let Ok(json) = fs::read_to_string(&cfg_path) {
            if let Ok(config) = serde_json::from_str::<DataDirConfig>(&json) {
                let custom = PathBuf::from(&config.data_dir);
                if custom.is_dir() || fs::create_dir_all(&custom).is_ok() {
                    log::info!("数据目录 (自定义): {}", custom.display());
                    return custom;
                }
                log::warn!(
                    "自定义数据目录不存在且无法创建: {}，回退到默认",
                    custom.display()
                );
            }
        }
    }

    // 使用默认路径
    if let Err(e) = fs::create_dir_all(&default) {
        log::warn!("无法创建默认数据目录 {}: {}", default.display(), e);
    }

    // 首次运行时写入默认配置
    save_config_inner(&default);

    log::info!("数据目录 (默认): {}", default.display());
    default
}

/// 持久化配置到磁盘
fn save_config_inner(path: &PathBuf) {
    if let Some(cfg_path) = config_file_path() {
        if let Some(parent) = cfg_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let config = DataDirConfig {
            data_dir: path.to_string_lossy().to_string(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(&cfg_path, &json);
        }
    }
}

/// 递归复制目录内容
fn copy_dir_contents(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;

    for entry_res in fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))? {
        let entry = entry_res.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_contents(&src_path, &dest_path)?;
        } else if src_path.is_file() {
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("复制文件 {} 失败: {}", src_path.display(), e))?;
        }
    }

    Ok(())
}

// ============================================================================
// 公共 API
// ============================================================================

/// 获取当前数据目录路径
pub fn get_data_dir() -> PathBuf {
    DATA_DIR_CACHE.read().unwrap().clone()
}

/// 获取默认数据目录路径（UI 显示用）
pub fn get_default_dir() -> PathBuf {
    default_data_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 设置新的数据目录并迁移已有数据
///
/// 【中文说明】
/// 1. 创建新目录
/// 2. 将旧目录中的所有数据复制到新目录
/// 3. 更新运行时缓存和持久化配置文件
///
/// 注意：旧目录数据不会被删除，如需清理请手动操作。
pub fn set_data_dir(new_path: &Path) -> Result<(), String> {
    let old_path = get_data_dir();

    // 相同路径则跳过
    if old_path == new_path {
        return Ok(());
    }

    // 创建新目录
    fs::create_dir_all(new_path)
        .map_err(|e| format!("无法创建数据目录 {}: {}", new_path.display(), e))?;

    // 迁移已有数据
    if old_path.exists() && old_path.is_dir() {
        log::info!(
            "正在迁移数据: {} -> {}",
            old_path.display(),
            new_path.display()
        );
        copy_dir_contents(&old_path, new_path)?;
        log::info!("数据迁移完成");
    }

    // 更新缓存并持久化
    let path_buf = new_path.to_path_buf();
    save_config_inner(&path_buf);
    *DATA_DIR_CACHE.write().unwrap() = path_buf;

    log::info!("数据目录已更改为: {}", new_path.display());
    Ok(())
}

pub fn list_clearable_data_items() -> Result<Vec<ClearableDataItem>, String> {
    let data_dir = get_data_dir();
    CLEARABLE_DATA_DEFINITIONS
        .iter()
        .map(|definition| build_clearable_data_item(&data_dir, definition))
        .collect()
}

pub fn clear_selected_local_data(item_ids: &[String]) -> Result<ClearLocalDataResult, String> {
    let data_dir = get_data_dir();
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for item_id in item_ids {
        let Some(definition) = CLEARABLE_DATA_DEFINITIONS
            .iter()
            .find(|definition| definition.id == item_id)
        else {
            return Err(format!("未知的本地数据清理项: {}", item_id));
        };

        let target_path = data_dir.join(definition.relative_path);
        let (deleted_files, deleted_bytes) = clear_data_item(definition, &target_path)?;
        file_count += deleted_files;
        total_size += deleted_bytes;
    }

    Ok(ClearLocalDataResult {
        deleted_files: file_count,
        freed_bytes: total_size,
    })
}

/// 清空本地数据：保留旧命令兼容，一次性清理所有白名单项。
pub fn clear_local_data() -> Result<(usize, u64), String> {
    let item_ids = CLEARABLE_DATA_DEFINITIONS
        .iter()
        .map(|definition| definition.id.to_string())
        .collect::<Vec<_>>();
    let result = clear_selected_local_data(&item_ids)?;
    Ok((result.deleted_files, result.freed_bytes))
}

fn build_clearable_data_item(
    data_dir: &Path,
    definition: &ClearableDataDefinition,
) -> Result<ClearableDataItem, String> {
    let target_path = data_dir.join(definition.relative_path);
    let (file_count, size) = match definition.item_type {
        ClearableDataType::File => file_usage(&target_path),
        ClearableDataType::DirectoryContents => directory_contents_usage(&target_path)?,
    };

    Ok(ClearableDataItem {
        id: definition.id.to_string(),
        label: definition.label.to_string(),
        description: definition.description.to_string(),
        path: target_path.to_string_lossy().to_string(),
        item_type: match definition.item_type {
            ClearableDataType::File => "file",
            ClearableDataType::DirectoryContents => "directory",
        }
        .to_string(),
        exists: target_path.exists(),
        file_count,
        size,
        warning: definition.warning.map(str::to_string),
    })
}

fn clear_data_item(
    definition: &ClearableDataDefinition,
    target_path: &Path,
) -> Result<(usize, u64), String> {
    match definition.item_type {
        ClearableDataType::File => clear_file(target_path),
        ClearableDataType::DirectoryContents => {
            // 数据目录入口本身由应用复用，只清空目录内容，避免后续日志/快照写入前还要重新创建父目录。
            if !target_path.exists() {
                return Ok((0, 0));
            }
            if !target_path.is_dir() {
                return Err(format!("清理项不是目录: {}", target_path.display()));
            }
            let result = clear_directory_contents(target_path)?;
            log::info!("已清空本地数据目录: {}", definition.relative_path);
            Ok(result)
        }
    }
}

fn clear_file(path: &Path) -> Result<(usize, u64), String> {
    if !path.exists() {
        return Ok((0, 0));
    }
    if !path.is_file() {
        return Err(format!("清理项不是文件: {}", path.display()));
    }

    let size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    fs::remove_file(path).map_err(|e| format!("删除文件 {} 失败: {}", path.display(), e))?;
    Ok((1, size))
}

fn file_usage(path: &Path) -> (usize, u64) {
    if !path.is_file() {
        return (0, 0);
    }

    let size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    (1, size)
}

fn directory_contents_usage(dir: &Path) -> Result<(usize, u64), String> {
    if !dir.exists() {
        return Ok((0, 0));
    }
    if !dir.is_dir() {
        return Ok((0, 0));
    }

    directory_usage(dir)
}

/// 清空指定目录下的所有内容但保留目录本身，避免日志目录等固定入口被删后还要重新创建。
fn clear_directory_contents(dir: &Path) -> Result<(usize, u64), String> {
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for entry_res in
        fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {}", dir.display(), e))?
    {
        let entry = entry_res.map_err(|e| format!("读取目录条目失败 {}: {}", dir.display(), e))?;
        let path = entry.path();
        if path.is_dir() {
            let (child_files, child_bytes) = directory_usage(&path)?;
            file_count += child_files;
            total_size += child_bytes;
            fs::remove_dir_all(&path)
                .map_err(|e| format!("删除目录 {} 失败: {}", path.display(), e))?;
        } else if path.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                total_size += meta.len();
            }
            fs::remove_file(&path)
                .map_err(|e| format!("删除文件 {} 失败: {}", path.display(), e))?;
            file_count += 1;
        }
    }

    Ok((file_count, total_size))
}

/// 删除目录前先统计文件数和空间，保证前端提示的释放量包含嵌套目录内的快照分片。
fn directory_usage(dir: &Path) -> Result<(usize, u64), String> {
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for entry_res in
        fs::read_dir(dir).map_err(|e| format!("统计目录失败 {}: {}", dir.display(), e))?
    {
        let entry = entry_res.map_err(|e| format!("统计目录条目失败 {}: {}", dir.display(), e))?;
        let path = entry.path();
        if path.is_dir() {
            let (child_files, child_bytes) = directory_usage(&path)?;
            file_count += child_files;
            total_size += child_bytes;
        } else if path.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                total_size += meta.len();
            }
            file_count += 1;
        }
    }

    Ok((file_count, total_size))
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_dir_exists() {
        let dir = get_data_dir();
        // 如果目录不存在，至少路径能被创建
        assert!(!dir.as_os_str().is_empty());
    }

    #[test]
    fn test_get_default_dir_not_empty() {
        let dir = get_default_dir();
        assert!(!dir.as_os_str().is_empty());
    }
}
