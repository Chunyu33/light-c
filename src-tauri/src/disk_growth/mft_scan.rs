// ============================================================================
// 独立 MFT 全盘目录扫描器
//
// 使用 FSCTL_ENUM_USN_DATA 枚举 NTFS 文件记录来重建路径，再并行读取文件
// metadata 获取大小。这样避免传统递归遍历反复进入目录，适合全盘变化分析。
// ============================================================================

#![cfg(target_os = "windows")]

use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Instant, UNIX_EPOCH};

use winapi::um::fileapi::GetDriveTypeW;
use winapi::um::winbase::DRIVE_FIXED;


use crate::scanner::big_files_engine::mft_core;

const DEFAULT_MAX_DEPTH: u8 = 4;
const METADATA_PROGRESS_STEP: usize = 10_000;
/// 卷根目录在 NTFS 里的固定记录号：MFT 前 16 条记录都是元文件，`$Root` 就是 5。
const ROOT_MFT_ID: u64 = 5;

static DISK_GROWTH_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn reset_disk_growth_cancelled() {
    DISK_GROWTH_SCAN_CANCELLED.store(false, Ordering::SeqCst);
}

pub fn cancel_disk_growth_scan() {
    log::info!("收到取消全盘分析请求");
    DISK_GROWTH_SCAN_CANCELLED.store(true, Ordering::SeqCst);
}

fn is_disk_growth_cancelled() -> bool {
    DISK_GROWTH_SCAN_CANCELLED.load(Ordering::SeqCst)
}

fn ensure_not_cancelled() -> Result<(), String> {
    if is_disk_growth_cancelled() {
        Err("扫描已取消".to_string())
    } else {
        Ok(())
    }
}

/// 单条 MFT 记录。这里直接用 `mft_core` 的解析结果 —— 它一次顺序读就同时给出
/// 名字、父子关系、大小和时间，不必再单独枚举一遍或按需 seek 读 FILE record。
type RawEntry = mft_core::MftRecordInfo;

#[derive(Debug, Clone)]
struct FileRecord {
    path: String,
    parent_id: u64,
    size: u64,
    modified: i64,
    has_data_stream: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct FileSizeRecord {
    pub(crate) parent_id: u64,
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) modified: i64,
}

struct FileSizeCollection {
    records: Vec<FileSizeRecord>,
    mft_size_count: usize,
    metadata_fallback_count: usize,
}

#[derive(Debug, Clone, Copy)]
struct FileRecordMetadata {
    size: u64,
    modified: i64,
}

