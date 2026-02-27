// ============================================================================
// 增强删除引擎 - 处理锁定文件和权限问题
// 
// 核心功能：
// 1. Take Ownership - 获取文件所有权以删除受保护文件
// 2. Delete on Reboot - 使用 MOVEFILE_DELAY_UNTIL_REBOOT 处理锁定文件
// 3. 物理大小计算 - 返回实际释放的磁盘空间
// 
// 安全机制：
// - 严格的白名单路径检查，只在安全目录执行 Take Ownership
// - 系统关键文件绝对禁止删除
// - 详细的删除结果反馈，包括跳过原因
// ============================================================================

use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};

// ============================================================================
// Windows API 绑定
// ============================================================================

#[cfg(windows)]
mod windows_api {
    use std::ptr;

    // Windows API 常量
    pub const MOVEFILE_DELAY_UNTIL_REBOOT: u32 = 0x00000004;
    pub const MOVEFILE_REPLACE_EXISTING: u32 = 0x00000001;

    // 文件属性常量
    pub const FILE_ATTRIBUTE_READONLY: u32 = 0x00000001;
    pub const FILE_ATTRIBUTE_HIDDEN: u32 = 0x00000002;
    pub const FILE_ATTRIBUTE_SYSTEM: u32 = 0x00000004;

    #[link(name = "kernel32")]
    extern "system" {
        /// 标记文件在重启时删除
        /// 
        /// # 安全说明
        /// 此函数使用 MOVEFILE_DELAY_UNTIL_REBOOT 标志将文件标记为重启时删除。
        /// 这是 Windows 系统存储感知（Storage Sense）处理被锁定文件的标准方式。
        /// 
        /// # 参数
        /// - lpExistingFileName: 要删除的文件路径（宽字符）
        /// - lpNewFileName: 目标路径，设为 NULL 表示删除
        /// - dwFlags: 操作标志，使用 MOVEFILE_DELAY_UNTIL_REBOOT
        pub fn MoveFileExW(
            lpExistingFileName: *const u16,
            lpNewFileName: *const u16,
            dwFlags: u32,
        ) -> i32;

        /// 获取文件属性
        pub fn GetFileAttributesW(lpFileName: *const u16) -> u32;

        /// 设置文件属性
        pub fn SetFileAttributesW(lpFileName: *const u16, dwFileAttributes: u32) -> i32;

        /// 获取最后的错误代码
        pub fn GetLastError() -> u32;

        /// 获取磁盘空闲空间（用于计算簇大小）
        pub fn GetDiskFreeSpaceW(
            lpRootPathName: *const u16,
            lpSectorsPerCluster: *mut u32,
            lpBytesPerSector: *mut u32,
            lpNumberOfFreeClusters: *mut u32,
            lpTotalNumberOfClusters: *mut u32,
        ) -> i32;
    }

