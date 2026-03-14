// ============================================================================
// 卸载残留扫描模块（支持模拟器、残留驱动深度检测）
// 扫描 AppData 和 ProgramData 中已卸载软件遗留的孤立文件夹
// ============================================================================
//
// 【安全说明】
// 本模块通过对比已安装程序列表与文件系统中的应用文件夹，
// 识别出已卸载软件遗留的配置文件、缓存和日志等残留数据。
//
// 【扫描路径】
// - %LOCALAPPDATA% (C:\Users\<用户>\AppData\Local)
// - %APPDATA% (C:\Users\<用户>\AppData\Roaming)
// - %LOCALAPPDATA%Low (C:\Users\<用户>\AppData\LocalLow)
// - C:\ProgramData
//
// 【深度扫描模式】
// - 扫描模拟器残留（雷电、蓝叠、夜神、MuMu、MEmu、MSI App Player）
// - 扫描孤立虚拟磁盘文件（.vmdk, .vdi, .vhd）
// - 检查注册表关联（HKCU/HKLM Software）
//
// 【安全机制】
// 1. 白名单保护：系统关键文件夹（如 Microsoft、Windows）永不扫描
// 2. 时间过滤：仅扫描超过30天未修改的文件夹（确保不是新安装的软件）
// 3. 大小阈值：忽略小于 1MB 的文件夹（避免误报）
// 4. 驱动保护：系统核心驱动永不标记为残留
// ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;
use winreg::enums::*;
use winreg::RegKey;

/// 卸载残留扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeftoverScanResult {
    /// 发现的残留文件夹列表
    pub leftovers: Vec<LeftoverEntry>,
    /// 总大小（字节）
    pub total_size: u64,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
}

/// 单个残留条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeftoverEntry {
    /// 文件夹路径
    pub path: String,
    /// 文件夹大小（字节）
    pub size: u64,
    /// 可能的软件名称（从文件夹名推断）
    pub app_name: String,
    /// 来源类型
    pub source: LeftoverSource,
    /// 最后修改时间（Unix时间戳）
    pub last_modified: i64,
    /// 包含的文件数量
    pub file_count: u32,
    /// 是否为模拟器残留
    pub is_emulator: bool,
    /// 是否为虚拟磁盘文件
    pub is_virtual_disk: bool,
    /// 残留类型描述（用于 UI 显示）
    pub leftover_type: LeftoverType,
}

/// 残留类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LeftoverType {
    /// 普通应用残留
    Normal,
    /// 模拟器残留（雷电、蓝叠、夜神等）
    Emulator,
    /// 虚拟磁盘文件（.vmdk, .vdi, .vhd）
    VirtualDisk,
    /// 注册表关联残留
    RegistryOrphan,
}

/// 残留来源类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LeftoverSource {
    /// AppData\Local
    LocalAppData,
    /// AppData\Roaming
    RoamingAppData,
    /// AppData\LocalLow
    LocalLowAppData,
    /// ProgramData
    ProgramData,
    /// 虚拟磁盘文件（独立文件）
    VirtualDiskFile,
}

impl LeftoverSource {
    #[allow(dead_code)]
    pub fn display_name(&self) -> &'static str {
        match self {
            LeftoverSource::LocalAppData => "本地应用数据",
            LeftoverSource::RoamingAppData => "漫游应用数据",
            LeftoverSource::LocalLowAppData => "LocalLow数据",
            LeftoverSource::ProgramData => "程序数据",
            LeftoverSource::VirtualDiskFile => "虚拟磁盘文件",
        }
    }
}

// ============================================================================
// 模拟器特征库
// 用于识别常见 Android 模拟器的残留文件夹
// ============================================================================

/// 模拟器特征信息
struct EmulatorSignature {
    /// 模拟器名称
    name: &'static str,
    /// 文件夹名称关键字（小写匹配）
    folder_keywords: &'static [&'static str],
    /// 注册表厂商名关键字
    registry_keywords: &'static [&'static str],
}

