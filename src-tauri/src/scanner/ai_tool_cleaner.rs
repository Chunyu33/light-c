// ============================================================================
// AI 工具清理：扫各家 AI 客户端 / 编程助手留在本地的缓存
// ============================================================================
//
// 设计原则（对应 docs/dev/AI工具清理-规划.md）：
//
// 1. **白名单，不是黑名单**：只进明确列出的子目录名。
//    同一个父目录里往往既有缓存也有会话历史和登录凭据 ——
//    比如 ~/.dsh 下 cache 只有 676K，sessions 却有 46M，整目录删就是灾难。
// 2. **只扫一层**：工具的缓存目录结构都很浅，不做深递归去"找垃圾"，
//    避免把用户放在同一层里的其它文件卷进来。
// 3. **找不到就跳过**：没装的工具直接略过，不报错、不影响其它工具。

use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 允许清理的子目录名。**只认这些名字**，不在名单里的一律不碰。
///
/// 大小写按 Windows 上实际创建的文件名写：Electron 系是 `Cache`/`GPUCache`，
/// 部分 CLI 工具用小写 `cache`，所以两种都列。
const CLEANABLE_DIR_NAMES: &[&str] = &[
    "Cache",
    "cache",
    "GPUCache",
    "GrShaderCache",
    "GPUPersistentCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Code Cache",
    "logs",
    "Crashpad",
];

/// 从工具根目录往下找的最大层数。
///
/// 有些工具的缓存不是直接在根目录下（如 `.codeium/windsurf/<版本>/Cache`），
/// 只扫一层会漏掉；但也不能无限往下走，免得把工具自己带的运行时目录当成缓存。
const MAX_SCAN_DEPTH: usize = 3;

/// 单个缓存目录的统计结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCacheEntry {
    /// 目录名（用于界面展示，如 "Cache" / "media_cache"）
    pub name: String,
    pub path: String,
    pub size: u64,
    pub file_count: usize,
}

/// 一个工具的汇总。界面按工具分组展示，用户先看到"哪个工具占了多少"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolGroup {
    pub tool_id: String,
    pub tool_name: String,
    pub total_size: u64,
    pub file_count: usize,
    /// 该工具下命中的缓存目录，按体积从大到小
    pub entries: Vec<AiCacheEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolScanResult {
    pub groups: Vec<AiToolGroup>,
    pub total_size: u64,
    pub total_files: usize,
}

/// 一个工具的数据根目录候选。
///
/// 用多个候选而不是单个，是因为同一个工具在不同安装方式下位置不同：
/// 比如 dsh 的桌面端缓存在 AppData 里，CLI 缓存却在用户目录的点目录下。
struct ToolSpec {
    id: &'static str,
    name: &'static str,
    roots: Vec<PathBuf>,
}

pub struct AiToolScanner {
    appdata: PathBuf,
    local_appdata: PathBuf,
    user_profile: PathBuf,
}