    /// 将 Rust 字符串转换为 Windows 宽字符串
    pub fn to_wide_string(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 标记文件在重启时删除
    /// 
    /// # 中文说明
    /// 此函数使用 Windows API MoveFileExW 配合 MOVEFILE_DELAY_UNTIL_REBOOT 标志，
    /// 将被锁定的文件标记为"重启时删除"。这是 Windows 系统存储感知处理顽固文件的标准方式。
    /// 
    /// 工作原理：
    /// 1. 调用 MoveFileExW，目标路径设为 NULL
    /// 2. Windows 将此操作记录到注册表 PendingFileRenameOperations
    /// 3. 下次系统启动时，在用户登录前执行删除操作
    /// 
    /// 安全考虑：
    /// - 只对已通过安全检查的文件执行此操作
    /// - 系统关键文件绝对禁止使用此功能
    /// - 用户会收到"需要重启完成清理"的提示
    pub fn mark_for_delete_on_reboot(path: &str) -> Result<(), String> {
        let wide_path = to_wide_string(path);
        
        unsafe {
            let result = MoveFileExW(
                wide_path.as_ptr(),
                ptr::null(),  // NULL 表示删除而非移动
                MOVEFILE_DELAY_UNTIL_REBOOT,
            );

            if result != 0 {
                Ok(())
            } else {
                let error_code = GetLastError();
                Err(format!("标记重启删除失败，错误代码: {}", error_code))
            }
        }
    }

    /// 移除文件的只读、隐藏、系统属性
    pub fn remove_protection_attributes(path: &str) -> Result<(), String> {
        let wide_path = to_wide_string(path);
        
        unsafe {
            let attrs = GetFileAttributesW(wide_path.as_ptr());
            if attrs == u32::MAX {
                return Err("无法获取文件属性".to_string());
            }

            // 移除只读、隐藏、系统属性
            let new_attrs = attrs & !(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
            
            if new_attrs != attrs {
                let result = SetFileAttributesW(wide_path.as_ptr(), new_attrs);
                if result == 0 {
                    return Err("无法修改文件属性".to_string());
                }
            }
        }
        
        Ok(())
    }

    /// 获取磁盘簇大小（用于计算物理占用）
    pub fn get_cluster_size(root_path: &str) -> Option<u32> {
        let wide_path = to_wide_string(root_path);
        let mut sectors_per_cluster: u32 = 0;
        let mut bytes_per_sector: u32 = 0;
        let mut free_clusters: u32 = 0;
        let mut total_clusters: u32 = 0;

        unsafe {
            let result = GetDiskFreeSpaceW(
                wide_path.as_ptr(),
                &mut sectors_per_cluster,
                &mut bytes_per_sector,
                &mut free_clusters,
                &mut total_clusters,
            );

            if result != 0 {
                Some(sectors_per_cluster * bytes_per_sector)
            } else {
                None
            }
        }
    }
}

// ============================================================================
// 删除结果类型
// ============================================================================

/// 删除失败的原因分类
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DeleteFailureReason {
    /// 文件不存在
    NotFound,
    /// 权限不足
    PermissionDenied,
    /// 文件被锁定（正在使用）
    FileLocked,
    /// 系统保护文件
    SystemProtected,
    /// 路径不在允许范围
    OutOfScope,
    /// 已标记为重启时删除
    MarkedForReboot,
    /// 其他错误
    Other(String),
}

impl DeleteFailureReason {
    /// 获取用户友好的中文描述
    pub fn display_message(&self) -> &str {
        match self {
            Self::NotFound => "文件不存在",
            Self::PermissionDenied => "权限不足",
            Self::FileLocked => "文件被系统占用",
            Self::SystemProtected => "系统保护文件",
            Self::OutOfScope => "不在清理范围内",
            Self::MarkedForReboot => "已标记重启后删除",
            Self::Other(_) => "删除失败",
        }
    }

    /// 获取详细的提示信息（用于 tooltip）
    pub fn tooltip(&self) -> &str {
        match self {
            Self::NotFound => "该文件可能已被其他程序删除",
            Self::PermissionDenied => "需要管理员权限才能删除此文件",
            Self::FileLocked => "该文件正被系统或其他程序使用，将在重启后删除",
            Self::SystemProtected => "这是系统关键文件，删除可能导致系统不稳定",
            Self::OutOfScope => "该文件不在安全清理范围内",
            Self::MarkedForReboot => "文件已标记，将在下次重启时自动删除",
            Self::Other(msg) => msg.as_str(),
        }
    }
}

/// 单个文件的删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDeleteResult {
    /// 文件路径
    pub path: String,
    /// 是否成功删除
    pub success: bool,
    /// 逻辑大小（文件实际内容大小）
    pub logical_size: u64,
    /// 物理大小（实际占用磁盘空间，按簇对齐）
    pub physical_size: u64,
    /// 失败原因（如果失败）
    pub failure_reason: Option<DeleteFailureReason>,
    /// 是否标记为重启删除
    pub marked_for_reboot: bool,
}

/// 增强版删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhancedDeleteResult {
    /// 成功删除的文件数
    pub success_count: usize,
    /// 失败的文件数
    pub failed_count: usize,
    /// 标记为重启删除的文件数
    pub reboot_pending_count: usize,
    /// 实际释放的物理空间（字节）
    pub freed_physical_size: u64,
    /// 逻辑大小总计（用于对比）
    pub freed_logical_size: u64,
    /// 跳过的文件大小（因错误未能删除）
    pub skipped_size: u64,
    /// 详细的文件删除结果
    pub file_results: Vec<FileDeleteResult>,
    /// 是否需要重启完成清理
    pub needs_reboot: bool,
    /// 汇总消息（WeChat 风格）
    pub summary_message: String,
}

impl EnhancedDeleteResult {
    pub fn new() -> Self {
        Self {
            success_count: 0,
            failed_count: 0,
            reboot_pending_count: 0,
            freed_physical_size: 0,
            freed_logical_size: 0,
            skipped_size: 0,
            file_results: Vec::new(),
            needs_reboot: false,
            summary_message: String::new(),
        }
    }