#[derive(Debug, Clone)]
struct DirectoryInfo {
    parent_id: u64,
    path: String,
    depth: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirSizeEntry {
    pub path: String,
    pub size: u64,
    pub depth: u8,
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshotEntry {
    pub path: String,
    pub size: u64,
    #[serde(default)]
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthPhaseDuration {
    pub stage: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthScanProgress {
    pub stage: String,
    pub message: String,
    pub processed: usize,
    pub total: Option<usize>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone)]
pub struct FullDiskScanResult {
    pub entries: Vec<DirSizeEntry>,
    // 文件级明细只在后端写快照分片时使用，不进入前端响应，避免超大盘下复制出第二份路径列表。
    pub(crate) file_records: Vec<FileSizeRecord>,
    pub total_size: u64,
    pub total_files_scanned: usize,
    pub scan_duration_ms: u64,
    pub root_path: String,
    pub backend: String,
    pub phase_durations: Vec<DiskGrowthPhaseDuration>,
    pub mft_size_count: usize,
    pub metadata_fallback_count: usize,
    /// `$MFT` 的 data run 段数、读盘耗时、解析耗时：判断瓶颈在盘还是 CPU。
    pub mft_fragments: usize,
    pub mft_io_ms: u64,
    pub mft_parse_ms: u64,
}

pub fn scan_drive_with_progress<F>(
    drive_letter: &str,
    progress: &F,
) -> Result<FullDiskScanResult, String>
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let drive_letter = normalize_drive_letter(drive_letter)?;
    let root = format!("{}:\\", drive_letter);
    scan_disk_with_progress(&root, DEFAULT_MAX_DEPTH, progress)
}

fn scan_disk_with_progress<F>(
    root: &str,
    max_depth: u8,
    progress: &F,
) -> Result<FullDiskScanResult, String>
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let start = Instant::now();
    let mut phase_durations = Vec::new();
    let drive_letter = root
        .chars()
        .find(|c| c.is_ascii_alphabetic())
        .ok_or_else(|| "无效的磁盘路径，无法识别盘符".to_string())?
        .to_ascii_uppercase();
    let drive_root = format!("{}:\\", drive_letter);

    ensure_fixed_drive(&drive_root)?;

    emit_progress(progress, &start, "mft", "正在读取 NTFS 主文件表", 0, None);
    let phase_start = Instant::now();
    // 一次顺序读 $MFT 就同时拿到名字（$FILE_NAME）、父子关系、大小（$DATA）和修改时间。
    // 原先先走 USN 枚举拿名字、再另开一个读取器按 mft_id 随机 seek 拿大小 ——
    // 同一份数据过两遍，而实测枚举单独就要 36.9 秒、单遍读整张表只要 3.9 秒。
    let metadata_reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let (raw_entries, mft_stats) = metadata_reader.read_all_records(&|processed| {
        if is_disk_growth_cancelled() {
            return false;
        }
        if processed % 100_000 == 0 {
            emit_progress(
                progress,
                &start,
                "mft",
                "正在读取 NTFS 主文件表",
                processed,
                None,
            );
        }
        true
    })?;
    push_phase_duration(&mut phase_durations, "mft", phase_start);
    ensure_not_cancelled()?;

    emit_progress(
        progress,
        &start,
        "path",
        "正在重建文件路径",
        raw_entries.len(),
        None,
    );
    let phase_start = Instant::now();
    // 目录索引一次建完：路径在 BFS 里直接拼成最终形式（正斜杠 + 小写），
    // 文件路径再拿父目录路径补一个文件名 —— 原实现给目录和文件各建一遍再规范化，
    // 71 万条记录要付近三百万次字符串分配。
    let directory_index = build_directory_index(&raw_entries, &drive_root);
    ensure_not_cancelled()?;
    let file_records = collect_file_records(&raw_entries, &directory_index);
    push_phase_duration(&mut phase_durations, "path", phase_start);
    ensure_not_cancelled()?;

    emit_progress(
        progress,
        &start,
        "metadata",
        "正在读取文件大小",
        0,
        Some(file_records.len()),
    );
    let phase_start = Instant::now();
    let file_size_collection = collect_file_sizes(file_records, progress, &start);
    push_phase_duration(&mut phase_durations, "metadata", phase_start);
    ensure_not_cancelled()?;

    emit_progress(
        progress,
        &start,
        "aggregate",
        "正在聚合目录大小",
        file_size_collection.records.len(),
        None,
    );
    let phase_start = Instant::now();
    let entries = aggregate_directories(&file_size_collection.records, &directory_index, max_depth);
    ensure_not_cancelled()?;
    let total_size = file_size_collection
        .records
        .iter()
        .map(|record| record.size)
        .sum();
    push_phase_duration(&mut phase_durations, "aggregate", phase_start);
    let total_files_scanned = file_size_collection.records.len();

    Ok(FullDiskScanResult {
        entries,
        file_records: file_size_collection.records,
        total_size,
        total_files_scanned,
        scan_duration_ms: start.elapsed().as_millis() as u64,
        root_path: drive_root,
        backend: "mft".to_string(),
        phase_durations,
        mft_size_count: file_size_collection.mft_size_count,
        metadata_fallback_count: file_size_collection.metadata_fallback_count,
        mft_fragments: mft_stats.fragments,
        mft_io_ms: mft_stats.io_ms,
        mft_parse_ms: mft_stats.parse_ms,
    })
}

fn ensure_fixed_drive(root: &str) -> Result<(), String> {
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
    if drive_type != DRIVE_FIXED {
        return Err(format!("仅支持固定磁盘扫描: {}", root));
    }
    Ok(())
}

fn normalize_drive_letter(value: &str) -> Result<char, String> {
    let Some(letter) = value
        .chars()
        .find(|character| character.is_ascii_alphabetic())
    else {
        return Err("无效的磁盘盘符".to_string());
    };
    // 前端可能传入 D、D: 或 D:\，这里只保留盘符，保证同一磁盘只对应一组快照。
    Ok(letter.to_ascii_uppercase())
}

/// 一次遍历建出目录索引：BFS 往下走的同时把路径拼成**最终形式**（正斜杠 + 小写）。
///
/// 原实现分三步：给每个目录建一份反斜杠路径 → 再 clone 出来整体规范化 → 再为每个文件
/// 单独建一条路径。现在目录路径只分配一次，深度顺着 BFS 累加（不再拿字符串去数分隔符），
/// 环检测直接用「索引里有没有这条路径」代替额外的 `HashSet`。
fn build_directory_index(entries: &[RawEntry], drive_root: &str) -> HashMap<u64, DirectoryInfo> {
    // 目录大约占全部有效记录的六分之一
    let mut children: HashMap<u64, Vec<u32>> = HashMap::with_capacity(entries.len() / 6);
    for (index, entry) in entries.iter().enumerate() {
        // 文件没有子节点，放进 children 只会让 BFS 白跑一遍
        if entry.mft_id == 0 || !entry.is_dir {
            continue;
        }
        children.entry(entry.parent_id).or_default().push(index as u32);
    }

    let mut directories: HashMap<u64, DirectoryInfo> = HashMap::with_capacity(children.len() + 1);
    directories.insert(
        ROOT_MFT_ID,
        DirectoryInfo {
            parent_id: 0,
            path: normalize_path(drive_root),
            depth: 0,
        },
    );

    let mut queue = VecDeque::new();
    if let Some(root_children) = children.get(&ROOT_MFT_ID) {
        queue.extend(root_children.iter().copied());
    }

    while let Some(index) = queue.pop_front() {
        let entry = &entries[index as usize];
        // 已经建过路径的目录直接跳过：这也挡住了异常父链造成的死循环
        if entry.mft_id == 0 || directories.contains_key(&entry.mft_id) {
            continue;
        }
        // 父目录不在索引里，说明这条链断在从根不可达的位置，整支都建不出来
        let Some(parent) = directories.get(&entry.parent_id) else {
            continue;
        };
        let depth = parent.depth.saturating_add(1);
        let path = join_normalized_path(&parent.path, &entry.name);
        // 上面对 directories 的不可变借用到此结束，可以插入了
        directories.insert(
            entry.mft_id,
            DirectoryInfo {
                parent_id: entry.parent_id,
                path,
                depth,
            },
        );

        if let Some(next_children) = children.get(&entry.mft_id) {
            queue.extend(next_children.iter().copied());
        }
    }

    directories
}

fn collect_file_records(
    entries: &[RawEntry],
    directory_index: &HashMap<u64, DirectoryInfo>,
) -> Vec<FileRecord> {
    // 提前按记录总数预留：靠 collect 自动扩容会把几十 MB 的数组反复搬几遍
    let mut records = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.is_dir || entry.mft_id == 0 {
            continue;
        }
        // 父目录路径在目录索引里**已经是规范化形式**（小写 + 正斜杠）
        let Some(parent) = directory_index.get(&entry.parent_id) else {
            continue;
        };
        records.push(FileRecord {
            path: join_normalized_path(&parent.path, &entry.name),
            parent_id: entry.parent_id,
            // 大小和时间在顺序读 $MFT 时已经拿到了，这里直接带下去
            size: entry.size,
            modified: entry.modified,
            has_data_stream: entry.has_data_stream,
        });
    }
    records
}

