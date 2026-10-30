//! 扫描与删除的核心逻辑。

use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

use super::tools::build_specs;
use super::types::{
    AiCacheDeleteFailure, AiCacheDeleteResult, AiCacheEntry, AiCacheFile, AiCacheFileList,
    AiToolGroup, AiToolScanResult,
};

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
    // 下面三个是 VS Code 套壳客户端（Cursor / Trae / Devin / Windsurf）共有的缓存目录，
    // 删掉只会让下次启动时重新生成，不影响已装的扩展和设置：
    // - CachedData             V8 编译快照，体积最大（Devin 上 105MB）
    // - CachedExtensionVSIXs   扩展安装包缓存，更新扩展时重新下载
    // - CachedProfilesData     配置读取缓存
    "CachedData",
    "CachedExtensionVSIXs",
    "CachedProfilesData",
    // Windsurf 下载并解包后的扩展产物，和上面的 CachedExtensionVSIXs（原始安装包）不是一回事
    "CachedExtensions",
    // Chromium 系的其余缓存：着色器编译结果与 Service Worker 脚本编译结果。
    // 版本不同目录名会变（老版 GrShaderCache、新版 GraphiteDawnCache），几个都留着；
    // 删掉只是让下次启动重新编译一遍。
    "ShaderCache",
    "ScriptCache",
    "GraphiteDawnCache",
];

/*
名字像缓存、但**绝对不能**进白名单的目录（写在这里是为了不再被误加）：

- `WebStorage` / `IndexedDB` / `Local Storage` / `Session Storage`
  客户端把登录态和站点数据存在这些目录里，删了等于把用户踢下线。
  Devin 的 `WebStorage` 有 66MB，体积上很有诱惑力，性质上是用户数据。
  它下面还有 `CacheStorage`（Devin 那里 83MB），同样不能碰：路径在 `WebStorage` 之内，
  删了会丢站点离线数据。
- `Network`   存放 cookies，几十 KB 却能让人丢掉所有登录状态。
- `Backups`   VS Code 系的未保存文件备份，删了会丢没保存的编辑内容。
- `User`      设置、snippets、workspaceStorage、globalStorage。
- `cli`       部分客户端的命令行本体，不是缓存。
- `plugins`   已安装的插件本体。里面的子目录多叫 `cache`，但装的是插件包，
              实测 WorkBuddy 224MB、Codex 31MB，删了对应功能直接不可用。
- `extensions` / `node_modules`
              扩展本体与它的依赖。里面确实存在名为 `cache` 的子目录，
              但属于依赖内部，删了会让扩展损坏（见下面的跳过逻辑）。
- `ModularData`  TRAE 的对话记录库，加密绑定机器，删了历史对话全没。
- `sessions`  各家 CLI 的会话历史（Codex 136MB、Grok Build 全家桶都在这）。
- `bin`       Grok Build / Qwen 等 CLI 的可执行文件本体。
*/

/// 从工具根目录往下找的最大层数。
///
/// 有些工具的缓存不是直接在根目录下（如 `.codeium/windsurf/<版本>/Cache`），
/// 只扫一层会漏掉；但也不能无限往下走，免得把工具自己带的运行时目录当成缓存。
const MAX_SCAN_DEPTH: usize = 3;

