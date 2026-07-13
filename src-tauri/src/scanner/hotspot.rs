// ============================================================================
// 大目录分析模块（原 C盘热点扫描）
// 支持两种扫描模式：
// 1. 默认模式：仅扫描 AppData 目录
// 2. 深度扫描模式：扫描指定磁盘（顺序 IO + 深度限制 + 巨型目录跳过）
// ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Instant, SystemTime};
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
    /// 扫描范围总大小（AppData 或所选磁盘总计）
    pub scanned_total_size: u64,
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
    /// 已完成的一级目录数（进度百分比 = completed_roots / total_first_level_dirs）
    /// 与 scanned_dirs 不同：后者包含子目录，会超过 100%
    pub completed_roots: usize,
    /// 当前后端：mft / walkdir，用于前端判断是否走了降级方案
    #[serde(default)]
    pub backend: String,
    /// 当前阶段：mft / index / metadata / aggregate / result / walkdir
    #[serde(default)]
    pub stage: String,
    /// 当前阶段展示文案，避免前端只能从 current_dir 猜测瓶颈
    #[serde(default)]
    pub message: String,
    /// 扫描总耗时（毫秒）
    #[serde(default)]
    pub elapsed_ms: u64,
    /// 当前阶段耗时（毫秒）
    #[serde(default)]
    pub stage_elapsed_ms: u64,
}

fn build_hotspot_progress(
    backend: &str,
    stage: &str,
    message: &str,
    processed: usize,
    total_size: u64,
    total_first_level_dirs: usize,
    completed_roots: usize,
    scan_start: &Instant,
    stage_elapsed_ms: u64,
) -> HotspotScanProgress {
    HotspotScanProgress {
        current_dir: message.to_string(),
        scanned_dirs: processed,
        found_entries: 0,
        total_size,
        total_first_level_dirs,
        completed_roots,
        backend: backend.to_string(),
        stage: stage.to_string(),
        message: message.to_string(),
        elapsed_ms: scan_start.elapsed().as_millis() as u64,
        stage_elapsed_ms,
    }
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

/// 暴露给 MFT 引擎的取消状态查询，避免 MFT 阶段无视前端停止按钮继续跑完整流程。
pub(crate) fn is_hotspot_scan_cancelled() -> bool {
    HOTSPOT_SCAN_CANCELLED.load(Ordering::SeqCst)
}

// ============================================================================
// 危险目录黑名单配置
// 这些目录在深度扫描时仅统计大小，严禁执行任何删除操作
// ============================================================================

/// 系统保护目录黑名单（全盘扫描时禁止清理）
/// ProgramData 已移除——其下 Docker/Scoop/VS Code Server 等是用户关心的主要空间占用
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
    // 硬件驱动（无清理价值）
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

/// 收录为热点条目的最小目录大小（默认 50MB，用户可配置）
const MIN_SIZE_THRESHOLD: u64 = 50 * 1024 * 1024;
/// 绝对下限（1MB），防止返回过多细碎条目
const SIZE_THRESHOLD_FLOOR: u64 = 1 * 1024 * 1024;
/// 触发下钻的最小目录大小（5GB）
const DRILL_DOWN_SIZE_THRESHOLD: u64 = 5 * 1024 * 1024 * 1024;
/// 触发下钻的最小文件数量
const DRILL_DOWN_FILE_COUNT_THRESHOLD: usize = 1000;
/// 最大下钻深度
const MAX_DRILL_DOWN_DEPTH: u8 = 8;
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
/// microsoft 和 packages 已移除——Teams/OneDrive/UWP 应用数据是用户关心的主要空间占用
const APPDATA_SKIP_FOLDERS: &[&str] = &[
    "windows",
    "connecteddevicesplatform",
    "comms",
    "history",
    "inetcache",
    "inetcookies",
    "systemcertificates",
];

// ============================================================================
// 巨型系统目录跳过机制（Win11 性能杀手）
// ============================================================================

/// 巨型系统目录（Win11 下文件量暴涨，禁止 WalkDir 深入遍历）
/// 这些目录仅统计根级大小，不递归进入子目录
/// SoftwareDistribution 已移除——Windows Update 缓存体积可达数GB，用户应能看到
const HEAVY_SKIP_DIRS: &[&str] = &[
    "WinSxS",
    "WindowsApps",
    "DriverStore",
    "Installer",
    "Packages",
    "Catroot",
    "assembly",
];

/// 判断目录名是否为巨型系统目录（大小写不敏感，仅匹配末级目录名）
pub(crate) fn is_heavy_system_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|name| HEAVY_SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d)))
        .unwrap_or(false)
}

// ============================================================================
// 噪音目录配置（不参与 TopN 排名，避免污染结果）
// ============================================================================

