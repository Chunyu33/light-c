// ============================================================================
// 卸载残留扫描模块 — 置信度评分检测引擎
// ============================================================================
//
// 【架构说明】
// 本模块采用加权评分模型替代原有的布尔判断逻辑：
//   1. InstalledAppMap   — 从注册表构建已安装应用→路径的映射，推断 AppData 所有权
//   2. ScoringEngine     — 对每个目录计算置信度分数（0.0~1.0），综合多维信号
//   3. WhitelistRule     — 结构化白名单（Exact / Prefix / Pattern），禁止全局 contains
//   4. FileSystemProbe   — 有限深度文件探测（.exe / .dll / uninstall*.exe）
//
// 【评分信号】（基线 0.0，纯正向驱动）
//   正向（累加）：
//     +0.45  文件夹名精确匹配已知卸载应用 DisplayName（规范化后）
//     +0.35  文件夹内发现 uninstall*.exe / uninst*.exe
//     +0.25  文件夹名匹配 InstallLocation 末级目录（且应用已不在注册表中）
//     +0.20  包含 .exe 或 .dll 文件
//     +0.10  超过 min_days_old 天未修改
//     +0.10  匹配已知模拟器特征
//   负向（扣分）：
//     -0.60  文件夹名精确匹配已安装应用 InstallLocation 末级目录
//     -0.40  通用目录名（cache, logs, temp, data）
//     -0.30  位于 ProgramData
//     -0.20  7 天内有修改记录
//     -0.15  包名格式目录（com.xxx.yyy）
//     -0.15  纯版本号目录（1.2.3.4 / v2.0）
//     -0.50  已知共享厂商目录（Adobe, Microsoft 等）
//
// 【分类阈值】
//   score >= 0.65 → HighConfidenceLeftover（前端默认勾选）
//   0.40 <= score < 0.65 → Suspicious（前端不勾选，仅展示）
//   score < 0.40 → 不输出
//
// 【扫描路径】
// - %LOCALAPPDATA%      (C:\Users\<用户>\AppData\Local)
// - %APPDATA%           (C:\Users\<用户>\AppData\Roaming)
// - %LOCALAPPDATA%Low   (C:\Users\<用户>\AppData\LocalLow)
// - C:\ProgramData
//
// 【深度扫描模式】
// - 扫描模拟器残留（雷电、蓝叠、夜神、MuMu、MEmu、MSI App Player）
// - 扫描孤立虚拟磁盘文件（.vmdk, .vdi, .vhd）
//
// 【安全机制】
// 1. 结构化白名单保护：系统关键文件夹永不扫描
// 2. 置信度分级：只有高置信度条目默认勾选
// 3. ProgramData 降权：不直接标记为残留，仅降低分数
// 4. 大小阈值：忽略小于 1MB 的文件夹
// ============================================================================

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;
use winreg::enums::*;
use winreg::RegKey;

// ============================================================================
// 预编译正则（包名格式 / 版本号格式）
// ============================================================================

/// 包名格式：com.example.app、org.apache.commons 等
static RE_PACKAGE_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$").unwrap());

/// 纯版本号格式：1.2.3.4、v2.0 等
static RE_VERSION_FOLDER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^v?\d+(\.\d+){1,3}$").unwrap());

// ============================================================================
// 数据模型
// ============================================================================

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

/// 单个残留条目（前端兼容 + 新增置信度字段）
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
    /// 置信度分数 (0.0 ~ 1.0)，越高越可能是残留
    pub confidence: f32,
    /// 检测分类
    pub detection_category: DetectionCategory,
    /// 评分理由列表（中文，供 UI 悬浮提示）
    pub reasons: Vec<String>,
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

/// 检测分类（置信度分级）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DetectionCategory {
    /// 高置信度残留（score >= 0.7）
    HighConfidenceLeftover,
    /// 可疑（0.4 <= score < 0.7）
    Suspicious,
    /// 可能是正在使用的应用数据
    LikelyAppData,
    /// 系统共享目录
    SystemShared,
}

// ============================================================================
// 结构化白名单系统
// 禁止全局 contains 匹配，只允许精确/前缀/通配符模式
// ============================================================================

/// 白名单规则类型
enum WhitelistRule {
    /// 精确匹配（不区分大小写）
    Exact(String),
    /// 前缀匹配（不区分大小写）
    Prefix(String),
    /// 通配符模式匹配（简化版：仅支持 * 前后缀）
    Pattern(String),
}

impl WhitelistRule {
    /// 检查文件夹名是否命中规则
    fn matches(&self, folder_name_lower: &str) -> bool {
        match self {
            WhitelistRule::Exact(s) => folder_name_lower == s,
            WhitelistRule::Prefix(s) => folder_name_lower.starts_with(s),
            WhitelistRule::Pattern(p) => {
                // 简化通配符：仅支持 "prefix*" 和 "*suffix" 两种模式
                if let Some(prefix) = p.strip_suffix('*') {
                    folder_name_lower.starts_with(prefix)
                } else if let Some(suffix) = p.strip_prefix('*') {
                    folder_name_lower.ends_with(suffix)
                } else {
                    folder_name_lower == p
                }
            }
        }
    }
}

