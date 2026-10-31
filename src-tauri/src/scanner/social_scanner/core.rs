// ============================================================================
// 社交软件专清扫描器 - 智能路径溯源与文件类型深度分类
// ============================================================================
//
// 支持的社交软件：
// - 微信 (WeChat): 注册表 + 文档目录 + 全盘搜索定位数据目录，同时兼容旧版 3.x（WeChat Files）
//   与新版 4.x（xwechat_files / db_storage + msg）两代目录结构
// - QQ/NTQQ: 定位 nt_data 目录与 nt_qq\global，识别消息数据库；
//   安装路径除注册表外还会从常见安装目录推断，覆盖自定义安装位置
// - 钉钉 (DingTalk): 定位 storage 和 cache 目录
// - 飞书 (Lark/Feishu): 扫描 LarkShell，定位 sdk_storage 和 file_storage
// - 企业微信 (WXWork): 识别缓存和文件目录
// - Telegram: 识别缓存目录
//
// ============================================================================
// 风险等级说明
// ============================================================================
//
// CRITICAL (危险) - 聊天记录数据库，禁止删除
//   识别规则：
//   1. 路径包含: Msg/Database, Msg/Multi, nt_msg, nt_db, db_storage, tdata
//   2. 文件后缀: .db, .db-wal, .db-shm, .sqlite, .sqlite-wal, .sqlite-shm
//   3. 效果: is_deletable = false，前端禁用勾选
//
// MEDIUM (提示) - 接收的文件，谨慎清理
//   识别规则：
//   1. 路径包含: FileStorage/File, FileRecv, MsgAttach, file_storage
//   2. 效果: 提醒用户可能包含重要文档
//
// LOW (安全) - 加密图片/视频，建议清理
//   识别规则：
//   1. 微信 FileStorage/Image 下的 .dat 文件（加密图片）
//   2. Image, Video, Pic, Ptt 目录下的媒体文件
//   3. 效果: 建议清理，删除后可重新下载
//
// NONE (无风险) - 临时缓存与日志，安全清理
//   识别规则：
//   1. 路径包含: Cache, Temp, Log, WebView, Thumb, sdk_storage
//   2. 效果: 安全清理，不影响正常使用
//
// ============================================================================

use log::info;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 单条扫描路径的最大递归深度。
///
/// 与原先 `walkdir` 的 `max_depth(16)` 保持一致：微信深层目录
/// （`msg/attach/<hash>/<日期>/…`）很容易超过 10 层，调小会漏扫。
const SOCIAL_SCAN_MAX_DEPTH: usize = 16;

/// 前几层把子目录交给 rayon 分叉。
///
/// 实测（本机 10.5 万文件 / 1.5 万目录）：只分 1 层时，一旦某个子目录占掉绝大部分
/// 开销就毫无收益 —— QQ 的 `Image` 有 4388 个目录，其中 `Group2` 独占 1618 个，
/// 分 1 层只有 1.0×；分到 3 层能到 1.8×～3.7×。
const SOCIAL_SCAN_FORK_DEPTH: usize = 3;

/// 耗时浮层里最多列几条最慢的扫描路径。
///
/// 取 5 条：一屏放得下，也足够判断「是某个软件的某个目录拖慢的」。
const SOCIAL_SLOW_PATH_LIMIT: usize = 5;

// ============================================================================
// 枚举定义
// ============================================================================

/// 文件风险等级
/// 用于标记文件的安全性，指导用户是否可以删除
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    /// 危险 - 聊天记录数据库，禁止删除
    /// 特征：.db, .db-wal, .db-shm 文件，位于 Msg/Database/nt_msg 目录
    Critical,

    /// 提示 - 接收的文件，谨慎清理
    /// 特征：File, FileRecv, MsgAttach 目录下的文件
    Medium,

    /// 安全 - 加密图片/视频，建议清理（本地备份）
    /// 特征：Image 目录下的 .dat 文件，视频缓存
    Low,

    /// 无风险 - 临时缓存与日志，安全清理
    /// 特征：Cache, Temp, Log, WebView, Thumb 目录
    None,
}

impl RiskLevel {
    /// 获取风险等级的中文描述
    pub fn description(&self) -> &'static str {
        match self {
            RiskLevel::Critical => "危险（聊天记录）",
            RiskLevel::Medium => "谨慎清理",
            RiskLevel::Low => "建议清理",
            RiskLevel::None => "安全清理",
        }
    }

    /// 获取风险等级的提示信息
    pub fn tooltip(&self) -> &'static str {
        match self {
            RiskLevel::Critical => "此文件为聊天记录数据库，删除后将永久丢失聊天记录，强烈建议保留",
            RiskLevel::Medium => "此文件可能包含重要文档或附件，请确认后再删除",
            RiskLevel::Low => "此文件为图片/视频缓存，删除后可通过重新下载恢复",
            RiskLevel::None => "此文件为临时缓存，可安全删除",
        }
    }

    /// 是否允许用户勾选删除
    pub fn is_deletable(&self) -> bool {
        !matches!(self, RiskLevel::Critical)
    }
}

