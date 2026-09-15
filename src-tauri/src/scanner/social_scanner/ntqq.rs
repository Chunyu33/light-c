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
    /// 扫描一个 nt_qq 数据目录（其下按账号分子目录，另有 global 全局目录）。
    ///
    /// 调用方传入的可能是数据根（`...\nt_qq`），也可能是自定义路径直接指向账号目录，
    /// 这里按"账号目录 / 数据根"两种形态分别处理。
    pub(super) fn collect_ntqq_paths(&self, base: &Path, paths: &mut Vec<SocialAppPath>) {
        if Self::looks_like_ntqq_account(base) {
            self.scan_ntqq_account_directory(base, paths);
            // 账号目录下还可能再嵌一层 nt_qq（老架构账号目录里常见）
            let nested = base.join("nt_qq");
            if nested.is_dir() {
                self.scan_ntqq_directory(&nested, paths);
            }
            return;
        }

        self.scan_ntqq_directory(base, paths);
    }

    /// NTQQ 账号目录特征：直接用 nt_data / nt_db / nt_msg 标记，不再依赖目录名。
    pub(super) fn looks_like_ntqq_account(path: &Path) -> bool {
        ["nt_data", "nt_db", "nt_msg"]
            .iter()
            .any(|name| path.join(name).is_dir())
    }

    /// 扫描 NTQQ 的账号目录结构（nt_qq 下的一个账号子目录）。
    pub(super) fn scan_ntqq_account_directory(&self, account_dir: &Path, paths: &mut Vec<SocialAppPath>) {
        // nt_data 目录 - 媒体文件
        let nt_data = account_dir.join("nt_data");
        if nt_data.is_dir() {
            // 图片视频 (LOW)
            for media_dir in &["Pic", "Video", "Ptt"] {
                let dir = nt_data.join(media_dir);
                Self::add_scan_path(paths, "NTQQ", dir, FileCategory::ImageVideo, false);
            }

            // 文件 (MEDIUM)
            let file_dir = nt_data.join("File");
            Self::add_scan_path(paths, "NTQQ", file_dir, FileCategory::FileTransfer, false);

            // 表情、头像等业务缓存 (NONE)
            self.add_named_subdirectories(
                &nt_data,
                &["Emoji", "PokeFace", "Skin", "ntnnModel", "onlineStatus", "msf"],
                "NTQQ",
                FileCategory::TempCache,
                false,
                paths,
            );

            // 运行日志 (NONE)
            self.add_named_subdirectories(
                &nt_data,
                &["Log", "Login", "mmkv", "search"],
                "NTQQ",
                FileCategory::TempCache,
                false,
                paths,
            );
        }

        // --------------------------------------------------------
        // nt_msg 目录（消息数据库）(CRITICAL)
        // 包含 .db 文件：
        //   - nt_msg.db      - 主消息数据库
        //   - nt_msg.db-wal  - WAL 日志
        //   - nt_msg.db-shm  - 共享内存
        // --------------------------------------------------------
        let nt_msg = account_dir.join("nt_msg");
        Self::add_scan_path(paths, "NTQQ", nt_msg, FileCategory::ChatDatabase, false);

        // nt_db 目录（用户数据库）(CRITICAL)
        let nt_db = account_dir.join("nt_db");
        Self::add_scan_path(paths, "NTQQ", nt_db, FileCategory::ChatDatabase, false);

        // nt_temp 目录（临时数据）(NONE)
        let nt_temp = account_dir.join("nt_temp");
        Self::add_scan_path(paths, "NTQQ", nt_temp, FileCategory::TempCache, false);
    }

    pub(super) fn detect_ntqq_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        // NTQQ 主目录
        let ntqq_base = PathBuf::from(format!("{}\\Tencent\\QQ\\nt_qq", self.local_appdata));
        if ntqq_base.is_dir() {
            info!("发现NTQQ目录: {}", ntqq_base.display());
            self.collect_ntqq_paths(&ntqq_base, &mut paths);
        }

        // 尝试从注册表读取 NTQQ 自定义路径
        if let Some(registry_path) = self.read_ntqq_registry_path() {
            let custom_base = PathBuf::from(&registry_path);
            if custom_base.is_dir() && custom_base != ntqq_base {
                info!("发现NTQQ自定义目录: {}", custom_base.display());
                self.collect_ntqq_paths(&custom_base, &mut paths);
            }
        }

        // 安装目录推出的 nt_qq：QQ 常把数据放在安装目录或同级目录的自定义位置，
        // 例如 D:\software\qq\install + D:\software\qq\data\nt_qq
        for candidate in self.ntqq_install_adjacent_paths() {
            if candidate != ntqq_base {
                info!("发现NTQQ安装目录旁数据目录: {}", candidate.display());
                self.collect_ntqq_paths(&candidate, &mut paths);
            }
        }

        // NTQQ 全局缓存
        let qq_root = PathBuf::from(&self.local_appdata).join("Tencent\\QQ");
        self.add_named_subdirectories(
            &qq_root,
            &["Cache", "Temp", "Logs", "WebCache"],
            "NTQQ",
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

    /// 扫描 NTQQ 数据根目录：其下是各账号目录，另有 global 全局目录。
    pub(super) fn scan_ntqq_directory(&self, base: &Path, paths: &mut Vec<SocialAppPath>) {
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

            if dir_name.starts_with('.') {
                continue;
            }

            // global 不是账号目录，但里面有 Emoji、表情、临时文件等可清理内容；
            // 之前整个跳过，导致只装了新版 QQ 的机器扫不出任何 QQ 数据。
            if dir_name.eq_ignore_ascii_case("global") {
                info!("  NTQQ全局目录: {}", dir_name);
                self.scan_ntqq_account_directory(&sub_dir, paths);
                continue;
            }

            // 只处理账号目录特征明确的子目录，避免把 global 下的杂项目录当成账号
            if !Self::looks_like_ntqq_account(&sub_dir) {
                continue;
            }

            info!("  NTQQ用户目录: {}", dir_name);
            self.scan_ntqq_account_directory(&sub_dir, paths);
        }
    }

    /// 从 QQ 安装目录推断 nt_qq 数据目录位置。
    ///
    /// 新版 QQ 允许把数据放到自定义位置，注册表不一定记录；
    /// 但安装目录通常是已知的（注册表 QQNT / QQ 的 Install / InstallPath），
    /// 数据目录大多就在安装目录或其同级目录下。
    #[cfg(target_os = "windows")]
    pub(super) fn ntqq_install_adjacent_paths(&self) -> Vec<PathBuf> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let mut bases: Vec<PathBuf> = Vec::new();

        // 收集安装目录候选
        for key_path in ["Software\\Tencent\\QQNT", "Software\\Tencent\\QQ"] {
            let Ok(key) = hkcu.open_subkey(key_path) else {
                continue;
            };
            for value_name in ["Install", "InstallPath", "InstallDir"] {
                let Ok(raw) = key.get_value::<String, _>(value_name) else {
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
                if let Some(parent) = install_dir.parent() {
                    bases.push(parent.to_path_buf());
                }
                bases.push(install_dir);
            }
        }

        // 注册表没有安装信息时（自定义安装目录、绿色版），退回文件系统推断，
        // 例如 D:\software\qq\install -> D:\software\qq\data\nt_qq
        for install_dir in self.find_qq_install_directories() {
            if let Some(parent) = install_dir.parent() {
                bases.push(parent.to_path_buf());
            }
            bases.push(install_dir);
        }

        // 在安装目录及其同级目录中寻找 nt_qq / data\nt_qq
        let mut found = Vec::new();
        for base in bases {
            for relative in ["nt_qq", "data\\nt_qq"] {
                let candidate = base.join(relative);
                if candidate.is_dir() && !found.contains(&candidate) {
                    found.push(candidate);
                }
            }
        }

        found
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn ntqq_install_adjacent_paths(&self) -> Vec<PathBuf> {
        Vec::new()
    }

    /// 从注册表读取 NTQQ 自定义路径
    #[cfg(target_os = "windows")]
    pub(super) fn read_ntqq_registry_path(&self) -> Option<String> {
        use winreg::enums::*;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // 尝试读取 NTQQ 注册表路径；不同版本写入的值名不一致，逐个尝试
        if let Ok(qq_key) = hkcu.open_subkey("Software\\Tencent\\QQNT") {
            for value_name in ["PersonalPath", "DataPath", "PersonalFolder"] {
                if let Ok(path) = qq_key.get_value::<String, _>(value_name) {
                    if !path.is_empty() && Path::new(&path).exists() {
                        return Some(path);
                    }
                }
            }
        }

        None
    }

    #[cfg(not(target_os = "windows"))]
    pub(super) fn read_ntqq_registry_path(&self) -> Option<String> {
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

    static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn fixture(name: &str) -> PathBuf {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "lightc-ntqq-{}-{}-{}",
            name,
            std::process::id(),
            sequence
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    #[test]
    fn recognizes_ntqq_account_by_structure() {
        let root = fixture("account-shape");
        let account = root.join("123456789");
        std::fs::create_dir_all(account.join("nt_data/Pic")).unwrap();
        assert!(SocialScanner::looks_like_ntqq_account(&account));

        // 只有 global 那种空目录不算账号
        let global = root.join("global");
        std::fs::create_dir_all(&global).unwrap();
        assert!(!SocialScanner::looks_like_ntqq_account(&global));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scans_ntqq_global_directory() {
        // 只装新版 QQ 的机器上，nt_qq 下可能只有 global，
        // 旧实现直接跳过 global，导致这类机器完全扫不出 QQ 缓存。
        let root = fixture("global-scan");
        let global = root.join("global");
        std::fs::create_dir_all(global.join("nt_data/Emoji")).unwrap();
        std::fs::create_dir_all(global.join("nt_data/Log")).unwrap();
        std::fs::create_dir_all(global.join("nt_temp")).unwrap();
        std::fs::create_dir_all(global.join("nt_db")).unwrap();
        // 账号目录仍要照常解析
        std::fs::create_dir_all(root.join("123456789/nt_data/Pic")).unwrap();

        let scanner = SocialScanner::new();
        let mut paths = Vec::new();
        scanner.scan_ntqq_directory(&root, &mut paths);

        let found = |suffix: &str, category: FileCategory| {
            paths
                .iter()
                .any(|p| p.path.ends_with(suffix) && p.category == category)
        };

        assert!(found("Emoji", FileCategory::TempCache), "global/nt_data/Emoji 应被收录");
        assert!(found("Log", FileCategory::TempCache), "global/nt_data/Log 应被收录");
        assert!(found("nt_temp", FileCategory::TempCache), "global/nt_temp 应被收录");
        assert!(found("nt_db", FileCategory::ChatDatabase), "global/nt_db 应为聊天记录");
        assert!(found("Pic", FileCategory::ImageVideo), "账号目录媒体仍应被收录");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collects_paths_when_root_points_at_account() {
        // 自定义路径可能直接指向账号目录而不是 nt_qq 根目录
        let root = fixture("account-root");
        std::fs::create_dir_all(root.join("nt_data/Pic")).unwrap();

        let scanner = SocialScanner::new();
        let mut paths = Vec::new();
        scanner.collect_ntqq_paths(&root, &mut paths);

        assert!(paths.iter().any(|p| p.path.ends_with("Pic")));

        let _ = std::fs::remove_dir_all(&root);
    }
}

// ========================================================================
