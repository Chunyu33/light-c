// ============================================================================
// 大文件扫描模块
// 负责遍历系统盘，用最小堆收集 Top N 最大文件
// ============================================================================

use serde::{Deserialize, Serialize};
use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use tauri::{Emitter, Window};
use walkdir::WalkDir;

// 全局取消标志，跨线程共享
static LARGE_FILE_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

// ============================================================================
// 数据结构
// ============================================================================

/// 大文件扫描结果条目
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct LargeFileEntry {
    pub path: String,
    pub size: u64,
    pub modified: i64,
    /// 风险等级 (1-5)，由后端路径规则计算
    pub risk_level: u8,
    /// 来源标签（如"微信文件"、"虚拟机磁盘"、"系统临时文件"）
    pub source_label: String,
}

impl Ord for LargeFileEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.size
            .cmp(&other.size)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for LargeFileEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 扫描进度事件负载
#[derive(Debug, Clone, Serialize)]
pub struct LargeFileScanProgress {
    pub current_path: String,
    pub scanned_count: u64,
    pub found_count: usize,
}

// ============================================================================
// 命令入口
// ============================================================================

/// 重置取消标志
pub fn reset_cancelled() {
    LARGE_FILE_SCAN_CANCELLED.store(false, AtomicOrdering::SeqCst);
}

/// 设置取消标志
pub fn cancel() {
    log::info!("收到取消大文件扫描请求");
    LARGE_FILE_SCAN_CANCELLED.store(true, AtomicOrdering::SeqCst);
}

/// 执行大文件扫描（阻塞，应在 spawn_blocking 中调用）
pub fn scan(window: &Window, top_n: usize) -> Result<Vec<LargeFileEntry>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::time::Instant;

        let system_drive = std::env::var("SYSTEMDRIVE").unwrap_or_else(|_| "C:".to_string());
        let root = format!("{}\\", system_drive);

        log::info!("开始扫描大文件: {} (Top {})", root, top_n);

        let mut heap: BinaryHeap<Reverse<LargeFileEntry>> = BinaryHeap::new();
        let mut file_count: u64 = 0;
        let mut last_emit = Instant::now();

        for entry in WalkDir::new(&root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if name == "$recycle.bin" || name == "system volume information" {
                        return false;
                    }
                    if name == "winsxs" {
                        if let Some(parent) = e.path().parent() {
                            if parent
                                .to_string_lossy()
                                .to_lowercase()
                                .ends_with("\\windows")
                            {
                                return false;
                            }
                        }
                    }
                }
                true
            })
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            if LARGE_FILE_SCAN_CANCELLED.load(AtomicOrdering::SeqCst) {
                log::info!("大文件扫描被用户取消，已扫描 {} 个文件", file_count);
                let _ = window.emit("large-file-scan:cancelled", ());
                let mut results: Vec<LargeFileEntry> =
                    heap.into_iter().map(|item| item.0).collect();
                results.sort_by(|a, b| b.size.cmp(&a.size));
                return Ok(results);
            }

            let path = entry.path().to_path_buf();
            let path_str = path.to_string_lossy().to_string();

            if let Ok(metadata) = entry.metadata() {
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                file_count += 1;

                if last_emit.elapsed().as_millis() >= 200 || file_count % 1000 == 0 {
                    let progress = LargeFileScanProgress {
                        current_path: path_str.clone(),
                        scanned_count: file_count,
                        found_count: heap.len(),
                    };
                    let _ = window.emit("large-file-scan:progress", &progress);
                    last_emit = Instant::now();
                }

                let risk_level = compute_file_risk_level(&path_str);
                let source_label = compute_source_label(&path_str);

                heap.push(Reverse(LargeFileEntry {
                    path: path_str,
                    size,
                    modified,
                    risk_level,
                    source_label,
                }));

                if heap.len() > top_n {
                    heap.pop();
                }
            }
        }

        let mut results: Vec<LargeFileEntry> = heap.into_iter().map(|item| item.0).collect();
        results.sort_by(|a, b| b.size.cmp(&a.size));

        log::info!(
            "大文件扫描完成: 扫描 {} 个文件, 返回 {} 项 (Top {})",
            file_count,
            results.len(),
            top_n,
        );
        Ok(results)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

// ============================================================================
// 风险等级 & 来源标签
// ============================================================================

