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
// 【评分信号】（基线 0.0，正向识别 + 保护性降权）
//   正向（累加）：
//     +0.35  文件夹内发现 uninstall*.exe / uninst*.exe
//     +0.25  文件夹名匹配 InstallLocation 末级目录（且应用已不在注册表中）
//     +0.20  包含 .exe 或 .dll 文件
//     +0.10  超过 min_days_old 天未修改
//     +0.10  匹配已知模拟器特征
//   负向（扣分）：
//     -0.45  文件夹名精确匹配当前已安装应用 DisplayName（规范化后）
//     -0.60  文件夹名精确匹配已安装应用 InstallLocation 末级目录
//     -0.40  通用目录名（cache, logs, temp, data）
//     -0.30  位于 ProgramData
//     -0.20  7 天内有修改记录
//     -0.15  包名格式目录（com.xxx.yyy）
//     -0.15  纯版本号目录（1.2.3.4 / v2.0）
//     -0.50  已知共享厂商目录（Adobe, Microsoft 等）
//
// 【分类阈值】
//   score >= 0.75 → HighConfidenceLeftover（前端默认勾选）
//   0.30 <= score < 0.75 → Suspicious（前端不勾选，仅展示）
//   score < 0.30 → 不输出
//   两个阈值都定义成常量（HIGH_CONFIDENCE_SCORE / SUSPICIOUS_SCORE），分档和过滤共用同一份。
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
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};
use walkdir::WalkDir;
use winreg::enums::*;
use winreg::RegKey;

use super::leftover_whitelist;

// ============================================================================
// 安装历史持久化（用于检测"曾经安装但现已卸载"的残留文件夹）
// 使用统一数据目录管理模块 (crate::data_dir) 获取存储路径
// ============================================================================

/// 安装历史缓存文件名
const INSTALL_HISTORY_FILE: &str = "install_history.json";

/// 从持久化缓存加载历史安装文件夹名集合
fn load_install_history() -> HashSet<String> {
    let path = crate::data_dir::get_data_dir().join(INSTALL_HISTORY_FILE);
    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => HashSet::new(),
    }
}

/// 将当前已知安装文件夹名持久化保存（与历史合并）
fn save_install_history(folders: &HashSet<String>) {
    let dir = crate::data_dir::get_data_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("无法创建数据目录 {}: {}", dir.display(), e);
        return;
    }
    let path = dir.join(INSTALL_HISTORY_FILE);
    let json = serde_json::to_string_pretty(folders).unwrap_or_default();
    if let Err(e) = fs::write(&path, &json) {
        log::warn!("无法保存安装历史缓存 {}. {}", path.display(), e);
    }
}

/// 根据统一数据目录构造路径（兼容程序内部其他模块使用）
#[allow(dead_code)]
fn get_data_sub_path(relative: &str) -> PathBuf {
    crate::data_dir::get_data_dir().join(relative)
}

// ============================================================================
// 预编译正则（包名格式 / 版本号格式）
// ============================================================================

/// 包名格式：com.example.app、org.apache.commons 等
static RE_PACKAGE_NAME: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$").unwrap());

/// 纯版本号格式：1.2.3.4、v2.0 等
static RE_VERSION_FOLDER: Lazy<Regex> = Lazy::new(|| Regex::new(r"^v?\d+(\.\d+){1,3}$").unwrap());

/// 更新器目录：名字里带 updater / update，或直接以 Updater 结尾。
///
/// 命中 `kimi-desktop-updater`、`comfyui-desktop-2-updater`、`QuarkCloudDriveUpdater`、
/// `@genie\workbuddy-desktop-updater` 这些形态。
///
/// 这类目录装的是"下载/解包好的新版本"，程序更新完就不再需要。删掉最坏的结果是
/// 下次更新重新下载一遍 —— 这是本模块里唯一能对用户明确说"后果是什么"的一类，
/// 所以值得单独标出来（`DetectionCategory::UpdaterCache`），而不是混进"高置信度"。
static RE_UPDATER_DIR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(^|[-_. ])(updater|update)([-_. ]|$)|updater$").unwrap()
});

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
    /// 实际检查过的一级目录数（含被白名单 / 体积阈值挡掉的）
    ///
    /// 结果为空时给用户一个「模块确实在跑」的证据：否则永远返回 0 条，
    /// 用户没法区分「真的没有残留」和「扫描坏了」。
    pub scanned_directories: usize,
    /// 进入评分、但因低于阈值被丢弃的条数
    pub below_threshold: usize,
    /// 所有参与评分的目录里的最高置信度（0.0~1.0）
    pub highest_confidence: f32,
    /// 当前使用的判定门槛（0.0~1.0），前端展示时和数据同源，避免两处各写一个 0.40
    pub confidence_threshold: f32,
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
    /// 直接躺在 AppData / ProgramData 根目录下的孤立可执行文件
    LooseFile,
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
    /// 高置信度残留（score >= 0.75）
    HighConfidenceLeftover,
    /// 可疑（0.30 <= score < 0.75）
    Suspicious,
    /// 可能是正在使用的应用数据
    LikelyAppData,
    /// 系统共享目录
    SystemShared,
    /// 更新器下载/解包的旧版本目录。
    ///
    /// 单独一类而不是并进"高置信度"：这两件事的可信度不是一回事。
    /// 高置信度是"大概率是残留，但我不敢打包票"；这一类是**后果明确**——
    /// 删掉之后更新器下次会重新下载，不会影响已经装好的程序。
    /// 用户看到这个标签时可以不用逐个猜。
    UpdaterCache,
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
        // ==================== 视频编辑软件（精确匹配） ====================
        WhitelistRule::Exact("jianyingpro".into()),
        WhitelistRule::Prefix("jianyingpro".into()),
        WhitelistRule::Exact("jianying".into()),
        WhitelistRule::Prefix("jianying".into()),
        WhitelistRule::Exact("capcut".into()),
        WhitelistRule::Prefix("capcut".into()),
        // ==================== 隐藏文件夹（通配符） ====================
        WhitelistRule::Pattern(".*".into()),
        // 视频/创意工具
        WhitelistRule::Exact("davinci resolve".into()),
        WhitelistRule::Exact("blackmagic design".into()),
        WhitelistRule::Exact("obs-studio".into()),
        WhitelistRule::Exact("obs studio".into()),
        WhitelistRule::Exact("figma".into()),
        WhitelistRule::Exact("comfyui".into()),
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

/// 根目录孤立文件的最小体积。
///
/// 低于这个数的可执行文件基本都是占位标记（安装器的 stub），
/// 删掉既省不了空间，也可能影响某个仍在用的工具自检。
const LOOSE_FILE_MIN_SIZE: u64 = 64 * 1024;

/// 高置信度门槛：到这个分数才算"很可能是残留"。
const HIGH_CONFIDENCE_SCORE: f32 = 0.75;

/// 最低输出门槛，同时也是"可疑"这一档的下限。
///
/// ⚠️ **这两个数必须相等**，改一个就要改另一个：
/// - 门槛 > 分档下限 → 分档到了（Suspicious）却被过滤掉，白算；
/// - 门槛 < 分档下限 → 进了结果，标签却写"可能是正在使用的应用数据"，自相矛盾。
///
/// 定在 0.30 而不是 0.40，是因为常见组合 `+0.20 有可执行文件` + `+0.10 很久没改`
/// 正好等于 0.30：卸载残留里带 exe 的目录（updater、便携软件）大多只能凑到这一档。
/// 0.40 会让这类条目全部消失，而它们恰恰是用户看得懂、也敢删的那批。
const SUSPICIOUS_SCORE: f32 = 0.30;

