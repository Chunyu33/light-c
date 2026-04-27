// ============================================================================
// ProgramData 目录扫描模块
// 扫描 C:\ProgramData 目录，统计每个子目录的大小
// 采用两层扫描策略：
// - 第一层：扫描 ProgramData 下的所有一级目录
// - 第二层：仅对超过阈值（默认 100MB）的目录继续扫描一层子目录
// ============================================================================

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// ============================================================================
// 配置常量
// ============================================================================

/// 默认扫描根目录
const DEFAULT_PROGRAMDATA_PATH: &str = "C:\\ProgramData";

/// 触发二级扫描的大小阈值（字节）：100MB
const DEEP_SCAN_THRESHOLD: u64 = 100 * 1024 * 1024;

/// 最大并发扫描目录数（避免文件句柄耗尽）
const MAX_PARALLEL_DIRS: usize = 32;

// ============================================================================
// 数据结构定义
// ============================================================================

/// 目录条目信息
/// 记录单个目录的空间占用、文件数量和子目录信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramDataEntry {
    /// 目录完整路径
    pub path: String,
    /// 目录名称
    pub name: String,
    /// 总大小（字节）- 包含所有子文件和子目录
    pub size: u64,
    /// 文件数量（仅当前目录层级，不含子目录内的文件）
    pub file_count: usize,
    /// 子目录数量
    pub dir_count: usize,
    /// 最后修改时间（Unix 时间戳，毫秒）
    pub last_modified: i64,
    /// 子目录列表（仅当 size > DEEP_SCAN_THRESHOLD 时填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ProgramDataEntry>>,
    /// 当前目录的扫描深度（0 = ProgramData 一级子目录）
    #[serde(default)]
    pub depth: u8,
    /// 是否有访问权限
    #[serde(default = "default_true")]
    pub accessible: bool,
    /// 是否为符号链接
    #[serde(default)]
    pub is_symlink: bool,
}

fn default_true() -> bool {
    true
}

/// ProgramData 扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramDataScanResult {
    /// 一级目录列表（已按大小降序排列）
    pub entries: Vec<ProgramDataEntry>,
    /// 扫描的总目录数
    pub total_dirs_scanned: usize,
    /// 扫描的总文件数
    pub total_files_scanned: usize,
    /// ProgramData 目录总大小（字节）
    pub total_size: u64,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
    /// 无权限访问的目录数
    pub inaccessible_count: usize,
    /// 扫描根路径
    pub root_path: String,
}

/// 扫描配置
#[derive(Debug, Clone)]
pub struct ScanConfig {
    /// 扫描根目录
    pub root_path: PathBuf,
    /// 触发深度扫描的大小阈值（字节）
    pub deep_scan_threshold: u64,
    /// 最大扫描深度（0 = 仅一级目录，1 = 两层）
    pub max_depth: u8,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            root_path: PathBuf::from(DEFAULT_PROGRAMDATA_PATH),
            deep_scan_threshold: DEEP_SCAN_THRESHOLD,
            max_depth: 1,
        }
    }
}

// ============================================================================
// 扫描器实现
// ============================================================================

/// ProgramData 目录扫描器
pub struct ProgramDataScanner {
    config: ScanConfig,
}

impl ProgramDataScanner {
    /// 创建默认配置的扫描器
    pub fn new() -> Self {
        Self {
            config: ScanConfig::default(),
        }
    }

    /// 使用自定义配置创建扫描器
    pub fn with_config(config: ScanConfig) -> Self {
        Self { config }
    }

