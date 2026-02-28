// ============================================================================
// 永久删除引擎 - 卸载残留深度清理
// 
// ⚠️ 警告：此模块执行直接物理删除，数据不可恢复！
// 
// 【核心功能】
// 直接使用 std::fs::remove_dir_all 和 std::fs::remove_file 从磁盘永久删除文件，
// 而非移动到回收站。这是为了彻底清理已卸载软件的残留数据。
// 
// 【为什么需要检查 .exe 文件？】
// 在删除前检查文件夹内是否存在 .exe/.dll/.sys 文件至关重要，原因如下：
// 1. 便携软件（Portable Apps）：用户可能将便携软件放在 AppData 目录下运行，
//    这些软件没有安装记录，但仍在正常使用中。
// 2. 自启动程序：某些程序的可执行文件可能存放在 AppData 中并设置了自启动。
// 3. 系统组件：部分系统服务的 DLL 文件可能存放在扫描目录中。
// 4. 驱动文件：.sys 文件是内核驱动，误删可能导致系统崩溃。
// 
// 如果检测到这些文件，我们将跳过该文件夹并标记为"需要人工审核"，
// 让用户自行决定是否删除，从而避免误删正在使用的软件。
// 
// 【三重安全检查协议】
// Check 1: 注册表缺失验证 - 确认目录名不在任何已安装程序的注册表项中
// Check 2: 可执行文件检查 - 扫描 .exe/.dll/.sys 文件，发现则跳过
// Check 3: 核心白名单检查 - 确保路径不在系统关键目录内
// 
// 【错误处理】
// - 所有 IO 操作都包裹在 Result 中
// - 文件锁定时自动切换到"重启后删除"队列
// - 权限不足时尝试获取所有权后重试
// ============================================================================

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use log::{debug, info, warn};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use winreg::enums::*;
use winreg::RegKey;

#[cfg(windows)]
use crate::cleaner::enhanced_delete::windows_api;

// ============================================================================
// 安全检查结果类型
// ============================================================================

/// 安全检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SafetyCheckResult {
    /// 通过所有检查，可以安全删除
    Safe,
    /// 在注册表中找到匹配项（Check 1 失败）
    FoundInRegistry { matched_field: String, matched_value: String },
    /// 发现可执行文件（Check 2 失败）
    ContainsExecutables { files: Vec<String> },
    /// 路径在系统保护目录内（Check 3 失败）
    InProtectedPath { reason: String },
}

impl SafetyCheckResult {
    pub fn is_safe(&self) -> bool {
        matches!(self, SafetyCheckResult::Safe)
    }

    pub fn display_message(&self) -> String {
        match self {
            SafetyCheckResult::Safe => "安全".to_string(),
            SafetyCheckResult::FoundInRegistry { matched_field, matched_value } => {
                format!("注册表中存在匹配: {} = {}", matched_field, matched_value)
            }
            SafetyCheckResult::ContainsExecutables { files } => {
                let count = files.len();
                let preview: Vec<_> = files.iter().take(3).cloned().collect();
                if count > 3 {
                    format!("包含 {} 个可执行文件: {} 等", count, preview.join(", "))
                } else {
                    format!("包含可执行文件: {}", preview.join(", "))
                }
            }
            SafetyCheckResult::InProtectedPath { reason } => {
                format!("系统保护路径: {}", reason)
            }
        }
    }
}

/// 单个残留的删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeftoverDeleteResult {
    /// 文件夹路径
    pub path: String,
    /// 是否成功删除
    pub success: bool,
    /// 删除的文件数量
    pub deleted_files: u32,
    /// 释放的空间（字节）
    pub freed_size: u64,
    /// 失败原因
    pub failure_reason: Option<String>,
    /// 是否标记为重启删除
    pub marked_for_reboot: bool,
    /// 是否需要人工审核
    pub needs_manual_review: bool,
    /// 安全检查结果
    pub safety_check: SafetyCheckResult,
}