/// 构建结构化白名单规则列表
fn build_whitelist_rules() -> Vec<WhitelistRule> {
    vec![
        // ==================== Windows 系统核心（精确匹配） ====================
        WhitelistRule::Exact("microsoft".into()),
        WhitelistRule::Exact("windows".into()),
        WhitelistRule::Exact("packages".into()),
        WhitelistRule::Exact("windowsapps".into()),
        WhitelistRule::Exact("connecteddevicesplatform".into()),
        WhitelistRule::Exact("comms".into()),
        WhitelistRule::Exact("d3dscache".into()),
        WhitelistRule::Exact("diagnostics".into()),
        WhitelistRule::Exact("publishers".into()),
        WhitelistRule::Exact("temp".into()),
        WhitelistRule::Exact("temporary internet files".into()),
        // ==================== 硬件驱动相关（精确 + 前缀） ====================
        WhitelistRule::Exact("nvidia".into()),
        WhitelistRule::Exact("nvidia corporation".into()),
        WhitelistRule::Exact("amd".into()),
        WhitelistRule::Exact("intel".into()),
        WhitelistRule::Exact("realtek".into()),
        WhitelistRule::Exact("asus".into()),
        WhitelistRule::Exact("msi".into()),
        WhitelistRule::Exact("gigabyte".into()),
        WhitelistRule::Exact("logitech".into()),
        WhitelistRule::Exact("razer".into()),
        WhitelistRule::Exact("corsair".into()),
        WhitelistRule::Exact("steelseries".into()),
        // ==================== 运行时和框架（精确匹配） ====================
        WhitelistRule::Exact(".net".into()),
        WhitelistRule::Exact("dotnet".into()),
        WhitelistRule::Exact("java".into()),
        WhitelistRule::Exact("python".into()),
        WhitelistRule::Prefix("python3".into()),
        WhitelistRule::Exact("node".into()),
        WhitelistRule::Exact("nodejs".into()),
        WhitelistRule::Exact("npm".into()),
        WhitelistRule::Exact("yarn".into()),
        WhitelistRule::Exact("rust".into()),
        WhitelistRule::Exact("cargo".into()),
        WhitelistRule::Exact("go".into()),
        WhitelistRule::Exact("golang".into()),
        // ==================== 开发工具（精确 + 前缀） ====================
        WhitelistRule::Exact("vscode".into()),
        WhitelistRule::Exact("visual studio".into()),
        WhitelistRule::Prefix("visual studio".into()),
        WhitelistRule::Exact("jetbrains".into()),
        WhitelistRule::Exact("git".into()),
        WhitelistRule::Exact("github".into()),
        WhitelistRule::Exact("docker".into()),
        WhitelistRule::Exact("wsl".into()),
        WhitelistRule::Exact("tauri".into()),
        WhitelistRule::Exact("electron".into()),
        WhitelistRule::Exact("flutter".into()),
        WhitelistRule::Exact("android".into()),
        WhitelistRule::Exact("gradle".into()),
        WhitelistRule::Exact("maven".into()),
        WhitelistRule::Exact("composer".into()),
        WhitelistRule::Exact("pip".into()),
        WhitelistRule::Exact("conda".into()),
        WhitelistRule::Exact("anaconda".into()),
        WhitelistRule::Exact("miniconda".into()),
        WhitelistRule::Exact("virtualenv".into()),
        WhitelistRule::Exact("pnpm".into()),
        WhitelistRule::Exact("bun".into()),
        WhitelistRule::Exact("deno".into()),
        // ==================== 系统服务（精确匹配） ====================
        WhitelistRule::Exact("application data".into()),
        WhitelistRule::Exact("local settings".into()),
        WhitelistRule::Exact("history".into()),
        WhitelistRule::Exact("cookies".into()),
        WhitelistRule::Exact("cache".into()),
        WhitelistRule::Exact("caches".into()),
        WhitelistRule::Exact("logs".into()),
        WhitelistRule::Exact("crash reports".into()),
        WhitelistRule::Exact("crashdumps".into()),
        // ==================== 常见应用（精确匹配） ====================
        WhitelistRule::Exact("google".into()),
        WhitelistRule::Exact("chrome".into()),
        WhitelistRule::Exact("edge".into()),
        WhitelistRule::Exact("firefox".into()),
        WhitelistRule::Exact("mozilla".into()),
        WhitelistRule::Exact("opera".into()),
        WhitelistRule::Prefix("opera".into()),
        WhitelistRule::Exact("brave".into()),
        WhitelistRule::Exact("vivaldi".into()),
        WhitelistRule::Exact("wechat".into()),
        WhitelistRule::Exact("tencent".into()),
        WhitelistRule::Exact("qq".into()),
        WhitelistRule::Exact("discord".into()),
        WhitelistRule::Exact("slack".into()),
        WhitelistRule::Exact("zoom".into()),
        WhitelistRule::Exact("teams".into()),
        WhitelistRule::Exact("skype".into()),
        WhitelistRule::Exact("telegram".into()),
        WhitelistRule::Exact("telegram desktop".into()),
        WhitelistRule::Exact("whatsapp".into()),
        WhitelistRule::Exact("steam".into()),
        WhitelistRule::Exact("epic games".into()),
        WhitelistRule::Exact("ubisoft".into()),
        WhitelistRule::Exact("origin".into()),
        WhitelistRule::Exact("ea".into()),
        WhitelistRule::Exact("blizzard".into()),
        WhitelistRule::Exact("battle.net".into()),
        WhitelistRule::Exact("riot games".into()),
        WhitelistRule::Exact("adobe".into()),
        WhitelistRule::Exact("autodesk".into()),
        WhitelistRule::Exact("office".into()),
        WhitelistRule::Exact("onedrive".into()),
        WhitelistRule::Exact("dropbox".into()),
        WhitelistRule::Exact("icloud".into()),
        WhitelistRule::Exact("spotify".into()),
        WhitelistRule::Exact("vlc".into()),
        WhitelistRule::Exact("potplayer".into()),
        WhitelistRule::Exact("7-zip".into()),
        WhitelistRule::Exact("winrar".into()),
        WhitelistRule::Exact("bandizip".into()),
        // ==================== 隐藏文件夹（通配符） ====================
        WhitelistRule::Pattern(".*".into()),
    ]
}

