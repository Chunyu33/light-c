// ============================================================================
// 垃圾清理深度扫描器
//
// 深度扫描只识别高置信度的临时文件、缓存和报告目录，不使用全盘扩展名泛匹配，
// 避免把用户的日志、下载文件或项目文件误判为垃圾。
// ============================================================================

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use serde::Serialize;
use tauri::{Emitter, Window};
use walkdir::WalkDir;

use super::{CategoryScanResult, FileInfo, JunkCategory};

const DEEP_JUNK_MIN_AGE_SECONDS: i64 = 24 * 60 * 60;
const DEEP_JUNK_PAGE_SIZE: usize = 500;
const DEEP_JUNK_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_DEEP_JUNK_SESSIONS: usize = 2;

static DEEP_JUNK_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 深度扫描阶段进度，前端用它显示当前分区和 MFT 阶段。
#[derive(Debug, Clone, Serialize)]
pub struct DeepJunkScanProgress {
    pub stage: String,
    pub drive_letter: String,
    pub message: String,
    pub processed: usize,
    pub matched_count: usize,
    pub elapsed_ms: u64,
}

/// 单个分区的深度扫描摘要。
#[derive(Debug, Clone, Serialize)]
pub struct DeepJunkDriveSummary {
    pub drive_letter: String,
    pub file_system: String,
    pub backend: String,
    pub matched_file_count: usize,
    pub matched_size: u64,
    pub warning: Option<String>,
}

/// 深度垃圾扫描结果。快速扫描继续使用原有 ScanResult，避免破坏旧调用协议。
#[derive(Debug, Clone, Serialize)]
pub struct DeepJunkScanResult {
    pub scan_mode: String,
    pub scan_id: String,
    pub categories: Vec<CategoryScanResult>,
    pub total_size: u64,
    pub total_file_count: usize,
    pub scan_duration_ms: u64,
    pub scan_timestamp: i64,
    pub drives: Vec<DeepJunkDriveSummary>,
}

struct DriveScanResult {
    summary: DeepJunkDriveSummary,
    files: Vec<(JunkCategory, FileInfo)>,
}

struct DeepJunkScanSession {
    created_at: Instant,
    result: DeepJunkScanResult,
}

static DEEP_JUNK_SESSIONS: LazyLock<Mutex<HashMap<String, DeepJunkScanSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DEEP_JUNK_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 重置深度扫描取消标志。
pub fn reset_cancelled() {
    DEEP_JUNK_SCAN_CANCELLED.store(false, Ordering::SeqCst);
}

/// 设置深度扫描取消标志，MFT 和降级遍历都会检查它。
pub fn cancel() {
    DEEP_JUNK_SCAN_CANCELLED.store(true, Ordering::SeqCst);
}

fn is_cancelled() -> bool {
    DEEP_JUNK_SCAN_CANCELLED.load(Ordering::SeqCst)
}

