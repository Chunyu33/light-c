// ============================================================================
// 清理日志模块 - 记录每次文件删除操作
// ============================================================================
//
// 功能说明：
// 1. 使用 serde_json 序列化日志数据到 JSON 文件
// 2. 通过 std::fs::read_dir 统计文件数量，实现日志轮转（只保留10份）
// 3. 异步写入日志，不阻塞主线程
// 4. 即使日志写入失败，清理逻辑也能继续运行
//
// 日志存储位置：AppData/Roaming/LightC/logs/
// 文件命名格式：cleanup_YYYYMMDD_HHMMSS.json
// ============================================================================

use chrono::Local;
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

/// 最大保留的日志文件数量
const MAX_LOG_FILES: usize = 10;

// ============================================================================
// 日志数据结构
// ============================================================================

/// 单条清理记录
/// 
/// 使用 serde 的 Serialize/Deserialize 特性实现 JSON 序列化：
/// - #[derive(Serialize, Deserialize)] 自动生成序列化代码
/// - serde_json::to_string_pretty() 将结构体转为格式化的 JSON 字符串
/// - serde_json::from_str() 将 JSON 字符串解析为结构体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupLogEntry {
    /// 操作时间戳 (ISO 8601 格式)
    pub timestamp: String,
    /// 清理模块分类 (如 "微信清理", "注册表残留", "大文件清理")
    pub category: String,
    /// 文件/注册表键的绝对路径
    pub path: String,
    /// 释放的空间大小（字节）
    pub size: u64,
    /// 操作结果: "Success" 或 "Failed" 或 "Locked_Pending_Reboot"
    pub result: String,
    /// 错误信息（如果有）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// 单次清理会话的完整日志
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupSession {
    /// 会话开始时间
    pub session_start: String,
    /// 会话结束时间
    pub session_end: String,
    /// 总清理文件数
    pub total_files: usize,
    /// 成功删除数
    pub success_count: usize,
    /// 失败数
    pub failed_count: usize,
    /// 总释放空间（字节）
    pub total_freed_bytes: u64,
    /// 详细清理记录
    pub entries: Vec<CleanupLogEntry>,
}

impl CleanupSession {
    /// 创建新的清理会话
    pub fn new() -> Self {
        Self {
            session_start: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            session_end: String::new(),
            total_files: 0,
            success_count: 0,
            failed_count: 0,
            total_freed_bytes: 0,
            entries: Vec::new(),
        }
    }

    /// 添加清理记录
    pub fn add_entry(&mut self, entry: CleanupLogEntry) {
        if entry.result == "Success" {
            self.success_count += 1;
            self.total_freed_bytes += entry.size;
        } else {
            self.failed_count += 1;
        }
        self.total_files += 1;
        self.entries.push(entry);
    }

    /// 完成会话
    pub fn finish(&mut self) {
        self.session_end = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    }
}

impl Default for CleanupSession {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 日志管理器
// ============================================================================

/// 清理日志管理器
/// 
/// 负责：
/// 1. 将清理记录写入 JSON 文件
/// 2. 管理日志文件数量（轮转）
/// 3. 提供异步写入接口
pub struct CleanupLogger {
    /// 日志存储目录
    log_dir: PathBuf,
    /// 当前会话（使用 Arc<Mutex> 支持异步访问）
    current_session: Arc<Mutex<Option<CleanupSession>>>,
}

impl CleanupLogger {
    /// 创建日志管理器
    /// 
    /// # Arguments
    /// * `app_data_dir` - 应用数据目录 (AppData/Roaming/LightC)
    pub fn new(app_data_dir: &Path) -> Self {
        let log_dir = app_data_dir.join("logs");
        
        // 确保日志目录存在
        if let Err(e) = fs::create_dir_all(&log_dir) {
            error!("创建日志目录失败: {:?}, 错误: {}", log_dir, e);
        }
        
        Self {
            log_dir,
            current_session: Arc::new(Mutex::new(None)),
        }
    }