// ============================================================================
// 已知共享厂商目录（负向信号）
// 这些目录高概率是多应用共享的，不应标记为残留
// ============================================================================

/// 已知共享厂商/系统目录名（精确匹配，小写）
/// 命中时扣分 -0.5
const KNOWN_SHARED_VENDORS: &[&str] = &[
    "adobe",
    "microsoft",
    "google",
    "apple",
    "intel",
    "nvidia",
    "nvidia corporation",
    "amd",
    "realtek",
    "qualcomm",
    "broadcom",
    "dell",
    "hp",
    "lenovo",
    "asus",
    "msi",
    "gigabyte",
    "logitech",
    "razer",
    "corsair",
    "steelseries",
    "mozilla",
];

/// 通用目录名（负向信号，小写）
/// 这些名称太通用，不太可能是某个特定已卸载应用的残留
/// 命中时扣分 -0.4
const GENERIC_FOLDER_NAMES: &[&str] = &[
    "cache",
    "caches",
    "logs",
    "log",
    "temp",
    "tmp",
    "data",
    "config",
    "settings",
    "preferences",
    "backup",
    "backups",
    "crash reports",
    "crashdumps",
    "diagnostics",
    "telemetry",
    "update",
    "updates",
    "downloads",
    "icons",
    "thumbnails",
];

// ============================================================================
// 模拟器特征库
// ============================================================================

/// 模拟器特征信息
struct EmulatorSignature {
    /// 模拟器名称
    name: &'static str,
    /// 文件夹名称关键字（精确或前缀匹配，小写）
    folder_keywords: &'static [&'static str],
    /// 注册表厂商名关键字
    #[allow(dead_code)]
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

/// 文件系统探测的最大递归深度
const FS_PROBE_MAX_DEPTH: usize = 4;

/// 可执行文件扩展名（用于文件系统探测正向信号）
const EXECUTABLE_EXTENSIONS: &[&str] = &["exe", "dll", "sys", "msi"];

// ============================================================================
// 已安装应用映射（路径所有权推断）
// ============================================================================

/// 单个已安装应用的信息
#[derive(Debug, Clone)]
struct InstalledAppInfo {
    /// 注册表中的显示名称（原始大小写）
    display_name: String,
    /// 安装路径（如有）
    install_location: Option<String>,
    /// 从安装路径推断的文件夹名（小写）
    inferred_folder_names: Vec<String>,
}

/// 已安装应用映射表
struct InstalledAppMap {
    /// 所有已安装应用信息
    apps: Vec<InstalledAppInfo>,
    /// 快速查找集合：所有已知的文件夹名（小写）→ 对应应用索引列表
    folder_to_app: HashMap<String, Vec<usize>>,
    /// 精确文件夹名集合（仅来源于 InstallLocation 的末级/倒数第二级目录）
    known_folders: HashSet<String>,
    /// 规范化后的 DisplayName 集合（小写，去除版本号和特殊字符）
    display_names: HashSet<String>,
}

/// 规范化 DisplayName：转小写，去除版本号、括号内容、多余空格
fn normalize_display_name(name: &str) -> String {
    let lower = name.to_lowercase();
    // 去除括号内容（如 "Foo App (x64)"  → "foo app"）
    let no_parens = lower.replace(|c: char| c == '(' || c == ')', " ");
    // 去除版本号模式（如 "v1.2.3"、"1.0.0"）
    let cleaned: String = no_parens
        .split_whitespace()
        .filter(|tok| !RE_VERSION_FOLDER.is_match(tok))
        .collect::<Vec<_>>()
        .join(" ");
    cleaned.trim().to_string()
}

/// InstalledAppMap 中不允许作为 parent 目录名的公共父目录
const EXCLUDED_PARENT_DIRS: &[&str] = &[
    "program files",
    "program files (x86)",
    "programdata",
    "users",
];

