// ============================================================================
// 磁盘信息命令
// ============================================================================

use log::info;
use serde::Serialize;

/// 磁盘信息
#[derive(Debug, Serialize)]
pub struct DiskInfo {
    pub total_space: u64,
    pub used_space: u64,
    pub free_space: u64,
    pub usage_percent: f32,
    pub drive_letter: String,
}

/// 本机固定分区信息，后续大文件、大目录等多盘模块也复用这份结构。
#[derive(Debug, Serialize)]
pub struct LocalDriveInfo {
    pub drive_letter: String,
    pub root_path: String,
    pub volume_name: String,
    pub file_system: String,
    pub total_space: u64,
    pub used_space: u64,
    pub free_space: u64,
    pub usage_percent: f32,
    pub is_system: bool,
    pub is_ntfs: bool,
}

/// 获取C盘磁盘信息
#[tauri::command]
pub fn get_disk_info() -> Result<DiskInfo, String> {
    info!("获取磁盘信息");

    #[cfg(target_os = "windows")]
    {
        let drive = query_drive_info('C')?;

        Ok(DiskInfo {
            total_space: drive.total_space,
            used_space: drive.used_space,
            free_space: drive.free_space,
            usage_percent: drive.usage_percent,
            drive_letter: drive.drive_letter,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 获取本机固定磁盘分区列表。
#[tauri::command]
pub fn get_local_drives() -> Result<Vec<LocalDriveInfo>, String> {
    info!("获取本机固定磁盘分区列表");

    #[cfg(target_os = "windows")]
    {
        use winapi::um::fileapi::{GetDriveTypeW, GetLogicalDrives};
        use winapi::um::winbase::DRIVE_FIXED;

        let mask = unsafe { GetLogicalDrives() };
        if mask == 0 {
            return Err("无法读取本机磁盘分区列表".to_string());
        }

        let mut drives = Vec::new();
        for index in 0..26 {
            if mask & (1 << index) == 0 {
                continue;
            }

            let letter = (b'A' + index as u8) as char;
            let root = format!("{}:\\", letter);
            let wide_root = wide_null(&root);
            let drive_type = unsafe { GetDriveTypeW(wide_root.as_ptr()) };
            if drive_type != DRIVE_FIXED {
                continue;
            }

            match query_drive_info(letter) {
                Ok(drive) => drives.push(drive),
                Err(error) => {
                    // 单个分区异常不应阻断列表展示，避免坏盘或权限问题拖垮整个设置入口。
                    log::warn!("读取磁盘 {} 信息失败: {}", root, error);
                }
            }
        }

        drives.sort_by(|left, right| left.drive_letter.cmp(&right.drive_letter));
        Ok(drives)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

#[cfg(target_os = "windows")]
fn query_drive_info(letter: char) -> Result<LocalDriveInfo, String> {
    use winapi::um::fileapi::GetDiskFreeSpaceExW;
    use winapi::um::winnt::ULARGE_INTEGER;

    let normalized_letter = letter.to_ascii_uppercase();
    if !normalized_letter.is_ascii_alphabetic() {
        return Err(format!("无效的磁盘盘符: {}", letter));
    }

    let root = format!("{}:\\", normalized_letter);
    let wide_root = wide_null(&root);
    let mut free_bytes_available: ULARGE_INTEGER = unsafe { std::mem::zeroed() };
    let mut total_bytes: ULARGE_INTEGER = unsafe { std::mem::zeroed() };
    let mut total_free_bytes: ULARGE_INTEGER = unsafe { std::mem::zeroed() };

    let result = unsafe {
        GetDiskFreeSpaceExW(
            wide_root.as_ptr(),
            &mut free_bytes_available,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };
    if result == 0 {
        return Err(format!("无法获取 {} 磁盘容量信息", root));
    }

    let (volume_name, file_system) = query_volume_labels(&wide_root);
    let total = unsafe { *total_bytes.QuadPart() };
    let free = unsafe { *total_free_bytes.QuadPart() };
    let used = total.saturating_sub(free);
    let usage_percent = if total > 0 {
        (used as f64 / total as f64 * 100.0) as f32
    } else {
        0.0
    };
    let drive_letter = format!("{}:", normalized_letter);
    let system_drive = std::env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".to_string())
        .trim_end_matches('\\')
        .to_ascii_uppercase();

    Ok(LocalDriveInfo {
        drive_letter: drive_letter.clone(),
        root_path: root,
        volume_name,
        is_ntfs: file_system.eq_ignore_ascii_case("NTFS"),
        file_system,
        total_space: total,
        used_space: used,
        free_space: free,
        usage_percent,
        is_system: drive_letter == system_drive,
    })
}

#[cfg(target_os = "windows")]
fn query_volume_labels(root: &[u16]) -> (String, String) {
    use winapi::um::fileapi::GetVolumeInformationW;

    let mut volume_name = vec![0u16; 260];
    let mut file_system = vec![0u16; 64];
    let ok = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            volume_name.as_mut_ptr(),
            volume_name.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            file_system.as_mut_ptr(),
            file_system.len() as u32,
        )
    };

    if ok == 0 {
        return (String::new(), String::new());
    }

    (
        utf16_buffer_to_string(&volume_name),
        utf16_buffer_to_string(&file_system),
    )
}

#[cfg(target_os = "windows")]
fn utf16_buffer_to_string(buffer: &[u16]) -> String {
    let len = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}