/// 执行所有固定分区的深度垃圾扫描。
pub fn scan_all(window: &Window) -> Result<DeepJunkScanResult, String> {
    let started_at = std::time::Instant::now();
    let mut categories = JunkCategory::all()
        .into_iter()
        .map(CategoryScanResult::new)
        .collect::<Vec<_>>();
    let mut drives = Vec::new();

    #[cfg(windows)]
    {
        let drive_letters = fixed_drive_letters()?;
        if drive_letters.is_empty() {
            return Err("没有找到可访问的固定磁盘分区".to_string());
        }

        emit_progress(
            window,
            "discover",
            "",
            "已发现固定磁盘分区，准备开始深度扫描",
            0,
            0,
            started_at,
        );

        // 深度模式仍保留回收站的 Explorer 可见条目，不能用 MFT 直接枚举内部文件。
        let mut recycle_result = CategoryScanResult::new(JunkCategory::RecycleBin);
        super::recycle_bin::scan_current_user(&JunkCategory::RecycleBin, &mut recycle_result);
        if let Some(category_result) = categories
            .iter_mut()
            .find(|item| item.category == JunkCategory::RecycleBin)
        {
            for file in recycle_result.files {
                category_result.add_file(file);
            }
        }

        for drive_letter in drive_letters {
            if is_cancelled() {
                return Err("扫描已取消".to_string());
            }

            let result = if super::big_files_engine::mft_core::is_ntfs(drive_letter) {
                match scan_ntfs_drive(drive_letter, window, started_at) {
                    Ok(result) => result,
                    Err(error) if error == "扫描已取消" => return Err(error),
                    Err(error) => {
                        warn!(
                            "{} 盘 MFT 深度扫描失败，降级为受控遍历: {}",
                            drive_letter, error
                        );
                        scan_non_ntfs_drive(
                            drive_letter,
                            window,
                            started_at,
                            "NTFS",
                            Some(format!("MFT 扫描失败，已降级为受控目录遍历: {}", error)),
                        )
                    }
                }
            } else {
                scan_non_ntfs_drive(
                    drive_letter,
                    window,
                    started_at,
                    "非 NTFS",
                    Some("非 NTFS 分区使用受控目录遍历，未执行 MFT 扫描".to_string()),
                )
            };

            if is_cancelled() {
                return Err("扫描已取消".to_string());
            }

            for (category, file) in result.files {
                if let Some(category_result) =
                    categories.iter_mut().find(|item| item.category == category)
                {
                    category_result.add_file(file);
                }
            }
            drives.push(result.summary);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        return Err("深度垃圾扫描仅支持 Windows 系统".to_string());
    }

    let mut result = DeepJunkScanResult {
        scan_mode: "deep".to_string(),
        scan_id: String::new(),
        categories,
        total_size: 0,
        total_file_count: 0,
        scan_duration_ms: started_at.elapsed().as_millis() as u64,
        scan_timestamp: chrono::Utc::now().timestamp(),
        drives,
    };
    result.total_size = result.categories.iter().map(|item| item.total_size).sum();
    result.total_file_count = result.categories.iter().map(|item| item.file_count).sum();

    emit_progress(
        window,
        "summary",
        "",
        &format!(
            "深度扫描完成：发现 {} 个文件，{} 字节",
            result.total_file_count, result.total_size
        ),
        result.total_file_count,
        result.total_file_count,
        started_at,
    );
    info!(
        "深度垃圾扫描完成：{} 个文件，{} 字节，耗时 {}ms",
        result.total_file_count, result.total_size, result.scan_duration_ms
    );
    Ok(result)
}

/// 保存完整深度结果并只返回首屏数据，避免一次性把大量路径传入 WebView。
pub fn create_session(mut result: DeepJunkScanResult) -> Result<DeepJunkScanResult, String> {
    let session_id = format!(
        "deep-{}-{}",
        current_unix_timestamp(),
        DEEP_JUNK_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    result.scan_id = session_id.clone();

    let response = page_result(&result, 0, DEEP_JUNK_PAGE_SIZE)?;
    let mut sessions = DEEP_JUNK_SESSIONS
        .lock()
        .map_err(|_| "深度扫描会话锁异常，请重试".to_string())?;
    sessions.retain(|_, session| session.created_at.elapsed() < DEEP_JUNK_SESSION_TTL);
    while sessions.len() >= MAX_DEEP_JUNK_SESSIONS {
        let Some(oldest_id) = sessions
            .iter()
            .min_by_key(|(_, session)| session.created_at)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        sessions.remove(&oldest_id);
    }
    sessions.insert(
        session_id,
        DeepJunkScanSession {
            created_at: Instant::now(),
            result,
        },
    );
    Ok(response)
}

/// 获取某个深度扫描分类的下一页文件。
pub fn get_category_page(
    scan_id: &str,
    category_name: &str,
    offset: usize,
    limit: usize,
) -> Result<CategoryScanResult, String> {
    let sessions = DEEP_JUNK_SESSIONS
        .lock()
        .map_err(|_| "深度扫描会话锁异常，请重试".to_string())?;
    let session = sessions
        .get(scan_id)
        .ok_or_else(|| "深度扫描结果已过期，请重新扫描".to_string())?;
    if session.created_at.elapsed() >= DEEP_JUNK_SESSION_TTL {
        return Err("深度扫描结果已过期，请重新扫描".to_string());
    }

    let category = session
        .result
        .categories
        .iter()
        .find(|category| category.display_name == category_name)
        .ok_or_else(|| format!("未知垃圾分类: {}", category_name))?;
    page_category(category, offset, limit.clamp(1, DEEP_JUNK_PAGE_SIZE * 2))
}

/// 从短期扫描会话中取出完整分类路径，供删除命令处理分页未返回的文件。
pub fn get_paths_for_categories(
    scan_id: &str,
    category_names: &[String],
    excluded_paths: &[String],
) -> Result<Vec<String>, String> {
    let sessions = DEEP_JUNK_SESSIONS
        .lock()
        .map_err(|_| "深度扫描会话锁异常，请重试".to_string())?;
    let session = sessions
        .get(scan_id)
        .ok_or_else(|| "深度扫描结果已过期，请重新扫描".to_string())?;
    if session.created_at.elapsed() >= DEEP_JUNK_SESSION_TTL {
        return Err("深度扫描结果已过期，请重新扫描".to_string());
    }

    let requested_names = category_names.iter().collect::<HashSet<_>>();
    let excluded = excluded_paths
        .iter()
        .map(|path| path.to_lowercase())
        .collect::<HashSet<_>>();
    let mut matched_names = HashSet::new();
    let mut paths = Vec::new();

    for category in &session.result.categories {
        if !requested_names.contains(&category.display_name) {
            continue;
        }
        matched_names.insert(category.display_name.clone());
        paths.extend(
            category
                .files
                .iter()
                .filter(|file| !excluded.contains(&file.path.to_lowercase()))
                .map(|file| file.path.clone()),
        );
    }

    if matched_names.len() != requested_names.len() {
        return Err("深度扫描分类已变化，请重新扫描后再清理".to_string());
    }
    Ok(paths)
}

fn page_result(
    result: &DeepJunkScanResult,
    offset: usize,
    limit: usize,
) -> Result<DeepJunkScanResult, String> {
    let mut response = result.clone();
    response.categories = result
        .categories
        .iter()
        .map(|category| page_category(category, offset, limit))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(response)
}

fn page_category(
    category: &CategoryScanResult,
    offset: usize,
    limit: usize,
) -> Result<CategoryScanResult, String> {
    let mut page = category.clone();
    let start = offset.min(category.files.len());
    let end = start.saturating_add(limit).min(category.files.len());
    page.files = category.files[start..end].to_vec();
    page.has_more = end < category.file_count;
    Ok(page)
}

#[cfg(windows)]
fn scan_ntfs_drive(
    drive_letter: char,
    window: &Window,
    started_at: std::time::Instant,
) -> Result<DriveScanResult, String> {
    use super::big_files_engine::mft_core;

    let drive_label = format!("{}:", drive_letter);
    emit_progress(
        window,
        "mft",
        &drive_label,
        "正在枚举 NTFS 文件记录",
        0,
        0,
        started_at,
    );

    let device = mft_core::open_volume(drive_letter)?;
    let enumerate_result = mft_core::enumerate_usn_records_v2(device, &|processed| {
        if is_cancelled() {
            return false;
        }
        if processed == 0 || processed % 10_000 == 0 {
            emit_progress(
                window,
                "mft",
                &drive_label,
                &format!("正在枚举 NTFS 文件记录，已处理 {} 条", processed),
                processed,
                0,
                started_at,
            );
        }
        true
    });
    mft_core::close_volume(device);
    let entries = enumerate_result?;

    if is_cancelled() {
        return Err("扫描已取消".to_string());
    }

    emit_progress(
        window,
        "path",
        &drive_label,
        "正在重建候选文件路径",
        entries.len(),
        0,
        started_at,
    );

    let parent_ids = entries
        .iter()
        .filter(|entry| !entry.is_dir)
        .map(|entry| entry.parent_id)
        .collect::<HashSet<_>>();
    let directory_paths = mft_core::rebuild_paths_for_ids(&entries, drive_letter, &parent_ids);
    let mut candidates = Vec::new();
    let mut candidate_ids = HashSet::new();
    let mut candidate_paths = HashSet::new();

    for entry in entries.iter().filter(|entry| !entry.is_dir) {
        let Some(parent_path) = directory_paths.get(&entry.parent_id) else {
            continue;
        };
        let path = PathBuf::from(parent_path).join(&entry.name);
        let path_string = path.to_string_lossy().into_owned();
        let Some(category) = match_deep_junk_category(&path_string) else {
            continue;
        };
        if !candidate_paths.insert(path_string.to_ascii_lowercase()) {
            continue;
        }
        candidate_ids.insert(entry.mft_id);
        candidates.push((entry.mft_id, category, path_string));
    }
    let enumerated_count = entries.len();
    drop(entries);
    drop(directory_paths);
    drop(candidate_paths);

    emit_progress(
        window,
        "filter",
        &drive_label,
        &format!("规则筛选完成：{} 个候选文件", candidates.len()),
        enumerated_count,
        candidates.len(),
        started_at,
    );

    if candidates.is_empty() {
        return Ok(DriveScanResult {
            summary: DeepJunkDriveSummary {
                drive_letter: drive_label,
                file_system: "NTFS".to_string(),
                backend: "mft".to_string(),
                matched_file_count: 0,
                matched_size: 0,
                warning: None,
            },
            files: Vec::new(),
        });
    }

    emit_progress(
        window,
        "metadata",
        &drive_label,
        "正在读取候选文件大小和修改时间",
        0,
        candidates.len(),
        started_at,
    );
    let metadata_reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let metadata = metadata_reader.read_file_metadata_map(&candidate_ids, &|processed| {
        if is_cancelled() {
            return false;
        }
        if processed == 0 || processed % 100_000 == 0 {
            emit_progress(
                window,
                "metadata",
                &drive_label,
                &format!("正在读取 $MFT 文件大小，已处理 {} 条", processed),
                processed,
                candidates.len(),
                started_at,
            );
        }
        true
    })?;

    let current_time = current_unix_timestamp();
    let mut files = Vec::new();
    for (mft_id, category, path) in candidates {
        let Some(file_metadata) = metadata.get(&mft_id) else {
            continue;
        };
        if file_metadata.size == 0 || !is_old_enough(file_metadata.modified, current_time) {
            continue;
        }
        let name = Path::new(&path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "未知文件".to_string());
        files.push((
            category.clone(),
            FileInfo::new(
                path,
                name,
                file_metadata.size,
                file_metadata.modified,
                false,
                category,
            ),
        ));
    }

    files.sort_by(|left, right| left.1.path.cmp(&right.1.path));
    let matched_size = files.iter().map(|(_, file)| file.size).sum();
    emit_progress(
        window,
        "result",
        &drive_label,
        &format!("{} 盘候选结果整理完成", drive_label),
        files.len(),
        files.len(),
        started_at,
    );

    Ok(DriveScanResult {
        summary: DeepJunkDriveSummary {
            drive_letter: drive_label,
            file_system: "NTFS".to_string(),
            backend: "mft".to_string(),
            matched_file_count: files.len(),
            matched_size,
            warning: None,
        },
        files,
    })
}

#[cfg(windows)]
fn scan_non_ntfs_drive(
    drive_letter: char,
    window: &Window,
    started_at: std::time::Instant,
    file_system: &str,
    warning: Option<String>,
) -> DriveScanResult {
    let drive_label = format!("{}:", drive_letter);
    let mut files = Vec::new();
    let mut visited = HashSet::new();
    let current_time = current_unix_timestamp();

    emit_progress(
        window,
        "walkdir",
        &drive_label,
        "当前分区不是 NTFS，正在遍历明确的缓存目录",
        0,
        0,
        started_at,
    );

    for root in non_ntfs_scan_roots(drive_letter) {
        if is_cancelled() {
            break;
        }
        if !root.exists() {
            continue;
        }

        for entry in WalkDir::new(root)
            .max_depth(12)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if is_cancelled() {
                break;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path().to_string_lossy().into_owned();
            if !visited.insert(path.to_ascii_lowercase()) {
                continue;
            }
            let Some(category) = match_deep_junk_category(&path) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs() as i64)
                .unwrap_or(0);
            if metadata.len() == 0 || !is_old_enough(modified, current_time) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            files.push((
                category.clone(),
                FileInfo::new(path, name, metadata.len(), modified, false, category),
            ));
        }
    }

    files.sort_by(|left, right| left.1.path.cmp(&right.1.path));
    let matched_size = files.iter().map(|(_, file)| file.size).sum();
    emit_progress(
        window,
        "result",
        &drive_label,
        &format!("{} 盘常规遍历完成", drive_label),
        files.len(),
        files.len(),
        started_at,
    );

    DriveScanResult {
        summary: DeepJunkDriveSummary {
            drive_letter: drive_label,
            file_system: file_system.to_string(),
            backend: "walkdir".to_string(),
            matched_file_count: files.len(),
            matched_size,
            warning,
        },
        files,
    }
}

#[cfg(windows)]
fn fixed_drive_letters() -> Result<Vec<char>, String> {
    use winapi::um::fileapi::{GetDriveTypeW, GetLogicalDrives};
    use winapi::um::winbase::DRIVE_FIXED;

    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err("无法读取本机磁盘分区列表".to_string());
    }

    Ok((0..26)
        .filter_map(|index| {
            if mask & (1 << index) == 0 {
                return None;
            }
            let letter = (b'A' + index as u8) as char;
            let root = format!("{}:\\", letter);
            let wide_root = root
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let drive_type = unsafe { GetDriveTypeW(wide_root.as_ptr()) };
            (drive_type == DRIVE_FIXED && Path::new(&root).is_dir()).then_some(letter)
        })
        .collect())
}

