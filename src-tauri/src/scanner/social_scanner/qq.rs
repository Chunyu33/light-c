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

        // 安装目录旁的 data 目录：自定义数据位置不一定写进注册表，
        // 例如 D:\software\qq\install + D:\software\qq\data\<QQ号>
        for candidate in self.qq_install_adjacent_data_paths() {
            info!("QQ 安装目录旁数据目录: {}", candidate.display());
            Self::add_candidate(&mut found_base_paths, candidate);
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
                    if Self::is_qq_non_account_name(&user_name) {
                        continue;
                    }

                    // 账号目录特征是"存在 Msg/Image/FileRecv 之类子目录"，
                    // 不满足就跳过，避免把 All Users 之外的杂项目录也扫一遍。
                    if !Self::looks_like_qq_account(&user_dir) {
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

    /// QQ 数据根目录下需要跳过的非账号目录。
    fn is_qq_non_account_name(dir_name: &str) -> bool {
        dir_name.eq_ignore_ascii_case("all users")
            || dir_name.eq_ignore_ascii_case("global")
            || dir_name.starts_with('.')
    }

    /// 从 QQ 传统版安装目录推断数据目录。
    ///
    /// 老架构 QQ 把数据放在安装目录同级的 `data`（自定义位置）或 `Tencent Files`，
    /// 注册表可能没有记录，这里作为补充来源。
    #[cfg(target_os = "windows")]
    pub(super) fn qq_install_adjacent_data_paths(&self) -> Vec<PathBuf> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut bases: Vec<PathBuf> = Vec::new();

        if let Ok(qq_key) = hkcu.open_subkey("Software\\Tencent\\QQ") {
            for value_name in ["Install", "InstallPath", "InstallDir"] {
                let Ok(raw) = qq_key.get_value::<String, _>(value_name) else {
                    continue;
                };
                let raw = raw.trim().trim_matches('"').to_string();
                if raw.is_empty() {
                    continue;
                }
                let install_dir = PathBuf::from(&raw);
                if !install_dir.is_dir() {
                    continue;
                }
                // QQ 的注册表 Install 多指向 exe，取其所在目录
                let base_dir = if install_dir.is_file() {
                    install_dir.parent().map(|p| p.to_path_buf())
                } else {
                    Some(install_dir)
                };
                if let Some(base_dir) = base_dir {
                    if let Some(parent) = base_dir.parent() {
                        bases.push(parent.to_path_buf());
                    }
                    bases.push(base_dir);
                }
            }
        }

        // 注册表没有安装信息时（自定义安装目录、绿色版），退回文件系统推断
        for install_dir in self.find_qq_install_directories() {
            if let Some(parent) = install_dir.parent() {
                bases.push(parent.to_path_buf());
            }
            bases.push(install_dir);
        }

        let mut found = Vec::new();
        for base in bases {
            for relative in ["data", "Tencent Files", "data\\Tencent Files"] {
                let candidate = base.join(relative);
                // 只接受含账号目录特征的目录，避免把无关的 data 目录当 QQ 数据
                if candidate.is_dir() && Self::looks_like_qq_data_root(&candidate) {
                    if !found.contains(&candidate) {
                        found.push(candidate);
                    }
                }
            }
        }

        found
    }

    /// 在常见安装根目录下按名字找出 QQ 安装目录。
    ///
    /// 覆盖"注册表里没有安装路径"的情况：用户把 QQ 装在自定义目录（如 D:\software\qq\install），
    /// 或只装了新版 NTQQ（C:\Program Files\Tencent\QQNT）。
    pub(super) fn find_qq_install_directories(&self) -> Vec<PathBuf> {
        // 安装根目录候选：逐盘符的程序目录 + 常见的自定义软件目录
        let install_roots: [&str; 6] = [
            "Program Files\\Tencent",
            "Program Files (x86)\\Tencent",
            "Program Files",
            "Program Files (x86)",
            "software",
            "Programs",
        ];

        let mut install_dirs = Vec::new();
        for drive in &self.available_drives {
            for root in install_roots {
                let base = PathBuf::from(drive).join(root);
                if !base.is_dir() {
                    continue;
                }

                // 只看一层：安装目录本身、或安装根目录下的第一层子目录
                if Self::looks_like_qq_install_dir(&base) {
                    install_dirs.push(base.clone());
                }

                let Ok(entries) = std::fs::read_dir(&base) else {
                    continue;
                };
                for entry in entries.filter_map(|e| e.ok()) {
                    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        continue;
                    }
                    let candidate = entry.path();
                    if Self::looks_like_qq_install_dir(&candidate) {
                        install_dirs.push(candidate);
                    }
                }
            }
        }

        install_dirs.sort();
        install_dirs.dedup();
        install_dirs
    }

    /// 判断目录是否像 QQ 安装目录：目录名含 QQ，或目录内有 QQ 系可执行文件。
    pub(super) fn looks_like_qq_install_dir(path: &Path) -> bool {
        let name_matches = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.to_lowercase().contains("qq"));

        if name_matches {
            return true;
        }

        // 名字不含 QQ 的目录（例如 D:\software\qq\install 这类自定义命名）用可执行文件判断
        ["QQ.exe", "QQScLauncher.exe", "QQUninst.exe", "PCQQ2021.exe"]
            .iter()
            .any(|exe| path.join(exe).is_file())
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn qq_install_adjacent_data_paths(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    /// 判断目录是否为 QQ 数据根：其下直接存在账号目录或 nt_qq。
    pub(super) fn looks_like_qq_data_root(path: &Path) -> bool {
        if path.join("nt_qq").is_dir() {
            return true;
        }

        let Ok(entries) = std::fs::read_dir(path) else {
            return false;
        };

        entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .any(|entry| Self::looks_like_qq_account(&entry.path()))
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

        // 新旧架构混装的机器上，老账号目录里也会出现 nt_qq（新版数据落在老路径下），
        // 这里顺带解析，避免同一份数据只因为所在位置不同而漏扫。
        let nested_ntqq = account_path.join("nt_qq");
        if nested_ntqq.is_dir() {
            info!("  QQ账号内 NTQQ 数据: {}", nested_ntqq.display());
            self.scan_ntqq_directory(&nested_ntqq, paths);
        }
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

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn fixture(name: &str) -> PathBuf {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "lightc-qq-{}-{}-{}",
            name,
            std::process::id(),
            sequence
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn recognizes_qq_install_directory() {
        let root = fixture("install-shape");

        // 目录名含 QQ：直接认定
        let named = root.join("QQ");
        std::fs::create_dir_all(&named).unwrap();
        assert!(SocialScanner::looks_like_qq_install_dir(&named));

        // 目录名不含 QQ（自定义命名）：靠可执行文件认定
        let custom = root.join("install");
        std::fs::create_dir_all(&custom).unwrap();
        assert!(!SocialScanner::looks_like_qq_install_dir(&custom));
        std::fs::write(custom.join("QQUninst.exe"), b"stub").unwrap();
        assert!(SocialScanner::looks_like_qq_install_dir(&custom));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recognizes_qq_data_root_by_account_directories() {
        let root = fixture("data-shape");

        // 含数字账号目录（老架构）
        let legacy = root.join("legacy");
        std::fs::create_dir_all(legacy.join("1378813463/Image")).unwrap();
        assert!(SocialScanner::looks_like_qq_data_root(&legacy));

        // 含 nt_qq（新架构）
        let nt = root.join("nt");
        std::fs::create_dir_all(nt.join("nt_qq")).unwrap();
        assert!(SocialScanner::looks_like_qq_data_root(&nt));

        // 普通目录不应被当成 QQ 数据根，避免误扫无关的 data 目录
        let unrelated = root.join("unrelated");
        std::fs::create_dir_all(unrelated.join("notes")).unwrap();
        assert!(!SocialScanner::looks_like_qq_data_root(&unrelated));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collects_legacy_account_media_paths() {
        let root = fixture("legacy-account");
        let account = root.join("1378813463");
        std::fs::create_dir_all(account.join("Image")).unwrap();
        std::fs::create_dir_all(account.join("FileRecv")).unwrap();
        std::fs::create_dir_all(account.join("Msg2")).unwrap();
        // 老账号目录里嵌套的 nt_qq 也要解析
        std::fs::create_dir_all(account.join("nt_qq/123/nt_data/Pic")).unwrap();

        let scanner = SocialScanner::new();
        let mut paths = Vec::new();
        scanner.scan_qq_account_directory(&account, false, &mut paths);

        let found = |suffix: &str, category: FileCategory| {
            paths
                .iter()
                .any(|p| p.path.ends_with(suffix) && p.category == category)
        };

        assert!(found("Image", FileCategory::ImageVideo));
        assert!(found("FileRecv", FileCategory::FileTransfer));
        assert!(found("Msg2", FileCategory::ChatDatabase));
        assert!(found("Pic", FileCategory::ImageVideo), "嵌套 nt_qq 数据应被解析");

        let _ = std::fs::remove_dir_all(&root);
    }
}
