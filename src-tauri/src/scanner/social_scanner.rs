// ============================================================================
// 社交软件专清扫描器 - 智能路径溯源与文件类型深度分类
// ============================================================================
//
// 支持的社交软件：
// - 微信 (WeChat): 通过注册表读取自定义路径，识别聊天记录数据库
// - QQ/NTQQ: 定位 nt_data 目录，识别消息数据库
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
//   1. 路径包含: Msg/Database, Msg/Multi, nt_msg, nt_db, tdata
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

use log::{debug, info};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

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
enum RegistryPathResult {
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
    user_profile: String,
    /// LocalAppData 目录
    local_appdata: String,
    /// Roaming AppData 目录
    appdata: String,
    /// 文档目录（可能在非系统盘）
    documents_dir: String,
    /// 默认文档目录
    default_documents: String,
    /// 所有可用盘符（用于全盘搜索）
    available_drives: Vec<String>,
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

        info!(
            "共检测到 {} 个社交软件，{} 个扫描路径",
            detected_apps.len(),
            all_paths.len()
        );

        // 执行文件扫描并分类
        let categories = self.scan_and_classify(&all_paths);

        // 统计汇总
        let total_files: usize = categories.iter().map(|c| c.file_count).sum();
        let total_size: u64 = categories.iter().map(|c| c.total_size).sum();
        let deletable_files: usize = categories.iter().map(|c| c.deletable_count).sum();
        let deletable_size: u64 = categories.iter().map(|c| c.deletable_size).sum();

