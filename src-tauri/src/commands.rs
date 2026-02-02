// ============================================================================
// Tauri 命令模块 - 前后端通信接口
// 定义所有可从前端调用的Rust命令
// ============================================================================

use crate::scanner::{ScanEngine, ScanResult, JunkCategory, DeleteResult, CategoryScanResult};
use crate::cleaner::DeleteEngine;
use log::info;
use serde::{Deserialize, Serialize};
use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::path::PathBuf;
use tauri::{Emitter, Window};
use walkdir::WalkDir;

/// 扫描请求参数
#[derive(Debug, Deserialize)]
pub struct ScanRequest {
    /// 要扫描的分类列表（可选，为空则扫描全部）
    pub categories: Option<Vec<String>>,
}

/// 大文件扫描结果
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct LargeFileEntry {
    /// 文件路径
    pub path: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 最后修改时间（Unix 时间戳，秒）
    pub modified: i64,
}

impl Ord for LargeFileEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.size
            .cmp(&other.size)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for LargeFileEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
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

/// 扫描C盘大文件（前 50 项），并实时推送当前路径
#[tauri::command]
pub async fn scan_large_files(window: Window) -> Result<Vec<LargeFileEntry>, String> {
    let window = window.clone();
    tokio::task::spawn_blocking(move || scan_large_files_impl(&window))
        .await
        .map_err(|e| format!("扫描任务异常: {}", e))?
}

