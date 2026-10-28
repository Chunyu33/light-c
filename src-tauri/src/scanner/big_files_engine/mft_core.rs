// ============================================================================
// MFT 核心 — USN 枚举 + $MFT 顺序读取（供 big_files 使用）
// ============================================================================

#![cfg(target_os = "windows")]

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs;
use std::os::windows::fs::{FileExt, OpenOptionsExt};

use winapi::shared::minwindef::{BOOL, DWORD, LPVOID};
use winapi::shared::ntdef::HANDLE;
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::fileapi::{CreateFileW, OPEN_EXISTING};
use winapi::um::handleapi::CloseHandle;
use winapi::um::ioapiset::DeviceIoControl;
use winapi::um::processthreadsapi::{GetCurrentProcess, OpenProcessToken};
use winapi::um::securitybaseapi::GetTokenInformation;
use winapi::um::winnt::{
    TokenElevation, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_SHARE_READ,
    FILE_SHARE_WRITE, GENERIC_READ, TOKEN_ELEVATION, TOKEN_QUERY,
};

extern "system" {
    fn GetVolumeInformationW(
        lpRootPathName: *const u16,
        lpVolumeNameBuffer: *mut u16,
        nVolumeNameSize: DWORD,
        lpVolumeSerialNumber: *mut DWORD,
        lpMaximumComponentLength: *mut DWORD,
        lpFileSystemFlags: *mut DWORD,
        lpFileSystemNameBuffer: *mut u16,
        nFileSystemNameSize: DWORD,
    ) -> BOOL;
}

pub const FSCTL_ENUM_USN_DATA: DWORD = (9 << 16) | (0 << 14) | (44 << 2) | 3;
pub const ERROR_HANDLE_EOF: DWORD = 38;
pub const USN_BUFFER_SIZE: usize = 1024 * 1024;
const MFT_METADATA_MAX: u64 = 25;
const MFT_READ_CHUNK: usize = 16 * 1024 * 1024;
// 深度垃圾扫描通常只命中少量缓存文件；候选较少时按记录定位读取，避免完整扫过整个 MFT。
const MFT_RANDOM_READ_THRESHOLD: usize = 8 * 1024;
// 把相邻候选合并成窗口，减少候选 ID 分散时的设备 seek 次数，同时避免读入过大空洞。
const MFT_RANDOM_READ_BATCH_RECORDS: u64 = 4096;
const MFT_RANDOM_READ_MAX_GAP_RECORDS: u64 = 64;
/// 顺序扫描标志：告诉系统这批读取是连续向前的，让它提前预读后续数据。
///
/// 不加这个标志时，每次 seek_read 都要等上一块读完才发下一个请求，
/// I/O 队列深度只有 1，多盘冷读会慢一倍以上（实测四个盘 5.78GB 从 35 秒降到正常水平）。
const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
const WINDOWS_TO_UNIX_SECONDS: i64 = 11_644_473_600;
const FILE_RECORD_FLAG_IN_USE: u16 = 0x0001;
const FILE_RECORD_FLAG_DIRECTORY: u16 = 0x0002;
/// `$FILE_NAME` 的命名空间标记，2 表示 DOS 8.3 短名 —— 优先取长名。
const FILE_NAME_NAMESPACE_DOS: u8 = 2;
/// 重解析点（junction / 符号链接）在 `$STANDARD_INFORMATION` 里的属性位。
const FILE_ATTRIBUTE_REPARSE_POINT_BIT: u32 = 0x0000_0400;

#[repr(C)]
#[allow(non_snake_case)]
pub struct MftEnumDataV0 {
    pub StartFileReferenceNumber: u64,
    pub LowUsn: i64,
    pub HighUsn: i64,
}

#[derive(Clone)]
pub struct MftEntry {
    pub mft_id: u64,
    pub parent_id: u64,
    pub name: String,
    pub is_dir: bool,
}

/// 一条 `$MFT` 记录里能一次拿到的全部信息。
///
/// 名字来自 `$FILE_NAME` 属性，大小来自 `$DATA` 属性，两者在同一条记录里，
/// 所以顺序读一遍就能同时得到 —— 不必再走一次 USN 枚举（那是内核遍历整张 MFT，
/// 实测比用户态顺序读慢 6 倍）。
#[derive(Clone)]
pub struct MftRecordInfo {
    pub mft_id: u64,
    pub parent_id: u64,
    pub name: String,
    pub is_dir: bool,
    /// 目录恒为 0。
    pub size: u64,
    pub modified: i64,
    /// 是否解析出了未命名的 `$DATA` 流。
    ///
    /// `size` 为 0 有两种来源：真的是空文件，或者 `$DATA` 没解析出来。
    /// 需要区分时（比如要决定是否回退去 stat）看这个标记，别只看 size。
    pub has_data_stream: bool,
}

/// 一次全量读取的统计。
///
/// `io_ms` 和 `parse_ms` 是分开计的：只有拆开才知道慢在磁盘还是 CPU，
/// 之前只看总耗时，改了两轮都是盲改。
#[derive(Debug, Clone, Copy, Default)]
pub struct MftReadStats {
    /// `$MFT` 的 data run 个数
    pub fragments: usize,
    /// 等待磁盘返回数据的时间
    pub io_ms: u64,
    /// 解析记录（fixup + 属性）的时间
    pub parse_ms: u64,
}

