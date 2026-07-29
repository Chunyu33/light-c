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
const WINDOWS_TO_UNIX_SECONDS: i64 = 11_644_473_600;
const FILE_RECORD_FLAG_IN_USE: u16 = 0x0001;
const FILE_RECORD_FLAG_DIRECTORY: u16 = 0x0002;

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
    let mut entry_by_id: HashMap<u64, &MftEntry> = HashMap::with_capacity(entries.len());
    for entry in entries {
        entry_by_id.insert(entry.mft_id, entry);
    }

    let mut paths = HashMap::with_capacity(target_ids.len() + 1);
    let root_path = format!("{}:\\", drive_letter);
    paths.insert(5, root_path);

    for target_id in target_ids {
        let mut visiting = HashSet::new();
        // 只为 TopN 候选路径做懒解析，避免全盘文件都分配完整路径字符串。
        let _ = resolve_path(*target_id, &entry_by_id, &mut paths, &mut visiting);
    }

    paths
}

fn resolve_path(
    mft_id: u64,
    entry_by_id: &HashMap<u64, &MftEntry>,
    paths: &mut HashMap<u64, String>,
    visiting: &mut HashSet<u64>,
) -> Option<String> {
    if let Some(path) = paths.get(&mft_id) {
        return Some(path.clone());
    }
    if !visiting.insert(mft_id) {
        return None;
    }

    let entry = entry_by_id.get(&mft_id)?;
    let parent_path = resolve_path(entry.parent_id, entry_by_id, paths, visiting)?;
    let mut full_path = String::with_capacity(parent_path.len() + 1 + entry.name.len());
    full_path.push_str(&parent_path);
    if !parent_path.ends_with('\\') {
        full_path.push('\\');
    }
    full_path.push_str(&entry.name);
    paths.insert(mft_id, full_path.clone());
    visiting.remove(&mft_id);
    Some(full_path)
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
                    if wanted_mft_ids.contains(&record_id) && looks_like_active_file(record_bytes) {
                        let mut record = record_bytes.to_vec();
                        if self.apply_fixup(&mut record).is_some() {
                            if let Some(metadata) = parse_active_file_record_metadata(&record) {
                                metadata_by_id.insert(record_id, metadata);
                            }
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