fn scan_large_files_impl(window: &Window) -> Result<Vec<LargeFileEntry>, String> {
    #[cfg(target_os = "windows")]
    {
        use std::time::Instant;
        
        info!("开始扫描C盘大文件");
        let mut heap: BinaryHeap<Reverse<LargeFileEntry>> = BinaryHeap::new();
        let mut file_count: u64 = 0;
        let mut last_emit = Instant::now();

        for entry in WalkDir::new("C:\\")
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path().to_path_buf();
            let path_str = path.to_string_lossy().to_string();

            if let Ok(metadata) = entry.metadata() {
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                file_count += 1;
                
                // 限制事件发送频率：每 200ms 或每 1000 个文件发送一次
                if last_emit.elapsed().as_millis() >= 200 || file_count % 1000 == 0 {
                    let _ = window.emit("large-file-scan:progress", &path_str);
                    last_emit = Instant::now();
                }

                heap.push(Reverse(LargeFileEntry {
                    path: path_str,
                    size,
                    modified,
                }));

                if heap.len() > 50 {
                    heap.pop();
                }
            }
        }

        let mut results: Vec<LargeFileEntry> = heap.into_iter().map(|item| item.0).collect();
        results.sort_by(|a, b| b.size.cmp(&a.size));

        info!("大文件扫描完成，共扫描 {} 个文件，返回 {} 项", file_count, results.len());
        Ok(results)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 执行垃圾文件扫描（异步执行，避免阻塞 UI）
#[tauri::command]
pub async fn scan_junk_files(request: Option<ScanRequest>) -> Result<ScanResult, String> {
    info!("开始扫描垃圾文件");
    
    // 使用 spawn_blocking 在后台线程执行扫描操作
    let result = tokio::task::spawn_blocking(move || {
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

/// 扫描单个分类（异步执行）
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

/// 删除指定文件（异步执行，避免阻塞 UI）
#[tauri::command]
pub async fn delete_files(request: DeleteRequest) -> Result<DeleteResult, String> {
    info!("开始删除 {} 个文件", request.paths.len());
    
    // 使用 spawn_blocking 在后台线程执行删除操作
    let result = tokio::task::spawn_blocking(move || {
        let engine = DeleteEngine::new();
        engine.delete_paths(&request.paths)
    })
    .await
    .map_err(|e| format!("删除任务异常: {}", e))?;
    
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

/// 打开Windows磁盘清理工具
#[tauri::command]
pub fn open_disk_cleanup() -> Result<(), String> {
    info!("打开Windows磁盘清理工具");
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        
        Command::new("cleanmgr")
            .arg("/d")
            .arg("C")
            .spawn()
            .map_err(|e| format!("无法启动磁盘清理工具: {}", e))?;
        
        Ok(())
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 在文件资源管理器中打开文件所在目录
#[tauri::command]
pub fn open_in_folder(path: String) -> Result<(), String> {
    info!("打开文件所在目录: {}", path);
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        
        // 使用 explorer /select, 命令打开并选中文件
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("无法打开文件夹: {}", e))?;
        
        Ok(())
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 直接打开文件（使用系统默认程序）
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    info!("打开文件: {}", path);
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        
        // 使用 start 命令打开文件
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("无法打开文件: {}", e))?;
        
        Ok(())
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

// ============================================================================
// 社交软件专清相关
// ============================================================================

/// 社交软件分类
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialCategory {
    /// 分类ID
    pub id: String,
    /// 分类名称
    pub name: String,
    /// 分类描述
    pub description: String,
    /// 文件数量
    pub file_count: usize,
    /// 总大小（字节）
    pub total_size: u64,
    /// 文件列表
    pub files: Vec<SocialFile>,
}

/// 社交软件文件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialFile {
    /// 文件路径
    pub path: String,
    /// 文件大小
    pub size: u64,
    /// 所属应用
    pub app_name: String,
}

/// 社交软件扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialScanResult {
    /// 分类列表
    pub categories: Vec<SocialCategory>,
    /// 总文件数
    pub total_files: usize,
    /// 总大小
    pub total_size: u64,
}

/// 扫描社交软件缓存（异步执行）
#[tauri::command]
pub async fn scan_social_cache() -> Result<SocialScanResult, String> {
    info!("开始扫描社交软件缓存");
    
    let result = tokio::task::spawn_blocking(|| -> Result<SocialScanResult, String> {
        let mut categories = vec![
            SocialCategory {
                id: "images_videos".to_string(),
                name: "图片视频".to_string(),
                description: "聊天中收发的图片和视频文件".to_string(),
                file_count: 0,
                total_size: 0,
                files: Vec::new(),
            },
            SocialCategory {
                id: "file_transfer".to_string(),
                name: "文件传输".to_string(),
                description: "通过聊天传输的各类文件".to_string(),
                file_count: 0,
                total_size: 0,
                files: Vec::new(),
            },
            SocialCategory {
                id: "moments_cache".to_string(),
                name: "朋友圈/动态缓存".to_string(),
                description: "朋友圈、空间动态等缓存数据".to_string(),
                file_count: 0,
                total_size: 0,
                files: Vec::new(),
            },
        ];

        // 获取用户目录和文档目录
        let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());
        
        // 获取真实的文档目录（可能在 D 盘等非系统盘）
        let documents_dir = dirs::document_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}\\Documents", user_profile));
        
        info!("用户目录: {}, 文档目录: {}", user_profile, documents_dir);
        
        // 社交软件路径配置 (app_name, path_pattern, category_id)
        // 同时支持文档目录和用户目录下的 Documents，因为有些系统配置不同
        let mut social_paths: Vec<(&str, String, &str)> = vec![
            // 微信 - 文档目录
            ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Image", documents_dir), "images_videos"),
            ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Video", documents_dir), "images_videos"),
            ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\File", documents_dir), "file_transfer"),
            ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Sns", documents_dir), "moments_cache"),
            ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Cache", documents_dir), "moments_cache"),
            // QQ - 文档目录
            ("QQ", format!("{}\\Tencent Files\\*\\Image", documents_dir), "images_videos"),
            ("QQ", format!("{}\\Tencent Files\\*\\Video", documents_dir), "images_videos"),
            ("QQ", format!("{}\\Tencent Files\\*\\FileRecv", documents_dir), "file_transfer"),
            ("QQ", format!("{}\\AppData\\Roaming\\Tencent\\QQ\\Temp", user_profile), "moments_cache"),
            // 钉钉
            ("钉钉", format!("{}\\AppData\\Roaming\\DingTalk\\*\\Image", user_profile), "images_videos"),
            ("钉钉", format!("{}\\AppData\\Roaming\\DingTalk\\*\\Video", user_profile), "images_videos"),
            ("钉钉", format!("{}\\AppData\\Roaming\\DingTalk\\*\\File", user_profile), "file_transfer"),
            ("钉钉", format!("{}\\DingTalk", documents_dir), "file_transfer"),
            ("钉钉", format!("{}\\AppData\\Roaming\\DingTalk\\*\\Cache", user_profile), "moments_cache"),
            // 飞书
            ("飞书", format!("{}\\AppData\\Roaming\\feishu\\*\\Image", user_profile), "images_videos"),
            ("飞书", format!("{}\\AppData\\Roaming\\feishu\\*\\File", user_profile), "file_transfer"),
            ("飞书", format!("{}\\Feishu", documents_dir), "file_transfer"),
            ("飞书", format!("{}\\AppData\\Roaming\\feishu\\*\\Cache", user_profile), "moments_cache"),
            // 企业微信
            ("企业微信", format!("{}\\WXWork\\*\\Cache\\Image", documents_dir), "images_videos"),
            ("企业微信", format!("{}\\WXWork\\*\\Cache\\Video", documents_dir), "images_videos"),
            ("企业微信", format!("{}\\WXWork\\*\\Cache\\File", documents_dir), "file_transfer"),
        ];
        
        // 如果文档目录不是默认的 Documents，也添加默认路径作为备选
        let default_documents = format!("{}\\Documents", user_profile);
        if documents_dir != default_documents {
            social_paths.extend(vec![
                // 微信 - 默认 Documents 目录
                ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Image", default_documents), "images_videos"),
                ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Video", default_documents), "images_videos"),
                ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\File", default_documents), "file_transfer"),
                ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Sns", default_documents), "moments_cache"),
                ("微信", format!("{}\\WeChat Files\\*\\FileStorage\\Cache", default_documents), "moments_cache"),
                // QQ - 默认 Documents 目录
                ("QQ", format!("{}\\Tencent Files\\*\\Image", default_documents), "images_videos"),
                ("QQ", format!("{}\\Tencent Files\\*\\Video", default_documents), "images_videos"),
                ("QQ", format!("{}\\Tencent Files\\*\\FileRecv", default_documents), "file_transfer"),
            ]);
        }

        // 图片视频扩展名
        let image_video_exts = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "mp4", "avi", "mov", "wmv", "flv", "mkv", "dat"];
        
        for (app_name, path_pattern, category_id) in &social_paths {
            info!("检查路径模式: {} ({})", path_pattern, app_name);
            
            if path_pattern.contains("*") {
                // 处理通配符路径：找到通配符所在的父目录
                // 例如: C:\Users\xxx\Documents\WeChat Files\*\FileStorage\Image
                // 需要遍历 WeChat Files 下的所有子目录
                let parts: Vec<&str> = path_pattern.split('*').collect();
                if parts.len() >= 2 {
                    let parent_dir = parts[0].trim_end_matches('\\');
                    let suffix = parts[1].trim_start_matches('\\');
                    
                    info!("  父目录: {}, 后缀: {}", parent_dir, suffix);
                    
                    let parent_path = std::path::Path::new(parent_dir);
                    if parent_path.exists() {
                        info!("  父目录存在，开始遍历子目录");
                        if let Ok(entries) = std::fs::read_dir(parent_path) {
                            for entry in entries.filter_map(|e| e.ok()) {
                                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                                    let full_path = entry.path().join(suffix);
                                    info!("    检查完整路径: {:?}, 存在: {}", full_path, full_path.exists());
                                    if full_path.exists() {
                                        scan_directory_for_social(
                                            &full_path,
                                            app_name,
                                            category_id,
                                            &mut categories,
                                            &image_video_exts,
                                        );
                                    }
                                }
                            }
                        }
                    } else {
                        info!("  父目录不存在: {}", parent_dir);
                    }
                }
            } else {
                // 非通配符路径，直接扫描
                let direct_path = PathBuf::from(path_pattern);
                info!("  直接路径: {:?}, 存在: {}", direct_path, direct_path.exists());
                if direct_path.exists() {
                    scan_directory_for_social(
                        &direct_path,
                        app_name,
                        category_id,
                        &mut categories,
                        &image_video_exts,
                    );
                }
            }
        }

        let total_files: usize = categories.iter().map(|c| c.file_count).sum();
        let total_size: u64 = categories.iter().map(|c| c.total_size).sum();

        Ok(SocialScanResult {
            categories,
            total_files,
            total_size,
        })
    })
    .await
    .map_err(|e| format!("扫描任务异常: {}", e))??;

    info!(
        "社交软件扫描完成: {} 个文件, {} 字节",
        result.total_files, result.total_size
    );

    Ok(result)
}

