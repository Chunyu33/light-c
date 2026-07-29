// ============================================================================
// 社交软件路径适配器
// ============================================================================
//
// 每个适配器只负责发现软件数据目录，实际遍历和分类由 core.rs 统一处理。
// 这样可以在增强单个软件路径时避免复制扫描、去重和风险分级逻辑。
// ============================================================================

use super::core::{FileCategory, SocialAppPath, SocialScanner};
use log::info;
use std::path::{Path, PathBuf};

impl SocialScanner {
    // QQ 路径检测
    // ========================================================================

    /// 检测传统 QQ 路径
    ///
    /// 路径溯源优先级：
    /// 1. 注册表 HKCU\Software\Tencent\QQ\PersonalFolder
    /// 2. 默认文档目录下的 "Tencent Files"
    /// 3. 全盘搜索 "Tencent Files" 文件夹
    pub(super) fn detect_qq_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();
        let mut found_base_paths = Vec::new();
        let registry_path = self.read_qq_registry_path();
        let is_custom = registry_path.is_some();

        // 尝试从注册表读取 QQ 自定义路径
        if let Some(registry_path) = registry_path {
            info!("QQ 注册表路径: {}", registry_path);
            Self::add_candidate(&mut found_base_paths, PathBuf::from(registry_path));
        }

        // 同时保留文档目录候选；用户可能安装过多个版本或迁移过数据。
        Self::add_candidate(
            &mut found_base_paths,
            PathBuf::from(format!("{}\\Tencent Files", self.documents_dir)),
        );
        if self.documents_dir != self.default_documents {
            Self::add_candidate(
                &mut found_base_paths,
                PathBuf::from(format!("{}\\Tencent Files", self.default_documents)),
            );
        }

        // 全盘搜索备选
        if found_base_paths.is_empty() {
            if let Some(search_paths) = self.search_qq_files_on_all_drives() {
                for path in search_paths {
                    Self::add_candidate(&mut found_base_paths, path);
                }
            }
        }

        for base_path in found_base_paths {
            info!("发现QQ目录: {}", base_path.display());

            if Self::looks_like_qq_account(&base_path) {
                self.scan_qq_account_directory(&base_path, is_custom, &mut paths);
            } else if let Ok(entries) = std::fs::read_dir(&base_path) {
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
                    self.scan_qq_account_directory(&user_dir, is_custom, &mut paths);
                }
            }
        }

        self.add_named_subdirectories(
            &PathBuf::from(&self.appdata).join("Tencent\\QQ"),
            &["Temp", "Cache", "Logs"],
            "QQ",
            FileCategory::TempCache,
            false,
            &mut paths,
        );

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }

    /// 扫描传统 QQ 的单个用户目录，覆盖消息、媒体、接收文件和缓存。
    fn scan_qq_account_directory(
        &self,
        account_path: &Path,
        is_custom: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
        self.add_named_subdirectories(
            account_path,
            &["Msg", "Msg2", "Database", "History", "MsgDb"],
            "QQ",
            FileCategory::ChatDatabase,
            is_custom,
            paths,
        );
        self.add_named_subdirectories(
            account_path,
            &["Image", "Video", "Audio", "Ptt", "QQImage"],
            "QQ",
            FileCategory::ImageVideo,
            is_custom,
            paths,
        );
        self.add_named_subdirectories(
            account_path,
            &["FileRecv", "File", "MsgAttach"],
            "QQ",
            FileCategory::FileTransfer,
            is_custom,
            paths,
        );
        self.add_named_subdirectories(
            account_path,
            &["Cache", "Temp", "Thumb", "Log", "Logs"],
            "QQ",
            FileCategory::TempCache,
            is_custom,
            paths,
        );
    }

    fn looks_like_qq_account(path: &Path) -> bool {
        ["Msg", "Msg2", "FileRecv", "Image", "Database"]
            .iter()
            .any(|name| path.join(name).is_dir())
    }

    /// 从注册表读取 QQ 自定义路径
    #[cfg(target_os = "windows")]
    pub(super) fn read_qq_registry_path(&self) -> Option<String> {
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
    pub(super) fn read_qq_registry_path(&self) -> Option<String> {
        None
    }

    /// 全盘搜索 Tencent Files 文件夹
    pub(super) fn search_qq_files_on_all_drives(&self) -> Option<Vec<PathBuf>> {
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
}
