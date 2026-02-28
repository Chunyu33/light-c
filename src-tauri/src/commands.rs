// ============================================================================
// Tauri 命令模块 - 前后端通信接口
// 定义所有可从前端调用的Rust命令
// ============================================================================

use crate::scanner::{ScanEngine, ScanResult, JunkCategory, DeleteResult, CategoryScanResult};
use crate::cleaner::{DeleteEngine, EnhancedDeleteEngine, EnhancedDeleteResult, PermanentDeleteEngine, PermanentDeleteResult, SafetyCheckResult};
use log::info;
use serde::{Deserialize, Serialize};
use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use tauri::{Emitter, Window};
use walkdir::WalkDir;

// 全局取消标志，用于停止大文件扫描
static LARGE_FILE_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

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
    // 重置取消标志
    LARGE_FILE_SCAN_CANCELLED.store(false, AtomicOrdering::SeqCst);
    let window = window.clone();
    tokio::task::spawn_blocking(move || scan_large_files_impl(&window))
        .await
        .map_err(|e| format!("扫描任务异常: {}", e))?
}

/// 取消大文件扫描
#[tauri::command]
pub fn cancel_large_file_scan() {
    info!("收到取消大文件扫描请求");
    LARGE_FILE_SCAN_CANCELLED.store(true, AtomicOrdering::SeqCst);
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
            // 检查是否被取消
            if LARGE_FILE_SCAN_CANCELLED.load(AtomicOrdering::SeqCst) {
                info!("大文件扫描被用户取消，已扫描 {} 个文件", file_count);
                let _ = window.emit("large-file-scan:cancelled", ());
                // 返回当前已扫描到的结果
                let mut results: Vec<LargeFileEntry> = heap.into_iter().map(|item| item.0).collect();
                results.sort_by(|a, b| b.size.cmp(&a.size));
                return Ok(results);
            }

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
/// 支持动态路径检测，自动识别微信、QQ、NTQQ、钉钉、飞书等软件的缓存目录
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

        // 获取用户目录
        let user_profile = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());
        let local_appdata = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| format!("{}\\AppData\\Local", user_profile));
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| format!("{}\\AppData\\Roaming", user_profile));
        
        // 获取真实的文档目录（可能在 D 盘等非系统盘）
        let documents_dir = dirs::document_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}\\Documents", user_profile));
        
        // 默认文档目录
        let default_documents = format!("{}\\Documents", user_profile);
        
        info!("用户目录: {}", user_profile);
        info!("文档目录: {}", documents_dir);
        info!("LocalAppData: {}", local_appdata);
        
        // ========================================================================
        // 动态检测社交软件路径
        // ========================================================================
        
        let mut social_paths: Vec<(&str, String, &str)> = Vec::new();
        
        // ------------------------------------------------------------------------
        // 微信 (WeChat) - 动态检测
        // ------------------------------------------------------------------------
        let wechat_base_paths = vec![
            format!("{}\\WeChat Files", documents_dir),
            format!("{}\\WeChat Files", default_documents),
        ];
        
        for base_path in &wechat_base_paths {
            let base = std::path::Path::new(base_path);
            if base.exists() {
                info!("发现微信目录: {}", base_path);
                // 遍历所有用户目录（微信ID）
                if let Ok(entries) = std::fs::read_dir(base) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let user_dir = entry.path();
                            let user_name = user_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
                            
                            // 跳过 All Users 和 Applet 等系统目录
                            if user_name == "All Users" || user_name == "Applet" || user_name.starts_with(".") {
                                continue;
                            }
                            
                            info!("  微信用户: {}", user_name);
                            
                            // FileStorage 子目录
                            let file_storage = user_dir.join("FileStorage");
                            if file_storage.exists() {
                                // 图片
                                let image_dir = file_storage.join("Image");
                                if image_dir.exists() {
                                    social_paths.push(("微信", image_dir.to_string_lossy().to_string(), "images_videos"));
                                }
                                // 视频
                                let video_dir = file_storage.join("Video");
                                if video_dir.exists() {
                                    social_paths.push(("微信", video_dir.to_string_lossy().to_string(), "images_videos"));
                                }
                                // 文件
                                let file_dir = file_storage.join("File");
                                if file_dir.exists() {
                                    social_paths.push(("微信", file_dir.to_string_lossy().to_string(), "file_transfer"));
                                }
                                // 朋友圈
                                let sns_dir = file_storage.join("Sns");
                                if sns_dir.exists() {
                                    social_paths.push(("微信", sns_dir.to_string_lossy().to_string(), "moments_cache"));
                                }
                                // 缓存
                                let cache_dir = file_storage.join("Cache");
                                if cache_dir.exists() {
                                    social_paths.push(("微信", cache_dir.to_string_lossy().to_string(), "moments_cache"));
                                }
                                // 消息附件
                                let msg_attach = file_storage.join("MsgAttach");
                                if msg_attach.exists() {
                                    social_paths.push(("微信", msg_attach.to_string_lossy().to_string(), "file_transfer"));
                                }
                            }
                            
                            // Msg 目录（消息数据库，通常较大）
                            let msg_dir = user_dir.join("Msg");
                            if msg_dir.exists() {
                                // 只扫描 Attach 子目录，避免删除消息数据库
                                let attach_dir = msg_dir.join("Attach");
                                if attach_dir.exists() {
                                    social_paths.push(("微信", attach_dir.to_string_lossy().to_string(), "file_transfer"));
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // ------------------------------------------------------------------------
        // QQ (传统版) - 动态检测
        // ------------------------------------------------------------------------
        let qq_base_paths = vec![
            format!("{}\\Tencent Files", documents_dir),
            format!("{}\\Tencent Files", default_documents),
        ];
        
        for base_path in &qq_base_paths {
            let base = std::path::Path::new(base_path);
            if base.exists() {
                info!("发现QQ目录: {}", base_path);
                if let Ok(entries) = std::fs::read_dir(base) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let user_dir = entry.path();
                            let user_name = user_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
                            
                            // QQ号通常是纯数字
                            if !user_name.chars().all(|c| c.is_ascii_digit()) && user_name != "All Users" {
                                continue;
                            }
                            
                            info!("  QQ用户: {}", user_name);
                            
                            // 图片
                            let image_dir = user_dir.join("Image");
                            if image_dir.exists() {
                                social_paths.push(("QQ", image_dir.to_string_lossy().to_string(), "images_videos"));
                            }
                            // 视频
                            let video_dir = user_dir.join("Video");
                            if video_dir.exists() {
                                social_paths.push(("QQ", video_dir.to_string_lossy().to_string(), "images_videos"));
                            }
                            // 文件接收
                            let file_recv = user_dir.join("FileRecv");
                            if file_recv.exists() {
                                social_paths.push(("QQ", file_recv.to_string_lossy().to_string(), "file_transfer"));
                            }
                            // 音频
                            let audio_dir = user_dir.join("Audio");
                            if audio_dir.exists() {
                                social_paths.push(("QQ", audio_dir.to_string_lossy().to_string(), "images_videos"));
                            }
                        }
                    }
                }
            }
        }
        
        // QQ 临时文件
        let qq_temp = format!("{}\\Tencent\\QQ\\Temp", appdata);
        if std::path::Path::new(&qq_temp).exists() {
            social_paths.push(("QQ", qq_temp, "moments_cache"));
        }
        
        // ------------------------------------------------------------------------
        // NTQQ (新版QQ) - 动态检测
        // ------------------------------------------------------------------------
        let ntqq_base = format!("{}\\Tencent\\QQ\\nt_qq", local_appdata);
        let ntqq_path = std::path::Path::new(&ntqq_base);
        if ntqq_path.exists() {
            info!("发现NTQQ目录: {}", ntqq_base);
            // NTQQ 的缓存结构
            if let Ok(entries) = std::fs::read_dir(ntqq_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        let sub_dir = entry.path();
                        let dir_name = sub_dir.file_name().unwrap_or_default().to_string_lossy().to_string();
                        
                        // 跳过非用户目录
                        if dir_name == "global" || dir_name.starts_with(".") {
                            continue;
                        }
                        
                        info!("  NTQQ用户目录: {}", dir_name);
                        
                        // nt_data 目录
                        let nt_data = sub_dir.join("nt_data");
                        if nt_data.exists() {
                            // 图片缓存
                            let pic_dir = nt_data.join("Pic");
                            if pic_dir.exists() {
                                social_paths.push(("NTQQ", pic_dir.to_string_lossy().to_string(), "images_videos"));
                            }
                            // 视频缓存
                            let video_dir = nt_data.join("Video");
                            if video_dir.exists() {
                                social_paths.push(("NTQQ", video_dir.to_string_lossy().to_string(), "images_videos"));
                            }
                            // 文件缓存
                            let file_dir = nt_data.join("File");
                            if file_dir.exists() {
                                social_paths.push(("NTQQ", file_dir.to_string_lossy().to_string(), "file_transfer"));
                            }
                        }
                        
                        // nt_msg 目录（消息缓存）
                        let nt_msg = sub_dir.join("nt_msg");
                        if nt_msg.exists() {
                            social_paths.push(("NTQQ", nt_msg.to_string_lossy().to_string(), "moments_cache"));
                        }
                    }
                }
            }
        }
        
        // NTQQ 全局缓存
        let ntqq_cache = format!("{}\\Tencent\\QQ\\Cache", local_appdata);
        if std::path::Path::new(&ntqq_cache).exists() {
            social_paths.push(("NTQQ", ntqq_cache, "moments_cache"));
        }
        
        // ------------------------------------------------------------------------
        // 钉钉 (DingTalk) - 动态检测
        // ------------------------------------------------------------------------
        let dingtalk_base = format!("{}\\DingTalk", appdata);
        let dingtalk_path = std::path::Path::new(&dingtalk_base);
        if dingtalk_path.exists() {
            info!("发现钉钉目录: {}", dingtalk_base);
            if let Ok(entries) = std::fs::read_dir(dingtalk_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        let sub_dir = entry.path();
                        // 图片
                        let image_dir = sub_dir.join("Image");
                        if image_dir.exists() {
                            social_paths.push(("钉钉", image_dir.to_string_lossy().to_string(), "images_videos"));
                        }
                        // 视频
                        let video_dir = sub_dir.join("Video");
                        if video_dir.exists() {
                            social_paths.push(("钉钉", video_dir.to_string_lossy().to_string(), "images_videos"));
                        }
                        // 文件
                        let file_dir = sub_dir.join("File");
                        if file_dir.exists() {
                            social_paths.push(("钉钉", file_dir.to_string_lossy().to_string(), "file_transfer"));
                        }
                        // 缓存
                        let cache_dir = sub_dir.join("Cache");
                        if cache_dir.exists() {
                            social_paths.push(("钉钉", cache_dir.to_string_lossy().to_string(), "moments_cache"));
                        }
                    }
                }
            }
        }
        
        // 钉钉文档目录
        let dingtalk_docs = format!("{}\\DingTalk", documents_dir);
        if std::path::Path::new(&dingtalk_docs).exists() {
            social_paths.push(("钉钉", dingtalk_docs, "file_transfer"));
        }
        
        // ------------------------------------------------------------------------
        // 飞书 (Feishu/Lark) - 动态检测
        // ------------------------------------------------------------------------
        let feishu_base = format!("{}\\feishu", appdata);
        let feishu_path = std::path::Path::new(&feishu_base);
        if feishu_path.exists() {
            info!("发现飞书目录: {}", feishu_base);
            if let Ok(entries) = std::fs::read_dir(feishu_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        let sub_dir = entry.path();
                        // 图片
                        let image_dir = sub_dir.join("Image");
                        if image_dir.exists() {
                            social_paths.push(("飞书", image_dir.to_string_lossy().to_string(), "images_videos"));
                        }
                        // 文件
                        let file_dir = sub_dir.join("File");
                        if file_dir.exists() {
                            social_paths.push(("飞书", file_dir.to_string_lossy().to_string(), "file_transfer"));
                        }
                        // 缓存
                        let cache_dir = sub_dir.join("Cache");
                        if cache_dir.exists() {
                            social_paths.push(("飞书", cache_dir.to_string_lossy().to_string(), "moments_cache"));
                        }
                    }
                }
            }
        }
        
        // 飞书文档目录
        let feishu_docs = format!("{}\\Feishu", documents_dir);
        if std::path::Path::new(&feishu_docs).exists() {
            social_paths.push(("飞书", feishu_docs, "file_transfer"));
        }
        
        // Lark (国际版飞书)
        let lark_base = format!("{}\\Lark", appdata);
        if std::path::Path::new(&lark_base).exists() {
            social_paths.push(("Lark", lark_base, "moments_cache"));
        }
        
        // ------------------------------------------------------------------------
        // 企业微信 (WXWork) - 动态检测
        // ------------------------------------------------------------------------
        let wxwork_base_paths = vec![
            format!("{}\\WXWork", documents_dir),
            format!("{}\\WXWork", default_documents),
        ];
        
        for base_path in &wxwork_base_paths {
            let base = std::path::Path::new(base_path);
            if base.exists() {
                info!("发现企业微信目录: {}", base_path);
                if let Ok(entries) = std::fs::read_dir(base) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                            let user_dir = entry.path();
                            let cache_dir = user_dir.join("Cache");
                            if cache_dir.exists() {
                                // 图片
                                let image_dir = cache_dir.join("Image");
                                if image_dir.exists() {
                                    social_paths.push(("企业微信", image_dir.to_string_lossy().to_string(), "images_videos"));
                                }
                                // 视频
                                let video_dir = cache_dir.join("Video");
                                if video_dir.exists() {
                                    social_paths.push(("企业微信", video_dir.to_string_lossy().to_string(), "images_videos"));
                                }
                                // 文件
                                let file_dir = cache_dir.join("File");
                                if file_dir.exists() {
                                    social_paths.push(("企业微信", file_dir.to_string_lossy().to_string(), "file_transfer"));
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // ------------------------------------------------------------------------
        // Telegram - 动态检测
        // ------------------------------------------------------------------------
        let telegram_base = format!("{}\\Telegram Desktop", appdata);
        if std::path::Path::new(&telegram_base).exists() {
            info!("发现Telegram目录: {}", telegram_base);
            social_paths.push(("Telegram", telegram_base, "moments_cache"));
        }
        
        // ========================================================================
        // 执行扫描
        // ========================================================================
        
        // 图片视频扩展名
        let image_video_exts = [
            "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tiff",
            "mp4", "avi", "mov", "wmv", "flv", "mkv", "webm", "m4v", "3gp",
            "mp3", "wav", "aac", "flac", "ogg", "wma", "m4a",
            "dat", "silk", "amr"  // 微信语音格式
        ];
        
        info!("共发现 {} 个社交软件缓存路径", social_paths.len());
        
        for (app_name, path_str, category_id) in &social_paths {
            let path = PathBuf::from(path_str);
            if path.exists() {
                scan_directory_for_social(
                    &path,
                    app_name,
                    category_id,
                    &mut categories,
                    &image_video_exts,
                );
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

// ============================================================================
// 系统健康评分
// ============================================================================

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
/// 评分算法：
/// - C盘剩余百分比 (40%权重)：剩余空间越多分数越高
/// - 休眠文件 (30%权重)：无休眠文件得满分，有则根据大小扣分
/// - 垃圾文件 (30%权重)：垃圾越少分数越高
#[tauri::command]
pub fn get_health_score() -> HealthScoreResult {
    info!("计算系统健康评分...");
    
    // 1. 获取C盘剩余空间百分比
    let (disk_free_percent, disk_score) = calculate_disk_score();
    
    // 2. 检查休眠文件
    let (has_hibernation, hibernation_size, hibernation_score) = calculate_hibernation_score();
    
    // 3. 快速估算垃圾文件大小
    let (junk_size, junk_score) = calculate_junk_score();
    
    // 计算总分
    let score = disk_score + hibernation_score + junk_score;
    
    info!("健康评分: {} (磁盘:{}, 休眠:{}, 垃圾:{})", score, disk_score, hibernation_score, junk_score);
    
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
            // 剩余空间评分：
            // >= 30% 得满分40
            // 20-30% 得30分
            // 10-20% 得20分
            // 5-10% 得10分
            // < 5% 得0分
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
    
    (50.0, 20) // 默认值
}

/// 计算休眠文件评分 (满分30)
fn calculate_hibernation_score() -> (bool, u64, u32) {
    let hiberfil_path = std::path::Path::new("C:\\hiberfil.sys");
    
    if hiberfil_path.exists() {
        // 获取休眠文件大小
        let size = std::fs::metadata(hiberfil_path)
            .map(|m| m.len())
            .unwrap_or(0);
        
        // 休眠文件存在，根据大小扣分
        // < 4GB: 20分
        // 4-8GB: 15分
        // 8-16GB: 10分
        // > 16GB: 5分
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
        // 无休眠文件，得满分
        (false, 0, 30)
    }
}

/// 计算垃圾文件评分 (满分30)
fn calculate_junk_score() -> (u64, u32) {
    let mut total_junk_size: u64 = 0;
    
    // 快速检查常见垃圾目录
    let junk_paths = [
        std::env::var("TEMP").unwrap_or_default(),
        std::env::var("TMP").unwrap_or_default(),
        format!("{}\\AppData\\Local\\Temp", std::env::var("USERPROFILE").unwrap_or_default()),
        "C:\\Windows\\Temp".to_string(),
        "C:\\Windows\\Prefetch".to_string(),
    ];
    
    for path_str in &junk_paths {
        if path_str.is_empty() {
            continue;
        }
        let path = std::path::Path::new(path_str);
        if path.exists() && path.is_dir() {
            // 快速统计目录大小（只遍历一层）
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
    
    // 检查回收站大小（简化估算）
    let recycle_bin = format!("C:\\$Recycle.Bin");
    if std::path::Path::new(&recycle_bin).exists() {
        // 回收站通常有权限问题，简单估算
        total_junk_size += 100 * 1024 * 1024; // 假设100MB
    }
    
    // 垃圾文件评分：
    // < 500MB: 满分30
    // 500MB-1GB: 25分
    // 1-2GB: 20分
    // 2-5GB: 15分
    // 5-10GB: 10分
    // > 10GB: 5分
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

// ============================================================================
// 卸载残留扫描命令
// ============================================================================

use crate::scanner::{LeftoverScanner, LeftoverScanResult};
use crate::scanner::{RegistryScanner, RegistryScanResult, RegistryEntry, RegistryBackup};

/// 扫描卸载残留
/// 
/// 扫描 AppData 和 ProgramData 中已卸载软件遗留的孤立文件夹
#[tauri::command]
pub async fn scan_uninstall_leftovers() -> Result<LeftoverScanResult, String> {
    info!("开始扫描卸载残留...");
    
    let result = tokio::task::spawn_blocking(|| {
        let scanner = LeftoverScanner::new();
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务失败: {}", e))?;
    
    info!(
        "卸载残留扫描完成: 发现 {} 个残留, 总大小 {} 字节",
        result.leftovers.len(),
        result.total_size
    );
    
    Ok(result)
}

/// 删除卸载残留文件夹
/// 
/// # 参数
/// - `paths`: 要删除的文件夹路径列表
#[tauri::command]
pub async fn delete_leftover_folders(paths: Vec<String>) -> Result<LeftoverDeleteResult, String> {
    info!("开始删除 {} 个卸载残留文件夹...", paths.len());
    
    let result = tokio::task::spawn_blocking(move || {
        let mut deleted_count = 0u32;
        let mut deleted_size = 0u64;
        let mut failed_paths = Vec::new();
        let mut errors = Vec::new();
        
        for path in paths {
            let path_buf = std::path::PathBuf::from(&path);
            
            // 安全检查：确保路径在允许的目录内
            if !is_safe_leftover_path(&path_buf) {
                failed_paths.push(path.clone());
                errors.push(format!("路径不在允许的目录内: {}", path));
                continue;
            }
            
            // 计算文件夹大小（删除前）
            let folder_size = calculate_dir_size(&path_buf);
            
            // 递归删除目录
            match std::fs::remove_dir_all(&path_buf) {
                Ok(_) => {
                    deleted_count += 1;
                    deleted_size += folder_size;
                }
                Err(e) => {
                    failed_paths.push(path.clone());
                    errors.push(format!("删除失败 {}: {}", path, e));
                }
            }
        }
        
        LeftoverDeleteResult {
            deleted_count,
            deleted_size,
            failed_paths,
            errors,
        }
    })
    .await
    .map_err(|e| format!("删除任务失败: {}", e))?;
    
    info!(
        "卸载残留删除完成: 成功 {}, 失败 {}",
        result.deleted_count,
        result.failed_paths.len()
    );
    
    Ok(result)
}

/// 卸载残留删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeftoverDeleteResult {
    /// 成功删除的文件夹数
    pub deleted_count: u32,
    /// 释放的空间大小（字节）
    pub deleted_size: u64,
    /// 删除失败的路径
    pub failed_paths: Vec<String>,
    /// 错误信息列表
    pub errors: Vec<String>,
}

/// 计算目录大小
fn calculate_dir_size(path: &std::path::Path) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    size += metadata.len();
                }
            } else if entry_path.is_dir() {
                size += calculate_dir_size(&entry_path);
            }
        }
    }
    size
}

/// 检查路径是否在允许删除的目录内
fn is_safe_leftover_path(path: &std::path::Path) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();
    
    // 允许的目录前缀
    let allowed_prefixes = [
        "appdata\\local",
        "appdata\\roaming",
        "programdata",
    ];
    
    // 检查路径是否包含允许的前缀
    allowed_prefixes.iter().any(|prefix| path_str.contains(prefix))
}

// ============================================================================
// 注册表冗余扫描命令
// ============================================================================

/// 扫描注册表冗余
/// 
/// 安全扫描 Windows 注册表中的孤立键值和无效引用
#[tauri::command]
pub async fn scan_registry_redundancy() -> Result<RegistryScanResult, String> {
    info!("开始扫描注册表冗余...");
    
    let result = tokio::task::spawn_blocking(|| {
        let scanner = RegistryScanner::new();
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务失败: {}", e))?;
    
    info!(
        "注册表扫描完成: 发现 {} 个冗余条目",
        result.total_count
    );
    
    Ok(result)
}

/// 备份并删除注册表条目
/// 
/// # 参数
/// - `entries`: 要删除的注册表条目列表
/// 
/// # 返回
/// - 备份文件路径和删除结果
#[tauri::command]
pub async fn delete_registry_entries(entries: Vec<RegistryEntry>) -> Result<RegistryDeleteResult, String> {
    info!("开始删除 {} 个注册表条目...", entries.len());
    
    // 首先创建备份
    let backup_dir = RegistryBackup::get_backup_dir();
    let backup_path = RegistryBackup::export_backup(&entries, &backup_dir)
        .map_err(|e| format!("创建备份失败: {}", e))?;
    
    info!("注册表备份已保存到: {:?}", backup_path);
    
    // 执行删除
    let result = tokio::task::spawn_blocking(move || {
        let mut deleted_count = 0u32;
        let mut failed_entries = Vec::new();
        let mut errors = Vec::new();
        
        for entry in entries {
            match crate::scanner::delete_registry_entry(&entry) {
                Ok(_) => {
                    deleted_count += 1;
                }
                Err(e) => {
                    failed_entries.push(entry.path.clone());
                    errors.push(e);
                }
            }
        }
        
        RegistryDeleteResult {
            backup_path: backup_path.to_string_lossy().to_string(),
            deleted_count,
            failed_entries,
            errors,
        }
    })
    .await
    .map_err(|e| format!("删除任务失败: {}", e))?;
    
    info!(
        "注册表删除完成: 成功 {}, 失败 {}",
        result.deleted_count,
        result.failed_entries.len()
    );
    
    Ok(result)
}

/// 注册表删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryDeleteResult {
    /// 备份文件路径
    pub backup_path: String,
    /// 成功删除的条目数
    pub deleted_count: u32,
    /// 删除失败的条目路径
    pub failed_entries: Vec<String>,
    /// 错误信息列表
    pub errors: Vec<String>,
}

/// 打开注册表备份目录
#[tauri::command]
pub async fn open_registry_backup_dir() -> Result<(), String> {
    let backup_dir = RegistryBackup::get_backup_dir();
    
    // 确保目录存在
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("创建备份目录失败: {}", e))?;
    
    // 打开目录
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&backup_dir)
            .spawn()
            .map_err(|e| format!("打开目录失败: {}", e))?;
    }
    
    Ok(())
}

// ============================================================================
// 增强删除命令 - 支持锁定文件处理和物理大小计算
// ============================================================================

/// 增强删除文件
/// 
/// 使用增强删除引擎删除文件，支持：
/// - 物理大小计算（实际释放的磁盘空间）
/// - 锁定文件处理（标记为重启删除）
/// - 详细的失败原因反馈
#[tauri::command]
pub async fn enhanced_delete_files(paths: Vec<String>) -> Result<EnhancedDeleteResult, String> {
    info!("增强删除: 开始删除 {} 个文件", paths.len());
    
    let result = tokio::task::spawn_blocking(move || {
        let engine = EnhancedDeleteEngine::new();
        engine.delete_files(&paths)
    })
    .await
    .map_err(|e| format!("删除任务失败: {}", e))?;
    
    info!(
        "增强删除完成: 成功 {}, 失败 {}, 待重启 {}, 释放 {} 字节",
        result.success_count,
        result.failed_count,
        result.reboot_pending_count,
        result.freed_physical_size
    );
    
    Ok(result)
}

/// 获取文件的物理大小（按簇对齐）
#[tauri::command]
pub async fn get_physical_size(logical_size: u64) -> Result<u64, String> {
    let engine = EnhancedDeleteEngine::new();
    Ok(engine.calculate_physical_size(logical_size))
}

/// 检查是否需要管理员权限
#[tauri::command]
pub async fn check_admin_for_path(path: String) -> Result<bool, String> {
    let path_lower = path.to_lowercase();
    
    // 需要管理员权限的路径
    let admin_required_paths = [
        "c:\\windows\\",
        "c:\\program files",
        "c:\\programdata\\microsoft\\windows",
    ];
    
    for admin_path in &admin_required_paths {
        if path_lower.starts_with(admin_path) {
            return Ok(true);
        }
    }
    
    Ok(false)
}

// ============================================================================
// 永久删除命令 - 卸载残留深度清理
// ============================================================================

/// 永久删除卸载残留（深度清理）
/// 
/// ⚠️ 警告：此操作将直接从磁盘永久删除文件，不可恢复！
/// 
/// 【安全机制】
/// 执行删除前会进行三重安全检查：
/// 1. 注册表检查 - 确认目录不在任何已安装程序中
/// 2. 可执行文件检查 - 扫描 .exe/.dll/.sys 文件，发现则跳过
/// 3. 核心白名单检查 - 确保路径不在系统关键目录内
/// 
/// # 参数
/// - `paths`: 要永久删除的文件夹路径列表
/// 
/// # 返回
/// - `PermanentDeleteResult`: 包含成功/失败数量、释放空间、详细结果等
#[tauri::command]
pub async fn delete_leftovers_permanent(paths: Vec<String>) -> Result<PermanentDeleteResult, String> {
    info!("⚠️ 永久删除: 开始深度清理 {} 个卸载残留文件夹", paths.len());
    
    let result = tokio::task::spawn_blocking(move || {
        let engine = PermanentDeleteEngine::new();
        engine.delete_leftovers(paths)
    })
    .await
    .map_err(|e| format!("永久删除任务失败: {}", e))?;
    
    info!(
        "永久删除完成: 成功 {}, 失败 {}, 待审核 {}, 待重启 {}, 释放 {} 字节",
        result.success_count,
        result.failed_count,
        result.manual_review_count,
        result.reboot_pending_count,
        result.freed_size
    );
    
    Ok(result)
}

/// 执行单个路径的安全检查
/// 
/// 在用户确认删除前，可以先调用此接口检查路径是否安全
/// 
/// # 参数
/// - `path`: 要检查的文件夹路径
/// 
/// # 返回
/// - `SafetyCheckResult`: 安全检查结果
#[tauri::command]
pub async fn check_leftover_safety(path: String) -> Result<SafetyCheckResult, String> {
    let result = tokio::task::spawn_blocking(move || {
        let engine = PermanentDeleteEngine::new();
        let path = std::path::Path::new(&path);
        engine.perform_safety_checks(path)
    })
    .await
    .map_err(|e| format!("安全检查失败: {}", e))?;
    
    Ok(result)
}

// ============================================================================
// 系统信息获取
// ============================================================================

/// 系统信息结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    /// 操作系统名称
    pub os_name: String,
    /// 操作系统版本
    pub os_version: String,
    /// 系统架构
    pub os_arch: String,
    /// 计算机名称
    pub computer_name: String,
    /// 用户名
    pub user_name: String,
    /// CPU 信息
    pub cpu_info: String,
    /// CPU 核心数
    pub cpu_cores: u32,
    /// 总内存（字节）
    pub total_memory: u64,
    /// 可用内存（字节）
    pub available_memory: u64,
    /// 系统启动时间（秒）
    pub uptime_seconds: u64,
}

/// 获取系统信息
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    info!("获取系统信息");
    
    #[cfg(target_os = "windows")]
    {
        use winapi::um::sysinfoapi::{GetSystemInfo, GlobalMemoryStatusEx, SYSTEM_INFO, MEMORYSTATUSEX};
        
        // 获取操作系统版本
        let os_version = get_windows_version();
        
        // 获取系统架构
        let os_arch = if cfg!(target_arch = "x86_64") {
            "x64 (64位)".to_string()
        } else if cfg!(target_arch = "x86") {
            "x86 (32位)".to_string()
        } else if cfg!(target_arch = "aarch64") {
            "ARM64".to_string()
        } else {
            std::env::consts::ARCH.to_string()
        };
        
        // 获取计算机名称
        let computer_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "未知".to_string());
        
        // 获取用户名
        let user_name = std::env::var("USERNAME").unwrap_or_else(|_| "未知".to_string());
        
        // 获取 CPU 信息
        let cpu_info = get_cpu_info();
        
        // 获取 CPU 核心数
        let cpu_cores = unsafe {
            let mut sys_info: SYSTEM_INFO = std::mem::zeroed();
            GetSystemInfo(&mut sys_info);
            sys_info.dwNumberOfProcessors
        };
        
        // 获取内存信息
        let (total_memory, available_memory) = unsafe {
            let mut mem_status: MEMORYSTATUSEX = std::mem::zeroed();
            mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut mem_status) != 0 {
                (mem_status.ullTotalPhys, mem_status.ullAvailPhys)
            } else {
                (0, 0)
            }
        };
        
        // 获取系统启动时间
        let uptime_seconds = unsafe {
            winapi::um::sysinfoapi::GetTickCount64() / 1000
        };
        
        Ok(SystemInfo {
            os_name: "Microsoft Windows".to_string(),
            os_version,
            os_arch,
            computer_name,
            user_name,
            cpu_info,
            cpu_cores,
            total_memory,
            available_memory,
            uptime_seconds,
        })
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

