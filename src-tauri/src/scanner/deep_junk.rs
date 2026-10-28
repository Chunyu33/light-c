// ============================================================================
// 垃圾清理深度扫描器
//
// 深度扫描在快速扫描的已知垃圾目录基础上，覆盖全部分区、全部用户，并通过
// MFT/USN 与受控遍历补扫缓存目录；命中规则只识别高置信度的临时文件、缓存
// 和报告目录，不使用全盘扩展名泛匹配，避免把用户的日志、下载文件或项目
// 文件误判为垃圾。深度扫描与快速扫描一样不按文件修改时间过滤，保证深度
// 扫描结果（数量与体积）始终是快速扫描的超集。
// ============================================================================

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use rayon::prelude::*;
use serde::Serialize;
use tauri::{Emitter, Window};
use walkdir::WalkDir;

use super::{CategoryScanResult, FileInfo, JunkCategory};

const DEEP_JUNK_PAGE_SIZE: usize = 500;
// 深度扫描耗时长，用户扫描后还需浏览分类和翻页，会话保留 60 分钟避免过早失效。
const DEEP_JUNK_SESSION_TTL: Duration = Duration::from_secs(60 * 60);
// 允许保留的深度扫描会话数，避免用户连续多次扫描时旧会话被立即挤出。
const MAX_DEEP_JUNK_SESSIONS: usize = 4;

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
    /// 各阶段耗时，用来定位一次扫描慢在哪一段。
    pub stage_durations: Vec<DeepJunkStageDuration>,
    /// 本盘从开始到结束的总耗时（含未单独计时的零碎开销）。
    pub total_duration_ms: u64,
    /// `$MFT` 的 data run 个数。段数越多说明表越碎，顺序读的预读越容易失效。
    pub mft_fragments: usize,
    /// 读 `$MFT` 时等磁盘的时间，与下面的解析时间分开计。
    pub mft_io_ms: u64,
    /// 解析 `$MFT` 记录（fixup + 属性）的时间。
    pub mft_parse_ms: u64,
}