/// 明细弹窗单次最多返回的文件条数。
///
/// 正常缓存目录只有几千个文件，但"被当成缓存"的目录结构可能又深又宽。
/// 不封顶会让 IPC 序列化和前端内存一起爆掉，所以截断后明确告知只显示了前 N 条。
const MAX_LISTED_FILES: usize = 50_000;

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

    pub fn scan(&self) -> AiToolScanResult {
        let mut groups = Vec::new();

        for spec in build_specs(&self.appdata, &self.local_appdata, &self.user_profile) {
            let mut entries = Vec::new();
            for root in &spec.roots {
                self.collect_cleanable_children(root, spec.extra_cleanable_names, &mut entries);
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

        // 按占用体积倒序：第一眼看到的就是最能释放空间的那一项。
        // 体积相同时保持 tools.rs 里的清单顺序（sort_by 是稳定排序），
        // 所以常用工具仍然排在同类量的前面。
        groups.sort_by(|a, b| b.total_size.cmp(&a.total_size));

        AiToolScanResult {
            total_size: groups.iter().map(|g| g.total_size).sum(),
            total_files: groups.iter().map(|g| g.file_count).sum(),
            groups,
        }
    }

    /// 在 root 下找白名单目录并统计。root 不存在就静默返回。
    ///
    /// `extra_names` 是**这个工具额外允许**的目录名（如 Codex 的 `.tmp`）。
    /// 不放进全局白名单，是因为 `.tmp` 这种名字在别的工具里可能是重要暂存目录。
    /// 对 `tests` 模块可见：白名单边界要用真实目录结构验证。
    pub(super) fn collect_cleanable_children(
        &self,
        root: &Path,
        extra_names: &[&str],
        entries: &mut Vec<AiCacheEntry>,
    ) {
        if !root.is_dir() {
            return;
        }
        self.walk_for_caches(root, 0, extra_names, entries);
    }

    /// 递归找白名单目录，最多 MAX_SCAN_DEPTH 层。
    ///
    /// **命中即停**：白名单目录里不会再有需要单独统计的缓存，
    /// 继续往下走只会把同一个 Cache 的子孙目录重复算一遍。
    fn walk_for_caches(
        &self,
        dir: &Path,
        depth: usize,
        extra_names: &[&str],
        entries: &mut Vec<AiCacheEntry>,
    ) {
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
            // 软链接与 junction 在这里 `is_dir()` 为 false（实测 junction 报
            // is_dir=false / is_symlink=true），所以天然不会跟进到别的盘，
            // 也就不会顺着链接把工具根目录之外的东西算进来或删掉。
            if !child.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = child.file_name().to_string_lossy().to_string();
            // 版本库目录整体跳过：白名单是按名字匹配的，而 `.git/logs` 存的是 reflog，
            // 删掉会让用户丢失版本历史，和"清缓存"完全不是一回事。
            if name == ".git" {
                continue;
            }
            // `plugins` 目录整体跳过：里面的 `cache` 存的是**已安装的插件本体**，不是缓存。
            // 实测 WorkBuddy 的 plugins/cache 有 224MB（内置插件 + 连接器），
            // Codex 的 plugins/cache 是 openai-bundled 运行时 —— 删了功能直接缺失。
            if name == "plugins" {
                continue;
            }
            // `extensions` / `node_modules` 同样整体跳过。
            // VS Code 系客户端的扩展目录形如 `extensions/<扩展名>/node_modules/<包>/cache`，
            // 正好落在扫描深度内，按名字会被当成缓存 —— 但那是扩展依赖内部的目录，
            // 删掉会让扩展直接损坏。用户要清的是客户端的缓存，不是扩展自己的。
            if name == "extensions" || name == "node_modules" {
                continue;
            }
            if is_cleanable_name(&name, extra_names) {
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
            self.walk_for_caches(&child.path(), depth + 1, extra_names, entries);
        }
    }

    /// 判断一个路径是不是本模块管理的缓存目录。
    ///
    /// 删除是不可逆操作，前端传来的路径**一律不可信**，必须重新校验：
    /// ① 路径里不能有 `.` / `..` ② 目录名必须被这个工具允许 ③ 必须位于它的根目录之下。
    pub fn is_managed_cache_dir(&self, path: &Path) -> bool {
        // `Path::starts_with` 是**词法**比较：`...\Cursor\Cache\..\..\..\logs` 会被判定
        // 在根目录之下，而 `remove_dir_all` 是按解析后的真实路径动手的 ——
        // 不先把这类路径挡掉，前缀校验等于形同虚设。
        if path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return false;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return false;
        };

        build_specs(&self.appdata, &self.local_appdata, &self.user_profile)
            .iter()
            .any(|spec| {
                if !is_cleanable_name(name, spec.extra_cleanable_names) {
                    return false;
                }
                spec.roots.iter().any(|root| {
                    // 必须严格在根目录**之下**：根目录本身不能删
                    path.components().count() > root.components().count()
                        && starts_with_ignore_case(path, root)
                })
            })
    }

    /// 删除选中的缓存目录，返回成功数与失败明细。
    ///
    /// 失败是常态而不是异常：工具还开着的时候，Chromium 的缓存文件常被内存映射，
    /// Windows 会以共享冲突拒绝删除。以前这里只记日志、把成功数当全部结果返回，
    /// 用户看到的是"提示删完了，可大小一点没变"。所以失败必须一并交回前端说明原因。
    pub fn delete_dirs(&self, paths: &[String]) -> AiCacheDeleteResult {
        let mut deleted = 0usize;
        let mut failed = Vec::new();

        for raw in paths {
            let path = PathBuf::from(raw);
            if !self.is_managed_cache_dir(&path) {
                log::warn!("拒绝删除非托管路径: {raw}");
                failed.push(AiCacheDeleteFailure {
                    path: raw.clone(),
                    reason: "不在可清理范围内".to_string(),
                });
                continue;
            }
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {
                    deleted += 1;
                    log::info!("已删除缓存目录: {raw}");
                }
                Err(error) => {
                    // 目录被占用是常见情况（工具还开着），记录后继续删其它目录
                    log::warn!("删除失败 {raw}: {error}");
                    failed.push(AiCacheDeleteFailure {
                        path: raw.clone(),
                        reason: error.to_string(),
                    });
                }
            }
        }

        AiCacheDeleteResult { deleted, failed }
    }

    /// 列出某个缓存目录下的全部文件（超过上限时截断并标记）。
    ///
    /// 按需调用（用户点"查看全部"才进来），不在扫描阶段把所有文件塞进结果里 ——
    /// 单个工具动辄上千个文件，全量返回会让扫描结果变得很大。
    pub fn list_files(&self, path: &Path) -> AiCacheFileList {
        let mut files = Vec::new();
        let mut truncated = false;
        for entry in WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
        {
            if files.len() >= MAX_LISTED_FILES {
                truncated = true;
                break;
            }
            if let Ok(metadata) = entry.metadata() {
                files.push(AiCacheFile {
                    path: entry.path().to_string_lossy().to_string(),
                    size: metadata.len(),
                });
            }
        }
        AiCacheFileList { files, truncated }
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

/// 目录名是否可清理：全局白名单，或这个工具额外授权的名字。
fn is_cleanable_name(name: &str, extra_names: &[&str]) -> bool {
    CLEANABLE_DIR_NAMES.contains(&name) || extra_names.contains(&name)
}

/// 忽略大小写地判断 `path` 是否位于 `root` 之下。
///
/// 必须忽略大小写：扫描拿到的是磁盘上的**真实**目录名，而清单里写的是固定字面量。
/// 两者大小写不一致时 `Path::starts_with` 会判定"不在根目录下"，
/// 表现是「能扫到、选得中、删不掉」，界面还只会报个 0。
fn starts_with_ignore_case(path: &Path, root: &Path) -> bool {
    let mut path_components = path.components();
    for root_component in root.components() {
        let Some(path_component) = path_components.next() else {
            return false;
        };
        let path_part = path_component.as_os_str().to_string_lossy();
        let root_part = root_component.as_os_str().to_string_lossy();
        if !path_part.eq_ignore_ascii_case(&root_part) {
            return false;
        }
    }
    true
}
