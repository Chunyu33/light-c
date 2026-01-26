// ============================================================================
// Tauri 命令模块 - 前后端通信接口
// 定义所有可从前端调用的Rust命令
// ============================================================================

use crate::scanner::{ScanEngine, ScanResult, JunkCategory, DeleteResult, CategoryScanResult};
use crate::cleaner::DeleteEngine;
use log::info;
use serde::{Deserialize, Serialize};

/// 扫描请求参数
#[derive(Debug, Deserialize)]
pub struct ScanRequest {
    /// 要扫描的分类列表（可选，为空则扫描全部）
    pub categories: Option<Vec<String>>,
}

/// 删除请求参数
#[derive(Debug, Deserialize)]
pub struct DeleteRequest {
    /// 要删除的文件路径列表
    pub paths: Vec<String>,
}

/// 磁盘信息
#[derive(Debug, Serialize)]
pub struct DiskInfo {
    /// 磁盘总容量（字节）
    pub total_space: u64,
    /// 已用空间（字节）
    pub used_space: u64,
    /// 可用空间（字节）
    pub free_space: u64,
    /// 使用百分比
    pub usage_percent: f32,
    /// 磁盘盘符
    pub drive_letter: String,
}

/// 获取C盘磁盘信息
#[tauri::command]
pub fn get_disk_info() -> Result<DiskInfo, String> {
    info!("获取磁盘信息");
    
    // 使用Windows API获取磁盘信息
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

/// 执行垃圾文件扫描
#[tauri::command]
pub fn scan_junk_files(request: Option<ScanRequest>) -> Result<ScanResult, String> {
    info!("开始扫描垃圾文件");
    
    let engine = if let Some(req) = request {
        if let Some(category_names) = req.categories {
            // 根据名称筛选分类
            let categories: Vec<JunkCategory> = JunkCategory::all()
                .into_iter()
                .filter(|c| category_names.contains(&c.display_name().to_string()))
                .collect();
            
            if categories.is_empty() {
                ScanEngine::new()
            } else {
                ScanEngine::new().with_categories(categories)
            }
        } else {
            ScanEngine::new()
        }
    } else {
        ScanEngine::new()
    };

    let result = engine.scan();
    
    info!(
        "扫描完成: {} 个文件, {} 字节",
        result.total_file_count, result.total_size
    );
    
    Ok(result)
}

/// 扫描单个分类
#[tauri::command]
pub fn scan_category(category_name: String) -> Result<CategoryScanResult, String> {
    info!("扫描分类: {}", category_name);
    
    let category = JunkCategory::all()
        .into_iter()
        .find(|c| c.display_name() == category_name)
        .ok_or_else(|| format!("未知分类: {}", category_name))?;

    let engine = ScanEngine::new();
    let result = engine.scan_category(&category);
    
    Ok(result)
}

/// 删除指定文件
#[tauri::command]
pub fn delete_files(request: DeleteRequest) -> Result<DeleteResult, String> {
    info!("开始删除 {} 个文件", request.paths.len());
    
    let engine = DeleteEngine::new();
    let result = engine.delete_paths(&request.paths);
    
    info!(
        "删除完成: 成功 {}, 失败 {}, 释放 {} 字节",
        result.success_count, result.failed_count, result.freed_size
    );
    
    Ok(result)
}

/// 获取所有可用的清理分类
#[tauri::command]
pub fn get_categories() -> Vec<CategoryInfo> {
    JunkCategory::all()
        .into_iter()
        .map(|c| CategoryInfo {
            name: c.display_name().to_string(),
            description: c.description().to_string(),
            risk_level: c.risk_level(),
        })
        .collect()
}

/// 分类信息（用于前端展示）
#[derive(Debug, Serialize)]
pub struct CategoryInfo {
    /// 分类名称
    pub name: String,
    /// 分类描述
    pub description: String,
    /// 风险等级
    pub risk_level: u8,
}

/// 格式化文件大小
#[tauri::command]
pub fn format_size(bytes: u64) -> String {
    crate::scanner::format_size(bytes)
}