#[cfg(windows)]
fn non_ntfs_scan_roots(drive_letter: char) -> Vec<PathBuf> {
    let root = PathBuf::from(format!("{}:\\", drive_letter));
    let mut roots = vec![
        root.join("Windows\\Temp"),
        root.join("Windows\\Prefetch"),
        root.join("Windows\\SoftwareDistribution\\Download"),
        root.join("Windows\\SoftwareDistribution\\DeliveryOptimization"),
        root.join("Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache"),
        root.join("Windows\\Logs"),
        root.join("Windows\\Minidump"),
        root.join("Windows.old"),
        root.join("$Windows.~BT"),
        root.join("$Windows.~WS"),
        root.join("ProgramData\\Microsoft\\Windows\\WER"),
        root.join("ProgramData\\Microsoft\\Windows Defender\\LocalCopy"),
        root.join("ProgramData\\Microsoft\\Windows Defender\\Support"),
    ];

    let users_root = root.join("Users");
    if let Ok(users) = std::fs::read_dir(users_root) {
        for user in users.filter_map(Result::ok) {
            let profile = user.path();
            if profile.is_dir() {
                roots.push(profile.join("AppData\\Local"));
            }
        }
    }
    roots
}

fn emit_progress(
    window: &Window,
    stage: &str,
    drive_letter: &str,
    message: &str,
    processed: usize,
    matched_count: usize,
    started_at: std::time::Instant,
) {
    let progress = DeepJunkScanProgress {
        stage: stage.to_string(),
        drive_letter: drive_letter.to_string(),
        message: message.to_string(),
        processed,
        matched_count,
        elapsed_ms: started_at.elapsed().as_millis() as u64,
    };
    if let Err(error) = window.emit("junk-clean:progress", &progress) {
        warn!("发送垃圾深度扫描进度失败: {}", error);
    }
}

fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

fn is_old_enough(modified: i64, current_time: i64) -> bool {
    if modified <= 0 {
        return false;
    }
    current_time.saturating_sub(modified) >= DEEP_JUNK_MIN_AGE_SECONDS
}

/// 判断路径是否属于深度清理允许的高置信度目录。
pub fn is_deep_junk_path(path: &str) -> bool {
    super::recycle_bin::is_current_user_entry_path(path) || match_deep_junk_category(path).is_some()
}

fn match_deep_junk_category(path: &str) -> Option<JunkCategory> {
    let normalized = normalize_path(path);
    if normalized.is_empty() || is_excluded_path(&normalized) {
        return None;
    }

    if is_shader_cache(&normalized) {
        return Some(JunkCategory::ShaderCache);
    }
    if is_defender_cache(&normalized) {
        return Some(JunkCategory::WindowsDefenderCache);
    }
    if contains_any(
        &normalized,
        &["\\appdata\\local\\temp\\", "\\windows\\temp\\"],
    ) {
        return Some(JunkCategory::WindowsTemp);
    }
    if contains_any(
        &normalized,
        &[
            "\\windows\\softwaredistribution\\deliveryoptimization\\",
            "\\windows\\serviceprofiles\\networkservice\\appdata\\local\\microsoft\\windows\\deliveryoptimization\\",
        ],
    ) {
        return Some(JunkCategory::DeliveryOptimization);
    }
    if contains_any(
        &normalized,
        &[
            "\\windows\\prefetch\\",
            "\\appdata\\local\\microsoft\\windows\\inetcache\\",
            "\\appdata\\local\\microsoft\\windows\\caches\\",
        ],
    ) {
        return Some(JunkCategory::SystemCache);
    }
    if is_browser_cache(&normalized) {
        return Some(JunkCategory::BrowserCache);
    }
    if is_user_profile_cache(&normalized) {
        // 第三方应用通常把可重建缓存放在用户配置目录下；仅匹配明确的缓存目录名，
        // 不把整个 AppData 当作垃圾，也不触碰 MSIX/WebView 持久化数据。
        return Some(JunkCategory::AppCache);
    }
    if contains_any(
        &normalized,
        &["\\windows\\softwaredistribution\\download\\"],
    ) {
        return Some(JunkCategory::WindowsUpdate);
    }
    if is_thumbnail_cache(&normalized) {
        return Some(JunkCategory::ThumbnailCache);
    }
    if contains_any(
        &normalized,
        &[
            "\\appdata\\local\\crashdumps\\",
            "\\windows\\minidump\\",
            "\\appdata\\local\\microsoft\\windows\\wer\\",
            "\\programdata\\microsoft\\windows\\wer\\",
        ],
    ) {
        return Some(JunkCategory::WindowsErrorReports);
    }
    if normalized.ends_with("\\windows\\memory.dmp") {
        return Some(JunkCategory::MemoryDump);
    }
    if is_windows_log(&normalized) {
        return Some(JunkCategory::LogFiles);
    }
    if contains_any(
        &normalized,
        &["\\windows.old\\", "\\$windows.~bt\\", "\\$windows.~ws\\"],
    ) {
        return Some(JunkCategory::OldWindowsInstallation);
    }
    if contains_any(
        &normalized,
        &[
            "\\appdata\\local\\downloaded installations\\",
            "\\windows\\installer\\$patchcache$\\",
        ],
    ) {
        return Some(JunkCategory::InstallerTemp);
    }
    if normalized.contains("\\appdata\\local\\microsoft\\windows\\webcache\\") {
        return Some(JunkCategory::AppCache);
    }
    if normalized.contains("\\windows\\serviceprofiles\\localservice\\appdata\\local\\fontcache\\")
    {
        return Some(JunkCategory::FontCache);
    }
    if normalized.contains("\\appdata\\local\\microsoft\\windows\\clipboard\\") {
        return Some(JunkCategory::ClipboardCache);
    }
    None
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_ascii_lowercase()
}

