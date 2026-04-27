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
    /// DirectX/GPU Shader 缓存
    ShaderCache,
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
            JunkCategory::ShaderCache => "DirectX Shader 缓存",
        }
    }

    /// 获取分类的描述信息
    pub fn description(&self) -> &'static str {
        match self {
            JunkCategory::WindowsTemp => "系统和应用程序产生的临时文件，可安全删除",
            JunkCategory::SystemCache => "Windows系统预读取和分发缓存文件",
            JunkCategory::BrowserCache => {
                "浏览器保存的网页资源缓存（不含 Cookie 和登录状态），删除后网页首次访问较慢"
            }
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
            JunkCategory::ShaderCache => "GPU 着色器编译缓存，删除后游戏和应用首次运行时会重新生成",
        }
    }

    /// 获取分类的风险等级 (1-5, 1最安全)
    pub fn risk_level(&self) -> u8 {
        match self {
            JunkCategory::WindowsTemp => 1,
            JunkCategory::ThumbnailCache => 1,
            JunkCategory::FontCache => 1,
            JunkCategory::ClipboardCache => 1,
            JunkCategory::ShaderCache => 1,
            JunkCategory::BrowserCache => 2,
            JunkCategory::WindowsUpdate => 2,
            JunkCategory::LogFiles => 2,
            JunkCategory::WindowsErrorReports => 2,
            JunkCategory::InstallerTemp => 2,
            JunkCategory::RecycleBin => 3,
            JunkCategory::SystemCache => 3,
            JunkCategory::AppCache => 3,
            JunkCategory::MemoryDump => 3,
            JunkCategory::OldWindowsInstallation => 3,
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
                ScanPath::glob_path("LOCALAPPDATA", "Google\\Chrome\\User Data\\Default\\Cache"),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Google\\Chrome\\User Data\\Default\\Code Cache",
                ),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Google\\Chrome\\User Data\\Default\\GPUCache",
                ),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Google\\Chrome\\User Data\\Profile *\\Cache",
                ),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Google\\Chrome\\User Data\\Profile *\\Code Cache",
                ),
                ScanPath::glob_path("LOCALAPPDATA", "Google\\Chrome\\User Data\\ShaderCache"),
                // Edge - 主缓存
                ScanPath::glob_path("LOCALAPPDATA", "Microsoft\\Edge\\User Data\\Default\\Cache"),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Microsoft\\Edge\\User Data\\Default\\Code Cache",
                ),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Microsoft\\Edge\\User Data\\Default\\GPUCache",
                ),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Microsoft\\Edge\\User Data\\Profile *\\Cache",
                ),
                ScanPath::glob_path(
                    "LOCALAPPDATA",
                    "Microsoft\\Edge\\User Data\\Profile *\\Code Cache",
                ),
                ScanPath::glob_path("LOCALAPPDATA", "Microsoft\\Edge\\User Data\\ShaderCache"),
                // Firefox - 具体缓存目录
                ScanPath::glob_path("LOCALAPPDATA", "Mozilla\\Firefox\\Profiles\\*\\cache2"),
                ScanPath::glob_path("APPDATA", "Mozilla\\Firefox\\Profiles\\*\\cache2"),
                // Brave 浏览器
                ScanPath::env_path(
                    "LOCALAPPDATA",
                    Some("BraveSoftware\\Brave-Browser\\User Data\\Default\\Cache"),
                ),
                ScanPath::env_path(
                    "LOCALAPPDATA",
                    Some("BraveSoftware\\Brave-Browser\\User Data\\Default\\Code Cache"),
                ),
                // Opera 浏览器
                ScanPath::env_path("APPDATA", Some("Opera Software\\Opera Stable\\Cache")),
            ],
            JunkCategory::RecycleBin => get_all_drive_letters()
                .into_iter()
                .map(|letter| ScanPath::fixed_path(&format!("{}:\\$Recycle.Bin", letter)))
                .collect(),
            JunkCategory::WindowsUpdate => vec![ScanPath::fixed_path(
                "C:\\Windows\\SoftwareDistribution\\Download",
            )],
            JunkCategory::ThumbnailCache => vec![ScanPath::env_path(
                "LOCALAPPDATA",
                Some("Microsoft\\Windows\\Explorer"),
            )],
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
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\INetCache\\IE")),
                ScanPath::env_path("LOCALAPPDATA", Some("Microsoft\\Windows\\WebCache")),
                ScanPath::glob_path("LOCALAPPDATA", "Packages\\*\\LocalCache"),
            ],
            JunkCategory::FontCache => vec![ScanPath::fixed_path(
                "C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Local\\FontCache",
            )],
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
            JunkCategory::ClipboardCache => vec![ScanPath::env_path(
                "LOCALAPPDATA",
                Some("Microsoft\\Windows\\Clipboard"),
            )],
            JunkCategory::ShaderCache => vec![
                ScanPath::fixed_path("C:\\Windows\\System32\\d3d_cache"),
                ScanPath::env_path("LOCALAPPDATA", Some("D3DSCache")),
                ScanPath::env_path("LOCALAPPDATA", Some("AMD\\DxCache")),
                ScanPath::env_path("LOCALAPPDATA", Some("NVIDIA\\DXCache")),
                ScanPath::env_path("LOCALAPPDATA", Some("Intel\\ShaderCache")),
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
            JunkCategory::ShaderCache => vec!["*"],
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
            JunkCategory::ShaderCache,
        ]
    }
}