    /// 执行扫描
    pub fn scan(&self) -> ProgramDataScanResult {
        let start_time = Instant::now();

        // 统计计数器
        let total_dirs = Arc::new(AtomicU64::new(0));
        let total_files = Arc::new(AtomicU64::new(0));
        let inaccessible = Arc::new(AtomicU64::new(0));

        // 获取一级目录列表
        let first_level_dirs = match self.list_first_level_dirs() {
            Ok(dirs) => dirs,
            Err(e) => {
                log::error!("无法读取 ProgramData 目录: {}", e);
                return ProgramDataScanResult {
                    entries: Vec::new(),
                    total_dirs_scanned: 0,
                    total_files_scanned: 0,
                    total_size: 0,
                    scan_duration_ms: start_time.elapsed().as_millis() as u64,
                    inaccessible_count: 1,
                    root_path: self.config.root_path.to_string_lossy().to_string(),
                };
            }
        };

        // 并行扫描一级目录
        let entries: Vec<ProgramDataEntry> = first_level_dirs
            .par_iter()
            .with_max_len(MAX_PARALLEL_DIRS)
            .filter_map(|dir_path| {
                self.scan_directory(dir_path, 0, &total_dirs, &total_files, &inaccessible)
            })
            .collect();

        // 按大小降序排序
        let mut sorted_entries = entries;
        sorted_entries.sort_by(|a, b| b.size.cmp(&a.size));

        // 计算总大小
        let total_size: u64 = sorted_entries.iter().map(|e| e.size).sum();

        ProgramDataScanResult {
            entries: sorted_entries,
            total_dirs_scanned: total_dirs.load(Ordering::Relaxed) as usize,
            total_files_scanned: total_files.load(Ordering::Relaxed) as usize,
            total_size,
            scan_duration_ms: start_time.elapsed().as_millis() as u64,
            inaccessible_count: inaccessible.load(Ordering::Relaxed) as usize,
            root_path: self.config.root_path.to_string_lossy().to_string(),
        }
    }

    /// 列出一级目录
    fn list_first_level_dirs(&self) -> Result<Vec<PathBuf>, std::io::Error> {
        let mut dirs = Vec::new();

        for entry in fs::read_dir(&self.config.root_path)? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue, // 跳过无法读取的条目
            };

            let path = entry.path();

            // 跳过非目录
            if !path.is_dir() {
                continue;
            }

            // 跳过符号链接（避免死循环）
            if is_symlink(&path) {
                continue;
            }

            dirs.push(path);
        }

        Ok(dirs)
    }

    /// 扫描单个目录
    /// 返回 None 表示该目录无法访问
    fn scan_directory(
        &self,
        path: &Path,
        depth: u8,
        total_dirs: &Arc<AtomicU64>,
        total_files: &Arc<AtomicU64>,
        inaccessible: &Arc<AtomicU64>,
    ) -> Option<ProgramDataEntry> {
        total_dirs.fetch_add(1, Ordering::Relaxed);

        // 检查是否为符号链接
        let is_symlink = is_symlink(path);
        if is_symlink {
            return Some(ProgramDataEntry {
                path: path.to_string_lossy().to_string(),
                name: get_dir_name(path),
                size: 0,
                file_count: 0,
                dir_count: 0,
                last_modified: 0,
                children: None,
                depth,
                accessible: true,
                is_symlink: true,
            });
        }

        // 尝试读取目录内容
        let read_result = fs::read_dir(path);
        if read_result.is_err() {
            inaccessible.fetch_add(1, Ordering::Relaxed);
            return Some(ProgramDataEntry {
                path: path.to_string_lossy().to_string(),
                name: get_dir_name(path),
                size: 0,
                file_count: 0,
                dir_count: 0,
                last_modified: 0,
                children: None,
                depth,
                accessible: false,
                is_symlink: false,
            });
        }

        // 统计当前目录
        let (size, file_count, dir_count, last_modified, sub_dirs) =
            self.calculate_dir_stats(path, total_files);

        // 判断是否需要深度扫描子目录
        let children = if depth < self.config.max_depth && size >= self.config.deep_scan_threshold {
            // 并行扫描子目录
            let child_entries: Vec<ProgramDataEntry> = sub_dirs
                .par_iter()
                .with_max_len(MAX_PARALLEL_DIRS)
                .filter_map(|sub_path| {
                    self.scan_directory(sub_path, depth + 1, total_dirs, total_files, inaccessible)
                })
                .collect();

            // 按大小降序排序
            let mut sorted_children = child_entries;
            sorted_children.sort_by(|a, b| b.size.cmp(&a.size));

            if sorted_children.is_empty() {
                None
            } else {
                Some(sorted_children)
            }
        } else {
            None
        };

        Some(ProgramDataEntry {
            path: path.to_string_lossy().to_string(),
            name: get_dir_name(path),
            size,
            file_count,
            dir_count,
            last_modified,
            children,
            depth,
            accessible: true,
            is_symlink: false,
        })
    }

    /// 计算目录统计信息（递归计算总大小）
    /// 返回：(总大小, 文件数, 子目录数, 最后修改时间, 子目录路径列表)
    fn calculate_dir_stats(
        &self,
        path: &Path,
        total_files: &Arc<AtomicU64>,
    ) -> (u64, usize, usize, i64, Vec<PathBuf>) {
        let mut size: u64 = 0;
        let mut file_count: usize = 0;
        let mut dir_count: usize = 0;
        let mut last_modified: i64 = 0;
        let mut sub_dirs: Vec<PathBuf> = Vec::new();

        // 使用 walkdir 递归遍历计算总大小
        for entry in walkdir::WalkDir::new(path)
            .follow_links(false) // 不跟随符号链接
            .into_iter()
            .filter_map(|e| e.ok())
        // 跳过无权限的条目
        {
            let entry_path = entry.path();

            if entry_path == path {
                continue; // 跳过根目录本身
            }

            if entry.file_type().is_file() {
                // 统计文件
                if let Ok(metadata) = entry.metadata() {
                    size += metadata.len();
                    total_files.fetch_add(1, Ordering::Relaxed);

                    // 仅统计直接子文件
                    if entry_path.parent() == Some(path) {
                        file_count += 1;
                    }

                    // 更新最后修改时间
                    if let Ok(modified) = metadata.modified() {
                        let timestamp = system_time_to_millis(modified);
                        if timestamp > last_modified {
                            last_modified = timestamp;
                        }
                    }
                }
            } else if entry.file_type().is_dir() {
                // 统计直接子目录
                if entry_path.parent() == Some(path) {
                    dir_count += 1;
                    if !is_symlink(entry_path) {
                        sub_dirs.push(entry_path.to_path_buf());
                    }
                }
            }
        }

        (size, file_count, dir_count, last_modified, sub_dirs)
    }
}