fn contains_any(path: &str, markers: &[&str]) -> bool {
    markers.iter().any(|marker| path.contains(marker))
}

fn is_excluded_path(path: &str) -> bool {
    contains_any(
        path,
        &[
            "\\$recycle.bin\\",
            "\\system volume information\\",
            "\\program files\\",
            "\\program files (x86)\\",
            "\\users\\default\\",
            "\\windows\\system32\\",
            "\\windows\\syswow64\\",
            "\\windows\\winsxs\\",
            "\\windows\\assembly\\",
            "\\windows\\servicing\\",
            "\\programdata\\microsoft\\windows defender\\",
            "\\appdata\\local\\packages\\",
            "\\ebwebview\\default\\",
            "\\local storage\\",
            "\\indexeddb\\",
            "\\session storage\\",
            "\\databases\\",
            "\\file system\\",
        ],
    ) && !is_shader_cache(path)
        && !is_defender_cache(path)
}

fn is_shader_cache(path: &str) -> bool {
    contains_any(
        path,
        &[
            "\\windows\\system32\\d3d_cache\\",
            "\\appdata\\local\\d3dscache\\",
            "\\appdata\\local\\amd\\dxcache\\",
            "\\appdata\\local\\nvidia\\dxcache\\",
            "\\appdata\\local\\intel\\shadercache\\",
        ],
    )
}

