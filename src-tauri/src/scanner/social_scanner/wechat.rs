// ============================================================================
// 社交软件路径适配器
// ============================================================================
//
// 每个适配器只负责发现软件数据目录，实际遍历和分类由 core.rs 统一处理。
// 这样可以在增强单个软件路径时避免复制扫描、去重和风险分级逻辑。
// ============================================================================

use super::core::{FileCategory, RegistryPathResult, SocialAppPath, SocialScanner};
use log::{debug, info};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 微信数据根目录名：旧版 3.x 用 "WeChat Files"，新版 4.x 改用 "xwechat_files"。
/// 只按旧名字搜索会直接漏掉新版客户端，这是"扫不到微信"投诉的主要来源。
const WECHAT_DATA_DIR_NAMES: [&str; 2] = ["WeChat Files", "xwechat_files"];
/// 已按账户名精确搜索过数据目录的盘符，避免重复枚举。
fn visited_roots(visited: &HashSet<String>, root: &Path) -> bool {
    visited.contains(&SocialScanner::normalize_path_key(root))
}

/// 微信账号目录的结构版本：新旧客户端的目录布局完全不同，需要分别解析。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WechatAccountKind {
    /// 旧版 3.x：Msg + FileStorage
    Legacy,
    /// 新版 4.x：db_storage + msg
    V4,
}

impl SocialScanner {
    // 微信路径检测
    // ========================================================================

    /// 检测微信路径
    ///
    /// 路径溯源优先级：
    /// 1. 注册表自定义路径
    ///    - 旧版 3.x：HKCU\Software\Tencent\WeChat\FileSavePath
    ///    - 新版 4.x：HKCU\Software\Tencent\Weixin（FileSavePath / InstallPath 同级目录）
    ///    - 值为 "MyDocument:" 时使用系统文档目录
    /// 2. 文档目录下的 "WeChat Files" / "xwechat_files"
    /// 3. 各盘常见目录浅层搜索（含盘符根目录），作为保底方案
    pub(super) fn detect_wechat_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();
        let mut found_base_paths: Vec<PathBuf> = Vec::new();

        // ----------------------------------------------------------------
        // 步骤 1: 从注册表读取微信自定义路径
        // ----------------------------------------------------------------
        let registry_result = self.read_wechat_registry_path();