/// 拼出文件的完整路径，并顺手规范化成 `normalize_path` 的形式：**正斜杠 + 小写**。
///
/// 父路径取自目录索引，已经是规范化形式；所以这里只需要补一个分隔符、把文件名接上，
/// 再原地小写。这样一条文件路径只分配一次 —— 原实现是「建全量路径 → clone → 再规范化」三次。
///
/// 小写分两步：先 `make_ascii_lowercase`（原地、零分配），只有剩下非 ASCII 的大写字母时
/// 才退回 `to_lowercase()`。这样和旧实现（直接 `to_lowercase()`）的结果逐字一致，
/// 中文、日文文件名不会多付一次分配。
fn join_normalized_path(parent: &str, name: &str) -> String {
    // 调用方只传目录索引里的路径，那已经是规范化形式；传原始路径进来会拼出混合分隔符
    debug_assert!(!parent.contains('\\'), "父路径应先规范化: {parent}");
    let mut path = String::with_capacity(parent.len() + 1 + name.len());
    path.push_str(parent);
    if !parent.ends_with('/') {
        path.push('/');
    }
    path.push_str(name);
    path.make_ascii_lowercase();
    if path.chars().any(char::is_uppercase) {
        // 只有非 ASCII 大写（如 Ö、Д）才会走到这里
        path = path.to_lowercase();
    }
    path
}