impl InstalledAppMap {
    /// 从注册表构建已安装应用映射
    ///
    /// known_folders 只保留两类来源：
    ///   a. InstallLocation 路径的最后一级目录名（小写）
    ///   b. InstallLocation 路径的倒数第二级目录名，排除公共父目录
    /// 不再拆分 DisplayName token，避免短 token 碰撞导致误判
    fn build() -> Self {
        let mut apps = Vec::new();
        let mut folder_to_app: HashMap<String, Vec<usize>> = HashMap::new();
        let mut known_folders = HashSet::new();
        let mut display_names = HashSet::new();

        // 【安全说明】只读取注册表，不进行任何写入操作
        let reg_paths = [
            (
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_LOCAL_MACHINE,
                r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
            (
                HKEY_CURRENT_USER,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            ),
        ];

        for (hkey, path) in reg_paths {
            if let Ok(key) = RegKey::predef(hkey).open_subkey_with_flags(path, KEY_READ) {
                for subkey_name in key.enum_keys().filter_map(|k| k.ok()) {
                    if let Ok(subkey) = key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                        let display_name: String =
                            subkey.get_value("DisplayName").unwrap_or_default();
                        if display_name.is_empty() {
                            continue;
                        }

                        let install_location: Option<String> = subkey
                            .get_value::<String, _>("InstallLocation")
                            .ok()
                            .filter(|s| !s.is_empty());

                        // 规范化 DisplayName 并加入集合
                        let normalized = normalize_display_name(&display_name);
                        if !normalized.is_empty() {
                            display_names.insert(normalized);
                        }

                        // 仅从 InstallLocation 推断文件夹名，不拆分 DisplayName token
                        let mut inferred = Vec::new();

                        if let Some(ref loc) = install_location {
                            let loc_path = Path::new(loc);
                            // a. 末级目录名
                            if let Some(folder) = loc_path.file_name() {
                                let name = folder.to_string_lossy().to_lowercase();
                                if !name.is_empty() {
                                    inferred.push(name);
                                }
                            }
                            // b. 倒数第二级目录名（排除公共父目录）
                            if let Some(parent) = loc_path.parent() {
                                if let Some(vendor) = parent.file_name() {
                                    let v = vendor.to_string_lossy().to_lowercase();
                                    if !v.is_empty() && !EXCLUDED_PARENT_DIRS.contains(&v.as_str())
                                    {
                                        inferred.push(v);
                                    }
                                }
                            }
                        }

                        // 去重
                        inferred.sort();
                        inferred.dedup();

                        let app_idx = apps.len();
                        for name in &inferred {
                            folder_to_app.entry(name.clone()).or_default().push(app_idx);
                            known_folders.insert(name.clone());
                        }

                        apps.push(InstalledAppInfo {
                            display_name,
                            install_location,
                            inferred_folder_names: inferred,
                        });
                    }
                }
            }
        }

        log::info!(
            "已安装应用映射构建完成: {} 个应用, {} 个已知文件夹名, {} 个 DisplayName",
            apps.len(),
            known_folders.len(),
            display_names.len()
        );

        InstalledAppMap {
            apps,
            folder_to_app,
            known_folders,
            display_names,
        }
    }

    /// 检查文件夹名是否精确匹配某个已安装应用的 InstallLocation 末级目录
    fn has_exact_owner(&self, folder_name_lower: &str) -> bool {
        self.known_folders.contains(folder_name_lower)
    }

    /// 查找文件夹名对应的已安装应用（精确匹配 InstallLocation，返回应用名）
    fn find_owner(&self, folder_name_lower: &str) -> Option<&str> {
        if let Some(indices) = self.folder_to_app.get(folder_name_lower) {
            if let Some(&idx) = indices.first() {
                return Some(&self.apps[idx].display_name);
            }
        }
        None
    }

    /// 检查文件夹名是否匹配某个已知应用的规范化 DisplayName
    fn matches_display_name(&self, folder_name_lower: &str) -> bool {
        self.display_names.contains(folder_name_lower)
    }

    /// 结构化路径所有权推断：检查文件夹名是否映射到某个已安装应用的 InstallLocation
    fn has_inferred_ownership(&self, folder_name_lower: &str) -> bool {
        self.has_exact_owner(folder_name_lower)
    }
}

// ============================================================================
// 评分引擎
// ============================================================================

/// 评分上下文（单个目录的评分中间结果）
struct ScoringContext {
    score: f32,
    reasons: Vec<String>,
}

impl ScoringContext {
    fn new() -> Self {
        // 基线分 0.0，所有分数由正向信号驱动
        Self {
            score: 0.0,
            reasons: Vec::new(),
        }
    }

    fn add(&mut self, delta: f32, reason: String) {
        self.score += delta;
        self.reasons.push(reason);
    }

    /// 将分数限制在 [0.0, 1.0]
    fn finalize(&mut self) {
        self.score = self.score.clamp(0.0, 1.0);
    }

    /// 根据最终分数确定检测分类
    fn category(&self) -> DetectionCategory {
        if self.score >= 0.65 {
            DetectionCategory::HighConfidenceLeftover
        } else if self.score >= 0.40 {
            DetectionCategory::Suspicious
        } else {
            DetectionCategory::LikelyAppData
        }
    }
}

// ============================================================================
// 文件系统探测
// ============================================================================

