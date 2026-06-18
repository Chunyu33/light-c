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
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use winapi::shared::minwindef::{DWORD, LPVOID};
use winapi::shared::ntdef::HANDLE;
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::fileapi::{CreateFileW, GetDriveTypeW, OPEN_EXISTING};
use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
use winapi::um::ioapiset::DeviceIoControl;
use winapi::um::winbase::DRIVE_FIXED;
use winapi::um::winnt::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GENERIC_READ,
};

const FSCTL_ENUM_USN_DATA: DWORD = (9 << 16) | (0 << 14) | (44 << 2) | 3;
const ERROR_HANDLE_EOF: DWORD = 38;
const USN_BUFFER_SIZE: usize = 1024 * 1024;
const MFT_METADATA_MAX: u64 = 25;
const DEFAULT_MAX_DEPTH: u8 = 4;
const METADATA_PROGRESS_STEP: usize = 10_000;
const MFT_SIZE_READ_CHUNK: usize = 16 * 1024 * 1024;

static DISK_GROWTH_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

pub fn reset_disk_growth_cancelled() {
    DISK_GROWTH_SCAN_CANCELLED.store(false, Ordering::SeqCst);
}

pub fn cancel_disk_growth_scan() {
    log::info!("收到取消 C 盘全盘分析请求");
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

#[repr(C)]
#[allow(non_snake_case)]
struct MftEnumDataV0 {
    StartFileReferenceNumber: u64,
    LowUsn: i64,
    HighUsn: i64,
}

#[derive(Debug, Clone)]
struct RawEntry {
    mft_id: u64,
    parent_id: u64,
    name: String,
    is_dir: bool,
}

#[derive(Debug, Clone)]
struct FileRecord {
    mft_id: u64,
    path: String,
    parent_id: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct FileSizeRecord {
    pub(crate) parent_id: u64,
    pub(crate) path: String,
    pub(crate) size: u64,
}

struct FileSizeCollection {
    records: Vec<FileSizeRecord>,
    mft_size_count: usize,
    metadata_fallback_count: usize,
}

#[derive(Debug, Clone)]
struct DirectoryInfo {
    parent_id: u64,
    path: String,
    depth: u8,
}

#[derive(Debug, Clone)]
struct DataRun {
    start_lcn: i64,
    cluster_count: u64,
}

struct NtfsFileSizeReader {
    volume: fs::File,
    bytes_per_sector: usize,
    cluster_size: u64,
    file_record_size: usize,
    mft_runs: Vec<DataRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirSizeEntry {
    pub path: String,
    pub size: u64,
    pub depth: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshotEntry {
    pub path: String,
    pub size: u64,
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
}

pub fn scan_system_drive_with_progress<F>(progress: &F) -> Result<FullDiskScanResult, String>
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let root = format!("{}\\", drive.trim_end_matches('\\'));
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

    emit_progress(progress, &start, "mft", "正在枚举 MFT 文件记录", 0, None);
    let phase_start = Instant::now();
    let handle = open_volume(drive_letter)?;
    let raw_entries = enumerate(handle, progress, &start);
    unsafe {
        CloseHandle(handle);
    }
    let raw_entries = raw_entries?;
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
    let paths = rebuild_paths(&raw_entries, drive_letter);
    ensure_not_cancelled()?;
    let directory_index = build_directory_index(&raw_entries, &paths, &drive_root);
    ensure_not_cancelled()?;
    let file_records = collect_file_records(&raw_entries, &paths);
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
    let file_size_collection = collect_file_sizes(file_records, drive_letter, progress, &start);
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

fn open_volume(drive_letter: char) -> Result<HANDLE, String> {
    let volume_path = format!("\\\\.\\{}:", drive_letter);
    let wide: Vec<u16> = volume_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "无法打开 {}，请以管理员身份运行后重试",
            volume_path
        ));
    }

    Ok(handle)
}

fn enumerate<F>(device: HANDLE, progress: &F, scan_start: &Instant) -> Result<Vec<RawEntry>, String>
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let mut entries = Vec::new();
    let mut buffer = vec![0u8; USN_BUFFER_SIZE];
    let mut start_file_reference_number = 0u64;
    let mut processed = 0usize;

    loop {
        ensure_not_cancelled()?;
        let mut bytes_returned: DWORD = 0;
        let mut query = MftEnumDataV0 {
            StartFileReferenceNumber: start_file_reference_number,
            LowUsn: 0,
            HighUsn: i64::MAX,
        };

        let ok = unsafe {
            DeviceIoControl(
                device,
                FSCTL_ENUM_USN_DATA,
                &mut query as *mut _ as LPVOID,
                std::mem::size_of::<MftEnumDataV0>() as DWORD,
                buffer.as_mut_ptr() as LPVOID,
                USN_BUFFER_SIZE as DWORD,
                &mut bytes_returned,
                std::ptr::null_mut(),
            )
        };

        if ok == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_HANDLE_EOF {
                break;
            }
            return Err(format!("MFT 枚举失败，Windows 错误码: {}", error));
        }

        if bytes_returned <= 8 {
            break;
        }

        let mut offset = 8usize;
        while offset < bytes_returned as usize {
            if processed % 10_000 == 0 {
                ensure_not_cancelled()?;
            }
            let record = unsafe { read_record(&buffer, offset) };
            let Some((record_len, entry)) = record else {
                break;
            };

            if entry.mft_id > MFT_METADATA_MAX {
                entries.push(entry);
                processed += 1;
                if processed % 100_000 == 0 {
                    emit_progress(
                        progress,
                        scan_start,
                        "mft",
                        "正在枚举 MFT 文件记录",
                        processed,
                        None,
                    );
                }
            }

            offset += record_len;
        }

        start_file_reference_number =
            unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const u64) };
    }

    emit_progress(
        progress,
        scan_start,
        "mft",
        "MFT 文件记录枚举完成",
        processed,
        None,
    );
    Ok(entries)
}