fn collect_file_sizes<F>(
    file_records: Vec<FileRecord>,
    progress: &F,
    scan_start: &Instant,
) -> FileSizeCollection
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let total = file_records.len();
    let processed = AtomicUsize::new(0);
    let mft_size_count = AtomicUsize::new(0);
    let metadata_fallback_count = AtomicUsize::new(0);
    let threads = metadata_thread_count();
    let read_sizes = || {
        file_records
            .into_par_iter()
            .filter_map(|record| {
                if is_disk_growth_cancelled() {
                    return None;
                }
                let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                if current % METADATA_PROGRESS_STEP == 0 || current == total {
                    emit_progress(
                        progress,
                        scan_start,
                        "metadata",
                        "正在整理文件大小",
                        current,
                        Some(total),
                    );
                }

                // 大小和时间在顺序读 $MFT 时已经解析好了，这里**不再读盘**，
                // 只是把记录搬进聚合需要的结构里（原实现要为此再扫一遍 $MFT）。
                // 只有 `$DATA` 没解析出来的记录才回退一次 stat，保证数字和以前一致。
                let (metadata, from_mft) = if record.has_data_stream {
                    (
                        FileRecordMetadata {
                            size: record.size,
                            modified: record.modified,
                        },
                        true,
                    )
                } else {
                    let metadata = fs::metadata(&record.path).ok()?;
                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|duration| duration.as_secs() as i64)
                        .unwrap_or(0);
                    (
                        FileRecordMetadata {
                            size: metadata.len(),
                            modified,
                        },
                        false,
                    )
                };
                // 空文件（含目录占位）不进入结果，也就不该计入"大小来源"的统计
                if metadata.size == 0 {
                    return None;
                }
                if from_mft {
                    mft_size_count.fetch_add(1, Ordering::Relaxed);
                } else {
                    metadata_fallback_count.fetch_add(1, Ordering::Relaxed);
                }
                Some(FileSizeRecord {
                    parent_id: record.parent_id,
                    // collect_file_records 已经产出规范化路径，这里不再重复处理
                    path: record.path,
                    size: metadata.size,
                    modified: metadata.modified,
                })
            })
            .collect()
    };

    let records = match ThreadPoolBuilder::new().num_threads(threads).build() {
        Ok(pool) => pool.install(read_sizes),
        Err(_) => read_sizes(),
    };

    FileSizeCollection {
        records,
        mft_size_count: mft_size_count.load(Ordering::Relaxed),
        metadata_fallback_count: metadata_fallback_count.load(Ordering::Relaxed),
    }
}