/// 扫描目录并归类到社交分类
fn scan_directory_for_social(
    path: &PathBuf,
    app_name: &str,
    category_id: &str,
    categories: &mut Vec<SocialCategory>,
    image_video_exts: &[&str],
) {
    for entry in WalkDir::new(path)
        .follow_links(false)
        .max_depth(5)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        if let Ok(metadata) = entry.metadata() {
            let file_path = entry.path().to_string_lossy().to_string();
            let size = metadata.len();
            
            // 根据分类ID和文件扩展名决定归类
            let ext = entry.path()
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            
            let target_category = if category_id == "images_videos" {
                // 图片视频分类只收集对应扩展名的文件
                if image_video_exts.contains(&ext.as_str()) {
                    Some("images_videos")
                } else {
                    None
                }
            } else {
                Some(category_id)
            };

            if let Some(cat_id) = target_category {
                if let Some(category) = categories.iter_mut().find(|c| c.id == cat_id) {
                    category.files.push(SocialFile {
                        path: file_path,
                        size,
                        app_name: app_name.to_string(),
                    });
                    category.file_count += 1;
                    category.total_size += size;
                }
            }
        }
    }
}

// ============================================================================
// 系统瘦身相关
// ============================================================================

/// 系统瘦身项状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlimItemStatus {
    /// 项目ID
    pub id: String,
    /// 项目名称
    pub name: String,
    /// 项目描述
    pub description: String,
    /// 风险提示
    pub warning: String,
    /// 是否启用/存在
    pub enabled: bool,
    /// 占用空间（字节）
    pub size: u64,
    /// 是否可操作
    pub actionable: bool,
    /// 操作按钮文本
    pub action_text: String,
}