/// 文件系统探测结果
struct FsProbeResult {
    /// 发现的可执行文件数量
    executable_count: u32,
    /// 发现 uninstall*.exe
    has_uninstaller: bool,
    /// 总文件数（在探测深度内）
    file_count: u32,
    /// 总大小（字节）
    total_size: u64,
}

/// 对目录执行有限深度文件系统探测
fn probe_directory(path: &Path, max_depth: usize) -> FsProbeResult {
    let mut result = FsProbeResult {
        executable_count: 0,
        has_uninstaller: false,
        file_count: 0,
        total_size: 0,
    };

    for entry in WalkDir::new(path)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        if let Ok(metadata) = entry.metadata() {
            result.total_size += metadata.len();
            result.file_count += 1;
        }

        let file_name = entry.file_name().to_string_lossy().to_lowercase();

        // 检查可执行文件
        if let Some(ext) = entry.path().extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if EXECUTABLE_EXTENSIONS.contains(&ext_lower.as_str()) {
                result.executable_count += 1;
            }
        }

        // 检查卸载程序
        if file_name.starts_with("uninstall") || file_name.starts_with("uninst") {
            if file_name.ends_with(".exe") {
                result.has_uninstaller = true;
            }
        }
    }

    result
}

// ============================================================================
// 卸载残留扫描器
// ============================================================================

/// 卸载残留扫描器（置信度评分引擎）
pub struct LeftoverScanner {
    /// 已安装应用映射表
    app_map: InstalledAppMap,
    /// 结构化白名单规则
    whitelist: Vec<WhitelistRule>,
    /// 最小文件夹大小阈值（字节）
    min_size_threshold: u64,
    /// 最小未修改天数（用于正向加分）
    min_days_old: u64,
    /// 是否启用深度扫描模式
    deep_scan: bool,
    /// 最低输出置信度阈值（低于此分数的条目不输出）
    min_confidence_threshold: f32,
}

impl LeftoverScanner {
    /// 创建新的扫描器实例（默认启用完整扫描，包括模拟器残留和虚拟磁盘检测）
    pub fn new() -> Self {
        let app_map = InstalledAppMap::build();
        let whitelist = build_whitelist_rules();
        log::info!(
            "置信度评分引擎初始化: {} 个已安装应用, {} 条白名单规则",
            app_map.apps.len(),
            whitelist.len(),
        );

        LeftoverScanner {
            app_map,
            whitelist,
            min_size_threshold: 1024 * 1024, // 1MB
            min_days_old: 7,
            deep_scan: true,
            // 只输出 score >= 0.40 的条目（Suspicious 阈值）
            min_confidence_threshold: 0.40,
        }
    }

    /// 兼容旧接口，参数已忽略，始终启用完整扫描
    pub fn with_deep_scan(_deep_scan: bool) -> Self {
        Self::new()
    }