/// 单个扫描阶段的耗时。
#[derive(Debug, Clone, Serialize)]
pub struct DeepJunkStageDuration {
    pub stage: String,
    pub duration_ms: u64,
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
    /// 各盘之外的开销：发现分区、回收站、并行等待、汇总。
    ///
    /// 之前只有单盘内部的耗时，第一次扫描 26.9 秒而四盘相加才 12.8 秒，
    /// 中间十几秒落在哪个环节完全看不出来。
    pub outer_stages: Vec<DeepJunkStageDuration>,
    /// 进度上报累计等待（多线程求和）。用来判断发进度是否在阻塞扫描线程。
    pub emit_wait_ms: u64,
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

/// 深度扫描的递归层数上限，由设置页的「深度发现扫描深度」传入。
///
/// 用模块级状态而不是逐层传参：扫描链路要经过 MFT 补扫、受控遍历补扫等多条路径，
/// 逐层加参数会散落到五六个函数签名上；这里和取消标志放在一起，与文件既有写法一致，
/// 也保证"本次扫描用哪个深度"只有一处真相。
static DEEP_SCAN_MAX_DEPTH: AtomicU64 = AtomicU64::new(DEFAULT_DEEP_SCAN_DEPTH);

/// 默认层数，与前端 `junkDeepScanDepth` 的默认值保持一致（设置页默认 16）。
/// 原先写死 12 层偏保守 —— 深度扫描本来就是为了找藏得深的缓存，太浅会漏。
const DEFAULT_DEEP_SCAN_DEPTH: u64 = 16;

/// 上限兜底：即使前端传了异常值，也不会让遍历深度失控导致扫描时间爆炸。
const MAX_DEEP_SCAN_DEPTH: u64 = 24;

/// 设置本次深度扫描的递归层数。命令入口在 `reset_cancelled()` 之后调用。
/// 传 `None`（老前端或直接调用命令）时退回默认值，保证行为可预期。
pub fn set_scan_depth(depth: Option<u32>) {
    let resolved = depth
        .map(|value| (value as u64).clamp(1, MAX_DEEP_SCAN_DEPTH))
        .unwrap_or(DEFAULT_DEEP_SCAN_DEPTH);
    DEEP_SCAN_MAX_DEPTH.store(resolved, Ordering::SeqCst);
}

/// 读取本次扫描的递归层数上限。
fn scan_depth() -> usize {
    DEEP_SCAN_MAX_DEPTH.load(Ordering::SeqCst) as usize
}

/// 执行所有固定分区的深度垃圾扫描。
pub fn scan_all(window: &Window) -> Result<DeepJunkScanResult, String> {
    let started_at = std::time::Instant::now();
    let mut outer_stages: Vec<DeepJunkStageDuration> = Vec::new();
    EMIT_WAIT_MS.store(0, Ordering::Relaxed);
    let mut categories = JunkCategory::all()
        .into_iter()
        .map(CategoryScanResult::new)
        .collect::<Vec<_>>();
    let mut drives = Vec::new();

    #[cfg(windows)]
    {
        let stage = std::time::Instant::now();
        let drive_letters = fixed_drive_letters()?;
        record_stage(&mut outer_stages, "discover", stage);
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

        // 各盘之间互不依赖，必须并行扫：串行时总耗时等于各盘之和
        // （实测 C 7.3s + D 2.7s + E 6.9s + F 1.1s = 18s），
        // 并行后总耗时接近最慢的那个盘，剩下的时间就是白等的。
        // 磁盘相互独立时收益最大；若两个盘符在同一块物理盘上，会共享带宽，收益打折。
        let stage = std::time::Instant::now();
        let (drive_results, recycle_result, recycle_ms) =
            std::thread::scope(|scope| {
                // 深度模式仍保留回收站的 Explorer 可见条目，不能用 MFT 直接枚举内部文件。
                // 它和各盘互不依赖，所以放进同一个 scope —— 原来串行跑在并行块之前，
                // 实测要 1.5 秒，那 1.5 秒纯属排队。
                let recycle_handle = scope.spawn(|| {
                    let recycle_started = std::time::Instant::now();
                    let mut result = CategoryScanResult::new(JunkCategory::RecycleBin);
                    super::recycle_bin::scan_current_user(
                        &JunkCategory::RecycleBin,
                        &mut result,
                    );
                    (result, recycle_started.elapsed().as_millis() as u64)
                });

                let handles: Vec<_> = drive_letters
                    .iter()
                    .map(|&drive_letter| {
                        scope.spawn(move || {
                            let result =
                                if super::big_files_engine::mft_core::is_ntfs(drive_letter) {
                                    match scan_ntfs_drive(drive_letter, window, started_at) {
                                        Ok(result) => Ok(result),
                                        Err(error) if error == "扫描已取消" => Err(error),
                                        Err(error) => {
                                            warn!(
                                                "{} 盘 MFT 深度扫描失败，降级为受控遍历: {}",
                                                drive_letter, error
                                            );
                                            Ok(scan_non_ntfs_drive(
                                                drive_letter,
                                                window,
                                                started_at,
                                                "NTFS",
                                                Some(format!(
                                                    "MFT 扫描失败，已降级为受控目录遍历: {}",
                                                    error
                                                )),
                                            ))
                                        }
                                    }
                                } else {
                                    Ok(scan_non_ntfs_drive(
                                        drive_letter,
                                        window,
                                        started_at,
                                        "非 NTFS",
                                        Some(
                                            "非 NTFS 分区使用受控目录遍历，未执行 MFT 扫描"
                                                .to_string(),
                                        ),
                                    ))
                                };
                            (drive_letter, result)
                        })
                    })
                    .collect();
                // join 顺序与创建顺序一致，结果仍按盘符顺序返回
                let drives: Vec<(char, Result<DriveScanResult, String>)> = handles
                    .into_iter()
                    .map(|handle| handle.join().expect("扫描线程异常退出"))
                    .collect();
                let (recycle, recycle_ms) =
                    recycle_handle.join().expect("回收站扫描线程异常退出");
                (drives, recycle, recycle_ms)
            });

        // 回收站和各盘在同一个并行窗口里跑，所以它不再累加到总时间上；
        // 仍然单独记一笔，用来判断它是否成了最慢的那个分支。
        outer_stages.push(DeepJunkStageDuration {
            stage: "recycle".to_string(),
            duration_ms: recycle_ms,
        });
        record_stage(&mut outer_stages, "parallel", stage);

        if let Some(category_result) = categories
            .iter_mut()
            .find(|item| item.category == JunkCategory::RecycleBin)
        {
            for file in recycle_result.files {
                category_result.add_file(file);
            }
        }

        let stage = std::time::Instant::now();
        for (_drive_letter, result) in drive_results {
            let result = result?;

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
        record_stage(&mut outer_stages, "merge", stage);
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
        outer_stages,
        emit_wait_ms: EMIT_WAIT_MS.load(Ordering::Relaxed),
    };
    result.total_size = result.categories.iter().map(|item| item.total_size).sum();
    result.total_file_count = result.categories.iter().map(|item| item.file_count).sum();

    // 深度结果按分区先后合并，分区内又按路径排序，顺序对用户没有意义。
    // 在建立会话前统一按大小倒序，保证前端分页拿到的是“最大的文件先出现”。
    for category in &mut result.categories {
        category.sort_files_by_size_desc();
    }

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

    let drive_started = std::time::Instant::now();
    let mut stage_durations: Vec<DeepJunkStageDuration> = Vec::new();
    let drive_label = format!("{}:", drive_letter);
    emit_progress(
        window,
        "mft",
        &drive_label,
        "正在读取 NTFS 主文件表",
        0,
        0,
        started_at,
    );

    // 一次顺序读 $MFT 就能同时拿到名字（$FILE_NAME 属性）、父子关系和大小（$DATA 属性）。
    // 原先先走一次 USN 枚举拿名字、再读一遍 $MFT 拿大小，同一份数据过了两遍；
    // 实测 USN 枚举是内核遍历整张表，比用户态顺序读慢 6 倍，所以这里只读一遍。
    let stage = std::time::Instant::now();
    let metadata_reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let (entries, mft_stats) = metadata_reader.read_all_records(&|processed| {
        if is_cancelled() {
            return false;
        }
        if processed == 0 || processed % 100_000 == 0 {
            emit_progress(
                window,
                "mft",
                &drive_label,
                &format!("正在读取 NTFS 主文件表，已检查 {} 条记录", processed),
                processed,
                0,
                started_at,
            );
        }
        true
    })?;
    record_stage(&mut stage_durations, "mft", stage);

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
    let stage = std::time::Instant::now();
    let directory_paths =
        mft_core::rebuild_paths_for_records(&entries, drive_letter, &parent_ids);
    record_stage(&mut stage_durations, "path", stage);
    // 候选只记下标，不克隆整条记录：命中规则的文件通常只有几千条，
    // 但记录的字段（含文件名字符串）在组装阶段还要用，存下标最省。
    let stage = std::time::Instant::now();
    // 规则匹配是纯 CPU：全盘上百万条路径逐条比对字符串，单线程要两秒多。
    // 按块切分后交给 rayon，块内仍用两块复用缓冲，块间互不影响。
    const FILTER_CHUNK: usize = 16_384;
    let per_chunk: Vec<Vec<(usize, JunkCategory, String)>> = entries
        .par_chunks(FILTER_CHUNK)
        .enumerate()
        .map(|(chunk_index, chunk)| {
            let mut local: Vec<(usize, JunkCategory, String)> = Vec::new();
            // 每块自带缓冲，避免线程间共享
            let mut path_buffer = String::with_capacity(512);
            let mut normalize_buffer: Vec<u8> = Vec::with_capacity(512);
            for (offset, entry) in chunk.iter().enumerate() {
                if is_cancelled() {
                    return local;
                }
                if entry.is_dir {
                    continue;
                }
                let Some(parent_path) = directory_paths.get(&entry.parent_id) else {
                    continue;
                };
                // MFT 已经给出父目录字符串；直接拼接可以省掉 PathBuf 和 OsString 的中间转换。
                join_mft_path_into(parent_path, &entry.name, &mut path_buffer);
                let Some(category) =
                    match_deep_junk_category_reusing(&path_buffer, &mut normalize_buffer)
                else {
                    continue;
                };
                // 走到这里才说明真的命中了，这时候才值得分配一份路径
                local.push((
                    chunk_index * FILTER_CHUNK + offset,
                    category,
                    path_buffer.clone(),
                ));
            }
            local
        })
        .collect();

    // 去重放在合并之后串行做：par_chunks 保证按块顺序返回，结果与串行一致
    let mut candidates: Vec<(usize, JunkCategory, String)> = Vec::new();
    let mut candidate_paths = HashSet::new();
    for chunk in per_chunk {
        for (index, category, path_string) in chunk {
            if !candidate_paths.insert(path_string.to_ascii_lowercase()) {
                continue;
            }
            candidates.push((index, category, path_string));
        }
    }
    record_stage(&mut stage_durations, "filter", stage);
    let enumerated_count = entries.len();
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
                stage_durations,
                total_duration_ms: drive_started.elapsed().as_millis() as u64,
                mft_fragments: mft_stats.fragments,
                mft_io_ms: mft_stats.io_ms,
                mft_parse_ms: mft_stats.parse_ms,
            },
            files: Vec::new(),
        });
    }

    // 大小和修改时间在顺序读 $MFT 时已经解析好，这里不再二次读盘
    let mut files = Vec::new();
    for (index, category, path) in candidates {
        let record = &entries[index];
        files.push((
            category.clone(),
            FileInfo::new(
                path,
                record.name.clone(),
                record.size,
                record.modified,
                false,
                category,
            ),
        ));
    }

    // MFT/USN 枚举只覆盖变更日志中尚存的记录，老且长期未变的系统缓存文件会被跳过；
    // 这里对所有白名单缓存根目录做一次受控遍历，与 MFT 结果按小写路径去重后补齐缺口。
    let stage = std::time::Instant::now();
    scan_supplement_roots(drive_letter, window, started_at, &mut files);
    record_stage(&mut stage_durations, "walkdir", stage);

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
            stage_durations,
            total_duration_ms: drive_started.elapsed().as_millis() as u64,
            mft_fragments: mft_stats.fragments,
            mft_io_ms: mft_stats.io_ms,
            mft_parse_ms: mft_stats.parse_ms,
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
    let drive_started = std::time::Instant::now();
    let drive_label = format!("{}:", drive_letter);
    let mut files = Vec::new();
    let mut visited = HashSet::new();

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
            // 递归层数改由设置页控制（默认 16、上限 24），不再写死。
            .max_depth(scan_depth())
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
            // 常规遍历只有一次完整扫描，不再细分阶段；没有 MFT 也就没有这些统计
            stage_durations: Vec::new(),
            total_duration_ms: drive_started.elapsed().as_millis() as u64,
            mft_fragments: 0,
            mft_io_ms: 0,
            mft_parse_ms: 0,
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
fn system_level_cache_roots(root: &Path) -> Vec<PathBuf> {
    vec![
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
        // Defender 扫描历史目录（扫描结束后自动重建），与 Windows 清理向导的 Defender 项一致。
        root.join("ProgramData\\Microsoft\\Windows Defender\\Scans\\History\\Service"),
        root.join("Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\FontCache"),
        root.join("Windows\\Installer\\$PatchCache$"),
        root.join("Windows\\System32\\d3d_cache"),
        // 系统级临时缓存：更新回滚暂存、内核崩溃报告（深度受限，见下）、
        // Windows Update 与应用商店日志。这些目录只包含可重建的诊断/更新数据。
        root.join("Windows\\SystemTemp"),
        root.join("Windows\\Logs\\WindowsUpdate"),
        root.join("Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Packages\\Microsoft.WindowsStore_8wekyb3d8bbwe\\LocalCache"),
        // 以下为此前未覆盖、但同样只含可重建数据的目录。
        // ⚠️ Windows\Logs\CBS **刻意不加** —— is_windows_log 里明确排除了它，
        //    因为组件安装日志是排查更新故障的依据，属于"有用"而非垃圾。
        root.join("Windows\\Panther"),                        // 安装/升级日志与残留
        root.join("Windows\\Performance\\WinSAT"),            // 体验指数（Windows 体验评分）数据，可重建
        root.join("Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\Temp"), // 服务账户临时目录，会持续堆积
        root.join("ProgramData\\USOShared\\Logs"),            // 更新协调器日志
        root.join("ProgramData\\NVIDIA Corporation\\NV_Cache"), // 显卡着色器缓存，驱动会自行重建
        root.join("ProgramData\\NVIDIA\\Downloader"),          // 驱动安装包残留
    ]
}