    /// 获取日志目录路径
    pub fn get_log_dir(&self) -> &Path {
        &self.log_dir
    }

    /// 开始新的清理会话
    pub async fn start_session(&self) {
        let mut session = self.current_session.lock().await;
        *session = Some(CleanupSession::new());
        info!("开始新的清理会话");
    }

    /// 记录单条清理操作
    /// 
    /// # Arguments
    /// * `category` - 清理模块分类
    /// * `path` - 文件路径
    /// * `size` - 文件大小
    /// * `success` - 是否成功
    /// * `error_msg` - 错误信息（可选）
    pub async fn log_entry(
        &self,
        category: &str,
        path: &str,
        size: u64,
        success: bool,
        error_msg: Option<String>,
    ) {
        let entry = CleanupLogEntry {
            timestamp: Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            category: category.to_string(),
            path: path.to_string(),
            size,
            result: if success { "Success".to_string() } else { "Failed".to_string() },
            error_message: error_msg,
        };

        let mut session = self.current_session.lock().await;
        if let Some(ref mut s) = *session {
            s.add_entry(entry);
        } else {
            // 如果没有活动会话，创建一个临时会话
            let mut new_session = CleanupSession::new();
            new_session.add_entry(entry);
            *session = Some(new_session);
        }
    }

    /// 结束当前会话并保存日志
    /// 
    /// 使用 serde_json 序列化日志数据：
    /// 1. 调用 serde_json::to_string_pretty() 生成格式化的 JSON
    /// 2. 使用 std::fs::write() 写入文件
    /// 3. 即使写入失败也不会影响程序运行
    pub async fn finish_session(&self) -> Result<PathBuf, String> {
        let mut session_guard = self.current_session.lock().await;
        
        if let Some(ref mut session) = *session_guard {
            session.finish();
            
            // 生成日志文件名
            let filename = format!(
                "cleanup_{}.json",
                Local::now().format("%Y%m%d_%H%M%S")
            );
            let log_path = self.log_dir.join(&filename);
            
            // 使用 serde_json 序列化为格式化的 JSON 字符串
            // to_string_pretty() 会生成带缩进的可读 JSON
            match serde_json::to_string_pretty(session) {
                Ok(json_content) => {
                    // 写入文件，使用 Result 处理错误
                    match fs::write(&log_path, json_content) {
                        Ok(_) => {
                            info!("清理日志已保存: {:?}", log_path);
                            
                            // 执行日志轮转（在后台线程中执行，不阻塞）
                            let log_dir = self.log_dir.clone();
                            tokio::spawn(async move {
                                if let Err(e) = rotate_logs(&log_dir).await {
                                    warn!("日志轮转失败: {}", e);
                                }
                            });
                            
                            *session_guard = None;
                            return Ok(log_path);
                        }
                        Err(e) => {
                            // 写入失败，记录错误但不崩溃
                            error!("写入日志文件失败: {}", e);
                            *session_guard = None;
                            return Err(format!("写入日志文件失败: {}", e));
                        }
                    }
                }
                Err(e) => {
                    // 序列化失败，记录错误但不崩溃
                    error!("序列化日志失败: {}", e);
                    *session_guard = None;
                    return Err(format!("序列化日志失败: {}", e));
                }
            }
        }
        
        Err("没有活动的清理会话".to_string())
    }

