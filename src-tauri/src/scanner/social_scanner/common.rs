// ============================================================================
// 社交软件扫描通用路径工具
// ============================================================================
//
// 适配器只描述“哪里可能有数据”，这里统一处理存在性、路径去重和
// Windows 大小写/斜杠差异，避免同一文件被重复统计或重复提交删除。
// ============================================================================

use super::core::{FileCategory, SocialAppPath, SocialScanner};
use std::path::{Path, PathBuf};

impl SocialScanner {
    /// 追加目录候选并去重；候选不存在时不做 IO 递归，避免漏扫修复拖慢常规扫描。
    pub(super) fn add_candidate(candidates: &mut Vec<PathBuf>, path: PathBuf) {
        if !path.is_dir() {
            return;
        }

        let path_key = Self::normalize_path_key(&path);
        if !candidates
            .iter()
            .any(|candidate| Self::normalize_path_key(candidate) == path_key)
        {
            candidates.push(path);
        }
    }

    /// 将已存在的目录加入扫描路径，并按应用、分类和规范化路径去重。
    pub(super) fn add_scan_path(
        paths: &mut Vec<SocialAppPath>,
        app_name: &str,
        path: PathBuf,
        category: FileCategory,
        is_custom_path: bool,
    ) {
        if !path.is_dir() {
            return;
        }

        let path_key = Self::normalize_path_key(&path);
        let duplicated = paths.iter().any(|item| {
            item.app_name == app_name
                && item.category == category
                && Self::normalize_path_key(&item.path) == path_key
        });

        if !duplicated {
            paths.push(SocialAppPath {
                app_name: app_name.to_string(),
                path,
                category,
                is_custom_path,
            });
        }
    }

    /// 添加多个固定名称的子目录，适合处理 Electron/WebView 类客户端。
    pub(super) fn add_named_subdirectories(
        &self,
        base_path: &Path,
        names: &[&str],
        app_name: &str,
        category: FileCategory,
        is_custom_path: bool,
        paths: &mut Vec<SocialAppPath>,
    ) {
        for name in names {
            Self::add_scan_path(
                paths,
                app_name,
                base_path.join(name),
                category,
                is_custom_path,
            );
        }
    }

    /// 查找匹配指定关键词的 Windows Store 包目录。
    pub(super) fn find_package_directories(&self, markers: &[&str]) -> Vec<PathBuf> {
        let packages_dir = PathBuf::from(&self.local_appdata).join("Packages");
        let Ok(entries) = std::fs::read_dir(packages_dir) else {
            return Vec::new();
        };

        entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let is_dir = entry.file_type().ok()?.is_dir();
                if !is_dir {
                    return None;
                }

                let name = entry.file_name().to_string_lossy().to_lowercase();
                markers
                    .iter()
                    .any(|marker| name.contains(&marker.to_lowercase()))
                    .then_some(entry.path())
            })
            .collect()
    }

    /// 统一生成路径键，兼容 Windows 下大小写不敏感和两种分隔符。
    pub(super) fn normalize_path_key(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
}