        SocialScanResult {
            categories,
            total_files,
            total_size,
            deletable_files,
            deletable_size,
            detected_apps,
        }
    }

    // ========================================================================
    // 微信路径检测
    // ========================================================================

    /// 检测微信路径
    ///
    /// 路径溯源优先级：
    /// 1. 注册表 HKCU\Software\Tencent\WeChat\FileSavePath
    ///    - 如果值为 "MyDocument:"，则使用系统文档目录
    ///    - 如果是绝对路径（如 "E:\data\xwechat_files"），则直接使用
    /// 2. 默认文档目录下的 "WeChat Files"
    /// 3. 全盘搜索 "WeChat Files" 文件夹（保底方案）
    fn detect_wechat_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();
        let mut found_base_paths: Vec<PathBuf> = Vec::new();

        // ----------------------------------------------------------------
        // 步骤 1: 从注册表读取微信自定义路径
        // ----------------------------------------------------------------
        let registry_result = self.read_wechat_registry_path();

        match &registry_result {
            Some(RegistryPathResult::AbsolutePath(abs_path)) => {
                // 注册表返回绝对路径，直接使用
                info!("微信注册表路径(绝对): {}", abs_path);
                let path = PathBuf::from(abs_path);
                if path.exists() {
                    found_base_paths.push(path);
                }
            }
            Some(RegistryPathResult::MyDocument) => {
                // 注册表返回 MyDocument:，使用文档目录
                info!("微信注册表路径: MyDocument: -> {}", self.documents_dir);
                let path = PathBuf::from(format!("{}\\WeChat Files", self.documents_dir));
                if path.exists() {
                    found_base_paths.push(path);
                }
            }
            None => {
                debug!("微信注册表路径未找到，使用默认路径");
            }
        }

        // ----------------------------------------------------------------
        // 步骤 2: 添加默认路径（如果注册表路径不存在或未找到）
        // ----------------------------------------------------------------
        if found_base_paths.is_empty() {
            // 尝试文档目录
            let doc_path = PathBuf::from(format!("{}\\WeChat Files", self.documents_dir));
            if doc_path.exists() {
                found_base_paths.push(doc_path);
            }

            // 尝试默认文档目录（如果不同）
            if self.documents_dir != self.default_documents {
                let default_path =
                    PathBuf::from(format!("{}\\WeChat Files", self.default_documents));
                if default_path.exists() && !found_base_paths.contains(&default_path) {
                    found_base_paths.push(default_path);
                }
            }
        }

        // ----------------------------------------------------------------
        // 步骤 3: 全盘搜索备选（如果上述路径都不存在）
        // ----------------------------------------------------------------
        if found_base_paths.is_empty() {
            info!("微信默认路径不存在，启动全盘搜索...");
            if let Some(search_paths) = self.search_wechat_files_on_all_drives() {
                found_base_paths.extend(search_paths);
            }
        }

        // ----------------------------------------------------------------
        // 步骤 4: 扫描找到的所有基础路径
        // ----------------------------------------------------------------
        let is_custom = registry_result.is_some();

        for base_path in found_base_paths {
            info!("发现微信目录: {}", base_path.display());
            self.scan_wechat_base_directory(&base_path, is_custom, &mut paths);
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    /// 扫描微信基础目录，提取所有用户的缓存路径
    fn scan_wechat_base_directory(
        &self,
        base_path: &Path,
        is_custom: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
        let Ok(entries) = std::fs::read_dir(base_path) else {
            return;
        };

        for entry in entries.filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }

            let user_dir = entry.path();
            let user_name = user_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // 跳过系统目录
            if user_name == "All Users" || user_name == "Applet" || user_name.starts_with(".") {
                continue;
            }

            info!("  微信用户: {}", user_name);

            // --------------------------------------------------------
            // 聊天记录数据库 (CRITICAL)
            // 特征：Msg 目录下的 .db 文件
            // 微信数据库结构：
            //   Msg/
            //     MicroMsg.db      - 主消息数据库
            //     MediaMSG*.db     - 媒体消息数据库
            //     Multi/           - 多开消息
            //       MSG*.db
            // --------------------------------------------------------
            let msg_dir = user_dir.join("Msg");
            if msg_dir.exists() {
                paths.push(SocialAppPath {
                    app_name: "微信".to_string(),
                    path: msg_dir.clone(),
                    category: FileCategory::ChatDatabase,
                    is_custom_path: is_custom,
                });

                // Msg\Multi 目录（多开消息）
                let multi_dir = msg_dir.join("Multi");
                if multi_dir.exists() {
                    paths.push(SocialAppPath {
                        app_name: "微信".to_string(),
                        path: multi_dir,
                        category: FileCategory::ChatDatabase,
                        is_custom_path: is_custom,
                    });
                }
            }

            // FileStorage 子目录
            let file_storage = user_dir.join("FileStorage");
            if file_storage.exists() {
                // --------------------------------------------------------
                // 图片视频 (LOW)
                // 特征：Image, Video 目录下的文件
                // 微信加密图片：Image 目录下的 .dat 文件
                // --------------------------------------------------------
                for dir_name in &["Image", "Video"] {
                    let dir = file_storage.join(dir_name);
                    if dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "微信".to_string(),
                            path: dir,
                            category: FileCategory::ImageVideo,
                            is_custom_path: is_custom,
                        });
                    }
                }

                // --------------------------------------------------------
                // 传输文件 (MEDIUM)
                // 特征：File, MsgAttach 目录
                // --------------------------------------------------------
                for dir_name in &["File", "MsgAttach"] {
                    let dir = file_storage.join(dir_name);
                    if dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "微信".to_string(),
                            path: dir,
                            category: FileCategory::FileTransfer,
                            is_custom_path: is_custom,
                        });
                    }
                }

                // --------------------------------------------------------
                // 朋友圈/缓存 (NONE)
                // 特征：Sns, Cache 目录
                // --------------------------------------------------------
                for dir_name in &["Sns", "Cache", "Fav", "CustomEmotion"] {
                    let dir = file_storage.join(dir_name);
                    if dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "微信".to_string(),
                            path: dir,
                            category: if *dir_name == "Sns" {
                                FileCategory::MomentsCache
                            } else {
                                FileCategory::TempCache
                            },
                            is_custom_path: is_custom,
                        });
                    }
                }
            }
        }
    }

    /// 全盘搜索 WeChat Files 文件夹
    /// 当注册表和默认路径都失败时，作为保底方案
    fn search_wechat_files_on_all_drives(&self) -> Option<Vec<PathBuf>> {
        let mut found_paths = Vec::new();

        for drive in &self.available_drives {
            // 搜索根目录下的 WeChat Files
            let root_path = PathBuf::from(drive).join("WeChat Files");
            if root_path.exists() {
                info!("全盘搜索发现: {}", root_path.display());
                found_paths.push(root_path);
                continue;
            }

            // 搜索常见位置
            let common_locations = ["Users", "Data", "Documents", "data"];

            for location in &common_locations {
                let search_base = PathBuf::from(drive).join(location);
                if !search_base.exists() {
                    continue;
                }

                // 只搜索一层深度，避免耗时过长
                if let Ok(entries) = std::fs::read_dir(&search_base) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.is_dir() {
                            // 检查是否是 WeChat Files 目录
                            if path
                                .file_name()
                                .map(|n| n.to_string_lossy().to_lowercase() == "wechat files")
                                .unwrap_or(false)
                            {
                                info!("全盘搜索发现: {}", path.display());
                                found_paths.push(path.clone());
                            }

                            // 检查子目录中是否有 WeChat Files
                            let wechat_in_subdir = path.join("WeChat Files");
                            if wechat_in_subdir.exists() {
                                info!("全盘搜索发现: {}", wechat_in_subdir.display());
                                found_paths.push(wechat_in_subdir);
                            }
                        }
                    }
                }
            }
        }

        if found_paths.is_empty() {
            None
        } else {
            Some(found_paths)
        }
    }

    /// 从注册表读取微信自定义路径
    ///
    /// 注册表路径：HKEY_CURRENT_USER\Software\Tencent\WeChat -> FileSavePath
    ///
    /// 返回值说明：
    /// - `MyDocument:` -> 使用系统文档目录
    /// - 绝对路径（如 `E:\data\xwechat_files`）-> 直接使用
    #[cfg(target_os = "windows")]
    fn read_wechat_registry_path(&self) -> Option<RegistryPathResult> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 尝试读取微信注册表路径
        match hkcu.open_subkey("Software\\Tencent\\WeChat") {
            Ok(wechat_key) => {
                match wechat_key.get_value::<String, _>("FileSavePath") {
                    Ok(path) => {
                        if path.is_empty() {
                            debug!("微信 FileSavePath 为空");
                            return None;
                        }

                        // 检查是否为 MyDocument: 特殊值
                        if path.trim().eq_ignore_ascii_case("MyDocument:") {
                            info!("微信 FileSavePath = MyDocument:");
                            return Some(RegistryPathResult::MyDocument);
                        }

                        // 绝对路径
                        info!("微信 FileSavePath = {}", path);
                        Some(RegistryPathResult::AbsolutePath(path))
                    }
                    Err(e) => {
                        debug!("读取微信 FileSavePath 失败: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                debug!("打开微信注册表键失败: {}", e);
                None
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn read_wechat_registry_path(&self) -> Option<RegistryPathResult> {
        None
    }

    // ========================================================================
    // QQ 路径检测
    // ========================================================================

    /// 检测传统 QQ 路径
    ///
    /// 路径溯源优先级：
    /// 1. 注册表 HKCU\Software\Tencent\QQ\PersonalFolder
    /// 2. 默认文档目录下的 "Tencent Files"
    /// 3. 全盘搜索 "Tencent Files" 文件夹
    fn detect_qq_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();
        let mut found_base_paths: Vec<PathBuf> = Vec::new();

        // 尝试从注册表读取 QQ 自定义路径
        if let Some(registry_path) = self.read_qq_registry_path() {
            info!("QQ 注册表路径: {}", registry_path);
            let path = PathBuf::from(&registry_path);
            if path.exists() {
                found_base_paths.push(path);
            }
        }

        // 默认路径
        if found_base_paths.is_empty() {
            let doc_path = PathBuf::from(format!("{}\\Tencent Files", self.documents_dir));
            if doc_path.exists() {
                found_base_paths.push(doc_path);
            }

            if self.documents_dir != self.default_documents {
                let default_path =
                    PathBuf::from(format!("{}\\Tencent Files", self.default_documents));
                if default_path.exists() && !found_base_paths.contains(&default_path) {
                    found_base_paths.push(default_path);
                }
            }
        }

        // 全盘搜索备选
        if found_base_paths.is_empty() {
            if let Some(search_paths) = self.search_qq_files_on_all_drives() {
                found_base_paths.extend(search_paths);
            }
        }

        for base_path in found_base_paths {
            info!("发现QQ目录: {}", base_path.display());

            if let Ok(entries) = std::fs::read_dir(&base_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }

                    let user_dir = entry.path();
                    let user_name = user_dir
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();

                    // QQ号通常是纯数字，跳过非用户目录
                    if user_name == "All Users" || user_name.starts_with(".") {
                        continue;
                    }

                    info!("  QQ用户: {}", user_name);

                    // 图片视频
                    for dir_name in &["Image", "Video", "Audio"] {
                        let dir = user_dir.join(dir_name);
                        if dir.exists() {
                            paths.push(SocialAppPath {
                                app_name: "QQ".to_string(),
                                path: dir,
                                category: FileCategory::ImageVideo,
                                is_custom_path: false,
                            });
                        }
                    }

                    // 文件接收 (MEDIUM)
                    let file_recv = user_dir.join("FileRecv");
                    if file_recv.exists() {
                        paths.push(SocialAppPath {
                            app_name: "QQ".to_string(),
                            path: file_recv,
                            category: FileCategory::FileTransfer,
                            is_custom_path: false,
                        });
                    }
                }
            }
        }

        // QQ 临时文件
        let qq_temp = PathBuf::from(format!("{}\\Tencent\\QQ\\Temp", self.appdata));
        if qq_temp.exists() {
            paths.push(SocialAppPath {
                app_name: "QQ".to_string(),
                path: qq_temp,
                category: FileCategory::TempCache,
                is_custom_path: false,
            });
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    /// 从注册表读取 QQ 自定义路径
    #[cfg(target_os = "windows")]
    fn read_qq_registry_path(&self) -> Option<String> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 尝试读取 QQ 注册表路径
        if let Ok(qq_key) = hkcu.open_subkey("Software\\Tencent\\QQ") {
            // 尝试 PersonalFolder
            if let Ok(path) = qq_key.get_value::<String, _>("PersonalFolder") {
                if !path.is_empty() && Path::new(&path).exists() {
                    return Some(path);
                }
            }
            // 尝试 Install
            if let Ok(path) = qq_key.get_value::<String, _>("Install") {
                let tencent_files = PathBuf::from(&path)
                    .parent()
                    .map(|p| p.join("Tencent Files"))
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().to_string());
                if tencent_files.is_some() {
                    return tencent_files;
                }
            }
        }

        None
    }

    #[cfg(not(target_os = "windows"))]
    fn read_qq_registry_path(&self) -> Option<String> {
        None
    }

    /// 全盘搜索 Tencent Files 文件夹
    fn search_qq_files_on_all_drives(&self) -> Option<Vec<PathBuf>> {
        let mut found_paths = Vec::new();

        for drive in &self.available_drives {
            // 搜索常见位置
            let common_locations = ["Users", "Documents", "Data"];

            for location in &common_locations {
                let search_base = PathBuf::from(drive).join(location);
                if !search_base.exists() {
                    continue;
                }

                if let Ok(entries) = std::fs::read_dir(&search_base) {
                    for entry in entries.filter_map(|e| e.ok()) {
                        let path = entry.path();
                        if path.is_dir() {
                            // 检查是否是 Tencent Files 目录
                            if path
                                .file_name()
                                .map(|n| n.to_string_lossy().to_lowercase() == "tencent files")
                                .unwrap_or(false)
                            {
                                info!("全盘搜索发现QQ目录: {}", path.display());
                                found_paths.push(path.clone());
                            }

                            // 检查子目录
                            let tencent_in_subdir = path.join("Tencent Files");
                            if tencent_in_subdir.exists() {
                                info!("全盘搜索发现QQ目录: {}", tencent_in_subdir.display());
                                found_paths.push(tencent_in_subdir);
                            }
                        }
                    }
                }
            }
        }

        if found_paths.is_empty() {
            None
        } else {
            Some(found_paths)
        }
    }

    /// 检测 NTQQ (新版QQ) 路径
    ///
    /// NTQQ 数据库结构：
    ///   nt_qq/{用户ID}/
    ///     nt_msg/     - 消息数据库 (CRITICAL)
    ///     nt_db/      - 用户数据库 (CRITICAL)
    ///     nt_data/    - 媒体文件
    ///       Pic/      - 图片
    ///       Video/    - 视频
    ///       File/     - 文件
    fn detect_ntqq_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        // NTQQ 主目录
        let ntqq_base = PathBuf::from(format!("{}\\Tencent\\QQ\\nt_qq", self.local_appdata));

        if ntqq_base.exists() {
            info!("发现NTQQ目录: {}", ntqq_base.display());
            self.scan_ntqq_directory(&ntqq_base, &mut paths);
        }

        // 尝试从注册表读取 NTQQ 自定义路径
        if let Some(registry_path) = self.read_ntqq_registry_path() {
            let custom_base = PathBuf::from(&registry_path);
            if custom_base.exists() && custom_base != ntqq_base {
                info!("发现NTQQ自定义目录: {}", custom_base.display());
                self.scan_ntqq_directory(&custom_base, &mut paths);
            }
        }

        // NTQQ 全局缓存
        let ntqq_cache = PathBuf::from(format!("{}\\Tencent\\QQ\\Cache", self.local_appdata));
        if ntqq_cache.exists() {
            paths.push(SocialAppPath {
                app_name: "NTQQ".to_string(),
                path: ntqq_cache,
                category: FileCategory::TempCache,
                is_custom_path: false,
            });
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    /// 扫描 NTQQ 目录结构
    fn scan_ntqq_directory(&self, base: &Path, paths: &mut Vec<SocialAppPath>) {
        let Ok(entries) = std::fs::read_dir(base) else {
            return;
        };

        for entry in entries.filter_map(|e| e.ok()) {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }

            let sub_dir = entry.path();
            let dir_name = sub_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // 跳过非用户目录
            if dir_name == "global" || dir_name.starts_with(".") {
                continue;
            }

            info!("  NTQQ用户目录: {}", dir_name);

            // nt_data 目录 - 媒体文件
            let nt_data = sub_dir.join("nt_data");
            if nt_data.exists() {
                // 图片视频 (LOW)
                for media_dir in &["Pic", "Video", "Ptt"] {
                    let dir = nt_data.join(media_dir);
                    if dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "NTQQ".to_string(),
                            path: dir,
                            category: FileCategory::ImageVideo,
                            is_custom_path: false,
                        });
                    }
                }

                // 文件 (MEDIUM)
                let file_dir = nt_data.join("File");
                if file_dir.exists() {
                    paths.push(SocialAppPath {
                        app_name: "NTQQ".to_string(),
                        path: file_dir,
                        category: FileCategory::FileTransfer,
                        is_custom_path: false,
                    });
                }
            }

            // --------------------------------------------------------
            // nt_msg 目录（消息数据库）(CRITICAL)
            // 包含 .db 文件：
            //   - nt_msg.db      - 主消息数据库
            //   - nt_msg.db-wal  - WAL 日志
            //   - nt_msg.db-shm  - 共享内存
            // --------------------------------------------------------
            let nt_msg = sub_dir.join("nt_msg");
            if nt_msg.exists() {
                paths.push(SocialAppPath {
                    app_name: "NTQQ".to_string(),
                    path: nt_msg,
                    category: FileCategory::ChatDatabase,
                    is_custom_path: false,
                });
            }

            // nt_db 目录（用户数据库）(CRITICAL)
            let nt_db = sub_dir.join("nt_db");
            if nt_db.exists() {
                paths.push(SocialAppPath {
                    app_name: "NTQQ".to_string(),
                    path: nt_db,
                    category: FileCategory::ChatDatabase,
                    is_custom_path: false,
                });
            }
        }
    }

    /// 从注册表读取 NTQQ 自定义路径
    #[cfg(target_os = "windows")]
    fn read_ntqq_registry_path(&self) -> Option<String> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 尝试读取 NTQQ 注册表路径
        if let Ok(qq_key) = hkcu.open_subkey("Software\\Tencent\\QQNT") {
            if let Ok(path) = qq_key.get_value::<String, _>("PersonalPath") {
                if !path.is_empty() && Path::new(&path).exists() {
                    return Some(path);
                }
            }
        }

        None
    }

    #[cfg(not(target_os = "windows"))]
    fn read_ntqq_registry_path(&self) -> Option<String> {
        None
    }

    // ========================================================================
    // 钉钉路径检测
    // ========================================================================

    /// 检测钉钉路径
    fn detect_dingtalk_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        let dingtalk_base = PathBuf::from(format!("{}\\DingTalk", self.appdata));

        if dingtalk_base.exists() {
            info!("发现钉钉目录: {}", dingtalk_base.display());

            if let Ok(entries) = std::fs::read_dir(&dingtalk_base) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }

                    let sub_dir = entry.path();

                    // 图片视频
                    for dir_name in &["Image", "Video"] {
                        let dir = sub_dir.join(dir_name);
                        if dir.exists() {
                            paths.push(SocialAppPath {
                                app_name: "钉钉".to_string(),
                                path: dir,
                                category: FileCategory::ImageVideo,
                                is_custom_path: false,
                            });
                        }
                    }

                    // 文件
                    let file_dir = sub_dir.join("File");
                    if file_dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "钉钉".to_string(),
                            path: file_dir,
                            category: FileCategory::FileTransfer,
                            is_custom_path: false,
                        });
                    }

                    // 缓存和存储
                    for dir_name in &["Cache", "storage", "cache"] {
                        let dir = sub_dir.join(dir_name);
                        if dir.exists() {
                            paths.push(SocialAppPath {
                                app_name: "钉钉".to_string(),
                                path: dir,
                                category: FileCategory::TempCache,
                                is_custom_path: false,
                            });
                        }
                    }

                    // --------------------------------------------------------
                    // 钉钉数据库 (CRITICAL)
                    // 特征：Database 目录
                    // --------------------------------------------------------
                    let db_dir = sub_dir.join("Database");
                    if db_dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "钉钉".to_string(),
                            path: db_dir,
                            category: FileCategory::ChatDatabase,
                            is_custom_path: false,
                        });
                    }
                }
            }
        }

        // 钉钉文档目录
        let dingtalk_docs = PathBuf::from(format!("{}\\DingTalk", self.documents_dir));
        if dingtalk_docs.exists() {
            paths.push(SocialAppPath {
                app_name: "钉钉".to_string(),
                path: dingtalk_docs,
                category: FileCategory::FileTransfer,
                is_custom_path: false,
            });
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    // ========================================================================
    // 飞书路径检测
    // ========================================================================

    /// 检测飞书路径
    fn detect_feishu_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        // 飞书主目录
        let feishu_base = PathBuf::from(format!("{}\\feishu", self.appdata));
        if feishu_base.exists() {
            info!("发现飞书目录: {}", feishu_base.display());
            self.scan_feishu_directory(&feishu_base, "飞书", &mut paths);
        }

        // LarkShell 目录（飞书新版）
        let larkshell_base = PathBuf::from(format!("{}\\LarkShell", self.appdata));
        if larkshell_base.exists() {
            info!("发现LarkShell目录: {}", larkshell_base.display());

            // sdk_storage 目录
            let sdk_storage = larkshell_base.join("sdk_storage");
            if sdk_storage.exists() {
                paths.push(SocialAppPath {
                    app_name: "飞书".to_string(),
                    path: sdk_storage,
                    category: FileCategory::TempCache,
                    is_custom_path: false,
                });
            }

            // file_storage 目录
            let file_storage = larkshell_base.join("file_storage");
            if file_storage.exists() {
                paths.push(SocialAppPath {
                    app_name: "飞书".to_string(),
                    path: file_storage,
                    category: FileCategory::FileTransfer,
                    is_custom_path: false,
                });
            }
        }

        // Lark (国际版飞书)
        let lark_base = PathBuf::from(format!("{}\\Lark", self.appdata));
        if lark_base.exists() {
            info!("发现Lark目录: {}", lark_base.display());
            self.scan_feishu_directory(&lark_base, "Lark", &mut paths);
        }

        // 飞书文档目录
        let feishu_docs = PathBuf::from(format!("{}\\Feishu", self.documents_dir));
        if feishu_docs.exists() {
            paths.push(SocialAppPath {
                app_name: "飞书".to_string(),
                path: feishu_docs,
                category: FileCategory::FileTransfer,
                is_custom_path: false,
            });
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    /// 扫描飞书目录结构
    fn scan_feishu_directory(&self, base: &Path, app_name: &str, paths: &mut Vec<SocialAppPath>) {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.filter_map(|e| e.ok()) {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }

                let sub_dir = entry.path();

                // 图片
                let image_dir = sub_dir.join("Image");
                if image_dir.exists() {
                    paths.push(SocialAppPath {
                        app_name: app_name.to_string(),
                        path: image_dir,
                        category: FileCategory::ImageVideo,
                        is_custom_path: false,
                    });
                }

                // 文件
                let file_dir = sub_dir.join("File");
                if file_dir.exists() {
                    paths.push(SocialAppPath {
                        app_name: app_name.to_string(),
                        path: file_dir,
                        category: FileCategory::FileTransfer,
                        is_custom_path: false,
                    });
                }

                // 缓存
                let cache_dir = sub_dir.join("Cache");
                if cache_dir.exists() {
                    paths.push(SocialAppPath {
                        app_name: app_name.to_string(),
                        path: cache_dir,
                        category: FileCategory::TempCache,
                        is_custom_path: false,
                    });
                }

                // sdk_storage
                let sdk_storage = sub_dir.join("sdk_storage");
                if sdk_storage.exists() {
                    paths.push(SocialAppPath {
                        app_name: app_name.to_string(),
                        path: sdk_storage,
                        category: FileCategory::TempCache,
                        is_custom_path: false,
                    });
                }

                // file_storage
                let file_storage = sub_dir.join("file_storage");
                if file_storage.exists() {
                    paths.push(SocialAppPath {
                        app_name: app_name.to_string(),
                        path: file_storage,
                        category: FileCategory::FileTransfer,
                        is_custom_path: false,
                    });
                }
            }
        }
    }

    // ========================================================================
    // 企业微信路径检测
    // ========================================================================

    /// 检测企业微信路径
    fn detect_wxwork_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        let base_paths = vec![
            PathBuf::from(format!("{}\\WXWork", self.documents_dir)),
            PathBuf::from(format!("{}\\WXWork", self.default_documents)),
        ];

        for base_path in base_paths {
            if !base_path.exists() {
                continue;
            }

            info!("发现企业微信目录: {}", base_path.display());

            if let Ok(entries) = std::fs::read_dir(&base_path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }

                    let user_dir = entry.path();
                    let cache_dir = user_dir.join("Cache");

                    if cache_dir.exists() {
                        // 图片视频
                        for dir_name in &["Image", "Video"] {
                            let dir = cache_dir.join(dir_name);
                            if dir.exists() {
                                paths.push(SocialAppPath {
                                    app_name: "企业微信".to_string(),
                                    path: dir,
                                    category: FileCategory::ImageVideo,
                                    is_custom_path: false,
                                });
                            }
                        }

                        // 文件
                        let file_dir = cache_dir.join("File");
                        if file_dir.exists() {
                            paths.push(SocialAppPath {
                                app_name: "企业微信".to_string(),
                                path: file_dir,
                                category: FileCategory::FileTransfer,
                                is_custom_path: false,
                            });
                        }
                    }

                    // 消息数据库
                    let msg_dir = user_dir.join("Msg");
                    if msg_dir.exists() {
                        paths.push(SocialAppPath {
                            app_name: "企业微信".to_string(),
                            path: msg_dir,
                            category: FileCategory::ChatDatabase,
                            is_custom_path: false,
                        });
                    }
                }
            }
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    // ========================================================================
    // Telegram 路径检测
    // ========================================================================

    /// 检测 Telegram 路径
    fn detect_telegram_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        let telegram_base = PathBuf::from(format!("{}\\Telegram Desktop", self.appdata));

        if telegram_base.exists() {
            info!("发现Telegram目录: {}", telegram_base.display());

            // tdata 目录（用户数据，包含消息数据库）
            let tdata = telegram_base.join("tdata");
            if tdata.exists() {
                // 检查是否有数据库文件
                let has_db = std::fs::read_dir(&tdata)
                    .map(|entries| {
                        entries.filter_map(|e| e.ok()).any(|e| {
                            let name = e.file_name().to_string_lossy().to_lowercase();
                            name.ends_with(".db") || name.contains("cache")
                        })
                    })
                    .unwrap_or(false);

                if has_db {
                    paths.push(SocialAppPath {
                        app_name: "Telegram".to_string(),
                        path: tdata.clone(),
                        category: FileCategory::ChatDatabase,
                        is_custom_path: false,
                    });
                }

                // user_data 目录
                let user_data = tdata.join("user_data");
                if user_data.exists() {
                    paths.push(SocialAppPath {
                        app_name: "Telegram".to_string(),
                        path: user_data,
                        category: FileCategory::TempCache,
                        is_custom_path: false,
                    });
                }
            }
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    // ========================================================================
    // 文件扫描与分类
    // ========================================================================

    /// 扫描并分类文件
    fn scan_and_classify(&self, app_paths: &[SocialAppPath]) -> Vec<SocialCategoryStats> {
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
                    id: format!("{:?}", cat).to_lowercase(),
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

        // 扫描每个路径
        for app_path in app_paths {
            if !app_path.path.exists() {
                continue;
            }

            self.scan_directory(
                &app_path.path,
                &app_path.app_name,
                app_path.category,
                &mut category_map,
            );
        }

        // 转换为 Vec 并排序
        let mut categories: Vec<SocialCategoryStats> = category_map.into_values().collect();

        // 按风险等级排序：Critical > Medium > Low > None
        categories.sort_by(|a, b| {
            let risk_a = self.category_to_risk(&a.id);
            let risk_b = self.category_to_risk(&b.id);
            risk_b.cmp(&risk_a)
        });

        categories
    }

    /// 扫描目录并添加到分类
    fn scan_directory(
        &self,
        path: &Path,
        app_name: &str,
        base_category: FileCategory,
        category_map: &mut HashMap<FileCategory, SocialCategoryStats>,
    ) {
        for entry in WalkDir::new(path)
            .follow_links(false)
            .max_depth(10)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            if let Ok(metadata) = entry.metadata() {
                let file_path = entry.path();
                let size = metadata.len();

                // 根据文件特征确定分类和风险等级
                let (category, risk_level) = self.classify_file(file_path, base_category);
                let deletable = risk_level.is_deletable();

                let file_entry = SocialFileEntry {
                    path: file_path.to_string_lossy().to_string(),
                    size,
                    app_name: app_name.to_string(),
                    category,
                    risk_level,
                    deletable,
                };

                if let Some(stats) = category_map.get_mut(&category) {
                    stats.file_count += 1;
                    stats.total_size += size;

                    if deletable {
                        stats.deletable_count += 1;
                        stats.deletable_size += size;
                    }

                    stats.files.push(file_entry);
                }
            }
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

        // 检查是否在数据库关键目录中
        let in_critical_dir = critical_path_patterns
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
        // 规则 2: 临时缓存 (NONE) - 优先于图片视频判断
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

        if is_cache_dir || base_category == FileCategory::TempCache {
            return (FileCategory::TempCache, RiskLevel::None);
        }

        // ================================================================
        // 规则 3: 图片视频 (LOW)
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
        // 规则 4: 朋友圈/动态缓存 (NONE)
        // ================================================================

        let moments_path_patterns = [
            "\\sns\\",
            "/sns/",
            "\\moments\\",
            "/moments/",
            "\\fav\\",
            "/fav/",
        ];

        let is_moments_dir = moments_path_patterns
            .iter()
            .any(|pattern| path_str.contains(pattern));

        if is_moments_dir || base_category == FileCategory::MomentsCache {
            return (FileCategory::MomentsCache, RiskLevel::None);
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
}
