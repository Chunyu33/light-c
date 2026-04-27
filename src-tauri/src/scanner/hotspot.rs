// ============================================================================
// 大目录分析模块（原 C盘热点扫描）
// 支持两种扫描模式：
// 1. 默认模式：仅扫描 AppData 目录
// 2. 深度扫描模式：全盘扫描 C 盘，使用多线程并行处理
// ============================================================================

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use walkdir::WalkDir;

// ============================================================================
// 数据结构定义
// ============================================================================

/// 大目录条目信息
/// 记录单个文件夹的空间占用和最后修改时间
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotspotEntry {
    /// 文件夹完整路径
    pub path: String,
    /// 文件夹名称
    pub name: String,
    /// 总大小（字节）- 包含所有子文件
    pub total_size: u64,
    /// 文件数量
    pub file_count: usize,
    /// 最后修改时间（Unix 时间戳，毫秒）
    /// 取该目录下所有文件中最晚的修改时间
    pub last_modified: i64,
    /// 父目录类型（Local/Roaming/LocalLow/System/Program 等）
    pub parent_type: String,
    /// 是否为缓存目录（包含 cache/tmp/temp/log/download/thumb 等关键字）
    pub is_cache: bool,
    /// 是否为程序目录（路径包含 Local\Programs）
    pub is_program: bool,
    /// 是否可安全清理（深度扫描模式下强制为 false）
    pub is_safe_to_clean: bool,
    /// 是否为系统保护目录（黑名单目录）
    pub is_protected: bool,
    /// 子目录列表（智能下钻：当目录 >5GB 且 >1000 文件时，展示前 3 个最大子目录）
    #[serde(default)]
    pub children: Vec<HotspotEntry>,
    /// 当前目录的下钻深度（0 = 顶级目录）
    #[serde(default)]
    pub depth: u8,
}

/// 大目录扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotspotScanResult {
    /// 大目录列表（已按大小降序排列）
    pub entries: Vec<HotspotEntry>,
    /// 扫描的总文件夹数
    pub total_folders_scanned: usize,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
    /// 扫描范围总大小（AppData 或 C 盘）
    pub appdata_total_size: u64,
    /// 是否为深度扫描模式
    pub is_full_scan: bool,
}

// ============================================================================
// 危险目录黑名单配置
// 这些目录在深度扫描时仅统计大小，严禁执行任何删除操作
// ============================================================================

/// 系统保护目录黑名单（全盘扫描时禁止清理）
const PROTECTED_DIRECTORIES: &[&str] = &[
    // Windows 核心系统目录
    "Windows",
    "Windows.old",
    "WinSxS",
    "System32",
    "SysWOW64",
    // 系统保护目录
    "System Volume Information",
    "$Recycle.Bin",
    "$WINDOWS.~BT",
    "$WINDOWS.~WS",
    "Recovery",
    "PerfLogs",
    // 程序安装目录
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    // 用户配置目录（部分）
    "Intel",
    "AMD",
    "NVIDIA",
    // 引导相关
    "Boot",
    "EFI",
];

// ============================================================================
// 智能下钻配置
// ============================================================================

/// 触发下钻的最小目录大小（5GB）
const DRILL_DOWN_SIZE_THRESHOLD: u64 = 5 * 1024 * 1024 * 1024;
/// 触发下钻的最小文件数量
const DRILL_DOWN_FILE_COUNT_THRESHOLD: usize = 1000;
/// 最大下钻深度（防止递归过深）
const MAX_DRILL_DOWN_DEPTH: u8 = 3;
/// 下钻时返回的最大子目录数
const DRILL_DOWN_TOP_CHILDREN: usize = 3;

/// 需要跳过扫描的目录（无法访问或无意义）
const SKIP_SCAN_DIRECTORIES: &[&str] = &[
    "System Volume Information",
    "$Recycle.Bin",
    "$WINDOWS.~BT",
    "$WINDOWS.~WS",
    "Config.Msi",
    "MSOCache",
    "Recovery",
];

/// AppData 下需要跳过的系统目录
const APPDATA_SKIP_FOLDERS: &[&str] = &[
    "microsoft",
    "windows",
    "packages",
    "connecteddevicesplatform",
    "comms",
    "history",
    "inetcache",
    "inetcookies",
    "systemcertificates",
];

