// ============================================================================
// 注册表路径工具 (Registry Path Utilities)
//
// 提供两个核心工具：
//   1. PathCache    — 路径存在性缓存，避免重复文件系统调用
//   2. PathResolver — 从命令行字符串中提取可执行文件路径、展开环境变量
//   3. is_definitely_safe_to_delete — 硬过滤条件，确认注册表项可安全删除
// ============================================================================

use regex::Regex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ============================================================================
// 1. 路径存在性缓存 (PathCache)
// ============================================================================

/// 路径存在性缓存
///
/// 使用 HashMap 缓存 Path::exists() 的结果，避免重复的文件系统调用。
/// 在同一轮扫描中，相同的路径会被反复引用（如多个 MUI 值引用同一个 exe）。
pub struct PathCache {
    cache: HashMap<String, bool>,
    hits: u64,
    misses: u64,
}

impl PathCache {
    pub fn new() -> Self {
        Self {
            cache: HashMap::with_capacity(256),
            hits: 0,
            misses: 0,
        }
    }

    /// 检查路径是否存在（带缓存）
    pub fn exists(&mut self, path: &str) -> bool {
        if let Some(&exists) = self.cache.get(path) {
            self.hits += 1;
            return exists;
        }
        self.misses += 1;
        let exists = Path::new(path).exists();
        self.cache.insert(path.to_string(), exists);
        exists
    }

    /// 获取缓存统计
    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }
}

impl Default for PathCache {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 2. 路径解析器 (PathResolver)
// ============================================================================

/// 路径解析器
///
/// 处理命令行字符串中的路径提取和环境变量展开。
pub struct PathResolver {
    env_var_re: Regex,
}

impl PathResolver {
    pub fn new() -> Self {
        Self {
            env_var_re: Regex::new(r"%([^%]+)%").unwrap(),
        }
    }

    /// 从命令行字符串中提取并解析可执行文件路径
    ///
    /// 支持格式：
    /// - `"C:\Program Files\App\app.exe" %1`
    /// - `C:\Program Files\App\app.exe %1`
    /// - `%SystemRoot%\system32\notepad.exe %1`
    /// - `"C:\Program Files\App\app.exe",-123`
    /// - `C:\PROGRA~1\App\app.exe`
    ///
    /// 返回 Option<(解析后的路径, 是否在系统目录)>
    pub fn extract_and_resolve(&self, raw_command: &str) -> Option<(PathBuf, bool)> {
        let exe_path = self.extract_exe_path(raw_command)?;
        let resolved = self.expand_env_vars(&exe_path);
        let path = PathBuf::from(&resolved);
        let is_system = self.is_system_path(&resolved);

        Some((path, is_system))
    }

    /// 从命令行字符串中提取可执行文件路径
    fn extract_exe_path(&self, command: &str) -> Option<String> {
        let command = command.trim();

        if command.is_empty() {
            return None;
        }

        // 处理带引号的路径: "C:\path\to\app.exe" args
        if command.starts_with('"') {
            if let Some(end) = command[1..].find('"') {
                let path = &command[1..end + 1];
                if self.looks_like_exe_path(path) {
                    return Some(path.to_string());
                }
            }
        }

        // 处理不带引号的路径: C:\path\to\app.exe args
        let first_token = command.split_whitespace().next()?;
        let cleaned = first_token.trim_end_matches(',');

        if self.looks_like_exe_path(cleaned) {
            Some(cleaned.to_string())
        } else {
            None
        }
    }

    /// 检查是否像可执行文件路径（盘符 + exe/dll/sys 扩展名）
    fn looks_like_exe_path(&self, s: &str) -> bool {
        let lower = s.to_lowercase();
        (lower.ends_with(".exe") || lower.ends_with(".dll") || lower.ends_with(".sys"))
            && lower.len() > 4
            && lower.chars().nth(1) == Some(':') // 盘符
    }

    /// 展开环境变量（如 %SystemRoot%）
    fn expand_env_vars(&self, s: &str) -> String {
        self.env_var_re
            .replace_all(s, |caps: &regex::Captures| {
                let var_name = &caps[1];
                std::env::var(var_name).unwrap_or_else(|_| {
                    match var_name.to_uppercase().as_str() {
                        "SYSTEMROOT" => "C:\\Windows".to_string(),
                        "WINDIR" => "C:\\Windows".to_string(),
                        "PROGRAMFILES" => "C:\\Program Files".to_string(),
                        "PROGRAMFILES(X86)" => "C:\\Program Files (x86)".to_string(),
                        "PROGRAMDATA" => "C:\\ProgramData".to_string(),
                        "USERPROFILE" => "C:\\Users\\Default".to_string(),
                        "APPDATA" => "C:\\Users\\Default\\AppData\\Roaming".to_string(),
                        "LOCALAPPDATA" => "C:\\Users\\Default\\AppData\\Local".to_string(),
                        "TEMP" | "TMP" => "C:\\Windows\\Temp".to_string(),
                        _ => caps[0].to_string(),
                    }
                })
            })
            .to_string()
    }