    /// 执行卸载残留扫描
    pub fn scan(&self) -> LeftoverScanResult {
        let start_time = std::time::Instant::now();
        let mut leftovers = Vec::new();
        let mut total_size = 0u64;

        // 获取扫描路径
        let scan_paths = self.get_scan_paths();

        for (base_path, source) in &scan_paths {
            if !base_path.exists() {
                continue;
            }

            log::info!("扫描残留目录: {:?}", base_path);

            // 只扫描一级子目录
            if let Ok(entries) = fs::read_dir(base_path) {
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

                    // 白名单检查（硬性排除）
                    if self.is_whitelisted(&folder_name) {
                        continue;
                    }

                    let folder_lower = folder_name.to_lowercase();

                    // 预过滤：包名格式目录（com.xxx.yyy）→ 直接跳过
                    if RE_PACKAGE_NAME.is_match(&folder_lower) {
                        continue;
                    }
                    // 预过滤：纯版本号目录（1.2.3.4、v2.0）→ 直接跳过
                    if RE_VERSION_FOLDER.is_match(&folder_lower) {
                        continue;
                    }

                    // 模拟器检测（高置信度短路）
                    let emulator_match = self.detect_emulator(&folder_name);

                    // 文件系统探测（有限深度）
                    let probe = probe_directory(&path, FS_PROBE_MAX_DEPTH);

                    // 大小阈值过滤
                    let threshold = if emulator_match.is_some() {
                        100 * 1024 // 模拟器残留降低阈值到 100KB
                    } else {
                        self.min_size_threshold
                    };
                    if probe.total_size < threshold {
                        continue;
                    }

                    // 获取最后修改时间
                    let last_modified = Self::get_last_modified(&path);

                    // ============ 评分（基线 0.0） ============
                    let mut ctx = ScoringContext::new();

                    if let Some(emu_name) = &emulator_match {
                        // 【5】模拟器命中 → 直接 0.90，跳过其他信号
                        ctx.score = 0.90;
                        ctx.reasons.push(format!("匹配已知模拟器: {}", emu_name));
                    } else {
                        // ---- 正向信号 ----

                        // +0.45 文件夹名精确匹配已知卸载应用的 DisplayName（规范化后）
                        if self.app_map.matches_display_name(&folder_lower) {
                            ctx.add(0.45, format!("匹配已知应用 DisplayName: {}", folder_name));
                        }

                        // +0.35 文件夹内发现 uninstall*.exe / uninst*.exe
                        if probe.has_uninstaller {
                            ctx.add(0.35, "包含卸载程序残留 (uninstall*.exe)".into());
                        }

                        // +0.25 文件夹名匹配 InstallLocation 末级目录且应用已不在注册表
                        // （find_owner 返回 Some 说明应用仍在注册表，返回 None 但
                        //  known_folders 曾包含说明是卸载后残留 —— 但当前 build()
                        //  只保留在册应用，所以此信号暂不触发，留作未来增量扫描扩展）

                        // +0.20 包含 .exe 或 .dll 文件
                        if probe.executable_count > 0 {
                            ctx.add(
                                0.20,
                                format!("包含 {} 个可执行文件", probe.executable_count),
                            );
                        }

                        // 修改时间（只计算一次）
                        let days_old = Self::get_days_since_modified(&path);

                        // +0.10 超过 min_days_old 天未修改
                        if days_old > self.min_days_old {
                            ctx.add(0.10, format!("已 {} 天未修改", days_old));
                        }

                        // ---- 负向信号 ----

                        // -0.60 文件夹名精确匹配已安装应用的 InstallLocation 末级目录
                        if let Some(owner) = self.app_map.find_owner(&folder_lower) {
                            ctx.add(-0.60, format!("映射到已安装应用: {}", owner));
                        }

                        // -0.40 通用目录名
                        if GENERIC_FOLDER_NAMES.contains(&folder_lower.as_str()) {
                            ctx.add(-0.40, format!("通用目录名: {}", folder_name));
                        }

                        // -0.30 位于 ProgramData
                        if *source == LeftoverSource::ProgramData {
                            ctx.add(-0.30, "位于 ProgramData（系统共享目录）".into());
                        }

                        // -0.20 7 天内有修改记录
                        if days_old < 7 {
                            ctx.add(-0.20, format!("最近 {} 天内有修改", days_old));
                        }

                        // -0.15 包名格式目录（预过滤已跳过大部分，此处作为负向信号兜底）
                        // （已在预过滤阶段 skip，此处不再重复）

                        // -0.15 纯版本号目录
                        // （已在预过滤阶段 skip，此处不再重复）

                        // -0.50 已知共享厂商目录
                        if KNOWN_SHARED_VENDORS.contains(&folder_lower.as_str()) {
                            ctx.add(-0.50, format!("已知共享厂商目录: {}", folder_name));
                        }
                    }

                    ctx.finalize();

                    // 过滤低分条目（score < 0.40 不输出）
                    if ctx.score < self.min_confidence_threshold {
                        continue;
                    }

                    let detection_category = if emulator_match.is_some() {
                        DetectionCategory::HighConfidenceLeftover
                    } else if *source == LeftoverSource::ProgramData && ctx.score < 0.40 {
                        DetectionCategory::SystemShared
                    } else {
                        ctx.category()
                    };

                    let leftover_type = if emulator_match.is_some() {
                        LeftoverType::Emulator
                    } else {
                        LeftoverType::Normal
                    };

                    leftovers.push(LeftoverEntry {
                        path: path.to_string_lossy().to_string(),
                        size: probe.total_size,
                        app_name: folder_name,
                        source: source.clone(),
                        last_modified,
                        file_count: probe.file_count,
                        is_emulator: emulator_match.is_some(),
                        is_virtual_disk: false,
                        leftover_type,
                        confidence: ctx.score,
                        detection_category,
                        reasons: ctx.reasons,
                    });

                    total_size += probe.total_size;
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

        // 按置信度降序排列（同分则按大小降序）
        leftovers.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.size.cmp(&a.size))
        });

        let scan_duration_ms = start_time.elapsed().as_millis() as u64;
        log::info!(
            "卸载残留扫描完成: 发现 {} 个条目 (高置信度 {}, 可疑 {}), 总大小 {} 字节, 耗时 {}ms",
            leftovers.len(),
            leftovers
                .iter()
                .filter(|l| l.detection_category == DetectionCategory::HighConfidenceLeftover)
                .count(),
            leftovers
                .iter()
                .filter(|l| l.detection_category == DetectionCategory::Suspicious)
                .count(),
            total_size,
            scan_duration_ms
        );

        LeftoverScanResult {
            leftovers,
            total_size,
            scan_duration_ms,
        }
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    /// 白名单检查（结构化规则匹配）
    fn is_whitelisted(&self, folder_name: &str) -> bool {
        let name_lower = folder_name.to_lowercase();
        self.whitelist.iter().any(|rule| rule.matches(&name_lower))
    }

    /// 模拟器检测（精确/前缀匹配，非全局 contains）
    /// 返回匹配到的模拟器名称（如有）
    fn detect_emulator(&self, folder_name: &str) -> Option<String> {
        let name_lower = folder_name.to_lowercase();

        for sig in EMULATOR_SIGNATURES {
            for keyword in sig.folder_keywords {
                // 使用精确匹配或前缀匹配代替 contains
                if name_lower == *keyword || name_lower.starts_with(keyword) {
                    log::debug!("检测到模拟器残留: {} (匹配 {})", folder_name, sig.name);
                    return Some(sig.name.to_string());
                }
            }
        }

        None
    }