#[cfg(target_os = "windows")]
fn get_windows_version() -> String {
    use winreg::enums::*;
    use winreg::RegKey;
    
    // 从注册表读取系统版本信息（避免 wmic 编码问题）
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion") {
        let product_name: String = key.get_value("ProductName").unwrap_or_default();
        let display_version: String = key.get_value("DisplayVersion").unwrap_or_default();
        let current_build: String = key.get_value("CurrentBuild").unwrap_or_default();
        let ubr: u32 = key.get_value("UBR").unwrap_or(0);
        
        if !product_name.is_empty() {
            let version_str = if !display_version.is_empty() {
                format!("{} {} (Build {}.{})", product_name, display_version, current_build, ubr)
            } else {
                format!("{} (Build {}.{})", product_name, current_build, ubr)
            };
            return version_str;
        }
    }
    
    // 回退到基本版本信息
    "Windows".to_string()
}

#[cfg(target_os = "windows")]
fn get_cpu_info() -> String {
    use winreg::enums::*;
    use winreg::RegKey;
    
    // 从注册表读取 CPU 信息（避免 wmic 编码问题）
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0") {
        let processor_name: String = key.get_value("ProcessorNameString").unwrap_or_default();
        if !processor_name.is_empty() {
            return processor_name.trim().to_string();
        }
    }
    
    // 回退到环境变量
    std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "未知处理器".to_string())
}