#[derive(Clone)]
pub struct MftFileMetadata {
    pub size: u64,
    pub modified: i64,
    pub is_cloud_placeholder: bool,
}

#[derive(Clone)]
pub struct MftTopFileCandidate {
    pub mft_id: u64,
    pub size: u64,
    pub modified: i64,
}

#[derive(Clone)]
struct DataRun {
    start_lcn: i64,
    cluster_count: u64,
}

/// 路径重建只关心三件事：自身 id、父 id、名字。
///
/// `MftEntry`（USN 枚举结果）和 `MftRecordInfo`（$MFT 直读结果）结构不同，
/// 但重建路径的逻辑完全一样，用这个 trait 避免维护两份实现。
trait PathNode {
    fn node_id(&self) -> u64;
    fn parent_id(&self) -> u64;
    fn node_name(&self) -> &str;
}

impl PathNode for MftEntry {
    fn node_id(&self) -> u64 {
        self.mft_id
    }
    fn parent_id(&self) -> u64 {
        self.parent_id
    }
    fn node_name(&self) -> &str {
        &self.name
    }
}

impl PathNode for MftRecordInfo {
    fn node_id(&self) -> u64 {
        self.mft_id
    }
    fn parent_id(&self) -> u64 {
        self.parent_id
    }
    fn node_name(&self) -> &str {
        &self.name
    }
}

pub struct NtfsFileMetadataReader {
    volume: fs::File,
    bytes_per_sector: usize,
    cluster_size: u64,
    file_record_size: usize,
    mft_runs: Vec<DataRun>,
}

pub fn open_volume(drive_letter: char) -> Result<HANDLE, String> {
    let p = format!("\\\\.\\{}:", drive_letter);
    let w: Vec<u16> = p.encode_utf16().chain(std::iter::once(0)).collect();
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    if h == winapi::um::handleapi::INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        return Err(format!("无法打开卷设备 {} (错误码: {})", p, err));
    }
    Ok(h)
}

pub fn close_volume(h: HANDLE) {
    unsafe { CloseHandle(h) };
}

pub fn enumerate_usn_records_v2(
    h_device: HANDLE,
    cb: &impl Fn(usize) -> bool,
) -> Result<Vec<MftEntry>, String> {
    let mut entries: Vec<MftEntry> = Vec::new();
    let mut buf: Vec<u8> = vec![0u8; USN_BUFFER_SIZE];
    let mut processed: usize = 0;
    let mut frn: u64 = 0;
    loop {
        let mut br: DWORD = 0;
        let mut ed = MftEnumDataV0 {
            StartFileReferenceNumber: frn,
            LowUsn: 0,
            HighUsn: i64::MAX,
        };
        let ok = unsafe {
            DeviceIoControl(
                h_device,
                FSCTL_ENUM_USN_DATA,
                &mut ed as *mut _ as LPVOID,
                std::mem::size_of::<MftEnumDataV0>() as DWORD,
                buf.as_mut_ptr() as LPVOID,
                USN_BUFFER_SIZE as DWORD,
                &mut br,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            if unsafe { GetLastError() } == ERROR_HANDLE_EOF {
                break;
            }
            return Err("DeviceIoControl 失败".into());
        }
        if br == 0 {
            break;
        }
        if processed == 0 && !cb(0) {
            return Err("扫描已取消".into());
        }
        let mut offset: usize = 8;
        while offset < br as usize {
            let Some((rlen, mft_id, parent_id, file_name, _is_dir, is_reparse)) =
                read_usn_record(&buf, offset, br as usize)
            else {
                break;
            };
            if !file_name.is_empty() && !is_reparse && mft_id > MFT_METADATA_MAX {
                entries.push(MftEntry {
                    mft_id,
                    parent_id,
                    name: file_name,
                    is_dir: _is_dir,
                });
            }
            processed += 1;
            if processed % 10_000 == 0 && !cb(processed) {
                return Err("扫描已取消".into());
            }
            offset += rlen;
        }
        frn = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const u64) };
    }
    cb(processed);
    Ok(entries)
}

fn read_usn_record(
    buffer: &[u8],
    offset: usize,
    bytes_returned: usize,
) -> Option<(usize, u64, u64, String, bool, bool)> {
    unsafe {
        let base = buffer.as_ptr().add(offset);
        let record_len = std::ptr::read_unaligned(base as *const u32) as usize;
        if record_len == 0 || offset + record_len > bytes_returned {
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
        let is_dir = (attributes & FILE_ATTRIBUTE_DIRECTORY) == FILE_ATTRIBUTE_DIRECTORY;
        let is_reparse =
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) == FILE_ATTRIBUTE_REPARSE_POINT;

        Some((
            record_len,
            file_ref & 0x0000_FFFF_FFFF_FFFF,
            parent_ref & 0x0000_FFFF_FFFF_FFFF,
            name,
            is_dir,
            is_reparse,
        ))
    }
}

pub fn rebuild_paths_for_ids(
    entries: &[MftEntry],
    drive_letter: char,
    target_ids: &HashSet<u64>,
) -> HashMap<u64, String> {
    rebuild_paths_for_nodes(entries, drive_letter, target_ids)
}