    /// 【深度扫描】扫描孤立虚拟磁盘文件
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
                    let ext = path
                        .extension()
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

                    // 检查父目录是否对应已安装应用
                    let parent_folder = path
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .unwrap_or_default();

                    if self.app_map.has_inferred_ownership(&parent_folder) {
                        continue;
                    }

                    let file_name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let last_modified = Self::get_last_modified(path);

                    log::info!(
                        "发现孤立虚拟磁盘文件: {} ({} MB)",
                        path.display(),
                        size / 1024 / 1024
                    );

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
                        confidence: 0.85,
                        detection_category: DetectionCategory::HighConfidenceLeftover,
                        reasons: vec!["孤立虚拟磁盘文件，未关联已安装应用".into()],
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

    /// 获取文件夹最后修改时间（Unix 时间戳）
    fn get_last_modified(path: &Path) -> i64 {
        if let Ok(metadata) = fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    return duration.as_secs() as i64;
                }
            }
        }
        0
    }

    /// 获取距离上次修改的天数
    fn get_days_since_modified(path: &Path) -> u64 {
        if let Ok(metadata) = fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                let age = SystemTime::now()
                    .duration_since(modified)
                    .unwrap_or(Duration::ZERO);
                return age.as_secs() / (24 * 60 * 60);
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

// ============================================================================
// 卸载残留删除操作
// ============================================================================

/// 卸载残留删除结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LeftoverDeleteResult {
    /// 成功删除的文件夹数
    pub deleted_count: u32,
    /// 释放的空间大小（字节）
    pub deleted_size: u64,
    /// 删除失败的路径
    pub failed_paths: Vec<String>,
    /// 错误信息列表
    pub errors: Vec<String>,
}

/// 删除卸载残留文件夹
///
/// 对每个路径执行安全检查后递归删除，返回详细结果
pub fn delete_folders(paths: Vec<String>) -> LeftoverDeleteResult {
    let mut deleted_count = 0u32;
    let mut deleted_size = 0u64;
    let mut failed_paths = Vec::new();
    let mut errors = Vec::new();

    for path in paths {
        let path_buf = std::path::PathBuf::from(&path);

        // 安全检查：确保路径在允许的目录内
        if !is_safe_leftover_path(&path_buf) {
            failed_paths.push(path.clone());
            errors.push(format!("路径不在允许的目录内: {}", path));
            continue;
        }

        // 删除前计算文件夹大小
        let folder_size = calculate_dir_size(&path_buf);

        match std::fs::remove_dir_all(&path_buf) {
            Ok(_) => {
                deleted_count += 1;
                deleted_size += folder_size;
            }
            Err(e) => {
                failed_paths.push(path.clone());
                errors.push(format!("删除失败 {}: {}", path, e));
            }
        }
    }

    LeftoverDeleteResult {
        deleted_count,
        deleted_size,
        failed_paths,
        errors,
    }
}

/// 递归计算目录大小
fn calculate_dir_size(path: &std::path::Path) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    size += metadata.len();
                }
            } else if entry_path.is_dir() {
                size += calculate_dir_size(&entry_path);
            }
        }
    }
    size
}

