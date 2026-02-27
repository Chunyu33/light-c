// ============================================================================
// 垃圾文件分类定义
// 定义了各种可清理的垃圾文件类型及其扫描规则
// ============================================================================

use serde::{Deserialize, Serialize};

/// 垃圾文件分类枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum JunkCategory {
    /// Windows临时文件 (%TEMP%, Windows\Temp)
    WindowsTemp,
    /// 系统缓存文件 (Prefetch, SoftwareDistribution等)
    SystemCache,
    /// 浏览器缓存 (Chrome, Edge, Firefox等)
    BrowserCache,
    /// 回收站
    RecycleBin,
    /// Windows更新缓存
    WindowsUpdate,
    /// 缩略图缓存
    ThumbnailCache,
    /// 日志文件
    LogFiles,
    /// 内存转储文件
    MemoryDump,
    /// 旧版Windows安装文件 (Windows.old)
    OldWindowsInstallation,
    /// 应用程序缓存
    AppCache,
    /// 字体缓存
    FontCache,
    /// Windows错误报告
    WindowsErrorReports,
    /// 安装程序临时文件
    InstallerTemp,
    /// 剪贴板缓存
    ClipboardCache,
}

impl JunkCategory {
    /// 获取分类的中文显示名称
    pub fn display_name(&self) -> &'static str {
        match self {
            JunkCategory::WindowsTemp => "Windows临时文件",
            JunkCategory::SystemCache => "系统缓存",
            JunkCategory::BrowserCache => "浏览器缓存",
            JunkCategory::RecycleBin => "回收站",
            JunkCategory::WindowsUpdate => "Windows更新缓存",
            JunkCategory::ThumbnailCache => "缩略图缓存",
            JunkCategory::LogFiles => "日志文件",
            JunkCategory::MemoryDump => "内存转储文件",
            JunkCategory::OldWindowsInstallation => "旧版Windows安装",
            JunkCategory::AppCache => "应用程序缓存",
            JunkCategory::FontCache => "字体缓存",
            JunkCategory::WindowsErrorReports => "Windows错误报告",
            JunkCategory::InstallerTemp => "安装程序临时文件",
            JunkCategory::ClipboardCache => "剪贴板缓存",
        }
    }

    /// 获取分类的描述信息
    pub fn description(&self) -> &'static str {
        match self {
            JunkCategory::WindowsTemp => "系统和应用程序产生的临时文件，可安全删除",
            JunkCategory::SystemCache => "Windows系统预读取和分发缓存文件",
            JunkCategory::BrowserCache => "浏览器保存的网页缓存、Cookie等数据",
            JunkCategory::RecycleBin => "已删除但未彻底清除的文件",
            JunkCategory::WindowsUpdate => "Windows更新下载的安装包缓存",
            JunkCategory::ThumbnailCache => "文件夹中图片和视频的缩略图缓存",
            JunkCategory::LogFiles => "系统和应用程序的日志记录文件",
            JunkCategory::MemoryDump => "系统崩溃时产生的内存转储文件",
            JunkCategory::OldWindowsInstallation => "系统升级后保留的旧版Windows文件",
            JunkCategory::AppCache => "各类应用程序产生的缓存文件",
            JunkCategory::FontCache => "Windows字体渲染缓存，删除后会自动重建",
            JunkCategory::WindowsErrorReports => "系统和应用崩溃时生成的错误报告文件",
            JunkCategory::InstallerTemp => "软件安装过程中产生的临时文件",
            JunkCategory::ClipboardCache => "剪贴板历史记录缓存文件",
        }
    }

    /// 获取分类的风险等级 (1-5, 1最安全)
    pub fn risk_level(&self) -> u8 {
        match self {
            JunkCategory::WindowsTemp => 1,
            JunkCategory::ThumbnailCache => 1,
            JunkCategory::FontCache => 1,
            JunkCategory::ClipboardCache => 1,
            JunkCategory::BrowserCache => 2,
            JunkCategory::RecycleBin => 2,
            JunkCategory::LogFiles => 2,
            JunkCategory::WindowsErrorReports => 2,
            JunkCategory::InstallerTemp => 2,
            JunkCategory::SystemCache => 3,
            JunkCategory::WindowsUpdate => 3,
            JunkCategory::AppCache => 3,
            JunkCategory::MemoryDump => 3,
            JunkCategory::OldWindowsInstallation => 4,
        }
    }

    /// 获取该分类需要扫描的路径列表
    pub fn get_scan_paths(&self) -> Vec<ScanPath> {
        match self {
            JunkCategory::WindowsTemp => vec![
                ScanPath::env_path("TEMP", None),
                ScanPath::env_path("TMP", None),
                ScanPath::fixed_path("C:\\Windows\\Temp"),
            ],
            JunkCategory::SystemCache => vec![
                // Windows 预读取缓存
                ScanPath::fixed_path("C:\\Windows\\Prefetch"),
                // Windows 传递优化缓存
                ScanPath::fixed_path("C:\\Windows\\SoftwareDistribution\\DeliveryOptimization"),
                // Windows 网络缓存
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\INetCache")),
                // Windows 应用程序缓存
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\Caches")),
            ],
            JunkCategory::BrowserCache => vec![
                // Chrome - 主缓存
                ScanPath::env_path("LOCALAPPDATA", Some("Google\\Chrome\\User Data\\Default\\Cache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Google\\Chrome\\User Data\\Default\\Code Cache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Google\\Chrome\\User Data\\Default\\GPUCache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Google\\Chrome\\User Data\\Default\\Service Worker\\CacheStorage")),
                ScanPath::env_path("LOCALAPPDATA", Some("Google\\Chrome\\User Data\\ShaderCache")),
                // Edge - 主缓存
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Edge\\User Data\\Default\\Cache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Edge\\User Data\\Default\\Code Cache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Edge\\User Data\\Default\\GPUCache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Edge\\User Data\\Default\\Service Worker\\CacheStorage")),
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Edge\\User Data\\ShaderCache")),
                // Firefox - 配置文件夹下的缓存
                ScanPath::env_path("LOCALAPPDATA", Some("Mozilla\\Firefox\\Profiles")),
                // Brave 浏览器
                ScanPath::env_path("LOCALAPPDATA", Some("BraveSoftware\\Brave-Browser\\User Data\\Default\\Cache")),
                ScanPath::env_path("LOCALAPPDATA", Some("BraveSoftware\\Brave-Browser\\User Data\\Default\\Code Cache")),
                // Opera 浏览器
                ScanPath::env_path("APPDATA", Some("Opera Software\\Opera Stable\\Cache")),
            ],
            JunkCategory::RecycleBin => vec![
                ScanPath::fixed_path("C:\\$Recycle.Bin"),
            ],
            JunkCategory::WindowsUpdate => vec![
                ScanPath::fixed_path("C:\\Windows\\SoftwareDistribution\\Download"),
            ],
            JunkCategory::ThumbnailCache => vec![
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\Explorer")),
            ],
            JunkCategory::LogFiles => vec![
                ScanPath::fixed_path("C:\\Windows\\Logs"),
                ScanPath::env_path("LOCALAPPDATA", Some("CrashDumps")),
            ],
            JunkCategory::MemoryDump => vec![
                ScanPath::fixed_path("C:\\Windows\\Minidump"),
                ScanPath::fixed_path("C:\\Windows\\MEMORY.DMP"),
            ],
            JunkCategory::OldWindowsInstallation => vec![
                ScanPath::fixed_path("C:\\Windows.old"),
                ScanPath::fixed_path("C:\\$Windows.~BT"),
                ScanPath::fixed_path("C:\\$Windows.~WS"),
            ],
            JunkCategory::AppCache => vec![
                ScanPath::env_path("LOCALAPPDATA", Some("Temp")),
                ScanPath::env_path("APPDATA", Some("Local\\Temp")),
            ],
            JunkCategory::FontCache => vec![
                ScanPath::fixed_path("C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\FontCache"),
            ],
            JunkCategory::WindowsErrorReports => vec![
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\WER")),
                ScanPath::fixed_path("C:\\ProgramData\\Microsoft\\Windows\\WER"),
            ],
            JunkCategory::InstallerTemp => vec![
                // Windows Installer 补丁缓存
                ScanPath::fixed_path("C:\\Windows\\Installer\\$PatchCache$"),
                // 下载的安装程序
                ScanPath::env_path("LOCALAPPDATA", Some("Downloaded Installations")),
                // NVIDIA 安装缓存
                ScanPath::fixed_path("C:\\NVIDIA"),
                // AMD 安装缓存
                ScanPath::fixed_path("C:\\AMD"),
                // Intel 安装缓存
                ScanPath::fixed_path("C:\\Intel"),
            ],
            JunkCategory::ClipboardCache => vec![
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\Clipboard")),
            ],
        }
    }

    /// 获取该分类的文件过滤规则
    pub fn get_file_patterns(&self) -> Vec<&'static str> {
        match self {
            JunkCategory::WindowsTemp => vec!["*"],
            JunkCategory::SystemCache => vec!["*.pf"],
            JunkCategory::BrowserCache => vec!["*"],
            JunkCategory::RecycleBin => vec!["*"],
            JunkCategory::WindowsUpdate => vec!["*"],
            JunkCategory::ThumbnailCache => vec!["thumbcache_*.db", "iconcache_*.db"],
            JunkCategory::LogFiles => vec!["*.log", "*.etl", "*.evtx"],
            JunkCategory::MemoryDump => vec!["*.dmp", "MEMORY.DMP"],
            JunkCategory::OldWindowsInstallation => vec!["*"],
            JunkCategory::AppCache => vec!["*"],
            JunkCategory::FontCache => vec!["*"],
            JunkCategory::WindowsErrorReports => vec!["*"],
            JunkCategory::InstallerTemp => vec!["*"],
            JunkCategory::ClipboardCache => vec!["*"],
        }
    }

    /// 获取所有分类
    pub fn all() -> Vec<JunkCategory> {
        vec![
            JunkCategory::WindowsTemp,
            JunkCategory::SystemCache,
            JunkCategory::BrowserCache,
            JunkCategory::RecycleBin,
            JunkCategory::WindowsUpdate,
            JunkCategory::ThumbnailCache,
            JunkCategory::LogFiles,
            JunkCategory::MemoryDump,
            JunkCategory::OldWindowsInstallation,
            JunkCategory::AppCache,
            JunkCategory::FontCache,
            JunkCategory::WindowsErrorReports,
            JunkCategory::InstallerTemp,
            JunkCategory::ClipboardCache,
        ]
    }
}