/// 永久删除的总体结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermanentDeleteResult {
    /// 成功删除的文件夹数
    pub success_count: usize,
    /// 失败的文件夹数
    pub failed_count: usize,
    /// 需要人工审核的数量
    pub manual_review_count: usize,
    /// 标记为重启删除的数量
    pub reboot_pending_count: usize,
    /// 实际释放的空间（字节）
    pub freed_size: u64,
    /// 各文件夹的详细结果
    pub details: Vec<LeftoverDeleteResult>,
    /// 删除耗时（毫秒）
    pub duration_ms: u64,
}

// ============================================================================
// 核心白名单 - 绝对禁止删除的系统路径
// ============================================================================

/// 系统核心保护路径（Check 3）
/// 这些路径下的任何内容都不允许通过本模块删除
const PROTECTED_PATHS: &[&str] = &[
    // Windows 系统目录
    r"C:\Windows",
    r"C:\Windows\System32",
    r"C:\Windows\SysWOW64",
    r"C:\Windows\WinSxS",
    
    // 用户关键目录
    r"\Desktop",
    r"\Documents",
    r"\Downloads",
    r"\Pictures",
    r"\Videos",
    r"\Music",
    
    // 系统根目录
    r"C:\Program Files",
    r"C:\Program Files (x86)",
    r"C:\ProgramData\Microsoft",
    
    // 引导相关
    r"C:\Boot",
    r"C:\Recovery",
    r"C:\$Recycle.Bin",
    r"C:\System Volume Information",
];

/// 可执行文件扩展名（Check 2）
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe", "dll", "sys", "drv", "ocx", "cpl", "scr",
];

// ============================================================================
// 永久删除引擎
// ============================================================================

/// 永久删除引擎
/// 
/// 【中文说明】
/// 此引擎负责执行卸载残留的深度清理。与普通删除不同，它直接从磁盘物理删除文件，
/// 不经过回收站，因此数据不可恢复。
/// 
/// 为确保安全，每次删除前都会执行"三重安全检查协议"：
/// 1. 注册表检查：确认目标不是已安装程序的一部分
/// 2. 可执行文件检查：确认目标不包含正在使用的程序
/// 3. 白名单检查：确认目标不在系统关键路径内
pub struct PermanentDeleteEngine {
    /// 已安装程序信息缓存（用于 Check 1）
    installed_apps_cache: HashSet<String>,
    /// 是否启用重启删除回退
    enable_reboot_fallback: bool,
}

impl PermanentDeleteEngine {
    /// 创建新的永久删除引擎
    pub fn new() -> Self {
        let installed_apps_cache = Self::load_installed_apps();
        info!("永久删除引擎初始化完成，已加载 {} 个已安装程序信息", installed_apps_cache.len());
        
        PermanentDeleteEngine {
            installed_apps_cache,
            enable_reboot_fallback: true,
        }
    }