    /// 检查路径是否在系统目录
    pub fn is_system_path(&self, path: &str) -> bool {
        let lower = path.to_lowercase();
        let system_roots = [
            "c:\\windows\\system32",
            "c:\\windows\\syswow64",
            "c:\\windows\\system",
            "c:\\windows\\winsxs",
            "c:\\windows\\servicing",
            "c:\\windows\\assembly",
        ];

        for root in &system_roots {
            if lower.starts_with(root) {
                return true;
            }
        }

        false
    }
}

impl Default for PathResolver {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 3. 硬过滤条件 (Hard Delete Safety Check)
// ============================================================================

/// 确认注册表项关联的文件路径满足"铁证条件"——可以安全删除
///
/// 【铁证条件】
///   1. 路径非空且能从注册表值中提取到
///   2. 关联文件在磁盘上不存在 (Path.exists == false)
///   3. 路径不在系统目录 (Windows / System32 / SysWOW64)
///   4. 文件名不是系统关键进程 (rundll32.exe / svchost.exe)
///
/// 任何不确定的情况一律返回 false —— 安全优先原则
pub fn is_definitely_safe_to_delete(extracted_path: &str, path_cache: &mut PathCache) -> bool {
    // 条件1：路径非空
    if extracted_path.is_empty() {
        return false;
    }

    // 条件2：文件必须不存在（存在意味着程序可能仍在使用）
    if path_cache.exists(extracted_path) {
        return false;
    }

    // 条件3：路径不能在系统目录
    let lower = extracted_path.to_lowercase();
    let system_dirs = [
        "\\windows\\system32",
        "\\windows\\syswow64",
        "\\windows\\system\\",
        "\\windows\\winsxs",
        "\\windows\\servicing",
        "\\windows\\assembly",
    ];
    for dir in &system_dirs {
        if lower.contains(dir) {
            return false;
        }
    }

    // 条件4：文件名不能是系统关键进程
    let file_name = Path::new(extracted_path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    let file_name_lower = file_name.to_lowercase();
    let system_exes = [
        "rundll32.exe",
        "svchost.exe",
        "explorer.exe",
        "regedit.exe",
        "cmd.exe",
        "powershell.exe",
        "csrss.exe",
        "lsass.exe",
        "services.exe",
        "winlogon.exe",
        "taskmgr.exe",
        "conhost.exe",
        "smss.exe",
        "spoolsv.exe",
        "dllhost.exe",
    ];
    if system_exes.contains(&file_name_lower.as_str()) {
        return false;
    }

    true
}

// ============================================================================
// 4. 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_resolver_basic() {
        let resolver = PathResolver::new();

        let (path, _) = resolver
            .extract_and_resolve(r#""C:\Program Files\App\app.exe" %1"#)
            .unwrap();
        assert_eq!(path, PathBuf::from(r"C:\Program Files\App\app.exe"));

        let (path, _) = resolver
            .extract_and_resolve(r"C:\App\app.exe %1")
            .unwrap();
        assert_eq!(path, PathBuf::from(r"C:\App\app.exe"));
    }

    #[test]
    fn test_path_resolver_env_var() {
        let resolver = PathResolver::new();
        let result = resolver.extract_and_resolve(r"%SystemRoot%\system32\notepad.exe %1");
        assert!(result.is_some());
        let (path, is_system) = result.unwrap();
        let path_str = path.to_string_lossy().to_lowercase();
        assert!(path_str.contains("system32"));
        assert!(is_system);
    }

    #[test]
    fn test_path_cache() {
        let mut cache = PathCache::new();

        // Windows 目录肯定存在
        assert!(cache.exists(r"C:\Windows"));
        // 第二次命中缓存
        assert!(cache.exists(r"C:\Windows"));

        let (hits, misses) = cache.stats();
        assert_eq!(hits, 1);
        assert_eq!(misses, 1);
    }

    #[test]
    fn test_is_definitely_safe_system_exe() {
        let mut cache = PathCache::new();
        // System32 路径不被允许
        assert!(!is_definitely_safe_to_delete(
            r"C:\Windows\System32\notepad.exe",
            &mut cache
        ));
        // rundll32.exe 不被允许
        assert!(!is_definitely_safe_to_delete(
            r"C:\Program Files\App\rundll32.exe",
            &mut cache
        ));
    }
}