/// 文件分类
/// 根据目录特征和文件后缀进行分类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileCategory {
    /// 聊天记录数据库
    /// 包含 .db, .db-wal, .db-shm 文件
    ChatDatabase,

    /// 图片视频缓存
    /// 包含加密的 .dat 文件和常见图片/视频格式
    ImageVideo,

    /// 传输文件
    /// 用户接收的各类文件
    FileTransfer,

    /// 临时缓存
    /// 包含 Cache, Temp, Log, WebView, Thumb 等目录
    TempCache,

    /// 朋友圈/动态缓存
    /// 包含 Sns, Moments 等目录
    MomentsCache,
}

impl FileCategory {
    /// 获取分类的中文名称
    pub fn display_name(&self) -> &'static str {
        match self {
            FileCategory::ChatDatabase => "聊天记录",
            FileCategory::ImageVideo => "图片视频",
            FileCategory::FileTransfer => "传输文件",
            FileCategory::TempCache => "临时缓存",
            FileCategory::MomentsCache => "动态缓存",
        }
    }

    /// 获取分类的描述
    pub fn description(&self) -> &'static str {
        match self {
            FileCategory::ChatDatabase => "聊天记录数据库文件，删除后无法恢复",
            FileCategory::ImageVideo => "聊天中收发的图片和视频文件",
            FileCategory::FileTransfer => "通过聊天传输的各类文件",
            FileCategory::TempCache => "应用运行产生的临时缓存",
            FileCategory::MomentsCache => "朋友圈、空间动态等缓存数据",
        }
    }

    /// 获取分类唯一标识符（用于前后端 key 匹配）
    pub fn id(&self) -> &'static str {
        match self {
            FileCategory::ChatDatabase => "chatdatabase",
            FileCategory::ImageVideo => "imagevideo",
            FileCategory::FileTransfer => "filetransfer",
            FileCategory::TempCache => "tempcache",
            FileCategory::MomentsCache => "momentscache",
        }
    }

    /// 获取该分类的默认风险等级
    pub fn default_risk_level(&self) -> RiskLevel {
        match self {
            FileCategory::ChatDatabase => RiskLevel::Critical,
            FileCategory::ImageVideo => RiskLevel::Low,
            FileCategory::FileTransfer => RiskLevel::Medium,
            FileCategory::TempCache => RiskLevel::None,
            FileCategory::MomentsCache => RiskLevel::None,
        }
    }
}

// ============================================================================
// 数据结构
// ============================================================================

/// 社交软件文件条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialFileEntry {
    /// 文件完整路径
    pub path: String,
    /// 文件大小（字节）
    pub size: u64,
    /// 所属应用名称
    pub app_name: String,
    /// 文件分类
    pub category: FileCategory,
    /// 风险等级
    pub risk_level: RiskLevel,
    /// 是否可删除（Critical 级别强制为 false）
    pub deletable: bool,
}

/// 社交软件分类统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialCategoryStats {
    /// 分类ID
    pub id: String,
    /// 分类名称
    pub name: String,
    /// 分类描述
    pub description: String,
    /// 文件数量
    pub file_count: usize,
    /// 总大小（字节）
    pub total_size: u64,
    /// 可删除的文件数量
    pub deletable_count: usize,
    /// 可删除的文件大小
    pub deletable_size: u64,
    /// 文件列表
    pub files: Vec<SocialFileEntry>,
}

/// 社交软件扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialScanResult {
    /// 按分类统计
    pub categories: Vec<SocialCategoryStats>,
    /// 总文件数
    pub total_files: usize,
    /// 总大小
    pub total_size: u64,
    /// 可删除的文件数
    pub deletable_files: usize,
    /// 可删除的文件大小
    pub deletable_size: u64,
    /// 检测到的社交软件列表
    pub detected_apps: Vec<String>,
    /// 阶段耗时明细（排查性能用，前端默认收在「秒表」浮层里，不点不显示）
    pub phase_durations: Vec<SocialPhaseDuration>,
    /// 最慢的几条扫描路径（最多 5 条），用来回答「为什么这个用户扫得慢」
    pub slow_paths: Vec<SocialSlowPath>,
}

/// 单个扫描阶段的耗时
///
/// 只在阶段边界取一次时间戳，不参与遍历循环 —— 十几次 `Instant::now()`
/// 相对整次扫描（百毫秒级）完全可以忽略。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialPhaseDuration {
    /// 阶段标识：detect（路径探测）/ categorize（遍历并分级）/ total
    pub stage: String,
    /// 阶段耗时，单位毫秒
    pub duration_ms: u64,
}

/// 单条扫描路径的耗时明细
///
/// 同时给出目录数：这个模块的开销主要来自 `readdir` 次数，目录数远大于文件数时
/// （比如 QQ 的 `Image`：4388 个目录只有 1803 个文件），慢的原因就是"列目录"
/// 而不是"文件多"，看这一行就能判断，不用让用户装工具。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialSlowPath {
    /// 扫描路径
    pub path: String,
    /// 所属应用
    pub app_name: String,
    /// 该路径耗时，单位毫秒
    pub duration_ms: u64,
    /// 该路径下的文件数
    pub file_count: usize,
    /// 该路径下的目录数（含自身）
    pub directory_count: usize,
}