    /// 生成 WeChat 风格的汇总消息
    pub fn generate_summary(&mut self) {
        let freed_mb = self.freed_physical_size as f64 / 1024.0 / 1024.0;
        let skipped_mb = self.skipped_size as f64 / 1024.0 / 1024.0;

        let mut parts = Vec::new();

        // 成功释放部分
        if self.freed_physical_size > 0 {
            if freed_mb >= 1024.0 {
                parts.push(format!("成功释放 {:.1} GB", freed_mb / 1024.0));
            } else if freed_mb >= 1.0 {
                parts.push(format!("成功释放 {:.1} MB", freed_mb));
            } else {
                parts.push(format!("成功释放 {:.0} KB", freed_mb * 1024.0));
            }
        }

        // 跳过部分
        if self.skipped_size > 0 {
            if skipped_mb >= 1.0 {
                parts.push(format!("{:.1} MB 因系统占用跳过", skipped_mb));
            } else {
                parts.push(format!("{:.0} KB 因系统占用跳过", skipped_mb * 1024.0));
            }
        }

        // 重启待删除部分
        if self.reboot_pending_count > 0 {
            parts.push(format!("{} 个文件将在重启后删除", self.reboot_pending_count));
        }

        self.summary_message = if parts.is_empty() {
            "没有文件被清理".to_string()
        } else {
            parts.join("，")
        };
    }
}

impl Default for EnhancedDeleteResult {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 增强删除引擎
// ============================================================================

/// 允许执行 Take Ownership 的安全目录
/// 
/// # 中文说明
/// 只有在这些目录下的文件才允许执行"获取所有权"操作。
/// 这是为了防止误操作导致系统文件被删除。
const SAFE_OWNERSHIP_PATHS: &[&str] = &[
    "\\temp",
    "\\tmp",
    "\\cache",
    "\\caches",
    "\\appdata\\local\\temp",
    "\\appdata\\local\\microsoft\\windows\\temporary internet files",
    "\\appdata\\local\\microsoft\\windows\\inetcache",
    "\\appdata\\local\\microsoft\\windows\\explorer",
    "\\windows\\temp",
    "\\windows\\prefetch",
    "\\windows\\softwaredistribution\\download",
    "\\$recycle.bin",
];

/// 增强删除引擎
pub struct EnhancedDeleteEngine {
    /// 磁盘簇大小缓存
    cluster_size: u32,
    /// 是否启用重启删除功能
    enable_reboot_delete: bool,
    /// 是否尝试获取所有权
    enable_take_ownership: bool,
}

impl EnhancedDeleteEngine {
    /// 创建新的增强删除引擎
    pub fn new() -> Self {
        // 获取 C 盘簇大小，默认 4096 字节
        let cluster_size = windows_api::get_cluster_size("C:\\").unwrap_or(4096);
        
        Self {
            cluster_size,
            enable_reboot_delete: true,
            enable_take_ownership: true,
        }
    }

    /// 设置是否启用重启删除
    pub fn with_reboot_delete(mut self, enabled: bool) -> Self {
        self.enable_reboot_delete = enabled;
        self
    }

    /// 设置是否启用获取所有权
    pub fn with_take_ownership(mut self, enabled: bool) -> Self {
        self.enable_take_ownership = enabled;
        self
    }

    /// 计算文件的物理占用大小（按簇对齐）
    /// 
    /// # 中文说明
    /// 文件在磁盘上的实际占用空间是按簇（cluster）分配的。
    /// 例如，一个 1 字节的文件在 4KB 簇大小的磁盘上实际占用 4KB。
    /// 这个函数返回文件实际释放的磁盘空间，而非文件内容大小。
    pub fn calculate_physical_size(&self, logical_size: u64) -> u64 {
        if logical_size == 0 {
            return 0;
        }
        let cluster_size = self.cluster_size as u64;
        ((logical_size + cluster_size - 1) / cluster_size) * cluster_size
    }

    /// 删除文件列表
    pub fn delete_files(&self, paths: &[String]) -> EnhancedDeleteResult {
        let mut result = EnhancedDeleteResult::new();
        
        info!("增强删除引擎：开始删除 {} 个文件", paths.len());

        for path in paths {
            let file_result = self.delete_single_file(path);
            
            match &file_result.failure_reason {
                None => {
                    result.success_count += 1;
                    result.freed_logical_size += file_result.logical_size;
                    result.freed_physical_size += file_result.physical_size;
                }
                Some(DeleteFailureReason::MarkedForReboot) => {
                    result.reboot_pending_count += 1;
                    result.needs_reboot = true;
                }
                Some(_) => {
                    result.failed_count += 1;
                    result.skipped_size += file_result.physical_size;
                }
            }
            
            result.file_results.push(file_result);
        }

        result.generate_summary();
        
        info!(
            "增强删除完成: 成功 {}, 失败 {}, 待重启 {}, 释放 {} 字节",
            result.success_count,
            result.failed_count,
            result.reboot_pending_count,
            result.freed_physical_size
        );

        result
    }

