// ============================================================================
// 统一数据目录管理模块
//
// 管理 LightC 所有本地持久化数据的存储目录，包括：
//   - 清理日志 (logs/)
//   - 安装历史缓存 (install_history.json)
//   - ProgramData 快照
//
// 配置固定存储在 %LOCALAPPDATA%/LightC/config/config.json，
// 默认数据存储在 %LOCALAPPDATA%/LightC/data，避免配置和可迁移数据混在一起。
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

/// 基于 LOCALAPPDATA 的应用根目录名，配置和默认数据会在此目录下分区存放。
const APP_ROOT_DIR_NAME: &str = "LightC";

/// 默认数据目录子目录名，避免把 config.json 和日志/快照等运行数据放在同一层级。
const DEFAULT_DATA_DIR_NAME: &str = "data";

/// 配置目录子目录名，配置属于本机应用状态，固定留在 LocalAppData。
const CONFIG_DIR_NAME: &str = "config";

/// 配置文件相对默认目录的文件名
const CONFIG_FILE: &str = "config.json";

/// 迁移数据目录时只复制 LightC 明确拥有的数据，避免用户误选磁盘根目录后把无关文件继续带到新位置。
const MIGRATABLE_DATA_ENTRIES: [&str; 4] = [
    "install_history.json",
    "logs",
    "reg_backups",
    "disk_growth_snapshots",
];

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

/// 应用本机根目录（%LOCALAPPDATA%/LightC），只作为配置和默认数据的父目录。
fn app_local_root_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join(APP_ROOT_DIR_NAME))
}

/// 默认数据目录路径（%LOCALAPPDATA%/LightC/data）
fn default_data_dir() -> Option<PathBuf> {
    app_local_root_dir().map(|dir| dir.join(DEFAULT_DATA_DIR_NAME))
}

/// 配置文件存储路径（始终在独立配置目录下）
fn config_file_path() -> Option<PathBuf> {
    app_local_root_dir().map(|dir| dir.join(CONFIG_DIR_NAME).join(CONFIG_FILE))
}

/// 旧版本曾把配置放在 %LOCALAPPDATA%/LightC/config.json，初始化时需要兼容读取。
fn legacy_config_file_path() -> Option<PathBuf> {
    app_local_root_dir().map(|dir| dir.join(CONFIG_FILE))
}

/// 加载配置或创建默认配置
fn load_or_create() -> PathBuf {
    let default = default_data_dir().unwrap_or_else(|| PathBuf::from("."));

    // 优先读取新的独立配置目录；旧配置只作为兼容入口，成功读取后会写回新位置。
    if let Some((config, from_legacy_config)) = load_existing_config() {
        let configured_data_dir = normalize_legacy_default_data_dir(&config.data_dir, &default);
        if configured_data_dir.is_dir() || fs::create_dir_all(&configured_data_dir).is_ok() {
            save_config_inner(&configured_data_dir);
            log::info!(
                "数据目录 ({}): {}",
                if from_legacy_config {
                    "旧配置迁移"
                } else {
                    "配置"
                },
                configured_data_dir.display()
            );
            return configured_data_dir;
        }
        log::warn!(
            "配置中的数据目录不存在且无法创建: {}，回退到默认",
            configured_data_dir.display()
        );
    }

    // 缺少配置时创建默认配置；若旧版默认目录下已有数据，只迁移 LightC 白名单数据，避免递归复制应用根目录。
    migrate_legacy_default_data_if_needed(&default);
    if let Err(e) = fs::create_dir_all(&default) {
        log::warn!("无法创建默认数据目录 {}: {}", default.display(), e);
    }

    // 首次运行时写入默认配置
    save_config_inner(&default);

    log::info!("数据目录 (默认): {}", default.display());
    default
}

fn load_existing_config() -> Option<(DataDirConfig, bool)> {
    if let Some(config_path) = config_file_path() {
        if let Some(config) = read_config_file(&config_path) {
            return Some((config, false));
        }
    }

    legacy_config_file_path()
        .and_then(|config_path| read_config_file(&config_path))
        .map(|config| (config, true))
}