/// ProgramData 下低于这个分数的条目归为"系统共享"，而不是"可疑"。
///
/// 系统目录里一点风吹草动不足以当残留；这个分支在门槛 0.40 时是不可达的，
/// 门槛降到 0.30 之后 `[0.30, 0.40)` 这一段才会落到这里 —— 属于预期行为。
const SYSTEM_SHARED_SCORE_LIMIT: f32 = 0.40;

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
    /// 疑似残留候选：历史 InstallLocation 中出现过但当前注册表中找不到的文件夹名
    leftover_candidates: HashSet<String>,
    /// 已安装应用名的词元 → 应用索引。
    ///
    /// 为什么需要它：目录名和 DisplayName 很少逐字相同。
    /// 装了 Playwright 的用户，目录叫 `ms-playwright`；装了 VS Code 的，目录叫 `Code`。
    /// 精确匹配全部落空，结果就是"还在用的工具"和"真的卸载了"混在同一档里，
    /// 用户没有任何依据判断该删哪个（0.30 一档 20 多条全是同一个分数）。
    /// 拆成词元后 `ms-playwright` 能对上 `playwright`。
    token_to_app: HashMap<String, Vec<usize>>,
    /// 已卸载应用的词元 → 历史里出现过的原始名字。
    ///
    /// 反向证据：目录词元能对上"曾经装过、现在注册表里没有"的应用，
    /// 这才是"卸载残留"的定义，比"有 exe + 很久没改"两个弱信号可靠得多。
    uninstalled_tokens: HashMap<String, String>,
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

/// 目录名拆词后不参与匹配的词元。
///
/// 这些词出现在几乎所有软件的目录名里（`xxx-desktop`、`xxx-updater`），
/// 拿它们去比对"这是哪个软件的目录"只会制造噪音：
/// 只要装了任意一个 Electron 应用，所有带 `desktop` 的目录都会被当成它的数据。
const TOKEN_STOPWORDS: &[&str] = &[
    "app",
    "apps",
    "application",
    "applications",
    "desktop",
    "client",
    "service",
    "services",
    "updater",
    "update",
    "updates",
    "setup",
    "installer",
    "install",
    "uninstall",
    "helper",
    "launcher",
    "runtime",
    "editor",
    "viewer",
    "player",
    "manager",
    "studio",
    "suite",
    "tools",
    "tool",
    "utils",
    "utility",
    "common",
    "shared",
    "system",
    "program",
    "programs",
    "files",
    "folder",
    "cache",
    "data",
    "config",
    "settings",
    "user",
    "current",
    "version",
    "bin",
    "lib",
    "node",
    "electron",
    "chromium",
    "portable",
    "windows",
    "x64",
    "x86",
    "win32",
    "win64",
    "preview",
    "beta",
    "alpha",
    "nightly",
];

/// 把目录名拆成可用于比较的词元。
///
/// `ms-playwright` → [`playwright`]（`ms` 太短）
/// `kimi-desktop-updater` → [`kimi`]（后两个是停用词）
/// `ollama app` → [`ollama`]
///
/// 只保留长度 ≥ 4、不是停用词、不是纯数字的词元。
/// 阈值定在 4 是因为 `ms`、`ai`、`vr` 这类两三个字母的词元几乎必然误撞。
fn name_tokens(name_lower: &str) -> impl Iterator<Item = &str> {
    name_lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.len() >= 4)
        .filter(|token| !TOKEN_STOPWORDS.contains(token))
        .filter(|token| !token.chars().all(|c| c.is_ascii_digit()))
}