/// 需要限制遍历深度的补充根目录。
///
/// 中文说明：这些目录本身是可重建缓存，但内部可能包含大量嵌套的小文件（例如 WER 的报告队列
/// 会按应用/时间建多层子目录）。限制深度可以在覆盖真实垃圾的同时，避免深度扫描把时间花在
/// 深不见底的目录树上。
#[cfg(windows)]
fn depth_limited_system_cache_roots(root: &Path) -> Vec<(PathBuf, usize)> {
    vec![
        (root.join("ProgramData\\Microsoft\\Windows\\WER"), 2),
        (root.join("Windows\\LiveKernelReports"), 1),
    ]
}

/// 每个用户配置目录下的明确高置信缓存子目录。
/// 只遍历可重建缓存，避免触碰 WebView/Chromium 持久化 Profile 数据。
#[cfg(windows)]
fn user_level_cache_roots(profile: &Path) -> Vec<PathBuf> {
    let local = profile.join("AppData\\Local");
    let roaming = profile.join("AppData\\Roaming");
    vec![
        local.join("Temp"),
        local.join("CrashDumps"),
        local.join("Downloaded Installations"),
        local.join("D3DSCache"),
        local.join("AMD\\DxCache"),
        local.join("NVIDIA\\DXCache"),
        local.join("Intel\\ShaderCache"),
        local.join("Microsoft\\Windows\\INetCache"),
        local.join("Microsoft\\Windows\\Caches"),
        local.join("Microsoft\\Windows\\Explorer"),
        local.join("Microsoft\\Windows\\WebCache"),
        local.join("Microsoft\\Windows\\Clipboard"),
        local.join("Microsoft\\Windows\\WER"),
        // Firefox 崩溃恢复缓存放在 Roaming 下；Chromium 系浏览器的 Service Worker / 媒体缓存
        // 位于各浏览器 user data 之下，由深度规则覆盖。
        roaming.join("Mozilla\\Firefox\\Crash Reports"),
    ]
}