/// 一次子树遍历的产出：文件条目 + 走过的目录数
///
/// 目录数要单独返回，是因为这个模块的耗时几乎全在 `readdir` 上
/// （见 `docs/dev/扫描性能优化.md` §6.1）：排查「为什么扫得慢」必须能区分
/// 是「文件多」还是「目录多」—— 两者的单位成本差两个数量级。
struct DirectoryWalk {
    /// 该子树下收集到的文件条目
    entries: Vec<SocialFileEntry>,
    /// 该子树下的目录数（含子树根自身）
    directory_count: usize,
}

impl DirectoryWalk {
    /// 空产出：深度超限或目录读不了时用，不参与目录统计
    fn empty() -> Self {
        Self {
            entries: Vec::new(),
            directory_count: 0,
        }
    }
}

/// 社交软件路径信息
#[derive(Debug, Clone)]
pub struct SocialAppPath {
    /// 应用名称
    pub app_name: String,
    /// 路径
    pub path: PathBuf,
    /// 文件分类
    pub category: FileCategory,
    /// 是否为用户自定义路径（通过注册表获取）
    #[allow(dead_code)]
    pub is_custom_path: bool,
}

/// 注册表路径解析结果
/// 用于处理微信等软件的自定义路径配置
#[derive(Debug, Clone)]
pub(super) enum RegistryPathResult {
    /// 使用系统文档目录（注册表值为 "MyDocument:"）
    MyDocument,
    /// 绝对路径（如 "E:\data\xwechat_files"）
    AbsolutePath(String),
}

// ============================================================================
// 社交软件扫描器
// ============================================================================

/// 社交软件扫描器
/// 负责智能路径溯源和文件类型深度分类
pub struct SocialScanner {
    /// 用户目录
    pub(super) user_profile: String,
    /// LocalAppData 目录
    pub(super) local_appdata: String,
    /// Roaming AppData 目录
    pub(super) appdata: String,
    /// 文档目录（可能在非系统盘）
    pub(super) documents_dir: String,
    /// 默认文档目录
    pub(super) default_documents: String,
    /// 所有可用盘符（用于全盘搜索）
    pub(super) available_drives: Vec<String>,
}

impl SocialScanner {
    /// 创建新的扫描器实例
    pub fn new() -> Self {
        let user_profile =
            std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\Users\\Default".to_string());
        let local_appdata = std::env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| format!("{}\\AppData\\Local", user_profile));
        let appdata = std::env::var("APPDATA")
            .unwrap_or_else(|_| format!("{}\\AppData\\Roaming", user_profile));

        // 获取真实的文档目录（可能在 D 盘等非系统盘）
        let documents_dir = dirs::document_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{}\\Documents", user_profile));

        let default_documents = format!("{}\\Documents", user_profile);

        // 获取所有可用盘符（用于全盘搜索备选）
        let available_drives = Self::get_available_drives();

        info!("SocialScanner 初始化:");
        info!("  用户目录: {}", user_profile);
        info!("  文档目录: {}", documents_dir);
        info!("  LocalAppData: {}", local_appdata);
        info!("  可用盘符: {:?}", available_drives);