    /// 删除单个文件
    fn delete_single_file(&self, path: &str) -> FileDeleteResult {
        let file_path = Path::new(path);
        
        // 获取文件大小
        let logical_size = self.get_file_size(file_path);
        let physical_size = self.calculate_physical_size(logical_size);

        // 检查文件是否存在
        if !file_path.exists() {
            return FileDeleteResult {
                path: path.to_string(),
                success: false,
                logical_size,
                physical_size,
                failure_reason: Some(DeleteFailureReason::NotFound),
                marked_for_reboot: false,
            };
        }

        // 安全检查
        if self.is_system_protected(file_path) {
            return FileDeleteResult {
                path: path.to_string(),
                success: false,
                logical_size,
                physical_size,
                failure_reason: Some(DeleteFailureReason::SystemProtected),
                marked_for_reboot: false,
            };
        }

        // 尝试删除
        match self.try_delete(file_path) {
            Ok(_) => {
                debug!("成功删除: {}", path);
                FileDeleteResult {
                    path: path.to_string(),
                    success: true,
                    logical_size,
                    physical_size,
                    failure_reason: None,
                    marked_for_reboot: false,
                }
            }
            Err(e) => {
                // 判断错误类型
                let is_locked = e.contains("正在使用") || 
                               e.contains("被另一个进程") ||
                               e.contains("sharing violation") ||
                               e.contains("access is denied");

                if is_locked && self.enable_reboot_delete {
                    // 尝试标记为重启删除
                    if self.is_safe_for_ownership(file_path) {
                        match windows_api::mark_for_delete_on_reboot(path) {
                            Ok(_) => {
                                info!("文件已标记为重启删除: {}", path);
                                return FileDeleteResult {
                                    path: path.to_string(),
                                    success: false,
                                    logical_size,
                                    physical_size,
                                    failure_reason: Some(DeleteFailureReason::MarkedForReboot),
                                    marked_for_reboot: true,
                                };
                            }
                            Err(mark_err) => {
                                warn!("标记重启删除失败: {} - {}", path, mark_err);
                            }
                        }
                    }
                    
                    FileDeleteResult {
                        path: path.to_string(),
                        success: false,
                        logical_size,
                        physical_size,
                        failure_reason: Some(DeleteFailureReason::FileLocked),
                        marked_for_reboot: false,
                    }
                } else if e.contains("权限") || e.contains("permission") {
                    FileDeleteResult {
                        path: path.to_string(),
                        success: false,
                        logical_size,
                        physical_size,
                        failure_reason: Some(DeleteFailureReason::PermissionDenied),
                        marked_for_reboot: false,
                    }
                } else {
                    FileDeleteResult {
                        path: path.to_string(),
                        success: false,
                        logical_size,
                        physical_size,
                        failure_reason: Some(DeleteFailureReason::Other(e)),
                        marked_for_reboot: false,
                    }
                }
            }
        }
    }

    /// 尝试删除文件（多策略）
    fn try_delete(&self, path: &Path) -> Result<(), String> {
        // 策略1：直接删除
        if let Ok(_) = self.direct_delete(path) {
            return Ok(());
        }

        // 策略2：移除保护属性后删除
        if let Ok(_) = self.delete_after_remove_attrs(path) {
            return Ok(());
        }

        // 策略3：获取所有权后删除（仅限安全目录）
        if self.enable_take_ownership && self.is_safe_for_ownership(path) {
            if let Ok(_) = self.delete_with_ownership(path) {
                return Ok(());
            }
        }

        // 所有策略都失败
        Err(self.get_last_error_message(path))
    }

    /// 直接删除
    fn direct_delete(&self, path: &Path) -> io::Result<()> {
        if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
    }

    /// 移除保护属性后删除
    fn delete_after_remove_attrs(&self, path: &Path) -> Result<(), String> {
        let path_str = path.to_string_lossy();
        
        // 移除只读等属性
        windows_api::remove_protection_attributes(&path_str)?;
        
        // 再次尝试删除
        self.direct_delete(path)
            .map_err(|e| format!("移除属性后仍无法删除: {}", e))
    }

