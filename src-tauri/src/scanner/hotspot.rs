// ============================================================================
// C盘热点扫描模块
// 扫描 AppData 目录下的大文件夹，按空间占用排序
// ============================================================================

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

/// 热点文件夹信息
/// 记录单个文件夹的空间占用和最后修改时间
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotspotEntry {
    /// 文件夹完整路径
    pub path: String,
    /// 文件夹名称
    pub name: String,
    /// 总大小（字节）- 包含所有子文件
    pub total_size: u64,
    /// 文件数量
    pub file_count: usize,
    /// 最后修改时间（Unix 时间戳，毫秒）
    /// 取该目录下所有文件中最晚的修改时间
    pub last_modified: i64,
    /// 父目录类型（Local/Roaming/LocalLow）
    pub parent_type: String,
}

/// 热点扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotspotScanResult {
    /// 热点文件夹列表（已按大小降序排列）
    pub entries: Vec<HotspotEntry>,
    /// 扫描的总文件夹数
    pub total_folders_scanned: usize,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
    /// AppData 总大小
    pub appdata_total_size: u64,
}

/// 热点扫描引擎
pub struct HotspotScanner;

impl HotspotScanner {
    /// 执行热点扫描
    /// 扫描 C:\Users\{UserName}\AppData 下的一级子目录
    /// 返回按空间大小降序排列的 Top N 结果
    pub fn scan(top_n: usize) -> Result<HotspotScanResult, String> {
        let start_time = std::time::Instant::now();
        
        // 获取 AppData 路径
        let appdata_path = Self::get_appdata_path()?;
        
        let mut all_entries: Vec<HotspotEntry> = Vec::new();
        let mut total_folders_scanned = 0;
        let mut appdata_total_size: u64 = 0;
        
        // 扫描三个主要目录：Local, Roaming, LocalLow
        let subdirs = ["Local", "Roaming", "LocalLow"];
        
        for subdir in &subdirs {
            let target_path = appdata_path.join(subdir);
            if !target_path.exists() {
                continue;
            }
            
            // 遍历该目录下的一级子文件夹
            // 使用 read_dir 而非 WalkDir，只获取直接子目录
            match std::fs::read_dir(&target_path) {
                Ok(entries) => {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        
                        // 只处理目录
                        if !path.is_dir() {
                            continue;
                        }
                        
                        // 跳过系统保护目录
                        if Self::should_skip_folder(&path) {
                            continue;
                        }
                        
                        total_folders_scanned += 1;
                        
                        // 计算文件夹统计信息
                        if let Some(stats) = Self::calculate_folder_stats(&path) {
                            appdata_total_size += stats.total_size;
                            
                            let folder_name = path.file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default();
                            
                            all_entries.push(HotspotEntry {
                                path: path.to_string_lossy().to_string(),
                                name: folder_name,
                                total_size: stats.total_size,
                                file_count: stats.file_count,
                                last_modified: stats.last_modified,
                                parent_type: subdir.to_string(),
                            });
                        }
                    }
                }
                Err(_) => {
                    // 静默跳过无法访问的目录
                    continue;
                }
            }
        }
        
        // 按大小降序排列
        all_entries.sort_by(|a, b| b.total_size.cmp(&a.total_size));
        
        // 取 Top N
        let entries: Vec<HotspotEntry> = all_entries.into_iter().take(top_n).collect();
        
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;
        
