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

/// 获取C盘磁盘信息
#[tauri::command]
pub fn get_disk_info() -> Result<DiskInfo, String> {
    info!("获取磁盘信息");

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::fileapi::GetDiskFreeSpaceExW;
        use winapi::um::winnt::ULARGE_INTEGER;

        let path: Vec<u16> = OsStr::new("C:\\")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut free_bytes_available: ULARGE_INTEGER = unsafe { std::mem::zeroed() };
        let mut total_bytes: ULARGE_INTEGER = unsafe { std::mem::zeroed() };
        let mut total_free_bytes: ULARGE_INTEGER = unsafe { std::mem::zeroed() };

        let result = unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut free_bytes_available,
                &mut total_bytes,
                &mut total_free_bytes,
            )
        };

        if result == 0 {
            return Err("无法获取磁盘信息".to_string());
        }

        let total = unsafe { *total_bytes.QuadPart() };
        let free = unsafe { *total_free_bytes.QuadPart() };
        let used = total - free;
        let usage_percent = (used as f64 / total as f64 * 100.0) as f32;

        Ok(DiskInfo {
            total_space: total,
            used_space: used,
            free_space: free,
            usage_percent,
            drive_letter: "C:".to_string(),
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}