/// 噪音系统目录（允许统计和展示，但不参与 TopN 排名竞争）
/// 这些目录体积大但用户无法清理，如 WinSxS、System32 等
const NOISE_DIRECTORIES: &[&str] = &[
    "WinSxS",
    "System32",
    "SysWOW64",
    "assembly",
    "DriverStore",
    "WindowsApps",
];

/// 判断目录名是否为噪音目录（大小写不敏感，仅匹配末级目录名）
fn is_noise_directory(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|name| {
            NOISE_DIRECTORIES
                .iter()
                .any(|d| name.eq_ignore_ascii_case(d))
        })
        .unwrap_or(false)
}

/// 触发热点展开的大小阈值（20GB）
/// 大于此值的非保护目录会被"展开"——用其子目录替代它参与 TopN 竞争
const EXPAND_SIZE_THRESHOLD: u64 = 20 * 1024 * 1024 * 1024;

/// 隐藏/系统目录的核心名称判断（不调用 metadata()，避免 Win11 Defender IO 拦截）
/// 仅基于文件名规则：前缀为 . 或 $ 的隐藏/系统目录
fn is_hidden_name(name: &str) -> bool {
    if name.starts_with('.') && name != "." && name != ".." {
        return true;
    }
    if name.starts_with('$') {
        return true;
    }
    if name.eq_ignore_ascii_case("System Volume Information") {
        return true;
    }
    false
}

/// Fast 模式文件名过滤（不调用 metadata()，避免 Win11 Defender IO 拦截）
fn is_hidden_by_name(entry: &walkdir::DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|n| is_hidden_name(n))
        .unwrap_or(false)
}

/// 基于 Path 的隐藏判断（用于 jwalk 的 process_read_dir 回调，不依赖 DirEntry）
pub(crate) fn is_hidden_by_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| is_hidden_name(n))
        .unwrap_or(false)
}

/// 计算 path 相对于 root 的层级深度
/// 例如 root=C:\ 时，C:\Users → 1，C:\Users\Evan → 2
fn calculate_relative_depth(root: &Path, path: &Path) -> usize {
    path.strip_prefix(root)
        .map(|p| p.components().count())
        .unwrap_or(0)
}

// ============================================================================
// 扫描精度模式
// ============================================================================

/// 扫描精度模式
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScanAccuracyMode {
    /// 快速模式（默认）：
    /// - max_depth = 4，跳过 HEAVY_SKIP_DIRS
    /// - 不读取 modified time，只统计 size + file_count
    Fast,
    /// 精确模式（用户主动开启）：
    /// - max_depth = 10，保留 modified
    /// - 允许更深扫描
    Accurate,
}

impl ScanAccuracyMode {
    /// 获取对应模式的扫描深度
    fn max_depth(self) -> u8 {
        match self {
            ScanAccuracyMode::Fast => 6,
            ScanAccuracyMode::Accurate => 10,
        }
    }

    /// 是否需要在文件遍历时收集 modified time
    fn track_modified(self) -> bool {
        match self {
            ScanAccuracyMode::Fast => false,
            ScanAccuracyMode::Accurate => true,
        }
    }
}

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
    /// 扫描精度（默认 Fast）
    accuracy_mode: ScanAccuracyMode,
    /// 最大展示深度（以扫描根路径为 Level 0，默认 3，范围 2-5）
    max_display_depth: usize,
    /// 扫描深度（控制 WalkDir/jwalk 的 max_depth，独立于展示深度）
    /// Fast 模式固定 6 层，足以覆盖 AppData/Local/App/Cache 深度
    scan_depth: u8,
    /// 最小展示大小阈值（字节，默认 50MB）
    size_threshold: u64,
    /// 深度扫描时是否忽略系统保护目录（默认 true）
    /// 关闭后 Windows/Program Files/ProgramData 等目录的子目录也会纳入结果
    ignore_system_dirs: bool,
    /// 深度扫描目标盘符；AppData 模式仍按当前用户目录扫描，不受此字段影响。
    drive_letter: char,
}

impl HotspotScanner {
    /// 创建新的扫描器实例
    ///
    /// # 参数
    /// - `full_scan`: 是否启用全盘深度扫描
    /// - `top_n`: 返回的最大条目数
    pub fn new(full_scan: bool, top_n: usize) -> Self {
        Self {
            full_scan,
            top_n,
            accuracy_mode: ScanAccuracyMode::Fast,
            max_display_depth: 3,
            scan_depth: 6, // Fast 模式固定 6 层，覆盖 AppData/Local/App/Cache 深度
            size_threshold: MIN_SIZE_THRESHOLD,
            ignore_system_dirs: true, // 默认忽略系统目录，保持现有行为
            drive_letter: 'C',
        }
    }

    /// 设置扫描精度模式（链式调用）
    /// 同时联动设置 scan_depth：Fast=6, Accurate=10
    pub fn with_accuracy(mut self, mode: ScanAccuracyMode) -> Self {
        self.accuracy_mode = mode;
        self.scan_depth = match mode {
            ScanAccuracyMode::Fast => 6,
            ScanAccuracyMode::Accurate => 10,
        };
        self
    }