/// 检查路径是否在允许删除的目录内
fn is_safe_leftover_path(path: &std::path::Path) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();
    let allowed_prefixes = ["appdata\\local", "appdata\\roaming", "programdata"];
    allowed_prefixes
        .iter()
        .any(|prefix| path_str.contains(prefix))
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_whitelist_exact() {
        let rules = build_whitelist_rules();
        // 精确匹配
        assert!(rules.iter().any(|r| r.matches("microsoft")));
        assert!(rules.iter().any(|r| r.matches("nvidia corporation")));
        // 隐藏文件夹通配符
        assert!(rules.iter().any(|r| r.matches(".vscode")));
        assert!(rules.iter().any(|r| r.matches(".git")));
        // 不匹配随机名
        assert!(!rules.iter().any(|r| r.matches("somerandomapp")));
    }

    #[test]
    fn test_whitelist_no_global_contains() {
        // 确保白名单不会因为 contains 而误匹配
        let rules = build_whitelist_rules();
        // "microsoftedge" 不该被 "microsoft" 精确规则匹配
        assert!(!rules.iter().any(|r| r.matches("microsoftedge")));
        // "amdgpu_settings" 不该被 "amd" 精确规则匹配
        assert!(!rules.iter().any(|r| r.matches("amdgpu_settings")));
    }

    #[test]
    fn test_scoring_context() {
        let mut ctx = ScoringContext::new();
        // 基线 0.0
        assert!((ctx.score - 0.0).abs() < f32::EPSILON);

        ctx.add(0.45, "测试正向信号".into());
        ctx.add(0.35, "卸载程序残留".into());
        ctx.finalize();
        assert!((ctx.score - 0.80).abs() < 0.01);
        assert_eq!(ctx.category(), DetectionCategory::HighConfidenceLeftover);
    }

    #[test]
    fn test_scoring_clamped() {
        let mut ctx = ScoringContext::new();
        ctx.add(1.5, "超大正向".into());
        ctx.finalize();
        assert!((ctx.score - 1.0).abs() < f32::EPSILON);

        let mut ctx2 = ScoringContext::new();
        ctx2.add(-2.0, "超大负向".into());
        ctx2.finalize();
        assert!((ctx2.score - 0.0).abs() < f32::EPSILON);
    }

    #[test]
    fn test_detection_category_thresholds() {
        // score >= 0.65 → HighConfidenceLeftover
        let mut ctx = ScoringContext::new();
        ctx.score = 0.70;
        assert_eq!(ctx.category(), DetectionCategory::HighConfidenceLeftover);

        // 0.40 <= score < 0.65 → Suspicious
        ctx.score = 0.50;
        assert_eq!(ctx.category(), DetectionCategory::Suspicious);

        // score < 0.40 → LikelyAppData
        ctx.score = 0.30;
        assert_eq!(ctx.category(), DetectionCategory::LikelyAppData);
    }

    #[test]
    fn test_generic_folder_names() {
        assert!(GENERIC_FOLDER_NAMES.contains(&"cache"));
        assert!(GENERIC_FOLDER_NAMES.contains(&"logs"));
        assert!(GENERIC_FOLDER_NAMES.contains(&"temp"));
        assert!(!GENERIC_FOLDER_NAMES.contains(&"foobar"));
    }

    #[test]
    fn test_known_shared_vendors() {
        assert!(KNOWN_SHARED_VENDORS.contains(&"adobe"));
        assert!(KNOWN_SHARED_VENDORS.contains(&"microsoft"));
        assert!(!KNOWN_SHARED_VENDORS.contains(&"somerandomvendor"));
    }

    // ===== 新增测试 =====

    #[test]
    fn test_score_starts_at_zero() {
        // 验证 ScoringContext::new() 初始分为 0.0
        let ctx = ScoringContext::new();
        assert!((ctx.score - 0.0).abs() < f32::EPSILON, "基线分应为 0.0");
    }

    #[test]
    fn test_package_name_filtered() {
        // 验证包名格式目录被预过滤跳过
        assert!(
            RE_PACKAGE_NAME.is_match("com.example.app"),
            "com.example.app 应匹配包名格式"
        );
        assert!(
            RE_PACKAGE_NAME.is_match("org.apache.commons.lang"),
            "org.apache.commons.lang 应匹配"
        );
        assert!(
            !RE_PACKAGE_NAME.is_match("steamapp"),
            "steamapp 不应匹配包名格式"
        );
        assert!(
            !RE_PACKAGE_NAME.is_match("com.x"),
            "com.x 只有两段，不应匹配"
        );
    }

    #[test]
    fn test_version_folder_filtered() {
        // 验证纯版本号目录被预过滤跳过
        assert!(
            RE_VERSION_FOLDER.is_match("1.2.3.4"),
            "1.2.3.4 应匹配版本号格式"
        );
        assert!(RE_VERSION_FOLDER.is_match("v2.0"), "v2.0 应匹配版本号格式");
        assert!(
            RE_VERSION_FOLDER.is_match("10.0.1"),
            "10.0.1 应匹配版本号格式"
        );
        assert!(
            !RE_VERSION_FOLDER.is_match("v2"),
            "v2 没有点号分隔，不应匹配"
        );
        assert!(
            !RE_VERSION_FOLDER.is_match("foobar"),
            "foobar 不应匹配版本号格式"
        );
    }

    #[test]
    fn test_high_confidence_threshold() {
        // 验证阈值 >= 0.65 分类为 HighConfidenceLeftover
        let mut ctx = ScoringContext::new();
        ctx.score = 0.65;
        assert_eq!(
            ctx.category(),
            DetectionCategory::HighConfidenceLeftover,
            "score = 0.65 应为 HighConfidenceLeftover"
        );

        ctx.score = 0.64;
        assert_eq!(
            ctx.category(),
            DetectionCategory::Suspicious,
            "score = 0.64 应为 Suspicious"
        );

        ctx.score = 0.40;
        assert_eq!(
            ctx.category(),
            DetectionCategory::Suspicious,
            "score = 0.40 应为 Suspicious"
        );

        ctx.score = 0.39;
        assert_eq!(
            ctx.category(),
            DetectionCategory::LikelyAppData,
            "score = 0.39 应为 LikelyAppData"
        );
    }

    #[test]
    fn test_no_token_in_known_folders() {
        // 验证 known_folders 不包含长度 <= 3 的纯 token
        // InstalledAppMap::build() 不再拆分 DisplayName，因此 known_folders
        // 只来自 InstallLocation 末级/倒数第二级目录名
        let map = InstalledAppMap::build();
        for folder in &map.known_folders {
            // 长度 <= 3 的条目必须是合法目录名（如 "amd"、"git"），不是 token 碎片
            // 验证方式：known_folders 中不应出现纯数字或常见 token 碎片
            let is_pure_numeric = folder.chars().all(|c| c.is_ascii_digit());
            assert!(
                !is_pure_numeric || folder.len() > 3,
                "known_folders 不应包含纯数字短 token: \"{}\"",
                folder
            );
        }
    }
}