impl Default for AiToolScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl AiToolScanner {
    pub fn new() -> Self {
        // 和社交扫描器保持一致：环境变量优先，取不到就用默认路径兜底，
        // 免得某个变量缺失时整个扫描直接失败。
        let user_profile = std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\Users\Default"));
        let local_appdata = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| user_profile.join("AppData").join("Local"));
        let appdata = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| user_profile.join("AppData").join("Roaming"));

        Self {
            appdata,
            local_appdata,
            user_profile,
        }
    }

    /// 工具清单。
    ///
    /// Trae 这类用户量小的先不做；Codex 和 dsh 按用户反馈优先排进来。
    /// 新增一个工具只需要在这里加一段，扫描与界面都不用改。
    fn specs(&self) -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                id: "workbuddy",
                name: "WorkBuddy",
                roots: vec![
                    self.local_appdata.join("WorkBuddy"),
                    self.appdata.join("WorkBuddy"),
                    // CLI 的缓存写在用户目录点目录下，和桌面端 AppData 是两套
                    self.user_profile.join(".workbuddy"),
                ],
            },
            ToolSpec {
                id: "claude-code",
                name: "Claude Code",
                roots: vec![self.user_profile.join(".claude")],
            },
            ToolSpec {
                id: "codex",
                name: "Codex",
                roots: vec![self.user_profile.join(".codex")],
            },
            // 下面几个都是用户目录下的点目录，缓存藏在第二、三层，
            // 靠 MAX_SCAN_DEPTH 才能找到。
            ToolSpec {
                id: "codeium",
                name: "Codeium / Windsurf",
                roots: vec![self.user_profile.join(".codeium")],
            },
            ToolSpec {
                id: "continue",
                name: "Continue",
                roots: vec![self.user_profile.join(".continue")],
            },
            ToolSpec {
                id: "codebuddy",
                name: "CodeBuddy",
                roots: vec![self.user_profile.join(".codebuddy")],
            },
            ToolSpec {
                id: "gemini",
                name: "Gemini CLI",
                roots: vec![self.user_profile.join(".gemini")],
            },
            ToolSpec {
                id: "dsh",
                name: "DeepSeek（dsh）",
                roots: vec![
                    self.user_profile.join(".dsh"),
                    // 壁纸引擎的缓存单独放在同级目录，体积往往是最大的
                    self.user_profile.join(".dsh-wallpaper-engine"),
                    self.appdata.join("@deepseek-ai").join("dsh-desktop"),
                ],
            },
        ]
    }

    pub fn scan(&self) -> AiToolScanResult {
        let mut groups = Vec::new();

        for spec in self.specs() {
            let mut entries = Vec::new();
            for root in &spec.roots {
                self.collect_cleanable_children(root, &mut entries);
            }
            if entries.is_empty() {
                continue;
            }

            // 体积大的排前面，用户第一眼看到的就是最能省的那块
            entries.sort_by(|a, b| b.size.cmp(&a.size));

            groups.push(AiToolGroup {
                tool_id: spec.id.to_string(),
                tool_name: spec.name.to_string(),
                total_size: entries.iter().map(|e| e.size).sum(),
                file_count: entries.iter().map(|e| e.file_count).sum(),
                entries,
            });
        }

        groups.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        AiToolScanResult {
            total_size: groups.iter().map(|g| g.total_size).sum(),
            total_files: groups.iter().map(|g| g.file_count).sum(),
            groups,
        }
    }

    /// 在 root 下找白名单目录并统计。root 不存在就静默返回。
    fn collect_cleanable_children(&self, root: &Path, entries: &mut Vec<AiCacheEntry>) {
        if !root.is_dir() {
            return;
        }
        self.walk_for_caches(root, 0, entries);
    }

    /// 递归找白名单目录，最多 MAX_SCAN_DEPTH 层。
    ///
    /// **命中即停**：白名单目录里不会再有需要单独统计的缓存，
    /// 继续往下走只会把同一个 Cache 的子孙目录重复算一遍。
    fn walk_for_caches(&self, dir: &Path, depth: usize, entries: &mut Vec<AiCacheEntry>) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let children = match std::fs::read_dir(dir) {
            Ok(children) => children,
            Err(error) => {
                // 权限不足或目录正被占用：跳过这一层，不让整次扫描失败
                log::debug!("跳过 {}：{error}", dir.display());
                return;
            }
        };

        for child in children.filter_map(|entry| entry.ok()) {
            if !child.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = child.file_name().to_string_lossy().to_string();
            // 版本库目录整体跳过：白名单是按名字匹配的，而 `.git/logs` 存的是 reflog，
            // 删掉会让用户丢失版本历史，和"清缓存"完全不是一回事。
            if name == ".git" {
                continue;
            }
            if CLEANABLE_DIR_NAMES.contains(&name.as_str()) {
                let (size, file_count) = Self::measure_dir(&child.path());
                if file_count > 0 {
                    entries.push(AiCacheEntry {
                        name,
                        path: child.path().to_string_lossy().to_string(),
                        size,
                        file_count,
                    });
                }
                continue;
            }
            self.walk_for_caches(&child.path(), depth + 1, entries);
        }
    }

    /// 判断一个路径是不是本模块管理的缓存目录。
    ///
    /// 删除是不可逆操作，前端传来的路径**一律不可信**，必须重新校验：
    /// ① 目录名必须在白名单里 ② 必须位于某个已登记工具的根目录之下。
    /// 两条都满足才允许删，避免被改参数删到用户目录本身。
    pub fn is_managed_cache_dir(&self, path: &Path) -> bool {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return false;
        };
        if !CLEANABLE_DIR_NAMES.contains(&name) {
            return false;
        }
        self.specs().iter().any(|spec| {
            spec.roots
                .iter()
                .any(|root| path.starts_with(root) && path != root.as_path())
        })
    }

    /// 统计目录内所有文件的总大小与数量。读不到的单条直接跳过（缓存目录常有占用）。
    fn measure_dir(path: &Path) -> (u64, usize) {
        let mut size = 0u64;
        let mut file_count = 0usize;
        for entry in WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
        {
            if let Ok(metadata) = entry.metadata() {
                size += metadata.len();
                file_count += 1;
            }
        }
        (size, file_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 白名单之外的目录必须被忽略 —— 这条是安全底线：
    /// 删错会话历史或凭据的代价，远大于少省几个 G。
    #[test]
    fn only_whitelisted_directories_are_collected() {
        let base = std::env::temp_dir().join("lightc-ai-clean-test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("Cache")).unwrap();
        fs::create_dir_all(base.join("sessions")).unwrap();
        fs::write(base.join("Cache").join("a.bin"), vec![0u8; 1024]).unwrap();
        fs::write(base.join("sessions").join("chat.db"), vec![0u8; 4096]).unwrap();

        let scanner = AiToolScanner::new();
        let mut entries = Vec::new();
        scanner.collect_cleanable_children(&base, &mut entries);

        assert_eq!(entries.len(), 1, "只应命中 Cache");
        assert_eq!(entries[0].name, "Cache");
        assert_eq!(entries[0].file_count, 1);
        assert_eq!(entries[0].size, 1024);

        let _ = fs::remove_dir_all(&base);
    }

    /// 目录不存在时不能 panic，也不能返回空以外的副作用。
    #[test]
    fn missing_root_is_ignored() {
        let scanner = AiToolScanner::new();
        let mut entries = Vec::new();
        scanner.collect_cleanable_children(Path::new(r"Z:\definitely-not-exists"), &mut entries);
        assert!(entries.is_empty());
    }
}