// ============================================================================
// 大目录扫描引擎
// ============================================================================

/// 大目录扫描引擎
/// 支持两种扫描模式：AppData 扫描和全盘深度扫描
pub struct HotspotScanner {
    /// 是否为深度扫描模式
    full_scan: bool,
    /// 返回的最大条目数
    top_n: usize,
}

impl HotspotScanner {
    /// 创建新的扫描器实例
    ///
    /// # 参数
    /// - `full_scan`: 是否启用全盘深度扫描
    /// - `top_n`: 返回的最大条目数
    pub fn new(full_scan: bool, top_n: usize) -> Self {
        Self { full_scan, top_n }
    }

    /// 执行扫描
    /// 根据 full_scan 参数决定扫描范围
    pub fn scan(&self) -> Result<HotspotScanResult, String> {
        if self.full_scan {
            self.scan_full_disk()
        } else {
            self.scan_appdata()
        }
    }

    // ========================================================================
    // AppData 扫描（默认模式）
    // ========================================================================

    /// 扫描 AppData 目录
    /// 仅扫描 C:\Users\{UserName}\AppData 下的一级子目录
    fn scan_appdata(&self) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();

        let appdata_path = Self::get_appdata_path()?;

        let mut all_entries: Vec<HotspotEntry> = Vec::new();
        let mut total_folders_scanned = 0;
        let mut appdata_total_size: u64 = 0;

        // 扫描三个主要目录：Local, Roaming, LocalLow
        let subdirs = ["Local", "Roaming", "LocalLow"];

