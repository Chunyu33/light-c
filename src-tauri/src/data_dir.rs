// ============================================================================
// 统一数据目录管理模块
//
// 管理 LightC 所有本地持久化数据的存储目录，包括：
//   - 清理日志 (logs/)
//   - 安装历史缓存 (install_history.json)
//   - ProgramData 快照
//
// 安装版配置固定存储在 %LOCALAPPDATA%/LightC/config/config.json，
// 便携版配置和默认数据跟随 exe 存储，避免便携包仍然依赖 AppData。
// 允许用户通过 UI 自定义数据目录路径。更改时自动迁移已有数据。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::RwLock;

use log;

use crate::runtime::{
    current_application_root, current_executable_path, detect_distribution_channel,
    portable_webview_data_directory, DistributionChannel,
};

// ============================================================================
// 常量
// ============================================================================

/// 基于 LOCALAPPDATA 的应用根目录名，配置和默认数据会在此目录下分区存放。
const APP_ROOT_DIR_NAME: &str = "LightC";

/// 默认数据目录子目录名，避免把 config.json 和日志/快照等运行数据放在同一层级。
const DEFAULT_DATA_DIR_NAME: &str = "data";

/// 配置目录子目录名，安装版和便携版都保持独立的 config/data 结构。
const CONFIG_DIR_NAME: &str = "config";

/// 配置文件相对默认目录的文件名
const CONFIG_FILE: &str = "config.json";

/// 迁移状态放在数据目录中，避免把迁移元数据写进用户配置并影响旧版本读取。
const PORTABLE_MIGRATION_DIR: &str = ".migration";
const PORTABLE_MIGRATION_STATE_FILE: &str = "legacy_appdata_v1.json";

/// 迁移数据目录时只复制 LightC 明确拥有的数据，避免用户误选磁盘根目录后把无关文件继续带到新位置。
const MIGRATABLE_DATA_ENTRIES: [&str; 5] = [
    "install_history.json",
    "logs",
    "reg_backups",
    "disk_growth_snapshots",
    "driver_backups",
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
    /// 新版便携版默认目录使用相对值，程序移动后仍然能解析到当前 exe 目录。
    #[serde(default)]
    data_dir_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageLocationInfo {
    pub distribution_channel: DistributionChannel,
    pub config_directory: String,
    pub config_file: String,
    pub default_data_directory: String,
    pub current_data_directory: String,
    pub data_directory_is_custom: bool,
    pub portable_root: Option<String>,
    pub webview_data_directory: Option<String>,
    pub legacy_data_directory: Option<String>,
    pub can_write: bool,
    pub migration_available: bool,
    pub migration_completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PortableMigrationState {
    schema_version: u32,
    completed: bool,
    source_directory: String,
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
    /// 父级目录统计和清理时排除独立管理的子路径，避免同一批文件重复计算或删除。
    excluded_relative_paths: &'static [&'static str],
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ClearableDataType {
    File,
    DirectoryContents,
}

const DISK_GROWTH_SNAPSHOT_DIR: &str = "disk_growth_snapshots";
const DISK_GROWTH_SNAPSHOT_ID_PREFIX: &str = "disk_growth_snapshots_";
const DISK_GROWTH_SNAPSHOT_BASE_ID: &str = "disk_growth_snapshots";
const DISK_GROWTH_SNAPSHOT_BASE_PREFIX: &str = "disk_growth_";
const DISK_GROWTH_SNAPSHOT_JSON_SUFFIX: &str = ".json";
const DISK_GROWTH_SNAPSHOT_SHARD_SUFFIX: &str = ".files";

// 快照项按盘符动态展开，普通白名单只保留固定数据，避免“清空本地数据”误删所有磁盘基线。
const CLEARABLE_DATA_DEFINITIONS: [ClearableDataDefinition; 6] = [
    ClearableDataDefinition {
        id: "install_history",
        label: "安装历史缓存",
        description: "用于辅助卸载残留识别，删除后会重新学习历史安装路径。",
        relative_path: "install_history.json",
        item_type: ClearableDataType::File,
        warning: Some("可安全清理，但卸载残留模块的历史识别信号会重新建立。"),
        excluded_relative_paths: &[],
    },
    ClearableDataDefinition {
        id: "logs",
        label: "清理日志",
        description: "记录历史清理明细，仅用于回看操作记录。",
        relative_path: "logs",
        item_type: ClearableDataType::DirectoryContents,
        warning: None,
        excluded_relative_paths: &["shell_icons.log"],
    },
    ClearableDataDefinition {
        id: "reg_backups",
        label: "注册表备份",
        description: "右键菜单和注册表清理前生成的备份文件。",
        relative_path: "reg_backups",
        item_type: ClearableDataType::DirectoryContents,
        warning: Some("删除后无法再通过这些备份回溯旧注册表清理操作。"),
        excluded_relative_paths: &["shell_icons"],
    },
    ClearableDataDefinition {
        id: "shell_icon_logs",
        label: "虚拟磁盘操作记录",
        description: "记录虚拟磁盘删除、恢复和防复活操作，便于确认处理过哪些入口。",
        relative_path: "logs/shell_icons.log",
        item_type: ClearableDataType::File,
        warning: None,
        excluded_relative_paths: &[],
    },
    ClearableDataDefinition {
        id: "shell_icon_backups",
        label: "虚拟磁盘注册表备份",
        description: "外壳图标清理操作前保存的注册表和权限备份，可用于恢复入口。",
        relative_path: "reg_backups/shell_icons",
        item_type: ClearableDataType::DirectoryContents,
        warning: Some("删除后无法再通过备份恢复已移除的虚拟磁盘入口。"),
        excluded_relative_paths: &[],
    },
    ClearableDataDefinition {
        id: "driver_backups",
        label: "驱动备份",
        description: "旧驱动清理前导出的驱动包备份，文件可能较大。",
        relative_path: "driver_backups",
        item_type: ClearableDataType::DirectoryContents,
        warning: Some("删除后将无法使用这些备份手动恢复已清理的驱动包。默认不会勾选。"),
        excluded_relative_paths: &[],
    },
];

// ============================================================================
// 内部函数
// ============================================================================

/// 安装版应用本机根目录（%LOCALAPPDATA%/LightC），作为旧版数据迁移源。
fn app_local_root_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join(APP_ROOT_DIR_NAME))
}