/// 获取当前系统中存在的驱动器盘符
fn get_all_drive_letters() -> Vec<char> {
    ('A'..='Z')
        .filter(|letter| {
            let path = std::path::PathBuf::from(format!("{}:\\", letter));
            path.exists() && path.is_dir()
        })
        .collect()
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
    /// 基于环境变量的通配符展开路径
    GlobExpand,
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

    /// 创建基于环境变量的通配符路径
    pub fn glob_path(env_var: &str, pattern: &str) -> Self {
        ScanPath {
            path_type: PathType::GlobExpand,
            base: env_var.to_string(),
            sub_path: Some(pattern.to_string()),
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
                    log::debug!("扫描路径不存在，跳过: {:?}", path);
                    None
                }
            }
            PathType::EnvBased => std::env::var(&self.base).ok().and_then(|base_path| {
                let mut path = std::path::PathBuf::from(base_path);
                if let Some(sub) = &self.sub_path {
                    path.push(sub);
                }
                if path.exists() {
                    Some(path)
                } else {
                    log::debug!("扫描路径不存在，跳过: {:?}", path);
                    None
                }
            }),
            PathType::GlobExpand => None,
        }
    }

    /// 解析为实际路径列表
    pub fn resolve_all(&self) -> Vec<std::path::PathBuf> {
        match &self.path_type {
            PathType::Fixed | PathType::EnvBased => self.resolve().into_iter().collect(),
            PathType::GlobExpand => {
                let Some(pattern) = &self.sub_path else {
                    return Vec::new();
                };

                let Ok(base_path) = std::env::var(&self.base) else {
                    log::debug!("环境变量不存在，跳过 Glob 展开: {}", self.base);
                    return Vec::new();
                };

                let mut full_pattern = std::path::PathBuf::from(base_path);
                full_pattern.push(pattern);
                let pattern_string = full_pattern.to_string_lossy().to_string();

                let results: Vec<std::path::PathBuf> = match glob::glob(&pattern_string) {
                    Ok(paths) => paths
                        .filter_map(|entry| entry.ok())
                        .filter(|path| path.exists())
                        .collect(),
                    Err(err) => {
                        log::debug!("Glob 模式无效，跳过: {} ({})", pattern_string, err);
                        Vec::new()
                    }
                };

                log::debug!(
                    "Glob 展开 '{}' 得到 {} 个路径",
                    pattern_string,
                    results.len()
                );
                results
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_categories_covered() {
        const JUNK_CATEGORY_VARIANT_COUNT: usize = 15;
        assert_eq!(JunkCategory::all().len(), JUNK_CATEGORY_VARIANT_COUNT);
    }

    #[test]
    fn test_recycle_bin_multi_drive() {
        assert!(get_all_drive_letters().contains(&'C'));
    }

    #[test]
    fn test_glob_path_resolve_all() {
        let fixed_path = ScanPath::fixed_path("C:\\");
        assert_eq!(
            fixed_path.resolve_all().len(),
            fixed_path.resolve().map_or(0, |_| 1)
        );

        let env_path = ScanPath::env_path("LOCALAPPDATA", None);
        assert_eq!(
            env_path.resolve_all().len(),
            env_path.resolve().map_or(0, |_| 1)
        );
    }
}