        for subdir in &subdirs {
            let target_path = appdata_path.join(subdir);
            if !target_path.exists() {
                continue;
            }

            // 遍历该目录下的一级子文件夹
            match std::fs::read_dir(&target_path) {
                Ok(entries) => {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();

                        if !path.is_dir() {
                            continue;
                        }

                        // 跳过系统保护目录
                        if Self::should_skip_appdata_folder(&path) {
                            continue;
                        }

                        total_folders_scanned += 1;

                        if let Some(stats) = Self::calculate_folder_stats(&path) {
                            appdata_total_size += stats.total_size;

                            let folder_name = path
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default();

                            let path_str = path.to_string_lossy().to_string();
                            let is_cache = Self::is_cache_directory(&path_str, &folder_name);
                            let is_program = path_str.contains("Local\\Programs");

                            all_entries.push(HotspotEntry {
                                path: path_str,
                                name: folder_name,
                                total_size: stats.total_size,
                                file_count: stats.file_count,
                                last_modified: stats.last_modified,
                                parent_type: subdir.to_string(),
                                is_cache,
                                is_program,
                                // AppData 模式下，缓存目录可清理
                                is_safe_to_clean: is_cache,
                                is_protected: false,
                                children: Vec::new(),
                                depth: 0,
                            });
                        }
                    }
                }
                Err(_) => continue,
            }
        }

        // 按大小降序排列
        all_entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        let entries: Vec<HotspotEntry> = all_entries.into_iter().take(self.top_n).collect();
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned,
            scan_duration_ms,
            appdata_total_size,
            is_full_scan: false,
        })
    }

    // ========================================================================
    // 全盘深度扫描（使用 Rayon 多线程并行）
    // ========================================================================

    /// 全盘深度扫描 C 盘
    /// 使用 Rayon 线程池进行多线程并行扫描
    ///
    /// # 安全措施
    /// - 所有结果的 is_safe_to_clean 强制设为 false
    /// - 黑名单目录仅统计大小，标记为 is_protected
    /// - 限制线程数防止 CPU 满载
    ///
    /// # 智能下钻
    /// - 当目录 >5GB 且 >1000 文件时，自动分析子目录
    /// - 最多下钻 3 层，返回每层前 3 个最大子目录
    fn scan_full_disk(&self) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();

        // 配置 Rayon 线程池，限制最大线程数为 CPU 核心数的一半，最少 2 个
        let num_threads = std::cmp::max(2, num_cpus::get() / 2);

        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(num_threads)
            .build()
            .map_err(|e| format!("创建线程池失败: {}", e))?;

        // 获取 C 盘根目录下的一级目录
        let c_drive = PathBuf::from("C:\\");
        let first_level_dirs: Vec<PathBuf> = match std::fs::read_dir(&c_drive) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .filter(|p| !Self::should_skip_scan(p))
                .collect(),
            Err(e) => return Err(format!("无法读取 C 盘根目录: {}", e)),
        };

        // 使用原子计数器统计扫描进度
        let total_scanned = Arc::new(AtomicUsize::new(0));
        let total_size = Arc::new(AtomicU64::new(0));

        // 使用 Rayon 并行扫描每个一级目录
        let all_entries: Vec<HotspotEntry> = pool.install(|| {
            first_level_dirs
                .par_iter()
                .flat_map(|dir| {
                    let scanned = Arc::clone(&total_scanned);
                    let size_counter = Arc::clone(&total_size);

                    self.scan_directory_with_drill_down(dir, &scanned, &size_counter, 0, true)
                })
                .collect()
        });

        // 按大小降序排列
        let mut sorted_entries = all_entries;
        sorted_entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        // 对顶级条目应用智能下钻
        let entries: Vec<HotspotEntry> = sorted_entries
            .into_iter()
            .take(self.top_n)
            .map(|mut entry| {
                // 对每个顶级条目执行下钻分析
                if entry.depth == 0 {
                    entry.children =
                        Self::drill_down_directory(&PathBuf::from(&entry.path), 1, true);
                }
                entry
            })
            .collect();

        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned: total_scanned.load(Ordering::Relaxed),
            scan_duration_ms,
            appdata_total_size: total_size.load(Ordering::Relaxed),
            is_full_scan: true,
        })
    }

    /// 扫描目录并支持智能下钻
    ///
    /// # 参数
    /// - `dir`: 要扫描的目录
    /// - `scanned_counter`: 已扫描目录计数器
    /// - `size_counter`: 总大小计数器
    /// - `current_depth`: 当前扫描深度
    /// - `is_full_scan`: 是否为全盘扫描模式
    fn scan_directory_with_drill_down(
        &self,
        dir: &Path,
        scanned_counter: &Arc<AtomicUsize>,
        size_counter: &Arc<AtomicU64>,
        current_depth: u8,
        is_full_scan: bool,
    ) -> Vec<HotspotEntry> {
        let mut entries = Vec::new();

        let is_protected = Self::is_protected_directory(dir);

        if let Some(stats) = Self::calculate_folder_stats(dir) {
            scanned_counter.fetch_add(1, Ordering::Relaxed);
            size_counter.fetch_add(stats.total_size, Ordering::Relaxed);

            const MIN_SIZE_THRESHOLD: u64 = 100 * 1024 * 1024; // 100MB

            if stats.total_size >= MIN_SIZE_THRESHOLD {
                let folder_name = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                let path_str = dir.to_string_lossy().to_string();
                let is_cache = Self::is_cache_directory(&path_str, &folder_name);
                let is_program = Self::is_program_directory(&path_str);
                let parent_type = Self::get_parent_type(&path_str);

                entries.push(HotspotEntry {
                    path: path_str,
                    name: folder_name,
                    total_size: stats.total_size,
                    file_count: stats.file_count,
                    last_modified: stats.last_modified,
                    parent_type,
                    is_cache,
                    is_program,
                    is_safe_to_clean: !is_full_scan && is_cache && !is_program && !is_protected,
                    is_protected,
                    children: Vec::new(), // 下钻在后处理阶段执行
                    depth: current_depth,
                });
            }
        }

        // 如果是保护目录，不再递归扫描子目录
        if is_protected {
            return entries;
        }

        // 扫描一级子目录
        if let Ok(sub_entries) = std::fs::read_dir(dir) {
            for sub_entry in sub_entries.filter_map(|e| e.ok()) {
                let sub_path = sub_entry.path();

                if sub_path.is_dir() && !Self::should_skip_scan(&sub_path) {
                    if let Some(stats) = Self::calculate_folder_stats(&sub_path) {
                        scanned_counter.fetch_add(1, Ordering::Relaxed);

                        const MIN_SIZE_THRESHOLD: u64 = 100 * 1024 * 1024;

                        if stats.total_size >= MIN_SIZE_THRESHOLD {
                            let folder_name = sub_path
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default();

                            let path_str = sub_path.to_string_lossy().to_string();
                            let is_cache = Self::is_cache_directory(&path_str, &folder_name);
                            let is_program = Self::is_program_directory(&path_str);
                            let parent_type = Self::get_parent_type(&path_str);
                            let is_sub_protected = Self::is_protected_directory(&sub_path);

                            entries.push(HotspotEntry {
                                path: path_str,
                                name: folder_name,
                                total_size: stats.total_size,
                                file_count: stats.file_count,
                                last_modified: stats.last_modified,
                                parent_type,
                                is_cache,
                                is_program,
                                is_safe_to_clean: !is_full_scan
                                    && is_cache
                                    && !is_program
                                    && !is_sub_protected,
                                is_protected: is_sub_protected,
                                children: Vec::new(),
                                depth: current_depth + 1,
                            });
                        }
                    }
                }
            }
        }

        entries
    }

    /// 智能下钻分析：递归分析大目录的子目录结构
    ///
    /// # 触发条件
    /// - 目录大小 > 5GB
    /// - 文件数量 > 1000
    ///
    /// # 限制
    /// - 最大深度 3 层
    /// - 每层返回前 3 个最大子目录
    fn drill_down_directory(
        dir: &Path,
        current_depth: u8,
        is_full_scan: bool,
    ) -> Vec<HotspotEntry> {
        // 超过最大深度，停止下钻
        if current_depth > MAX_DRILL_DOWN_DEPTH {
            return Vec::new();
        }

        // 计算当前目录统计信息
        let stats = match Self::calculate_folder_stats(dir) {
            Some(s) => s,
            None => return Vec::new(),
        };

        // 检查是否满足下钻条件
        if stats.total_size < DRILL_DOWN_SIZE_THRESHOLD
            || stats.file_count < DRILL_DOWN_FILE_COUNT_THRESHOLD
        {
            return Vec::new();
        }

        // 获取所有子目录并计算大小
        let mut sub_dirs: Vec<(PathBuf, FolderStats)> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let sub_path = entry.path();
                if sub_path.is_dir() && !Self::should_skip_scan(&sub_path) {
                    if let Some(sub_stats) = Self::calculate_folder_stats(&sub_path) {
                        // 只考虑大于 100MB 的子目录
                        if sub_stats.total_size >= 100 * 1024 * 1024 {
                            sub_dirs.push((sub_path, sub_stats));
                        }
                    }
                }
            }
        }

        // 按大小降序排列，取前 N 个
        sub_dirs.sort_by(|a, b| b.1.total_size.cmp(&a.1.total_size));

        sub_dirs
            .into_iter()
            .take(DRILL_DOWN_TOP_CHILDREN)
            .map(|(sub_path, sub_stats)| {
                let folder_name = sub_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                let path_str = sub_path.to_string_lossy().to_string();
                let is_cache = Self::is_cache_directory(&path_str, &folder_name);
                let is_program = Self::is_program_directory(&path_str);
                let parent_type = Self::get_parent_type(&path_str);
                let is_protected = Self::is_protected_directory(&sub_path);

                // 递归下钻子目录
                let children =
                    Self::drill_down_directory(&sub_path, current_depth + 1, is_full_scan);

                HotspotEntry {
                    path: path_str,
                    name: folder_name,
                    total_size: sub_stats.total_size,
                    file_count: sub_stats.file_count,
                    last_modified: sub_stats.last_modified,
                    parent_type,
                    is_cache,
                    is_program,
                    is_safe_to_clean: !is_full_scan && is_cache && !is_program && !is_protected,
                    is_protected,
                    children,
                    depth: current_depth,
                }
            })
            .collect()
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 获取 AppData 路径
    fn get_appdata_path() -> Result<PathBuf, String> {
        if let Ok(roaming) = std::env::var("APPDATA") {
            let roaming_path = PathBuf::from(&roaming);
            if let Some(parent) = roaming_path.parent() {
                return Ok(parent.to_path_buf());
            }
        }

        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local_path = PathBuf::from(&local);
            if let Some(parent) = local_path.parent() {
                return Ok(parent.to_path_buf());
            }
        }

        Err("无法获取 AppData 路径".to_string())
    }

    /// 判断是否应该跳过 AppData 下的文件夹
    fn should_skip_appdata_folder(path: &Path) -> bool {
        let folder_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        APPDATA_SKIP_FOLDERS.contains(&folder_name.as_str())
    }

    /// 判断是否应该跳过扫描（无法访问或无意义的目录）
    fn should_skip_scan(path: &Path) -> bool {
        let folder_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // 检查是否在跳过列表中
        for skip_dir in SKIP_SCAN_DIRECTORIES {
            if folder_name.eq_ignore_ascii_case(skip_dir) {
                return true;
            }
        }

        // 跳过以 $ 开头的系统目录
        if folder_name.starts_with('$') {
            return true;
        }

        false
    }

    /// 判断是否为系统保护目录（黑名单）
    fn is_protected_directory(path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        let folder_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        // 检查是否在保护列表中
        for protected in PROTECTED_DIRECTORIES {
            if folder_name.eq_ignore_ascii_case(protected) {
                return true;
            }
        }

        // 检查路径是否包含 Windows 系统目录
        if path_str.contains("\\windows\\") || path_str.ends_with("\\windows") {
            return true;
        }

        // 检查是否为 Program Files 子目录
        if path_str.contains("\\program files\\") || path_str.contains("\\program files (x86)\\") {
            return true;
        }

        false
    }

    /// 判断是否为缓存目录
    fn is_cache_directory(path: &str, folder_name: &str) -> bool {
        let path_lower = path.to_lowercase();
        let name_lower = folder_name.to_lowercase();

        let cache_keywords = [
            "cache",
            "caches",
            "tmp",
            "temp",
            "log",
            "logs",
            "download",
            "downloads",
            "thumb",
            "thumbnails",
            "crashdump",
            "crashreport",
            "backup",
        ];

        for keyword in &cache_keywords {
            if name_lower.contains(keyword) {
                return true;
            }
        }

        if path_lower.contains("\\temp\\") || path_lower.ends_with("\\temp") {
            return true;
        }

        false
    }

    /// 判断是否为程序目录
    fn is_program_directory(path: &str) -> bool {
        let path_lower = path.to_lowercase();
        path_lower.contains("\\programs\\")
            || path_lower.contains("\\program files\\")
            || path_lower.contains("\\program files (x86)\\")
    }

    /// 获取父目录类型
    fn get_parent_type(path: &str) -> String {
        let path_lower = path.to_lowercase();

        if path_lower.contains("\\appdata\\local\\") {
            "Local".to_string()
        } else if path_lower.contains("\\appdata\\roaming\\") {
            "Roaming".to_string()
        } else if path_lower.contains("\\appdata\\locallow\\") {
            "LocalLow".to_string()
        } else if path_lower.contains("\\program files (x86)\\") {
            "Program Files (x86)".to_string()
        } else if path_lower.contains("\\program files\\") {
            "Program Files".to_string()
        } else if path_lower.contains("\\windows\\") {
            "Windows".to_string()
        } else if path_lower.contains("\\users\\") {
            "Users".to_string()
        } else {
            "System".to_string()
        }
    }

    /// 计算文件夹的统计信息
    fn calculate_folder_stats(path: &Path) -> Option<FolderStats> {
        let mut total_size: u64 = 0;
        let mut file_count: usize = 0;
        let mut last_modified: i64 = 0;

        // 使用 WalkDir 递归遍历，限制深度以提高性能
        let walker = WalkDir::new(path)
            .follow_links(false)
            .max_depth(15)
            .into_iter()
            .filter_entry(|e| !Self::is_hidden_system_entry(e));

        for entry in walker {
            match entry {
                Ok(e) => {
                    if e.file_type().is_file() {
                        if let Ok(metadata) = e.metadata() {
                            total_size += metadata.len();
                            file_count += 1;

                            if let Ok(modified) = metadata.modified() {
                                let timestamp = Self::system_time_to_millis(modified);
                                if timestamp > last_modified {
                                    last_modified = timestamp;
                                }
                            }
                        }
                    }
                }
                Err(_) => continue, // 静默跳过权限拒绝等错误
            }
        }

        if file_count == 0 && total_size == 0 {
            return None;
        }

        Some(FolderStats {
            total_size,
            file_count,
            last_modified,
        })
    }

    /// 判断是否为隐藏的系统条目
    fn is_hidden_system_entry(entry: &walkdir::DirEntry) -> bool {
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with('.') && name != "." && name != ".." {
                return true;
            }
        }

        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if let Ok(metadata) = entry.metadata() {
                const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
                const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
                let attrs = metadata.file_attributes();
                if (attrs & FILE_ATTRIBUTE_HIDDEN != 0) && (attrs & FILE_ATTRIBUTE_SYSTEM != 0) {
                    return true;
                }
            }
        }

        false
    }

    /// 将 SystemTime 转换为 Unix 时间戳（毫秒）
    fn system_time_to_millis(time: SystemTime) -> i64 {
        match time.duration_since(SystemTime::UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i64,
            Err(_) => 0,
        }
    }
}