fn aggregate_directories(
    file_sizes: &[FileSizeRecord],
    directory_index: &HashMap<u64, DirectoryInfo>,
    max_depth: u8,
) -> Vec<DirSizeEntry> {
    let mut size_by_dir: HashMap<u64, u64> = HashMap::new();
    let mut modified_by_dir: HashMap<u64, i64> = HashMap::new();

    for record in file_sizes {
        let mut current_id = record.parent_id;
        let mut guard = 0usize;

        while let Some(directory) = directory_index.get(&current_id) {
            if directory.depth <= max_depth {
                *size_by_dir.entry(current_id).or_insert(0) += record.size;
                // 目录本身的 mtime 在 Windows 上不一定反映子文件变化；这里聚合子树内最新文件修改时间，更贴近用户关心的“变化时间”。
                let modified = modified_by_dir.entry(current_id).or_insert(0);
                if record.modified > *modified {
                    *modified = record.modified;
                }
            }

            if directory.parent_id == 0 || directory.parent_id == current_id {
                break;
            }

            current_id = directory.parent_id;
            guard += 1;
            if guard > 128 {
                // 极端异常的 MFT 父链可能成环或过深，直接截断以保证整次扫描可结束。
                break;
            }
        }
    }

    let mut entries: Vec<DirSizeEntry> = size_by_dir
        .into_iter()
        .filter_map(|(directory_id, size)| {
            let directory = directory_index.get(&directory_id)?;
            Some(DirSizeEntry {
                depth: directory.depth,
                path: directory.path.clone(),
                size,
                modified: modified_by_dir.get(&directory_id).copied().unwrap_or(0),
            })
        })
        .collect();

    entries.sort_by(|left, right| {
        right
            .size
            .cmp(&left.size)
            .then_with(|| left.path.cmp(&right.path))
    });
    entries
}

pub fn normalize_path(path: &str) -> String {
    path.to_lowercase().replace('\\', "/")
}

fn metadata_thread_count() -> usize {
    // metadata 读取是随机 IO，线程过多会让 SSD、Defender 和文件系统过滤驱动互相抢资源。
    num_cpus::get().clamp(4, 8)
}

fn push_phase_duration(
    phases: &mut Vec<DiskGrowthPhaseDuration>,
    stage: &str,
    started_at: Instant,
) {
    phases.push(DiskGrowthPhaseDuration {
        stage: stage.to_string(),
        duration_ms: started_at.elapsed().as_millis() as u64,
    });
}