    /// 从注册表加载已安装程序信息
    fn load_installed_apps() -> HashSet<String> {
        let mut apps = HashSet::new();
        
        let paths = [
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        ];

        for (hkey, path) in paths {
            if let Ok(key) = RegKey::predef(hkey).open_subkey_with_flags(path, KEY_READ) {
                for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
                    if let Ok(subkey) = key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                        // 读取 DisplayName
                        if let Ok(display_name) = subkey.get_value::<String, _>("DisplayName") {
                            apps.insert(display_name.to_lowercase());
                        }
                        // 读取 InstallLocation
                        if let Ok(install_loc) = subkey.get_value::<String, _>("InstallLocation") {
                            apps.insert(install_loc.to_lowercase());
                            if let Some(folder) = Path::new(&install_loc).file_name() {
                                apps.insert(folder.to_string_lossy().to_lowercase());
                            }
                        }
                        // 读取 Publisher
                        if let Ok(publisher) = subkey.get_value::<String, _>("Publisher") {
                            apps.insert(publisher.to_lowercase());
                        }
                    }
                }
            }
        }

        apps
    }

    // ========================================================================
    // 三重安全检查协议
    // ========================================================================

    /// 执行完整的三重安全检查
    /// 
    /// 【中文说明】
    /// 此函数依次执行三项安全检查，任何一项失败都会阻止删除操作。
    /// 这是保护用户数据安全的核心机制。
    pub fn perform_safety_checks(&self, path: &Path) -> SafetyCheckResult {
        let path_str = path.to_string_lossy().to_string();
        let folder_name = path.file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        // ====================================================================
        // Check 3: 核心白名单检查（最先执行，最严格）
        // ====================================================================
        if let Some(reason) = self.check_protected_path(&path_str) {
            return SafetyCheckResult::InProtectedPath { reason };
        }

        // ====================================================================
        // Check 1: 注册表缺失验证
        // ====================================================================
        if let Some((field, value)) = self.check_registry_presence(&folder_name) {
            return SafetyCheckResult::FoundInRegistry {
                matched_field: field,
                matched_value: value,
            };
        }

        // ====================================================================
        // Check 2: 可执行文件检查
        // ====================================================================
        let executables = self.scan_executables(path);
        if !executables.is_empty() {
            return SafetyCheckResult::ContainsExecutables { files: executables };
        }

        SafetyCheckResult::Safe
    }

    /// Check 1: 检查目录名是否在注册表中存在
    /// 
    /// 【中文说明】
    /// 遍历已安装程序的 DisplayName、InstallLocation、Publisher 字段，
    /// 检查目标文件夹名是否与任何已安装程序相关联。
    fn check_registry_presence(&self, folder_name: &str) -> Option<(String, String)> {
        let folder_lower = folder_name.to_lowercase();
        
        for app in &self.installed_apps_cache {
            // 检查是否包含文件夹名
            if app.contains(&folder_lower) || folder_lower.contains(app.as_str()) {
                // 只有当匹配长度足够时才认为是有效匹配（避免短字符串误匹配）
                if folder_lower.len() >= 4 && app.len() >= 4 {
                    return Some(("已安装程序".to_string(), app.clone()));
                }
            }
        }
        
        None
    }

    /// Check 2: 扫描目录中的可执行文件
    /// 
    /// 【中文说明】
    /// 递归扫描目标目录，查找 .exe、.dll、.sys 等可执行文件。
    /// 发现这些文件意味着该目录可能包含正在使用的软件，需要人工审核。
    fn scan_executables(&self, path: &Path) -> Vec<String> {
        let mut executables = Vec::new();
        
        // 限制扫描深度和数量，避免性能问题
        let max_depth = 5;
        let max_results = 10;
        
        for entry in WalkDir::new(path)
            .max_depth(max_depth)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if executables.len() >= max_results {
                break;
            }
            
            if entry.file_type().is_file() {
                if let Some(ext) = entry.path().extension() {
                    let ext_lower = ext.to_string_lossy().to_lowercase();
                    if EXECUTABLE_EXTENSIONS.contains(&ext_lower.as_str()) {
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        executables.push(file_name);
                    }
                }
            }
        }
        
        executables
    }

    /// Check 3: 检查路径是否在系统保护目录内
    /// 
    /// 【中文说明】
    /// 验证目标路径不在 C:\Windows、桌面、文档等系统关键目录内。
    /// 这是最后一道防线，确保不会误删系统文件。
    fn check_protected_path(&self, path: &str) -> Option<String> {
        let path_lower = path.to_lowercase();
        
        for protected in PROTECTED_PATHS {
            let protected_lower = protected.to_lowercase();
            if path_lower.starts_with(&protected_lower) || path_lower.contains(&protected_lower) {
                return Some(format!("路径包含受保护目录: {}", protected));
            }
        }
        
        // 额外检查：不允许删除驱动器根目录
        if path.len() <= 3 {
            return Some("不允许删除驱动器根目录".to_string());
        }
        
        // 检查是否是用户目录的直接子目录（如 C:\Users\xxx 本身）
        if path_lower.starts_with(r"c:\users\") {
            let parts: Vec<&str> = path.split('\\').collect();
            if parts.len() <= 3 {
                return Some("不允许删除用户根目录".to_string());
            }
        }
        
        None
    }

    // ========================================================================
    // 删除执行
    // ========================================================================

    /// 执行永久删除（并发处理）
    /// 
    /// 【中文说明】
    /// 使用 rayon 线程池并发删除多个目录，确保 UI 保持响应。
    /// 每个目录删除前都会执行三重安全检查。
    pub fn delete_leftovers(&self, paths: Vec<String>) -> PermanentDeleteResult {
        let start_time = std::time::Instant::now();
        
        // 使用原子计数器进行并发统计
        let success_count = AtomicUsize::new(0);
        let failed_count = AtomicUsize::new(0);
        let manual_review_count = AtomicUsize::new(0);
        let reboot_pending_count = AtomicUsize::new(0);
        let freed_size = AtomicU64::new(0);

        // 并发执行删除
        let details: Vec<LeftoverDeleteResult> = paths
            .par_iter()
            .map(|path_str| {
                let path = Path::new(path_str);
                
                // 执行三重安全检查
                let safety_check = self.perform_safety_checks(path);
                
                match &safety_check {
                    SafetyCheckResult::Safe => {
                        // 通过安全检查，执行删除
                        let result = self.delete_single_leftover(path);
                        
                        if result.success {
                            success_count.fetch_add(1, Ordering::Relaxed);
                            freed_size.fetch_add(result.freed_size, Ordering::Relaxed);
                        } else if result.marked_for_reboot {
                            reboot_pending_count.fetch_add(1, Ordering::Relaxed);
                        } else {
                            failed_count.fetch_add(1, Ordering::Relaxed);
                        }
                        
                        result
                    }
                    SafetyCheckResult::ContainsExecutables { .. } => {
                        // 包含可执行文件，标记为需要人工审核
                        manual_review_count.fetch_add(1, Ordering::Relaxed);
                        
                        LeftoverDeleteResult {
                            path: path_str.clone(),
                            success: false,
                            deleted_files: 0,
                            freed_size: 0,
                            failure_reason: Some(safety_check.display_message()),
                            marked_for_reboot: false,
                            needs_manual_review: true,
                            safety_check,
                        }
                    }
                    _ => {
                        // 其他安全检查失败
                        failed_count.fetch_add(1, Ordering::Relaxed);
                        
                        LeftoverDeleteResult {
                            path: path_str.clone(),
                            success: false,
                            deleted_files: 0,
                            freed_size: 0,
                            failure_reason: Some(safety_check.display_message()),
                            marked_for_reboot: false,
                            needs_manual_review: false,
                            safety_check,
                        }
                    }
                }
            })
            .collect();

        let duration_ms = start_time.elapsed().as_millis() as u64;

        info!(
            "永久删除完成: 成功 {}, 失败 {}, 待审核 {}, 待重启 {}, 释放 {} 字节, 耗时 {}ms",
            success_count.load(Ordering::Relaxed),
            failed_count.load(Ordering::Relaxed),
            manual_review_count.load(Ordering::Relaxed),
            reboot_pending_count.load(Ordering::Relaxed),
            freed_size.load(Ordering::Relaxed),
            duration_ms
        );

        PermanentDeleteResult {
            success_count: success_count.load(Ordering::Relaxed),
            failed_count: failed_count.load(Ordering::Relaxed),
            manual_review_count: manual_review_count.load(Ordering::Relaxed),
            reboot_pending_count: reboot_pending_count.load(Ordering::Relaxed),
            freed_size: freed_size.load(Ordering::Relaxed),
            details,
            duration_ms,
        }
    }

    /// 删除单个残留目录
    /// 
    /// 【中文说明】
    /// 此函数执行实际的物理删除操作。首先尝试直接删除，
    /// 如果遇到锁定文件，则自动切换到"重启后删除"队列。
    fn delete_single_leftover(&self, path: &Path) -> LeftoverDeleteResult {
        let path_str = path.to_string_lossy().to_string();
        
        // 先计算目录大小
        let (total_size, file_count) = self.calculate_dir_size(path);
        
        // ====================================================================
        // ⚠️ 警告：以下代码执行永久删除，数据不可恢复！
        // ====================================================================
        
        // 尝试直接删除整个目录
        match self.try_remove_dir_all(path) {
            Ok(()) => {
                info!("成功永久删除: {} ({} 文件, {} 字节)", path_str, file_count, total_size);
                
                LeftoverDeleteResult {
                    path: path_str,
                    success: true,
                    deleted_files: file_count,
                    freed_size: total_size,
                    failure_reason: None,
                    marked_for_reboot: false,
                    needs_manual_review: false,
                    safety_check: SafetyCheckResult::Safe,
                }
            }
            Err(e) => {
                warn!("直接删除失败: {} - {}", path_str, e);
                
                // 尝试重启后删除
                if self.enable_reboot_fallback {
                    if self.mark_for_reboot_delete(path) {
                        return LeftoverDeleteResult {
                            path: path_str,
                            success: false,
                            deleted_files: 0,
                            freed_size: 0,
                            failure_reason: Some("已标记为重启后删除".to_string()),
                            marked_for_reboot: true,
                            needs_manual_review: false,
                            safety_check: SafetyCheckResult::Safe,
                        };
                    }
                }
                
                LeftoverDeleteResult {
                    path: path_str,
                    success: false,
                    deleted_files: 0,
                    freed_size: 0,
                    failure_reason: Some(format!("删除失败: {}", e)),
                    marked_for_reboot: false,
                    needs_manual_review: false,
                    safety_check: SafetyCheckResult::Safe,
                }
            }
        }
    }

    /// 尝试删除整个目录
    /// 
    /// 【中文说明】
    /// 使用 std::fs::remove_dir_all 递归删除目录及其所有内容。
    /// 如果遇到只读文件，会先尝试移除只读属性后重试。
    fn try_remove_dir_all(&self, path: &Path) -> Result<(), String> {
        // ====================================================================
        // ⚠️ 警告：此操作将永久删除磁盘数据，不可恢复！
        // ====================================================================
        
        // 首先尝试直接删除
        match fs::remove_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                debug!("权限不足，尝试移除保护属性后重试: {:?}", path);
            }
            Err(e) => return Err(format!("{}", e)),
        }

        // 尝试移除所有文件的保护属性后重试
        self.remove_all_protection_attributes(path);
        
        // ====================================================================
        // ⚠️ 警告：此操作将永久删除磁盘数据，不可恢复！
        // ====================================================================
        fs::remove_dir_all(path).map_err(|e| format!("{}", e))
    }

    /// 移除目录下所有文件的保护属性
    fn remove_all_protection_attributes(&self, path: &Path) {
        for entry in WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let entry_path = entry.path().to_string_lossy().to_string();
            #[cfg(windows)]
            let _ = windows_api::remove_protection_attributes(&entry_path);
        }
    }

    /// 标记目录为重启后删除
    fn mark_for_reboot_delete(&self, path: &Path) -> bool {
        // 遍历目录中的所有文件，逐个标记
        let mut any_marked = false;
        
        for entry in WalkDir::new(path)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                let file_path = entry.path().to_string_lossy().to_string();
                #[cfg(windows)]
                if windows_api::mark_for_delete_on_reboot(&file_path).is_ok() {
                    any_marked = true;
                }
            }
        }
        
        // 最后标记目录本身
        let path_str = path.to_string_lossy().to_string();
        #[cfg(windows)]
        if windows_api::mark_for_delete_on_reboot(&path_str).is_ok() {
            any_marked = true;
        }
        
        any_marked
    }

    /// 计算目录大小
    fn calculate_dir_size(&self, path: &Path) -> (u64, u32) {
        let mut total_size = 0u64;
        let mut file_count = 0u32;

        for entry in WalkDir::new(path)
            .max_depth(20)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() {
                if let Ok(metadata) = entry.metadata() {
                    total_size += metadata.len();
                    file_count += 1;
                }
            }
        }

        (total_size, file_count)
    }
}

impl Default for PermanentDeleteEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protected_path_check() {
        let engine = PermanentDeleteEngine::new();
        
        // 应该被保护的路径
        assert!(engine.check_protected_path(r"C:\Windows\System32\test").is_some());
        assert!(engine.check_protected_path(r"C:\Users\test\Desktop\file").is_some());
        assert!(engine.check_protected_path(r"C:\").is_some());
        
        // 应该允许的路径
        assert!(engine.check_protected_path(r"C:\Users\test\AppData\Local\SomeApp").is_none());
    }

    #[test]
    fn test_executable_extensions() {
        assert!(EXECUTABLE_EXTENSIONS.contains(&"exe"));
        assert!(EXECUTABLE_EXTENSIONS.contains(&"dll"));
        assert!(EXECUTABLE_EXTENSIONS.contains(&"sys"));
        assert!(!EXECUTABLE_EXTENSIONS.contains(&"txt"));
    }
}