        Self {
            user_profile,
            local_appdata,
            appdata,
            documents_dir,
            default_documents,
            available_drives,
        }
    }

    // ========================================================================
    // 系统工具方法
    // ========================================================================

    /// 获取所有可用的磁盘盘符
    #[cfg(target_os = "windows")]
    fn get_available_drives() -> Vec<String> {
        let mut drives = Vec::new();
        // 检查 A-Z 盘符
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                drives.push(drive);
            }
        }
        drives
    }

    #[cfg(not(target_os = "windows"))]
    fn get_available_drives() -> Vec<String> {
        vec!["/".to_string()]
    }

    /// 执行扫描
    pub fn scan(&self) -> SocialScanResult {
        // 三个时间点就够定位问题：探测（跟数据量无关）、遍历（跟目录数相关）、合计
        let scan_started = Instant::now();
        let mut all_paths = Vec::new();
        let mut detected_apps = Vec::new();

        // 1. 微信路径检测（包括注册表溯源）
        if let Some(paths) = self.detect_wechat_paths() {
            if !paths.is_empty() {
                detected_apps.push("微信".to_string());
                all_paths.extend(paths);
            }
        }

        // 2. QQ/NTQQ 路径检测
        if let Some(paths) = self.detect_qq_paths() {
            if !paths.is_empty() {
                detected_apps.push("QQ".to_string());
                all_paths.extend(paths);
            }
        }

        if let Some(paths) = self.detect_ntqq_paths() {
            if !paths.is_empty() {
                if !detected_apps.contains(&"NTQQ".to_string()) {
                    detected_apps.push("NTQQ".to_string());
                }
                all_paths.extend(paths);
            }
        }

        // 3. 钉钉路径检测
        if let Some(paths) = self.detect_dingtalk_paths() {
            if !paths.is_empty() {
                detected_apps.push("钉钉".to_string());
                all_paths.extend(paths);
            }
        }

        // 4. 飞书路径检测
        if let Some(paths) = self.detect_feishu_paths() {
            if !paths.is_empty() {
                detected_apps.push("飞书".to_string());
                all_paths.extend(paths);
            }
        }

        // 5. 企业微信路径检测
        if let Some(paths) = self.detect_wxwork_paths() {
            if !paths.is_empty() {
                detected_apps.push("企业微信".to_string());
                all_paths.extend(paths);
            }
        }

        // 6. Telegram 路径检测
        if let Some(paths) = self.detect_telegram_paths() {
            if !paths.is_empty() {
                detected_apps.push("Telegram".to_string());
                all_paths.extend(paths);
            }
        }

        // LINE 和 WhatsApp 使用独立适配器，避免把海外客户端路径规则混入国内软件逻辑。
        if let Some(paths) = self.detect_line_paths() {
            if !paths.is_empty() {
                detected_apps.push("LINE".to_string());
                all_paths.extend(paths);
            }
        }

        if let Some(paths) = self.detect_whatsapp_paths() {
            if !paths.is_empty() {
                detected_apps.push("WhatsApp".to_string());
                all_paths.extend(paths);
            }
        }

        info!(
            "共检测到 {} 个社交软件，{} 个扫描路径",
            detected_apps.len(),
            all_paths.len()
        );

        // 路径探测到此结束：这一段是注册表 + 全盘浅层搜索，与聊天数据大小无关
        let detect_duration = scan_started.elapsed();

        // 执行文件扫描并分类
        let walk_started = Instant::now();
        let (categories, slow_paths) = self.scan_and_classify(&all_paths);
        let categorize_duration = walk_started.elapsed();

        // 统计汇总
        let total_files: usize = categories.iter().map(|c| c.file_count).sum();
        let total_size: u64 = categories.iter().map(|c| c.total_size).sum();
        let deletable_files: usize = categories.iter().map(|c| c.deletable_count).sum();
        let deletable_size: u64 = categories.iter().map(|c| c.deletable_size).sum();

        let phase_durations = vec![
            SocialPhaseDuration {
                stage: "detect".to_string(),
                duration_ms: detect_duration.as_millis() as u64,
            },
            SocialPhaseDuration {
                stage: "categorize".to_string(),
                duration_ms: categorize_duration.as_millis() as u64,
            },
            SocialPhaseDuration {
                stage: "total".to_string(),
                duration_ms: scan_started.elapsed().as_millis() as u64,
            },
        ];

        SocialScanResult {
            categories,
            total_files,
            total_size,
            deletable_files,
            deletable_size,
            detected_apps,
            phase_durations,
            slow_paths,
        }
    }

    // ========================================================================
    // 文件扫描与分类
    // ========================================================================

    /// 扫描并分类文件
    fn scan_and_classify(
        &self,
        app_paths: &[SocialAppPath],
    ) -> (Vec<SocialCategoryStats>, Vec<SocialSlowPath>) {
        // 初始化分类统计
        let mut category_map: HashMap<FileCategory, SocialCategoryStats> = HashMap::new();

        for cat in &[
            FileCategory::ChatDatabase,
            FileCategory::ImageVideo,
            FileCategory::FileTransfer,
            FileCategory::TempCache,
            FileCategory::MomentsCache,
        ] {
            category_map.insert(
                *cat,
                SocialCategoryStats {
                    id: cat.id().to_string(),
                    name: cat.display_name().to_string(),
                    description: cat.description().to_string(),
                    file_count: 0,
                    total_size: 0,
                    deletable_count: 0,
                    deletable_size: 0,
                    files: Vec::new(),
                },
            );
        }

        // 扫描每个路径；适配器可能通过多个候选入口指向同一文件，统一去重。
        //
        // ⚠️ 必须**深的路径先扫**：同一个文件被父目录和子目录同时覆盖时，先扫到的那个
        // 分类说了算。Telegram 的 tdata（聊天记录）里就包着 user_data（缓存），
        // 原来按 push 顺序先扫 tdata，1.1GB 缓存全被并进聊天记录，界面上没有独立缓存项。
        // 按层级从深到浅排序后，子路径先拿到自己的分类，父路径再跳过重复文件。
        let mut ordered_paths: Vec<_> = app_paths.iter().collect();
        ordered_paths.sort_by(|a, b| {
            b.path.components().count().cmp(&a.path.components().count())
        });

        let mut scanned_files = HashSet::new();
        // 已经完整遍历过的子树。深的路径先扫，父路径后扫时直接跳过这些子目录，
        // 免得同一批文件再走一遍目录树、再被去重全部丢掉。
        // Telegram 的 tdata 里就包着 user_data（缓存），本机实测这一项白走 33 ms。
        let mut scanned_roots: Vec<PathBuf> = Vec::new();
        // 每条路径的耗时都记下来（一百多条，开销可忽略），最后只留最慢的几条
        let mut slow_paths: Vec<SocialSlowPath> = Vec::new();
        for app_path in ordered_paths {
            if !app_path.path.exists() {
                continue;
            }

            let path_started = Instant::now();
            let (file_count, directory_count) = self.scan_directory(
                &app_path.path,
                &app_path.app_name,
                app_path.category,
                &mut category_map,
                &mut scanned_files,
                &scanned_roots,
            );

            slow_paths.push(SocialSlowPath {
                path: app_path.path.to_string_lossy().to_string(),
                app_name: app_path.app_name.clone(),
                duration_ms: path_started.elapsed().as_millis() as u64,
                file_count,
                directory_count,
            });

            scanned_roots.push(app_path.path.clone());
        }

        // 只留最慢的几条：浮层里放得下，也足够回答「慢在哪」
        slow_paths.sort_by(|left, right| right.duration_ms.cmp(&left.duration_ms));
        slow_paths.truncate(SOCIAL_SLOW_PATH_LIMIT);

        // 转换为 Vec 并排序
        let mut categories: Vec<SocialCategoryStats> = category_map.into_values().collect();

        // 按风险等级排序：Critical > Medium > Low > None
        categories.sort_by(|a, b| {
            let risk_a = self.category_to_risk(&a.id);
            let risk_b = self.category_to_risk(&b.id);
            risk_b.cmp(&risk_a)
        });

        (categories, slow_paths)
    }

    /// 扫描目录并添加到分类
    ///
    /// 遍历内部按层分叉并行（见 `SOCIAL_SCAN_FORK_DEPTH`），收集完再统一做跨路径去重。
    /// 去重放到最后是安全的：一条扫描路径内部不可能出现同一个文件，跨路径的重复
    /// 仍然按原有顺序判定"先扫到的分类说了算"。
    fn scan_directory(
        &self,
        path: &Path,
        app_name: &str,
        base_category: FileCategory,
        category_map: &mut HashMap<FileCategory, SocialCategoryStats>,
        scanned_files: &mut HashSet<String>,
        scanned_roots: &[PathBuf],
    ) -> (usize, usize) {
        let walked = self.collect_directory_entries(path, app_name, base_category, 0, scanned_roots);
        let mut counted_files = 0usize;

        for file_entry in walked.entries {
            let file_key = Self::normalize_path_key(Path::new(&file_entry.path));
            if !scanned_files.insert(file_key) {
                continue;
            }

            let size = file_entry.size;
            let deletable = file_entry.deletable;
            if let Some(stats) = category_map.get_mut(&file_entry.category) {
                stats.file_count += 1;
                stats.total_size += size;

                if deletable {
                    stats.deletable_count += 1;
                    stats.deletable_size += size;
                }

                stats.files.push(file_entry);
                counted_files += 1;
            }
        }

        (counted_files, walked.directory_count)
    }

    /// 收集一个目录（含子目录）下的全部文件条目，顺带统计走过的目录数。
    ///
    /// 与原先 `walkdir` 的遍历等价：不跟随符号链接、只取普通文件、深度上限 16 层。
    /// 唯一的差别是顺序（先直属文件、再各子目录），后端本来就不保证文件顺序，
    /// 前端按分类整体展示、弹窗自己筛选，不依赖它。
    ///
    /// 并行只作用在**同一棵子树内**：子目录之间互不重叠，分给不同线程不会改变结果集合。
    fn collect_directory_entries(
        &self,
        directory: &Path,
        app_name: &str,
        base_category: FileCategory,
        depth: usize,
        scanned_roots: &[PathBuf],
    ) -> DirectoryWalk {
        // 目录自身已经处在深度上限，再往下就超过原实现的 max_depth(16)
        if depth >= SOCIAL_SCAN_MAX_DEPTH {
            return DirectoryWalk::empty();
        }

        // 权限不足 / 目录刚被删掉：原实现同样静默跳过，不中断整次扫描
        let Ok(read_dir) = std::fs::read_dir(directory) else {
            return DirectoryWalk::empty();
        };

        let mut entries = Vec::new();
        let mut subdirectories = Vec::new();
        for dir_entry in read_dir.filter_map(|item| item.ok()) {
            let Ok(file_type) = dir_entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                let child = dir_entry.path();
                // 已被更深的扫描路径完整覆盖的子树直接跳过（结果会由那条路径产出）
                let covered = scanned_roots.iter().any(|root| child.starts_with(root));
                if !covered {
                    subdirectories.push(child);
                }
                continue;
            }

            // 只要普通文件：符号链接、设备等一律不计入（与原 walkdir 的 is_file 过滤一致）
            if !file_type.is_file() {
                continue;
            }

            // Windows 上 read_dir 已经带回文件大小，metadata 不会额外发起系统调用
            if let Ok(metadata) = dir_entry.metadata() {
                entries.push(self.build_file_entry(
                    &dir_entry.path(),
                    metadata.len(),
                    app_name,
                    base_category,
                ));
            }
        }

        // 只有前几层才分叉：再深就退回单线程，避免小目录派生出大量空任务
        let child_walks: Vec<DirectoryWalk> =
            if depth < SOCIAL_SCAN_FORK_DEPTH && subdirectories.len() > 1 {
                subdirectories
                    .par_iter()
                    .map(|child| {
                        self.collect_directory_entries(
                            child,
                            app_name,
                            base_category,
                            depth + 1,
                            scanned_roots,
                        )
                    })
                    .collect()
            } else {
                subdirectories
                    .iter()
                    .map(|child| {
                        self.collect_directory_entries(
                            child,
                            app_name,
                            base_category,
                            depth + 1,
                            scanned_roots,
                        )
                    })
                    .collect()
            };

        // 当前目录自身也算一个（下面累加子目录的数量）
        let mut directory_count = 1usize;
        for child_walk in child_walks {
            entries.extend(child_walk.entries);
            directory_count += child_walk.directory_count;
        }

        DirectoryWalk {
            entries,
            directory_count,
        }
    }

    /// 组装单个文件条目：分类与风险等级仍走 `classify_file`，规则一条都没动
    fn build_file_entry(
        &self,
        path: &Path,
        size: u64,
        app_name: &str,
        base_category: FileCategory,
    ) -> SocialFileEntry {
        let (category, risk_level) = self.classify_file(path, base_category);
        SocialFileEntry {
            path: path.to_string_lossy().to_string(),
            size,
            app_name: app_name.to_string(),
            category,
            risk_level,
            deletable: risk_level.is_deletable(),
        }
    }

    /// 根据文件特征分类并确定风险等级
    ///
    /// # 风险分级规则（按优先级排序）
    ///
    /// ## 1. CRITICAL (危险) - 聊天记录数据库，禁止删除
    ///
    /// **路径特征匹配（高优先级）：**
    /// - `Msg/Database` - 微信消息数据库目录
    /// - `Msg/Multi` - 微信多开消息目录
    /// - `nt_msg` - NTQQ 消息数据库
    /// - `nt_db` - NTQQ 用户数据库
    /// - `tdata` - Telegram 数据目录
    /// - `Database` - 钉钉数据库目录
    ///
    /// **文件后缀匹配：**
    /// - `.db`, `.db-wal`, `.db-shm` - SQLite 数据库文件
    /// - `.sqlite`, `.sqlite-wal`, `.sqlite-shm` - SQLite 变体
    ///
    /// **效果：** `is_deletable = false`，前端必须禁用勾选
    ///
    /// ## 2. MEDIUM (提示) - 传输文件，谨慎清理
    ///
    /// **路径特征匹配：**
    /// - `FileStorage/File` - 微信传输文件
    /// - `FileRecv` - QQ 接收文件
    /// - `MsgAttach` - 微信消息附件
    /// - `file_storage` - 飞书文件存储
    ///
    /// **效果：** 提醒用户可能包含重要文档
    ///
    /// ## 3. LOW (安全) - 图片视频缓存，建议清理
    ///
    /// **路径特征匹配：**
    /// - `FileStorage/Image` - 微信图片（含 .dat 加密图片）
    /// - `Image`, `Video`, `Pic`, `Ptt` - 各软件媒体目录
    ///
    /// **效果：** 建议清理，删除后可重新下载
    ///
    /// ## 4. NONE (无风险) - 临时缓存，安全清理
    ///
    /// **路径特征匹配：**
    /// - `Cache`, `Temp`, `Log`, `WebView`, `Thumb`
    /// - `sdk_storage`, `logs`
    ///
    /// **效果：** 安全清理，不影响正常使用
    fn classify_file(&self, path: &Path, base_category: FileCategory) -> (FileCategory, RiskLevel) {
        let path_str = path.to_string_lossy().to_lowercase();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // ================================================================
        // 规则 1: 聊天记录数据库 (CRITICAL) - 最高优先级
        // ================================================================

        // 数据库文件后缀
        let db_extensions = [
            "db",
            "db-wal",
            "db-shm",
            "sqlite",
            "sqlite-wal",
            "sqlite-shm",
        ];

        // 数据库目录特征（精确匹配路径片段）
        // 使用更精确的路径匹配，避免误判
        let critical_path_patterns = [
            "\\msg\\database", // 微信: Msg/Database
            "\\msg\\multi",    // 微信: Msg/Multi
            "/msg/database",   // 兼容正斜杠
            "/msg/multi",
            "\\nt_msg", // NTQQ: nt_msg
            "\\nt_db",  // NTQQ: nt_db
            "/nt_msg",
            "/nt_db",
            "\\tdata\\", // Telegram: tdata
            "/tdata/",
            "\\database\\", // 钉钉: Database
            "/database/",
        ];

        // Telegram 的缓存目录（user_data）在 tdata 里面，路径同样包含 "\tdata\"，
        // 会被下面的特征误判成聊天记录 —— 把 1.1GB 缓存算进"不可删除"，
        // 界面上就永远看不到独立的缓存项。这里先把它排除掉。
        let is_telegram_cache =
            path_str.contains("\\tdata\\user_data") || path_str.contains("/tdata/user_data");

        // 检查是否在数据库关键目录中
        let in_critical_dir = !is_telegram_cache
            && critical_path_patterns
                .iter()
                .any(|pattern| path_str.contains(pattern));

        // 如果在关键目录中，或者是数据库文件后缀
        if in_critical_dir {
            return (FileCategory::ChatDatabase, RiskLevel::Critical);
        }

        // 数据库文件后缀 + 基础分类是数据库
        if db_extensions.contains(&ext.as_str()) {
            if base_category == FileCategory::ChatDatabase {
                return (FileCategory::ChatDatabase, RiskLevel::Critical);
            }
            // 即使不在数据库目录，.db 文件也需要检查路径
            let db_related_dirs = ["msg", "database", "nt_msg", "nt_db", "tdata"];
            if db_related_dirs.iter().any(|d| path_str.contains(d)) {
                return (FileCategory::ChatDatabase, RiskLevel::Critical);
            }
        }

        // 基础分类是数据库，所有文件都标记为 Critical
        if base_category == FileCategory::ChatDatabase {
            return (FileCategory::ChatDatabase, RiskLevel::Critical);
        }

        // ================================================================
        // 规则 2: 临时缓存 (NONE)
        // 仅当 base_category 本身是 TempCache 时，才允许 cache 路径匹配生效；
        // 若 base_category 是 ImageVideo / FileTransfer / MomentsCache，
        // 则信任 base_category，不因路径含 "cache" 而被拦截
        // ================================================================

        let cache_path_patterns = [
            "\\cache\\",
            "/cache/",
            "\\temp\\",
            "/temp/",
            "\\log\\",
            "/log/",
            "\\logs\\",
            "/logs/",
            "\\webview\\",
            "/webview/",
            "\\thumb\\",
            "/thumb/",
            "\\sdk_storage\\",
            "/sdk_storage/",
            "\\customemotion\\",
            "/customemotion/",
        ];

        let is_cache_dir = cache_path_patterns
            .iter()
            .any(|pattern| path_str.contains(pattern));

        // 仅当调用方明确给了 TempCache 分类时才按 cache 路径归类
        if base_category == FileCategory::TempCache {
            return (FileCategory::TempCache, RiskLevel::None);
        }

        // ================================================================
        // 规则 3: 朋友圈/动态缓存 (NONE)
        // 先于媒体规则判断，是因为 Sns 目录里常见图片/视频缩略数据，不能被普通媒体规则抢走。
        // ================================================================

        let moments_path_patterns = [
            "\\sns\\",
            "/sns/",
            "\\moments\\",
            "/moments/",
            "\\filestorage\\sns", // 微信朋友圈完整路径
            "/filestorage/sns",
        ];

        let is_moments_dir = moments_path_patterns
            .iter()
            .any(|pattern| path_str.contains(pattern));

        if is_moments_dir || base_category == FileCategory::MomentsCache {
            return (FileCategory::MomentsCache, RiskLevel::None);
        }

        // ================================================================
        // 规则 4: 图片视频 (LOW)
        // ================================================================

        // 媒体文件后缀
        let image_video_extensions = [
            // 图片
            "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif", "tiff", "ico",
            // 视频
            "mp4", "avi", "mov", "wmv", "flv", "mkv", "webm", "m4v", "3gp", "ts",
            // 音频
            "mp3", "wav", "aac", "flac", "ogg", "wma", "m4a",
            // 微信特有格式
            "dat",  // 微信加密图片
            "silk", // 微信语音
            "amr",  // 语音格式
        ];

        let image_video_path_patterns = [
            "\\image\\",
            "/image/",
            "\\video\\",
            "/video/",
            "\\pic\\",
            "/pic/",
            "\\ptt\\",
            "/ptt/",
            "\\audio\\",
            "/audio/",
        ];

        let is_image_video_dir = image_video_path_patterns
            .iter()
            .any(|pattern| path_str.contains(pattern));

        // 微信加密图片特殊处理：FileStorage/Image 下的 .dat 文件
        let is_wechat_encrypted_image = ext == "dat"
            && (path_str.contains("filestorage\\image") || path_str.contains("filestorage/image"));

        if is_wechat_encrypted_image {
            return (FileCategory::ImageVideo, RiskLevel::Low);
        }

        if image_video_extensions.contains(&ext.as_str()) || is_image_video_dir {
            return (FileCategory::ImageVideo, RiskLevel::Low);
        }

        if base_category == FileCategory::ImageVideo {
            return (FileCategory::ImageVideo, RiskLevel::Low);
        }

        // ================================================================
        // 规则 5: 传输文件 (MEDIUM)
        // ================================================================

        let file_transfer_path_patterns = [
            "\\filestorage\\file\\", // 微信: FileStorage/File
            "/filestorage/file/",
            "\\filerecv\\", // QQ: FileRecv
            "/filerecv/",
            "\\msgattach\\", // 微信: MsgAttach
            "/msgattach/",
            "\\file_storage\\", // 飞书: file_storage
            "/file_storage/",
            "\\file\\", // 通用 File 目录
            "/file/",
        ];

        let is_file_transfer_dir = file_transfer_path_patterns
            .iter()
            .any(|pattern| path_str.contains(pattern));

        if is_file_transfer_dir || base_category == FileCategory::FileTransfer {
            return (FileCategory::FileTransfer, RiskLevel::Medium);
        }

        // ================================================================
        // 规则 6: 兜底 cache 匹配（移到末尾）
        // 走到这里说明 base_category 不是 TempCache，
        // 但路径确实含 cache 特征（如企业微信 Cache\File 下的子目录）
        // ================================================================
        if is_cache_dir {
            return (FileCategory::TempCache, RiskLevel::None);
        }

        // ================================================================
        // 默认：使用基础分类的默认风险等级
        // ================================================================
        (base_category, base_category.default_risk_level())
    }

    /// 分类ID转风险等级（用于排序）
    fn category_to_risk(&self, id: &str) -> u8 {
        match id {
            "chatdatabase" => 4,
            "filetransfer" => 3,
            "imagevideo" => 2,
            "momentscache" => 1,
            "tempcache" => 0,
            _ => 0,
        }
    }
}