/// 系统瘦身状态汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSlimStatus {
    /// 是否以管理员权限运行
    pub is_admin: bool,
    /// 各瘦身项状态
    pub items: Vec<SlimItemStatus>,
    /// 总可释放空间
    pub total_reclaimable: u64,
}

/// 检查是否以管理员权限运行
#[tauri::command]
pub fn check_admin_privilege() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        // 尝试执行需要管理员权限的命令来检测
        let output = Command::new("net")
            .args(["session"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
        
        match output {
            Ok(o) => o.status.success(),
            Err(_) => false,
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 获取系统瘦身状态
#[tauri::command]
pub fn get_system_slim_status() -> SystemSlimStatus {
    let is_admin = check_admin_privilege();
    let mut items = Vec::new();
    let mut total_reclaimable: u64 = 0;
    
    // 1. 休眠文件检测
    let hibernation = get_hibernation_status();
    if hibernation.enabled {
        total_reclaimable += hibernation.size;
    }
    items.push(hibernation);
    
    // 2. WinSxS 组件存储（估算可清理空间）
    let winsxs = get_winsxs_status();
    total_reclaimable += winsxs.size;
    items.push(winsxs);
    
    // 3. 虚拟内存检测
    let pagefile = get_pagefile_status();
    items.push(pagefile);
    
    SystemSlimStatus {
        is_admin,
        items,
        total_reclaimable,
    }
}

/// 获取休眠文件状态
fn get_hibernation_status() -> SlimItemStatus {
    let hiberfil_path = std::path::Path::new("C:\\hiberfil.sys");
    let exists = hiberfil_path.exists();
    let size = if exists {
        std::fs::metadata(hiberfil_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    
    SlimItemStatus {
        id: "hibernation".to_string(),
        name: "休眠文件".to_string(),
        description: "Windows 休眠功能会在 C 盘创建与内存大小相当的 hiberfil.sys 文件".to_string(),
        warning: "关闭休眠将导致快速启动功能失效，电脑无法进入休眠状态".to_string(),
        enabled: exists,
        size,
        actionable: exists,
        action_text: if exists { "关闭休眠".to_string() } else { "已关闭".to_string() },
    }
}

/// 获取 WinSxS 组件存储状态
fn get_winsxs_status() -> SlimItemStatus {
    // WinSxS 目录大小估算（实际清理效果取决于系统状态）
    let winsxs_path = std::path::Path::new("C:\\Windows\\WinSxS");
    let estimated_reclaimable: u64 = if winsxs_path.exists() {
        // 估算可清理空间为 1-3GB（保守估计）
        2 * 1024 * 1024 * 1024 // 2GB
    } else {
        0
    };
    
    SlimItemStatus {
        id: "winsxs".to_string(),
        name: "系统组件存储".to_string(),
        description: "Windows 组件存储 (WinSxS) 包含系统更新的旧版本文件，可安全清理冗余部分".to_string(),
        warning: "清理过程可能需要 5-15 分钟，期间请勿关闭程序或电脑".to_string(),
        enabled: true,
        size: estimated_reclaimable,
        actionable: true,
        action_text: "开始清理".to_string(),
    }
}

/// 获取虚拟内存状态
fn get_pagefile_status() -> SlimItemStatus {
    let pagefile_path = std::path::Path::new("C:\\pagefile.sys");
    let exists = pagefile_path.exists();
    let size = if exists {
        std::fs::metadata(pagefile_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    
    // 读取注册表获取分页文件配置
    let pagefile_location = get_pagefile_registry_info();
    let is_on_c_drive = pagefile_location.contains("C:") || pagefile_location.contains("c:");
    
    SlimItemStatus {
        id: "pagefile".to_string(),
        name: "虚拟内存".to_string(),
        description: format!("当前分页文件位置: {}。建议将虚拟内存迁移到非系统盘以释放 C 盘空间", pagefile_location),
        warning: "虚拟内存对系统稳定性至关重要，不建议直接删除，请通过系统设置迁移到其他磁盘".to_string(),
        enabled: exists && is_on_c_drive,
        size,
        actionable: is_on_c_drive,
        action_text: "打开系统设置".to_string(),
    }
}

/// 从注册表读取分页文件配置
fn get_pagefile_registry_info() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        let output = Command::new("reg")
            .args([
                "query",
                r"HKLM\System\CurrentControlSet\Control\Session Manager\Memory Management",
                "/v",
                "PagingFiles",
            ])
            .creation_flags(0x08000000)
            .output();
        
        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                // 解析输出获取分页文件路径
                if let Some(line) = stdout.lines().find(|l| l.contains("PagingFiles")) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 3 {
                        return parts[2..].join(" ");
                    }
                }
                "未知".to_string()
            }
            Err(_) => "读取失败".to_string(),
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        "不支持".to_string()
    }
}

/// 关闭休眠功能
#[tauri::command]
pub fn disable_hibernation() -> Result<String, String> {
    if !check_admin_privilege() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        info!("正在关闭休眠功能...");
        
        let output = Command::new("powercfg")
            .args(["-h", "off"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("执行命令失败: {}", e))?;
        
        if output.status.success() {
            info!("休眠功能已关闭");
            Ok("休眠功能已成功关闭，hiberfil.sys 文件将被删除".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("关闭休眠失败: {}", stderr))
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

/// 开启休眠功能
#[tauri::command]
pub fn enable_hibernation() -> Result<String, String> {
    if !check_admin_privilege() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        info!("正在开启休眠功能...");
        
        let output = Command::new("powercfg")
            .args(["-h", "on"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("执行命令失败: {}", e))?;
        
        if output.status.success() {
            info!("休眠功能已开启");
            Ok("休眠功能已成功开启".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("开启休眠失败: {}", stderr))
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

/// 清理 WinSxS 组件存储（异步执行）
#[tauri::command]
pub async fn cleanup_winsxs(window: Window) -> Result<String, String> {
    if !check_admin_privilege() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        info!("开始清理 WinSxS 组件存储...");
        
        // 发送开始事件
        let _ = window.emit("winsxs-cleanup-progress", serde_json::json!({
            "status": "running",
            "message": "正在清理系统组件存储，请耐心等待..."
        }));
        
        // 使用 tokio 的 spawn_blocking 来执行阻塞操作
        let result = tokio::task::spawn_blocking(move || {
            Command::new("dism.exe")
                .args([
                    "/online",
                    "/cleanup-image",
                    "/startcomponentcleanup",
                    "/resetbase",
                ])
                .creation_flags(0x08000000)
                .output()
        })
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
        .map_err(|e| format!("执行 DISM 命令失败: {}", e))?;
        
        if result.status.success() {
            info!("WinSxS 清理完成");
            Ok("系统组件存储清理完成".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let stdout = String::from_utf8_lossy(&result.stdout);
            Err(format!("清理失败: {} {}", stdout, stderr))
        }
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

/// 打开系统虚拟内存设置
#[tauri::command]
pub fn open_virtual_memory_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;
        
        info!("打开虚拟内存设置...");
        
        // 打开系统属性 - 高级选项卡
        Command::new("SystemPropertiesAdvanced.exe")
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法打开系统设置: {}", e))?;
        
        Ok(())
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}