fn emit_progress<F>(
    progress: &F,
    scan_start: &Instant,
    stage: &str,
    message: &str,
    processed: usize,
    total: Option<usize>,
) where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    progress(DiskGrowthScanProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        processed,
        total,
        elapsed_ms: scan_start.elapsed().as_millis() as u64,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_uses_forward_slash_and_lowercase() {
        assert_eq!(normalize_path("C:\\Users\\Evan"), "c:/users/evan");
    }

    /// 大小来源的判断：有 `$DATA` 的直接用记录里的大小；没有 `$DATA` 的才回退 stat。
    /// 真空文件（有 `$DATA` 但大小为 0）必须直接丢弃 —— 不能因为 `size == 0` 就去 stat，
    /// 那会把几万个空文件各 stat 一遍。
    #[test]
    fn collect_file_sizes_only_stats_records_without_data_stream() {
        let dir = std::env::temp_dir().join("lightc-disk-growth-sizes");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real_file = dir.join("payload.bin");
        std::fs::write(&real_file, vec![7u8; 128]).unwrap();

        let records = vec![
            // 记录里就有大小：不碰磁盘
            FileRecord {
                path: "C:////fake////from-mft.bin".to_string(),
                parent_id: 26,
                size: 4096,
                modified: 100,
                has_data_stream: true,
            },
            // 没有 $DATA：回退 stat，拿到真实大小
            FileRecord {
                path: real_file.to_string_lossy().to_string(),
                parent_id: 26,
                size: 0,
                modified: 0,
                has_data_stream: false,
            },
            // 真空文件：有 $DATA、大小为 0，直接丢掉，不 stat
            FileRecord {
                path: "C:////fake////empty.bin".to_string(),
                parent_id: 26,
                size: 0,
                modified: 100,
                has_data_stream: true,
            },
        ];

        let started = Instant::now();
        let collection = collect_file_sizes(records, &|_| {}, &started);

        assert_eq!(collection.records.len(), 2, "空文件应该被丢掉");
        assert_eq!(collection.mft_size_count, 1, "只有带 $DATA 的非空记录算 MFT 来源");
        assert_eq!(collection.metadata_fallback_count, 1, "只有缺 $DATA 的记录才回退");
        let sizes: Vec<u64> = collection.records.iter().map(|item| item.size).collect();
        assert!(sizes.contains(&4096) && sizes.contains(&128), "大小不对: {sizes:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 一步式拼接必须和「先拼路径、再整体规范化」完全一致。
    ///
    /// 这是把三次路径构建合成一次的等价性依据：路径会直接显示给用户、
    /// 也会拿去 stat 回退，差一个字符就会变成"文件不存在"。
    #[test]
    fn join_normalized_path_matches_the_two_step_version() {
        let cases = [
            ("c:\\users\\evan", "Report.TXT"),
            ("c:\\", "A.BIN"),
            ("c:\\users\\张三\\appdata\\local", "中文文件.LOG"),
            ("d:\\program files\\app", "MixedCase.Dll"),
            ("c:\\users\\Ömer", "Ärger.TXT"),
        ];
        for (raw_parent, name) in cases {
            // 旧链路：原始父路径 + 名字 → 拼接 → 整体规范化
            let joined = if raw_parent.ends_with('\\') {
                format!("{raw_parent}{name}")
            } else {
                format!("{raw_parent}\\{name}")
            };
            let legacy = normalize_path(&joined);
            // 新链路：父路径先规范化（目录索引里存的就是这个）→ 拼接时就地规范化
            let normalized_parent = normalize_path(raw_parent);
            assert_eq!(
                join_normalized_path(&normalized_parent, name),
                legacy,
                "parent={raw_parent} name={name}"
            );
        }
    }

    /// 目录索引的路径与深度：深度改成顺着 BFS 逐层累加（不再拿字符串数分隔符），
    /// 所以必须验证它和「路径里有几段」完全一致 —— 前端按 depth 分层聚合，
    /// 差一层就会把某个目录的占用统计挂到父目录头上。
    #[test]
    fn build_directory_index_matches_path_segments() {
        let entry = |mft_id: u64, parent_id: u64, name: &str, is_dir: bool| RawEntry {
            mft_id,
            parent_id,
            name: name.to_string(),
            is_dir,
            size: 0,
            modified: 0,
            has_data_stream: is_dir,
        };
        let entries = vec![
            entry(ROOT_MFT_ID, ROOT_MFT_ID, ".", true),
            entry(26, ROOT_MFT_ID, "Users", true),
            entry(30, 26, "Evan", true),
            entry(31, 30, "Desktop", true),
            entry(40, 31, "report.txt", false),
            // 父目录不在表里（从根不可达）：整支都建不出路径
            entry(50, 999, "orphan", true),
            entry(51, 50, "inside", true),
        ];

        let index = build_directory_index(&entries, "C:\\");
        assert_eq!(index[&ROOT_MFT_ID].depth, 0);
        assert_eq!(index[&26].path, "c:/users");
        assert_eq!(index[&26].depth, 1);
        assert_eq!(index[&30].depth, 2);
        assert_eq!(index[&31].depth, 3);
        assert!(
            !index.contains_key(&50) && !index.contains_key(&51),
            "不可达目录不该进索引"
        );

        // 文件路径由「父目录路径 + 文件名」拼出，父目录已经在索引里
        let files = collect_file_records(&entries, &index);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "c:/users/evan/desktop/report.txt");
    }
}