/// 根据文件路径计算风险等级 (1-5)
///
/// 1 = 安全 (临时文件/缓存)
/// 2 = 低风险 (媒体文件/下载)
/// 3 = 中等风险 (数据库/文档)
/// 4 = 较高风险 (程序文件/Windows 非 Temp)
/// 5 = 系统关键 (System32/驱动/页面文件)
fn compute_file_risk_level(path: &str) -> u8 {
    let lower = path.to_lowercase();
    let file_name = std::path::Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    let file_name_lower = file_name.to_lowercase();
    let ext = file_name_lower.rsplit('.').next().unwrap_or("");

    // 5 — 系统关键
    if lower.contains("\\windows\\system32\\")
        || lower.contains("\\windows\\syswow64\\")
        || lower.contains("\\windows\\winsxs\\")
    {
        return 5;
    }
    let critical_files = [
        "pagefile.sys",
        "hiberfil.sys",
        "swapfile.sys",
        "ntoskrnl.exe",
        "bootmgr",
    ];
    if critical_files.contains(&file_name_lower.as_str()) {
        return 5;
    }
    if ext == "sys" && lower.contains("\\windows\\") {
        return 5;
    }

    // 4 — 较高风险
    if (lower.contains("\\program files\\") || lower.contains("\\program files (x86)\\"))
        && ["exe", "dll", "ocx", "msi"].contains(&ext)
    {
        return 4;
    }
    if lower.contains("\\windows\\") && !lower.contains("\\temp\\") {
        return 4;
    }

    // 3 — 中等风险
    let data_exts = [
        "db", "sqlite", "mdf", "ldf", "accdb", "mdb", "vmdk", "vdi", "vhd", "vhdx", "doc",
        "docx", "xls", "xlsx", "ppt", "pptx", "pdf",
    ];
    if data_exts.contains(&ext) {
        return 3;
    }

    // 2 — 低风险
    let media_exts = [
        "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mp3", "wav", "flac",
    ];
    if media_exts.contains(&ext) {
        return 2;
    }
    if lower.contains("\\downloads\\") || lower.contains("\\desktop\\") {
        return 2;
    }

    // 1 — 安全
    if lower.contains("\\temp\\") || lower.contains("\\tmp\\") || lower.contains("\\cache\\") {
        return 1;
    }
    let safe_exts = ["log", "tmp", "bak", "old", "dmp"];
    if safe_exts.contains(&ext) {
        return 1;
    }

    3
}

/// 根据文件路径识别来源标签
fn compute_source_label(path: &str) -> String {
    let lower = path.to_lowercase();
    let file_name = std::path::Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    let file_name_lower = file_name.to_lowercase();
    let ext = file_name_lower.rsplit('.').next().unwrap_or("");

    // 按扩展名识别
    if ["vmdk", "vdi", "vhd", "vhdx"].contains(&ext) {
        return "虚拟机磁盘".to_string();
    }
    if ext == "dmp" || file_name_lower == "memory.dmp" {
        return "内存转储".to_string();
    }
    if ["iso", "img"].contains(&ext) {
        return "光盘镜像".to_string();
    }
    if ["db", "sqlite", "mdf", "ldf", "accdb", "mdb"].contains(&ext) {
        return "数据库文件".to_string();
    }
    if ["zip", "rar", "7z", "tar", "gz"].contains(&ext) {
        return "压缩包".to_string();
    }
    if ext == "log" {
        return "日志文件".to_string();
    }

    // 按路径模式识别
    if lower.contains("\\windows\\temp\\") || lower.contains("\\appdata\\local\\temp\\") {
        return "系统临时文件".to_string();
    }
    if lower.contains("\\windows\\softwaredistribution\\") {
        return "Windows 更新缓存".to_string();
    }
    if lower.contains("\\steam\\") {
        return "Steam 游戏文件".to_string();
    }
    if lower.contains("\\wechat files\\") {
        return "微信文件".to_string();
    }
    if lower.contains("\\chrome\\") || lower.contains("\\google\\chrome\\") {
        return "Chrome 浏览器".to_string();
    }
    if lower.contains("\\edge\\") || lower.contains("\\microsoft\\edge\\") {
        return "Edge 浏览器".to_string();
    }
    if lower.contains("\\firefox\\") {
        return "Firefox 浏览器".to_string();
    }
    if lower.contains("\\downloads\\") {
        return "下载文件".to_string();
    }
    if lower.contains("\\desktop\\") {
        return "桌面文件".to_string();
    }
    if lower.contains("\\recycle") || file_name_lower.starts_with("$r") {
        return "回收站".to_string();
    }

    // 媒体文件
    if ["mp4", "mkv", "avi", "mov", "wmv"].contains(&ext) {
        return "视频文件".to_string();
    }
    if ["mp3", "wav", "flac", "aac"].contains(&ext) {
        return "音频文件".to_string();
    }
    if ["jpg", "jpeg", "png", "gif", "bmp"].contains(&ext) {
        return "图片文件".to_string();
    }

    "未知来源".to_string()
}