// ============================================================================
// 兼容旧 API 的静态方法
// ============================================================================

impl HotspotScanner {
    /// 兼容旧 API：执行 AppData 扫描
    pub fn scan_legacy(top_n: usize) -> Result<HotspotScanResult, String> {
        let scanner = HotspotScanner::new(false, top_n);
        scanner.scan()
    }

    /// 单层路径钻取扫描（动态下钻功能）
    /// 仅扫描指定路径的直接子文件夹，使用 rayon 并行计算大小
    ///
    /// # 参数
    /// - `path`: 要扫描的目标目录绝对路径
    ///
    /// # 返回
    /// 返回 HotspotScanResult，其中 entries 为该路径下的直接子文件夹列表
    /// 按 total_size 降序排列
    pub fn scan_path_direct(path: &str) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();
        let target = PathBuf::from(path);

        if !target.exists() {
            return Err(format!("路径不存在: {}", path));
        }
        if !target.is_dir() {
            return Err(format!("路径不是文件夹: {}", path));
        }

        // 读取直接子目录
        let sub_dirs: Vec<PathBuf> = std::fs::read_dir(&target)
            .map_err(|e| format!("无法读取目录 {}: {}", path, e))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .filter(|p| !Self::should_skip_scan(p))
            .collect();

        let total_folders_scanned = sub_dirs.len();