fn is_defender_cache(path: &str) -> bool {
    contains_any(
        path,
        &[
            "\\programdata\\microsoft\\windows defender\\localcopy\\",
            "\\programdata\\microsoft\\windows defender\\support\\",
        ],
    )
}

fn is_browser_cache(path: &str) -> bool {
    let known_browser = contains_any(
        path,
        &[
            "\\google\\chrome\\user data\\",
            "\\microsoft\\edge\\user data\\",
            "\\bravesoftware\\brave-browser\\user data\\",
            "\\mozilla\\firefox\\profiles\\",
            "\\opera software\\opera stable\\",
        ],
    );
    known_browser
        && contains_any(
            path,
            &[
                "\\cache\\",
                "\\code cache\\",
                "\\gpucache\\",
                "\\shadercache\\",
                "\\cache2\\",
            ],
        )
}

fn is_user_profile_cache(path: &str) -> bool {
    if path.contains("\\appdata\\local\\packages\\") {
        return false;
    }

    let profile_markers = [
        "\\appdata\\local\\",
        "\\appdata\\locallow\\",
        "\\appdata\\roaming\\",
    ];
    let Some(profile_marker) = profile_markers
        .iter()
        .find(|marker| path.contains(**marker))
    else {
        return false;
    };
    let Some(profile_path) = path.split_once(profile_marker).map(|(_, suffix)| suffix) else {
        return false;
    };
    let segments = profile_path.split('\\').collect::<Vec<_>>();
    let cache_names = [
        "cache",
        "caches",
        "code cache",
        "gpucache",
        "shadercache",
        "d3dscache",
        "crashdumps",
    ];

    segments
        .iter()
        .take(segments.len().saturating_sub(1))
        .any(|segment| {
            cache_names
                .iter()
                .any(|name| segment.eq_ignore_ascii_case(name))
        })
}