unsafe fn read_record(buffer: &[u8], offset: usize) -> Option<(usize, RawEntry)> {
    let base = buffer.as_ptr().add(offset);
    let record_len = std::ptr::read_unaligned(base as *const u32) as usize;
    if record_len == 0 || offset + record_len > buffer.len() {
        return None;
    }

    let file_ref = std::ptr::read_unaligned(base.add(8) as *const u64);
    let parent_ref = std::ptr::read_unaligned(base.add(16) as *const u64);
    let attributes = std::ptr::read_unaligned(base.add(52) as *const u32);
    let name_len = std::ptr::read_unaligned(base.add(56) as *const u16) as usize / 2;
    let name_offset = std::ptr::read_unaligned(base.add(58) as *const u16) as usize;

    if name_offset + name_len * 2 > record_len {
        return None;
    }

    let name = if name_len > 0 {
        String::from_utf16_lossy(std::slice::from_raw_parts(
            buffer.as_ptr().add(offset + name_offset) as *const u16,
            name_len,
        ))
    } else {
        String::new()
    };

    let is_dir = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    let is_reparse = (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    if name.is_empty() || is_reparse {
        return Some((
            record_len,
            RawEntry {
                mft_id: 0,
                parent_id: 0,
                name: String::new(),
                is_dir,
            },
        ));
    }

    Some((
        record_len,
        RawEntry {
            mft_id: file_ref & 0x0000_FFFF_FFFF_FFFF,
            parent_id: parent_ref & 0x0000_FFFF_FFFF_FFFF,
            name,
            is_dir,
        },
    ))
}

fn rebuild_paths(entries: &[RawEntry], drive_letter: char) -> HashMap<u64, String> {
    let mut paths = HashMap::with_capacity(entries.len());
    let mut children: HashMap<u64, Vec<usize>> = HashMap::with_capacity(entries.len());

    for (index, entry) in entries.iter().enumerate() {
        if entry.mft_id == 0 {
            continue;
        }
        children.entry(entry.parent_id).or_default().push(index);
    }

    let root = format!("{}:\\", drive_letter);
    paths.insert(5, root.clone());

    let mut queue = VecDeque::new();
    let mut seen = HashSet::new();
    seen.insert(5u64);

    if let Some(root_children) = children.get(&5) {
        queue.extend(root_children.iter().copied());
    }

    while let Some(index) = queue.pop_front() {
        let entry = &entries[index];
        if entry.mft_id == 0 || !seen.insert(entry.mft_id) {
            continue;
        }

        let Some(parent_path) = paths.get(&entry.parent_id).cloned() else {
            continue;
        };

        let full_path = join_windows_path(&parent_path, &entry.name);
        paths.insert(entry.mft_id, full_path);

        if let Some(next_children) = children.get(&entry.mft_id) {
            queue.extend(next_children.iter().copied());
        }
    }

    paths
}

fn build_directory_index(
    entries: &[RawEntry],
    paths: &HashMap<u64, String>,
    drive_root: &str,
) -> HashMap<u64, DirectoryInfo> {
    let mut directories = HashMap::new();
    directories.insert(
        5,
        DirectoryInfo {
            parent_id: 0,
            path: normalize_path(drive_root),
            depth: 0,
        },
    );

    for entry in entries
        .iter()
        .filter(|entry| entry.is_dir && entry.mft_id != 0)
    {
        let Some(path) = paths.get(&entry.mft_id) else {
            continue;
        };
        directories.insert(
            entry.mft_id,
            DirectoryInfo {
                parent_id: entry.parent_id,
                path: normalize_path(path),
                depth: depth_from_root(path, drive_root) as u8,
            },
        );
    }

    directories
}

fn collect_file_records(entries: &[RawEntry], paths: &HashMap<u64, String>) -> Vec<FileRecord> {
    entries
        .iter()
        .filter(|entry| !entry.is_dir && entry.mft_id != 0)
        .filter_map(|entry| {
            paths.get(&entry.mft_id).map(|path| FileRecord {
                mft_id: entry.mft_id,
                path: path.clone(),
                parent_id: entry.parent_id,
            })
        })
        .collect()
}

fn collect_file_sizes<F>(
    file_records: Vec<FileRecord>,
    drive_letter: char,
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
    let wanted_mft_ids: HashSet<u64> = file_records.iter().map(|record| record.mft_id).collect();
    let mft_size_map = NtfsFileSizeReader::open(drive_letter)
        .ok()
        .map(|reader| reader.read_file_size_map(&wanted_mft_ids, progress, scan_start))
        .unwrap_or_default();
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
                        "正在读取文件大小",
                        current,
                        Some(total),
                    );
                }

                // 优先使用顺序扫描 $MFT 得到的大小表，避免每个文件随机 seek 读取 FILE record。
                // 少数解析不到的记录再回退 metadata，保证准确性和兼容性。
                let size = if let Some(size) = mft_size_map.get(&record.mft_id).copied() {
                    mft_size_count.fetch_add(1, Ordering::Relaxed);
                    size
                } else {
                    let size = fs::metadata(&record.path).ok()?.len();
                    metadata_fallback_count.fetch_add(1, Ordering::Relaxed);
                    size
                };
                if size == 0 {
                    return None;
                }
                Some(FileSizeRecord {
                    parent_id: record.parent_id,
                    path: normalize_path(&record.path),
                    size,
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

    for record in file_sizes {
        let mut current_id = record.parent_id;
        let mut guard = 0usize;

        while let Some(directory) = directory_index.get(&current_id) {
            if directory.depth <= max_depth {
                *size_by_dir.entry(current_id).or_insert(0) += record.size;
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

fn join_windows_path(parent: &str, name: &str) -> String {
    if parent.ends_with('\\') {
        format!("{}{}", parent, name)
    } else {
        format!("{}\\{}", parent, name)
    }
}

impl NtfsFileSizeReader {
    fn open(drive_letter: char) -> Result<Self, String> {
        let volume_path = format!("\\\\.\\{}:", drive_letter);
        let volume = fs::OpenOptions::new()
            .read(true)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE) as u32)
            .open(&volume_path)
            .map_err(|error| format!("打开 NTFS 卷失败: {}", error))?;

        let mut boot_sector = [0u8; 512];
        volume
            .seek_read(&mut boot_sector, 0)
            .map_err(|error| format!("读取 NTFS 引导扇区失败: {}", error))?;

        let bytes_per_sector = read_u16(&boot_sector, 11)
            .ok_or_else(|| "NTFS 引导扇区缺少 bytes_per_sector".to_string())?
            as usize;
        let sectors_per_cluster = boot_sector
            .get(13)
            .copied()
            .ok_or_else(|| "NTFS 引导扇区缺少 sectors_per_cluster".to_string())?
            as usize;
        let cluster_size = (bytes_per_sector * sectors_per_cluster) as u64;
        let mft_lcn =
            read_i64(&boot_sector, 48).ok_or_else(|| "NTFS 引导扇区缺少 MFT LCN".to_string())?;
        let file_record_size = decode_file_record_size(
            *boot_sector
                .get(64)
                .ok_or_else(|| "NTFS 引导扇区缺少 FILE record 大小".to_string())? as i8,
            cluster_size,
        );

        let mut reader = Self {
            volume,
            bytes_per_sector,
            cluster_size,
            file_record_size,
            mft_runs: vec![DataRun {
                start_lcn: mft_lcn,
                cluster_count: 24,
            }],
        };

        if let Some(runs) = reader.read_mft_data_runs() {
            reader.mft_runs = runs;
        }

        Ok(reader)
    }

    fn read_mft_data_runs(&self) -> Option<Vec<DataRun>> {
        let mut record = vec![0u8; self.file_record_size];
        let first_run = self.mft_runs.first()?;
        let offset = (first_run.start_lcn as u64).checked_mul(self.cluster_size)?;
        self.volume.seek_read(&mut record, offset).ok()?;
        self.apply_fixup(&mut record)?;
        parse_file_record_data_runs(&record)
    }

    fn read_file_size_map<F>(
        &self,
        wanted_mft_ids: &HashSet<u64>,
        progress: &F,
        scan_start: &Instant,
    ) -> HashMap<u64, u64>
    where
        F: Fn(DiskGrowthScanProgress) + Sync,
    {
        let mut size_by_mft_id = HashMap::with_capacity(wanted_mft_ids.len());
        let mut next_record_id = 0u64;

        for run in &self.mft_runs {
            if is_disk_growth_cancelled() {
                break;
            }
            let Some(run_start) = (run.start_lcn as u64).checked_mul(self.cluster_size) else {
                break;
            };
            let Some(run_bytes) = run.cluster_count.checked_mul(self.cluster_size) else {
                break;
            };

            let records_in_run = run_bytes / self.file_record_size as u64;
            let mut bytes_read_in_run = 0u64;
            let mut buffer = vec![0u8; MFT_SIZE_READ_CHUNK.max(self.file_record_size)];

            while bytes_read_in_run < run_bytes {
                if is_disk_growth_cancelled() {
                    return size_by_mft_id;
                }
                let remaining = (run_bytes - bytes_read_in_run) as usize;
                let read_len = remaining.min(buffer.len());
                let aligned_read_len = read_len - (read_len % self.file_record_size);
                if aligned_read_len == 0 {
                    break;
                }

                if self
                    .volume
                    .seek_read(
                        &mut buffer[..aligned_read_len],
                        run_start + bytes_read_in_run,
                    )
                    .is_err()
                {
                    break;
                }

                for record_bytes in buffer[..aligned_read_len].chunks_exact(self.file_record_size) {
                    if wanted_mft_ids.contains(&next_record_id) {
                        let mut record = record_bytes.to_vec();
                        if self.apply_fixup(&mut record).is_some() {
                            if let Some(size) = parse_file_record_data_size(&record) {
                                size_by_mft_id.insert(next_record_id, size);
                            }
                        }
                    }

                    next_record_id += 1;
                    if next_record_id % 100_000 == 0 {
                        emit_progress(
                            progress,
                            scan_start,
                            "metadata",
                            "正在顺序解析 MFT 文件大小",
                            next_record_id as usize,
                            None,
                        );
                    }

                    if size_by_mft_id.len() >= wanted_mft_ids.len() {
                        return size_by_mft_id;
                    }
                }

                bytes_read_in_run += aligned_read_len as u64;
            }

            next_record_id +=
                records_in_run.saturating_sub(bytes_read_in_run / self.file_record_size as u64);
        }

        size_by_mft_id
    }

    fn apply_fixup(&self, record: &mut [u8]) -> Option<()> {
        if record.len() < 8 || &record[0..4] != b"FILE" {
            return None;
        }

        let fixup_offset = read_u16(record, 4)? as usize;
        let fixup_count = read_u16(record, 6)? as usize;
        if fixup_count == 0 || fixup_offset + fixup_count * 2 > record.len() {
            return None;
        }

        let sectors_in_record = record.len() / self.bytes_per_sector;
        if fixup_count != sectors_in_record + 1 {
            return None;
        }

        let update_sequence = read_u16(record, fixup_offset)?;
        for sector_index in 0..sectors_in_record {
            let sector_tail = (sector_index + 1) * self.bytes_per_sector - 2;
            if read_u16(record, sector_tail)? != update_sequence {
                return None;
            }
            let replacement_offset = fixup_offset + (sector_index + 1) * 2;
            let replacement = read_u16(record, replacement_offset)?;
            write_u16(record, sector_tail, replacement)?;
        }

        Some(())
    }
}

fn parse_file_record_data_size(record: &[u8]) -> Option<u64> {
    let attributes_offset = read_u16(record, 20)? as usize;
    let mut offset = attributes_offset;

    while offset + 16 <= record.len() {
        let attribute_type = read_u32(record, offset)?;
        if attribute_type == 0xFFFF_FFFF {
            break;
        }

        let attribute_length = read_u32(record, offset + 4)? as usize;
        if attribute_length == 0 || offset + attribute_length > record.len() {
            return None;
        }

        if attribute_type == 0x80 {
            let non_resident = *record.get(offset + 8)?;
            return if non_resident == 0 {
                read_u32(record, offset + 16).map(|size| size as u64)
            } else {
                read_u64(record, offset + 48)
            };
        }

        offset += attribute_length;
    }

    None
}

fn parse_file_record_data_runs(record: &[u8]) -> Option<Vec<DataRun>> {
    let attributes_offset = read_u16(record, 20)? as usize;
    let mut offset = attributes_offset;

    while offset + 16 <= record.len() {
        let attribute_type = read_u32(record, offset)?;
        if attribute_type == 0xFFFF_FFFF {
            break;
        }

        let attribute_length = read_u32(record, offset + 4)? as usize;
        if attribute_length == 0 || offset + attribute_length > record.len() {
            return None;
        }

        if attribute_type == 0x80 && *record.get(offset + 8)? == 1 {
            let data_run_offset = read_u16(record, offset + 32)? as usize;
            let data_run_start = offset + data_run_offset;
            let data_run_end = offset + attribute_length;
            return parse_data_runs(record.get(data_run_start..data_run_end)?);
        }

        offset += attribute_length;
    }

    None
}

fn parse_data_runs(bytes: &[u8]) -> Option<Vec<DataRun>> {
    let mut runs = Vec::new();
    let mut offset = 0usize;
    let mut current_lcn = 0i64;

    while offset < bytes.len() {
        let header = *bytes.get(offset)?;
        offset += 1;
        if header == 0 {
            break;
        }

        let length_size = (header & 0x0F) as usize;
        let offset_size = (header >> 4) as usize;
        if length_size == 0
            || length_size > 8
            || offset_size > 8
            || offset + length_size + offset_size > bytes.len()
        {
            return None;
        }

        let cluster_count = read_unsigned_le(&bytes[offset..offset + length_size]);
        offset += length_size;
        let lcn_delta = read_signed_le(&bytes[offset..offset + offset_size]);
        offset += offset_size;

        current_lcn = current_lcn.checked_add(lcn_delta)?;
        if current_lcn < 0 {
            return None;
        }

        runs.push(DataRun {
            start_lcn: current_lcn,
            cluster_count,
        });
    }

    if runs.is_empty() {
        None
    } else {
        Some(runs)
    }
}

fn decode_file_record_size(raw: i8, cluster_size: u64) -> usize {
    if raw > 0 {
        raw as usize * cluster_size as usize
    } else {
        1usize << (-raw as usize)
    }
}

fn read_u16(buffer: &[u8], offset: usize) -> Option<u16> {
    let bytes = buffer.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn write_u16(buffer: &mut [u8], offset: usize, value: u16) -> Option<()> {
    let bytes = buffer.get_mut(offset..offset + 2)?;
    bytes.copy_from_slice(&value.to_le_bytes());
    Some(())
}

fn read_u32(buffer: &[u8], offset: usize) -> Option<u32> {
    let bytes = buffer.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_u64(buffer: &[u8], offset: usize) -> Option<u64> {
    let bytes = buffer.get(offset..offset + 8)?;
    Some(u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn read_i64(buffer: &[u8], offset: usize) -> Option<i64> {
    let bytes = buffer.get(offset..offset + 8)?;
    Some(i64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ]))
}

fn read_unsigned_le(bytes: &[u8]) -> u64 {
    let mut value = 0u64;
    for (index, byte) in bytes.iter().enumerate() {
        value |= (*byte as u64) << (index * 8);
    }
    value
}

fn read_signed_le(bytes: &[u8]) -> i64 {
    if bytes.is_empty() {
        return 0;
    }

    let mut value = read_unsigned_le(bytes) as i64;
    let sign_bit = 1i64 << (bytes.len() * 8 - 1);
    if value & sign_bit != 0 {
        value -= 1i64 << (bytes.len() * 8);
    }
    value
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

fn depth_from_root(path: &str, root: &str) -> usize {
    let normalized_path = path.to_lowercase();
    let normalized_root = root.to_lowercase();
    if !normalized_path.starts_with(&normalized_root) {
        return 0;
    }

    normalized_path[normalized_root.len()..]
        .trim_matches('\\')
        .split('\\')
        .filter(|part| !part.is_empty())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_uses_forward_slash_and_lowercase() {
        assert_eq!(normalize_path("C:\\Users\\Evan"), "c:/users/evan");
    }

    #[test]
    fn depth_from_root_counts_segments() {
        assert_eq!(depth_from_root("C:\\", "C:\\"), 0);
        assert_eq!(depth_from_root("C:\\Users", "C:\\"), 1);
        assert_eq!(depth_from_root("C:\\Users\\Evan\\AppData", "C:\\"), 3);
    }
}