fn read_config_file(path: &Path) -> Option<DataDirConfig> {
    let json = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<DataDirConfig>(&json) {
        Ok(config) => Some(config),
        Err(error) => {
            // 配置损坏时不继续使用旧值，避免把异常路径写回并放大数据目录问题。
            log::warn!("读取配置文件失败 {}: {}", path.display(), error);
            None
        }
    }
}

fn normalize_legacy_default_data_dir(
    configured_data_dir: &str,
    default_data_dir: &Path,
) -> PathBuf {
    let configured_path = PathBuf::from(configured_data_dir);
    let Some(legacy_root) = app_local_root_dir() else {
        return configured_path;
    };

    let normalized_path =
        normalize_legacy_default_data_dir_inner(&configured_path, &legacy_root, default_data_dir);
    if path_compare_key(&normalized_path) != path_compare_key(&configured_path) {
        // 旧版默认数据目录就是应用根目录；新版本把真实数据迁到 data 子目录，实现配置/数据分离。
        migrate_legacy_default_data_if_needed(default_data_dir);
    }

    normalized_path
}

fn normalize_legacy_default_data_dir_inner(
    configured_path: &Path,
    legacy_root: &Path,
    default_data_dir: &Path,
) -> PathBuf {
    if path_compare_key(configured_path) == path_compare_key(legacy_root) {
        return default_data_dir.to_path_buf();
    }

    configured_path.to_path_buf()
}

fn migrate_legacy_default_data_if_needed(default_data_dir: &Path) {
    let Some(legacy_root) = app_local_root_dir() else {
        return;
    };

    if path_compare_key(&legacy_root) == path_compare_key(default_data_dir) {
        return;
    }

    // 这里只迁移 LightC 明确拥有的数据项，避免把 config、config 目录或用户误放的文件复制进默认数据目录。
    if legacy_root.is_dir() {
        if let Err(error) = migrate_owned_data_entries(&legacy_root, default_data_dir) {
            log::warn!(
                "迁移旧版默认数据目录失败 {} -> {}: {}",
                legacy_root.display(),
                default_data_dir.display(),
                error
            );
        }
    }
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

fn canonical_or_absolute(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|e| format!("解析路径 {} 失败: {}", path.display(), e));
    }

    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    std::env::current_dir()
        .map(|current_dir| current_dir.join(path))
        .map_err(|e| format!("解析当前目录失败: {}", e))
}

fn path_compare_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn is_same_or_child_path(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|remaining| remaining.starts_with('\\'))
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left_key = path_compare_key(left);
    let right_key = path_compare_key(right);

    is_same_or_child_path(&left_key, &right_key) || is_same_or_child_path(&right_key, &left_key)
}

fn ensure_migration_target_is_safe(old_path: &Path, new_path: &Path) -> Result<(), String> {
    let old_key = canonical_or_absolute(old_path)?;
    let new_key = canonical_or_absolute(new_path)?;

    if paths_overlap(&old_key, &new_key) {
        return Err(
            "新的数据目录不能选择当前数据目录本身、其子目录或父目录，请选择一个独立的空文件夹。"
                .to_string(),
        );
    }

    if new_path.exists() && !new_path.is_dir() {
        return Err(format!("新的数据目录不是文件夹: {}", new_path.display()));
    }

    if new_path.exists() && !is_directory_empty(new_path)? {
        return Err("新的数据目录必须是空文件夹，避免把非 LightC 数据混入迁移流程。".to_string());
    }

    Ok(())
}

fn is_directory_empty(path: &Path) -> Result<bool, String> {
    Ok(fs::read_dir(path)
        .map_err(|e| format!("读取目标目录失败 {}: {}", path.display(), e))?
        .next()
        .is_none())
}