#[cfg(windows)]
fn non_ntfs_scan_roots(drive_letter: char) -> Vec<PathBuf> {
    let root = PathBuf::from(format!("{}:\\", drive_letter));
    let mut roots = system_level_cache_roots(&root);

    // 非 NTFS 分区无 MFT，需要覆盖整个 AppData\Local 才能发现 AppCache 等分散缓存。
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

/// NTFS 深度扫描的补扫根目录。
/// MFT/USN 枚举只返回变更日志中尚存的记录，老且长期未变、或祖先目录记录被淘汰的
/// 系统缓存文件会被静默跳过；这里对每个用户只列出明确的高置信缓存子目录做受控遍历，
/// 与 MFT 结果去重合并，保证传递优化、更新缓存、缩略图等系统目录稳定覆盖。
#[cfg(windows)]
fn supplement_ntfs_scan_roots(drive_letter: char) -> Vec<PathBuf> {
    let root = PathBuf::from(format!("{}:\\", drive_letter));
    let mut roots = system_level_cache_roots(&root);

    let users_root = root.join("Users");
    if let Ok(users) = std::fs::read_dir(users_root) {
        for user in users.filter_map(Result::ok) {
            let profile = user.path();
            if profile.is_dir() {
                roots.extend(user_level_cache_roots(&profile));
            }
        }
    }
    roots
}

/// 对补扫根目录做受控遍历，把 MFT 枚举遗漏的高置信缓存文件补充进结果。
/// 已存在于 results 中的路径（小写比较）直接跳过，避免与 MFT 结果重复统计。
#[cfg(windows)]
fn scan_supplement_roots(
    drive_letter: char,
    window: &Window,
    started_at: std::time::Instant,
    results: &mut Vec<(JunkCategory, FileInfo)>,
) {
    let drive_label = format!("{}:", drive_letter);
    let mut visited = results
        .iter()
        .map(|(_, file)| file.path.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    emit_progress(
        window,
        "walkdir",
        &drive_label,
        "正在补扫系统缓存目录，兜底 MFT 未覆盖的文件",
        results.len(),
        results.len(),
        started_at,
    );

    let drive_root = PathBuf::from(format!("{}:\\", drive_letter));

    // 先把补扫根筛成一份待办清单，再并行跑。
    // 筛选（去掉被父目录覆盖的根）必须串行 —— 它依赖"已经收下哪些根"的顺序。
    let mut jobs: Vec<(PathBuf, usize)> = Vec::new();
    let mut scanned_roots = Vec::new();
    for root in supplement_ntfs_scan_roots(drive_letter) {
        if is_cancelled() {
            return;
        }
        if is_redundant_supplement_root(&root, &scanned_roots) {
            continue;
        }
        // 没有单独限深的补扫根目录，跟着设置页的层数走。
        jobs.push((root.clone(), scan_depth()));
        scanned_roots.push(root);
    }

    // 深度受限的补充根：只覆盖根目录附近的真实垃圾，避免深入无意义的多层子目录。
    for (root, max_depth) in depth_limited_system_cache_roots(&drive_root) {
        if is_cancelled() {
            return;
        }
        if is_redundant_supplement_root(&root, &scanned_roots) {
            continue;
        }
        // 这些根目录自带限深（避免在超深的目录树里跑太久），取两者较大值：
        // 设置页调大时能生效，调小时仍保留各根目录自己的下限，不会因为用户调小就漏扫。
        jobs.push((root.clone(), max_depth.max(scan_depth())));
        scanned_roots.push(root);
    }

    // 各根目录互不依赖，并行走：实测 C 盘这一阶段 1.5 秒，原来是单线程把几十个
    // 目录排队遍历完，而它们分布在不同的子树里，本身没有先后关系。
    let batches: Vec<Vec<(JunkCategory, FileInfo)>> = jobs
        .par_iter()
        .map(|(root, max_depth)| {
            let mut local = Vec::new();
            // 每个根自带一份去重集：根之间可能有嵌套，合并时再统一去重
            let mut local_visited = HashSet::new();
            scan_supplement_root(root, *max_depth, &mut local, &mut local_visited);
            local
        })
        .collect();

    // 合并按待办清单顺序做，重复路径以先出现的为准，结果和串行一致
    for batch in batches {
        for (category, file) in batch {
            let key = file.path.to_ascii_lowercase();
            if !visited.insert(key) {
                continue;
            }
            results.push((category, file));
        }
    }
}

#[cfg(windows)]
fn join_mft_path_into(parent: &str, name: &str, buffer: &mut String) {
    // 写进调用方的缓冲：全盘几百万条路径逐条分配 String 是这步的主要开销，
    // 只有命中规则的那几千条才需要真正拥有一份路径。
    buffer.clear();
    buffer.reserve(parent.len() + 1 + name.len());
    buffer.push_str(parent);
    if !parent.ends_with('\\') && !parent.ends_with('/') {
        buffer.push('\\');
    }
    buffer.push_str(name);
}

#[cfg(windows)]
fn is_redundant_supplement_root(root: &Path, scanned_roots: &[PathBuf]) -> bool {
    let normalized = root.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    scanned_roots.iter().any(|scanned| {
        let existing = scanned
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
        normalized == existing || normalized.starts_with(&format!("{}\\", existing))
    })
}

/// 对单个补扫根做受控遍历，把命中的高置信缓存文件追加到 results。
/// max_depth 为 0 时只检查根目录自身，不做递归。
#[cfg(windows)]
fn scan_supplement_root(
    root: &Path,
    max_depth: usize,
    results: &mut Vec<(JunkCategory, FileInfo)>,
    visited: &mut HashSet<String>,
) {
    if !root.exists() {
        return;
    }

    // 1) 目录树内并行收集文件路径。
    // 补扫的开销几乎全压在单个大目录上（实测 Temp 19671 项 / 1.4 秒，
    // 其余三十多个根加起来 10 毫秒），跨根并行救不了它，必须在树内部分叉。
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files_parallel(root, max_depth, &mut files);

    // 2) 规则匹配也是纯 CPU，跟着并行；不命中的文件到此为止，不碰 stat
    let hits: Vec<(JunkCategory, PathBuf)> = files
        .into_par_iter()
        .filter_map(|path| {
            let mut normalize_buffer: Vec<u8> = Vec::with_capacity(512);
            let text = path.to_string_lossy();
            match_deep_junk_category_reusing(&text, &mut normalize_buffer)
                .map(|category| (category, path))
        })
        .collect();

    // 3) 去重和取元数据串行做：走到这里的只有命中的条目，量级是几千而不是几万
    for (category, path) in hits {
        let path = path.to_string_lossy().into_owned();
        if !visited.insert(path.to_ascii_lowercase()) {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64)
            .unwrap_or(0);
        let name = Path::new(&path)
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        results.push((
            category.clone(),
            FileInfo::new(path, name, metadata.len(), modified, false, category),
        ));
    }
}

/// 收集 `dir` 下这一层的文件，子目录追加到 `subdirs`（`remaining` 为 1 时不往下走）。
/// 只认真实文件：符号链接和重解析点一律跳过，和原来 `WalkDir::follow_links(false)` 一致。
#[cfg(windows)]
fn collect_level(
    dir: &Path,
    remaining: usize,
    out: &mut Vec<PathBuf>,
    subdirs: &mut Vec<PathBuf>,
) {
    if remaining == 0 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.filter_map(Result::ok) {
        if is_cancelled() {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() {
            out.push(entry.path());
        } else if kind.is_dir() && remaining > 1 {
            subdirs.push(entry.path());
        }
    }
}

/// 串行遍历一棵子树（并行分支内部用）。
#[cfg(windows)]
fn collect_tree_serial(dir: &Path, remaining: usize, out: &mut Vec<PathBuf>) {
    if remaining == 0 {
        return;
    }
    let mut subdirs = Vec::new();
    collect_level(dir, remaining, out, &mut subdirs);
    for child in subdirs {
        collect_tree_serial(&child, remaining - 1, out);
    }
}

/// 只在根目录的第一层分叉，各子树内部串行。
///
/// 只分叉一层是有意的：更深的递归会让任务碎到调度开销超过收益，
/// 而这一层的分布本来就是不均的（大目录各自成任务，正好被分到不同线程）。
#[cfg(windows)]
fn collect_files_parallel(root: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    let mut subdirs = Vec::new();
    collect_level(root, max_depth, out, &mut subdirs);
    if subdirs.is_empty() {
        return;
    }
    let nested: Vec<Vec<PathBuf>> = subdirs
        .par_iter()
        .map(|child| {
            let mut local = Vec::new();
            collect_tree_serial(child, max_depth - 1, &mut local);
            local
        })
        .collect();
    for chunk in nested {
        out.extend(chunk);
    }
}

/// 记录一个阶段的耗时。
///
/// 阶段之间是串行的，单独计时才看得出哪一段是大头 —— 之前只能靠猜。
fn record_stage(
    durations: &mut Vec<DeepJunkStageDuration>,
    stage: &str,
    started: std::time::Instant,
) {
    durations.push(DeepJunkStageDuration {
        stage: stage.to_string(),
        duration_ms: started.elapsed().as_millis() as u64,
    });
}

/// 进度上报累计等待毫秒。四个盘并发上报，这里存的是各线程等待之和。
static EMIT_WAIT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    // 计时包住 emit：如果它内部要等主线程处理，扫描线程就会被拖住，
    // 这也是"第一次扫描特别慢"的一个候选原因（首次启动时 WebView 还在初始化）。
    let emit_started = std::time::Instant::now();
    if let Err(error) = window.emit("junk-clean:progress", &progress) {
        warn!("发送垃圾深度扫描进度失败: {}", error);
    }
    EMIT_WAIT_MS.fetch_add(
        emit_started.elapsed().as_millis() as u64,
        Ordering::Relaxed,
    );
}

fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

/// 判断路径是否属于深度清理允许的高置信度目录。
pub fn is_deep_junk_path(path: &str) -> bool {
    super::recycle_bin::is_current_user_entry_path(path) || match_deep_junk_category(path).is_some()
}

fn match_deep_junk_category(path: &str) -> Option<JunkCategory> {
    let mut buffer = Vec::new();
    match_deep_junk_category_reusing(path, &mut buffer)
}

/// 规则命中的必要条件：规范化（小写）后的路径必须含以下之一。
///
/// 这份清单是从下面全部规则反推出来的，**每一条规则都至少需要其中一个**，
/// 漏一个就会让那一类垃圾扫不出来。改动规则时必须同步检查这里。
const JUNK_PATH_HINTS: &[&str] = &[
    // 三个系统级根目录，覆盖绝大多数规则
    "\\appdata\\",
    "\\windows\\",
    "\\programdata\\",
    // 旧系统残留：目录名本身就是关键字，不以 \windows\ 开头
    "\\windows.old\\",
    "\\$windows.~bt\\",
    "\\$windows.~ws\\",
    // 浏览器与第三方应用的缓存不一定放在 AppData 下
    // （实测用例：E://Google//Chrome//User Data\Default\Cache 同样要算浏览器缓存）
    "\\google\\",
    "\\microsoft\\edge\\",
    "\\bravesoftware\\",
    "\\mozilla\\firefox\\",
    "\\opera software\\",
    "\\tencent\\qqbrowser\\",
    "\\360chrome\\",
    "\\360se6\\",
    "\\sogouexplorer\\",
    "\\ucbrowser\\",
    "\\2345explorer\\",
    "\\liebao\\",
    "\\vivaldi\\",
    "\\yandexbrowser\\",
    "\\centbrowser\\",
    "\\discord\\",
    "\\slack\\",
    "\\microsoft\\teams\\",
    "\\steam\\",
    "\\epicgameslauncher\\",
    "\\netease\\cloudmusic\\",
    "\\tencent\\qqmusic\\",
];

/// 粗筛：路径里是否可能出现上面某个前缀。只做字节比较，不分配、不转换大小写。
///
/// 全盘百万级路径里，绝大多数跟垃圾规则无关。先在这里挡掉，
/// 后面那几个字符串分配和十几条规则就不用跑了。
fn could_be_junk_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    for (index, &byte) in bytes.iter().enumerate() {
        // 前缀都以分隔符开头
        if byte != b'\\' && byte != b'/' {
            continue;
        }
        let Some(&next) = bytes.get(index + 1) else {
            continue;
        };
        // 先看首字母，对不上就不用做完整比较
        match next.to_ascii_lowercase() {
            b'a' | b'b' | b'c' | b'd' | b'e' | b'g' | b'l' | b'm' | b'n' | b'o' | b'p' | b's'
            | b't' | b'u' | b'v' | b'w' | b'y' | b'$' | b'2' | b'3' => {}
            _ => continue,
        }
        let rest = &bytes[index..];
        if JUNK_PATH_HINTS
            .iter()
            .any(|hint| starts_with_ignore_ascii_case(rest, hint.as_bytes()))
        {
            return true;
        }
    }
    false
}

fn starts_with_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
    if haystack.len() < needle.len() {
        return false;
    }
    haystack
        .iter()
        .zip(needle)
        .all(|(left, right)| left.to_ascii_lowercase() == *right)
}

/// 把路径写进可复用的字节缓冲：`/` 统一成 `\`，ASCII 大写转小写。
///
/// 逐字节处理，非 ASCII 字节原样保留，所以中文路径不会被破坏；
/// 缓冲复用让百万次调用只分配一次，而不是每次两个 String。
fn normalize_into(path: &str, buffer: &mut Vec<u8>) {
    buffer.clear();
    buffer.reserve(path.len());
    for &byte in path.as_bytes() {
        buffer.push(match byte {
            b'/' => b'\\',
            b'A'..=b'Z' => byte + 32,
            _ => byte,
        });
    }
}

