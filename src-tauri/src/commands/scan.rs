// ============================================================================
// 垃圾扫描与大文件扫描命令
// ============================================================================

use crate::scanner::{
    big_files, deep_junk, CategoryScanResult, JunkCategory, ScanEngine, ScanResult,
};
use log::info;
use serde::{Deserialize, Serialize};
use tauri::Window;

/// 扫描请求参数
#[derive(Debug, Deserialize)]
pub struct ScanRequest {
    pub categories: Option<Vec<String>>,
}

/// 分类信息（用于前端展示）
#[derive(Debug, Serialize)]
pub struct CategoryInfo {
    pub name: String,
    pub description: String,
    pub risk_level: u8,
}

/// 执行垃圾文件扫描
#[tauri::command]
pub async fn scan_junk_files(request: Option<ScanRequest>) -> Result<ScanResult, String> {
    info!("开始扫描垃圾文件");

    let result = tokio::task::spawn_blocking(move || {
        let engine = if let Some(req) = request {
            if let Some(category_names) = req.categories {
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

        engine.scan()
    })
    .await
    .map_err(|e| format!("扫描任务异常: {}", e))?;

    info!(
        "扫描完成: {} 个文件, {} 字节",
        result.total_file_count, result.total_size
    );

    Ok(result)
}

/// 执行所有固定分区的深度垃圾扫描，NTFS 优先使用 MFT。
#[tauri::command]
pub async fn scan_deep_junk_files(window: Window) -> Result<deep_junk::DeepJunkScanResult, String> {
    info!("开始深度扫描垃圾文件");
    deep_junk::reset_cancelled();

    let result = tokio::task::spawn_blocking(move || deep_junk::scan_all(&window))
        .await
        .map_err(|error| format!("深度扫描任务异常: {}", error))??;

    deep_junk::create_session(result)
}

/// 获取深度扫描分类的分页文件。
#[tauri::command]
pub fn get_deep_junk_category_page(
    scan_id: String,
    category_name: String,
    offset: usize,
    limit: Option<usize>,
) -> Result<CategoryScanResult, String> {
    deep_junk::get_category_page(&scan_id, &category_name, offset, limit.unwrap_or(500))
}

/// 取消正在执行的深度垃圾扫描。
#[tauri::command]
pub fn cancel_deep_junk_scan() {
    info!("收到取消深度垃圾扫描请求");
    deep_junk::cancel();
}

/// 扫描单个分类
#[tauri::command]
pub async fn scan_category(category_name: String) -> Result<CategoryScanResult, String> {
    info!("扫描分类: {}", category_name);

    let result = tokio::task::spawn_blocking(move || -> Result<CategoryScanResult, String> {
        let category = JunkCategory::all()
            .into_iter()
            .find(|c| c.display_name() == category_name)
            .ok_or_else(|| format!("未知分类: {}", category_name))?;

        let engine = ScanEngine::new();
        Ok(engine.scan_category(&category))
    })
    .await
    .map_err(|e| format!("扫描任务异常: {}", e))??;

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

/// 扫描系统盘大文件，并实时推送进度
#[tauri::command]
pub async fn scan_large_files(
    window: Window,
    top_n: Option<usize>,
    drive_letter: Option<String>,
) -> Result<Vec<big_files::LargeFileEntry>, String> {
    big_files::reset_cancelled();
    let window = window.clone();
    // 大文件列表会直接渲染到前端，命令层收敛数量，避免异常配置造成界面和扫描压力失控。
    let top_n = top_n.unwrap_or(50).clamp(10, 500);
    let drive_letter = normalize_large_file_drive_letter(drive_letter.as_deref())?;
    tokio::task::spawn_blocking(move || big_files::scan(&window, top_n, drive_letter))
        .await
        .map_err(|e| format!("扫描任务异常: {}", e))?
}

/// 取消大文件扫描
#[tauri::command]
pub fn cancel_large_file_scan() {
    big_files::cancel();
}

fn normalize_large_file_drive_letter(value: Option<&str>) -> Result<char, String> {
    // 前端只传盘符，但这里仍做兜底校验，避免手动调用命令时传入路径或特殊字符。
    let raw = value
        .and_then(|text| text.chars().find(|ch| ch.is_ascii_alphabetic()))
        .unwrap_or_else(|| {
            std::env::var("SYSTEMDRIVE")
                .ok()
                .and_then(|drive| drive.chars().find(|ch| ch.is_ascii_alphabetic()))
                .unwrap_or('C')
        })
        .to_ascii_uppercase();

    let root = format!("{}:\\", raw);
    if !std::path::Path::new(&root).is_dir() {
        return Err(format!("磁盘不存在或不可访问: {}", root));
    }

    Ok(raw)
}