    /// 获取所有权后删除
    /// 
    /// # 中文说明
    /// 使用 icacls 命令获取文件所有权，然后删除。
    /// 这相当于在资源管理器中右键 -> 属性 -> 安全 -> 高级 -> 更改所有者。
    /// 
    /// 安全考虑：
    /// - 只在 SAFE_OWNERSHIP_PATHS 列表中的目录执行
    /// - 不会对系统关键文件执行此操作
    fn delete_with_ownership(&self, path: &Path) -> Result<(), String> {
        let path_str = path.to_string_lossy();
        
        info!("尝试获取所有权: {}", path_str);

        // 使用 icacls 获取所有权
        // icacls "path" /setowner "%username%" /T /C /Q
        let output = Command::new("icacls")
            .arg(&*path_str)
            .arg("/setowner")
            .arg("Administrators")
            .arg("/T")  // 递归
            .arg("/C")  // 继续处理错误
            .arg("/Q")  // 静默模式
            .output()
            .map_err(|e| format!("执行 icacls 失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("icacls 获取所有权失败: {}", stderr);
        }

        // 授予完全控制权限
        let output = Command::new("icacls")
            .arg(&*path_str)
            .arg("/grant")
            .arg("Administrators:F")
            .arg("/T")
            .arg("/C")
            .arg("/Q")
            .output()
            .map_err(|e| format!("执行 icacls 授权失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("icacls 授权失败: {}", stderr);
        }

        // 再次尝试删除
        self.direct_delete(path)
            .map_err(|e| format!("获取所有权后仍无法删除: {}", e))
    }

    /// 检查路径是否安全执行 Take Ownership
    fn is_safe_for_ownership(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        
        for safe_path in SAFE_OWNERSHIP_PATHS {
            if path_str.contains(safe_path) {
                return true;
            }
        }
        
        false
    }

    /// 检查是否为系统保护文件
    fn is_system_protected(&self, path: &Path) -> bool {
        let path_str = path.to_string_lossy().to_lowercase();
        
        // 系统关键路径
        let protected_prefixes = [
            "c:\\windows\\system32",
            "c:\\windows\\syswow64",
            "c:\\windows\\winsxs",
            "c:\\program files",
            "c:\\program files (x86)",
        ];

        for prefix in &protected_prefixes {
            if path_str.starts_with(prefix) {
                return true;
            }
        }

        // 系统关键文件
        let protected_files = [
            "ntoskrnl.exe", "hal.dll", "ntdll.dll", "kernel32.dll",
            "bootmgr", "pagefile.sys", "hiberfil.sys", "swapfile.sys",
        ];

        if let Some(file_name) = path.file_name() {
            let name = file_name.to_string_lossy().to_lowercase();
            for protected in &protected_files {
                if name == *protected {
                    return true;
                }
            }
        }

        false
    }

    /// 获取文件大小
    fn get_file_size(&self, path: &Path) -> u64 {
        if path.is_file() {
            fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        } else if path.is_dir() {
            self.calculate_dir_size(path)
        } else {
            0
        }
    }

    /// 计算目录大小
    fn calculate_dir_size(&self, path: &Path) -> u64 {
        walkdir::WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }

    /// 获取最后的错误信息
    fn get_last_error_message(&self, path: &Path) -> String {
        match fs::metadata(path) {
            Ok(_) => "文件被锁定或正在使用".to_string(),
            Err(e) => format!("{}", e),
        }
    }
}

impl Default for EnhancedDeleteEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_physical_size_calculation() {
        let engine = EnhancedDeleteEngine::new();
        
        // 假设簇大小为 4096
        assert_eq!(engine.calculate_physical_size(1), 4096);
        assert_eq!(engine.calculate_physical_size(4096), 4096);
        assert_eq!(engine.calculate_physical_size(4097), 8192);
        assert_eq!(engine.calculate_physical_size(0), 0);
    }

    #[test]
    fn test_safe_ownership_check() {
        let engine = EnhancedDeleteEngine::new();
        
        assert!(engine.is_safe_for_ownership(Path::new("C:\\Windows\\Temp\\test.tmp")));
        assert!(engine.is_safe_for_ownership(Path::new("C:\\Users\\Test\\AppData\\Local\\Temp\\file.log")));
        assert!(!engine.is_safe_for_ownership(Path::new("C:\\Windows\\System32\\test.dll")));
    }

    #[test]
    fn test_system_protected_check() {
        let engine = EnhancedDeleteEngine::new();
        
        assert!(engine.is_system_protected(Path::new("C:\\Windows\\System32\\ntdll.dll")));
        assert!(engine.is_system_protected(Path::new("C:\\pagefile.sys")));
        assert!(!engine.is_system_protected(Path::new("C:\\Temp\\test.tmp")));
    }
}