/// 与 `rebuild_paths_for_ids` 相同，只是输入是 `$MFT` 直读出来的记录。
pub fn rebuild_paths_for_records(
    records: &[MftRecordInfo],
    drive_letter: char,
    target_ids: &HashSet<u64>,
) -> HashMap<u64, String> {
    rebuild_paths_for_nodes(records, drive_letter, target_ids)
}

fn rebuild_paths_for_nodes<T: PathNode>(
    entries: &[T],
    drive_letter: char,
    target_ids: &HashSet<u64>,
) -> HashMap<u64, String> {
    let mut entry_by_id: HashMap<u64, &T> = HashMap::with_capacity(entries.len());
    for entry in entries {
        entry_by_id.insert(entry.node_id(), entry);
    }

    let mut paths = HashMap::with_capacity(target_ids.len() + 1);
    let root_path = format!("{}:\\", drive_letter);
    paths.insert(5, root_path);

    for target_id in target_ids {
        let mut visiting = HashSet::new();
        // 只为候选路径做懒解析，避免全盘文件都分配完整路径字符串。
        let _ = resolve_path(*target_id, &entry_by_id, &mut paths, &mut visiting);
    }

    paths
}

fn resolve_path<T: PathNode>(
    mft_id: u64,
    entry_by_id: &HashMap<u64, &T>,
    paths: &mut HashMap<u64, String>,
    visiting: &mut HashSet<u64>,
) -> Option<()> {
    if paths.contains_key(&mft_id) {
        // 命中缓存时不再克隆完整路径，候选文件共享同一条已构建的父路径。
        return Some(());
    }
    if !visiting.insert(mft_id) {
        return None;
    }

    let entry = entry_by_id.get(&mft_id)?;
    resolve_path(entry.parent_id(), entry_by_id, paths, visiting)?;
    let parent_path = paths.get(&entry.parent_id())?.clone();
    let name = entry.node_name();
    let mut full_path = String::with_capacity(parent_path.len() + 1 + name.len());
    full_path.push_str(&parent_path);
    if !parent_path.ends_with('\\') {
        full_path.push('\\');
    }
    full_path.push_str(name);
    paths.insert(mft_id, full_path);
    visiting.remove(&mft_id);
    Some(())
}

pub fn is_elevated() -> bool {
    let mut t: HANDLE = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t) } == 0 {
        return false;
    }
    let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut s: DWORD = 0;
    let ok = unsafe {
        GetTokenInformation(
            t,
            TokenElevation,
            &mut e as *mut _ as LPVOID,
            std::mem::size_of::<TOKEN_ELEVATION>() as DWORD,
            &mut s,
        )
    };
    unsafe { CloseHandle(t) };
    ok != 0 && e.TokenIsElevated != 0
}

pub fn is_ntfs(drive_letter: char) -> bool {
    let r = format!("{}:\\", drive_letter);
    let w: Vec<u16> = r.encode_utf16().chain(std::iter::once(0)).collect();
    let mut fs: [u16; 16] = [0; 16];
    if unsafe {
        GetVolumeInformationW(
            w.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fs.as_mut_ptr(),
            fs.len() as DWORD,
        )
    } == 0
    {
        return false;
    }
    String::from_utf16_lossy(&fs)
        .trim_end_matches('\0')
        .eq_ignore_ascii_case("NTFS")
}

