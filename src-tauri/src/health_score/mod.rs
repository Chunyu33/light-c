// ============================================================================
// 系统健康评分模块
// 根据磁盘空间、休眠文件、垃圾文件三维度计算 C 盘健康评分
// ============================================================================

use log::info;
use serde::Serialize;

/// 系统健康评分结果
#[derive(Debug, Clone, Serialize)]
pub struct HealthScoreResult {
    /// 总分 (0-100)
    pub score: u32,
    /// C盘剩余空间评分 (0-40)
    pub disk_score: u32,
    /// 休眠文件评分 (0-30)
    pub hibernation_score: u32,
    /// 垃圾文件评分 (0-30)
    pub junk_score: u32,
    /// C盘剩余百分比
    pub disk_free_percent: f64,
    /// 是否存在休眠文件
    pub has_hibernation: bool,
    /// 休眠文件大小
    pub hibernation_size: u64,
    /// 预估垃圾文件大小
    pub junk_size: u64,
}

/// 计算系统健康评分
///
/// 评分算法：
/// - C盘剩余百分比 (40%权重)：剩余空间越多分数越高
/// - 休眠文件 (30%权重)：无休眠文件得满分，有则根据大小扣分
/// - 垃圾文件 (30%权重)：垃圾越少分数越高
pub fn calculate() -> HealthScoreResult {
    info!("计算系统健康评分...");

    let (disk_free_percent, disk_score) = calculate_disk_score();
    let (has_hibernation, hibernation_size, hibernation_score) = calculate_hibernation_score();
    let (junk_size, junk_score) = calculate_junk_score();

    let score = disk_score + hibernation_score + junk_score;

    info!(
        "健康评分: {} (磁盘:{}, 休眠:{}, 垃圾:{})",
        score, disk_score, hibernation_score, junk_score
    );

    HealthScoreResult {
        score,
        disk_score,
        hibernation_score,
        junk_score,
        disk_free_percent,
        has_hibernation,
        hibernation_size,
        junk_size,
    }
}

/// 计算磁盘空间评分 (满分40)
fn calculate_disk_score() -> (f64, u32) {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }

        let path: Vec<u16> = OsStr::new("C:\\")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut free_bytes: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut _total_free: u64 = 0;

        let success = unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut free_bytes,
                &mut total_bytes,
                &mut _total_free,
            )
        };

        if success != 0 && total_bytes > 0 {
            let free_percent = (free_bytes as f64 / total_bytes as f64) * 100.0;
            let score = if free_percent >= 30.0 {
                40
            } else if free_percent >= 20.0 {
                30 + ((free_percent - 20.0) / 10.0 * 10.0) as u32
            } else if free_percent >= 10.0 {
                20 + ((free_percent - 10.0) / 10.0 * 10.0) as u32
            } else if free_percent >= 5.0 {
                10 + ((free_percent - 5.0) / 5.0 * 10.0) as u32
            } else {
                (free_percent / 5.0 * 10.0) as u32
            };
            return (free_percent, score.min(40));
        }
    }

    (50.0, 20) // 非 Windows 或调用失败时的默认值
}

/// 计算休眠文件评分 (满分30)
fn calculate_hibernation_score() -> (bool, u64, u32) {
    let hiberfil_path = std::path::Path::new("C:\\hiberfil.sys");

    if hiberfil_path.exists() {
        let size = std::fs::metadata(hiberfil_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let score = if size < 4 * 1024 * 1024 * 1024 {
            20
        } else if size < 8 * 1024 * 1024 * 1024 {
            15
        } else if size < 16 * 1024 * 1024 * 1024 {
            10
        } else {
            5
        };

        (true, size, score)
    } else {
        (false, 0, 30)
    }
}

/// 计算垃圾文件评分 (满分30)
fn calculate_junk_score() -> (u64, u32) {
    let mut total_junk_size: u64 = 0;

    let junk_paths = [
        std::env::var("TEMP").unwrap_or_default(),
        std::env::var("TMP").unwrap_or_default(),
        format!(
            "{}\\AppData\\Local\\Temp",
            std::env::var("USERPROFILE").unwrap_or_default()
        ),
        "C:\\Windows\\Temp".to_string(),
        "C:\\Windows\\Prefetch".to_string(),
    ];

    for path_str in &junk_paths {
        if path_str.is_empty() {
            continue;
        }
        let path = std::path::Path::new(path_str);
        if path.exists() && path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    if let Ok(metadata) = entry.metadata() {
                        if metadata.is_file() {
                            total_junk_size += metadata.len();
                        }
                    }
                }
            }
        }
    }

    // 回收站简化估算
    if std::path::Path::new("C:\\$Recycle.Bin").exists() {
        total_junk_size += 100 * 1024 * 1024;
    }

    let score = if total_junk_size < 500 * 1024 * 1024 {
        30
    } else if total_junk_size < 1024 * 1024 * 1024 {
        25
    } else if total_junk_size < 2 * 1024 * 1024 * 1024 {
        20
    } else if total_junk_size < 5 * 1024 * 1024 * 1024 {
        15
    } else if total_junk_size < 10 * 1024 * 1024 * 1024 {
        10
    } else {
        5
    };

    (total_junk_size, score)
}
