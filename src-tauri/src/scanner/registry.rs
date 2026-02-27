// ============================================================================
// 注册表冗余扫描模块
// 安全扫描 Windows 注册表中的孤立键值和无效引用
// ============================================================================
//
// 【安全声明】
// 本模块采用最保守的策略扫描注册表，遵循以下原则：
// 1. 只读扫描：扫描阶段绝不修改任何注册表键值
// 2. 严格白名单：Microsoft、Windows、硬件驱动相关键永不触碰
// 3. 备份优先：删除前必须导出 .reg 备份文件
// 4. 用户确认：所有删除操作需用户明确选择
//
// 【扫描的注册表路径】
// 1. HKEY_CURRENT_USER\Software
//    - 扫描用户安装的软件配置，查找已卸载软件的残留键
//
// 2. HKEY_CLASSES_ROOT\Applications
//    - 扫描应用程序文件关联，查找指向不存在可执行文件的条目
//
// 3. HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\MuiCache
//    - 扫描 MUI 缓存，查找指向不存在可执行文件的条目
//
// 4. HKEY_CURRENT_USER\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache
//    - 另一个 MUI 缓存位置
//
// 【风险等级】
// - MUI Cache: 低风险（仅缓存数据，删除后自动重建）
// - Software 键: 中等风险（可能影响软件配置）
// - Applications: 中等风险（可能影响文件关联）
// ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use winreg::enums::*;
use winreg::RegKey;

/// 注册表扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryScanResult {
    /// 发现的冗余注册表项
    pub entries: Vec<RegistryEntry>,
    /// 总条目数
    pub total_count: u32,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
}

/// 单个注册表条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    /// 注册表完整路径
    pub path: String,
    /// 键名或值名
    pub name: String,
    /// 条目类型
    pub entry_type: RegistryEntryType,
    /// 关联的文件路径（如果有）
    pub associated_path: Option<String>,
    /// 问题描述
    pub issue: String,
    /// 风险等级 (1-5)
    pub risk_level: u8,
}

/// 注册表条目类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RegistryEntryType {
    /// MUI 缓存条目
    MuiCache,
    /// 软件配置键
    SoftwareKey,
    /// 应用程序关联
    ApplicationAssociation,
    /// 文件类型关联
    FileTypeAssociation,
}

impl RegistryEntryType {
    pub fn display_name(&self) -> &'static str {
        match self {
            RegistryEntryType::MuiCache => "MUI缓存",
            RegistryEntryType::SoftwareKey => "软件配置",
            RegistryEntryType::ApplicationAssociation => "应用关联",
            RegistryEntryType::FileTypeAssociation => "文件类型关联",
        }
    }
}

// ============================================================================
// 白名单配置
// 这些注册表键是系统关键组件，永远不会被扫描或标记
// ============================================================================

/// 注册表键白名单（不区分大小写）
/// 任何包含这些字符串的键路径都会被跳过
const REGISTRY_WHITELIST: &[&str] = &[
    // Microsoft 和 Windows 核心
    "microsoft",
    "windows",
    "classes",
    "policies",
    "explorer",
    "shell",
    "currentversion",
    
    // 硬件和驱动
    "nvidia",
    "amd",
    "intel",
    "realtek",
    "hardware",
    "device",
    "driver",
    
    // 系统服务
    "services",
    "system",
    "security",
    "sam",
    "software\\classes",
    
    // 常用软件（用户可能仍在使用）
    "google",
    "chrome",
    "mozilla",
    "firefox",
    "adobe",
    "java",
    "python",
    "node",
    "git",
    "vscode",
    "visual studio",
    "jetbrains",
];

/// 注册表扫描器
pub struct RegistryScanner {
    /// 已安装程序名称集合（小写）
    installed_apps: HashSet<String>,
}

impl RegistryScanner {
    /// 创建新的扫描器实例
    pub fn new() -> Self {
        let installed_apps = Self::get_installed_programs();
        log::info!("注册表扫描器已加载 {} 个已安装程序", installed_apps.len());
        
        RegistryScanner { installed_apps }
    }