/// 扫描路径配置
#[derive(Debug, Clone)]
pub struct ScanPath {
    /// 路径类型
    pub path_type: PathType,
    /// 基础路径或环境变量名
    pub base: String,
    /// 子路径（可选）
    pub sub_path: Option<String>,
}

/// 路径类型
#[derive(Debug, Clone)]
pub enum PathType {
    /// 固定路径
    Fixed,
    /// 基于环境变量的路径
    EnvBased,
}

impl ScanPath {
    /// 创建固定路径
    pub fn fixed_path(path: &str) -> Self {
        ScanPath {
            path_type: PathType::Fixed,
            base: path.to_string(),
            sub_path: None,
        }
    }

    /// 创建基于环境变量的路径
    pub fn env_path(env_var: &str, sub_path: Option<&str>) -> Self {
        ScanPath {
            path_type: PathType::EnvBased,
            base: env_var.to_string(),
            sub_path: sub_path.map(|s| s.to_string()),
        }
    }

    /// 解析为实际路径
    pub fn resolve(&self) -> Option<std::path::PathBuf> {
        match &self.path_type {
            PathType::Fixed => {
                let path = std::path::PathBuf::from(&self.base);
                if path.exists() {
                    Some(path)
                } else {
                    None
                }
            }
            PathType::EnvBased => {
                std::env::var(&self.base).ok().and_then(|base_path| {
                    let mut path = std::path::PathBuf::from(base_path);
                    if let Some(sub) = &self.sub_path {
                        path.push(sub);
                    }
                    if path.exists() {
                        Some(path)
                    } else {
                        None
                    }
                })
            }
        }
    }
}