impl NtfsFileMetadataReader {
    pub fn open(drive_letter: char) -> Result<Self, String> {
        let volume_path = format!("\\\\.\\{}:", drive_letter);
        let volume = fs::OpenOptions::new()
            .read(true)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE) as u32)
            // $MFT 是按 run 顺序整段读的，交给系统预读能把磁盘的并发能力用起来
            .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN)
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
            // 先用 boot sector 里的 $MFT 起点读取自身记录，再解析真正 data runs。
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

    /// 读完整张 `$MFT`，每条有效记录解析出名字、父子关系、大小与修改时间。
    ///
    /// 返回记录和统计。**读盘与解析分别计时**：只有拆开才能判断瓶颈在磁盘还是 CPU，
    /// 否则只能靠猜（前两轮改动就是没拆开，方向都选偏了）。
    pub fn read_all_records(
        &self,
        progress_cb: &impl Fn(usize) -> bool,
    ) -> Result<(Vec<MftRecordInfo>, MftReadStats), String> {
        // $MFT 的记录按逻辑顺序连续编号，先算出每段起始记录号
        let mut run_starts = Vec::with_capacity(self.mft_runs.len());
        let mut logical_record_id = 0u64;
        for run in &self.mft_runs {
            run_starts.push(logical_record_id);
            logical_record_id += run.cluster_count * self.cluster_size / self.file_record_size as u64;
        }

        let mut records: Vec<MftRecordInfo> = Vec::with_capacity(logical_record_id as usize / 2);
        let mut processed = 0usize;
        let mut io_nanos = 0u128;
        let mut parse_nanos = 0u128;

        for (run, &base_record_id) in self.mft_runs.iter().zip(run_starts.iter()) {
            let (chunk, io, parse) =
                self.read_single_run(run, base_record_id, progress_cb, &mut processed)?;
            records.extend(chunk);
            io_nanos += io;
            parse_nanos += parse;
        }

        Ok((
            records,
            MftReadStats {
                fragments: self.mft_runs.len(),
                io_ms: (io_nanos / 1_000_000) as u64,
                parse_ms: (parse_nanos / 1_000_000) as u64,
            },
        ))
    }

    /// 读一个 data run 区间内的全部记录，返回(记录, 读盘耗时, 解析耗时)。
    fn read_single_run(
        &self,
        run: &DataRun,
        base_record_id: u64,
        progress_cb: &impl Fn(usize) -> bool,
        processed: &mut usize,
    ) -> Result<(Vec<MftRecordInfo>, u128, u128), String> {
        let run_start = (run.start_lcn as u64)
            .checked_mul(self.cluster_size)
            .ok_or_else(|| "$MFT data run 起始位置溢出".to_string())?;
        let run_bytes = run
            .cluster_count
            .checked_mul(self.cluster_size)
            .ok_or_else(|| "$MFT data run 大小溢出".to_string())?;
        let records_in_run = run_bytes / self.file_record_size as u64;

        let mut records: Vec<MftRecordInfo> = Vec::with_capacity(records_in_run as usize / 2);
        // 复用同一块缓冲做 fixup：每条记录都 to_vec 会在百万级记录上产生同样次数的堆分配
        let mut scratch = vec![0u8; self.file_record_size];
        let mut bytes_read_in_run = 0u64;
        let mut buffer = vec![0u8; MFT_READ_CHUNK.max(self.file_record_size)];
        let mut io_nanos = 0u128;
        let mut parse_nanos = 0u128;

        while bytes_read_in_run < run_bytes {
            let remaining = (run_bytes - bytes_read_in_run) as usize;
            let read_len = remaining.min(buffer.len());
            let aligned_read_len = read_len - (read_len % self.file_record_size);
            if aligned_read_len == 0 {
                break;
            }

            let read_started = std::time::Instant::now();
            self.volume
                .seek_read(
                    &mut buffer[..aligned_read_len],
                    run_start + bytes_read_in_run,
                )
                .map_err(|error| format!("读取 $MFT data run 失败: {}", error))?;
            io_nanos += read_started.elapsed().as_nanos();

            let parse_started = std::time::Instant::now();
            let records_before_chunk = bytes_read_in_run / self.file_record_size as u64;
            for (record_index, record_bytes) in buffer[..aligned_read_len]
                .chunks_exact(self.file_record_size)
                .enumerate()
            {
                let record_id = base_record_id + records_before_chunk + record_index as u64;
                // 先用头部 flags 粗筛：空闲记录和系统元数据记录占多数，不值得做 fixup
                if record_id > MFT_METADATA_MAX && looks_like_active_record(record_bytes) {
                    scratch.copy_from_slice(record_bytes);
                    if self.apply_fixup(&mut scratch).is_some() {
                        if let Some(info) = parse_record_info(&scratch, record_id) {
                            records.push(info);
                        }
                    }
                }

                *processed += 1;
                if *processed % 100_000 == 0 && !progress_cb(*processed) {
                    return Err("扫描已取消".into());
                }
            }
            parse_nanos += parse_started.elapsed().as_nanos();

            bytes_read_in_run += aligned_read_len as u64;
        }

        Ok((records, io_nanos, parse_nanos))
    }

    pub fn read_top_file_candidates(
        &self,
        top_limit: usize,
        progress_cb: &impl Fn(usize) -> bool,
    ) -> Result<Vec<MftTopFileCandidate>, String> {
        let mut heap: BinaryHeap<Reverse<(u64, u64, i64)>> = BinaryHeap::new();
        let mut logical_record_id = 0u64;

        for run in &self.mft_runs {
            let run_start = (run.start_lcn as u64)
                .checked_mul(self.cluster_size)
                .ok_or_else(|| "$MFT data run 起始位置溢出".to_string())?;
            let run_bytes = run
                .cluster_count
                .checked_mul(self.cluster_size)
                .ok_or_else(|| "$MFT data run 大小溢出".to_string())?;
            let records_in_run = run_bytes / self.file_record_size as u64;
            let mut bytes_read_in_run = 0u64;
            let mut buffer = vec![0u8; MFT_READ_CHUNK.max(self.file_record_size)];

            while bytes_read_in_run < run_bytes {
                let remaining = (run_bytes - bytes_read_in_run) as usize;
                let read_len = remaining.min(buffer.len());
                let aligned_read_len = read_len - (read_len % self.file_record_size);
                if aligned_read_len == 0 {
                    break;
                }

                self.volume
                    .seek_read(
                        &mut buffer[..aligned_read_len],
                        run_start + bytes_read_in_run,
                    )
                    .map_err(|error| format!("顺序读取 $MFT 失败: {}", error))?;

                let records_before_chunk = bytes_read_in_run / self.file_record_size as u64;
                for (record_index, record_bytes) in buffer[..aligned_read_len]
                    .chunks_exact(self.file_record_size)
                    .enumerate()
                {
                    let record_id = logical_record_id + records_before_chunk + record_index as u64;
                    if !looks_like_active_file(record_bytes) {
                        if record_id % 100_000 == 0 && !progress_cb(record_id as usize) {
                            return Err("扫描已取消".into());
                        }
                        continue;
                    }

                    let mut record = record_bytes.to_vec();
                    if self.apply_fixup(&mut record).is_some() {
                        if let Some(metadata) = parse_active_file_record_metadata(&record) {
                            // 在进入 Top-N 堆之前过滤，避免云端占位文件挤掉真正占用本地空间的文件。
                            if metadata.size > 0 && !metadata.is_cloud_placeholder {
                                heap.push(Reverse((metadata.size, record_id, metadata.modified)));
                                if heap.len() > top_limit {
                                    heap.pop();
                                }
                            }
                        }
                    }

                    if record_id % 100_000 == 0 && !progress_cb(record_id as usize) {
                        return Err("扫描已取消".into());
                    }
                }

                bytes_read_in_run += aligned_read_len as u64;
            }

            logical_record_id += records_in_run;
        }

        let mut candidates: Vec<MftTopFileCandidate> = heap
            .into_iter()
            .map(|Reverse((size, mft_id, modified))| MftTopFileCandidate {
                mft_id,
                size,
                modified,
            })
            .collect();
        candidates.sort_by(|left, right| {
            right
                .size
                .cmp(&left.size)
                .then_with(|| left.mft_id.cmp(&right.mft_id))
        });
        Ok(candidates)
    }

    pub fn read_file_metadata_map(
        &self,
        wanted_mft_ids: &HashSet<u64>,
        progress_cb: &impl Fn(usize) -> bool,
    ) -> Result<HashMap<u64, MftFileMetadata>, String> {
        if wanted_mft_ids.len() <= MFT_RANDOM_READ_THRESHOLD {
            return self.read_file_metadata_map_random(wanted_mft_ids, progress_cb);
        }

        self.read_file_metadata_map_sequential(wanted_mft_ids, progress_cb)
    }

    fn read_file_metadata_map_random(
        &self,
        wanted_mft_ids: &HashSet<u64>,
        progress_cb: &impl Fn(usize) -> bool,
    ) -> Result<HashMap<u64, MftFileMetadata>, String> {
        let mut wanted_ids: Vec<u64> = wanted_mft_ids.iter().copied().collect();
        wanted_ids.sort_unstable();

        let mut metadata_by_id = HashMap::with_capacity(wanted_mft_ids.len());
        let mut wanted_index = 0usize;
        let mut logical_record_id = 0u64;
        let mut processed = 0usize;

        for run in &self.mft_runs {
            let run_start = (run.start_lcn as u64)
                .checked_mul(self.cluster_size)
                .ok_or_else(|| "$MFT data run 起始位置溢出".to_string())?;
            let run_bytes = run
                .cluster_count
                .checked_mul(self.cluster_size)
                .ok_or_else(|| "$MFT data run 大小溢出".to_string())?;
            let records_in_run = run_bytes / self.file_record_size as u64;
            let run_end_id = logical_record_id.saturating_add(records_in_run);

            while wanted_index < wanted_ids.len() && wanted_ids[wanted_index] < run_end_id {
                if wanted_ids[wanted_index] < logical_record_id {
                    wanted_index += 1;
                    continue;
                }

                let batch_start_id = wanted_ids[wanted_index];
                let mut batch_end = wanted_index + 1;
                while batch_end < wanted_ids.len()
                    && wanted_ids[batch_end] - wanted_ids[batch_end - 1]
                        <= MFT_RANDOM_READ_MAX_GAP_RECORDS
                    && wanted_ids[batch_end] - batch_start_id < MFT_RANDOM_READ_BATCH_RECORDS
                    && wanted_ids[batch_end] < run_end_id
                {
                    batch_end += 1;
                }

                let batch_last_id = wanted_ids[batch_end - 1];
                let batch_records = (batch_last_id - batch_start_id + 1) as usize;
                let batch_bytes = batch_records
                    .checked_mul(self.file_record_size)
                    .ok_or_else(|| "$MFT 候选批次大小溢出".to_string())?;
                let batch_offset = run_start
                    .checked_add(
                        (batch_start_id - logical_record_id)
                            .checked_mul(self.file_record_size as u64)
                            .ok_or_else(|| "$MFT 候选记录偏移溢出".to_string())?,
                    )
                    .ok_or_else(|| "$MFT 候选记录位置溢出".to_string())?;
                let mut buffer = vec![0u8; batch_bytes];

                self.volume
                    .seek_read(&mut buffer, batch_offset)
                    .map_err(|error| format!("按 MFT ID 读取文件记录失败: {}", error))?;

                for (record_offset, record_bytes) in
                    buffer.chunks_exact(self.file_record_size).enumerate()
                {
                    let record_id = batch_start_id + record_offset as u64;
                    if wanted_mft_ids.contains(&record_id) {
                        if let Some(metadata) = self.parse_record_metadata(record_bytes) {
                            metadata_by_id.insert(record_id, metadata);
                        }
                        processed += 1;
                        if processed % 1000 == 0 && !progress_cb(processed) {
                            return Err("扫描已取消".into());
                        }
                    }
                }
                wanted_index = batch_end;
            }

            logical_record_id = run_end_id;
            if metadata_by_id.len() >= wanted_mft_ids.len() || wanted_index >= wanted_ids.len() {
                break;
            }
        }

        progress_cb(processed);
        Ok(metadata_by_id)
    }

    fn read_file_metadata_map_sequential(
        &self,
        wanted_mft_ids: &HashSet<u64>,
        progress_cb: &impl Fn(usize) -> bool,
    ) -> Result<HashMap<u64, MftFileMetadata>, String> {
        let mut metadata_by_id = HashMap::with_capacity(wanted_mft_ids.len());
        let mut logical_record_id = 0u64;

        for run in &self.mft_runs {
            let run_start = (run.start_lcn as u64)
                .checked_mul(self.cluster_size)
                .ok_or_else(|| "$MFT data run 起始位置溢出".to_string())?;
            let run_bytes = run
                .cluster_count
                .checked_mul(self.cluster_size)
                .ok_or_else(|| "$MFT data run 大小溢出".to_string())?;
            let records_in_run = run_bytes / self.file_record_size as u64;
            let mut bytes_read_in_run = 0u64;
            let mut buffer = vec![0u8; MFT_READ_CHUNK.max(self.file_record_size)];

            while bytes_read_in_run < run_bytes {
                let remaining = (run_bytes - bytes_read_in_run) as usize;
                let read_len = remaining.min(buffer.len());
                let aligned_read_len = read_len - (read_len % self.file_record_size);
                if aligned_read_len == 0 {
                    break;
                }

                self.volume
                    .seek_read(
                        &mut buffer[..aligned_read_len],
                        run_start + bytes_read_in_run,
                    )
                    .map_err(|error| format!("顺序读取 $MFT 失败: {}", error))?;

                let records_before_chunk = bytes_read_in_run / self.file_record_size as u64;
                for (record_index, record_bytes) in buffer[..aligned_read_len]
                    .chunks_exact(self.file_record_size)
                    .enumerate()
                {
                    let record_id = logical_record_id + records_before_chunk + record_index as u64;
                    if wanted_mft_ids.contains(&record_id) {
                        if let Some(metadata) = self.parse_record_metadata(record_bytes) {
                            metadata_by_id.insert(record_id, metadata);
                        }
                    }

                    if record_id % 100_000 == 0 && !progress_cb(record_id as usize) {
                        return Err("扫描已取消".into());
                    }

                    if metadata_by_id.len() >= wanted_mft_ids.len() {
                        return Ok(metadata_by_id);
                    }
                }

                bytes_read_in_run += aligned_read_len as u64;
            }

            logical_record_id += records_in_run;
        }

        Ok(metadata_by_id)
    }

    fn parse_record_metadata(&self, record_bytes: &[u8]) -> Option<MftFileMetadata> {
        if !looks_like_active_file(record_bytes) {
            return None;
        }

        // 仅在命中候选记录时复制，避免顺序扫描路径为每条记录分配临时缓冲区。
        let mut record = record_bytes.to_vec();
        self.apply_fixup(&mut record)?;
        parse_active_file_record_metadata(&record)
    }

    fn read_mft_data_runs(&self) -> Option<Vec<DataRun>> {
        let mut record = vec![0u8; self.file_record_size];
        let first_run = self.mft_runs.first()?;
        let offset = (first_run.start_lcn as u64).checked_mul(self.cluster_size)?;
        self.volume.seek_read(&mut record, offset).ok()?;
        self.apply_fixup(&mut record)?;
        parse_file_record_data_runs(&record)
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

/// 只看头部 flags 判断记录是否在用，不区分文件与目录。
fn looks_like_active_record(record: &[u8]) -> bool {
    if record.len() < 24 || &record[0..4] != b"FILE" {
        return false;
    }
    match read_u16(record, 22) {
        Some(flags) => (flags & FILE_RECORD_FLAG_IN_USE) != 0,
        None => false,
    }
}

/// 解析一条已做过 fixup 的记录，取出名字、父目录、大小与时间。
///
/// 与 `parse_active_file_record_metadata` 的区别：那个只关心文件大小，
/// 这里还要拿 `$FILE_NAME`，所以目录记录也要解析。
fn parse_record_info(record: &[u8], mft_id: u64) -> Option<MftRecordInfo> {
    let flags = read_u16(record, 22)?;
    if (flags & FILE_RECORD_FLAG_IN_USE) == 0 {
        return None;
    }
    let is_dir = (flags & FILE_RECORD_FLAG_DIRECTORY) != 0;

    let attributes_offset = read_u16(record, 20)? as usize;
    let mut offset = attributes_offset;
    let mut modified = 0i64;
    let mut file_attributes = 0u32;
    let mut name_entry: Option<(u64, String, u8)> = None;
    let mut data_size: Option<u64> = None;

    while offset + 16 <= record.len() {
        let attribute_type = read_u32(record, offset)?;
        if attribute_type == 0xFFFF_FFFF {
            break;
        }
        let attribute_length = read_u32(record, offset + 4)? as usize;
        if attribute_length == 0 || offset + attribute_length > record.len() {
            return None;
        }

        match attribute_type {
            // $STANDARD_INFORMATION：修改时间 + 文件属性位（用来看是否重解析点）
            0x10 => {
                if let Some((standard_modified, standard_attributes)) =
                    parse_standard_info(record, offset)
                {
                    modified = standard_modified;
                    file_attributes = standard_attributes;
                }
            }
            // $FILE_NAME：父目录引用 + 文件名。硬链接会有多条，8.3 短名需要跳过
            0x30 => {
                if let Some((parent_id, name, namespace)) = parse_file_name_attribute(record, offset)
                {
                    let should_replace = match &name_entry {
                        None => true,
                        Some((_, _, existing_namespace)) => {
                            *existing_namespace == FILE_NAME_NAMESPACE_DOS
                                && namespace != FILE_NAME_NAMESPACE_DOS
                        }
                    };
                    if should_replace {
                        name_entry = Some((parent_id, name, namespace));
                    }
                }
            }
            // $DATA：只认未命名数据流，命名流属于备用数据流（ADS），不能拿来当文件大小
            0x80 => {
                if *record.get(offset + 9)? == 0 && data_size.is_none() {
                    data_size = parse_data_attribute_size(record, offset);
                }
            }
            _ => {}
        }

        offset += attribute_length;
    }

    // 重解析点（junction / 符号链接）不是本地真实文件，与 USN 枚举阶段的过滤保持一致
    if file_attributes & FILE_ATTRIBUTE_REPARSE_POINT_BIT != 0 {
        return None;
    }

    let (parent_id, name, _) = name_entry?;
    Some(MftRecordInfo {
        mft_id,
        parent_id,
        name,
        is_dir,
        size: if is_dir { 0 } else { data_size.unwrap_or(0) },
        modified,
        has_data_stream: data_size.is_some(),
    })
}

/// 解析 `$FILE_NAME` 属性：返回(父目录引用, 文件名, 命名空间)。
fn parse_file_name_attribute(record: &[u8], attribute_offset: usize) -> Option<(u64, String, u8)> {
    let value_offset = read_u16(record, attribute_offset + 20)? as usize;
    let value_start = attribute_offset + value_offset;
    let parent_reference = read_u64(record, value_start)? & 0x0000_FFFF_FFFF_FFFF;
    let name_length = *record.get(value_start + 64)? as usize;
    let namespace = *record.get(value_start + 65)?;
    if name_length == 0 {
        return None;
    }
    let name_start = value_start + 66;
    let name_end = name_start + name_length * 2;
    if name_end > record.len() {
        return None;
    }
    // 文件名是 UTF-16LE，直接按 u16 切片解码，不额外拷贝
    let units: Vec<u16> = record[name_start..name_end]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    Some((parent_reference, String::from_utf16_lossy(&units), namespace))
}

fn looks_like_active_file(record: &[u8]) -> bool {
    if record.len() < 24 || &record[0..4] != b"FILE" {
        return false;
    }
    let Some(flags) = read_u16(record, 22) else {
        return false;
    };
    // 先用头部 flags 粗过滤，减少对目录、空闲记录和异常记录的拷贝/fixup 成本。
    (flags & FILE_RECORD_FLAG_IN_USE) != 0 && (flags & FILE_RECORD_FLAG_DIRECTORY) == 0
}

fn parse_active_file_record_metadata(record: &[u8]) -> Option<MftFileMetadata> {
    let flags = read_u16(record, 22)?;
    if (flags & FILE_RECORD_FLAG_IN_USE) == 0 || (flags & FILE_RECORD_FLAG_DIRECTORY) != 0 {
        return None;
    }
    parse_file_record_metadata(record)
}

fn parse_file_record_metadata(record: &[u8]) -> Option<MftFileMetadata> {
    let attributes_offset = read_u16(record, 20)? as usize;
    let mut offset = attributes_offset;
    let mut modified = 0i64;
    let mut file_attributes = 0u32;
    let mut unnamed_data_size = None;
    let mut fallback_data_size = None;

    while offset + 16 <= record.len() {
        let attribute_type = read_u32(record, offset)?;
        if attribute_type == 0xFFFF_FFFF {
            break;
        }

        let attribute_length = read_u32(record, offset + 4)? as usize;
        if attribute_length == 0 || offset + attribute_length > record.len() {
            return None;
        }

        if attribute_type == 0x10 && modified == 0 {
            if let Some((standard_modified, standard_attributes)) =
                parse_standard_info(record, offset)
            {
                modified = standard_modified;
                file_attributes = standard_attributes;
            }
        }

        if attribute_type == 0x80 {
            let name_length = *record.get(offset + 9)?;
            let size = parse_data_attribute_size(record, offset);
            if name_length == 0 {
                unnamed_data_size = size;
                break;
            } else if fallback_data_size.is_none() {
                // 只有没有主数据流时才保留备用数据流大小，避免 ADS 抢占普通文件大小。
                fallback_data_size = size;
            }
        }

        offset += attribute_length;
    }

    let size = unnamed_data_size.or(fallback_data_size)?;
    Some(MftFileMetadata {
        size,
        modified,
        is_cloud_placeholder: crate::scanner::big_files::has_cloud_placeholder_attributes(
            file_attributes,
        ),
    })
}

fn parse_standard_info(record: &[u8], attribute_offset: usize) -> Option<(i64, u32)> {
    let value_offset = read_u16(record, attribute_offset + 20)? as usize;
    let value_start = attribute_offset + value_offset;
    let modified_filetime = read_u64(record, value_start + 8)?;
    let file_attributes = read_u32(record, value_start + 32)?;
    Some((filetime_to_unix_seconds(modified_filetime), file_attributes))
}

fn parse_data_attribute_size(record: &[u8], attribute_offset: usize) -> Option<u64> {
    let non_resident = *record.get(attribute_offset + 8)?;
    if non_resident == 0 {
        read_u32(record, attribute_offset + 16).map(|size| size as u64)
    } else {
        read_u64(record, attribute_offset + 48)
    }
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

        if attribute_type == 0x80 && *record.get(offset + 8)? == 1 && *record.get(offset + 9)? == 0
        {
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
            || offset_size == 0
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

fn filetime_to_unix_seconds(filetime: u64) -> i64 {
    let seconds = (filetime / 10_000_000) as i64 - WINDOWS_TO_UNIX_SECONDS;
    seconds.max(0)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 写一个 resident 属性头。value_offset 指向属性值在记录里的位置。
    fn write_attribute_header(
        record: &mut [u8],
        offset: usize,
        attribute_type: u32,
        length: usize,
        value_offset: u16,
    ) {
        record[offset..offset + 4].copy_from_slice(&attribute_type.to_le_bytes());
        record[offset + 4..offset + 8].copy_from_slice(&(length as u32).to_le_bytes());
        record[offset + 8] = 0; // resident
        record[offset + 9] = 0; // 没有属性名
        record[offset + 20..offset + 22].copy_from_slice(&value_offset.to_le_bytes());
    }

    /// 把 "报表.log" 这样的普通文件拼成一条最小的 $MFT 记录。
    fn build_file_record(name: &str, size: u32, parent_id: u64, file_attributes: u32) -> Vec<u8> {
        let mut record = vec![0u8; 1024];
        record[0..4].copy_from_slice(b"FILE");
        record[20..22].copy_from_slice(&56u16.to_le_bytes());
        // 在用、不是目录
        record[22..24].copy_from_slice(&FILE_RECORD_FLAG_IN_USE.to_le_bytes());

        // $STANDARD_INFORMATION：修改时间 + 文件属性位
        let standard_info = 56;
        write_attribute_header(&mut record, standard_info, 0x10, 96, 24);
        let filetime = ((1_700_000_000i64 + WINDOWS_TO_UNIX_SECONDS) * 10_000_000) as u64;
        record[standard_info + 24 + 8..standard_info + 24 + 16]
            .copy_from_slice(&filetime.to_le_bytes());
        record[standard_info + 24 + 32..standard_info + 24 + 36]
            .copy_from_slice(&file_attributes.to_le_bytes());

        // $FILE_NAME：父目录引用 + 文件名（Win32 长名）
        let file_name = standard_info + 96;
        let name_units: Vec<u16> = name.encode_utf16().collect();
        let file_name_length = (24 + 66 + name_units.len() * 2 + 7) / 8 * 8;
        write_attribute_header(&mut record, file_name, 0x30, file_name_length, 24);
        record[file_name + 24..file_name + 32].copy_from_slice(&parent_id.to_le_bytes());
        record[file_name + 24 + 64] = name_units.len() as u8;
        record[file_name + 24 + 65] = 1;
        for (index, unit) in name_units.iter().enumerate() {
            let at = file_name + 24 + 66 + index * 2;
            record[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }

        // $DATA：未命名数据流，大小在属性头里
        let data = file_name + file_name_length;
        write_attribute_header(&mut record, data, 0x80, 24, 24);
        record[data + 16..data + 20].copy_from_slice(&size.to_le_bytes());

        // 属性列表结束标记
        record[data + 24..data + 28].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        record
    }

    /// 一条记录就能同时拿到名字、父目录和大小 —— 这是单遍读取的前提。
    #[test]
    fn parse_record_info_reads_name_parent_and_size() {
        let record = build_file_record("报表.log", 1024, 1234, 0);
        let info = parse_record_info(&record, 42).expect("应该能解析");

        assert_eq!(info.mft_id, 42);
        assert_eq!(info.parent_id, 1234);
        assert_eq!(info.name, "报表.log");
        assert!(!info.is_dir);
        assert_eq!(info.size, 1024);
        assert_eq!(info.modified, 1_700_000_000);
    }

    /// 重解析点（junction / 符号链接）必须被跳过，否则会把链接当成真实文件。
    #[test]
    fn reparse_point_is_skipped() {
        let record = build_file_record("link", 0, 1234, FILE_ATTRIBUTE_REPARSE_POINT_BIT);
        assert!(parse_record_info(&record, 42).is_none());
    }

    /// 头部没写 "FILE" 的（空闲记录、损坏记录）直接丢弃，不 panic。
    #[test]
    fn invalid_record_is_ignored() {
        let mut record = build_file_record("x.txt", 10, 1234, 0);
        record[0..4].copy_from_slice(b"BAAD");
        assert!(!looks_like_active_record(&record));
        record[0..4].copy_from_slice(b"FILE");
        // 抹掉"在用"标记
        record[22..24].copy_from_slice(&0u16.to_le_bytes());
        assert!(!looks_like_active_record(&record));
    }
}