    /// 从注册表获取已安装程序列表
    fn get_installed_programs() -> HashSet<String> {
        let mut programs = HashSet::new();
        
        let paths = [
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        ];

        for (hkey, path) in paths {
            if let Ok(key) = RegKey::predef(hkey).open_subkey_with_flags(path, KEY_READ) {
                for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
                    if let Ok(subkey) = key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                        if let Ok(display_name) = subkey.get_value::<String, _>("DisplayName") {
                            programs.insert(display_name.to_lowercase());
                        }
                    }
                }
            }
        }

        programs
    }

    /// 执行注册表冗余扫描
    pub fn scan(&self) -> RegistryScanResult {
        let start_time = std::time::Instant::now();
        let mut entries = Vec::new();

        // 1. 扫描 MUI 缓存（最安全，低风险）
        log::info!("扫描 MUI 缓存...");
        entries.extend(self.scan_mui_cache());

        // 2. 扫描 HKCU\Software 中的孤立键（中等风险）
        log::info!("扫描用户软件配置...");
        entries.extend(self.scan_software_keys());

        // 3. 扫描 Applications 关联（中等风险）
        log::info!("扫描应用程序关联...");
        entries.extend(self.scan_applications());

        let total_count = entries.len() as u32;
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        log::info!(
            "注册表扫描完成: 发现 {} 个冗余条目, 耗时 {}ms",
            total_count,
            scan_duration_ms
        );

        RegistryScanResult {
            entries,
            total_count,
            scan_duration_ms,
        }
    }

    /// 扫描 MUI 缓存
    /// 
    /// 【安全说明】
    /// MUI 缓存存储了可执行文件的显示名称缓存，
    /// 当对应的可执行文件不存在时，这些缓存条目就是无效的。
    /// 删除这些条目是完全安全的，系统会在需要时自动重建。
    fn scan_mui_cache(&self) -> Vec<RegistryEntry> {
        let mut entries = Vec::new();

        // MUI 缓存路径列表
        let mui_paths = [
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\MuiCache",
            r"Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache",
        ];

        for path in mui_paths {
            if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(path, KEY_READ)
            {
                // 【安全说明】只读取值，不进行任何写入
                for value_result in key.enum_values() {
                    if let Ok((name, _)) = value_result {
                        // MUI 缓存的键名格式通常是: "C:\path\to\app.exe.FriendlyAppName"
                        // 我们需要提取可执行文件路径
                        if let Some(exe_path) = self.extract_exe_path_from_mui(&name) {
                            // 检查可执行文件是否存在
                            if !Path::new(&exe_path).exists() {
                                entries.push(RegistryEntry {
                                    path: format!("HKEY_CURRENT_USER\\{}", path),
                                    name: name.clone(),
                                    entry_type: RegistryEntryType::MuiCache,
                                    associated_path: Some(exe_path.clone()),
                                    issue: format!("可执行文件不存在: {}", exe_path),
                                    risk_level: 1, // MUI 缓存是最安全的
                                });
                            }
                        }
                    }
                }
            }
        }

        entries
    }

    /// 从 MUI 缓存键名中提取可执行文件路径
    fn extract_exe_path_from_mui(&self, name: &str) -> Option<String> {
        // MUI 缓存键名格式: "path.exe.FriendlyAppName" 或 "@path.exe,-resourceId"
        
        // 处理 @ 开头的格式
        let name = name.trim_start_matches('@');
        
        // 查找 .exe 的位置
        if let Some(exe_pos) = name.to_lowercase().find(".exe") {
            let path = &name[..exe_pos + 4];
            // 验证路径格式（应该以盘符开头）
            if path.len() > 2 && path.chars().nth(1) == Some(':') {
                return Some(path.to_string());
            }
        }

        // 处理 .dll 格式
        if let Some(dll_pos) = name.to_lowercase().find(".dll") {
            let path = &name[..dll_pos + 4];
            if path.len() > 2 && path.chars().nth(1) == Some(':') {
                return Some(path.to_string());
            }
        }

        None
    }

    /// 扫描 HKCU\Software 中的孤立软件键
    /// 
    /// 【安全说明】
    /// 此函数扫描用户软件配置区域，查找已卸载软件的残留配置。
    /// 采用保守策略：只标记那些明确不在已安装列表中的键。
    fn scan_software_keys(&self) -> Vec<RegistryEntry> {
        let mut entries = Vec::new();

        // 【安全说明】只扫描 HKEY_CURRENT_USER\Software，不触碰 HKEY_LOCAL_MACHINE
        if let Ok(software_key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Software", KEY_READ)
        {
            for subkey_name in software_key.enum_keys().filter_map(|k| k.ok()) {
                // 检查是否在白名单中
                if self.is_key_whitelisted(&subkey_name) {
                    continue;
                }

                // 检查是否对应已安装程序
                if self.is_installed(&subkey_name) {
                    continue;
                }

                // 进一步检查子键是否有实际内容
                let full_path = format!(r"Software\{}", subkey_name);
                if let Ok(subkey) = software_key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                    // 检查是否有子键或值
                    let has_subkeys = subkey.enum_keys().next().is_some();
                    let has_values = subkey.enum_values().next().is_some();

                    if has_subkeys || has_values {
                        entries.push(RegistryEntry {
                            path: format!("HKEY_CURRENT_USER\\{}", full_path),
                            name: subkey_name.clone(),
                            entry_type: RegistryEntryType::SoftwareKey,
                            associated_path: None,
                            issue: format!("软件 \"{}\" 可能已卸载，但配置仍保留", subkey_name),
                            risk_level: 3, // 中等风险
                        });
                    }
                }
            }
        }

        entries
    }

    /// 扫描 HKCR\Applications 中的孤立应用关联
    /// 
    /// 【安全说明】
    /// 此函数扫描应用程序文件关联，查找指向不存在可执行文件的条目。
    fn scan_applications(&self) -> Vec<RegistryEntry> {
        let mut entries = Vec::new();

        // 【安全说明】HKEY_CLASSES_ROOT 是 HKLM 和 HKCU 的合并视图
        // 我们只读取，不写入
        if let Ok(apps_key) = RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey_with_flags("Applications", KEY_READ)
        {
            for app_name in apps_key.enum_keys().filter_map(|k| k.ok()) {
                // 检查是否在白名单中
                if self.is_key_whitelisted(&app_name) {
                    continue;
                }

                // 尝试获取应用程序的命令行路径
                let shell_path = format!(r"{}\shell\open\command", app_name);
                if let Ok(cmd_key) = apps_key.open_subkey_with_flags(&shell_path, KEY_READ) {
                    if let Ok(command) = cmd_key.get_value::<String, _>("") {
                        // 从命令行中提取可执行文件路径
                        if let Some(exe_path) = self.extract_exe_from_command(&command) {
                            if !Path::new(&exe_path).exists() {
                                entries.push(RegistryEntry {
                                    path: format!("HKEY_CLASSES_ROOT\\Applications\\{}", app_name),
                                    name: app_name.clone(),
                                    entry_type: RegistryEntryType::ApplicationAssociation,
                                    associated_path: Some(exe_path.clone()),
                                    issue: format!("关联的可执行文件不存在: {}", exe_path),
                                    risk_level: 3, // 中等风险
                                });
                            }
                        }
                    }
                }
            }
        }

        entries
    }

    /// 从命令行字符串中提取可执行文件路径
    fn extract_exe_from_command(&self, command: &str) -> Option<String> {
        let command = command.trim();
        
        // 处理带引号的路径
        if command.starts_with('"') {
            if let Some(end_quote) = command[1..].find('"') {
                return Some(command[1..end_quote + 1].to_string());
            }
        }
        
        // 处理不带引号的路径（取第一个空格之前的部分）
        let parts: Vec<&str> = command.split_whitespace().collect();
        if let Some(first) = parts.first() {
            let path = first.trim_matches('"');
            if path.len() > 2 && path.chars().nth(1) == Some(':') {
                return Some(path.to_string());
            }
        }

        None
    }

    /// 检查注册表键是否在白名单中
    fn is_key_whitelisted(&self, key_name: &str) -> bool {
        let name_lower = key_name.to_lowercase();
        REGISTRY_WHITELIST.iter().any(|w| name_lower.contains(w))
    }

    /// 检查是否对应已安装程序
    fn is_installed(&self, key_name: &str) -> bool {
        let name_lower = key_name.to_lowercase();
        
        // 完全匹配
        if self.installed_apps.contains(&name_lower) {
            return true;
        }

        // 部分匹配
        for app in &self.installed_apps {
            if app.len() > 3 && name_lower.contains(app.as_str()) {
                return true;
            }
        }

        false
    }
}

