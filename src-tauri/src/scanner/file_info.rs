// ============================================================================
// 文件信息结构定义
// 用于存储扫描到的文件详细信息
// ============================================================================

use serde::{Deserialize, Serialize};
use super::JunkCategory;

/// 单个文件的详细信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    /// 文件完整路径
    pub path: String,
    /// 文件名
    pub name: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 最后修改时间（Unix时间戳）
    pub modified_time: i64,
    /// 是否为目录
    pub is_dir: bool,
    /// 所属分类
    pub category: JunkCategory,
}

impl FileInfo {
    /// 创建新的文件信息
    pub fn new(
        path: String,
        name: String,
        size: u64,
        modified_time: i64,
        is_dir: bool,
        category: JunkCategory,
    ) -> Self {
        FileInfo {
            path,
            name,
            size,
            modified_time,
            is_dir,
            category,
        }
    }

    /// 获取人类可读的文件大小
    pub fn human_readable_size(&self) -> String {
        format_size(self.size)
    }
}

/// 分类扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryScanResult {
    /// 分类
    pub category: JunkCategory,
    /// 分类显示名称
    pub display_name: String,
    /// 分类描述
    pub description: String,
    /// 风险等级
    pub risk_level: u8,
    /// 该分类下的所有文件
    pub files: Vec<FileInfo>,
    /// 总大小（字节）
    pub total_size: u64,
    /// 文件数量
    pub file_count: usize,
}

impl CategoryScanResult {
    /// 创建新的分类扫描结果
    pub fn new(category: JunkCategory) -> Self {
        CategoryScanResult {
            display_name: category.display_name().to_string(),
            description: category.description().to_string(),
            risk_level: category.risk_level(),
            category,
            files: Vec::new(),
            total_size: 0,
            file_count: 0,
        }
    }

    /// 添加文件到结果中
    pub fn add_file(&mut self, file: FileInfo) {
        self.total_size += file.size;
        self.file_count += 1;
        self.files.push(file);
    }

    /// 获取人类可读的总大小
    pub fn human_readable_total_size(&self) -> String {
        format_size(self.total_size)
    }
}

/// 完整扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    /// 各分类的扫描结果
    pub categories: Vec<CategoryScanResult>,
    /// 总大小（字节）
    pub total_size: u64,
    /// 总文件数量
    pub total_file_count: usize,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
    /// 扫描时间戳
    pub scan_timestamp: i64,
}

impl ScanResult {
    /// 创建新的扫描结果
    pub fn new() -> Self {
        ScanResult {
            categories: Vec::new(),
            total_size: 0,
            total_file_count: 0,
            scan_duration_ms: 0,
            scan_timestamp: chrono::Utc::now().timestamp(),
        }
    }

    /// 添加分类结果
    pub fn add_category_result(&mut self, result: CategoryScanResult) {
        self.total_size += result.total_size;
        self.total_file_count += result.file_count;
        self.categories.push(result);
    }

    /// 设置扫描耗时
    pub fn set_duration(&mut self, duration_ms: u64) {
        self.scan_duration_ms = duration_ms;
    }

    /// 获取人类可读的总大小
    pub fn human_readable_total_size(&self) -> String {
        format_size(self.total_size)
    }
}

impl Default for ScanResult {
    fn default() -> Self {
        Self::new()
    }
}

/// 扫描进度信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    /// 当前正在扫描的分类
    pub current_category: String,
    /// 已完成的分类数
    pub completed_categories: usize,
    /// 总分类数
    pub total_categories: usize,
    /// 当前分类已扫描的文件数
    pub current_file_count: usize,
    /// 当前分类已扫描的大小
    pub current_size: u64,
    /// 进度百分比 (0-100)
    pub progress_percent: f32,
}

impl ScanProgress {
    /// 创建新的进度信息
    pub fn new(total_categories: usize) -> Self {
        ScanProgress {
            current_category: String::new(),
            completed_categories: 0,
            total_categories,
            current_file_count: 0,
            current_size: 0,
            progress_percent: 0.0,
        }
    }

    /// 更新当前分类
    pub fn set_current_category(&mut self, category: &str) {
        self.current_category = category.to_string();
        self.current_file_count = 0;
        self.current_size = 0;
    }

    /// 完成一个分类
    pub fn complete_category(&mut self) {
        self.completed_categories += 1;
        self.progress_percent = 
            (self.completed_categories as f32 / self.total_categories as f32) * 100.0;
    }

    /// 更新当前分类的扫描进度
    pub fn update_current(&mut self, file_count: usize, size: u64) {
        self.current_file_count = file_count;
        self.current_size = size;
    }
}

/// 格式化文件大小为人类可读格式
pub fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

/// 删除操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteResult {
    /// 成功删除的文件数
    pub success_count: usize,
    /// 删除失败的文件数
    pub failed_count: usize,
    /// 释放的空间大小（字节）
    pub freed_size: u64,
    /// 失败的文件列表及原因
    pub failed_files: Vec<DeleteError>,
}

impl DeleteResult {
    /// 创建新的删除结果
    pub fn new() -> Self {
        DeleteResult {
            success_count: 0,
            failed_count: 0,
            freed_size: 0,
            failed_files: Vec::new(),
        }
    }

    /// 记录成功删除
    pub fn add_success(&mut self, size: u64) {
        self.success_count += 1;
        self.freed_size += size;
    }

    /// 记录删除失败
    pub fn add_failure(&mut self, path: String, reason: String) {
        self.failed_count += 1;
        self.failed_files.push(DeleteError { path, reason });
    }
}

impl Default for DeleteResult {
    fn default() -> Self {
        Self::new()
    }
}

/// 删除错误信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteError {
    /// 文件路径
    pub path: String,
    /// 错误原因
    pub reason: String,
}