        Ok(HotspotScanResult {
            entries,
            total_folders_scanned,
            scan_duration_ms,
            appdata_total_size,
        })
    }
    
    /// 获取 AppData 路径
    /// 返回 C:\Users\{UserName}\AppData
    fn get_appdata_path() -> Result<PathBuf, String> {
        // 优先使用 APPDATA 环境变量获取 Roaming 路径，然后回退到父目录
        if let Ok(roaming) = std::env::var("APPDATA") {
            let roaming_path = PathBuf::from(&roaming);
            if let Some(parent) = roaming_path.parent() {
                return Ok(parent.to_path_buf());
            }
        }
        
        // 备用方案：使用 LOCALAPPDATA
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local_path = PathBuf::from(&local);
            if let Some(parent) = local_path.parent() {
                return Ok(parent.to_path_buf());
            }
        }
        
        Err("无法获取 AppData 路径".to_string())
    }
    
    /// 判断是否应该跳过该文件夹
    /// 跳过系统保护目录和特殊目录
    fn should_skip_folder(path: &Path) -> bool {
        let folder_name = path.file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        
        // 跳过的系统目录列表
        let skip_folders = [
            "microsoft",           // Windows 核心组件
            "windows",             // Windows 系统文件
            "packages",            // UWP 应用包
            "connecteddevicesplatform",
            "comms",
            "history",
            "inetcache",           // IE 缓存（系统保护）
            "inetcookies",
            "systemcertificates",
        ];
        
        skip_folders.contains(&folder_name.as_str())
    }
    
    /// 计算文件夹的统计信息
    /// 返回总大小、文件数量和最后修改时间
    fn calculate_folder_stats(path: &Path) -> Option<FolderStats> {
        let mut total_size: u64 = 0;
        let mut file_count: usize = 0;
        let mut last_modified: i64 = 0;
        
        // 使用 WalkDir 递归遍历，设置跟随符号链接为 false
        // 并限制最大深度以提高性能
        let walker = WalkDir::new(path)
            .follow_links(false)
            .max_depth(10)  // 限制递归深度，避免过深的目录结构
            .into_iter()
            .filter_entry(|e| {
                // 过滤掉隐藏的系统文件夹
                !Self::is_hidden_system_entry(e)
            });
        
        for entry in walker {
            match entry {
                Ok(e) => {
                    // 只统计文件，不统计目录本身
                    if e.file_type().is_file() {
                        // 获取文件元数据
                        if let Ok(metadata) = e.metadata() {
                            total_size += metadata.len();
                            file_count += 1;
                            
                            // 获取修改时间
                            if let Ok(modified) = metadata.modified() {
                                let timestamp = Self::system_time_to_millis(modified);
                                if timestamp > last_modified {
                                    last_modified = timestamp;
                                }
                            }
                        }
                    }
                }
                Err(_) => {
                    // 静默跳过无法访问的文件
                    continue;
                }
            }
        }
        
        // 如果文件夹为空或无法访问，返回 None
        if file_count == 0 && total_size == 0 {
            return None;
        }
        
        Some(FolderStats {
            total_size,
            file_count,
            last_modified,
        })
    }
    
    /// 判断是否为隐藏的系统条目
    fn is_hidden_system_entry(entry: &walkdir::DirEntry) -> bool {
        // 检查文件名是否以 . 开头（Unix 风格隐藏文件）
        if let Some(name) = entry.file_name().to_str() {
            if name.starts_with('.') && name != "." && name != ".." {
                return true;
            }
        }
        
        // 在 Windows 上检查隐藏属性
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if let Ok(metadata) = entry.metadata() {
                const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
                const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
                let attrs = metadata.file_attributes();
                // 同时具有隐藏和系统属性的文件跳过
                if (attrs & FILE_ATTRIBUTE_HIDDEN != 0) && (attrs & FILE_ATTRIBUTE_SYSTEM != 0) {
                    return true;
                }
            }
        }
        
        false
    }
    
    /// 将 SystemTime 转换为 Unix 时间戳（毫秒）
    fn system_time_to_millis(time: SystemTime) -> i64 {
        match time.duration_since(SystemTime::UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i64,
            Err(_) => 0,
        }
    }
}

/// 文件夹统计信息（内部使用）
struct FolderStats {
    total_size: u64,
    file_count: usize,
    last_modified: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_get_appdata_path() {
        let result = HotspotScanner::get_appdata_path();
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.exists());
    }
    
    #[test]
    fn test_scan_hotspot() {
        let result = HotspotScanner::scan(10);
        assert!(result.is_ok());
        let scan_result = result.unwrap();
        assert!(scan_result.entries.len() <= 10);
    }
}