        match &registry_result {
            Some(RegistryPathResult::AbsolutePath(abs_path)) => {
                // 新版微信和多开版本可能把注册表直接写成账号目录，不能强制再拼接一层。
                info!("微信注册表路径(绝对): {}", abs_path);
                let path = PathBuf::from(abs_path);
                self.add_wechat_path_candidates(&path, &mut found_base_paths);
            }
            Some(RegistryPathResult::MyDocument) => {
                // 注册表返回 MyDocument:，使用文档目录
                info!("微信注册表路径: MyDocument: -> {}", self.documents_dir);
                for dir_name in WECHAT_DATA_DIR_NAMES {
                    Self::add_candidate(
                        &mut found_base_paths,
                        PathBuf::from(format!("{}\\{}", self.documents_dir, dir_name)),
                    );
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
            for dir_name in WECHAT_DATA_DIR_NAMES {
                // 尝试文档目录
                Self::add_candidate(
                    &mut found_base_paths,
                    PathBuf::from(format!("{}\\{}", self.documents_dir, dir_name)),
                );

                // 尝试默认文档目录（如果不同）
                if self.documents_dir != self.default_documents {
                    Self::add_candidate(
                        &mut found_base_paths,
                        PathBuf::from(format!("{}\\{}", self.default_documents, dir_name)),
                    );
                }
            }
        }

        // ----------------------------------------------------------------
        // 步骤 3: 全盘搜索备选（如果上述路径都不存在）
        // ----------------------------------------------------------------
        if found_base_paths.is_empty() {
            info!("微信默认路径不存在，启动全盘搜索...");
            if let Some(search_paths) = self.search_wechat_files_on_all_drives() {
                for path in search_paths {
                    Self::add_candidate(&mut found_base_paths, path);
                }
            }
        }

        // ----------------------------------------------------------------
        // 步骤 4: 扫描找到的所有基础路径
        // ----------------------------------------------------------------
        let is_custom = registry_result.is_some();

        for base_path in found_base_paths {
            info!("发现微信目录: {}", base_path.display());
            if Self::looks_like_wechat4_account(&base_path) {
                // 注册表/搜索可能直接指向新版账号目录
                self.scan_wechat4_account_directory(&base_path, is_custom, &mut paths);
            } else {
                self.scan_wechat_base_directory(&base_path, is_custom, &mut paths);
            }
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    /// 将微信根目录、账号目录和多开目录统一归一为“可扫描账号根”。
    fn add_wechat_path_candidates(&self, path: &Path, candidates: &mut Vec<PathBuf>) {
        if !path.is_dir() {
            return;
        }

        if Self::looks_like_wechat_account(path) || Self::looks_like_wechat4_account(path) {
            Self::add_candidate(candidates, path.to_path_buf());
            return;
        }

        // 旧版数据目录固定叫 WeChat Files；新版 4.x 数据目录本身叫 xwechat_files，
        // 再拼一层会找不到，因此先判自身是否就是数据目录。
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(Self::is_wechat_data_dir_name)
        {
            Self::add_candidate(candidates, path.to_path_buf());
            return;
        }

        for data_dir_name in WECHAT_DATA_DIR_NAMES {
            let nested_root = path.join(data_dir_name);
            if nested_root.is_dir() {
                Self::add_candidate(candidates, nested_root);
                return;
            }
        }

        // 根目录通常包含多个数字账号目录，保留根目录让后续函数统一枚举。
        Self::add_candidate(candidates, path.to_path_buf());
    }

    /// 是否为微信数据根目录名（不区分大小写）。
    fn is_wechat_data_dir_name(name: &str) -> bool {
        WECHAT_DATA_DIR_NAMES
            .iter()
            .any(|candidate| name.eq_ignore_ascii_case(candidate))
    }

    /// 判断路径是否已经是微信账号目录，避免把账号目录误当作账号集合目录。
    ///
    /// 只用旧版 3.x 的权威特征，且区分大小写：
    /// 4.x 账号里的 `msg` / `file` 等小写目录若被当成 3.x 特征，
    /// 会把新版账号路由到旧版解析逻辑，导致整块数据漏扫。
    pub(super) fn looks_like_wechat_account(path: &Path) -> bool {
        ["Msg", "FileStorage", "MicroMsg", "Image"]
            .iter()
            .any(|name| path.join(name).exists())
    }

    /// 微信账号目录结构版本。
    fn wechat_account_kind(path: &Path) -> Option<WechatAccountKind> {
        // 先判新版：db_storage 只存在于 4.x，是区分两代结构最可靠的标记。
        // 注意必须逐个比较目录名而不是用 path.join(name).is_dir()：
        // Windows 文件系统不区分大小写，"msg" 会命中旧版的 "Msg"，把 3.x 账号误判为 4.x。
        if Self::contains_exact_directory(path, &["db_storage", "msg"]) {
            return Some(WechatAccountKind::V4);
        }

        if Self::looks_like_wechat_account(path) {
            return Some(WechatAccountKind::Legacy);
        }

        None
    }

    /// 判断目录下是否存在名字完全匹配（区分大小写）的子目录。
    fn contains_exact_directory(path: &Path, names: &[&str]) -> bool {
        let Ok(entries) = std::fs::read_dir(path) else {
            return false;
        };

        entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .any(|entry| {
                let entry_name = entry.file_name();
                let Some(entry_name) = entry_name.to_str() else {
                    return false;
                };
                names.iter().any(|name| entry_name == *name)
            })
    }

    /// 新版微信 4.x 账号目录特征：数据库在 db_storage，消息与媒体在 msg。
    pub(super) fn looks_like_wechat4_account(path: &Path) -> bool {
        matches!(
            Self::wechat_account_kind(path),
            Some(WechatAccountKind::V4)
        )
    }

    /// 判断子目录是否为可扫描的微信账号目录，过滤新建与迁移过程中的空目录。
    fn is_wechat_account_dir(path: &Path) -> bool {
        if Self::wechat_account_kind(path).is_some() {
            return true;
        }

        // 账号特征不明确时，退回按目录名判断，兼容尚未产生数据的账号目录
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .starts_with("wxid_")
    }

    /// 扫描新版微信 4.x 的单个账号目录。
    ///
    /// 目录结构与 3.x 完全不同：聊天数据库从 Msg 迁移到 db_storage，
    /// 图片/视频/文件统一收到 msg 下，另外多了 cache / business / temp 等缓存目录。
    fn scan_wechat4_account_directory(
        &self,
        account_dir: &Path,
        is_custom: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
        // 聊天记录数据库 (CRITICAL)
        let db_storage = account_dir.join("db_storage");
        if db_storage.is_dir() {
            Self::add_scan_path(
                paths,
                "微信",
                db_storage,
                FileCategory::ChatDatabase,
                is_custom,
            );
        }

        // 消息目录：file / attach 是收到的文件，video 是视频，migrate 是迁移中间数据
        self.add_named_subdirectories(
            &account_dir.join("msg"),
            &["file", "attach"],
            "微信",
            FileCategory::FileTransfer,
            is_custom,
            paths,
        );
        self.add_named_subdirectories(
            &account_dir.join("msg"),
            &["video"],
            "微信",
            FileCategory::ImageVideo,
            is_custom,
            paths,
        );
        self.add_named_subdirectories(
            &account_dir.join("msg"),
            &["migrate"],
            "微信",
            FileCategory::TempCache,
            is_custom,
            paths,
        );

        // 临时缓存 (NONE)
        self.add_named_subdirectories(
            account_dir,
            &["cache", "temp", "apm_record", "resource"],
            "微信",
            FileCategory::TempCache,
            is_custom,
            paths,
        );

        // 小程序、收藏、表情等业务缓存 (NONE)
        self.add_named_subdirectories(
            &account_dir.join("business"),
            &["emoticon", "favorite", "xweb", "xeditor", "InputTemp", "migrate"],
            "微信",
            FileCategory::TempCache,
            is_custom,
            paths,
        );

        // 朋友圈缓存 (NONE)
        self.add_named_subdirectories(
            &account_dir.join("business"),
            &["sns"],
            "微信",
            FileCategory::MomentsCache,
            is_custom,
            paths,
        );
    }

    /// 扫描微信基础目录，提取所有用户的缓存路径
    fn scan_wechat_base_directory(
        &self,
        base_path: &Path,
        is_custom: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
        if Self::looks_like_wechat4_account(base_path) {
            self.scan_wechat4_account_directory(base_path, is_custom, paths);
            return;
        }

        if Self::looks_like_wechat_account(base_path) {
            self.scan_wechat_account_directory(base_path, is_custom, paths);
            return;
        }

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

            // 跳过系统目录与备份目录：备份属于用户的主动备份，不应混进"缓存清理"里
            if Self::is_wechat_non_account_dir(&user_name) {
                continue;
            }

            // 3.x 与 4.x 的账号目录结构不同，按特征分派到对应的解析函数
            match Self::wechat_account_kind(&user_dir) {
                Some(WechatAccountKind::V4) => {
                    info!("  微信4.x用户: {}", user_name);
                    self.scan_wechat4_account_directory(&user_dir, is_custom, paths);
                }
                Some(WechatAccountKind::Legacy) => {
                    info!("  微信用户: {}", user_name);
                    self.scan_wechat_account_directory(&user_dir, is_custom, paths);
                }
                None => {
                    // 目录名像账号但还没有任何数据，无需扫描
                }
            }
        }
    }

    /// 微信数据根目录下的非账号目录：系统共享目录与备份目录。
    fn is_wechat_non_account_dir(dir_name: &str) -> bool {
        ["all_users", "backup", "applet", "wmpf", "all users"]
            .iter()
            .any(|name| dir_name.eq_ignore_ascii_case(name))
            || dir_name.starts_with('.')
    }

    /// 扫描单个微信账号目录，兼容旧版、新版和多开目录。
    fn scan_wechat_account_directory(
        &self,
        user_dir: &Path,
        is_custom: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
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
            Self::add_scan_path(
                paths,
                "微信",
                msg_dir.clone(),
                FileCategory::ChatDatabase,
                is_custom,
            );

            // Msg\Multi 目录（多开消息）
            let multi_dir = msg_dir.join("Multi");
            if multi_dir.exists() {
                Self::add_scan_path(
                    paths,
                    "微信",
                    multi_dir,
                    FileCategory::ChatDatabase,
                    is_custom,
                );
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
                    Self::add_scan_path(paths, "微信", dir, FileCategory::ImageVideo, is_custom);
                }
            }

            // --------------------------------------------------------
            // 传输文件 (MEDIUM)
            // 特征：File, MsgAttach 目录
            // --------------------------------------------------------
            for dir_name in &["File", "MsgAttach"] {
                let dir = file_storage.join(dir_name);
                if dir.exists() {
                    Self::add_scan_path(paths, "微信", dir, FileCategory::FileTransfer, is_custom);
                }
            }

            // --------------------------------------------------------
            // 朋友圈/缓存 (NONE)
            // 特征：Sns 是动态缓存，其余多为运行缓存、缩略图和小程序缓存。
            // --------------------------------------------------------
            for dir_name in &[
                "Sns",
                "Cache",
                "Temp",
                "General",
                "Thumb",
                "Web",
                "VideoCache",
                "Fav",
                "CustomEmotion",
            ] {
                let dir = file_storage.join(dir_name);
                if dir.exists() {
                    Self::add_scan_path(
                        paths,
                        "微信",
                        dir,
                        if *dir_name == "Sns" {
                            FileCategory::MomentsCache
                        } else {
                            FileCategory::TempCache
                        },
                        is_custom,
                    );
                }
            }
        }

        // 新版微信会把 WebView、小程序和部分临时缓存放在账号根目录，单靠 FileStorage 会漏掉。
        for dir_name in &[
            "Sns",
            "Moments",
            "Cache",
            "Temp",
            "Logs",
            "log",
            "WebView",
            "WMPF",
            "Applet",
            "WeChatAppEx",
        ] {
            let dir = user_dir.join(dir_name);
            if dir.exists() {
                Self::add_scan_path(
                    paths,
                    "微信",
                    dir,
                    if *dir_name == "Sns" || *dir_name == "Moments" {
                        FileCategory::MomentsCache
                    } else {
                        FileCategory::TempCache
                    },
                    is_custom,
                );
            }
        }
    }