/// 从已安装应用列表构建「词元 → 应用索引」索引。
///
/// 单独抽出来是为了让测试能自己指定"装了哪些应用"，不必依赖这台机器的注册表。
fn build_token_index(apps: &[InstalledAppInfo]) -> HashMap<String, Vec<usize>> {
    let mut token_to_app: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, app) in apps.iter().enumerate() {
        let normalized = normalize_display_name(&app.display_name);
        for token in name_tokens(&normalized) {
            token_to_app.entry(token.to_string()).or_default().push(idx);
        }
    }
    token_to_app
}

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

        // 加载历史安装文件夹并计算疑似残留候选
        // leftover_candidates = 曾经在 InstallLocation 中出现过但当前注册表中已找不到的文件夹
        let mut historical = load_install_history();
        let leftover_candidates: HashSet<String> =
            historical.difference(&known_folders).cloned().collect();

        // 当前装着的应用：DisplayName 拆词 → 应用索引
        let token_to_app = build_token_index(&apps);

        // 已卸载的应用：历史名的词元 → 原始历史名。
        // 名字里带泛指词（豆包的 InstallLocation 曾被记成 `application`）时，
        // 拆出来的词元全是停用词，自然进不了这张表 —— 不会因为一条垃圾历史误判一片目录。
        let mut uninstalled_tokens: HashMap<String, String> = HashMap::new();
        for candidate in &leftover_candidates {
            for token in name_tokens(candidate) {
                uninstalled_tokens
                    .entry(token.to_string())
                    .or_insert_with(|| candidate.clone());
            }
        }

        // 将当前已知文件夹合并到历史记录中并持久化
        historical.extend(known_folders.iter().cloned());
        save_install_history(&historical);

        log::info!(
            "已安装应用映射构建完成: {} 个应用, {} 个已知文件夹名, {} 个 DisplayName, {} 个历史残留候选, {} 个已卸载词元",
            apps.len(),
            known_folders.len(),
            display_names.len(),
            leftover_candidates.len(),
            uninstalled_tokens.len()
        );

        InstalledAppMap {
            apps,
            folder_to_app,
            known_folders,
            display_names,
            leftover_candidates,
            token_to_app,
            uninstalled_tokens,
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

    /// 目录名是否属于某个**仍安装着**的应用（词元匹配 + 子串兜底）。
    ///
    /// 与 `matches_display_name` 的区别是"宽松"：那边要求整个名字逐字相同，
    /// 这边只要有一个词元对上就算。目录 `ms-playwright` 对 `Playwright` 这种
    /// 命名差异只能靠词元识别 —— 否则"还在用的工具"会被当成残留推荐给用户删。
    fn installed_app_for_name(&self, folder_name_lower: &str) -> Option<&str> {
        if let Some(owner) = name_tokens(folder_name_lower).find_map(|token| {
            self.token_to_app
                .get(token)
                .and_then(|indices| indices.first())
                .map(|&idx| self.apps[idx].display_name.as_str())
        }) {
            return Some(owner);
        }

        // 子串兜底：真实目录名经常把两个词拼在一起，拆不出来
        // （`@genieworkbuddy-desktop-updater` → `genieworkbuddy`），
        // 或者应用名只是目录名的一部分（`Comfy` vs `comfyui-desktop-2-updater`）。
        // 长度门槛 5：`uv`、`code` 这种短名字的子串几乎必然撞上别的东西。
        self.token_to_app
            .iter()
            .filter(|(token, _)| token.len() >= 5 && folder_name_lower.contains(token.as_str()))
            .max_by_key(|(token, _)| token.len())
            .and_then(|(_, indices)| indices.first())
            .map(|&idx| self.apps[idx].display_name.as_str())
    }

    /// 目录名是否对应一个**已经卸载**的应用（词元匹配 + 子串兜底，返回历史里出现过的名字）。
    ///
    /// 这是"卸载残留"最直接的证据：这个应用曾经装过，现在注册表里已经没有它了。
    fn uninstalled_app_for_name(&self, folder_name_lower: &str) -> Option<&str> {
        if let Some(name) = name_tokens(folder_name_lower).find_map(|token| {
            self.uninstalled_tokens
                .get(token)
                .map(|name| name.as_str())
        }) {
            return Some(name);
        }

        self.uninstalled_tokens
            .iter()
            .filter(|(token, _)| token.len() >= 5 && folder_name_lower.contains(token.as_str()))
            .max_by_key(|(token, _)| token.len())
            .map(|(_, name)| name.as_str())
    }

    /// 结构化路径所有权推断：检查文件夹名是否映射到某个已安装应用的 InstallLocation
    fn has_inferred_ownership(&self, folder_name_lower: &str) -> bool {
        self.has_exact_owner(folder_name_lower)
    }

    /// 检查文件夹名是否为历史残留候选（曾经在 InstallLocation 中但当前注册表找不到）
    fn is_leftover_candidate(&self, folder_name_lower: &str) -> bool {
        self.leftover_candidates.contains(folder_name_lower)
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
        if self.score >= HIGH_CONFIDENCE_SCORE {
            DetectionCategory::HighConfidenceLeftover
        } else if self.score >= SUSPICIOUS_SCORE {
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
            // 只输出 score >= SUSPICIOUS_SCORE（0.30）的条目：常见组合
            // 「有可执行文件 +0.20」+「很久没改 +0.10」正好卡在这一档线
            min_confidence_threshold: SUSPICIOUS_SCORE,
        }
    }

    /// 兼容旧接口，参数已忽略，始终启用完整扫描
    pub fn with_deep_scan(_deep_scan: bool) -> Self {
        Self::new()
    }

    /// 执行卸载残留扫描
    pub fn scan(&self) -> LeftoverScanResult {
        // 白名单在一次扫描开始时只读取一次，避免目录枚举时产生重复磁盘 IO。
        let user_whitelist = leftover_whitelist::list_entries().unwrap_or_else(|error| {
            log::warn!(
                "读取卸载残留用户白名单失败，将按空白名单继续扫描: {}",
                error
            );
            Vec::new()
        });
        self.scan_with_paths(self.get_scan_paths(), &user_whitelist)
    }

    /// 使用给定根目录扫描，测试可通过临时目录验证规则而不触及真实用户数据。
    fn scan_with_paths(
        &self,
        scan_paths: Vec<(PathBuf, LeftoverSource)>,
        user_whitelist: &[leftover_whitelist::LeftoverWhitelistEntry],
    ) -> LeftoverScanResult {
        let start_time = std::time::Instant::now();
        let mut leftovers = Vec::new();
        let mut total_size = 0u64;
        // 空结果时用的诊断计数：让用户知道扫过多少目录、最高分差多少
        let mut scanned_directories = 0usize;
        let mut below_threshold = 0usize;
        let mut highest_confidence = 0f32;

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

                    scanned_directories += 1;

                    // 获取文件夹名称
                    let folder_name = match path.file_name() {
                        Some(name) => name.to_string_lossy().to_string(),
                        None => continue,
                    };

                    // 白名单检查（硬性排除）
                    // 用户白名单优先于评分逻辑，确保误报路径不会继续出现在结果中。
                    if leftover_whitelist::contains_path(user_whitelist, &path)
                        || self.is_whitelisted(&folder_name)
                    {
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

                    // 空壳目录：一个文件都没有。
                    // 真实的卸载残留经常正是这个形态 —— 卸载程序清掉了内容、只剩目录，
                    // 但它永远过不了 1MB 的体积门槛，所以先认出来，交给历史证据定分。
                    let is_empty_shell = probe.file_count == 0;

                    // 大小阈值过滤（空壳不参与：它是不是残留由历史证据决定，不由体积决定）
                    let threshold = if emulator_match.is_some() {
                        100 * 1024 // 模拟器残留降低阈值到 100KB
                    } else {
                        self.min_size_threshold
                    };
                    if !is_empty_shell && probe.total_size < threshold {
                        continue;
                    }

                    // 获取最后修改时间
                    let last_modified = Self::get_last_modified(&path);

                    // 更新器目录：名字就能说明它是什么，与装没装、改没改无关
                    let is_updater_dir = RE_UPDATER_DIR.is_match(&folder_lower);

                    // ============ 评分（基线 0.0） ============
                    let mut ctx = ScoringContext::new();

                    if let Some(emu_name) = &emulator_match {
                        // 【5】模拟器命中 → 直接 0.90，跳过其他信号
                        ctx.score = 0.90;
                        ctx.reasons.push(format!("匹配已知模拟器: {}", emu_name));
                    } else {
                        // ---- 正向信号 ----

                        // +0.35 文件夹内发现 uninstall*.exe / uninst*.exe
                        if probe.has_uninstaller {
                            ctx.add(0.35, "包含卸载程序残留 (uninstall*.exe)".into());
                        }

                        // +0.45 更新器目录。
                        // 这一条是给"后果"打的分，不是给"可能性"打分：程序更新完，
                        // 这些解包出来的旧版本就没用了，删掉只是让更新器下次重新下载。
                        if is_updater_dir {
                            ctx.add(
                                0.45,
                                "更新器下载目录（删除后下次更新会重新下载，不影响已安装的程序）"
                                    .into(),
                            );
                        }

                        // +0.25 文件夹名匹配历史 InstallLocation 且应用已不在注册表
                        // （历史缓存中记录了过去所有 InstallLocation 文件夹，
                        //   若某文件夹曾在历史中出现但当前注册表中找不到，说明已卸载）
                        if self.app_map.is_leftover_candidate(&folder_lower) {
                            ctx.add(
                                0.25,
                                format!("匹配已知安装路径但应用已卸载: {}", folder_name),
                            );
                        } else if let Some(uninstalled) = self
                            .app_map
                            .uninstalled_app_for_name(&folder_lower)
                        {
                            // 词元级的历史命中：目录名和安装记录不会逐字相同
                            // （`Comfy Desktop` vs `comfyui-desktop-2-updater`），
                            // 逐字匹配基本失效，这条才是历史证据真正生效的路径。
                            ctx.add(
                                0.20,
                                format!("目录名与该应用的历史安装记录吻合（已卸载）: {}", uninstalled),
                            );
                        }

                        // +0.10 空壳目录：配合上面的历史命中，才构成"卸载后留下的空目录"
                        if is_empty_shell {
                            ctx.add(0.10, "目录已空（只剩目录本身）".into());
                        }

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

                        // -0.45 文件夹名精确匹配当前已安装应用 DisplayName。
                        // DisplayName 来源于当前注册表，代表软件仍有安装记录；把它作为保护信号能降低误伤正在使用软件数据的概率。
                        if self.app_map.matches_display_name(&folder_lower) {
                            ctx.add(
                                -0.45,
                                format!("匹配当前已安装应用 DisplayName: {}", folder_name),
                            );
                        } else if let Some(owner) = self.app_map.installed_app_for_name(&folder_lower)
                        {
                            // -0.35 词元匹配到仍安装着的应用。
                            // 精确匹配漏掉的正是最常见的形态：`ms-playwright` / `Code` /
                            // `comfyui-desktop-2-updater` —— 它们和 DisplayName 从来不一致，
                            // 不扣分就会以 0.30 的身份出现在结果里，被用户当成"可以删"。
                            ctx.add(
                                -0.35,
                                format!("目录名与仍在安装的应用吻合: {}", owner),
                            );
                        }

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

                        // -0.20 7 天内有修改记录。
                        //
                        // 空壳目录不参与：它的修改时间几乎必然等于"内容被删掉的那一刻"，
                        // 拿它当"最近还在用"的证据是反的 —— 那恰恰是卸载刚发生。
                        if days_old < 7 && !is_empty_shell {
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

                    // 记录诊断：最高分是多少、有多少条卡在门槛下
                    highest_confidence = highest_confidence.max(ctx.score);

                    // 过滤低分条目（score < SUSPICIOUS_SCORE 不输出）
                    if ctx.score < self.min_confidence_threshold {
                        below_threshold += 1;
                        continue;
                    }

                    let detection_category = if emulator_match.is_some() {
                        DetectionCategory::HighConfidenceLeftover
                    } else if is_updater_dir {
                        // 比"高置信度"更具体：这一类连删掉的后果都能说清
                        DetectionCategory::UpdaterCache
                    } else if *source == LeftoverSource::ProgramData
                        && ctx.score < SYSTEM_SHARED_SCORE_LIMIT
                    {
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
            let virtual_disks = self.scan_virtual_disk_files(user_whitelist);
            for entry in virtual_disks {
                total_size += entry.size;
                leftovers.push(entry);
            }
        }

        // 根目录下的孤立可执行文件（`Roaming\ollama app.exe` 这类）
        for entry in self.scan_loose_files(&scan_paths, user_whitelist) {
            total_size += entry.size;
            leftovers.push(entry);
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
            scanned_directories,
            below_threshold,
            highest_confidence,
            confidence_threshold: self.min_confidence_threshold,
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

    /// 检查文件路径中是否有任何一级祖先目录在白名单内
    ///
    /// 从文件的父目录开始，逐级向上（到 base_dir 为止），
    /// 如果某级目录名命中白名单则返回 true。
    /// 用于 scan_virtual_disk_files 中防止 WSL2（\wsl\<GUID>\ext4.vhdx）等
    /// 深层嵌套虚拟磁盘被误判——直接父目录是 GUID，但上级 "wsl" 在名单中。
    fn is_path_in_whitelist(&self, file_path: &Path, base_dir: &Path) -> bool {
        // 从文件的父目录开始，逐级向上检查
        let mut current = match file_path.parent() {
            Some(p) => p.to_path_buf(),
            None => return false,
        };

        while current.starts_with(base_dir) && current != base_dir {
            if let Some(name) = current.file_name() {
                let name_lower = name.to_string_lossy().to_lowercase();
                if self.is_whitelisted(&name_lower) {
                    return true;
                }
            }
            // 继续向上一级
            current = match current.parent() {
                Some(p) => p.to_path_buf(),
                None => break,
            };
        }
        false
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
    /// 扫描 AppData / ProgramData 根目录下的**孤立文件**。
    ///
    /// 卸载残留不只有目录。安装器把启动器直接丢在 `AppData\Roaming` 根下是常见做法，
    /// 卸载时又只删自己登记过的那几项 —— `Roaming\ollama app.exe` 就是这种：
    /// 一个可执行文件独自躺在根目录里，而主流程只遍历目录（`if !path.is_dir() continue`），
    /// 完全看不见它。
    ///
    /// 只收可执行文件：根目录下其余文件是配置或缓存标志（`obs-virtualcam.txt`、
    /// `viap.json`、`IconCache.db`），删了要么无害、要么是系统在管，报出来只是噪音。
    ///
    /// 基础分给 0.25 而不是 0.30：根目录下出现 exe 本身可疑，但一条弱信号不该单独定罪。
    /// 要过 0.30 的门槛，必须再有一条 —— 「很久没改」（+0.10）或「对得上已卸载的应用」（+0.25）。
    fn scan_loose_files(
        &self,
        scan_paths: &[(PathBuf, LeftoverSource)],
        user_whitelist: &[leftover_whitelist::LeftoverWhitelistEntry],
    ) -> Vec<LeftoverEntry> {
        let mut results = Vec::new();

        for (base_path, source) in scan_paths {
            let Ok(entries) = fs::read_dir(base_path) else {
                continue;
            };

            for entry in entries.filter_map(|e| e.ok()) {
                // 只要文件：目录由主流程按残留规则处理
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_file() {
                    continue;
                }

                let path = entry.path();
                let Some(extension) = path.extension() else {
                    continue;
                };
                if !EXECUTABLE_EXTENSIONS.contains(&extension.to_string_lossy().to_lowercase().as_str())
                {
                    continue;
                }

                if leftover_whitelist::contains_path(user_whitelist, &path) {
                    continue;
                }

                let Some(file_name) = path.file_name().map(|n| n.to_string_lossy().to_string())
                else {
                    continue;
                };
                if self.is_whitelisted(&file_name) {
                    continue;
                }

                let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
                // 几百字节的 exe 通常只是占位标记，删不删都没有意义
                if size < LOOSE_FILE_MIN_SIZE {
                    continue;
                }

                let name_lower = file_name.to_lowercase();
                let days_old = Self::get_days_since_modified(&path);

                let mut ctx = ScoringContext::new();
                ctx.add(
                    0.25,
                    "直接位于 AppData / ProgramData 根目录下的可执行文件".into(),
                );

                if let Some(owner) = self.app_map.installed_app_for_name(&name_lower) {
                    // 同名应用还装着：这大概是它自己放的启动器，不能动
                    ctx.add(
                        -0.45,
                        format!("文件名与仍在安装的应用吻合: {}", owner),
                    );
                } else if let Some(uninstalled) = self.app_map.uninstalled_app_for_name(&name_lower)
                {
                    ctx.add(
                        0.25,
                        format!(
                            "文件名与该应用的历史安装记录吻合（已卸载）: {}",
                            uninstalled
                        ),
                    );
                }

                if days_old > self.min_days_old {
                    ctx.add(0.10, format!("已 {} 天未修改", days_old));
                }

                // ProgramData 是系统共享目录，同样的证据不足以说明问题
                if *source == LeftoverSource::ProgramData {
                    ctx.add(-0.20, "位于 ProgramData（系统共享目录）".into());
                }

                ctx.finalize();
                if ctx.score < self.min_confidence_threshold {
                    continue;
                }

                log::info!(
                    "发现根目录下的孤立文件: {} ({} KB)",
                    path.display(),
                    size / 1024
                );

                results.push(LeftoverEntry {
                    path: path.to_string_lossy().to_string(),
                    size,
                    app_name: file_name,
                    source: source.clone(),
                    last_modified: Self::get_last_modified(&path),
                    file_count: 1,
                    is_emulator: false,
                    is_virtual_disk: false,
                    leftover_type: LeftoverType::LooseFile,
                    confidence: ctx.score,
                    detection_category: ctx.category(),
                    reasons: ctx.reasons,
                });
            }
        }

        results
    }

    fn scan_virtual_disk_files(
        &self,
        user_whitelist: &[leftover_whitelist::LeftoverWhitelistEntry],
    ) -> Vec<LeftoverEntry> {
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

                    // 用户白名单可以保护虚拟磁盘文件本身或其上级目录。
                    if leftover_whitelist::contains_path(user_whitelist, path) {
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

                    // 检查路径中是否有上级目录在白名单内
                    // WSL2 等场景：文件在 \wsl\<GUID>\ext4.vhdx，直接父目录是 GUID，
                    // 但上级目录 "wsl" 在白名单中，应跳过
                    if self.is_path_in_whitelist(path, base_dir) {
                        log::info!("虚拟磁盘文件路径命中白名单，跳过: {}", path.display());
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
    /// 删除失败的路径（含因包含可执行文件而被跳过的，前端按下标与 `errors` 对应）
    pub failed_paths: Vec<String>,
    /// 错误信息列表
    pub errors: Vec<String>,
    /// 因包含可执行文件而被跳过的路径
    pub skipped_executables: Vec<String>,
}

/// 浅层可执行文件扫描，发现则返回警告信息
///
/// 【中文说明】
/// 快速扫描目标文件夹的浅层（depth=3），如果发现 .exe/.dll/.sys 文件，
/// 说明该目录可能包含正在使用的便携软件或系统组件。
/// 返回 Some(消息) 表示发现可执行文件，应跳过删除。
fn has_executables_shallow(path: &Path) -> Option<String> {
    const EXE_EXTENSIONS: &[&str] = &["exe", "dll", "sys"];
    let max_depth = 3;
    let max_found = 5;
    let mut found = 0u32;
    let mut example = String::new();

    for entry in WalkDir::new(path)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(ext) = entry.path().extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if EXE_EXTENSIONS.contains(&ext_lower.as_str()) {
                found += 1;
                if example.is_empty() {
                    example = entry.file_name().to_string_lossy().to_string();
                }
                if found >= max_found {
                    break;
                }
            }
        }
    }

    if found > 0 {
        if found == 1 {
            Some(format!(
                "文件夹包含可执行文件 (如 {})，已跳过，请使用深度清理手动确认",
                example
            ))
        } else {
            Some(format!(
                "文件夹包含 {} 个可执行文件 (如 {})，已跳过，请使用深度清理手动确认",
                found, example
            ))
        }
    } else {
        None
    }
}

/// 删除卸载残留文件夹（含安全预检查）
///
/// 【中文说明】
/// 每个路径依次执行：路径范围检查 → 分类（目录 / 文件）→ 可执行文件扫描 → 删除。
/// 包含可执行文件的**目录**不会被删除，而是标记为 skipped_executables，
/// 引导用户通过深度清理（含人工审核机制）处理。
pub fn delete_folders(paths: Vec<String>) -> LeftoverDeleteResult {
    let whitelist_entries = match leftover_whitelist::list_entries() {
        Ok(entries) => entries,
        Err(error) => {
            // 白名单无法读取时拒绝删除，宁可要求用户修复配置，也不能让保护规则失效。
            return LeftoverDeleteResult {
                deleted_count: 0,
                deleted_size: 0,
                failed_paths: paths.clone(),
                errors: paths
                    .iter()
                    .map(|path| format!("无法读取用户白名单，已拒绝删除 {}: {}", path, error))
                    .collect(),
                skipped_executables: Vec::new(),
            };
        }
    };
    delete_folders_with_whitelist(paths, &whitelist_entries)
}

/// 允许删除的根目录，必须与 `get_scan_paths()` 的扫描范围同一口径。
///
/// 两处一旦不一致，就会出现「扫得到、删不掉」（判定落在扫描范围外）。
fn deletion_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        roots.push(local.clone());
        // LocalLow 与 Local 同级，模拟器残留常落在这里
        if let Some(parent) = local.parent() {
            let local_low = parent.join("LocalLow");
            if local_low.exists() {
                roots.push(local_low);
            }
        }
    }
    if let Some(roaming) = dirs::data_dir() {
        roots.push(roaming);
    }
    let program_data = PathBuf::from(r"C:\ProgramData");
    if program_data.exists() {
        roots.push(program_data);
    }
    roots
}

/// 供正常删除和测试复用，保证过期扫描结果也不能绕过用户保护规则。
fn delete_folders_with_whitelist(
    paths: Vec<String>,
    whitelist_entries: &[leftover_whitelist::LeftoverWhitelistEntry],
) -> LeftoverDeleteResult {
    delete_folders_in(paths, whitelist_entries, &deletion_roots())
}

fn delete_folders_in(
    paths: Vec<String>,
    whitelist_entries: &[leftover_whitelist::LeftoverWhitelistEntry],
    roots: &[PathBuf],
) -> LeftoverDeleteResult {
    let mut deleted_count = 0u32;
    let mut deleted_size = 0u64;
    let mut failed_paths = Vec::new();
    let mut errors = Vec::new();
    let mut skipped_executables = Vec::new();

    for path in paths {
        let path_buf = PathBuf::from(&path);

        // 删除前重新检查，避免白名单更新后仍被旧扫描结果删除。
        if leftover_whitelist::contains_path(whitelist_entries, &path_buf) {
            failed_paths.push(path.clone());
            errors.push(format!("路径受用户白名单保护: {}", path));
            continue;
        }

        // 安全检查 1: 路径在允许范围内
        if !is_safe_leftover_path_under(&path_buf, roots) {
            failed_paths.push(path.clone());
            errors.push(format!("路径不在允许的目录内: {}", path));
            continue;
        }

        // 安全检查 2: 判类型。孤立虚拟磁盘（`ext4.vhdx` 这类）是**文件**，
        // 走到 `remove_dir_all` 上必然报「目录名无效」，用户看到的就是
        // 「几十 GB 的残留删不掉」，所以这里先分流。
        // junction / 目录软链接不算 is_file，仍走目录分支 —— `remove_dir_all`
        // 只会删掉链接本身，不会跟进去。
        let metadata = match fs::symlink_metadata(&path_buf) {
            Ok(metadata) => metadata,
            Err(error) => {
                failed_paths.push(path.clone());
                errors.push(format!("无法读取 {}: {}", path, error));
                continue;
            }
        };

        if metadata.is_file() {
            let file_size = metadata.len();
            match fs::remove_file(&path_buf) {
                Ok(()) => {
                    deleted_count += 1;
                    deleted_size += file_size;
                }
                Err(error) => {
                    failed_paths.push(path.clone());
                    errors.push(format!("删除失败 {}: {}", path, error));
                }
            }
            continue;
        }

        // 安全检查 3: 浅层可执行文件扫描（只对目录有意义）
        if let Some(msg) = has_executables_shallow(&path_buf) {
            skipped_executables.push(path.clone());
            // 跳过也算"没删掉"，一并进 failed_paths：
            // 前端是按 failed_paths 的下标去 errors 里取错误信息的，
            // 这里少推一条，后面所有条目的错误信息都会串位。
            failed_paths.push(path.clone());
            errors.push(format!("{}: {}", path, msg));
            continue;
        }

        // 删除前计算文件夹大小
        let folder_size = calculate_dir_size(&path_buf);

        match fs::remove_dir_all(&path_buf) {
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
        skipped_executables,
    }
}

/// 递归计算目录大小
fn calculate_dir_size(path: &std::path::Path) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            // `file_type()` 不跟随软链接 / junction：用 `is_dir()` 会跟进去，
            // 一是把别的盘的容量算进来，二是遇到指回上层的环会无限递归。
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                size += calculate_dir_size(&entry.path());
            } else if file_type.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    size += metadata.len();
                }
            }
        }
    }
    size
}

