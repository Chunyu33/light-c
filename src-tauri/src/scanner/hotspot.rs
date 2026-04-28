// ============================================================================
// 大目录分析模块（原 C盘热点扫描）
// 支持两种扫描模式：
// 1. 默认模式：仅扫描 AppData 目录
// 2. 深度扫描模式：全盘扫描 C 盘，使用多线程并行处理
// ============================================================================

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::Emitter;
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

/// 扫描进度信息（用于前端实时展示）
#[derive(Debug, Clone, Serialize)]
pub struct HotspotScanProgress {
    /// 当前正在扫描的目录路径
    pub current_dir: String,
    /// 已扫描的文件夹总数
    pub scanned_dirs: usize,
    /// 发现的大目录数（≥100MB）
    pub found_entries: usize,
    /// 已扫描范围的总大小（字节）
    pub total_size: u64,
    /// 一级目录总数（用于进度百分比）
    pub total_first_level_dirs: usize,
}

/// 全局取消标志，跨线程共享（与 big_files.rs 模式一致）
static HOTSPOT_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 重置取消标志（扫描开始前调用）
pub fn reset_hotspot_cancelled() {
    HOTSPOT_SCAN_CANCELLED.store(false, Ordering::SeqCst);
}

/// 设置取消标志（前端点击取消按钮时调用）
pub fn cancel_hotspot_scan() {
    log::info!("收到取消大目录扫描请求");
    HOTSPOT_SCAN_CANCELLED.store(true, Ordering::SeqCst);
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

/// 收录为热点条目的最小目录大小（100MB）
const MIN_SIZE_THRESHOLD: u64 = 100 * 1024 * 1024;
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

    /// 执行扫描（无进度通知，仅用于 AppData 浅扫描和旧 API 兼容）
    /// 深度扫描请使用 `scan_with_ui()` 以获取实时进度
    pub fn scan(&self) -> Result<HotspotScanResult, String> {
        if self.full_scan {
            log::warn!("深度扫描建议使用 scan_with_ui() 以获得进度反馈");
            self.scan_full_disk(None) // 不发送进度事件
        } else {
            self.scan_appdata()
        }
    }

    /// 执行扫描（带实时进度通知）
    /// 前端通过监听 `hotspot-scan:progress` 事件展示进度条
    pub fn scan_with_ui(
        &self,
        app_handle: &tauri::AppHandle,
    ) -> Result<HotspotScanResult, String> {
        if self.full_scan {
            self.scan_full_disk(Some(app_handle))
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

                            all_entries.push(Self::build_entry(&path, &stats, 0, false));
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

    /// 全盘深度扫描 C 盘（优化版）
    ///
    /// 核心优化：每个一级目录只做一次 WalkDir，通过 `aggregate_subtree_stats`
    /// 将文件大小向上聚合到所有祖先目录，消除原先父目录/子目录/下钻的重复遍历。
    ///
    /// # 参数
    /// - `app_handle`: Tauri 应用句柄，用于发送实时进度事件
    ///
    /// # 安全措施
    /// - 所有结果的 is_safe_to_clean 强制设为 false
    /// - 黑名单目录仅统计大小，标记为 is_protected
    /// - 限制线程数防止 CPU 满载
    ///
    /// # 智能下钻
    /// - 当目录 >5GB 且 >1000 文件时，自动分析子目录
    /// - 最多下钻 3 层，返回每层前 3 个最大子目录
    fn scan_full_disk(
        &self,
        app_handle: Option<&tauri::AppHandle>,
    ) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();

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

        let total_first_level = first_level_dirs.len();

        // 共享计数器（Rayon 线程间共享）
        let total_scanned = Arc::new(AtomicUsize::new(0));
        let total_size = Arc::new(AtomicU64::new(0));
        // 共享的目录统计缓存（PathBuf → FolderStats），用于后续下钻查询
        let global_stats_cache: Arc<Mutex<HashMap<PathBuf, FolderStats>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // 使用 Rayon 全局线程池并行处理每个一级目录
        // 每个线程：单次 WalkDir → 聚合子树统计 → 提取 ≥100MB 条目
        let cancel_flag = &HOTSPOT_SCAN_CANCELLED;

        let all_entries: Vec<HotspotEntry> = first_level_dirs
            .par_iter()
            .flat_map(|dir| {
                // 检查取消标志
                if cancel_flag.load(Ordering::SeqCst) {
                    return Vec::new();
                }

                // 跳过保护目录的子目录扫描（如 Windows、Program Files）
                let is_protected_root = Self::is_protected_directory(dir);

                // === 核心优化：单次 WalkDir 聚合子树统计 ===
                let subtree_stats = aggregate_subtree_stats(dir, cancel_flag);

                // 将统计数据合并到全局缓存（供下钻复用）
                {
                    let mut cache = global_stats_cache.lock().unwrap();
                    for (path, stats) in &subtree_stats {
                        cache
                            .entry(path.clone())
                            .or_insert_with(|| FolderStats {
                                total_size: stats.total_size,
                                file_count: stats.file_count,
                                last_modified: stats.last_modified,
                            });
                    }
                }

                // 从 stats map 中提取符合条件的条目
                let mut entries: Vec<HotspotEntry> = Vec::new();

                // 1. 添加一级目录本身（如 C:\Users）
                if let Some(stats) = subtree_stats.get(dir) {
                    total_scanned.fetch_add(1, Ordering::Relaxed);
                    total_size.fetch_add(stats.total_size, Ordering::Relaxed);

                    if stats.total_size >= MIN_SIZE_THRESHOLD {
                        entries.push(Self::build_entry(dir, stats, 0, true));
                    }
                }

                // 2. 添加一级子目录（如 C:\Users\chunyu、C:\Users\Public）
                //    仅当父目录不是保护目录时才添加子目录条目
                if !is_protected_root {
                    if let Ok(read_dir) = std::fs::read_dir(dir) {
                        for sub_entry in read_dir.filter_map(|e| e.ok()) {
                            let sub_path = sub_entry.path();
                            if !sub_path.is_dir() || Self::should_skip_scan(&sub_path) {
                                continue;
                            }

                            if let Some(stats) = subtree_stats.get(&sub_path) {
                                total_scanned.fetch_add(1, Ordering::Relaxed);

                                if stats.total_size >= MIN_SIZE_THRESHOLD {
                                    entries
                                        .push(Self::build_entry(&sub_path, stats, 1, true));
                                }
                            }
                        }
                    }
                }

                // 发送单目录完成进度
                if let Some(app) = app_handle {
                    let progress = HotspotScanProgress {
                        current_dir: dir.to_string_lossy().to_string(),
                        scanned_dirs: total_scanned.load(Ordering::Relaxed),
                        found_entries: 0, // 稍后在汇总阶段更新
                        total_size: total_size.load(Ordering::Relaxed),
                        total_first_level_dirs: total_first_level,
                    };
                    let _ = app.emit("hotspot-scan:progress", &progress);
                }

                entries
            })
            .collect();

        // 检查是否被取消
        if HOTSPOT_SCAN_CANCELLED.load(Ordering::SeqCst) {
            log::info!("大目录扫描被用户取消");
            if let Some(app) = app_handle {
                let _ = app.emit("hotspot-scan:cancelled", ());
            }
            // 返回已扫描的部分结果
            let mut partial: Vec<HotspotEntry> = all_entries;
            partial.sort_by(|a, b| b.total_size.cmp(&a.total_size));
            let partial: Vec<HotspotEntry> = partial.into_iter().take(self.top_n).collect();
            return Ok(HotspotScanResult {
                entries: partial,
                total_folders_scanned: total_scanned.load(Ordering::Relaxed),
                scan_duration_ms: start_time.elapsed().as_millis() as u64,
                appdata_total_size: total_size.load(Ordering::Relaxed),
                is_full_scan: true,
            });
        }

        // 按大小降序排列
        let mut sorted_entries = all_entries;
        sorted_entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        // 对顶级条目应用智能下钻（复用 stats 缓存，无需重新遍历）
        let stats_cache = global_stats_cache.lock().unwrap();
        let entries: Vec<HotspotEntry> = sorted_entries
            .into_iter()
            .take(self.top_n)
            .map(|mut entry| {
                if entry.depth == 0 {
                    entry.children =
                        Self::drill_down_directory_cached(
                            &PathBuf::from(&entry.path),
                            1,
                            true,
                            &stats_cache,
                        );
                }
                entry
            })
            .collect();
        drop(stats_cache);

        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        // 发送完成进度
        if let Some(app) = app_handle {
            let final_progress = HotspotScanProgress {
                current_dir: "扫描完成".to_string(),
                scanned_dirs: total_scanned.load(Ordering::Relaxed),
                found_entries: entries.len(),
                total_size: total_size.load(Ordering::Relaxed),
                total_first_level_dirs: total_first_level,
            };
            let _ = app.emit("hotspot-scan:progress", &final_progress);
        }

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned: total_scanned.load(Ordering::Relaxed),
            scan_duration_ms,
            appdata_total_size: total_size.load(Ordering::Relaxed),
            is_full_scan: true,
        })
    }

    /// 智能下钻分析（带统计缓存，避免重复 WalkDir）
    ///
    /// 与 `drill_down_directory` 功能相同，但优先从缓存中获取子目录统计，
    /// 仅在缓存未命中时才回退为 `calculate_folder_stats()`。
    ///
    /// # 参数
    /// - `dir`: 当前目录
    /// - `current_depth`: 当前深度层级
    /// - `is_full_scan`: 是否为全盘扫描
    /// - `stats_cache`: 子树统计缓存（aggregate_subtree_stats 结果）
    fn drill_down_directory_cached(
        dir: &Path,
        current_depth: u8,
        is_full_scan: bool,
        stats_cache: &HashMap<PathBuf, FolderStats>,
    ) -> Vec<HotspotEntry> {
        // 超过最大深度，停止下钻
        if current_depth > MAX_DRILL_DOWN_DEPTH {
            return Vec::new();
        }

        // 优先从缓存获取统计信息，未命中则回退到 WalkDir
        let stats = match stats_cache.get(dir) {
            Some(s) => FolderStats {
                total_size: s.total_size,
                file_count: s.file_count,
                last_modified: s.last_modified,
            },
            None => match Self::calculate_folder_stats(dir) {
                Some(s) => s,
                None => return Vec::new(),
            },
        };

        // 检查是否满足下钻条件
        if stats.total_size < DRILL_DOWN_SIZE_THRESHOLD
            || stats.file_count < DRILL_DOWN_FILE_COUNT_THRESHOLD
        {
            return Vec::new();
        }

        // 获取所有子目录并从缓存查询大小
        let mut sub_dirs: Vec<(PathBuf, FolderStats)> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let sub_path = entry.path();
                if sub_path.is_dir() && !Self::should_skip_scan(&sub_path) {
                    // 优先从缓存获取
                    let sub_stats_opt = stats_cache.get(&sub_path).cloned().or_else(|| {
                        Self::calculate_folder_stats(&sub_path)
                    });

                    if let Some(sub_stats) = sub_stats_opt {
                        if sub_stats.total_size >= MIN_SIZE_THRESHOLD {
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
                // 递归下钻子目录（继续使用缓存）
                let children = Self::drill_down_directory_cached(
                    &sub_path,
                    current_depth + 1,
                    is_full_scan,
                    stats_cache,
                );

                let mut entry = Self::build_entry(&sub_path, &sub_stats, current_depth, is_full_scan);
                entry.children = children;
                entry
            })
            .collect()
    }

    /// 智能下钻分析（回退接口，用于无缓存场景）
    ///
    /// 触发条件：目录 >5GB 且 >1000 文件 → 递归分析子目录结构
    /// 限制：最大深度 3 层，每层返回前 3 个最大子目录
    fn drill_down_directory(
        dir: &Path,
        current_depth: u8,
        is_full_scan: bool,
    ) -> Vec<HotspotEntry> {
        Self::drill_down_directory_cached(dir, current_depth, is_full_scan, &HashMap::new())
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

        // 从路径末尾提取文件夹名（避免额外 String 分配）
        let folder_name = path_str.rsplit('\\').next().unwrap_or("");

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

    /// 核心构建器：将目录路径和统计信息统一构造为 HotspotEntry
    /// 消除 scan_appdata / scan_full_disk / drill_down / scan_path_direct 中的重复代码
    fn build_entry(path: &Path, stats: &FolderStats, depth: u8, is_full_scan: bool) -> HotspotEntry {
        let path_str = path.to_string_lossy().to_string();
        let folder_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let is_cache = Self::is_cache_directory(&path_str, &folder_name);
        let is_program = Self::is_program_directory(&path_str);
        let parent_type = Self::get_parent_type(&path_str);
        let is_protected = Self::is_protected_directory(path);

        HotspotEntry {
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
            children: Vec::new(),
            depth,
        }
    }
}

// ============================================================================
// 单次遍历目录树聚合（核心性能优化）
// ============================================================================

/// 单次 WalkDir 遍历，将文件大小向上聚合到所有祖先目录
///
/// 替代原有的多次 `calculate_folder_stats()` 调用模式：
/// - 原本：父目录 WalkDir 一次 → 每个子目录再 WalkDir 一次 → 下钻再 WalkDir
/// - 现在：单次 WalkDir，每个文件的 size 向上聚合到所有祖先 → O(1) 查表
fn aggregate_subtree_stats(
    root: &Path,
    cancel_flag: &AtomicBool,
) -> HashMap<PathBuf, FolderStats> {
    let mut stats_map: HashMap<PathBuf, FolderStats> = HashMap::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(15)
        .into_iter()
        .filter_entry(|e| !HotspotScanner::is_hidden_system_entry(e));

    for entry in walker {
        // 检查取消标志
        if cancel_flag.load(Ordering::SeqCst) {
            break;
        }

        match entry {
            Ok(e) => {
                if !e.file_type().is_file() {
                    continue;
                }

                let file_path = e.path();
                let file_size = match e.metadata() {
                    Ok(m) => m.len(),
                    Err(_) => continue,
                };

                let modified_ts = e
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| HotspotScanner::system_time_to_millis(t))
                    .unwrap_or(0);

                // 向上遍历父目录链，将文件大小和元数据聚合到每个祖先
                let mut current = file_path.parent();
                while let Some(parent) = current {
                    // 只在 root 子树内聚合（不超出 root 范围）
                    if !parent.starts_with(root) {
                        break;
                    }

                    let entry_stats = stats_map
                        .entry(parent.to_path_buf())
                        .or_insert_with(|| FolderStats {
                            total_size: 0,
                            file_count: 0,
                            last_modified: 0,
                        });

                    entry_stats.total_size += file_size;
                    entry_stats.file_count += 1;
                    if modified_ts > entry_stats.last_modified {
                        entry_stats.last_modified = modified_ts;
                    }

                    // 到达 root 就停止（不往上走）
                    if parent == root {
                        break;
                    }

                    current = parent.parent();
                }
            }
            Err(_) => continue, // 权限错误静默跳过
        }
    }

    stats_map
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
                Self::calculate_folder_stats(sub_path)
                    .map(|stats| Self::build_entry(sub_path, &stats, 0, false))
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
#[derive(Debug, Clone)]
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
