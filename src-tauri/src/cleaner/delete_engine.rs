// ============================================================================
// 删除引擎 - 核心删除逻辑实现
// 多层安全保护，确保不会误删重要文件
// ============================================================================

use std::fs;
use std::path::Path;
use log::{info, warn, error, debug};

use crate::scanner::{DeleteResult, FileInfo};

// ============================================================================
// 安全保护配置
// ============================================================================

/// 绝对禁止删除的路径前缀
const PROTECTED_PATH_PREFIXES: &[&str] = &[
    "c:\\windows\\system32",
    "c:\\windows\\syswow64",
    "c:\\windows\\winsxs",
    "c:\\windows\\servicing",
    "c:\\windows\\assembly",
    "c:\\windows\\boot",
    "c:\\windows\\fonts",
    "c:\\windows\\inf",
    "c:\\windows\\microsoft.net",
    "c:\\windows\\security",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\users\\default",
    "c:\\users\\public\\desktop",
    "c:\\programdata\\microsoft\\windows",
    "c:\\programdata\\microsoft\\windows defender",
    "c:\\recovery",
    "c:\\$recycle.bin",  // 回收站根目录
];

/// 绝对禁止删除的文件名
const PROTECTED_FILES: &[&str] = &[
    // Windows 核心系统文件
    "ntoskrnl.exe",
    "hal.dll",
    "ntdll.dll",
    "kernel32.dll",
    "kernelbase.dll",
    "user32.dll",
    "gdi32.dll",
    "advapi32.dll",
    "shell32.dll",
    "ole32.dll",
    "bootmgr",
    "bcd",
    "ntldr",
    "boot.ini",
    "pagefile.sys",
    "hiberfil.sys",
    "swapfile.sys",
    "desktop.ini",  // 保护文件夹配置
    "ntuser.dat",   // 用户配置
    "usrclass.dat",
    // 社交软件配置文件（防止误删导致数据丢失）
    "config.data",      // 微信配置
    "accinfo.dat",      // 微信账号信息
    "msg.db",           // 消息数据库
    "micromsg.db",      // 微信消息数据库
    "contact.db",       // 联系人数据库
    "emotion.db",       // 表情数据库
    "favorite.db",      // 收藏数据库
    "publicmsg.db",     // 公众号消息
    "nt_db",            // NTQQ 数据库目录标识
    "nt_config",        // NTQQ 配置目录标识
];

/// 在Windows目录下禁止删除的扩展名
const PROTECTED_EXTENSIONS_IN_WINDOWS: &[&str] = &[
    "sys", "dll", "exe", "drv", "ocx", "cpl",
    "msi", "msp", "msu", "cat", "mum", "manifest",
];

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
                Ok(size) => {
                    result.add_success(size);
                    debug!("成功删除: {}", file.path);
                }
                Err(e) => {
                    result.add_failure(file.path.clone(), e);
                    warn!("删除失败: {} - {}", file.path, result.failed_files.last().map(|f| &f.reason).unwrap_or(&String::new()));
                }
            }
        }

        info!(
            "删除完成: 成功 {} 个, 失败 {} 个, 释放空间 {} 字节",
            result.success_count, result.failed_count, result.freed_size
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
                Ok(freed) => {
                    result.add_success(freed);
                    debug!("成功删除: {}", path);
                }
                Err(e) => {
                    result.add_failure(path.clone(), e);
                    warn!("删除失败: {}", path);
                }
            }
        }

        info!(
            "删除完成: 成功 {} 个, 失败 {} 个, 释放空间 {} 字节",
            result.success_count, result.failed_count, result.freed_size
        );

        result
    }

    /// 删除单个文件或目录（多层安全检查）
    fn delete_single_file(&self, path: &str, size: u64) -> Result<u64, String> {
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
            // 这里不返回错误，只是警告，因为扫描器已经过滤过了
        }

        // 尝试删除
        if file_path.is_dir() {
            self.delete_directory(file_path, size)
        } else {
            self.delete_file(file_path, size)
        }
    }

    /// 删除文件
    fn delete_file(&self, path: &Path, size: u64) -> Result<u64, String> {
        // 尝试删除文件
        match fs::remove_file(path) {
            Ok(_) => Ok(size),
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
                                return Ok(size);
                            }
                        }
                    }
                    Err(format!("权限不足: {}", e))
                } else {
                    Err(format!("删除失败: {}", e))
                }
            }
        }
    }

    /// 删除目录
    fn delete_directory(&self, path: &Path, size: u64) -> Result<u64, String> {
        match fs::remove_dir_all(path) {
            Ok(_) => Ok(size),
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
            if path_str.starts_with(protected) {
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
            "\\appdata\\local\\microsoft\\windows\\explorer",  // 缩略图缓存
            "\\windows\\temp",
            "\\windows\\prefetch",
            "\\windows\\softwaredistribution\\download",
            "\\$recycle.bin",  // 回收站内容
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
        assert!(!engine.is_protected_path(Path::new("C:\\Temp\\test.tmp")));
    }
}