    /// 全盘搜索微信数据目录（旧版 WeChat Files 与新版 xwechat_files）
    /// 当注册表和默认路径都失败时，作为保底方案
    pub(super) fn search_wechat_files_on_all_drives(&self) -> Option<Vec<PathBuf>> {
        let mut found_paths = Vec::new();
        // 记录已枚举过内容的目录：新版按名字全递归查一遍后，就不必再枚举它的子目录
        let mut enumerated_roots: HashSet<String> = HashSet::new();

        // 常见存放位置（含盘符根目录，覆盖把数据直接放在 D:\、E:\ 这类情况）。
        // 这里刻意不把整个盘符根目录当作深搜起点：在 C:\ 上按名字下钻会走进 Windows 等系统目录，
        // 既慢又无意义；自定义数据目录基本都是"盘符根 → 一个用户自建目录 → 微信数据目录"的结构。
        let common_locations = ["", "Users", "Data", "Documents", "data", "software", "Programs", "downloads"];

        for drive in &self.available_drives {
            for location in &common_locations {
                let search_base = if location.is_empty() {
                    PathBuf::from(drive)
                } else {
                    PathBuf::from(drive).join(location)
                };
                if !search_base.is_dir() {
                    continue;
                }

                // 只搜索一层深度，避免耗时过长
                let Ok(entries) = std::fs::read_dir(&search_base) else {
                    continue;
                };

                for entry in entries.filter_map(|e| e.ok()) {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }

                    // 前提一：目录本身就叫 WeChat Files / xwechat_files
                    if path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(Self::is_wechat_data_dir_name)
                    {
                        info!("全盘搜索发现: {}", path.display());
                        found_paths.push(path);
                        continue;
                    }

                    // 前提二：目录内部（含深层）存在微信数据目录名。
                    // 盘符根目录只做"前提一"的直接命中判断，不在这里下钻，避免扫进系统目录。
                    if location.is_empty() {
                        continue;
                    }
                    if visited_roots(&enumerated_roots, &path) {
                        continue;
                    }
                    enumerated_roots.insert(SocialScanner::normalize_path_key(&path));
                    for data_dir_name in WECHAT_DATA_DIR_NAMES {
                        if let Some(found) = Self::find_directory_by_name(&path, data_dir_name, 5) {
                            info!("全盘搜索发现: {}", found.display());
                            found_paths.push(found);
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

    /// 在指定目录内按名字查找子目录，限制递归深度与检查数量以控制耗时。
    pub(super) fn find_directory_by_name(base: &Path, name: &str, max_depth: usize) -> Option<PathBuf> {
        let mut checked = 0usize;
        for entry in walkdir::WalkDir::new(base)
            .follow_links(false)
            .max_depth(max_depth)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_dir())
        {
            checked += 1;
            // 目录索引本身也有成本，限定检查数量防止在超大目录里长时间停留
            if checked > 20_000 {
                debug!("目录检查数量超限，停止在 {} 内查找 {}", base.display(), name);
                break;
            }

            if entry
                .file_name()
                .to_str()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
            {
                return Some(entry.path().to_path_buf());
            }
        }

        None
    }

    /// 从注册表读取微信自定义路径
    ///
    /// 注册表路径：
    /// - 旧版 3.x：HKEY_CURRENT_USER\Software\Tencent\WeChat -> FileSavePath
    /// - 新版 4.x：HKEY_CURRENT_USER\Software\Tencent\Weixin  -> FileSavePath
    ///
    /// 返回值说明：
    /// - `MyDocument:` -> 使用系统文档目录
    /// - 绝对路径（如 `E:\data\xwechat_files`）-> 直接使用
    #[cfg(target_os = "windows")]
    pub(super) fn read_wechat_registry_path(&self) -> Option<RegistryPathResult> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 新版 4.x 客户端注册在 Weixin 下，旧版注册在 WeChat 下；优先读新版
        for key_path in ["Software\\Tencent\\Weixin", "Software\\Tencent\\WeChat"] {
            let Ok(wechat_key) = hkcu.open_subkey(key_path) else {
                debug!("打开微信注册表键失败: {}", key_path);
                continue;
            };

            match wechat_key.get_value::<String, _>("FileSavePath") {
                Ok(path) => {
                    if path.is_empty() {
                        debug!("微信 FileSavePath 为空: {}", key_path);
                        continue;
                    }

                    // 检查是否为 MyDocument: 特殊值
                    if path.trim().eq_ignore_ascii_case("MyDocument:") {
                        info!("微信 FileSavePath = MyDocument: ({})", key_path);
                        return Some(RegistryPathResult::MyDocument);
                    }

                    // 绝对路径
                    info!("微信 FileSavePath = {} ({})", path, key_path);
                    return Some(RegistryPathResult::AbsolutePath(path));
                }
                Err(e) => {
                    debug!("读取微信 FileSavePath 失败({}): {}", key_path, e);
                }
            }

            // 新版客户端不一定写 FileSavePath，退回用安装目录推断数据目录：
            // 自定义数据目录常放在安装目录同级，例如 D:\software\wechat\Weixin + D:\software\wechat\xwechat_files
            if let Ok(install_path) = wechat_key.get_value::<String, _>("InstallPath") {
                if let Some(data_root) = Self::wechat_data_root_near_install(&install_path) {
                    info!("微信安装目录推断数据目录: {}", data_root.display());
                    return Some(RegistryPathResult::AbsolutePath(
                        data_root.to_string_lossy().to_string(),
                    ));
                }
            }
        }

        None
    }

    /// 从安装目录推断数据目录：先看安装目录本身，再看同级目录。
    ///
    /// 新版微信把程序放在 `...\Weixin`，数据放在 `...\xwechat_files`（同级），
    /// 仅靠注册表里的 FileSavePath 在部分机器上是读不到的。
    /// 候选顺序固定为"旧的 WeChat Files 优先"，保证新旧客户端并存时行为与升级前一致。
    #[cfg(target_os = "windows")]
    pub(super) fn wechat_data_root_near_install(install_path: &str) -> Option<PathBuf> {
        let install_dir = Path::new(install_path);
        if !install_dir.is_dir() {
            return None;
        }

        let mut bases = vec![install_dir.to_path_buf()];
        if let Some(parent) = install_dir.parent() {
            bases.push(parent.to_path_buf());
        }

        for base in bases {
            for data_dir_name in WECHAT_DATA_DIR_NAMES {
                let candidate = base.join(data_dir_name);
                if candidate.is_dir() {
                    return Some(candidate);
                }
            }
        }

        None
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn read_wechat_registry_path(&self) -> Option<RegistryPathResult> {
        None
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
            "lightc-wechat-{}-{}-{}",
            name,
            std::process::id(),
            sequence
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn detects_new_wechat_data_directory_name() {
        // 新版 4.x 的数据目录叫 xwechat_files，不应被当成"父目录"再拼一层
        assert!(SocialScanner::is_wechat_data_dir_name("xwechat_files"));
        assert!(SocialScanner::is_wechat_data_dir_name("WeChat Files"));
        assert!(SocialScanner::is_wechat_data_dir_name("XWECHAT_FILES"));
        assert!(!SocialScanner::is_wechat_data_dir_name("WeChat"));
    }

    #[test]
    fn recognizes_wechat4_account_by_structure() {
        let root = fixture("v4-account");
        let account = root.join("wxid_abc123_4f4c");
        std::fs::create_dir_all(account.join("db_storage")).unwrap();
        std::fs::create_dir_all(account.join("msg/attach")).unwrap();
        // 旧版账号目录不应被判成 4.x
        let legacy = root.join("wxid_legacy");
        std::fs::create_dir_all(legacy.join("Msg")).unwrap();
        std::fs::create_dir_all(legacy.join("FileStorage/Image")).unwrap();

        assert!(SocialScanner::looks_like_wechat4_account(&account));
        // 旧版账号目录不应被判成 4.x
        {
            let dump = format!(
                "account={}\naccount_kind={:?}\nlegacy={}\nlegacy_kind={:?}\nlegacy_db_storage_exists={}\nlegacy_msg_exists={}\nlegacy_children={:?}\n",
                account.display(),
                SocialScanner::wechat_account_kind(&account),
                legacy.display(),
                SocialScanner::wechat_account_kind(&legacy),
                legacy.join("db_storage").exists(),
                legacy.join("msg").exists(),
                std::fs::read_dir(&legacy)
                    .map(|e| e.filter_map(|x| x.ok()).map(|x| x.file_name().to_string_lossy().to_string()).collect::<Vec<_>>())
                    .unwrap_or_default()
            );
            std::fs::write(std::env::temp_dir().join("lightc-wechat-debug.txt"), dump).unwrap();
        }
        assert!(!SocialScanner::looks_like_wechat4_account(&legacy));
        assert!(SocialScanner::looks_like_wechat_account(&legacy));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_wechat4_account_directories() {
        let root = fixture("v4-scan");
        let account = root.join("wxid_abc123_4f4c");
        std::fs::create_dir_all(account.join("db_storage")).unwrap();
        std::fs::create_dir_all(account.join("msg/file")).unwrap();
        std::fs::create_dir_all(account.join("msg/video")).unwrap();
        std::fs::create_dir_all(account.join("cache")).unwrap();
        std::fs::create_dir_all(account.join("business/sns")).unwrap();
        // 备份目录不应被当成账号目录扫描
        std::fs::create_dir_all(root.join("Backup/wxid_abc123")).unwrap();

        let scanner = SocialScanner::new();
        let mut paths = Vec::new();
        scanner.scan_wechat_base_directory(&root, false, &mut paths);

        let found = |name: &str, category: FileCategory| {
            paths
                .iter()
                .any(|p| p.path.ends_with(name) && p.category == category)
        };

        assert!(found("db_storage", FileCategory::ChatDatabase));
        assert!(found("file", FileCategory::FileTransfer));
        assert!(found("video", FileCategory::ImageVideo));
        assert!(found("cache", FileCategory::TempCache));
        assert!(found("sns", FileCategory::MomentsCache));
        assert!(!paths.iter().any(|p| p.path.to_string_lossy().contains("Backup")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_nested_data_directory_by_name() {
        let root = fixture("nested");
        let target = root.join("wechat");
        std::fs::create_dir_all(target.join("xwechat_files")).unwrap();

        let found = SocialScanner::find_directory_by_name(&root, "WeChat Files", 4);
        assert!(found.is_none(), "不应把 xwechat_files 匹配成 WeChat Files");

        let found = SocialScanner::find_directory_by_name(&root, "xwechat_files", 4);
        assert_eq!(found, Some(target.join("xwechat_files")));

        let _ = std::fs::remove_dir_all(&root);
    }
}

// ========================================================================
