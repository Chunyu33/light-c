// ============================================================================
// 删除引擎 - 核心删除逻辑实现
// 多层安全保护，确保不会误删重要文件
// ============================================================================

use log::{debug, error, info, warn};
use std::fs;
use std::path::Path;

use crate::scanner::{DeleteResult, FileInfo};

// ============================================================================
// 安全保护配置 — 统一从共享模块引用
// ============================================================================

use super::safety_constants::{
    is_rebuildable_system_cache_path, PROTECTED_EXTENSIONS_IN_WINDOWS, PROTECTED_FILES,
    PROTECTED_PATH_PREFIXES,
};

/// 删除引擎
pub struct DeleteEngine {
    /// 是否使用安全删除模式（移动到回收站而非直接删除）
    safe_mode: bool,
    /// 是否跳过正在使用的文件
    skip_in_use: bool,
}

impl DeleteEngine {
    /// 创建新的删除引擎
    pub fn new() -> Self {
        DeleteEngine {
            safe_mode: false,  // 默认直接删除
            skip_in_use: true, // 默认跳过正在使用的文件
        }
    }

    /// 设置安全模式
    pub fn with_safe_mode(mut self, enabled: bool) -> Self {
        self.safe_mode = enabled;
        self
    }

    /// 设置是否跳过正在使用的文件
    pub fn with_skip_in_use(mut self, enabled: bool) -> Self {
        self.skip_in_use = enabled;
        self
    }

    /// 删除文件列表
    pub fn delete_files(&self, files: &[FileInfo]) -> DeleteResult {
        let mut result = DeleteResult::new();

        info!("开始删除 {} 个文件", files.len());

        for file in files {
            match self.delete_single_file(&file.path, file.size) {
                Ok((freed, marked_for_reboot)) => {
                    if marked_for_reboot {
                        result.add_reboot_pending(freed);
                        debug!("已标记重启删除: {}", file.path);
                    } else {
                        result.add_success(freed);
                        debug!("成功删除: {}", file.path);
                    }
                }
                Err(e) => {
                    result.add_failure(file.path.clone(), e);
                    warn!(
                        "删除失败: {} - {}",
                        file.path,
                        result
                            .failed_files
                            .last()
                            .map(|f| &f.reason)
                            .unwrap_or(&String::new())
                    );
                }
            }
        }

        info!(
            "删除完成: 成功 {} 个, 失败 {} 个, 待重启 {} 个, 释放空间 {} 字节",
            result.success_count,
            result.failed_count,
            result.reboot_pending_count,
            result.freed_size
        );

        result
    }

    /// 删除指定路径列表
    pub fn delete_paths(&self, paths: &[String]) -> DeleteResult {
        let mut result = DeleteResult::new();

        info!("开始删除 {} 个路径", paths.len());

        for path in paths {
            let file_path = Path::new(path);
            let size = self.get_path_size(file_path);

            match self.delete_single_file(path, size) {
                Ok((freed, marked_for_reboot)) => {
                    if marked_for_reboot {
                        result.add_reboot_pending(freed);
                        debug!("已标记重启删除: {}", path);
                    } else {
                        result.add_success(freed);
                        debug!("成功删除: {}", path);
                    }
                }
                Err(e) => {
                    result.add_failure(path.clone(), e);
                    warn!("删除失败: {}", path);
                }
            }
        }

        info!(
            "删除完成: 成功 {} 个, 失败 {} 个, 待重启 {} 个, 释放空间 {} 字节",
            result.success_count,
            result.failed_count,
            result.reboot_pending_count,
            result.freed_size
        );

        result
    }

    /// 删除单个文件或目录（多层安全检查）
    /// 返回 (释放大小, 是否标记为重启删除)
    fn delete_single_file(&self, path: &str, size: u64) -> Result<(u64, bool), String> {
        let file_path = Path::new(path);

        // 检查路径是否存在
        if !file_path.exists() {
            return Err("文件不存在".to_string());
        }

        // 安全检查第1层：检查是否为受保护路径
        if self.is_protected_path(file_path) {
            return Err("系统保护路径，禁止删除".to_string());
        }

        // 安全检查第2层：检查是否在允许删除的范围内
        if !self.is_in_allowed_scope(file_path) {
            warn!("路径不在允许删除范围内: {}", path);
        }

        // 尝试删除
        if file_path.is_dir() {
            self.delete_directory(file_path, size)
        } else {
            self.delete_file(file_path, size)
        }
    }