    /// 直接保存一批清理记录（不使用会话模式）
    /// 
    /// 用于一次性记录多条清理结果
    pub async fn save_cleanup_results(&self, entries: Vec<CleanupLogEntry>) -> Result<PathBuf, String> {
        if entries.is_empty() {
            return Err("没有清理记录".to_string());
        }

        let mut session = CleanupSession::new();
        for entry in entries {
            session.add_entry(entry);
        }
        session.finish();

        // 生成日志文件名
        let filename = format!(
            "cleanup_{}.json",
            Local::now().format("%Y%m%d_%H%M%S")
        );
        let log_path = self.log_dir.join(&filename);

        // 序列化并写入
        let json_content = serde_json::to_string_pretty(&session)
            .map_err(|e| format!("序列化失败: {}", e))?;
        
        fs::write(&log_path, json_content)
            .map_err(|e| format!("写入失败: {}", e))?;

        info!("清理日志已保存: {:?}", log_path);

        // 执行日志轮转
        let log_dir = self.log_dir.clone();
        tokio::spawn(async move {
            if let Err(e) = rotate_logs(&log_dir).await {
                warn!("日志轮转失败: {}", e);
            }
        });

        Ok(log_path)
    }
}

// ============================================================================
// 日志轮转逻辑
// ============================================================================

/// 日志轮转 - 只保留最近 MAX_LOG_FILES 份日志
/// 
/// 实现逻辑：
/// 1. 使用 std::fs::read_dir() 遍历日志目录
/// 2. 过滤出 .json 文件并收集文件信息
/// 3. 按创建时间排序（最旧的在前）
/// 4. 如果文件数量超过 MAX_LOG_FILES，删除最旧的文件
async fn rotate_logs(log_dir: &Path) -> Result<(), String> {
    debug!("开始日志轮转检查，目录: {:?}", log_dir);
    
    // 使用 read_dir 遍历目录，收集所有 JSON 日志文件
    let entries: Vec<_> = match fs::read_dir(log_dir) {
        Ok(dir) => dir
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry.path().extension()
                    .map(|ext| ext == "json")
                    .unwrap_or(false)
            })
            .filter_map(|entry| {
                // 获取文件的创建时间（或修改时间作为备选）
                let metadata = entry.metadata().ok()?;
                let created = metadata.created()
                    .or_else(|_| metadata.modified())
                    .ok()?;
                Some((entry.path(), created))
            })
            .collect(),
        Err(e) => {
            return Err(format!("读取日志目录失败: {}", e));
        }
    };

    let file_count = entries.len();
    debug!("当前日志文件数量: {}", file_count);

    // 如果文件数量未超过限制，无需轮转
    if file_count <= MAX_LOG_FILES {
        return Ok(());
    }

    // 按创建时间排序（最旧的在前）
    let mut sorted_entries = entries;
    sorted_entries.sort_by(|a, b| a.1.cmp(&b.1));

    // 计算需要删除的文件数量
    let files_to_delete = file_count - MAX_LOG_FILES;
    info!("日志轮转: 需要删除 {} 个旧文件", files_to_delete);

    // 删除最旧的文件
    for (path, _) in sorted_entries.into_iter().take(files_to_delete) {
        match fs::remove_file(&path) {
            Ok(_) => {
                info!("已删除旧日志: {:?}", path);
            }
            Err(e) => {
                warn!("删除旧日志失败: {:?}, 错误: {}", path, e);
            }
        }
    }

    Ok(())
}

/// 在应用启动时执行日志轮转检查
pub async fn cleanup_old_logs(app_data_dir: &Path) {
    let log_dir = app_data_dir.join("logs");
    if log_dir.exists() {
        if let Err(e) = rotate_logs(&log_dir).await {
            warn!("启动时日志轮转失败: {}", e);
        }
    }
}

// ============================================================================
// 全局日志管理器实例
// ============================================================================

use once_cell::sync::OnceCell;

static CLEANUP_LOGGER: OnceCell<CleanupLogger> = OnceCell::new();

/// 初始化全局日志管理器
pub fn init_logger(app_data_dir: &Path) {
    let _ = CLEANUP_LOGGER.set(CleanupLogger::new(app_data_dir));
    info!("清理日志系统已初始化");
}

/// 获取全局日志管理器
pub fn get_logger() -> Option<&'static CleanupLogger> {
    CLEANUP_LOGGER.get()
}
