// ============================================================================
// 扫描引擎 - 核心扫描逻辑实现
// 使用并行扫描优化性能
// ============================================================================

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use std::thread;
use walkdir::WalkDir;
use log::{info, debug};

use super::{
    CategoryScanResult, FileInfo, JunkCategory, ScanProgress, ScanResult,
};

/// 扫描引擎
pub struct ScanEngine {
    /// 要扫描的分类列表
    categories: Vec<JunkCategory>,
    /// 最大扫描深度
    max_depth: usize,
}

impl ScanEngine {
    /// 创建新的扫描引擎
    pub fn new() -> Self {
        ScanEngine {
            categories: JunkCategory::all(),
            max_depth: 10,
        }
    }

    /// 设置要扫描的分类
    pub fn with_categories(mut self, categories: Vec<JunkCategory>) -> Self {
        self.categories = categories;
        self
    }

    /// 设置最大扫描深度
    pub fn with_max_depth(mut self, depth: usize) -> Self {
        self.max_depth = depth;
        self
    }

    /// 执行完整扫描（并行扫描所有分类）
    pub fn scan(&self) -> ScanResult {
        let start_time = Instant::now();
        let categories = self.categories.clone();
        let max_depth = self.max_depth;
        
        info!("开始并行扫描，共 {} 个分类", categories.len());

        // 使用线程并行扫描所有分类
        let results: Arc<Mutex<Vec<CategoryScanResult>>> = Arc::new(Mutex::new(Vec::new()));
        let mut handles = vec![];

        for category in categories {
            let results_clone = Arc::clone(&results);
            let handle = thread::spawn(move || {
                let engine = ScanEngine {
                    categories: vec![category.clone()],
                    max_depth,
                };
                let category_result = engine.scan_category(&category);
                
                info!(
                    "分类 {} 扫描完成: {} 个文件, {}",
                    category.display_name(),
                    category_result.file_count,
                    category_result.human_readable_total_size()
                );

                let mut results = results_clone.lock().unwrap();
                results.push(category_result);
            });
            handles.push(handle);
        }

        // 等待所有线程完成
        for handle in handles {
            let _ = handle.join();
        }

        // 汇总结果
        let mut result = ScanResult::new();
        let category_results = results.lock().unwrap();
        for category_result in category_results.iter() {
            result.add_category_result(category_result.clone());
        }

        let duration = start_time.elapsed();
        result.set_duration(duration.as_millis() as u64);

        info!(
            "扫描完成，共发现 {} 个文件，总大小 {}，耗时 {}ms",
            result.total_file_count,
            result.human_readable_total_size(),
            result.scan_duration_ms
        );

        result
    }

    /// 扫描单个分类
    pub fn scan_category(&self, category: &JunkCategory) -> CategoryScanResult {
        let mut result = CategoryScanResult::new(category.clone());
        let scan_paths = category.get_scan_paths();
        let patterns = category.get_file_patterns();

        for scan_path in scan_paths {
            if let Some(resolved_path) = scan_path.resolve() {
                debug!("扫描路径: {:?}", resolved_path);
                self.scan_path(&resolved_path, category, &patterns, &mut result);
            }
        }

        result
    }

    /// 扫描指定路径
    fn scan_path(
        &self,
        path: &Path,
        category: &JunkCategory,
        patterns: &[&str],
        result: &mut CategoryScanResult,
    ) {
        // 检查路径是否存在
        if !path.exists() {
            debug!("路径不存在: {:?}", path);
            return;
        }

        // 如果是文件，直接处理
        if path.is_file() {
            if let Some(file_info) = self.get_file_info(path, category) {
                result.add_file(file_info);
            }
            return;
        }

        // 遍历目录
        let walker = WalkDir::new(path)
            .max_depth(self.max_depth)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !self.is_system_protected(e.path()));

        for entry in walker.filter_map(|e| e.ok()) {
            let entry_path = entry.path();
            
            // 跳过根目录本身
            if entry_path == path {
                continue;
            }

            // 检查是否匹配模式
            if !self.matches_patterns(entry_path, patterns) {
                continue;
            }

            // 获取文件信息
            if let Some(file_info) = self.get_file_info(entry_path, category) {
                result.add_file(file_info);
            }
        }
    }

    /// 获取文件信息
    fn get_file_info(&self, path: &Path, category: &JunkCategory) -> Option<FileInfo> {
        let metadata = match fs::metadata(path) {
            Ok(m) => m,
            Err(e) => {
                debug!("无法获取文件元数据 {:?}: {}", path, e);
                return None;
            }
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知".to_string());

        let size = if metadata.is_file() {
            metadata.len()
        } else {
            // 对于目录，计算其总大小
            self.calculate_dir_size(path)
        };

        let modified_time = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        Some(FileInfo::new(
            path.to_string_lossy().to_string(),
            name,
            size,
            modified_time,
            metadata.is_dir(),
            category.clone(),
        ))
    }

    /// 计算目录大小
    fn calculate_dir_size(&self, path: &Path) -> u64 {
        WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }

    /// 检查文件名是否匹配模式
    fn matches_patterns(&self, path: &Path, patterns: &[&str]) -> bool {
        // 如果模式包含 "*"，匹配所有文件
        if patterns.contains(&"*") {
            return true;
        }

        let file_name = match path.file_name() {
            Some(name) => name.to_string_lossy().to_lowercase(),
            None => return false,
        };

        for pattern in patterns {
            if self.matches_glob(&file_name, pattern) {
                return true;
            }
        }

        false
    }

    /// 简单的glob模式匹配
    fn matches_glob(&self, name: &str, pattern: &str) -> bool {
        let pattern = pattern.to_lowercase();
        
        if pattern == "*" {
            return true;
        }

        if pattern.starts_with('*') && pattern.ends_with('*') {
            // *xxx* 模式
            let middle = &pattern[1..pattern.len() - 1];
            return name.contains(middle);
        }

        if pattern.starts_with('*') {
            // *.xxx 模式
            let suffix = &pattern[1..];
            return name.ends_with(suffix);
        }

        if pattern.ends_with('*') {
            // xxx* 模式
            let prefix = &pattern[..pattern.len() - 1];
            return name.starts_with(prefix);
        }

        // 精确匹配
        name == pattern
    }

    /// 检查是否为系统保护路径（不应扫描）
    fn is_system_protected(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        
        // 保护关键系统目录
        let protected_paths = [
            "system32",
            "syswow64",
            "winsxs",
            "assembly",
            "\\windows\\servicing",
            "\\windows\\installer",
            "\\windows\\logs\\cbs",
            "\\program files",
            "\\program files (x86)",
            "\\programdata\\microsoft\\windows defender",
            "\\users\\default",
        ];

        for protected in &protected_paths {
            if path_str.contains(protected) {
                return true;
            }
        }

        // 保护系统关键文件扩展名
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            let protected_exts = ["sys", "dll", "exe", "msi", "cat", "mum", "manifest"];
            // 只在Windows目录下保护这些扩展名
            if path_str.contains("\\windows\\") && protected_exts.contains(&ext_str.as_str()) {
                return true;
            }
        }

        false
    }
}

// 为并行扫描实现Send和Sync
unsafe impl Send for ScanEngine {}
unsafe impl Sync for ScanEngine {}

impl Default for ScanEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_matching() {
        let engine = ScanEngine::new();
        
        assert!(engine.matches_glob("test.log", "*.log"));
        assert!(engine.matches_glob("test.LOG", "*.log"));
        assert!(!engine.matches_glob("test.txt", "*.log"));
        assert!(engine.matches_glob("thumbcache_256.db", "thumbcache_*.db"));
    }
}
