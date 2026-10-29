// ============================================================================
// 引擎选择器 — 根据运行环境和文件系统类型自动选择最佳扫描引擎
//
// 决策树：
//   is_elevated() && is_ntfs(drive) → MFT 直读（秒级全盘）
//   否则                            → jwalk 降级（传统遍历）
//
// MFT 失败时自动回退到 jwalk，确保功能始终可用
// ============================================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use log::{info, warn};

use crate::scanner::hotspot::FolderStats;

use super::mft_scanner::MftScanProgress;

/// 扫描后端类型（用于前端展示当前使用的引擎）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HotspotBackend {
    /// MFT 直读（管理员 + NTFS）
    Mft,
    /// jwalk 遍历（兜底方案）
    Walkdir,
}

impl HotspotBackend {
    /// 前端展示用标签
    pub fn label(&self) -> &'static str {
        match self {
            HotspotBackend::Mft => "MFT 直读",
            HotspotBackend::Walkdir => "常规遍历",
        }
    }
}

/// 检测当前环境应使用的后端
pub fn detect_backend(drive_letter: char) -> HotspotBackend {
    #[cfg(windows)]
    {
        let elevated = super::mft_scanner::is_elevated();
        let ntfs = super::mft_scanner::is_ntfs(drive_letter);
        info!(
            "[引擎选择] 管理员: {}, NTFS: {} → {}",
            elevated,
            ntfs,
            if elevated && ntfs {
                "MFT 直读"
            } else {
                "常规遍历"
            }
        );
        if elevated && ntfs {
            return HotspotBackend::Mft;
        }
    }
    HotspotBackend::Walkdir
}

/// 扫描指定驱动器，自动选择引擎
///
/// MFT 失败时自动降级到 jwalk，确保功能可用。
///
/// # 返回
/// - `HashMap<PathBuf, FolderStats>` — 目录全路径 → 聚合统计
/// - `HotspotBackend` — 实际使用的引擎类型
pub fn scan_full_drive(
    drive_letter: char,
    root: &Path,
    max_depth: u8,
    track_modified: bool,
    cancel_flag: &AtomicBool,
    progress_cb: impl Fn(MftScanProgress) + Sync,
) -> (HashMap<PathBuf, FolderStats>, HotspotBackend) {
    let backend = detect_backend(drive_letter);

    match backend {
        HotspotBackend::Mft => {
            info!("[引擎选择] 使用 MFT 直读引擎扫描 {}:", drive_letter);
            match super::mft_scanner::scan_via_mft(drive_letter, &progress_cb) {
                Ok(map) => {
                    info!("[引擎选择] MFT 扫描成功，{} 个目录", map.len());
                    (map, HotspotBackend::Mft)
                }
                Err(e) => {
                    warn!("[引擎选择] MFT 扫描失败，自动降级到 jwalk: {}", e);
                    let (_, map) = super::fallback_scanner::aggregate_ancestor_stats(
                        root,
                        max_depth,
                        track_modified,
                        cancel_flag,
                        true, // 降级时忽略系统目录以保持性能
                    );
                    (map, HotspotBackend::Walkdir)
                }
            }
        }
        HotspotBackend::Walkdir => {
            info!("[引擎选择] 使用 jwalk 常规遍历扫描 {}:", drive_letter);
            let (_, map) = super::fallback_scanner::aggregate_ancestor_stats(
                root,
                max_depth,
                track_modified,
                cancel_flag,
                true,
            );
            (map, HotspotBackend::Walkdir)
        }
    }
}
