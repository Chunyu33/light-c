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
    pub(super) fn detect_ntqq_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        // NTQQ 主目录
        let ntqq_base = PathBuf::from(format!("{}\\Tencent\\QQ\\nt_qq", self.local_appdata));
        if ntqq_base.is_dir() {
            info!("发现NTQQ目录: {}", ntqq_base.display());
            self.scan_ntqq_directory(&ntqq_base, &mut paths);
        }

        // 尝试从注册表读取 NTQQ 自定义路径
        if let Some(registry_path) = self.read_ntqq_registry_path() {
            let custom_base = PathBuf::from(&registry_path);
            if custom_base.is_dir() && custom_base != ntqq_base {
                info!("发现NTQQ自定义目录: {}", custom_base.display());
                self.scan_ntqq_directory(&custom_base, &mut paths);
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

    /// 扫描 NTQQ 目录结构
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

            // 跳过非用户目录
            if dir_name == "global" || dir_name.starts_with(".") {
                continue;
            }

            info!("  NTQQ用户目录: {}", dir_name);

            // nt_data 目录 - 媒体文件
            let nt_data = sub_dir.join("nt_data");
            if nt_data.is_dir() {
                // 图片视频 (LOW)
                for media_dir in &["Pic", "Video", "Ptt"] {
                    let dir = nt_data.join(media_dir);
                    Self::add_scan_path(&mut *paths, "NTQQ", dir, FileCategory::ImageVideo, false);
                }

                // 文件 (MEDIUM)
                let file_dir = nt_data.join("File");
                Self::add_scan_path(paths, "NTQQ", file_dir, FileCategory::FileTransfer, false);
            }

            // --------------------------------------------------------
            // nt_msg 目录（消息数据库）(CRITICAL)
            // 包含 .db 文件：
            //   - nt_msg.db      - 主消息数据库
            //   - nt_msg.db-wal  - WAL 日志
            //   - nt_msg.db-shm  - 共享内存
            // --------------------------------------------------------
            let nt_msg = sub_dir.join("nt_msg");
            Self::add_scan_path(paths, "NTQQ", nt_msg, FileCategory::ChatDatabase, false);

            // nt_db 目录（用户数据库）(CRITICAL)
            let nt_db = sub_dir.join("nt_db");
            Self::add_scan_path(paths, "NTQQ", nt_db, FileCategory::ChatDatabase, false);
        }
    }

    /// 从注册表读取 NTQQ 自定义路径
    #[cfg(target_os = "windows")]
    pub(super) fn read_ntqq_registry_path(&self) -> Option<String> {
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
    pub(super) fn read_ntqq_registry_path(&self) -> Option<String> {
        None
    }
}

// ========================================================================