    /// 设置最大展示深度（可用于设置面板联动）
    pub fn with_display_depth(mut self, depth: usize) -> Self {
        self.max_display_depth = depth.clamp(2, 4); // 最大 4 层，超过无实际差异
        self
    }

    /// 设置大小阈值
    pub fn with_size_threshold(mut self, threshold: u64) -> Self {
        self.size_threshold = threshold.max(SIZE_THRESHOLD_FLOOR);
        self
    }

    /// 设置是否忽略系统保护目录（仅对深度扫描生效）
    /// 关闭后可发现藏在 Windows/Program Files/ProgramData 下的异常大文件
    pub fn with_ignore_system_dirs(mut self, ignore: bool) -> Self {
        self.ignore_system_dirs = ignore;
        self
    }

    /// 设置深度扫描目标盘符，避免多盘模式下仍固定扫系统盘。
    pub fn with_drive_letter(mut self, drive_letter: char) -> Self {
        self.drive_letter = drive_letter.to_ascii_uppercase();
        self
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
    pub fn scan_with_ui(&self, app_handle: &tauri::AppHandle) -> Result<HotspotScanResult, String> {
        if self.full_scan {
            self.scan_full_disk(Some(app_handle))
        } else {
            self.scan_appdata()
        }
    }

    // ========================================================================
    // AppData 扫描（默认模式）
    // ========================================================================

    /// 扫描 AppData 目录（默认模式）
    /// 使用 jwalk 单次遍历 + 祖先聚合，替代原有的逐子目录 WalkDir 循环
    fn scan_appdata(&self) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();

        let appdata_path = Self::get_appdata_path()?;

        let max_depth = self.scan_depth; // 扫描深度（固定 6），独立于展示深度
        let track_modified = self.accuracy_mode.track_modified();
        let cancel_flag = AtomicBool::new(false); // AppData 扫描不支持取消

        // 单次 jwalk 遍历 AppData，祖先聚合所有层级
        let (root_stats, ancestor_map) = aggregate_ancestor_stats(
            &appdata_path,
            max_depth,
            track_modified,
            &cancel_flag,
            true, /* AppData 扫描无系统目录 */
        );

        let scanned_total_size = root_stats.total_size;

        // 从 ancestor_map 筛选符合条件的条目
        let candidate_pairs: Vec<(PathBuf, FolderStats, usize)> = ancestor_map
            .into_iter()
            .filter(|(path, stats)| {
                if stats.total_size < self.size_threshold {
                    return false;
                }
                if Self::should_skip_appdata_folder(path) {
                    return false;
                }
                let depth = calculate_relative_depth(&appdata_path, path);
                // 多包含一层子节点，确保最后一层展示深度的条目也能显示子目录
                depth > 0 && depth <= self.max_display_depth + 1
            })
            .map(|(path, stats)| {
                let depth = calculate_relative_depth(&appdata_path, &path);
                (path, stats, depth)
            })
            .collect();

        let total_folders_scanned = candidate_pairs.len();

        // 只保留 depth=1 的条目作为顶级结果，递归构建子树
        let mut top_entries: Vec<HotspotEntry> = Vec::new();
        for (dir_path, dir_stats, depth) in candidate_pairs.iter().filter(|(_, _, d)| *d == 1) {
            let mut entry = Self::build_entry(dir_path, dir_stats, *depth as u8, false);
            // 多给一层深度，让末级条目也能构建子节点
            entry.children = Self::build_children_from_pairs(
                dir_path,
                2,
                self.max_display_depth + 1,
                &candidate_pairs,
            );
            top_entries.push(entry);
        }

        // 按大小降序排列
        top_entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        let entries: Vec<HotspotEntry> = top_entries.into_iter().take(self.top_n).collect();
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned,
            scan_duration_ms,
            scanned_total_size,
            is_full_scan: false,
        })
    }

    // ========================================================================
    // 全盘深度扫描（单次遍历 + 祖先聚合）
    // ========================================================================

    /// 全盘扫描指定磁盘（顺序 IO + 深度限制 + 祖先聚合 + 巨型目录跳过）
    ///
    /// v2.4.5 新增 MFT 直读引擎：管理员 + NTFS 时秒级全盘扫描，非管理员自动降级到 jwalk
    fn scan_full_disk(
        &self,
        app_handle: Option<&tauri::AppHandle>,
    ) -> Result<HotspotScanResult, String> {
        use crate::scanner::hotspot_engine::engine_selector::{self, HotspotBackend};

        let start_time = std::time::Instant::now();

        let scan_root = PathBuf::from(format!("{}:\\", self.drive_letter));
        let first_level_dirs: Vec<PathBuf> = match std::fs::read_dir(&scan_root) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .filter(|p| !Self::should_skip_scan(p))
                .collect(),
            Err(e) => return Err(format!("无法读取 {} 盘根目录: {}", self.drive_letter, e)),
        };

        let total_first_level = first_level_dirs.len();
        let max_depth = self.scan_depth;
        let track_modified = self.accuracy_mode.track_modified();

        let total_scanned = AtomicUsize::new(0);
        let total_size = AtomicU64::new(0);
        let completed_roots = AtomicUsize::new(0);

        let mut all_entries: Vec<HotspotEntry> = Vec::new();
        let mut ancestor_cache: HashMap<PathBuf, FolderStats> = HashMap::new();
        let cancel_flag = &HOTSPOT_SCAN_CANCELLED;

        // ========================================================================
        // 尝试 MFT 直读引擎（管理员 + NTFS）
        // ========================================================================
        let backend = engine_selector::detect_backend(self.drive_letter);

        match backend {
            HotspotBackend::Mft => {
                log::info!("[全盘扫描] 使用 MFT 直读引擎扫描 {} 盘", self.drive_letter);
                if let Some(app) = app_handle {
                    let _ = app.emit(
                        "hotspot-scan:progress",
                        build_hotspot_progress(
                            "mft",
                            "mft",
                            "MFT 直读引擎已就绪，正在读取主文件表...",
                            0,
                            0,
                            total_first_level,
                            0,
                            &start_time,
                            0,
                        ),
                    );
                }

                let (mft_map, actual_backend) = engine_selector::scan_full_drive(
                    self.drive_letter,
                    &scan_root,
                    max_depth,
                    track_modified,
                    cancel_flag,
                    |progress| {
                        // MFT 进度 → 前端事件
                        if let Some(app) = app_handle {
                            let _ = app.emit(
                                "hotspot-scan:progress",
                                build_hotspot_progress(
                                    "mft",
                                    progress.stage,
                                    &progress.message,
                                    progress.processed,
                                    0,
                                    total_first_level,
                                    (progress.processed / 50000)
                                        .min(total_first_level.saturating_sub(1)),
                                    &start_time,
                                    progress.stage_elapsed_ms,
                                ),
                            );
                        }
                    },
                );

                ancestor_cache = mft_map;

                log::info!(
                    "[全盘扫描] {} 引擎完成，{} 个目录，开始构建结果...",
                    actual_backend.label(),
                    ancestor_cache.len()
                );

                if let Some(root_stats) = ancestor_cache.get(&scan_root) {
                    // MFT 聚合后的每个目录都包含全部后代，不能把列表项大小再次相加，否则会重复计算祖先目录。
                    total_size.store(root_stats.total_size, Ordering::Relaxed);
                }

                // 从 ancestor_cache 构建 all_entries（与 Walkdir 路径一致的逻辑）
                for (path, stats) in &ancestor_cache {
                    if stats.total_size >= self.size_threshold {
                        let depth = calculate_relative_depth(&scan_root, path);
                        if depth > 0 && depth <= self.max_display_depth {
                            total_scanned.fetch_add(1, Ordering::Relaxed);
                            all_entries.push(Self::build_entry(path, stats, depth as u8, true));
                        }
                    }
                }

                // 补加一级目录的根条目
                for dir in &first_level_dirs {
                    if let Some(root_stats) = ancestor_cache.get(dir) {
                        if root_stats.total_size >= self.size_threshold {
                            let dir_depth = calculate_relative_depth(&scan_root, dir);
                            all_entries.push(Self::build_entry(
                                dir,
                                root_stats,
                                dir_depth as u8,
                                true,
                            ));
                        }
                    }
                }
            }

            // ========================================================================
            // 降级：jwalk 逐目录遍历
            // ========================================================================
            HotspotBackend::Walkdir => {
                log::info!(
                    "[全盘扫描] 使用 jwalk 常规遍历扫描 {} 盘",
                    self.drive_letter
                );

                // 顺序扫描每个一级目录（IO 密集型任务，避免 SSD 随机 IO 风暴）
                for dir in &first_level_dirs {
                    if cancel_flag.load(Ordering::SeqCst) {
                        break;
                    }

                    let is_protected_root = Self::is_protected_directory(dir);
                    let dir_depth = calculate_relative_depth(&scan_root, dir);

                    let (root_stats, ancestor_map) = aggregate_ancestor_stats(
                        dir,
                        max_depth,
                        track_modified,
                        cancel_flag,
                        self.ignore_system_dirs,
                    );

                    // 合并到全局祖先缓存
                    ancestor_cache.insert(dir.clone(), root_stats);
                    for (path, stats) in &ancestor_map {
                        ancestor_cache
                            .entry(path.clone())
                            .and_modify(|existing| {
                                if stats.total_size > existing.total_size {
                                    *existing = *stats;
                                }
                            })
                            .or_insert(*stats);
                    }

                    // 1. 添加根目录条目
                    if root_stats.file_count > 0 {
                        total_scanned.fetch_add(1, Ordering::Relaxed);
                        total_size.fetch_add(root_stats.total_size, Ordering::Relaxed);
                        if root_stats.total_size >= self.size_threshold {
                            all_entries.push(Self::build_entry(
                                dir,
                                &root_stats,
                                dir_depth as u8,
                                true,
                            ));
                        }
                    }

                    // 2. 从 ancestor_map 提取符合条件的祖先条目
                    let hide_ancestors = is_protected_root && self.ignore_system_dirs;
                    if !hide_ancestors {
                        for (path, stats) in &ancestor_map {
                            if stats.total_size >= self.size_threshold {
                                let depth = calculate_relative_depth(&scan_root, path);
                                if depth <= dir_depth + self.max_display_depth {
                                    total_scanned.fetch_add(1, Ordering::Relaxed);
                                    all_entries.push(Self::build_entry(
                                        path,
                                        stats,
                                        depth as u8,
                                        true,
                                    ));
                                }
                            }
                        }
                    }

                    completed_roots.fetch_add(1, Ordering::Relaxed);

                    if let Some(app) = app_handle {
                        let completed = completed_roots.load(Ordering::Relaxed);
                        let message = format!(
                            "正在常规遍历 {} ({}/{})",
                            dir.to_string_lossy(),
                            completed,
                            total_first_level
                        );
                        let _ = app.emit(
                            "hotspot-scan:progress",
                            build_hotspot_progress(
                                "walkdir",
                                "walkdir",
                                &message,
                                total_scanned.load(Ordering::Relaxed),
                                total_size.load(Ordering::Relaxed),
                                total_first_level,
                                completed,
                                &start_time,
                                0,
                            ),
                        );
                    }
                }
            }
        }

        // 热点展开 + 树形构建（两种引擎共用，逻辑不变）

        // 检查是否被取消
        if cancel_flag.load(Ordering::SeqCst) {
            log::info!("大目录扫描被用户取消");
            if let Some(app) = app_handle {
                let _ = app.emit("hotspot-scan:cancelled", ());
            }
            all_entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));
            let partial: Vec<HotspotEntry> = all_entries.into_iter().take(self.top_n).collect();
            return Ok(HotspotScanResult {
                entries: partial,
                total_folders_scanned: total_scanned.load(Ordering::Relaxed),
                scan_duration_ms: start_time.elapsed().as_millis() as u64,
                scanned_total_size: total_size.load(Ordering::Relaxed),
                is_full_scan: true,
            });
        }

        let result_stage_start = Instant::now();
        if let Some(app) = app_handle {
            let _ = app.emit(
                "hotspot-scan:progress",
                build_hotspot_progress(
                    match backend {
                        HotspotBackend::Mft => "mft",
                        HotspotBackend::Walkdir => "walkdir",
                    },
                    "result",
                    "正在生成热点目录列表",
                    total_scanned.load(Ordering::Relaxed),
                    total_size.load(Ordering::Relaxed),
                    total_first_level,
                    completed_roots.load(Ordering::Relaxed),
                    &start_time,
                    0,
                ),
            );
        }

        // 先用聚合缓存建立父子索引，后续热点展开和树形结果都只查内存。
        // 这样既能保持“展示深度”设置生效，也避免 result 阶段反复 read_dir 触发磁盘 IO。
        let child_index = build_child_index(
            &ancestor_cache,
            &scan_root,
            self.size_threshold,
            self.ignore_system_dirs,
        );

        // 热点展开：递归展开容器目录（Windows/Program Files 等），
        // 将排行榜让给用户真正关心的可清理热点（微信/npm/Docker 等）
        // 噪音目录（WinSxS/System32 等）是否过滤由系统目录设置决定
        let mut entries = flatten_hotspots(
            all_entries,
            &child_index,
            self.top_n,
            true,
            self.ignore_system_dirs,
        );

        // 按用户设置的展示深度补齐结果树。这里的深度是“从当前热点条目算起”的可见层数，
        // 与前端 treeDepth 判断保持一致：设置为 4 时，顶级热点 + 3 层子目录都会返回。
        for entry in &mut entries {
            let entry_path = PathBuf::from(&entry.path);
            let child_max_depth = entry
                .depth
                .saturating_add(self.max_display_depth.saturating_sub(1) as u8);
            entry.children =
                build_tree_children_from_index(&entry_path, child_max_depth, &child_index, true);
        }

        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        if let Some(app) = app_handle {
            let mut final_progress = build_hotspot_progress(
                match backend {
                    HotspotBackend::Mft => "mft",
                    HotspotBackend::Walkdir => "walkdir",
                },
                "result",
                "扫描完成",
                total_scanned.load(Ordering::Relaxed),
                total_size.load(Ordering::Relaxed),
                total_first_level,
                completed_roots.load(Ordering::Relaxed),
                &start_time,
                result_stage_start.elapsed().as_millis() as u64,
            );
            final_progress.found_entries = entries.len();
            let _ = app.emit("hotspot-scan:progress", &final_progress);
        }

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned: total_scanned.load(Ordering::Relaxed),
            scan_duration_ms,
            scanned_total_size: total_size.load(Ordering::Relaxed),
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
            None => match Self::calculate_folder_stats(dir, 6, true) {
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
                if sub_path.is_dir()
                    && !Self::should_skip_scan(&sub_path)
                    && !is_heavy_system_dir(&sub_path)
                {
                    // 优先从缓存获取
                    let sub_stats_opt = stats_cache
                        .get(&sub_path)
                        .cloned()
                        .or_else(|| Self::calculate_folder_stats(&sub_path, 4, true));

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

                let mut entry =
                    Self::build_entry(&sub_path, &sub_stats, current_depth, is_full_scan);
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

    /// 构建保护目录的单层直接子目录列表（不递归下钻）
    ///
    /// 保护目录（C:\Windows 等）的子目录中可能包含 WinSxS 等百万级文件目录，
    /// 禁止递归下钻以避免在缓存未命中时触发 `calculate_folder_stats` 的全量 WalkDir。
    /// 仅从浅层缓存读取直接子目录统计，取前 N 个返回，不设 children。
    fn build_shallow_children(
        dir: &Path,
        cache: &HashMap<PathBuf, FolderStats>,
        root: &Path,
    ) -> Vec<HotspotEntry> {
        let mut children: Vec<HotspotEntry> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let sub_path = entry.path();
                if !sub_path.is_dir()
                    || Self::should_skip_scan(&sub_path)
                    || is_heavy_system_dir(&sub_path)
                {
                    continue;
                }

                if let Some(stats) = cache.get(&sub_path) {
                    if stats.total_size >= MIN_SIZE_THRESHOLD {
                        let depth = calculate_relative_depth(root, &sub_path);
                        let mut child_entry =
                            Self::build_entry(&sub_path, stats, depth as u8, true);
                        child_entry.children = Vec::new();
                        children.push(child_entry);
                    }
                }
            }
        }

        children.sort_by(|a, b| b.total_size.cmp(&a.total_size));
        children.into_iter().take(DRILL_DOWN_TOP_CHILDREN).collect()
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

        // Windows Update 缓存：可见但不允许自动清理
        if folder_name.eq_ignore_ascii_case("softwaredistribution") {
            return true;
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
    ///
    /// # 参数
    /// - `max_depth`: WalkDir 递归深度上限
    /// - `include_modified`: 是否收集最后修改时间（Fast 模式跳过以减少 IO）
    fn calculate_folder_stats(
        path: &Path,
        max_depth: u8,
        include_modified: bool,
    ) -> Option<FolderStats> {
        let mut total_size: u64 = 0;
        let mut file_count: usize = 0;
        let mut last_modified: i64 = 0;

        let walker = WalkDir::new(path)
            .follow_links(false)
            .max_depth(max_depth as usize)
            .into_iter()
            .filter_entry(|e| !Self::is_hidden_system_entry(e) && !is_heavy_system_dir(e.path()));

        for entry in walker {
            match entry {
                Ok(e) => {
                    if e.file_type().is_file() {
                        // 单次 metadata() 调用，避免 Win11 + Defender 下重复 IO
                        if let Ok(metadata) = e.metadata() {
                            total_size += metadata.len();
                            file_count += 1;

                            // 仅在需要时收集修改时间（快速模式跳过）
                            if include_modified {
                                if let Ok(modified) = metadata.modified() {
                                    let timestamp = Self::system_time_to_millis(modified);
                                    if timestamp > last_modified {
                                        last_modified = timestamp;
                                    }
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
        // 先检查名称（避免不必要的 metadata() 调用）
        if entry
            .file_name()
            .to_str()
            .map(|n| is_hidden_name(n))
            .unwrap_or(false)
        {
            return true;
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
    pub(crate) fn system_time_to_millis(time: SystemTime) -> i64 {
        match time.duration_since(SystemTime::UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i64,
            Err(_) => 0,
        }
    }

    /// 核心构建器：将目录路径和统计信息统一构造为 HotspotEntry
    /// 消除 scan_appdata / scan_full_disk / drill_down / scan_path_direct 中的重复代码
    fn build_entry(
        path: &Path,
        stats: &FolderStats,
        depth: u8,
        is_full_scan: bool,
    ) -> HotspotEntry {
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

    /// 从候选列表中递归构建子目录树
    ///
    /// 基于 candidate_pairs 中的路径前缀匹配构建父子关系，无需额外 IO。
    /// 每个子条目 path 的 parent() 等于 parent_path 即为父子关系。
    fn build_children_from_pairs(
        parent_path: &Path,
        current_depth: usize,
        max_depth: usize,
        candidate_pairs: &[(PathBuf, FolderStats, usize)],
    ) -> Vec<HotspotEntry> {
        if current_depth > max_depth {
            return Vec::new();
        }

        // 筛选直接子目录：path.parent() == parent_path 且 depth == current_depth
        let mut children: Vec<HotspotEntry> = candidate_pairs
            .iter()
            .filter(|(p, _, d)| *d == current_depth && p.parent() == Some(parent_path))
            .map(|(path, stats, depth)| {
                let mut child = Self::build_entry(path, stats, *depth as u8, false);
                child.children = Self::build_children_from_pairs(
                    path,
                    current_depth + 1,
                    max_depth,
                    candidate_pairs,
                );
                child
            })
            .collect();

        children.sort_by(|a, b| b.total_size.cmp(&a.total_size));
        children.into_iter().take(DRILL_DOWN_TOP_CHILDREN).collect()
    }
}

// ============================================================================
// 祖先聚合 → 已迁移至 hotspot_engine/fallback_scanner.rs
// ============================================================================
use crate::scanner::hotspot_engine::fallback_scanner::aggregate_ancestor_stats;

#[derive(Debug, Clone)]
struct IndexedChild {
    path: PathBuf,
    stats: FolderStats,
    depth: u8,
}

type ChildIndex = HashMap<PathBuf, Vec<IndexedChild>>;

/// 将聚合后的目录缓存转换成父子索引，后续结果生成只查内存，不再递归读磁盘目录。
fn build_child_index(
    cache: &HashMap<PathBuf, FolderStats>,
    root: &Path,
    min_size: u64,
    ignore_system_dirs: bool,
) -> ChildIndex {
    let mut child_index: ChildIndex = HashMap::with_capacity(cache.len());

    for (path, stats) in cache {
        let Some(parent) = path.parent() else {
            continue;
        };
        if parent == path || stats.total_size < min_size {
            continue;
        }

        let skip_heavy = ignore_system_dirs && is_heavy_system_dir(path);
        // 用户关闭系统目录过滤时，需要让 WinSxS/System32 等目录真实参与排名，
        // 否则结果会和设置语义、WizTree 这类全盘视图明显不一致。
        let skip_noise = ignore_system_dirs && is_noise_directory(path);
        if skip_noise || skip_heavy || HotspotScanner::should_skip_scan(path) {
            continue;
        }

        let depth = calculate_relative_depth(root, path).min(u8::MAX as usize) as u8;
        child_index
            .entry(parent.to_path_buf())
            .or_default()
            .push(IndexedChild {
                path: path.clone(),
                stats: *stats,
                depth,
            });
    }

    for children in child_index.values_mut() {
        children.sort_by(|a, b| b.stats.total_size.cmp(&a.stats.total_size));
    }

    child_index
}

/// 从父子索引构建结果页树形子节点，深度严格跟随前端“展示深度”设置。
fn build_tree_children_from_index(
    parent: &Path,
    max_depth: u8,
    child_index: &ChildIndex,
    is_full_scan: bool,
) -> Vec<HotspotEntry> {
    let Some(children) = child_index.get(parent) else {
        return Vec::new();
    };

    children
        .iter()
        .filter(|child| child.depth <= max_depth)
        .take(DRILL_DOWN_TOP_CHILDREN)
        .map(|child| {
            let mut entry =
                HotspotScanner::build_entry(&child.path, &child.stats, child.depth, is_full_scan);
            if child.depth < max_depth {
                entry.children = build_tree_children_from_index(
                    &child.path,
                    max_depth,
                    child_index,
                    is_full_scan,
                );
            }
            entry
        })
        .collect()
}

// ============================================================================
// 热点展开机制（Hotspot Expansion）
// 核心思路：避免 Windows / Program Files 等容器目录霸占 TopN，
// 通过递归展开，将排行榜让给用户真正关心的可清理热点目录。
// ============================================================================

/// 判断是否应展开目录（用子目录替代它参与 TopN 竞争）
///
/// 触发条件（任意满足即展开）：
/// - 系统保护目录（Windows 等）—— 用户无法操作
/// - 总大小 > 20GB —— 太大，需要看内部
/// - depth <= 1 —— C:\ 的直接子级，太笼统
///
/// 不展开（作为终端热点）的条件：
/// - 非保护 + 小于阈值 + 深度足够 → 这就是用户要找的目录
fn should_expand_directory(entry: &HotspotEntry, ignore_system_dirs: bool) -> bool {
    if entry.is_protected {
        // 关闭系统目录过滤时，保护目录本身就是用户想看的磁盘占用结果；
        // 必须优先返回 false，避免又被 20GB 阈值或一级目录规则强制展开。
        return ignore_system_dirs;
    }
    if entry.total_size > EXPAND_SIZE_THRESHOLD {
        return true;
    }
    if entry.depth <= 1 {
        return true;
    }
    false
}

/// 从父子索引中查找目录的直接子目录。
/// 索引已经完成大小、系统目录与噪音目录过滤，避免热点展开阶段再次触发 read_dir。
fn find_meaningful_children(
    dir: &Path,
    child_index: &ChildIndex,
    is_full_scan: bool,
) -> Vec<HotspotEntry> {
    child_index
        .get(dir)
        .map(|children| {
            children
                .iter()
                .map(|child| {
                    HotspotScanner::build_entry(
                        &child.path,
                        &child.stats,
                        child.depth,
                        is_full_scan,
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// BinaryHeap 包装结构：按 total_size 降序排列 HotspotEntry
/// 大顶堆规则：total_size 更大的排在前面
struct SizeOrd(HotspotEntry);

impl PartialEq for SizeOrd {
    fn eq(&self, other: &Self) -> bool {
        self.0.total_size == other.0.total_size
    }
}
impl Eq for SizeOrd {}

impl Ord for SizeOrd {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_size.cmp(&other.0.total_size)
    }
}
impl PartialOrd for SizeOrd {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// 热点扁平化：递归展开容器目录，提取真正的用户热点
///
/// 算法：
/// 1. 将 all_entries 按大小降序放入 BinaryHeap 候选队列（O(log n) 插入/取出）
/// 2. 每次取出最大候选
/// 3. 若应展开：从 cache 找出子目录，子目录加入候选队列继续竞争
///    若不应展开：作为终端热点加入结果
/// 4. 直到结果达到 top_n 或候选队列耗尽
///
/// 噪音目录（WinSxS/System32 等）在开启系统目录过滤时才会被过滤
fn flatten_hotspots(
    all_entries: Vec<HotspotEntry>,
    child_index: &ChildIndex,
    top_n: usize,
    is_full_scan: bool,
    ignore_system_dirs: bool,
) -> Vec<HotspotEntry> {
    // 系统目录过滤关闭时保留噪音目录，便于和 WizTree 的全盘排名语义对齐。
    let mut candidates: BinaryHeap<SizeOrd> = all_entries
        .into_iter()
        .filter(|e| !ignore_system_dirs || !is_noise_directory(&PathBuf::from(&e.path)))
        .map(SizeOrd)
        .collect();

    let mut result: Vec<HotspotEntry> = Vec::new();
    // 防止同一个目录被重复加入结果
    let mut seen: HashSet<PathBuf> = HashSet::new();

    while !candidates.is_empty() && result.len() < top_n {
        let entry = candidates.pop().unwrap().0;

        // 关闭系统目录过滤时，结果要更接近 WizTree 的全盘占用视图，
        // 因此保护目录本身允许进入榜单，不再被无条件展开成更深层子目录。
        if should_expand_directory(&entry, ignore_system_dirs) {
            let dir_path = PathBuf::from(&entry.path);
            let children = find_meaningful_children(&dir_path, child_index, is_full_scan);

            if children.is_empty() {
                if seen.insert(dir_path) {
                    result.push(entry);
                }
            } else {
                for child in children {
                    let child_path = PathBuf::from(&child.path);
                    if !seen.contains(&child_path) {
                        candidates.push(SizeOrd(child));
                    }
                }
            }
        } else {
            if seen.insert(PathBuf::from(&entry.path)) {
                result.push(entry);
            }
        }
    }

    result
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

    /// 路径钻取扫描（UI 点击下钻）
    ///
    /// 单次祖先聚合扫描，返回目标路径下多层子目录的大小统计。
    /// 不触发多次递归 WalkDir，目标延迟 <1s。
    pub fn scan_path_direct(path: &str) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();
        let target = PathBuf::from(path);

        if !target.exists() {
            return Err(format!("路径不存在: {}", path));
        }
        if !target.is_dir() {
            return Err(format!("路径不是文件夹: {}", path));
        }

        // 单次 WalkDir + 祖先聚合（max_depth=4, Fast 模式）
        let cancel_flag = AtomicBool::new(false);
        let (_root_stats, ancestor_map) = aggregate_ancestor_stats(
            &target,
            4,     // max_depth
            false, // track_modified (快速模式)
            &cancel_flag,
            true, // 路径钻取：此上下文无系统目录
        );

        let mut entries: Vec<HotspotEntry> = ancestor_map
            .into_iter()
            .map(|(child_path, stats)| {
                let depth = calculate_relative_depth(&target, &child_path);
                Self::build_entry(&child_path, &stats, depth as u8, false)
            })
            .collect();

        // 按大小降序排列
        entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        let total_folders_scanned = entries.len();
        let scanned_total_size = entries.iter().map(|e| e.total_size).sum();
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(HotspotScanResult {
            entries,
            total_folders_scanned,
            scan_duration_ms,
            scanned_total_size,
            is_full_scan: false,
        })
    }
}

/// 文件夹统计信息（内部使用，pub(crate) 供 hotspot_engine 子模块引用）
#[derive(Debug, Clone, Copy)]
pub(crate) struct FolderStats {
    pub(crate) total_size: u64,
    pub(crate) file_count: usize,
    pub(crate) last_modified: i64,
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
