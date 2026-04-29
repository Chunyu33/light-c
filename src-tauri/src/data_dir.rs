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
static DATA_DIR_CACHE: std::sync::LazyLock<RwLock<PathBuf>> =
    std::sync::LazyLock::new(|| {
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
                    log::info!(
                        "数据目录 (自定义): {}",
                        custom.display()
                    );
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
    fs::create_dir_all(dest)
        .map_err(|e| format!("创建目标目录失败: {}", e))?;

    for entry_res in
        fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))?
    {
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

/// 清空本地数据：安装历史缓存 + 清理日志
///
/// 【中文说明】
/// 删除 install_history.json 和 logs/ 目录下所有日志文件。
/// 返回 (删除文件数, 释放字节数)。
pub fn clear_local_data() -> Result<(usize, u64), String> {
    let data_dir = get_data_dir();
    let mut file_count = 0usize;
    let mut total_size = 0u64;

    // 删除安装历史缓存
    let history_file = data_dir.join("install_history.json");
    if history_file.exists() && history_file.is_file() {
        if let Ok(meta) = fs::metadata(&history_file) {
            total_size += meta.len();
        }
        fs::remove_file(&history_file)
            .map_err(|e| format!("删除安装历史失败: {}", e))?;
        file_count += 1;
        log::info!("已删除安装历史缓存");
    }

    // 删除所有日志文件
    let logs_dir = data_dir.join("logs");
    if logs_dir.exists() && logs_dir.is_dir() {
        for entry_res in
            fs::read_dir(&logs_dir).map_err(|e| format!("读取日志目录失败: {}", e))?
        {
            let entry =
                entry_res.map_err(|e| format!("读取日志条目失败: {}", e))?;
            let path = entry.path();
            if path.is_file() {
                if let Ok(meta) = fs::metadata(&path) {
                    total_size += meta.len();
                }
                fs::remove_file(&path)
                    .map_err(|e| format!("删除日志文件 {} 失败: {}", path.display(), e))?;
                file_count += 1;
            }
        }
        log::info!("已清空日志目录");
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