/// 检查路径是否在允许删除的范围内（可注入根目录，便于测试）。
///
/// 【安全说明】
/// 三条约束缺一不可：
/// 1. **拒绝 `.` / `..` 组件** —— `remove_dir_all` 按解析后的真实路径动手，
///    而前缀匹配是对字面量做的。`...\Local\..\..\..\Windows` 会以
///    「在 AppData\Local 之下」的身份通过校验，实际删的却是别的目录。
/// 2. **按组件比较，不按字符串前缀** —— 字符串 `starts_with` 会放过
///    `AppData\LocalBackup`（它的前 19 个字符和 `AppData\Local` 一样）。
/// 3. **目录只能是根的直接子目录** —— 扫描只产出一级目录，更深层的目录
///    不该由这个模块整目录删除；文件（孤立虚拟磁盘）允许更深，
///    它的真实位置就在 `Packages\<包名>\LocalState\` 里面。
fn is_safe_leftover_path_under(path: &Path, roots: &[PathBuf]) -> bool {
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return false;
    }

    let path_depth = path.components().count();
    let is_file = fs::symlink_metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);

    roots.iter().any(|root| {
        // 严格在根目录之下：根目录本身不能被当成残留删掉
        if path_depth <= root.components().count() {
            return false;
        }
        if !starts_with_ignore_case(path, root) {
            return false;
        }
        if is_file {
            return true;
        }
        path.parent()
            .map(|parent| components_eq_ignore_case(parent, root))
            .unwrap_or(false)
    })
}