/// 当前发行包的存储根目录；便携版必须以 exe 所在目录为根。
fn storage_root_dir() -> Option<PathBuf> {
    current_application_root()
}

/// 默认数据目录路径。
fn default_data_dir() -> Option<PathBuf> {
    storage_root_dir().map(|dir| dir.join(DEFAULT_DATA_DIR_NAME))
}

/// 配置文件存储路径；便携版配置也必须跟随 exe，移动整个目录后仍然有效。
fn config_file_path() -> Option<PathBuf> {
    storage_root_dir().map(|dir| dir.join(CONFIG_DIR_NAME).join(CONFIG_FILE))
}

/// 旧版本曾把配置放在 %LOCALAPPDATA%/LightC/config.json，初始化时需要兼容读取。
fn legacy_config_file_path() -> Option<PathBuf> {
    app_local_root_dir().map(|dir| dir.join(CONFIG_FILE))
}

/// 加载配置或创建默认配置
fn load_or_create() -> PathBuf {
    let default = default_data_dir().unwrap_or_else(|| PathBuf::from("."));
    let channel = current_distribution_channel();

    // 先复制旧版配置到便携目录，再解析配置中的数据目录，避免旧配置直接指向 AppData。
    if channel == DistributionChannel::Portable {
        migrate_legacy_portable_config_if_needed();
    }

    if let Some((config, from_legacy_config)) = load_existing_config() {
        let (configured_data_dir, is_legacy_default) =
            resolve_configured_data_dir(&config, &default, channel);
        if is_legacy_default {
            migrate_legacy_data_to_default(&default, channel);
        }
        if configured_data_dir.is_dir() || fs::create_dir_all(&configured_data_dir).is_ok() {
            if let Err(error) = save_config_inner(&configured_data_dir) {
                log::warn!("保存数据目录配置失败: {}", error);
            }
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

    // 缺少配置时迁移旧版默认数据；只复制白名单内容，避免把用户无关文件带入便携包。
    migrate_legacy_data_to_default(&default, channel);
    if let Err(e) = fs::create_dir_all(&default) {
        log::warn!("无法创建默认数据目录 {}: {}", default.display(), e);
    }

    // 首次运行时写入默认配置
    if let Err(error) = save_config_inner(&default) {
        log::warn!("保存默认数据目录配置失败: {}", error);
    }

    log::info!("数据目录 (默认): {}", default.display());
    default
}

fn load_existing_config() -> Option<(DataDirConfig, bool)> {
    if let Some(config_path) = config_file_path() {
        if let Some(config) = read_config_file(&config_path) {
            return Some((config, false));
        }
    }

    if current_distribution_channel() == DistributionChannel::Portable {
        return None;
    }

    legacy_config_file_path()
        .and_then(|config_path| read_config_file(&config_path))
        .map(|config| (config, true))
}

fn read_config_file(path: &Path) -> Option<DataDirConfig> {
    let json = fs::read_to_string(path).ok()?;
    match serde_json::from_str::<DataDirConfig>(json.trim_start_matches('\u{feff}')) {
        Ok(config) => Some(config),
        Err(error) => {
            // 配置损坏时不继续使用旧值，避免把异常路径写回并放大数据目录问题。
            log::warn!("读取配置文件失败 {}: {}", path.display(), error);
            None
        }
    }
}

/// 将旧版默认路径转换为当前发行包的默认路径。
///
/// 只有 AppData 根目录或 AppData/data 被视为旧版默认路径，用户主动选择的自定义路径必须保留。
fn resolve_configured_data_dir(
    config: &DataDirConfig,
    default_data_dir: &Path,
    channel: DistributionChannel,
) -> (PathBuf, bool) {
    if channel == DistributionChannel::Portable
        && config.data_dir_mode.as_deref() == Some("relative")
        && config.data_dir == DEFAULT_DATA_DIR_NAME
    {
        return (default_data_dir.to_path_buf(), true);
    }

    let configured_path = PathBuf::from(&config.data_dir);
    if !configured_path.is_absolute() {
        // 外部配置可能被用户手工修改，禁止让相对路径跟随当前工作目录造成数据写入漂移。
        log::warn!(
            "配置中的数据目录不是绝对路径，将回退到默认目录: {}",
            config.data_dir
        );
        return (default_data_dir.to_path_buf(), true);
    }

    let Some(legacy_root) = app_local_root_dir() else {
        return (configured_path, false);
    };

    let is_legacy_default = if channel == DistributionChannel::Portable {
        let legacy_default = legacy_root.join(DEFAULT_DATA_DIR_NAME);
        path_compare_key(&configured_path) == path_compare_key(&legacy_root)
            || path_compare_key(&configured_path) == path_compare_key(&legacy_default)
    } else {
        path_compare_key(&configured_path) == path_compare_key(&legacy_root)
    };

    if is_legacy_default {
        (default_data_dir.to_path_buf(), true)
    } else {
        (configured_path, false)
    }
}

#[cfg(test)]
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

/// 将旧版 AppData 中的白名单数据复制到当前默认目录，源文件始终保留。
fn migrate_legacy_data_to_default(default_data_dir: &Path, channel: DistributionChannel) {
    let Some(legacy_root) = app_local_root_dir() else {
        return;
    };

    if channel == DistributionChannel::Portable {
        if let Err(error) = migrate_legacy_portable_data_inner(&legacy_root, default_data_dir) {
            log::warn!(
                "迁移旧版便携数据失败 {} -> {}: {}",
                legacy_root.display(),
                default_data_dir.display(),
                error
            );
        }
    } else {
        migrate_legacy_default_data_if_needed(default_data_dir);
    }
}

/// 旧版便携程序实际把数据写在 AppData；新版本只复制明确属于 LightC 的内容。
fn migrate_legacy_portable_data_inner(
    legacy_root: &Path,
    portable_data_dir: &Path,
) -> Result<(), String> {
    let migration_state_path = portable_data_dir
        .join(PORTABLE_MIGRATION_DIR)
        .join(PORTABLE_MIGRATION_STATE_FILE);
    if read_portable_migration_state(&migration_state_path)
        .is_some_and(|state| state.schema_version == 1 && state.completed)
    {
        return Ok(());
    }

    if !legacy_root.is_dir() {
        return Ok(());
    }

    // 同时检查旧版根目录和新版 AppData/data，覆盖多个历史版本的布局。
    let legacy_data_dir = legacy_root.join(DEFAULT_DATA_DIR_NAME);
    migrate_owned_data_entries(legacy_root, portable_data_dir)?;
    if legacy_data_dir.is_dir() {
        migrate_owned_data_entries(&legacy_data_dir, portable_data_dir)?;
    }

    write_portable_migration_state(
        &migration_state_path,
        &PortableMigrationState {
            schema_version: 1,
            completed: true,
            source_directory: legacy_root.to_string_lossy().to_string(),
        },
    )
}

/// 便携版没有本地配置时，先复制旧版配置，后续再把其中的默认数据路径重写为相对目录。
fn migrate_legacy_portable_config_if_needed() {
    let Some(target_path) = config_file_path() else {
        return;
    };
    if target_path.exists() {
        return;
    }

    let Some(legacy_root) = app_local_root_dir() else {
        return;
    };
    let candidates = [
        legacy_root.join(CONFIG_DIR_NAME).join(CONFIG_FILE),
        legacy_root.join(CONFIG_FILE),
    ];

    for source_path in candidates {
        if !source_path.is_file() || read_config_file(&source_path).is_none() {
            continue;
        }

        let Some(parent) = target_path.parent() else {
            return;
        };
        if let Err(error) = fs::create_dir_all(parent) {
            log::warn!("创建便携版配置目录失败 {}: {}", parent.display(), error);
            return;
        }
        if let Err(error) = fs::copy(&source_path, &target_path) {
            log::warn!(
                "复制旧版配置失败 {} -> {}: {}",
                source_path.display(),
                target_path.display(),
                error
            );
        } else {
            log::info!(
                "已复制旧版便携配置 {} -> {}",
                source_path.display(),
                target_path.display()
            );
        }
        return;
    }
}

fn current_distribution_channel() -> DistributionChannel {
    current_executable_path()
        .map(|path| detect_distribution_channel(&path))
        .unwrap_or(DistributionChannel::Installer)
}

fn read_portable_migration_state(path: &Path) -> Option<PortableMigrationState> {
    let json = fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

fn write_portable_migration_state(
    path: &Path,
    state: &PortableMigrationState,
) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err(format!("迁移状态路径无效: {}", path.display()));
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建迁移状态目录失败 {}: {}", parent.display(), error))?;
    let json = serde_json::to_string_pretty(state)
        .map_err(|error| format!("序列化迁移状态失败: {}", error))?;
    fs::write(path, json).map_err(|error| format!("写入迁移状态失败 {}: {}", path.display(), error))
}

/// 持久化配置到磁盘
fn save_config_inner(path: &PathBuf) -> Result<(), String> {
    let cfg_path = config_file_path().ok_or_else(|| "无法确定配置文件路径".to_string())?;
    let parent = cfg_path
        .parent()
        .ok_or_else(|| format!("配置文件路径无效: {}", cfg_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建配置目录失败 {}: {}", parent.display(), error))?;
    let is_portable_default = current_distribution_channel() == DistributionChannel::Portable
        && default_data_dir()
            .is_some_and(|default| path_compare_key(&default) == path_compare_key(path));
    let config = DataDirConfig {
        data_dir: if is_portable_default {
            DEFAULT_DATA_DIR_NAME.to_string()
        } else {
            path.to_string_lossy().to_string()
        },
        data_dir_mode: is_portable_default.then_some("relative".to_string()),
    };
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("序列化数据目录配置失败: {}", error))?;
    fs::write(&cfg_path, json)
        .map_err(|error| format!("写入配置文件失败 {}: {}", cfg_path.display(), error))
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

/// 获取当前配置、默认数据和迁移状态，前端不自行推断便携版路径。
pub fn get_storage_location_info() -> StorageLocationInfo {
    let channel = current_distribution_channel();
    let storage_root = storage_root_dir().unwrap_or_else(|| PathBuf::from("."));
    let config_directory = storage_root.join(CONFIG_DIR_NAME);
    let config_file = config_directory.join(CONFIG_FILE);
    let default_data_directory = get_default_dir();
    let current_data_directory = get_data_dir();
    let legacy_root = app_local_root_dir();
    let migration_state_path = default_data_directory
        .join(PORTABLE_MIGRATION_DIR)
        .join(PORTABLE_MIGRATION_STATE_FILE);
    let migration_completed = read_portable_migration_state(&migration_state_path)
        .is_some_and(|state| state.schema_version == 1 && state.completed);
    let migration_available = channel == DistributionChannel::Portable
        && !migration_completed
        && legacy_root
            .as_deref()
            .is_some_and(has_migratable_data_entries);

    StorageLocationInfo {
        distribution_channel: channel,
        config_directory: config_directory.to_string_lossy().to_string(),
        config_file: config_file.to_string_lossy().to_string(),
        default_data_directory: default_data_directory.to_string_lossy().to_string(),
        current_data_directory: current_data_directory.to_string_lossy().to_string(),
        data_directory_is_custom: path_compare_key(&default_data_directory)
            != path_compare_key(&current_data_directory),
        portable_root: (channel == DistributionChannel::Portable)
            .then(|| storage_root.to_string_lossy().to_string()),
        webview_data_directory: portable_webview_data_directory()
            .map(|path| path.to_string_lossy().to_string()),
        legacy_data_directory: (channel == DistributionChannel::Portable)
            .then(|| {
                legacy_root
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
            })
            .flatten(),
        can_write: can_write_storage(&config_directory, &current_data_directory),
        migration_available,
        migration_completed,
    }
}

/// 手动重试便携版旧数据迁移，供设置页处理自动迁移失败或用户稍后放入的旧数据。
pub fn migrate_legacy_portable_data() -> Result<StorageLocationInfo, String> {
    if current_distribution_channel() != DistributionChannel::Portable {
        return Err("只有便携版支持迁移旧版 AppData 数据。".to_string());
    }

    let legacy_root =
        app_local_root_dir().ok_or_else(|| "无法确定旧版 AppData 数据目录。".to_string())?;
    let default_data_directory = get_default_dir();
    migrate_legacy_portable_data_inner(&legacy_root, &default_data_directory)?;
    Ok(get_storage_location_info())
}

fn has_migratable_data_entries(root: &Path) -> bool {
    let candidate_roots = [root.to_path_buf(), root.join(DEFAULT_DATA_DIR_NAME)];
    candidate_roots.iter().any(|candidate_root| {
        MIGRATABLE_DATA_ENTRIES
            .iter()
            .map(|entry| candidate_root.join(entry))
            .any(|path| path.exists())
    })
}

fn can_write_storage(config_directory: &Path, data_directory: &Path) -> bool {
    // 初始化阶段已经创建过目录，这里只确认当前运行配置仍具备写入能力，不创建测试文件污染用户目录。
    fs::create_dir_all(config_directory).is_ok() && fs::create_dir_all(data_directory).is_ok()
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
    save_config_inner(&path_buf)?;
    *DATA_DIR_CACHE.write().unwrap() = path_buf;

    log::info!("数据目录已更改为: {}", new_path.display());
    Ok(())
}

pub fn list_clearable_data_items() -> Result<Vec<ClearableDataItem>, String> {
    let data_dir = get_data_dir();
    let mut items = CLEARABLE_DATA_DEFINITIONS
        .iter()
        .map(|definition| build_clearable_data_item(&data_dir, definition))
        .collect::<Result<Vec<_>, _>>()?;
    items.extend(build_disk_growth_snapshot_items(&data_dir)?);
    Ok(items)
}

pub fn clear_selected_local_data(item_ids: &[String]) -> Result<ClearLocalDataResult, String> {
    let data_dir = get_data_dir();
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for item_id in item_ids {
        if let Some(drive_letter) = parse_disk_growth_snapshot_item_id(item_id) {
            let snapshot_dir = data_dir.join(DISK_GROWTH_SNAPSHOT_DIR);
            let (deleted_files, deleted_bytes) =
                clear_disk_growth_snapshots_for_drive(&snapshot_dir, drive_letter)?;
            file_count += deleted_files;
            total_size += deleted_bytes;
            continue;
        }

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
    let item_ids = list_clearable_data_items()?
        .into_iter()
        .map(|item| item.id)
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
        ClearableDataType::DirectoryContents => {
            directory_contents_usage(&target_path, definition.excluded_relative_paths)?
        }
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

fn build_disk_growth_snapshot_items(data_dir: &Path) -> Result<Vec<ClearableDataItem>, String> {
    let snapshot_dir = data_dir.join(DISK_GROWTH_SNAPSHOT_DIR);
    if !snapshot_dir.is_dir() {
        return Ok(vec![empty_disk_growth_snapshot_item(&snapshot_dir)]);
    }

    let mut drives = std::collections::BTreeSet::new();
    for entry_res in fs::read_dir(&snapshot_dir).map_err(|e| {
        format!(
            "读取磁盘变化分析快照目录失败 {}: {}",
            snapshot_dir.display(),
            e
        )
    })? {
        let entry = entry_res.map_err(|e| {
            format!(
                "读取磁盘变化分析快照条目失败 {}: {}",
                snapshot_dir.display(),
                e
            )
        })?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(letter) = disk_growth_snapshot_drive_from_name(&name) {
            drives.insert(letter);
        }
    }

    if drives.is_empty() {
        return Ok(vec![empty_disk_growth_snapshot_item(&snapshot_dir)]);
    }

    // 只展示真实存在快照的盘符，弹窗默认全选时不会凭空多出一批空盘符项。
    drives
        .into_iter()
        .map(|drive_letter| build_disk_growth_snapshot_item(&snapshot_dir, drive_letter))
        .collect()
}

fn empty_disk_growth_snapshot_item(snapshot_dir: &Path) -> ClearableDataItem {
    ClearableDataItem {
        id: format!("{}c", DISK_GROWTH_SNAPSHOT_ID_PREFIX),
        label: "C 盘磁盘变化分析快照".to_string(),
        description: "用于 C 盘磁盘变化分析的增长对比基线和分片明细。".to_string(),
        path: snapshot_dir.to_string_lossy().to_string(),
        item_type: "directory".to_string(),
        exists: snapshot_dir.exists(),
        file_count: 0,
        size: 0,
        warning: Some(
            "可安全清理；下次对应磁盘分析会重新建立基线，第二次扫描后才会重新显示变化对比。"
                .to_string(),
        ),
    }
}

fn build_disk_growth_snapshot_item(
    snapshot_dir: &Path,
    drive_letter: char,
) -> Result<ClearableDataItem, String> {
    let (file_count, size) = disk_growth_snapshot_usage_for_drive(snapshot_dir, drive_letter)?;
    let drive_label = format!("{} 盘", drive_letter.to_ascii_uppercase());
    Ok(ClearableDataItem {
        id: format!(
            "{}{}",
            DISK_GROWTH_SNAPSHOT_ID_PREFIX,
            drive_letter.to_ascii_lowercase()
        ),
        label: format!("{}磁盘变化分析快照", drive_label),
        description: format!("用于 {}磁盘变化分析的增长对比基线和分片明细。", drive_label),
        path: snapshot_dir.to_string_lossy().to_string(),
        item_type: "directory".to_string(),
        exists: snapshot_dir.is_dir(),
        file_count,
        size,
        warning: Some(
            "可安全清理；下次对应磁盘分析会重新建立基线，第二次扫描后才会重新显示变化对比。"
                .to_string(),
        ),
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
            let result = clear_directory_contents(target_path, definition.excluded_relative_paths)?;
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

fn clear_disk_growth_snapshots_for_drive(
    snapshot_dir: &Path,
    drive_letter: char,
) -> Result<(usize, u64), String> {
    if !snapshot_dir.is_dir() {
        return Ok((0, 0));
    }

    let mut file_count = 0usize;
    let mut total_size = 0u64;
    for path in disk_growth_snapshot_paths_for_drive(snapshot_dir, drive_letter)? {
        // 分片目录与主快照文件同名同盘符，必须成组删除，否则后续明细查询会看到残缺数据。
        if path.is_dir() {
            let (child_files, child_bytes) = directory_usage(&path, &[])?;
            file_count += child_files;
            total_size += child_bytes;
            fs::remove_dir_all(&path)
                .map_err(|e| format!("删除快照分片目录 {} 失败: {}", path.display(), e))?;
        } else if path.is_file() {
            if let Ok(meta) = fs::metadata(&path) {
                total_size += meta.len();
            }
            fs::remove_file(&path)
                .map_err(|e| format!("删除快照文件 {} 失败: {}", path.display(), e))?;
            file_count += 1;
        }
    }

    log::info!(
        "已清空 {} 盘磁盘变化分析快照",
        drive_letter.to_ascii_uppercase()
    );
    Ok((file_count, total_size))
}

fn disk_growth_snapshot_usage_for_drive(
    snapshot_dir: &Path,
    drive_letter: char,
) -> Result<(usize, u64), String> {
    let mut file_count = 0usize;
    let mut total_size = 0u64;
    for path in disk_growth_snapshot_paths_for_drive(snapshot_dir, drive_letter)? {
        if path.is_dir() {
            let (child_files, child_bytes) = directory_usage(&path, &[])?;
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

fn disk_growth_snapshot_paths_for_drive(
    snapshot_dir: &Path,
    drive_letter: char,
) -> Result<Vec<PathBuf>, String> {
    if !snapshot_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry_res in fs::read_dir(snapshot_dir).map_err(|e| {
        format!(
            "读取磁盘变化分析快照目录失败 {}: {}",
            snapshot_dir.display(),
            e
        )
    })? {
        let entry = entry_res.map_err(|e| {
            format!(
                "读取磁盘变化分析快照条目失败 {}: {}",
                snapshot_dir.display(),
                e
            )
        })?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if disk_growth_snapshot_drive_from_name(name) == Some(drive_letter.to_ascii_uppercase()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn disk_growth_snapshot_drive_from_name(name: &str) -> Option<char> {
    let lower_name = name.to_ascii_lowercase();
    // C 盘沿用历史文件名，不带盘符前缀；其他盘才使用 d_/e_ 这类前缀。
    if lower_name.starts_with(DISK_GROWTH_SNAPSHOT_BASE_PREFIX)
        && (lower_name.ends_with(DISK_GROWTH_SNAPSHOT_JSON_SUFFIX)
            || lower_name.ends_with(DISK_GROWTH_SNAPSHOT_SHARD_SUFFIX))
    {
        return Some('C');
    }

    let mut chars = lower_name.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_lowercase() || chars.next()? != '_' {
        return None;
    }

    let rest = &lower_name[2..];
    if rest.starts_with(DISK_GROWTH_SNAPSHOT_BASE_PREFIX)
        && (rest.ends_with(DISK_GROWTH_SNAPSHOT_JSON_SUFFIX)
            || rest.ends_with(DISK_GROWTH_SNAPSHOT_SHARD_SUFFIX))
    {
        Some(letter.to_ascii_uppercase())
    } else {
        None
    }
}

fn parse_disk_growth_snapshot_item_id(item_id: &str) -> Option<char> {
    if item_id == DISK_GROWTH_SNAPSHOT_BASE_ID {
        return Some('C');
    }

    let suffix = item_id.strip_prefix(DISK_GROWTH_SNAPSHOT_ID_PREFIX)?;
    let mut chars = suffix.chars();
    let letter = chars.next()?;
    if chars.next().is_none() && letter.is_ascii_alphabetic() {
        Some(letter.to_ascii_uppercase())
    } else {
        None
    }
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

fn directory_contents_usage(
    dir: &Path,
    excluded_relative_paths: &[&str],
) -> Result<(usize, u64), String> {
    if !dir.exists() {
        return Ok((0, 0));
    }
    if !dir.is_dir() {
        return Ok((0, 0));
    }

    directory_usage(dir, excluded_relative_paths)
}

/// 清空指定目录下的所有内容但保留目录本身，避免日志目录等固定入口被删后还要重新创建。
fn clear_directory_contents(
    dir: &Path,
    excluded_relative_paths: &[&str],
) -> Result<(usize, u64), String> {
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for entry_res in
        fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {}", dir.display(), e))?
    {
        let entry = entry_res.map_err(|e| format!("读取目录条目失败 {}: {}", dir.display(), e))?;
        let path = entry.path();
        // 独立展示的虚拟磁盘数据由专属清理项处理，父级项目只统计其余内容。
        if entry.file_name().to_str().is_some_and(|name| {
            excluded_relative_paths
                .iter()
                .any(|excluded| *excluded == name)
        }) {
            continue;
        }
        if path.is_dir() {
            let (child_files, child_bytes) = directory_usage(&path, &[])?;
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
fn directory_usage(dir: &Path, excluded_relative_paths: &[&str]) -> Result<(usize, u64), String> {
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    for entry_res in
        fs::read_dir(dir).map_err(|e| format!("统计目录失败 {}: {}", dir.display(), e))?
    {
        let entry = entry_res.map_err(|e| format!("统计目录条目失败 {}: {}", dir.display(), e))?;
        let path = entry.path();
        // 这里只需要过滤当前目录的独立子项，嵌套目录由专属分类整体管理。
        if entry.file_name().to_str().is_some_and(|name| {
            excluded_relative_paths
                .iter()
                .any(|excluded| *excluded == name)
        }) {
            continue;
        }
        if path.is_dir() {
            let (child_files, child_bytes) = directory_usage(&path, &[])?;
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
    fn excludes_virtual_disk_entries_from_parent_usage() {
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("获取测试时间失败")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "lightc-data-dir-test-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("shell_icons")).expect("创建测试目录失败");
        fs::write(root.join("cleanup.json"), "cleanup").expect("创建通用日志失败");
        fs::write(root.join("shell_icons.log"), "shell icon").expect("创建专属日志失败");
        fs::write(root.join("shell_icons").join("backup.reg"), "backup").expect("创建专属备份失败");

        // 通用日志统计排除专属日志，但不会排除其他无关子目录。
        let usage = directory_usage(&root, &["shell_icons.log"]).expect("统计测试目录失败");
        assert_eq!(usage.0, 2);
        assert_eq!(usage.1, "cleanup".len() as u64 + "backup".len() as u64);

        // 通用备份统计排除虚拟磁盘专属目录，避免与专属备份项重复。
        let backup_usage = directory_usage(&root, &["shell_icons"]).expect("统计备份测试目录失败");
        assert_eq!(backup_usage.0, 2);
        assert_eq!(
            backup_usage.1,
            "cleanup".len() as u64 + "shell icon".len() as u64
        );

        let _ = fs::remove_dir_all(&root);
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
    fn portable_relative_config_follows_current_default_directory() {
        let default_dir = PathBuf::from(r"D:\LightC\data");
        let config = DataDirConfig {
            data_dir: DEFAULT_DATA_DIR_NAME.to_string(),
            data_dir_mode: Some("relative".to_string()),
        };

        let (resolved, is_legacy_default) =
            resolve_configured_data_dir(&config, &default_dir, DistributionChannel::Portable);

        assert_eq!(path_compare_key(&resolved), path_compare_key(&default_dir));
        assert!(is_legacy_default);
    }

    #[test]
    fn portable_custom_config_remains_absolute() {
        let default_dir = PathBuf::from(r"D:\LightC\data");
        let custom_dir = PathBuf::from(r"E:\LightCData");
        let config = DataDirConfig {
            data_dir: custom_dir.to_string_lossy().to_string(),
            data_dir_mode: None,
        };

        let (resolved, is_legacy_default) =
            resolve_configured_data_dir(&config, &default_dir, DistributionChannel::Portable);

        assert_eq!(path_compare_key(&resolved), path_compare_key(&custom_dir));
        assert!(!is_legacy_default);
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
