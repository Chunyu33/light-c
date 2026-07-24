// ============================================================================
// 删除安全保护常量（delete_engine 和 enhanced_delete 共享）
// 避免两个引擎各自维护不一致的保护列表
// ============================================================================

/// 绝对禁止删除的路径前缀（小写，starts_with 匹配）
pub const PROTECTED_PATH_PREFIXES: &[&str] = &[
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
    "c:\\$recycle.bin",
];

/// 绝对禁止删除的文件名（小写，精确匹配）
pub const PROTECTED_FILES: &[&str] = &[
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
    "desktop.ini",
    "ntuser.dat",
    "usrclass.dat",
    // 社交软件配置文件（防止误删导致数据丢失）
    "config.data",
    "accinfo.dat",
    "msg.db",
    "micromsg.db",
    "contact.db",
    "emotion.db",
    "favorite.db",
    "publicmsg.db",
    "nt_db",
    "nt_config",
];

/// 在 Windows 目录下禁止删除的扩展名（小写）
pub const PROTECTED_EXTENSIONS_IN_WINDOWS: &[&str] = &[
    "sys", "dll", "exe", "drv", "ocx", "cpl", "msi", "msp", "msu", "cat", "mum", "manifest",
];

/// 判断是否为 Windows 清理向导明确允许重建的系统缓存子目录。
/// 这些目录位于受保护的系统根目录下，因此删除引擎必须只放行精确子路径，不能放宽整个父目录。
pub fn is_rebuildable_system_cache_path(path: &str) -> bool {
    let normalized = path.replace('/', "\\").to_ascii_lowercase();
    [
        "\\windows\\system32\\d3d_cache",
        "\\programdata\\microsoft\\windows defender\\localcopy",
        "\\programdata\\microsoft\\windows defender\\support",
    ]
    .iter()
    .any(|marker| {
        let Some(start) = normalized.find(marker) else {
            return false;
        };
        let suffix = &normalized[start + marker.len()..];
        let has_drive_root_boundary = start > 0 && normalized.as_bytes()[start - 1] == b':';
        // 必须同时匹配系统盘根目录和完整目录名，避免误放行嵌套伪造路径或 Support2。
        has_drive_root_boundary && (suffix.is_empty() || suffix.starts_with('\\'))
    })
}

#[cfg(test)]
mod tests {
    use super::is_rebuildable_system_cache_path;

    #[test]
    fn matches_only_explicit_cache_directory_boundaries() {
        // 只允许清理向导明确列出的目录，避免相似目录名被误放行。
        assert!(is_rebuildable_system_cache_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Support\MPLog.log"
        ));
        assert!(!is_rebuildable_system_cache_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Support2\MPLog.log"
        ));
        assert!(!is_rebuildable_system_cache_path(
            r"C:\ProgramData\Microsoft\Windows Defender\Quarantine\entry.bin"
        ));
        assert!(!is_rebuildable_system_cache_path(
            r"C:\Temp\ProgramData\Microsoft\Windows Defender\Support\entry.bin"
        ));
    }
}