/// 按组件比较，忽略大小写（Windows 路径大小写不敏感）。
fn starts_with_ignore_case(path: &Path, root: &Path) -> bool {
    let mut path_components = path.components();
    for root_component in root.components() {
        let Some(path_component) = path_components.next() else {
            return false;
        };
        if !path_component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&root_component.as_os_str().to_string_lossy())
        {
            return false;
        }
    }
    true
}

/// 两个路径是否完全等价（按组件、忽略大小写）。
fn components_eq_ignore_case(left: &Path, right: &Path) -> bool {
    let mut left_components = left.components();
    let mut right_components = right.components();
    loop {
        match (left_components.next(), right_components.next()) {
            (None, None) => return true,
            (Some(left_component), Some(right_component)) => {
                if !left_component
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&right_component.as_os_str().to_string_lossy())
                {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn test_whitelist_entry(path: &Path) -> leftover_whitelist::LeftoverWhitelistEntry {
        leftover_whitelist::LeftoverWhitelistEntry {
            path: path.to_string_lossy().to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn user_whitelist_excludes_synthetic_leftover_and_blocks_normal_deletion() {
        let root = std::env::temp_dir().join(format!(
            "lightc-leftover-scan-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("读取测试时间失败")
                .as_nanos()
        ));
        let candidate = root.join("leidian_whitelist_fixture");
        fs::create_dir_all(&candidate).expect("创建模拟残留目录失败");
        // 模拟器特征和超过阈值的内容确保夹具能经过真实扫描器的筛选，而非只测试字符串过滤。
        fs::write(candidate.join("uninstall.exe"), vec![0u8; 1024 * 1024])
            .expect("创建模拟卸载程序失败");

        let mut scanner = LeftoverScanner::new();
        scanner.deep_scan = false;
        let scan_paths = vec![(root.clone(), LeftoverSource::LocalAppData)];
        let unprotected_result = scanner.scan_with_paths(scan_paths.clone(), &[]);
        assert!(unprotected_result
            .leftovers
            .iter()
            .any(|entry| entry.path == candidate.to_string_lossy()));

        let whitelist = vec![test_whitelist_entry(&candidate)];
        let protected_result = scanner.scan_with_paths(scan_paths, &whitelist);
        assert!(protected_result.leftovers.is_empty());

        let deletion = delete_folders_with_whitelist(
            vec![candidate.to_string_lossy().to_string()],
            &whitelist,
        );
        assert_eq!(deletion.deleted_count, 0);
        assert_eq!(deletion.failed_paths.len(), 1);
        assert!(candidate.exists());

        let _ = fs::remove_dir_all(root);
    }

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

        ctx.add(0.40, "测试正向信号".into());
        ctx.add(0.35, "卸载程序残留".into());
        ctx.finalize();
        assert!((ctx.score - 0.75).abs() < 0.01);
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
        // score >= 0.75 → HighConfidenceLeftover
        let mut ctx = ScoringContext::new();
        ctx.score = 0.75;
        assert_eq!(ctx.category(), DetectionCategory::HighConfidenceLeftover);

        // 0.30 <= score < 0.75 → Suspicious
        ctx.score = 0.50;
        assert_eq!(ctx.category(), DetectionCategory::Suspicious);

        // 门槛本身就是 Suspicious 的下限：0.30 必须落进"可疑"，
        // 否则门槛调了、分档没调，条目会以"可能是正在使用的应用数据"的身份出现在结果里
        ctx.score = SUSPICIOUS_SCORE;
        assert_eq!(ctx.category(), DetectionCategory::Suspicious);

        // 低于门槛 → LikelyAppData（正常情况下已被过滤，纯防御）
        ctx.score = SUSPICIOUS_SCORE - 0.01;
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
        // 验证阈值 >= 0.75 分类为 HighConfidenceLeftover
        let mut ctx = ScoringContext::new();
        ctx.score = 0.75;
        assert_eq!(
            ctx.category(),
            DetectionCategory::HighConfidenceLeftover,
            "score = 0.75 应为 HighConfidenceLeftover"
        );

        ctx.score = 0.74;
        assert_eq!(
            ctx.category(),
            DetectionCategory::Suspicious,
            "score = 0.74 应为 Suspicious"
        );

        ctx.score = SUSPICIOUS_SCORE;
        assert_eq!(
            ctx.category(),
            DetectionCategory::Suspicious,
            "score = 0.30 应为 Suspicious（门槛与分档下限是同一个数）"
        );

        ctx.score = SUSPICIOUS_SCORE - 0.01;
        assert_eq!(
            ctx.category(),
            DetectionCategory::LikelyAppData,
            "score = 0.29 应为 LikelyAppData"
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

    // ========================================================================
    // v2.4.3 修复：白名单覆盖 WSL2 虚拟磁盘 & 剪映工作区
    // ========================================================================

    #[test]
    fn test_whitelist_wsl_and_jianying() {
        let rules = build_whitelist_rules();

        // === WSL2 场景 ===
        // Microsoft Store 版 WSL（Ubuntu 等发行版）
        let store_path = Path::new(
            r"C:\Users\test_user\AppData\Local\Packages\CanonicalGroupLimited.Ubuntu_79rhkp1fndgsc\LocalState\ext4.vhdx",
        );
        // 非 Store 版 WSL
        let legacy_wsl_path = Path::new(
            r"C:\Users\test_user\AppData\Local\wsl\a1b2c3d4-e5f6-7890-abcd-ef1234567890\ext4.vhdx",
        );

        // === 剪映场景 ===
        let jianying_pro_path =
            Path::new(r"C:\Users\test_user\AppData\Local\JianyingPro\User Data\Projects");
        let jianying_drafts_path =
            Path::new(r"C:\Users\test_user\AppData\Local\JianyingPro Drafts\xxx");
        let capcut_path = Path::new(r"C:\Users\test_user\AppData\Roaming\CapCut\User Data");

        // === 真实残留场景 ===
        let real_leftover_path =
            Path::new(r"C:\Users\test_user\AppData\Local\SomeRandomUninstalledApp\cache");

        // 验证：白名单包含关键目录名
        assert!(rules.iter().any(|r| r.matches("wsl")), "wsl 应在白名单中");
        assert!(
            rules.iter().any(|r| r.matches("packages")),
            "packages 应在白名单中"
        );
        assert!(
            rules.iter().any(|r| r.matches("jianyingpro")),
            "jianyingpro 应在白名单中"
        );
        assert!(
            rules.iter().any(|r| r.matches("jianyingpro drafts")),
            "jianyingpro drafts 应在白名单中（Prefix 匹配）"
        );
        assert!(
            rules.iter().any(|r| r.matches("jianying")),
            "jianying 应在白名单中"
        );
        assert!(
            rules.iter().any(|r| r.matches("capcut")),
            "capcut 应在白名单中"
        );

        // 验证：is_path_in_whitelist 正确识别受保护路径
        let scanner = LeftoverScanner::new();
        // mock 路径基目录必须与测试路径前缀一致才能 strip_prefix 成功
        let mock_local = PathBuf::from(r"C:\Users\test_user\AppData\Local");
        let mock_roaming = PathBuf::from(r"C:\Users\test_user\AppData\Roaming");

        // Store 版 WSL: Packages 在白名单 → 应跳过
        assert!(
            scanner.is_path_in_whitelist(store_path, &mock_local),
            "Microsoft Store WSL 路径应命中白名单 (Packages)"
        );
        // 非 Store 版 WSL: wsl 在白名单 → 应跳过
        assert!(
            scanner.is_path_in_whitelist(legacy_wsl_path, &mock_local),
            "传统 WSL 路径应命中白名单 (wsl)"
        );
        // 剪映专业版
        assert!(
            scanner.is_path_in_whitelist(jianying_pro_path, &mock_local),
            "剪映专业版路径应命中白名单 (JianyingPro)"
        );
        // 剪映草稿目录
        assert!(
            scanner.is_path_in_whitelist(jianying_drafts_path, &mock_local),
            "剪映草稿目录应命中白名单 (JianyingPro Drafts)"
        );
        // CapCut 国际版
        assert!(
            scanner.is_path_in_whitelist(capcut_path, &mock_roaming),
            "CapCut 路径应命中白名单 (CapCut)"
        );
        // 真实残留：SomeRandomUninstalledApp 不在白名单 → 不应跳过
        assert!(
            !scanner.is_path_in_whitelist(real_leftover_path, &mock_local),
            "真实残留路径不应命中白名单"
        );
    }

    /// 测试用临时目录（带进程号与时间戳，避免并发用例互相踩）。
    fn case_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lightc-leftover-{}-{}-{}",
            tag,
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("读取测试时间失败")
                .as_nanos()
        ))
    }

    /// 路径校验的三条底线：拒绝 `..`、按组件比较、目录只放行一级。
    ///
    /// 旧实现用字符串 `starts_with`，`AppData\LocalBackup` 和
    /// `AppData\Local\..\..\..\Windows` 都能通过 —— 而 `remove_dir_all`
    /// 是按解析后的真实路径动手的。
    #[test]
    fn safe_path_check_rejects_traversal_and_prefix_lookalikes() {
        let base = case_dir("safe-path");
        let root = base.join("Local");
        let app_dir = root.join("SomeApp");
        let nested_dir = app_dir.join("Config");
        let virtual_disk = app_dir
            .join("Packages")
            .join("SomePackage")
            .join("LocalState")
            .join("ext4.vhdx");
        fs::create_dir_all(&nested_dir).expect("创建测试目录失败");
        fs::create_dir_all(virtual_disk.parent().expect("虚拟磁盘应有父目录"))
            .expect("创建虚拟磁盘目录失败");
        fs::write(&virtual_disk, vec![0u8; 64]).expect("写入虚拟磁盘夹具失败");

        let roots = vec![root.clone()];

        // 一级子目录：允许（扫描只会产出这一层）
        assert!(is_safe_leftover_path_under(&app_dir, &roots));
        // 根目录本身：不允许
        assert!(!is_safe_leftover_path_under(&root, &roots));
        // 兄弟前缀：字符串前缀匹配会放过，组件比较必须挡住
        assert!(!is_safe_leftover_path_under(
            &base.join("LocalBackup").join("x"),
            &roots
        ));
        // `..` 穿越：字面量看上去在根目录下，实际删的是别的目录
        assert!(!is_safe_leftover_path_under(
            &app_dir.join("..").join("..").join("Windows"),
            &roots
        ));
        // 二级子目录：整目录删除不在本模块职责内
        assert!(!is_safe_leftover_path_under(&nested_dir, &roots));
        // 深层文件（孤立虚拟磁盘）：允许，真实位置就在 Packages 里面
        assert!(is_safe_leftover_path_under(&virtual_disk, &roots));

        let _ = fs::remove_dir_all(&base);
    }

    /// 孤立虚拟磁盘是**文件**，必须走 `remove_file`。
    ///
    /// 旧实现一律 `remove_dir_all`，对文件必然报「目录名无效」——
    /// 而 WSL 的 `ext4.vhdx` 动辄几十 GB，是最值钱的一条。
    #[test]
    fn virtual_disk_file_is_deleted_as_file() {
        let base = case_dir("virtual-disk");
        let root = base.join("Local");
        let virtual_disk = root
            .join("Packages")
            .join("CanonicalGroupLimited")
            .join("LocalState")
            .join("ext4.vhdx");
        fs::create_dir_all(virtual_disk.parent().expect("虚拟磁盘应有父目录"))
            .expect("创建虚拟磁盘目录失败");
        fs::write(&virtual_disk, vec![0u8; 4096]).expect("写入虚拟磁盘夹具失败");

        let result = delete_folders_in(
            vec![virtual_disk.to_string_lossy().to_string()],
            &[],
            std::slice::from_ref(&root),
        );

        assert_eq!(result.deleted_count, 1, "虚拟磁盘文件应被删除");
        assert_eq!(result.deleted_size, 4096, "大小按文件实际长度记");
        assert!(result.errors.is_empty(), "不应产生错误: {:?}", result.errors);
        assert!(!virtual_disk.exists(), "文件应已不存在");

        let _ = fs::remove_dir_all(&base);
    }

    /// `errors` 与 `failed_paths` 必须逐条对齐。
    ///
    /// 前端用 `failed_paths.indexOf(path)` 去 `errors` 里取错误信息，
    /// 旧实现把「因可执行文件跳过」的路径只推进 errors、不推进 failed_paths，
    /// 结果从第一条跳过项开始，后面每个条目的错误信息都串到别人头上。
    #[test]
    fn skipped_executables_stay_index_aligned_with_errors() {
        let base = case_dir("aligned");
        let root = base.join("Local");
        let skipped = root.join("LegacyApp");
        let plain = root.join("PlainLeftover");
        let missing = root.join("GoneApp");
        fs::create_dir_all(&skipped).expect("创建跳过用例目录失败");
        fs::create_dir_all(&plain).expect("创建普通用例目录失败");
        fs::write(skipped.join("uninstall.exe"), vec![0u8; 2048]).expect("写入卸载程序失败");
        fs::write(plain.join("cache.bin"), vec![0u8; 1024]).expect("写入普通残留失败");

        let result = delete_folders_in(
            vec![
                skipped.to_string_lossy().to_string(),
                plain.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
            &[],
            std::slice::from_ref(&root),
        );

        assert_eq!(result.deleted_count, 1, "只有普通残留会被删掉");
        assert_eq!(result.skipped_executables.len(), 1);
        assert_eq!(result.failed_paths.len(), 2, "跳过项与不存在项都算没删掉");
        assert_eq!(result.errors.len(), result.failed_paths.len(), "逐条对齐");
        assert_eq!(result.failed_paths[0], skipped.to_string_lossy().to_string());
        assert!(
            result.errors[0].starts_with(skipped.to_string_lossy().as_ref()),
            "第一条错误必须属于被跳过的目录，实际: {}",
            result.errors[0]
        );
        assert!(
            result.errors[1].contains("无法读取"),
            "第二条错误必须属于不存在的目录，实际: {}",
            result.errors[1]
        );
        assert!(skipped.exists(), "含可执行文件的目录不能被删");
        assert!(!plain.exists(), "普通残留应已删除");

        let _ = fs::remove_dir_all(&base);
    }

    /// 空结果必须带上"为什么"，否则用户分不清「真没残留」和「扫描坏了」。
    ///
    /// 这条钉住三个诊断字段：检查过多少目录、有多少条卡在门槛下、最高分多少。
    #[test]
    fn empty_result_reports_scan_diagnostics() {
        let base = case_dir("diagnostics");
        let root = base.join("Local");
        let candidate = root.join("RecentNoEvidenceApp");
        fs::create_dir_all(&candidate).expect("创建测试目录失败");
        fs::write(candidate.join("data.bin"), vec![0u8; 2 * 1024 * 1024])
            .expect("写入测试文件失败");

        let mut scanner = LeftoverScanner::new();
        scanner.deep_scan = false;
        let result = scanner.scan_with_paths(vec![(root.clone(), LeftoverSource::LocalAppData)], &[]);

        assert!(result.leftovers.is_empty(), "没有正向证据不该出结果");
        assert_eq!(result.scanned_directories, 1, "必须报告检查过几个目录");
        assert_eq!(result.below_threshold, 1, "必须报告有多少条卡在门槛下");
        assert!(
            (result.confidence_threshold - scanner.min_confidence_threshold).abs() < f32::EPSILON,
            "门槛要和扫描器同源，前端不另写死"
        );
        assert!(
            result.highest_confidence <= 0.05,
            "今天刚改过、没有任何残留证据，分数应接近 0，实际 {}",
            result.highest_confidence
        );

        let _ = fs::remove_dir_all(&base);
    }

    /// 构造一个"装了什么、卸载了什么"完全可控的扫描器。
    ///
    /// 真实注册表不可预期：这台机器装着 Playwright，换台机器可能没有。
    /// 评分规则要能脱离机器环境验证，否则只能在"我这台是这结果"的层面打转。
    fn scanner_with_apps(installed: &[&str], uninstalled: &[&str]) -> LeftoverScanner {
        let apps: Vec<InstalledAppInfo> = installed
            .iter()
            .map(|name| InstalledAppInfo {
                display_name: (*name).to_string(),
                install_location: None,
                inferred_folder_names: Vec::new(),
            })
            .collect();

        let mut uninstalled_tokens: HashMap<String, String> = HashMap::new();
        for name in uninstalled {
            let lower = name.to_lowercase();
            for token in name_tokens(&lower) {
                uninstalled_tokens
                    .entry(token.to_string())
                    .or_insert_with(|| lower.clone());
            }
        }

        LeftoverScanner {
            app_map: InstalledAppMap {
                token_to_app: build_token_index(&apps),
                apps,
                folder_to_app: HashMap::new(),
                known_folders: HashSet::new(),
                display_names: HashSet::new(),
                leftover_candidates: HashSet::new(),
                uninstalled_tokens,
            },
            // 内置白名单会挡住 `code`、`nvidia` 这类真实目录名；测试只关心评分，传空最可控
            whitelist: Vec::new(),
            min_size_threshold: 1024 * 1024,
            min_days_old: 7,
            deep_scan: false,
            min_confidence_threshold: SUSPICIOUS_SCORE,
        }
    }

    /// 拆词的唯一目的：让"目录名"和"应用名"能对上，同时不被泛指词带偏。
    #[test]
    fn name_tokens_keep_only_meaningful_words() {
        // 写成带显式生命周期的函数而不是闭包：闭包推断不出返回引用指向入参，
        // 编译器会报 lifetime may not live long enough
        fn tokens(name: &str) -> Vec<&str> {
            name_tokens(name).collect()
        }

        assert_eq!(tokens("ms-playwright"), vec!["playwright"]);
        assert_eq!(tokens("kimi-desktop-updater"), vec!["kimi"]);
        assert_eq!(tokens("ollama app"), vec!["ollama"]);
        assert_eq!(tokens("comfyui-desktop-2-updater"), vec!["comfyui"]);

        // 泛指词 / 太短 / 纯数字都不参与匹配 —— 否则装了任意一个 Electron 应用，
        // 所有带 desktop 的目录都会被当成它的数据
        assert!(tokens("application").is_empty());
        assert!(tokens("desktop").is_empty());
        assert!(tokens("app").is_empty());
        assert!(tokens("2022").is_empty());
    }

    /// 同一个目录名，应用还装着是负向证据，已卸载才是正向证据。
    #[test]
    fn token_match_tells_installed_apart_from_uninstalled() {
        let installed = scanner_with_apps(&["ms-playwright"], &[]);
        assert_eq!(
            installed.app_map.installed_app_for_name("ms-playwright"),
            Some("ms-playwright"),
            "装了 Playwright 时，ms-playwright 目录必须被认为是它在用"
        );
        assert_eq!(
            installed.app_map.installed_app_for_name("kimi-desktop-updater"),
            None
        );

        let uninstalled = scanner_with_apps(&[], &["Kimi"]);
        assert_eq!(
            uninstalled.app_map.uninstalled_app_for_name("kimi-desktop-updater"),
            Some("kimi"),
            "Kimi 卸载后，kimi-* 目录应能对上历史安装记录"
        );
        assert_eq!(
            uninstalled.app_map.uninstalled_app_for_name("desktop-app"),
            None,
            "全是停用词的名字不能被判成历史命中"
        );
    }

    /// 空壳目录：删空之后留下的目录，只有"历史里出现过"才够格输出。
    ///
    /// 这一条钉的是真实卸载残留的主要形态（豆包卸载后 Local\Doubao 剩 0 字节），
    /// 它以前连评分都进不了 —— 体积门槛在评分之前就把它过滤了。
    #[test]
    fn empty_shell_needs_history_evidence() {
        let base = case_dir("empty-shell");
        let root = base.join("Local");
        let ghost = root.join("GhostApp");
        let stranger = root.join("StrangerApp");
        fs::create_dir_all(&ghost).expect("创建空壳目录失败");
        fs::create_dir_all(&stranger).expect("创建空壳目录失败");

        let scanner = scanner_with_apps(&[], &["GhostApp"]);
        let result =
            scanner.scan_with_paths(vec![(root.clone(), LeftoverSource::LocalAppData)], &[]);

        let paths: Vec<&str> = result
            .leftovers
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(
            paths.len(),
            1,
            "只有能对上历史的空目录才该输出，实际: {:?}",
            paths
        );
        assert!(paths[0].ends_with("GhostApp"));
        assert!(
            result.leftovers[0].reasons.iter().any(|r| r.contains("已空")),
            "理由里要说明它是空目录"
        );

        let _ = fs::remove_dir_all(&base);
    }

    /// 根目录孤立文件：只认可执行文件，且太小的不报。
    ///
    /// `Roaming\ollama app.exe` 是这类残留的典型：安装器把启动器丢在根目录，
    /// 卸载时没删。主流程只遍历目录，永远看不见它。
    #[test]
    fn loose_file_needs_executable_type_and_real_size() {
        let base = case_dir("loose");
        let root = base.join("Roaming");
        fs::create_dir_all(root.join("SomeDir")).expect("创建目录失败");
        fs::write(root.join("stray.exe"), vec![0u8; 128 * 1024]).expect("写入 exe 失败");
        fs::write(root.join("tiny.exe"), vec![0u8; 1024]).expect("写入小 exe 失败");
        fs::write(root.join("settings.json"), vec![0u8; 128 * 1024]).expect("写入配置文件失败");

        // 让 stray.exe 对上一条"已卸载"的历史，否则单凭"根目录有个 exe"不足以定罪
        let scanner = scanner_with_apps(&[], &["stray"]);
        let entries =
            scanner.scan_loose_files(&[(root.clone(), LeftoverSource::RoamingAppData)], &[]);

        let names: Vec<&str> = entries.iter().map(|entry| entry.app_name.as_str()).collect();
        assert_eq!(names, vec!["stray.exe"], "只有够大的 exe 该被报出来");
        assert_eq!(entries[0].leftover_type, LeftoverType::LooseFile);
        assert_eq!(entries[0].file_count, 1, "文件条目按 1 个文件计");
        assert_eq!(entries[0].size, 128 * 1024);

        let _ = fs::remove_dir_all(&base);
    }

    /// 同名应用还装着时，根目录的 exe 不能被当成残留。
    #[test]
    fn loose_file_ignored_while_its_app_is_still_installed() {
        let base = case_dir("loose-installed");
        let root = base.join("Roaming");
        fs::create_dir_all(&root).expect("创建目录失败");
        fs::write(root.join("ollama app.exe"), vec![0u8; 256 * 1024])
            .expect("写入 exe 失败");

        let scanner = scanner_with_apps(&["Ollama"], &[]);
        let entries =
            scanner.scan_loose_files(&[(root.clone(), LeftoverSource::RoamingAppData)], &[]);

        assert!(
            entries.is_empty(),
            "Ollama 还装着时，ollama app.exe 可能是它自己在用，不能报: {:?}",
            entries.iter().map(|e| e.app_name.as_str()).collect::<Vec<_>>()
        );

        let _ = fs::remove_dir_all(&base);
    }
}
