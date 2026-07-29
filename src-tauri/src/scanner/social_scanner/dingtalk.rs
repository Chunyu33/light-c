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
    // 钉钉路径检测
    // ========================================================================

    /// 检测钉钉路径
    pub(super) fn detect_dingtalk_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        let base_paths = [
            PathBuf::from(&self.appdata).join("DingTalk"),
            PathBuf::from(&self.local_appdata).join("DingTalk"),
            PathBuf::from(&self.appdata).join("Alibaba\\DingTalk"),
        ];

        for dingtalk_base in base_paths {
            if dingtalk_base.is_dir() {
                info!("发现钉钉目录: {}", dingtalk_base.display());
            }

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
                            Self::add_scan_path(
                                &mut paths,
                                "钉钉",
                                dir,
                                FileCategory::ImageVideo,
                                false,
                            );
                        }
                    }

                    // 文件
                    let file_dir = sub_dir.join("File");
                    if file_dir.exists() {
                        Self::add_scan_path(
                            &mut paths,
                            "钉钉",
                            file_dir,
                            FileCategory::FileTransfer,
                            false,
                        );
                    }

                    // 缓存和存储
                    for dir_name in &["Cache", "storage", "cache"] {
                        let dir = sub_dir.join(dir_name);
                        if dir.exists() {
                            Self::add_scan_path(
                                &mut paths,
                                "钉钉",
                                dir,
                                FileCategory::TempCache,
                                false,
                            );
                        }
                    }

                    // --------------------------------------------------------
                    // 钉钉数据库 (CRITICAL)
                    // 特征：Database 目录
                    // --------------------------------------------------------
                    let db_dir = sub_dir.join("Database");
                    if db_dir.exists() {
                        Self::add_scan_path(
                            &mut paths,
                            "钉钉",
                            db_dir,
                            FileCategory::ChatDatabase,
                            false,
                        );
                    }
                }
            }
        }

        // 钉钉文档目录
        let dingtalk_docs = PathBuf::from(format!("{}\\DingTalk", self.documents_dir));
        Self::add_scan_path(
            &mut paths,
            "钉钉",
            dingtalk_docs,
            FileCategory::FileTransfer,
            false,
        );

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }
}

// ========================================================================