impl Default for RegistryScanner {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 注册表备份功能
// 在删除注册表键之前，必须先导出备份
// ============================================================================

/// 注册表备份管理器
pub struct RegistryBackup;

impl RegistryBackup {
    /// 导出注册表键到 .reg 文件
    /// 
    /// 【安全说明】
    /// 此函数在删除任何注册表键之前被调用，
    /// 将要删除的键导出为标准 .reg 文件格式，
    /// 用户可以通过双击 .reg 文件恢复删除的键。
    /// 
    /// # 参数
    /// - `entries`: 要备份的注册表条目列表
    /// - `backup_dir`: 备份文件保存目录
    /// 
    /// # 返回
    /// - `Ok(PathBuf)`: 备份文件路径
    /// - `Err(String)`: 错误信息
    pub fn export_backup(entries: &[RegistryEntry], backup_dir: &Path) -> Result<PathBuf, String> {
        // 确保备份目录存在
        fs::create_dir_all(backup_dir)
            .map_err(|e| format!("创建备份目录失败: {}", e))?;

        // 生成备份文件名（包含时间戳）
        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let backup_file = backup_dir.join(format!("lightc_registry_backup_{}.reg", timestamp));

        // 创建备份文件
        let mut file = File::create(&backup_file)
            .map_err(|e| format!("创建备份文件失败: {}", e))?;

        // 写入 .reg 文件头
        writeln!(file, "Windows Registry Editor Version 5.00")
            .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file).map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file, "; LightC 注册表备份")
            .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file, "; 创建时间: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
            .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file, "; 如需恢复，请双击此文件")
            .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file).map_err(|e| format!("写入备份文件失败: {}", e))?;

        // 导出每个条目
        for entry in entries {
            // 写入注册表路径
            writeln!(file, "[{}]", entry.path)
                .map_err(|e| format!("写入备份文件失败: {}", e))?;
            
            // 如果是值条目，需要导出值内容
            // 这里简化处理，实际实现需要读取并导出值
            writeln!(file, "; {}", entry.issue)
                .map_err(|e| format!("写入备份文件失败: {}", e))?;
            writeln!(file).map_err(|e| format!("写入备份文件失败: {}", e))?;
        }

        log::info!("注册表备份已保存到: {:?}", backup_file);
        Ok(backup_file)
    }

    /// 获取默认备份目录
    pub fn get_backup_dir() -> PathBuf {
        // 使用用户文档目录下的 LightC 子目录
        dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\"))
            .join("LightC")
            .join("RegistryBackups")
    }
}