impl Default for ProgramDataScanner {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 检查路径是否为符号链接
fn is_symlink(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(metadata) => metadata.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// 获取目录名称
fn get_dir_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// 将 SystemTime 转换为毫秒时间戳
fn system_time_to_millis(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================================================================
// 公共 API
// ============================================================================

/// 扫描 ProgramData 目录（使用默认配置）
///
/// # 返回值
/// 返回扫描结果，包含所有一级目录的大小统计
/// 对于超过 100MB 的目录，会额外扫描其子目录
///
/// # 示例
/// ```no_run
/// let result = scan_programdata();
/// println!("总大小: {} bytes", result.total_size);
/// for entry in result.entries {
///     println!("{}: {} bytes", entry.name, entry.size);
/// }
/// ```
pub fn scan_programdata() -> ProgramDataScanResult {
    let scanner = ProgramDataScanner::new();
    scanner.scan()
}

/// 使用自定义阈值扫描 ProgramData 目录
///
/// # 参数
/// - `threshold_mb`: 触发深度扫描的大小阈值（MB）
///
/// # 返回值
/// 返回扫描结果
pub fn scan_programdata_with_threshold(threshold_mb: u64) -> ProgramDataScanResult {
    let config = ScanConfig {
        deep_scan_threshold: threshold_mb * 1024 * 1024,
        ..Default::default()
    };
    let scanner = ProgramDataScanner::with_config(config);
    scanner.scan()
}

/// 扫描指定目录（用于测试或扫描其他类似目录）
///
/// # 参数
/// - `path`: 要扫描的目录路径
/// - `threshold_mb`: 触发深度扫描的大小阈值（MB）
///
/// # 返回值
/// 返回扫描结果
pub fn scan_directory_tree(path: &str, threshold_mb: u64) -> ProgramDataScanResult {
    let config = ScanConfig {
        root_path: PathBuf::from(path),
        deep_scan_threshold: threshold_mb * 1024 * 1024,
        ..Default::default()
    };
    let scanner = ProgramDataScanner::with_config(config);
    scanner.scan()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ScanConfig::default();
        assert_eq!(config.deep_scan_threshold, 100 * 1024 * 1024);
        assert_eq!(config.max_depth, 1);
    }

    #[test]
    fn test_get_dir_name() {
        assert_eq!(
            get_dir_name(Path::new("C:\\ProgramData\\Microsoft")),
            "Microsoft"
        );
        assert_eq!(get_dir_name(Path::new("C:\\ProgramData")), "ProgramData");
    }

    #[test]
    fn test_is_symlink() {
        // 普通目录不应该是符号链接
        let path = Path::new("C:\\ProgramData");
        if path.exists() {
            assert!(!is_symlink(path));
        }
    }
}