        // 使用 rayon 并行计算每个子目录的大小
        let mut entries: Vec<HotspotEntry> = sub_dirs
            .par_iter()
            .filter_map(|sub_path| {
                Self::calculate_folder_stats(sub_path).map(|stats| {
                    let folder_name = sub_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let path_str = sub_path.to_string_lossy().to_string();
                    let is_cache = Self::is_cache_directory(&path_str, &folder_name);
                    let is_program = Self::is_program_directory(&path_str);
                    let parent_type = Self::get_parent_type(&path_str);
                    let is_protected = Self::is_protected_directory(sub_path);

                    HotspotEntry {
                        path: path_str,
                        name: folder_name,
                        total_size: stats.total_size,
                        file_count: stats.file_count,
                        last_modified: stats.last_modified,
                        parent_type,
                        is_cache,
                        is_program,
                        is_safe_to_clean: is_cache && !is_program && !is_protected,
                        is_protected,
                        children: Vec::new(),
                        depth: 0,
                    }
                })
            })
            .collect();

        // 按大小降序排列
        entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        let appdata_total_size = entries.iter().map(|e| e.total_size).sum();
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned,
            scan_duration_ms,
            appdata_total_size,
            is_full_scan: false,
        })
    }
}

/// 文件夹统计信息（内部使用）
struct FolderStats {
    total_size: u64,
    file_count: usize,
    last_modified: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_appdata_path() {
        let result = HotspotScanner::get_appdata_path();
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.exists());
    }

    #[test]
    fn test_scan_appdata() {
        let scanner = HotspotScanner::new(false, 10);
        let result = scanner.scan();
        assert!(result.is_ok());
        let scan_result = result.unwrap();
        assert!(scan_result.entries.len() <= 10);
        assert!(!scan_result.is_full_scan);
    }

    #[test]
    fn test_is_protected_directory() {
        let windows_path = PathBuf::from("C:\\Windows");
        assert!(HotspotScanner::is_protected_directory(&windows_path));

        let program_files = PathBuf::from("C:\\Program Files");
        assert!(HotspotScanner::is_protected_directory(&program_files));
    }
}