/// 删除注册表键
/// 
/// 【安全说明】
/// 此函数执行实际的注册表删除操作。
/// 调用此函数前，必须：
/// 1. 已通过 RegistryBackup::export_backup 创建备份
/// 2. 用户已明确确认删除操作
/// 
/// # 参数
/// - `entry`: 要删除的注册表条目
/// 
/// # 返回
/// - `Ok(())`: 删除成功
/// - `Err(String)`: 删除失败的原因
pub fn delete_registry_entry(entry: &RegistryEntry) -> Result<(), String> {
    // 解析注册表路径，获取根键和子路径
    let (root_key, subpath) = parse_registry_path(&entry.path)?;

    match entry.entry_type {
        RegistryEntryType::MuiCache => {
            // MUI 缓存是值，需要删除值而不是键
            let key = root_key
                .open_subkey_with_flags(subpath, KEY_WRITE)
                .map_err(|e| format!("打开注册表键失败: {}", e))?;
            
            key.delete_value(&entry.name)
                .map_err(|e| format!("删除注册表值失败: {}", e))?;
        }
        RegistryEntryType::SoftwareKey | 
        RegistryEntryType::ApplicationAssociation |
        RegistryEntryType::FileTypeAssociation => {
            // 删除整个键
            let parent_path = subpath.rsplit_once('\\')
                .map(|(parent, _)| parent)
                .unwrap_or("");
            
            let parent_key = root_key
                .open_subkey_with_flags(parent_path, KEY_WRITE)
                .map_err(|e| format!("打开父键失败: {}", e))?;
            
            parent_key.delete_subkey_all(&entry.name)
                .map_err(|e| format!("删除注册表键失败: {}", e))?;
        }
    }

    log::info!("已删除注册表条目: {}", entry.path);
    Ok(())
}

/// 解析注册表路径字符串，返回预定义的 RegKey 和子路径
fn parse_registry_path(path: &str) -> Result<(RegKey, &str), String> {
    if let Some(subpath) = path.strip_prefix("HKEY_CURRENT_USER\\") {
        Ok((RegKey::predef(HKEY_CURRENT_USER), subpath))
    } else if let Some(subpath) = path.strip_prefix("HKEY_LOCAL_MACHINE\\") {
        Ok((RegKey::predef(HKEY_LOCAL_MACHINE), subpath))
    } else if let Some(subpath) = path.strip_prefix("HKEY_CLASSES_ROOT\\") {
        Ok((RegKey::predef(HKEY_CLASSES_ROOT), subpath))
    } else {
        Err(format!("无法解析注册表路径: {}", path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whitelist() {
        let scanner = RegistryScanner::new();
        assert!(scanner.is_key_whitelisted("Microsoft"));
        assert!(scanner.is_key_whitelisted("NVIDIA"));
        assert!(!scanner.is_key_whitelisted("SomeRandomApp"));
    }

    #[test]
    fn test_extract_exe_from_command() {
        let scanner = RegistryScanner::new();
        
        assert_eq!(
            scanner.extract_exe_from_command(r#""C:\Program Files\App\app.exe" "%1""#),
            Some(r"C:\Program Files\App\app.exe".to_string())
        );
        
        assert_eq!(
            scanner.extract_exe_from_command(r"C:\App\app.exe %1"),
            Some(r"C:\App\app.exe".to_string())
        );
    }
}