fn is_thumbnail_cache(path: &str) -> bool {
    if !path.contains("\\appdata\\local\\microsoft\\windows\\explorer\\") {
        return false;
    }
    let Some(name) = Path::new(path).file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    (name.starts_with("thumbcache_") || name.starts_with("iconcache_")) && name.ends_with(".db")
}

fn is_windows_log(path: &str) -> bool {
    if !path.contains("\\windows\\logs\\") || path.contains("\\windows\\logs\\cbs\\") {
        return false;
    }
    matches!(
        Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("log" | "etl" | "evtx")
    )
}

#[cfg(test)]
mod tests {
    use super::{
        create_session, get_category_page, get_paths_for_categories, is_deep_junk_path,
        DeepJunkScanResult,
    };
    use crate::scanner::{CategoryScanResult, FileInfo, JunkCategory};

    #[test]
    fn matches_only_high_confidence_junk_paths() {
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Temp\old.tmp"
        ));
        assert!(is_deep_junk_path(
            r"E:\Google\Chrome\User Data\Default\Cache\data_1"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\SomeTool\Cache\data_1"
        ));
        assert!(is_deep_junk_path(r"D:\Windows\Prefetch\OLD.PF"));
        assert!(!is_deep_junk_path(r"D:\Users\Alice\Downloads\old.tmp"));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Packages\App\EBWebView\Default\Cache\data"
        ));
        assert!(!is_deep_junk_path(r"D:\$Recycle.Bin\S-1-5-21\$R123"));
    }

    #[test]
    fn keeps_persistent_profile_data_out_of_relaxed_cache_rules() {
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\SomeTool\Caches\old.bin"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\SomeTool\Local Storage\leveldb\data"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Packages\Some.App\LocalCache\Cache\data"
        ));
    }

    #[test]
    fn keeps_shader_cache_as_a_known_system_exception() {
        assert!(is_deep_junk_path(
            r"C:\Windows\System32\d3d_cache\shader.bin"
        ));
    }

    #[test]
    fn matches_windows_cleanup_wizard_cache_categories() {
        assert!(is_deep_junk_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Support\MPLog-old.log"
        ));
        assert!(is_deep_junk_path(
            r"C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache\payload.bin"
        ));
        assert!(!is_deep_junk_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Quarantine\entry.bin"
        ));
    }

    #[test]
    fn pages_large_deep_results_without_changing_total_count() {
        let mut category = CategoryScanResult::new(JunkCategory::WindowsTemp);
        for index in 0..501 {
            category.add_file(FileInfo::new(
                format!(r"D:\Users\Test\AppData\Local\Temp\{}.tmp", index),
                format!("{}.tmp", index),
                1,
                1,
                false,
                JunkCategory::WindowsTemp,
            ));
        }
        let result = DeepJunkScanResult {
            scan_mode: "deep".to_string(),
            scan_id: String::new(),
            categories: vec![category],
            total_size: 501,
            total_file_count: 501,
            scan_duration_ms: 0,
            scan_timestamp: 0,
            drives: Vec::new(),
        };

        let first_page = create_session(result).expect("创建深度扫描会话");
        assert_eq!(first_page.categories[0].files.len(), 500);
        assert_eq!(first_page.categories[0].file_count, 501);
        assert!(first_page.categories[0].has_more);

        let second_page = get_category_page(&first_page.scan_id, "Windows临时文件", 500, 500)
            .expect("获取深度扫描第二页");
        assert_eq!(second_page.files.len(), 1);
        assert!(!second_page.has_more);

        let category_names = vec!["Windows临时文件".to_string()];
        let excluded_paths = vec![first_page.categories[0].files[0].path.clone()];
        let full_paths =
            get_paths_for_categories(&first_page.scan_id, &category_names, &excluded_paths)
                .expect("恢复未分页的完整分类路径");
        // 后端应返回整类 501 个文件，并正确排除前端明确取消的 1 个路径。
        assert_eq!(full_paths.len(), 500);
        assert!(full_paths.iter().any(|path| path.ends_with("500.tmp")));
    }
}