fn migrate_owned_data_entries(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;

    for entry_name in MIGRATABLE_DATA_ENTRIES {
        let src_path = src.join(entry_name);
        if !src_path.exists() {
            continue;
        }

        let dest_path = dest.join(entry_name);
        if src_path.is_dir() {
            copy_dir_contents(&src_path, &dest_path)?;
        } else if src_path.is_file() && !dest_path.exists() {
            fs::copy(&src_path, &dest_path)
                .map_err(|e| format!("复制文件 {} 失败: {}", src_path.display(), e))?;
        }
    }

    Ok(())
}

/// 递归复制目录内容，仅供白名单数据目录迁移使用。
fn copy_dir_contents(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {}", e))?;

    for entry_res in fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))? {
        let entry = entry_res.map_err(|e| format!("读取目录条目失败: {}", e))?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_contents(&src_path, &dest_path)?;
        } else if src_path.is_file() && !dest_path.exists() {
            // 初始化和迁移都可能重复执行，目标已有文件时保留新目录中的版本，避免旧数据覆盖新数据。
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
    let old_key = canonical_or_absolute(&old_path)?;
    let new_key = canonical_or_absolute(new_path)?;

    // 相同路径则跳过
    if old_key == new_key {
        return Ok(());
    }

    ensure_migration_target_is_safe(&old_path, new_path)?;

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
        migrate_owned_data_entries(&old_path, new_path)?;
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

    #[test]
    fn separates_config_and_default_data_paths() {
        let config_path = config_file_path().expect("config path should be available");
        let default_dir = default_data_dir().expect("default data dir should be available");

        assert!(path_compare_key(&config_path).contains("\\lightc\\config\\config.json"));
        assert!(path_compare_key(&default_dir).ends_with("\\lightc\\data"));
    }

    #[test]
    fn normalizes_legacy_default_root_to_data_subdir() {
        let legacy_root = app_local_root_dir().expect("app local root should be available");
        let default_dir = default_data_dir().expect("default data dir should be available");

        let normalized =
            normalize_legacy_default_data_dir_inner(&legacy_root, &legacy_root, &default_dir);

        assert_eq!(
            path_compare_key(&normalized),
            path_compare_key(&default_dir)
        );
    }

    #[test]
    fn rejects_nested_migration_target() {
        let old_path = Path::new(r"C:\Users\tester\AppData\Local\LightC");
        let new_path = old_path.join("LightC_Data");

        let result = ensure_migration_target_is_safe(old_path, &new_path);

        assert!(result.is_err());
    }

    #[test]
    fn rejects_non_empty_migration_target() {
        let root =
            std::env::temp_dir().join(format!("lightc-data-dir-test-{}", std::process::id()));
        let old_path = root.join("old");
        let new_path = root.join("new");
        fs::create_dir_all(&old_path).unwrap();
        fs::create_dir_all(&new_path).unwrap();
        fs::write(new_path.join("other.txt"), "not lightc data").unwrap();

        let result = ensure_migration_target_is_safe(&old_path, &new_path);

        let _ = fs::remove_dir_all(&root);
        assert!(result.is_err());
    }

    #[test]
    fn migrates_only_owned_data_entries() {
        let root = std::env::temp_dir().join(format!(
            "lightc-owned-migration-test-{}",
            std::process::id()
        ));
        let old_path = root.join("old");
        let new_path = root.join("new");
        fs::create_dir_all(old_path.join("logs")).unwrap();
        fs::write(old_path.join("logs").join("cleanup.json"), "{}").unwrap();
        fs::write(old_path.join("install_history.json"), "[]").unwrap();
        fs::write(old_path.join("unrelated.txt"), "keep out").unwrap();

        let result = migrate_owned_data_entries(&old_path, &new_path);

        assert!(result.is_ok());
        assert!(new_path.join("logs").join("cleanup.json").is_file());
        assert!(new_path.join("install_history.json").is_file());
        assert!(!new_path.join("unrelated.txt").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