    /// 删除文件，返回 (大小, 是否标记为重启删除)
    fn delete_file(&self, path: &Path, size: u64) -> Result<(u64, bool), String> {
        // 尝试删除文件
        match fs::remove_file(path) {
            Ok(_) => Ok((size, false)),
            Err(e) => {
                // 检查是否是权限问题或文件正在使用
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    // 尝试移除只读属性后再删除
                    if let Ok(metadata) = fs::metadata(path) {
                        let mut permissions = metadata.permissions();
                        #[allow(clippy::permissions_set_readonly_false)]
                        permissions.set_readonly(false);
                        if fs::set_permissions(path, permissions).is_ok() {
                            if fs::remove_file(path).is_ok() {
                                return Ok((size, false));
                            }
                        }
                    }
                    Err(format!("权限不足: {}", e))
                } else {
                    // 检测共享冲突（错误码 32，ERROR_SHARING_VIOLATION），
                    // 文件正被其他进程使用时无法直接删除，标记为重启后删除
                    #[cfg(windows)]
                    let is_sharing_violation = e.raw_os_error() == Some(32); // ERROR_SHARING_VIOLATION
                    #[cfg(not(windows))]
                    let is_sharing_violation = false;

                    if is_sharing_violation && self.is_in_allowed_scope(path) {
                        // 调用 MoveFileExW 标记为重启删除
                        #[cfg(windows)]
                        {
                            let path_str = path.to_string_lossy();
                            match super::enhanced_delete::windows_api::mark_for_delete_on_reboot(
                                &path_str,
                            ) {
                                Ok(_) => {
                                    info!("文件已标记为重启删除: {}", path_str);
                                    return Ok((size, true)); // 标记成功，重启后删除
                                }
                                Err(mark_err) => {
                                    warn!("标记重启删除失败: {} - {}", path_str, mark_err);
                                }
                            }
                        }
                        Err(format!("文件被系统占用: {}", e))
                    } else {
                        Err(format!("删除失败: {}", e))
                    }
                }
            }
        }
    }

    /// 删除目录，返回 (大小, 是否标记为重启删除)
    fn delete_directory(&self, path: &Path, size: u64) -> Result<(u64, bool), String> {
        match fs::remove_dir_all(path) {
            Ok(_) => Ok((size, false)),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::PermissionDenied {
                    Err(format!("权限不足: {}", e))
                } else {
                    Err(format!("删除目录失败: {}", e))
                }
            }
        }
    }

    /// 获取路径大小
    fn get_path_size(&self, path: &Path) -> u64 {
        if path.is_file() {
            fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        } else if path.is_dir() {
            walkdir::WalkDir::new(path)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum()
        } else {
            0
        }
    }

    /// 检查是否为受保护的路径（多层安全检查）
    fn is_protected_path(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();

        // 第1层：检查路径前缀
        for protected in PROTECTED_PATH_PREFIXES {
            if path_str.starts_with(protected) && !is_rebuildable_system_cache_path(&path_str) {
                error!("安全拦截: 尝试删除受保护路径 {}", path_str);
                return true;
            }
        }

        // 第2层：检查文件名
        if let Some(file_name) = path.file_name() {
            let name = file_name.to_string_lossy().to_lowercase();
            for protected in PROTECTED_FILES {
                if name == *protected {
                    error!("安全拦截: 尝试删除系统关键文件 {}", name);
                    return true;
                }
            }
        }

        // 第3层：在Windows目录下保护特定扩展名
        if path_str.contains("\\windows\\") {
            if let Some(ext) = path.extension() {
                let ext_str = ext.to_string_lossy().to_lowercase();
                if PROTECTED_EXTENSIONS_IN_WINDOWS.contains(&ext_str.as_str()) {
                    error!("安全拦截: 尝试删除Windows目录下的系统文件 {}", path_str);
                    return true;
                }
            }
        }

        // 第4层：检查是否是用户配置文件夹的根目录
        let user_critical_paths = [
            "\\appdata\\local",
            "\\appdata\\roaming",
            "\\documents",
            "\\desktop",
            "\\downloads",
        ];
        for critical in &user_critical_paths {
            // 只保护根目录，不保护子目录
            if path_str.ends_with(critical) {
                error!("安全拦截: 尝试删除用户关键目录 {}", path_str);
                return true;
            }
        }

        // 第5层：检查是否是驱动器根目录
        if path_str.len() <= 3 && path_str.ends_with("\\") {
            error!("安全拦截: 尝试删除驱动器根目录 {}", path_str);
            return true;
        }

        false
    }

    /// 验证路径是否在允许删除的范围内
    fn is_in_allowed_scope(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();

        // 允许删除的路径范围
        let allowed_scopes = [
            "\\temp",
            "\\tmp",
            "\\cache",
            "\\caches",
            "\\temporary",
            "\\appdata\\local\\temp",
            "\\appdata\\local\\microsoft\\windows\\temporary",
            "\\appdata\\local\\microsoft\\windows\\inetcache",
            "\\appdata\\local\\microsoft\\windows\\explorer", // 缩略图缓存
            "\\windows\\temp",
            "\\windows\\prefetch",
            "\\windows\\softwaredistribution\\download",
            "\\windows\\softwaredistribution\\deliveryoptimization",
            "\\deliveryoptimization\\",
            "\\programdata\\microsoft\\windows defender\\localcopy",
            "\\programdata\\microsoft\\windows defender\\support",
            "\\d3d_cache",
            "\\$recycle.bin", // 回收站内容
            "\\.log",
            "\\.tmp",
            "\\.bak",
            "\\crash",
            "\\dumps",
        ];

        for scope in &allowed_scopes {
            if path_str.contains(scope) {
                return true;
            }
        }

        // 检查文件扩展名是否在允许列表
        if let Some(ext) = path.extension() {
            let ext_str = ext.to_string_lossy().to_lowercase();
            let allowed_exts = ["tmp", "temp", "log", "bak", "old", "dmp", "etl"];
            if allowed_exts.contains(&ext_str.as_str()) {
                return true;
            }
        }

        false
    }
}

impl Default for DeleteEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protected_paths() {
        let engine = DeleteEngine::new();

        assert!(engine.is_protected_path(Path::new("C:\\Windows\\System32\\test.dll")));
        assert!(engine.is_protected_path(Path::new("C:\\Program Files\\App")));
        // 只有 Windows 清理向导明确列出的可重建缓存子目录可以穿过系统目录保护。
        assert!(
            !engine.is_protected_path(Path::new("C:\\Windows\\System32\\d3d_cache\\shader.bin"))
        );
        assert!(!engine.is_protected_path(Path::new(
            "C:\\ProgramData\\Microsoft\\Windows Defender\\Support\\MPLog.log"
        )));
        assert!(engine.is_protected_path(Path::new(
            "C:\\ProgramData\\Microsoft\\Windows Defender\\Quarantine\\entry.bin"
        )));
        assert!(!engine.is_protected_path(Path::new("C:\\Temp\\test.tmp")));
    }
}
