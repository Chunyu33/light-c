// ============================================================================
// 扫描引擎 - 核心扫描逻辑实现
// 使用并行扫描优化性能
// ============================================================================

use log::{debug, info};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use walkdir::WalkDir;

use super::{CategoryScanResult, FileInfo, JunkCategory, ScanResult};

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

        // 收集所有解析后的路径，去重后再扫描
        // 例如 %TEMP% 和 %TMP% 可能指向同一个目录，避免重复扫描
        let mut unique_paths: HashSet<std::path::PathBuf> = HashSet::new();
        let mut resolved_list: Vec<std::path::PathBuf> = Vec::new();

        for scan_path in scan_paths {
            for resolved_path in scan_path.resolve_all() {
                // 尝试规范化路径以消除符号链接、大小写等差异
                let canonical = match std::fs::canonicalize(&resolved_path) {
                    Ok(p) => p,
                    Err(_) => resolved_path.clone(), // 规范化失败则使用原路径的克隆
                };
                if unique_paths.insert(canonical.clone()) {
                    resolved_list.push(canonical);
                } else {
                    debug!("跳过重复路径: {:?}", resolved_path);
                }
            }
        }

        for resolved_path in &resolved_list {
            debug!("扫描路径: {:?}", resolved_path);
            self.scan_path(resolved_path, category, &patterns, &mut result);
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

        // 遍历目录，只统计文件，跳过目录条目避免与文件重复计数
        let walker = WalkDir::new(path)
            .max_depth(self.max_depth)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                !self.is_system_protected(e.path())
                    && !self.is_persistent_app_profile_path(e.path())
            });

        for entry in walker.filter_map(|e| e.ok()) {
            let entry_path = entry.path();

            // 跳过根目录本身
            if entry_path == path {
                continue;
            }

            // 只处理文件，跳过目录（避免 calculate_dir_size 与逐文件统计重复计数）
            if !entry.file_type().is_file() {
                continue;
            }

            // 检查是否匹配模式
            if !self.matches_patterns(entry_path, patterns) {
                continue;
            }

            // 二次防线：即便未来新增扫描根，也不要把 WebView/Chromium 的持久化 Profile 数据当垃圾。
            if self.is_persistent_app_profile_path(entry_path) {
                continue;
            }

            // 获取文件信息
            if let Some(file_info) = self.get_file_info(entry_path, category) {
                result.add_file(file_info);
            }
        }
    }

    /// 获取文件信息（仅处理文件，目录已在 scan_path 中跳过）
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

        let size = metadata.len();

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
            false, // 始终为文件，目录不会传入此函数
            category.clone(),
        ))
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

    /// 检查是否为 WebView/Chromium 应用的持久化 Profile 数据。
    ///
    /// 中文说明：
    /// MSIX/Tauri/Electron/WebView2 应用常把用户状态放在 LocalCache 下，例如 Claude 的
    /// EBWebView\Default。这里面的 IndexedDB、Local Storage、各种 SQLite/LevelDB 文件
    /// 不是纯缓存，删除后会导致会话列表、应用偏好或索引丢失。
    fn is_persistent_app_profile_path(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        if !path_str.contains("\\appdata\\local\\packages\\")
            && !path_str.contains("\\ebwebview\\")
        {
            return false;
        }

        let persistent_markers = [
            "\\ebwebview\\default\\",
            "\\local storage\\",
            "\\indexeddb\\",
            "\\session storage\\",
            "\\databases\\",
            "\\file system\\",
            "\\shared_proto_db\\",
            "\\shared dictionary\\",
            "\\autofillaimodelcache\\",
            "\\autofillstrikedatabase\\",
            "\\budgetdatabase\\",
            "\\browsingtopicssitedata",
            "\\browsingtopicsstate",
            "\\bookmarkmergedsurfaceordering",
        ];

        persistent_markers
            .iter()
            .any(|marker| path_str.contains(marker))
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

    #[test]
    fn test_webview_profile_data_is_protected() {
        let engine = ScanEngine::new();

        assert!(engine.is_persistent_app_profile_path(Path::new(
            r"C:\Users\PC\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\app.formatif.desktop\EBWebView\Default\IndexedDB\index.leveldb\LOG"
        )));
        assert!(engine.is_persistent_app_profile_path(Path::new(
            r"C:\Users\PC\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\app.formatif.desktop\EBWebView\Default\BrowsingTopicsSiteData"
        )));
        assert!(!engine.is_persistent_app_profile_path(Path::new(
            r"C:\Users\PC\AppData\Local\Google\Chrome\User Data\Default\Code Cache\js\cache"
        )));
    }
}