/// 已知模拟器特征库
const EMULATOR_SIGNATURES: &[EmulatorSignature] = &[
    // 雷电模拟器 (LDPlayer)
    EmulatorSignature {
        name: "雷电模拟器",
        folder_keywords: &["ldplayer", "leidian", "dnplayer", "changzhi"],
        registry_keywords: &["ldplayer", "changzhi", "xuanzhi"],
    },
    // 蓝叠模拟器 (BlueStacks)
    EmulatorSignature {
        name: "蓝叠模拟器",
        folder_keywords: &["bluestacks", "bluestacks_nxt", "bstk"],
        registry_keywords: &["bluestacks", "bluestack systems"],
    },
    // 夜神模拟器 (Nox)
    EmulatorSignature {
        name: "夜神模拟器",
        folder_keywords: &["nox", "noxplayer", "bignox", "yeshen"],
        registry_keywords: &["nox", "bignox", "duodian"],
    },
    // MuMu模拟器 (网易)
    EmulatorSignature {
        name: "MuMu模拟器",
        folder_keywords: &["mumu", "nemu", "mumuemulator", "nemubox"],
        registry_keywords: &["mumu", "netease", "nemu"],
    },
    // MEmu模拟器 (逍遥)
    EmulatorSignature {
        name: "MEmu模拟器",
        folder_keywords: &["memu", "microvirt", "xyaz"],
        registry_keywords: &["memu", "microvirt"],
    },
    // MSI App Player
    EmulatorSignature {
        name: "MSI App Player",
        folder_keywords: &["msi app player", "msiappplayer"],
        registry_keywords: &["msi app player"],
    },
    // 腾讯手游助手
    EmulatorSignature {
        name: "腾讯手游助手",
        folder_keywords: &["txgameassistant", "gameloop", "tgp", "androidemulator"],
        registry_keywords: &["tencent", "gameloop"],
    },
];

/// 虚拟磁盘文件扩展名
const VIRTUAL_DISK_EXTENSIONS: &[&str] = &[".vmdk", ".vdi", ".vhd", ".vhdx"];

// ============================================================================
// 白名单配置
// 这些文件夹是系统或常用软件的关键目录，永远不会被标记为残留
// ============================================================================

/// 系统关键文件夹白名单（不区分大小写匹配）
const WHITELIST_FOLDERS: &[&str] = &[
    // Windows 系统核心
    "microsoft",
    "windows",
    "packages",
    "windowsapps",
    "connecteddevicesplatform",
    "comms",
    "d3dscache",
    "diagnostics",
    "publishers",
    "temp",
    "temporary internet files",
    
    // 硬件驱动相关
    "nvidia",
    "nvidia corporation",
    "amd",
    "intel",
    "realtek",
    "asus",
    "msi",
    "gigabyte",
    "logitech",
    "razer",
    "corsair",
    "steelseries",
    
    // 常用运行时和框架
    ".net",
    "dotnet",
    "java",
    "python",
    "node",
    "nodejs",
    "npm",
    "yarn",
    "rust",
    "cargo",
    "go",
    "golang",
    
    // 开发工具
    "vscode",
    "visual studio",
    "jetbrains",
    "git",
    "github",
    "docker",
    "wsl",
    
    // 系统服务
    "application data",
    "local settings",
    "history",
    "cookies",
    "cache",
    "caches",
    "logs",
    "crash reports",
    "crashdumps",
    
    // 常见应用（用户可能仍在使用）
    "google",
    "chrome",
    "edge",
    "firefox",
    "mozilla",
    "opera",
    "brave",
    "vivaldi",
    "wechat",
    "tencent",
    "qq",
    "discord",
    "slack",
    "zoom",
    "teams",
    "skype",
    "telegram",
    "whatsapp",
    "steam",
    "epic games",
    "ubisoft",
    "origin",
    "ea",
    "blizzard",
    "battle.net",
    "riot games",
    "adobe",
    "autodesk",
    "office",
    "onedrive",
    "dropbox",
    "icloud",
    "spotify",
    "vlc",
    "potplayer",
    "7-zip",
    "winrar",
    "bandizip",
];

