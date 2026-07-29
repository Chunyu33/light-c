// ============================================================================
// 社交软件路径适配器
// ============================================================================
//
// 每个适配器只负责发现软件数据目录，实际遍历和分类由 core.rs 统一处理。
// 这样可以在增强单个软件路径时避免复制扫描、去重和风险分级逻辑。
// ============================================================================

use super::core::{FileCategory, SocialAppPath, SocialScanner};
use log::info;
use std::path::PathBuf;

impl SocialScanner {
    // Telegram 路径检测
    // ========================================================================

    /// 检测 Telegram 路径
    pub(super) fn detect_telegram_paths(&self) -> Option<Vec<SocialAppPath>> {
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

        // Microsoft Store 版本不使用 Roaming\Telegram Desktop，需检查包目录的本地状态。
        for package in self.find_package_directories(&["telegramdesktop", "telegram"]) {
            self.add_named_subdirectories(
                &package.join("LocalCache"),
                &["Cache", "Temp", "Code Cache"],
                "Telegram",
                FileCategory::TempCache,
                false,
                &mut paths,
            );
            self.add_named_subdirectories(
                &package.join(r"LocalCache\Roaming\Telegram Desktop"),
                &["Cache", "Temp", "Code Cache"],
                "Telegram",
                FileCategory::TempCache,
                false,
                &mut paths,
            );
            Self::add_scan_path(
                &mut paths,
                "Telegram",
                package.join("LocalState").join("tdata"),
                FileCategory::ChatDatabase,
                false,
            );
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }
}

// ========================================================================