impl Default for SocialScanner {
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 同一进程内并发跑用例时会重名，加序号保证每个 fixture 独占路径。
    static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    /// 构造一个临时目录，测试结束后由调用方清理。
    fn fixture(name: &str) -> PathBuf {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "lightc-social-{}-{}-{}",
            name,
            std::process::id(),
            sequence
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn test_risk_level_deletable() {
        assert!(!RiskLevel::Critical.is_deletable());
        assert!(RiskLevel::Medium.is_deletable());
        assert!(RiskLevel::Low.is_deletable());
        assert!(RiskLevel::None.is_deletable());
    }

    #[test]
    fn test_file_category_risk() {
        assert_eq!(
            FileCategory::ChatDatabase.default_risk_level(),
            RiskLevel::Critical
        );
        assert_eq!(
            FileCategory::FileTransfer.default_risk_level(),
            RiskLevel::Medium
        );
        assert_eq!(
            FileCategory::ImageVideo.default_risk_level(),
            RiskLevel::Low
        );
        assert_eq!(
            FileCategory::TempCache.default_risk_level(),
            RiskLevel::None
        );
    }

    #[test]
    fn test_path_key_normalizes_windows_separators() {
        let first = SocialScanner::normalize_path_key(Path::new(r"C:/Users/Test/Cache/"));
        let second = SocialScanner::normalize_path_key(Path::new(r"c:\users\test\cache"));
        assert_eq!(first, second);
    }

    /// 并行分叉之后仍然要收全：多层、多子目录（超过分叉阈值）一个文件都不能漏。
    #[test]
    fn collects_every_file_of_nested_directories() {
        let root = fixture("collect-nested");
        for group in 0..3 {
            for account in 0..4 {
                // 每层 4 个子目录，确保走的是并行分支而不是单线程
                let dir = root.join(format!("group{}/account{}", group, account));
                std::fs::create_dir_all(&dir).expect("创建子目录失败");
                for index in 0..5 {
                    std::fs::write(dir.join(format!("photo{}.jpg", index)), [0u8; 16])
                        .expect("写入测试文件失败");
                }
            }
        }

        let scanner = SocialScanner::new();
        let walked =
            scanner.collect_directory_entries(&root, "微信", FileCategory::ImageVideo, 0, &[]);

        assert_eq!(walked.entries.len(), 60, "3×4×5 个文件必须全部收集到");
        assert_eq!(
            walked.entries.iter().map(|entry| entry.size).sum::<u64>(),
            60 * 16,
            "文件大小必须与原实现一致"
        );
        assert!(
            walked
                .entries
                .iter()
                .all(|entry| entry.category == FileCategory::ImageVideo
                    && entry.risk_level == RiskLevel::Low),
            "分类仍由 classify_file 决定，jpg 属于图片视频"
        );
        // 目录统计要能反映真实遍历量：root + 3 个 group + 12 个 account
        assert_eq!(walked.directory_count, 16, "目录数 = 1 + 3 + 12");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 已被更深的扫描路径完整覆盖的子树必须跳过，否则同一批文件会被遍历两遍。
    #[test]
    fn skips_subdirectory_covered_by_deeper_scan() {
        let root = fixture("skip-covered");
        let covered = root.join("msg/user_data");
        std::fs::create_dir_all(&covered).expect("创建子目录失败");
        std::fs::write(covered.join("cache.bin"), [0u8; 8]).expect("写入测试文件失败");

        let sibling = root.join("msg/other");
        std::fs::create_dir_all(&sibling).expect("创建子目录失败");
        std::fs::write(sibling.join("keep.bin"), [0u8; 4]).expect("写入测试文件失败");

        let scanner = SocialScanner::new();
        let walked = scanner.collect_directory_entries(
            &root,
            "Telegram",
            FileCategory::ChatDatabase,
            0,
            &[covered.clone()],
        );

        assert_eq!(walked.entries.len(), 1, "被覆盖的子目录不应再产出条目");
        assert!(walked.entries[0].path.ends_with("keep.bin"));
        // root、msg、msg/other 三个目录；被跳过的 user_data 不计入
        assert_eq!(walked.directory_count, 3, "被跳过的子树不应计入目录数");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 深度上限必须和原来的 walkdir max_depth(16) 一致：第 16 层之后的文件不收集。
    #[test]
    fn stops_collecting_beyond_sixteen_levels() {
        let root = fixture("depth-limit");
        let mut current = root.clone();
        for level in 0..18 {
            current = current.join(format!("level{}", level));
            std::fs::create_dir_all(&current).expect("创建子目录失败");
            std::fs::write(current.join(format!("file{}.bin", level)), [0u8; 1])
                .expect("写入测试文件失败");
        }

        let scanner = SocialScanner::new();
        let walked =
            scanner.collect_directory_entries(&root, "微信", FileCategory::TempCache, 0, &[]);

        // root 是第 0 层，level0 里的文件在第 2 层……第 16 层是 level14 里的文件
        assert_eq!(walked.entries.len(), 15, "只收集深度不超过 16 层的文件");

        let _ = std::fs::remove_dir_all(&root);
    }
}