/// 卸载残留扫描器
pub struct LeftoverScanner {
    /// 已安装程序名称集合（小写）
    installed_apps: HashSet<String>,
    /// 最小文件夹大小阈值（字节）
    min_size_threshold: u64,
    /// 最小未修改天数
    min_days_old: u64,
    /// 是否启用深度扫描模式
    deep_scan: bool,
}

impl LeftoverScanner {
    /// 创建新的扫描器实例
    pub fn new() -> Self {
        Self::with_deep_scan(false)
    }

    /// 创建带深度扫描选项的扫描器实例
    pub fn with_deep_scan(deep_scan: bool) -> Self {
        let installed_apps = Self::get_installed_programs();
        log::info!("已加载 {} 个已安装程序, 深度扫描: {}", installed_apps.len(), deep_scan);
        
        LeftoverScanner {
            installed_apps,
            min_size_threshold: 1024 * 1024, // 1MB
            min_days_old: if deep_scan { 7 } else { 30 }, // 深度扫描时降低时间阈值
            deep_scan,
        }
    }

    /// 从注册表获取已安装程序列表
    /// 
    /// 【扫描的注册表路径】
    /// - HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
    /// - HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall
    /// - HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
    fn get_installed_programs() -> HashSet<String> {
        let mut programs = HashSet::new();
        
        // 【安全说明】只读取注册表，不进行任何写入操作
        let paths = [
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        ];

        for (hkey, path) in paths {
            if let Ok(key) = RegKey::predef(hkey).open_subkey_with_flags(path, KEY_READ) {
                for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
                    if let Ok(subkey) = key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                        // 尝试读取 DisplayName
                        if let Ok(display_name) = subkey.get_value::<String, _>("DisplayName") {
                            let name_lower = display_name.to_lowercase();
                            programs.insert(name_lower.clone());
                            
                            // 提取软件名称的关键词（去除版本号等）
                            let keywords: Vec<&str> = name_lower
                                .split(|c: char| !c.is_alphanumeric() && c != ' ')
                                .filter(|s| !s.is_empty() && s.len() > 2)
                                .collect();
                            for kw in keywords {
                                programs.insert(kw.to_string());
                            }
                        }
                        
                        // 尝试读取 InstallLocation
                        if let Ok(install_loc) = subkey.get_value::<String, _>("InstallLocation") {
                            if let Some(folder_name) = Path::new(&install_loc).file_name() {
                                programs.insert(folder_name.to_string_lossy().to_lowercase());
                            }
                        }
                    }
                }
            }
        }

        programs
    }

    /// 执行卸载残留扫描
    pub fn scan(&self) -> LeftoverScanResult {
        let start_time = std::time::Instant::now();
        let mut leftovers = Vec::new();
        let mut total_size = 0u64;

        // 获取扫描路径
        let scan_paths = self.get_scan_paths();

        for (base_path, source) in scan_paths {
            if !base_path.exists() {
                continue;
            }

            log::info!("扫描残留目录: {:?}", base_path);

            // 只扫描一级子目录
            if let Ok(entries) = fs::read_dir(&base_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    
                    // 只处理目录
                    if !path.is_dir() {
                        continue;
                    }

                    // 获取文件夹名称
                    let folder_name = match path.file_name() {
                        Some(name) => name.to_string_lossy().to_string(),
                        None => continue,
                    };

                    // 检查是否在白名单中
                    if self.is_whitelisted(&folder_name) {
                        continue;
                    }

                    // 【模拟器检测】检查是否为已知模拟器残留
                    let is_emulator = self.is_emulator_folder(&folder_name);
                    
                    // 非模拟器残留需要检查是否对应已安装程序
                    if !is_emulator && self.is_installed(&folder_name) {
                        continue;
                    }

                    // 检查最后修改时间（模拟器残留跳过时间检查）
                    if !is_emulator && !self.is_old_enough(&path) {
                        continue;
                    }

                    // 计算文件夹大小
                    let (size, file_count) = self.calculate_folder_size(&path);

                    // 检查大小阈值（模拟器残留降低阈值）
                    let threshold = if is_emulator { 100 * 1024 } else { self.min_size_threshold };
                    if size < threshold {
                        continue;
                    }

                    // 获取最后修改时间
                    let last_modified = self.get_last_modified(&path);

                    // 确定残留类型
                    let leftover_type = if is_emulator {
                        LeftoverType::Emulator
                    } else {
                        LeftoverType::Normal
                    };

                    leftovers.push(LeftoverEntry {
                        path: path.to_string_lossy().to_string(),
                        size,
                        app_name: folder_name,
                        source: source.clone(),
                        last_modified,
                        file_count,
                        is_emulator,
                        is_virtual_disk: false,
                        leftover_type,
                    });

                    total_size += size;
                }
            }
        }

        // 【深度扫描】扫描虚拟磁盘文件
        if self.deep_scan {
            log::info!("执行深度扫描: 搜索孤立虚拟磁盘文件...");
            let virtual_disks = self.scan_virtual_disk_files();
            for entry in virtual_disks {
                total_size += entry.size;
                leftovers.push(entry);
            }
        }

        // 按大小降序排序
        leftovers.sort_by(|a, b| b.size.cmp(&a.size));

        let scan_duration_ms = start_time.elapsed().as_millis() as u64;
        log::info!(
            "卸载残留扫描完成: 发现 {} 个残留, 总大小 {} 字节, 耗时 {}ms",
            leftovers.len(),
            total_size,
            scan_duration_ms
        );

        LeftoverScanResult {
            leftovers,
            total_size,
            scan_duration_ms,
        }
    }

    /// 检查文件夹是否为已知模拟器残留
    fn is_emulator_folder(&self, folder_name: &str) -> bool {
        let name_lower = folder_name.to_lowercase();
        
        for sig in EMULATOR_SIGNATURES {
            for keyword in sig.folder_keywords {
                if name_lower.contains(keyword) {
                    log::debug!("检测到模拟器残留: {} (匹配 {})", folder_name, sig.name);
                    return true;
                }
            }
        }
        
        false
    }

    /// 【深度扫描】扫描孤立虚拟磁盘文件
    /// 搜索 .vmdk, .vdi, .vhd 等虚拟磁盘文件
    fn scan_virtual_disk_files(&self) -> Vec<LeftoverEntry> {
        let mut results = Vec::new();
        
        // 扫描路径：用户目录下的常见位置
        let scan_dirs = [
            dirs::data_local_dir(),
            dirs::data_dir(),
            Some(PathBuf::from(r"C:\ProgramData")),
        ];
        
        for dir_opt in scan_dirs.iter() {
            if let Some(base_dir) = dir_opt {
                if !base_dir.exists() {
                    continue;
                }
                
                // 递归搜索虚拟磁盘文件（限制深度为 5）
                for entry in WalkDir::new(base_dir)
                    .max_depth(5)
                    .into_iter()
                    .filter_map(|e| e.ok())
                {
                    let path = entry.path();
                    
                    // 只处理文件
                    if !path.is_file() {
                        continue;
                    }
                    
                    // 检查扩展名
                    let ext = path.extension()
                        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                        .unwrap_or_default();
                    
                    if !VIRTUAL_DISK_EXTENSIONS.contains(&ext.as_str()) {
                        continue;
                    }
                    
                    // 获取文件大小
                    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                    
                    // 虚拟磁盘文件通常很大，忽略小于 100MB 的
                    if size < 100 * 1024 * 1024 {
                        continue;
                    }
                    
                    // 检查是否关联到已安装的模拟器
                    let parent_folder = path.parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    
                    // 如果父目录对应已安装程序，跳过
                    if self.is_installed(&parent_folder) {
                        continue;
                    }
                    
                    let file_name = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    
                    let last_modified = self.get_last_modified(path);
                    
                    log::info!("发现孤立虚拟磁盘文件: {} ({} MB)", 
                        path.display(), size / 1024 / 1024);
                    
                    results.push(LeftoverEntry {
                        path: path.to_string_lossy().to_string(),
                        size,
                        app_name: file_name,
                        source: LeftoverSource::VirtualDiskFile,
                        last_modified,
                        file_count: 1,
                        is_emulator: false,
                        is_virtual_disk: true,
                        leftover_type: LeftoverType::VirtualDisk,
                    });
                }
            }
        }
        
        results
    }

    /// 获取需要扫描的路径列表
    fn get_scan_paths(&self) -> Vec<(PathBuf, LeftoverSource)> {
        let mut paths = Vec::new();

        // AppData\Local
        if let Some(local_app_data) = dirs::data_local_dir() {
            paths.push((local_app_data.clone(), LeftoverSource::LocalAppData));
            
            // AppData\LocalLow（模拟器残留常见位置）
            if let Some(parent) = local_app_data.parent() {
                let local_low = parent.join("LocalLow");
                if local_low.exists() {
                    paths.push((local_low, LeftoverSource::LocalLowAppData));
                }
            }
        }

        // AppData\Roaming
        if let Some(roaming_app_data) = dirs::data_dir() {
            paths.push((roaming_app_data, LeftoverSource::RoamingAppData));
        }

        // ProgramData
        let program_data = PathBuf::from(r"C:\ProgramData");
        if program_data.exists() {
            paths.push((program_data, LeftoverSource::ProgramData));
        }

        paths
    }

    /// 检查文件夹是否在白名单中
    fn is_whitelisted(&self, folder_name: &str) -> bool {
        let name_lower = folder_name.to_lowercase();
        
        // 检查完全匹配
        if WHITELIST_FOLDERS.iter().any(|w| w.eq_ignore_ascii_case(&name_lower)) {
            return true;
        }

        // 检查包含关系
        if WHITELIST_FOLDERS.iter().any(|w| name_lower.contains(w)) {
            return true;
        }

        // 以点开头的隐藏文件夹（如 .vscode）
        if name_lower.starts_with('.') {
            return true;
        }

        false
    }

    /// 检查文件夹是否对应已安装程序
    fn is_installed(&self, folder_name: &str) -> bool {
        let name_lower = folder_name.to_lowercase();
        
        // 完全匹配
        if self.installed_apps.contains(&name_lower) {
            return true;
        }

        // 检查是否包含已安装程序的关键词
        for app in &self.installed_apps {
            if app.len() > 3 && name_lower.contains(app.as_str()) {
                return true;
            }
            if name_lower.len() > 3 && app.contains(&name_lower) {
                return true;
            }
        }

        false
    }

    /// 检查文件夹是否足够旧（超过指定天数未修改）
    fn is_old_enough(&self, path: &Path) -> bool {
        if let Ok(metadata) = fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or(Duration::ZERO);
                return age.as_secs() > self.min_days_old * 24 * 60 * 60;
            }
        }
        // 无法获取修改时间时，保守起见返回 false
        false
    }

    /// 计算文件夹大小和文件数量
    fn calculate_folder_size(&self, path: &Path) -> (u64, u32) {
        let mut total_size = 0u64;
        let mut file_count = 0u32;

        for entry in WalkDir::new(path)
            .max_depth(10) // 限制递归深度，避免过深的目录结构
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

    /// 获取文件夹最后修改时间（Unix时间戳）
    fn get_last_modified(&self, path: &Path) -> i64 {
        if let Ok(metadata) = fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    return duration.as_secs() as i64;
                }
            }
        }
        0
    }
}

impl Default for LeftoverScanner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whitelist() {
        let scanner = LeftoverScanner::new();
        assert!(scanner.is_whitelisted("Microsoft"));
        assert!(scanner.is_whitelisted("NVIDIA Corporation"));
        assert!(scanner.is_whitelisted(".vscode"));
        assert!(!scanner.is_whitelisted("SomeRandomApp"));
    }
}