/// 与 `match_deep_junk_category` 相同，但复用调用方的缓冲做规范化。
///
/// 深度扫描是对全盘每个文件调用一次，这里的分配次数直接反映在耗时上。
fn match_deep_junk_category_reusing(
    path: &str,
    normalize_buffer: &mut Vec<u8>,
) -> Option<JunkCategory> {
    if !could_be_junk_path(path) {
        return None;
    }
    normalize_into(path, normalize_buffer);
    let Ok(normalized) = std::str::from_utf8(normalize_buffer) else {
        return None;
    };
    if normalized.is_empty() {
        return None;
    }

    // 这三个白名单目录必须早于系统排除规则判断：
    // d3d_cache 位于 System32 下，Defender 目录位于被排除的 Defender 根目录下，
    // 而 Windows.old 内部本身还有一份 \Windows\System32\，晚了就会被当成系统目录整片丢掉。
    if is_shader_cache(normalized) {
        return Some(JunkCategory::ShaderCache);
    }
    if is_defender_cache(normalized) {
        return Some(JunkCategory::WindowsDefenderCache);
    }
    if is_old_windows_installation(normalized) {
        return Some(JunkCategory::OldWindowsInstallation);
    }
    if is_excluded_path(normalized) {
        return None;
    }

    if contains_any(
        normalized,
        &[
            "\\appdata\\local\\temp\\",
            "\\windows\\temp\\",
            // Windows 10/11 提供的系统级临时目录，只存放可清理的安装/更新解包数据。
            "\\windows\\systemtemp\\",
        ],
    ) {
        return Some(JunkCategory::WindowsTemp);
    }
    if contains_any(
        normalized,
        &[
            "\\windows\\softwaredistribution\\deliveryoptimization\\",
            "\\windows\\serviceprofiles\\networkservice\\appdata\\local\\microsoft\\windows\\deliveryoptimization\\",
        ],
    ) {
        return Some(JunkCategory::DeliveryOptimization);
    }
    if is_windows_internet_cache(normalized) {
        // 旧版 IE/WinINet 的缓存属于浏览器资源缓存，Cookies 使用独立目录并不会命中这里。
        return Some(JunkCategory::BrowserCache);
    }
    if contains_any(
        normalized,
        &[
            "\\windows\\prefetch\\",
            "\\appdata\\local\\microsoft\\windows\\caches\\",
            // 体验指数数据与显卡着色器缓存，都是删掉后系统/驱动自行重建的内容。
            "\\windows\\performance\\winsat\\",
            "\\programdata\\nvidia corporation\\nv_cache\\",
        ],
    ) {
        return Some(JunkCategory::SystemCache);
    }
    if is_browser_cache(normalized) {
        return Some(JunkCategory::BrowserCache);
    }
    if is_user_profile_cache(normalized) {
        // 第三方应用通常把可重建缓存放在用户配置目录下；仅匹配明确的缓存目录名，
        // 不把整个 AppData 当作垃圾，也不触碰 MSIX/WebView 持久化数据。
        return Some(JunkCategory::AppCache);
    }
    if is_third_party_app_cache(normalized) {
        // 补充已知应用的非常规缓存目录名（如 Steam htmlcache、Epic webcache），
        // 这些目录删除后应用会自动重建，归入独立分类便于用户识别。
        return Some(JunkCategory::ThirdPartyAppCache);
    }
    if contains_any(
        normalized,
        &["\\windows\\softwaredistribution\\download\\"],
    ) {
        return Some(JunkCategory::WindowsUpdate);
    }
    if is_thumbnail_cache(normalized) {
        return Some(JunkCategory::ThumbnailCache);
    }
    if contains_any(
        normalized,
        &[
            "\\appdata\\local\\crashdumps\\",
            "\\windows\\minidump\\",
            "\\appdata\\local\\microsoft\\windows\\wer\\",
            "\\programdata\\microsoft\\windows\\wer\\",
        ],
    ) {
        return Some(JunkCategory::WindowsErrorReports);
    }
    if normalized.ends_with("\\windows\\memory.dmp")
        // 内核崩溃报告目录（WATCHDOG 等子目录）里的转储文件同样是可清理的诊断数据。
        || normalized.contains("\\windows\\livekernelreports\\")
    {
        return Some(JunkCategory::MemoryDump);
    }
    if is_windows_log(normalized) {
        return Some(JunkCategory::LogFiles);
    }
    if contains_any(
        normalized,
        &[
            // 安装/升级日志（Windows\Panther）与更新协调器日志（USOShared\Logs）：
            // 同属排障历史记录，删掉不影响功能，但体积会随更新持续增长。
            "\\windows\\panther\\",
            "\\programdata\\usoshared\\logs\\",
        ],
    ) {
        return Some(JunkCategory::LogFiles);
    }
    if contains_any(
        normalized,
        &[
            "\\appdata\\local\\downloaded installations\\",
            "\\windows\\installer\\$patchcache$\\",
            // NVIDIA 驱动下载器留下的安装包，装完即无用。
            "\\programdata\\nvidia\\downloader\\",
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

fn contains_any(path: &str, markers: &[&str]) -> bool {
    markers.iter().any(|marker| path.contains(marker))
}

/// 旧版 Windows 安装残留、升级暂存目录。
/// 这些目录内部包含完整的 \Windows\System32\ 等结构，必须在系统排除规则之前判断，
/// 否则 Windows.old 只会剩下一堆被排除后的碎片，用户会看到深度扫描"扫不出旧系统"。
fn is_old_windows_installation(path: &str) -> bool {
    contains_any(
        path,
        &["\\windows.old\\", "\\$windows.~bt\\", "\\$windows.~ws\\"],
    )
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
            // NVIDIA OpenGL 着色器缓存与 DX 编译缓存，删除后自动重建
            "\\appdata\\local\\nvidia\\glcache\\",
            "\\appdata\\local\\nvidia\\dxc\\",
            // NVIDIA 计算着色器缓存（CUDA/OptiX 编译产物），同样由驱动自动重建。
            "\\appdata\\local\\nvidia\\computecache\\",
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
            // Defender 扫描历史目录，扫描完成后自动重建，与 Windows 清理向导的 Defender 项一致。
            "\\programdata\\microsoft\\windows defender\\scans\\history\\service\\",
        ],
    )
}

fn is_windows_internet_cache(path: &str) -> bool {
    path.contains("\\appdata\\local\\microsoft\\windows\\inetcache\\")
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
            // 国产 Chromium 系浏览器（缓存目录与 Chrome 一致，删除后自动重建）
            "\\tencent\\qqbrowser\\",
            "\\360chrome\\chrome\\user data\\",
            "\\360se6\\user data\\",
            "\\sogouexplorer\\",
            "\\ucbrowser\\user data\\",
            "\\2345explorer\\",
            "\\liebao\\user data\\",
            // 其他国际 Chromium 系浏览器
            "\\vivaldi\\user data\\",
            "\\yandexbrowser\\user data\\",
            "\\opera software\\opera gx stable\\",
            "\\centbrowser\\user data\\",
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
                // Chrome/Edge 新版本 GPU 着色器缓存目录，删除后自动重建
                "\\grshadercache\\",
                "\\graphitedawncache\\",
                "\\dawngraphitecache\\",
                "\\dawnwebgpucache\\",
                // Chromium 的 PWA/离线资源缓存，与 cache 同级且同样可重建；
                // 注意不包含 CacheStorage/IndexedDB 等持久化站点数据目录。
                "\\service worker\\",
                "\\scriptcache\\",
                // 媒体缓存：网页音视频缓冲数据，删除后重新播放会重新下载。
                "\\media cache\\",
                "\\jump list icons\\",
                // Firefox 的启动缓存与崩溃恢复缓存，均位于 profile 下并自动重建。
                "\\startupcache\\",
                "\\cache-tmp\\",
                "\\crash reports\\",
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
    // 只匹配明确表达"缓存"语义的目录名；覆盖常见大小写与变体（Cache2/.cache/Cache Data），
    // 不匹配 Data、Settings、Local Storage 等持久化目录名。
    let cache_names = [
        "cache",
        "caches",
        "cache2",
        ".cache",
        "cache data",
        "code cache",
        "gpucache",
        "shadercache",
        "d3dscache",
        "crashdumps",
        // 以下目录名同样只包含可重建数据，但此前未收录，导致同目录下其它缓存被扫到、
        // 这些子目录却被漏掉（用户感觉"同一个软件只清了一半"）。
        "service worker",
        "media cache",
        "startupcache",
        "cache-tmp",
        "crash reports",
        // 包管理器缓存：npm / pnpm 的缓存动辄数 GB，且 100% 可重建（重新安装时重新下载）。
        // 这两个名字此前没收录 —— "npm-cache" 不等于 "cache"，不会命中上面的精确段匹配。
        "npm-cache",
        "cacheddata",
        ".pnpm-store",
        // VS Code 的 CachedData 存放编译后的 JS，重启即重建，同样是明确的缓存名。
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

/// 已知第三方应用的可重建缓存目录（白名单组合匹配）
/// 深度扫描中 AppCache 只匹配目录段恰好为 cache 等精确词；这里补充
/// "已知应用目录 + 明确缓存目录名"的组合，覆盖 Steam htmlcache、Epic webcache
/// 等非常规缓存名。缓存目录删除后应用会自动重建，不触碰持久化数据目录。
fn is_third_party_app_cache(path: &str) -> bool {
    // 先做应用目录快速过滤，避免对全盘路径做无谓的缓存词匹配（深度扫描热路径）
    let app_dir = contains_any(
        path,
        &[
            "\\discord\\",
            "\\slack\\",
            "\\microsoft\\teams\\",
            "\\steam\\",
            "\\epicgameslauncher\\saved\\",
            "\\netease\\cloudmusic\\",
            "\\tencent\\qqmusic\\",
        ],
    );
    if !app_dir {
        return false;
    }
    contains_any(
        path,
        &[
            "\\cache\\",
            "\\code cache\\",
            "\\gpucache\\",
            "\\shadercache\\",
            "\\htmlcache\\",
            "\\webcache\\",
        ],
    )
}

fn is_thumbnail_cache(path: &str) -> bool {
    if !path.contains("\\appdata\\local\\microsoft\\windows\\explorer\\") {
        return false;
    }
    let Some(name) = Path::new(path).file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    // IconCache.db 是没有下划线的旧版本图标缓存，与 thumbcache_*.db 一样可重建。
    name == "iconcache.db"
        || ((name.starts_with("thumbcache_") || name.starts_with("iconcache_"))
            && name.ends_with(".db"))
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
        could_be_junk_path, create_session, get_category_page, get_paths_for_categories,
        is_deep_junk_path, match_deep_junk_category, DeepJunkScanResult,
    };
    use crate::scanner::{CategoryScanResult, FileInfo, JunkCategory};

    /// 粗筛是纯性能优化，一旦漏掉某类路径，那一类垃圾就永远扫不出来。
    ///
    /// 这里对**每一条规则**取一个典型路径，粗筛必须放行、完整规则也必须命中。
    /// 以后加规则忘了更新 `JUNK_PATH_HINTS`，这条测试会先报警。
    #[test]
    fn junk_hint_filter_covers_every_rule() {
        let samples = [
            // 着色器缓存 / Defender 缓存 / 旧系统残留
            r"C:\Windows\System32\d3d_cache\a",
            r"C:\Users\a\AppData\Local\NVIDIA\DXCache\b",
            r"C:\ProgramData\Microsoft\Windows Defender\Scans\History\Service\c",
            r"C:\Windows.old\Windows\System32\d.dll",
            r"C:\$WINDOWS.~BT\e",
            r"D:\$WINDOWS.~WS\f",
            // 临时目录 / 分发优化 / IE 缓存 / 系统缓存
            r"C:\Windows\Temp\g.tmp",
            r"C:\Users\a\AppData\Local\Temp\h.tmp",
            r"C:\Windows\SystemTemp\i",
            r"C:\Windows\SoftwareDistribution\DeliveryOptimization\j",
            r"C:\Users\a\AppData\Local\Microsoft\Windows\INetCache\k",
            r"C:\Windows\Prefetch\l.pf",
            r"C:\ProgramData\NVIDIA Corporation\NV_Cache\m",
            // 浏览器 / 用户目录缓存 / 第三方应用缓存
            r"C:\Users\a\AppData\Local\Google\Chrome\User Data\Default\Cache\n",
            r"C:\Users\a\AppData\Roaming\Mozilla\Firefox\Profiles\x\startupCache\o",
            r"C:\Users\a\AppData\Roaming\Code\Cache\p",
            r"C:\Steam\htmlcache\q",
            r"C:\Users\a\AppData\Roaming\Discord\Cache\r",
            // 更新包 / 缩略图 / 错误报告 / 内核转储
            r"C:\Windows\SoftwareDistribution\Download\s.cab",
            r"C:\Users\a\AppData\Local\Microsoft\Windows\Explorer\thumbcache_128.db",
            r"C:\Users\a\AppData\Local\CrashDumps\t.dmp",
            r"C:\Windows\Minidump\u.dmp",
            r"C:\Windows\LiveKernelReports\v.dmp",
            // 日志 / 安装包残留 / 网页缓存 / 字体与剪贴板缓存
            r"C:\Windows\Logs\MeasuredBoot\w.log",
            r"C:\Windows\Panther\x.xml",
            r"C:\ProgramData\USOShared\Logs\y",
            r"C:\Users\a\AppData\Local\Downloaded Installations\z",
            r"C:\Windows\Installer\$PatchCache$\1",
            r"C:\Users\a\AppData\Local\Microsoft\Windows\WebCache\2",
            r"C:\Windows\ServiceProfiles\LocalService\AppData\Local\FontCache\3",
            r"C:\Users\a\AppData\Local\Microsoft\Windows\Clipboard\4",
        ];
        for path in samples {
            assert!(could_be_junk_path(path), "粗筛漏掉了这条路径: {path}");
            assert!(
                match_deep_junk_category(path).is_some(),
                "规则没有命中（样本或规则有问题）: {path}"
            );
        }
    }

    /// 粗筛不能把无关路径放过去太多次，也不能误判成命中。
    #[test]
    fn junk_hint_filter_rejects_unrelated_paths() {
        for path in [
            r"D:\code\project\src\main.rs",
            r"C:\Users\a\Documents\report.docx",
            r"C:\Program Files\App\app.exe",
            r"F:\backup\photos\1.jpg",
        ] {
            assert!(!could_be_junk_path(path), "无关路径不该通过粗筛: {path}");
            assert!(
                match_deep_junk_category(path).is_none(),
                "无关路径不该命中规则: {path}"
            );
        }
    }

    /// 并行遍历必须和 `WalkDir` 收集到**完全相同**的文件集。
    ///
    /// 这一步是拿正确性换速度的改造：补扫的结果会直接进"发现文件"总数，
    /// 少一个文件用户就会发现数字变了，所以先用多层结构把各深度都对齐一遍。
    #[cfg(windows)]
    #[test]
    fn parallel_walk_collects_the_same_files_as_walkdir() {
        use walkdir::WalkDir;

        let base = std::env::temp_dir().join("lightc-walk-equivalence");
        let _ = std::fs::remove_dir_all(&base);
        for relative in [
            "top.bin",
            "a/one.bin",
            "a/b/two.bin",
            "a/b/c/three.bin",
            "d/deep/four.bin",
        ] {
            let path = base.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"x").unwrap();
        }
        // 空目录也要建：并行遍历不能因为读不到内容就报错
        std::fs::create_dir_all(base.join("empty")).unwrap();

        for depth in 1..=5usize {
            let mut fast = Vec::new();
            super::collect_files_parallel(&base, depth, &mut fast);
            fast.sort();

            let mut slow: Vec<std::path::PathBuf> = WalkDir::new(&base)
                .max_depth(depth)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| entry.path().to_path_buf())
                .collect();
            slow.sort();

            assert_eq!(fast, slow, "max_depth = {depth} 时收集结果不一致");
        }

        let _ = std::fs::remove_dir_all(&base);
    }

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
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Microsoft\Windows\INetCache\IE\entry.dat"
        ));
        assert!(!is_deep_junk_path(r"D:\Users\Alice\Downloads\old.tmp"));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Packages\App\EBWebView\Default\Cache\data"
        ));
        assert!(!is_deep_junk_path(r"D:\$Recycle.Bin\S-1-5-21\$R123"));
    }

    /// 本轮新增的目录与缓存目录名：既要命中新的可重建内容，也不能把有用数据卷进来。
    #[test]
    fn matches_newly_added_cache_roots_and_names() {
        // 新增的系统级目录
        assert!(is_deep_junk_path(r"C:\Windows\Panther\setupact.log"));
        assert!(is_deep_junk_path(
            r"C:\Windows\Performance\WinSAT\winsat.wmv"
        ));
        assert!(is_deep_junk_path(
            r"C:\ProgramData\USOShared\Logs\System\UpdateStore.etl"
        ));
        assert!(is_deep_junk_path(
            r"C:\ProgramData\NVIDIA Corporation\NV_Cache\abc.bin"
        ));
        assert!(is_deep_junk_path(
            r"C:\ProgramData\NVIDIA\Downloader\setup.exe"
        ));
        assert!(is_deep_junk_path(
            r"C:\Windows\ServiceProfiles\LocalService\AppData\Local\Temp\tmp.tmp"
        ));
        // 新收录的缓存目录名（包管理器 / 编辑器）
        assert!(is_deep_junk_path(
            r"C:\Users\Alice\AppData\Local\npm-cache\_cacache\blob"
        ));
        assert!(is_deep_junk_path(
            r"C:\Users\Alice\AppData\Roaming\npm-cache\index-v5\entry"
        ));
        assert!(is_deep_junk_path(
            r"C:\Users\Alice\AppData\Local\.pnpm-store\v3\files\x"
        ));
        assert!(is_deep_junk_path(
            r"C:\Users\Alice\AppData\Roaming\Code\CachedData\abc\cache.bin"
        ));

        // 反例一：CBS 日志是**刻意保留**的（组件安装日志用于排查更新故障），不能被新规则卷进来。
        assert!(!is_deep_junk_path(r"C:\Windows\Logs\CBS\CBS.log"));
        // 反例二：缓存目录之外的同名前缀目录不能误伤（npm 的项目目录不是缓存）。
        assert!(!is_deep_junk_path(
            r"C:\Users\Alice\AppData\Local\npm\my-project\index.js"
        ));
        assert!(!is_deep_junk_path(
            r"C:\Users\Alice\AppData\Roaming\Code\User\settings.json"
        ));
        // 反例三：仍然属于排除区。
        assert!(!is_deep_junk_path(
            r"C:\Windows\System32\LogFiles\W3SVC1\log.log"
        ));
        assert!(!is_deep_junk_path(
            r"C:\ProgramData\Package Cache\vc_runtime\a.msi"
        ));
    }

    #[test]
    fn classifies_legacy_internet_cache_as_browser_cache() {
        // Temporary Internet Files 的实际目标是 INetCache，应归入浏览器缓存而非系统缓存。
        assert_eq!(
            super::match_deep_junk_category(
                r"D:\Users\Alice\AppData\Local\Microsoft\Windows\INetCache\IE\entry.dat"
            ),
            Some(JunkCategory::BrowserCache)
        );
        // Cookies 位于 INetCookies，必须保持在垃圾扫描范围之外，避免清除登录状态。
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Microsoft\Windows\INetCookies\entry.dat"
        ));
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
    fn matches_cache_name_variants() {
        // 缓存目录名变体（cache2/.cache/Cache Data）应命中 AppCache
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Mozilla\Firefox\Profiles\abc\cache2\entries"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\SomeApp\.cache\data"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\SomeApp\Cache Data\file"
        ));
    }

    #[test]
    fn matches_additional_rebuildable_cache_directories() {
        // Chromium 的 Service Worker / 媒体缓存与 Firefox 启动缓存此前被漏掉，
        // 命中它们可以让"同一个软件只清一半"的问题消失。
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\Default\Service Worker\CacheStorage\abc"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Microsoft\Edge\User Data\Default\Media Cache\data_0"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\SomeApp\Service Worker\ScriptCache\index"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\Mozilla\Firefox\Profiles\abc.default\startupCache\cache.bin"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\Mozilla\Firefox\Profiles\abc.default\Crash Reports\crash.dmp"
        ));
        // Chromium 的新版 GPU 着色器缓存与 NVIDIA ComputeCache 同样可重建。
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\GPUCache\data_0"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\NVIDIA\ComputeCache\shader.bin"
        ));
        // Windows 自带诊断缓存：系统临时目录、内核崩溃报告、旧版图标缓存。
        assert!(is_deep_junk_path(r"D:\Windows\SystemTemp\a.tmp"));
        assert!(is_deep_junk_path(
            r"D:\Windows\LiveKernelReports\WATCHDOG\report.dmp"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Microsoft\Windows\Explorer\iconcache.db"
        ));
    }

    #[test]
    fn keeps_persistent_site_data_out_of_new_cache_rules() {
        // CacheStorage 允许清理，但 WebView2/MSIX 应用持久化目录仍必须整体排除，
        // 避免新规则把 Claude 等应用的会话数据带进来。
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Packages\Some.App\LocalCache\Local\app\EBWebView\Default\Cache\data"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Packages\Some.App\LocalCache\Local\app\EBWebView\Default\Service Worker\CacheStorage\data"
        ));
        // 浏览器持久化站点数据（Local Storage / IndexedDB / Session Storage）不在清理范围。
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\Default\Local Storage\leveldb\data"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\Default\IndexedDB\abc\data"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\Default\Session Storage\data"
        ));
        // 普通用户文件不会因为新规则被误判。
        assert!(!is_deep_junk_path(r"D:\Users\Alice\Documents\report.dmp"));
        assert!(!is_deep_junk_path(r"D:\Windows\System32\kernel32.dll"));
    }

    #[test]
    fn matches_known_third_party_app_caches() {
        // 非常规缓存目录名（htmlcache/webcache）命中第三方应用缓存
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Steam\htmlcache\index.html"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\EpicGamesLauncher\Saved\webcache\data"
        ));
        // 标准 Cache 目录仍走 AppCache 分类，同样命中
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\discord\Cache\data_1"
        ));
        // 持久化数据与游戏文件不命中
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Roaming\discord\Local Storage\leveldb\data"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Steam\steamapps\common\game\data.bin"
        ));
    }

    #[test]
    fn matches_extended_browser_and_shader_caches() {
        // 国产与国际 Chromium 系浏览器缓存应命中，且不误伤非缓存数据。
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Tencent\QQBrowser\User Data\Default\Cache\data_1"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\360Chrome\Chrome\User Data\Default\Code Cache\js\cache"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Vivaldi\User Data\Default\GPUCache\data_0"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\CentBrowser\User Data\Default\Cache\data_1"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\YandexBrowser\User Data\Default\Cache\data_1"
        ));
        // Chrome/Edge 新版 GPU 缓存目录命中，但非缓存目录不命中。
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\Default\GrShaderCache\GPUCache\data_0"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Microsoft\Edge\User Data\Default\DawnGraphiteCache\data_0"
        ));
        assert!(!is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\Google\Chrome\User Data\Default\Local Storage\leveldb\data"
        ));
        // NVIDIA 着色器缓存变体命中。
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\NVIDIA\GLCache\shader.bin"
        ));
        assert!(is_deep_junk_path(
            r"D:\Users\Alice\AppData\Local\NVIDIA\DXC\compiled.bin"
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
        // Defender 扫描历史目录（扫描后自动重建）应命中，隔离区等关键数据仍被保护。
        assert!(is_deep_junk_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Scans\History\Service\DetectionHistory\00000000-0000-0000-0000-000000000000\entry.bin"
        ));
        assert!(!is_deep_junk_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Quarantine\entry.bin"
        ));
        // 仿冒目录名（History 后面加字符）不得命中，避免放行嵌套伪造路径。
        assert!(!is_deep_junk_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Scans\History\ServiceEvil\entry.bin"
        ));
    }

    #[test]
    fn supplement_roots_only_cover_high_confidence_cache_dirs() {
        // 补扫根覆盖的系统级缓存目录应命中深度规则（与 cleanmgr 对齐）。
        assert!(is_deep_junk_path(
            r"C:\Windows\SoftwareDistribution\Download\update.cab"
        ));
        assert!(is_deep_junk_path(
            r"C:\Windows\SoftwareDistribution\DeliveryOptimization\payload.bin"
        ));
        assert!(is_deep_junk_path(r"C:\Windows\Temp\old.tmp"));
        assert!(is_deep_junk_path(
            r"C:\Windows\Logs\setupapi\setupapi.dev.log"
        ));
        // 补扫根只覆盖明确缓存子目录，不放大到整个 AppData\Local。
        assert!(!is_deep_junk_path(
            r"C:\Users\Alice\AppData\Local\Microsoft\Windows\Explorer\data\something.bin"
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
            outer_stages: Vec::new(),
            emit_wait_ms: 0,
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

    #[test]
    fn sorts_deep_category_files_by_size_before_paging() {
        let mut category = CategoryScanResult::new(JunkCategory::WindowsTemp);
        for (name, size) in [("small.tmp", 1_u64), ("large.tmp", 900), ("medium.tmp", 500)] {
            category.add_file(FileInfo::new(
                format!(r"D:\Users\Test\AppData\Local\Temp\{}", name),
                name.to_string(),
                size,
                1,
                false,
                JunkCategory::WindowsTemp,
            ));
        }
        category.sort_files_by_size_desc();

        let result = DeepJunkScanResult {
            scan_mode: "deep".to_string(),
            scan_id: String::new(),
            categories: vec![category],
            total_size: 1401,
            total_file_count: 3,
            scan_duration_ms: 0,
            scan_timestamp: 0,
            drives: Vec::new(),
            outer_stages: Vec::new(),
            emit_wait_ms: 0,
        };

        // 首屏必须直接给出最大的文件，避免用户为了找大文件反复翻页。
        let first_page = create_session(result).expect("创建深度扫描会话");
        let sizes = first_page.categories[0]
            .files
            .iter()
            .map(|file| file.size)
            .collect::<Vec<_>>();
        assert_eq!(sizes, vec![900, 500, 1]);
        assert_eq!(first_page.categories[0].total_size, 1401);
    }

    /// 深度扫描必须是快速扫描的超集，否则用户会看到"深度扫描反而更少"。
    ///
    /// 中文说明：这里用与本机一致的 C 盘路径，把 `JunkCategory::get_scan_paths()` 里每一条
    /// 快速扫描路径都跑一遍深度规则；任何一条不命中都说明用户在深度模式下会漏掉整个目录。
    /// 缩略图缓存按文件名规则（thumbcache_*.db）匹配，这里给出代表性文件名。
    #[test]
    fn deep_rules_cover_every_quick_scan_path() {
        const QUICK_SCAN_TARGETS: &[(&str, &str)] = &[
            ("WindowsTemp", r"C:\Users\chunyu\AppData\Local\Temp\a.tmp"),
            ("WindowsTemp", r"C:\WINDOWS\Temp\a.tmp"),
            ("SystemCache", r"C:\WINDOWS\Prefetch\APP.PF"),
            (
                "SystemCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\Caches\cversion.ini",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\INetCache\IE\entry.dat",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\Default\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\Default\Code Cache\js\index",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\Default\GPUCache\data_0",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\Profile 1\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\ShaderCache\data_0",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Edge\User Data\Default\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Mozilla\Firefox\Profiles\abc123.default\cache2\entries\A1B2",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Roaming\Mozilla\Firefox\Profiles\abc123.default\cache2\entries\A1B2",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\BraveSoftware\Brave-Browser\User Data\Default\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Roaming\Opera Software\Opera Stable\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Tencent\QQBrowser\User Data\Default\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\360Chrome\Chrome\User Data\Default\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Vivaldi\User Data\Default\Cache\data_1",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\Default\Service Worker\CacheStorage\data",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Google\Chrome\User Data\Default\Media Cache\data_0",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Local\Mozilla\Firefox\Profiles\abc.default\startupCache\cache.bin",
            ),
            (
                "BrowserCache",
                r"C:\Users\chunyu\AppData\Roaming\Mozilla\Firefox\Profiles\abc.default\Crash Reports\a.dmp",
            ),
            (
                "ThumbnailCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\Explorer\iconcache.db",
            ),
            ("MemoryDump", r"C:\WINDOWS\LiveKernelReports\WATCHDOG\report.dmp"),
            ("WindowsTemp", r"C:\WINDOWS\SystemTemp\a.tmp"),
            (
                "WindowsUpdate",
                r"C:\WINDOWS\Logs\WindowsUpdate\WindowsUpdate.20240101.etl",
            ),
            (
                "WindowsUpdate",
                r"C:\WINDOWS\SoftwareDistribution\Download\update.cab",
            ),
            (
                "DeliveryOptimization",
                r"C:\WINDOWS\SoftwareDistribution\DeliveryOptimization\payload.bin",
            ),
            (
                "DeliveryOptimization",
                r"C:\WINDOWS\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache\payload.bin",
            ),
            (
                "WindowsDefenderCache",
                r"C:\ProgramData\Microsoft\Windows Defender\LocalCopy\copy.bin",
            ),
            (
                "WindowsDefenderCache",
                r"C:\ProgramData\Microsoft\Windows Defender\Support\MPLog.log",
            ),
            (
                "WindowsDefenderCache",
                r"C:\ProgramData\Microsoft\Windows Defender\Scans\History\Service\entry.bin",
            ),
            ("LogFiles", r"C:\WINDOWS\Logs\setupapi\setupapi.dev.log"),
            ("LogFiles", r"C:\Users\chunyu\AppData\Local\CrashDumps\app.exe.1234.dmp"),
            ("MemoryDump", r"C:\WINDOWS\Minidump\010101-1234-01.dmp"),
            ("MemoryDump", r"C:\WINDOWS\MEMORY.DMP"),
            ("OldWindowsInstallation", r"C:\Windows.old\Windows\System32\old.dll"),
            ("OldWindowsInstallation", r"C:\$Windows.~BT\sources\install.wim"),
            (
                "AppCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\WebCache\V01.log",
            ),
            (
                "ThirdPartyAppCache",
                r"C:\Users\chunyu\AppData\Roaming\discord\Cache\data_1",
            ),
            (
                "ThirdPartyAppCache",
                r"C:\Users\chunyu\AppData\Local\Steam\htmlcache\index.html",
            ),
            (
                "ThirdPartyAppCache",
                r"C:\Users\chunyu\AppData\Local\EpicGamesLauncher\Saved\webcache\data",
            ),
            (
                "FontCache",
                r"C:\WINDOWS\ServiceProfiles\LocalService\AppData\Local\FontCache\font.bin",
            ),
            (
                "WindowsErrorReports",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\WER\ReportQueue\a.wer",
            ),
            (
                "WindowsErrorReports",
                r"C:\ProgramData\Microsoft\Windows\WER\ReportQueue\a.wer",
            ),
            (
                "InstallerTemp",
                r"C:\WINDOWS\Installer\$PatchCache$\Managed\entry.bin",
            ),
            (
                "InstallerTemp",
                r"C:\Users\chunyu\AppData\Local\Downloaded Installations\setup.msi",
            ),
            (
                "ClipboardCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\Clipboard\entry.bin",
            ),
            (
                "ThumbnailCache",
                r"C:\Users\chunyu\AppData\Local\Microsoft\Windows\Explorer\thumbcache_256.db",
            ),
            (
                "ThumbnailCache",
                r"C:\Users\other\AppData\Local\Microsoft\Windows\Explorer\iconcache_48.db",
            ),
            ("ShaderCache", r"C:\WINDOWS\System32\d3d_cache\shader.bin"),
            ("ShaderCache", r"C:\Users\chunyu\AppData\Local\D3DSCache\shader.bin"),
            ("ShaderCache", r"C:\Users\chunyu\AppData\Local\NVIDIA\DXCache\shader.bin"),
            ("ShaderCache", r"C:\Users\chunyu\AppData\Local\Intel\ShaderCache\shader.bin"),
        ];

        let missing = QUICK_SCAN_TARGETS
            .iter()
            .filter(|(_, path)| !is_deep_junk_path(path))
            .map(|(label, path)| format!("{} -> {}", label, path))
            .collect::<Vec<_>>();

        assert!(
            missing.is_empty(),
            "以下快速扫描路径未被深度扫描覆盖，深度结果会少于快速扫描：\n{}",
            missing.join("\n")
        );
    }
}
