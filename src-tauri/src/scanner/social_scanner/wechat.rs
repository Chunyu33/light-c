// ============================================================================
// 社交软件路径适配器
// ============================================================================
//
// 每个适配器只负责发现软件数据目录，实际遍历和分类由 core.rs 统一处理。
// 这样可以在增强单个软件路径时避免复制扫描、去重和风险分级逻辑。
// ============================================================================

use super::core::{FileCategory, RegistryPathResult, SocialAppPath, SocialScanner};
use log::{debug, info};
use std::path::{Path, PathBuf};

impl SocialScanner {
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
                let path = PathBuf::from(format!("{}\\WeChat Files", self.documents_dir));
                Self::add_candidate(&mut found_base_paths, path);
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
            Self::add_candidate(&mut found_base_paths, doc_path);

            // 尝试默认文档目录（如果不同）
            if self.documents_dir != self.default_documents {
                let default_path =
                    PathBuf::from(format!("{}\\WeChat Files", self.default_documents));
                Self::add_candidate(&mut found_base_paths, default_path);
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
            self.scan_wechat_base_directory(&base_path, is_custom, &mut paths);
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

        if Self::looks_like_wechat_account(path) {
            Self::add_candidate(candidates, path.to_path_buf());
            return;
        }

        let nested_root = path.join("WeChat Files");
        if nested_root.is_dir() {
            Self::add_candidate(candidates, nested_root);
            return;
        }

        // 根目录通常包含多个数字账号目录，保留根目录让后续函数统一枚举。
        Self::add_candidate(candidates, path.to_path_buf());
    }

    /// 判断路径是否已经是微信账号目录，避免把账号目录误当作账号集合目录。
    fn looks_like_wechat_account(path: &Path) -> bool {
        ["Msg", "FileStorage", "MicroMsg", "File", "Image"]
            .iter()
            .any(|name| path.join(name).exists())
    }
    /// 扫描微信基础目录，提取所有用户的缓存路径
    fn scan_wechat_base_directory(
        &self,
        base_path: &Path,
        is_custom: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
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

            // 跳过系统目录
            if user_name == "All Users" || user_name == "Applet" || user_name.starts_with(".") {
                continue;
            }

            info!("  微信用户: {}", user_name);
            self.scan_wechat_account_directory(&user_dir, is_custom, paths);
        }
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

    /// 全盘搜索 WeChat Files 文件夹
    /// 当注册表和默认路径都失败时，作为保底方案
    pub(super) fn search_wechat_files_on_all_drives(&self) -> Option<Vec<PathBuf>> {
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
    pub(super) fn read_wechat_registry_path(&self) -> Option<RegistryPathResult> {
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
    pub(super) fn read_wechat_registry_path(&self) -> Option<RegistryPathResult> {
        None
    }
}

// ========================================================================
