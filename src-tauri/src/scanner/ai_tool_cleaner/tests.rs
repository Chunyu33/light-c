//! 白名单边界与异常输入。

use super::super::AiToolScanner;
use std::fs;
use std::path::{Path, PathBuf};

/// 与 `AiToolScanner::new` 相同的取值方式，供路径校验用例拼真实目录。
fn user_profile() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| r"C:\Users\Default".to_string()))
}

fn appdata() -> PathBuf {
    std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| user_profile().join("AppData").join("Roaming"))
}

/// 白名单之外的目录必须被忽略 —— 这条是安全底线：
/// 删错会话历史或凭据的代价，远大于少省几个 G。
#[test]
fn only_whitelisted_directories_are_collected() {
    let base = std::env::temp_dir().join("lightc-ai-clean-test");
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join("Cache")).unwrap();
    fs::create_dir_all(base.join("sessions")).unwrap();
    // Chromium 新版着色器缓存：本轮补进白名单，这里顺带钉住
    fs::create_dir_all(base.join("ShaderCache")).unwrap();
    fs::write(base.join("Cache").join("a.bin"), vec![0u8; 1024]).unwrap();
    fs::write(base.join("sessions").join("chat.db"), vec![0u8; 4096]).unwrap();
    fs::write(base.join("ShaderCache").join("s.bin"), vec![0u8; 256]).unwrap();

    let scanner = AiToolScanner::new();
    let mut entries = Vec::new();
    scanner.collect_cleanable_children(&base, &[], &mut entries);

    assert_eq!(entries.len(), 2, "只应命中 Cache 与 ShaderCache");
    let cache = entries.iter().find(|entry| entry.name == "Cache").unwrap();
    assert_eq!(cache.file_count, 1);
    assert_eq!(cache.size, 1024);

    let _ = fs::remove_dir_all(&base);
}

/// 工具私有的额外目录名（Codex 的 `.tmp`）只在这个工具下生效。
#[test]
fn extra_names_only_apply_when_requested() {
    let base = std::env::temp_dir().join("lightc-ai-clean-extra");
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join(".tmp")).unwrap();
    fs::write(base.join(".tmp").join("a.bin"), vec![0u8; 128]).unwrap();

    let scanner = AiToolScanner::new();

    // 不给额外名单：`.tmp` 不算缓存（别的工具里它可能是重要暂存区）
    let mut without = Vec::new();
    scanner.collect_cleanable_children(&base, &[], &mut without);
    assert!(without.is_empty(), "`.tmp` 不该进全局白名单");

    // 给了额外名单：才算
    let mut with = Vec::new();
    scanner.collect_cleanable_children(&base, &[".tmp"], &mut with);
    assert_eq!(with.len(), 1);
    assert_eq!(with[0].name, ".tmp");

    let _ = fs::remove_dir_all(&base);
}

/// 目录不存在时不能 panic，也不能返回空以外的副作用。
#[test]
fn missing_root_is_ignored() {
    let scanner = AiToolScanner::new();
    let mut entries = Vec::new();
    scanner.collect_cleanable_children(Path::new(r"Z:\definitely-not-exists"), &[], &mut entries);
    assert!(entries.is_empty());
}

/// 扩展 / 插件 / 依赖目录里的 `cache` 不能被当成可清理缓存。
///
/// 这不是假设出来的场景：VS Code 系客户端的扩展是
/// `extensions/<扩展名>/node_modules/<包>/cache` 这样的嵌套结构，
/// 按目录名匹配的话正好会命中，删掉整段扩展依赖就废了。
#[test]
fn cache_inside_extension_or_plugin_dirs_is_skipped() {
    let base = std::env::temp_dir().join("lightc-ai-clean-skip");
    let _ = fs::remove_dir_all(&base);

    // 真正该清理的：根目录下的 Cache
    fs::create_dir_all(base.join("Cache")).unwrap();
    fs::write(base.join("Cache").join("a.bin"), vec![0u8; 512]).unwrap();

    // 不该清理的三种嵌套：扩展依赖、插件、git 版本库
    for path in [
        base.join("extensions")
            .join("foo.pkg")
            .join("node_modules")
            .join("bar")
            .join("cache"),
        base.join("plugins").join("cache"),
        base.join(".git").join("logs"),
    ] {
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("x.bin"), vec![0u8; 4096]).unwrap();
    }

    let scanner = AiToolScanner::new();
    let mut entries = Vec::new();
    scanner.collect_cleanable_children(&base, &[], &mut entries);

    assert_eq!(entries.len(), 1, "只有根目录下的 Cache 应该被收集");
    assert_eq!(entries[0].name, "Cache");

    let _ = fs::remove_dir_all(&base);
}

/// 路径里带 `..` 时必须拒绝。
///
/// `Path::starts_with` 是词法比较，`...\Cursor\Cache\..\..\..\logs` 会被判定
/// 在根目录之下，而 `remove_dir_all` 按解析后的真实路径动手 ——
/// 少了这道判断，前缀校验就形同虚设。
#[test]
fn path_traversal_is_rejected() {
    let scanner = AiToolScanner::new();
    let root = appdata().join("Cursor");

    // 正常情况：根目录下的缓存目录是托管的
    assert!(scanner.is_managed_cache_dir(&root.join("Cache")));

    // 用 `..` 跳出根目录，名字仍伪装成白名单里的 logs
    let escaped = root
        .join("Cache")
        .join("..")
        .join("..")
        .join("..")
        .join("logs");
    assert!(!scanner.is_managed_cache_dir(&escaped), "带 `..` 的路径必须拒绝");

    // 根目录本身永远不能删
    assert!(!scanner.is_managed_cache_dir(&root));
}

/// 路径大小写不一致时仍然要认。
///
/// 扫描拿到的是磁盘上的真实目录名，清单里是固定字面量；两者不一致时
/// `Path::starts_with` 会让删除被静默拒绝（界面只报 0），所以比较必须忽略大小写。
#[test]
fn root_match_ignores_case() {
    let scanner = AiToolScanner::new();
    // 清单里写的是 "Cursor"，这里模拟磁盘上是 "CURSOR"
    assert!(scanner.is_managed_cache_dir(&appdata().join("CURSOR").join("Cache")));
    // 同理验证用户目录下的点目录
    assert!(scanner.is_managed_cache_dir(&user_profile().join(".CODEX").join("cache")));
}

/// 非托管路径必须被拒绝并计入失败列表。
///
/// 界面要靠这个列表说"没删掉"，所以拒绝也必须走同一条返回通道，
/// 不能只 log 一下就当成成功。
#[test]
fn delete_reports_unmanaged_paths_as_failures() {
    let scanner = AiToolScanner::new();
    // 名字在白名单里（logs），但不在任何工具的根目录下
    let target = std::env::temp_dir().join("logs");
    let result = scanner.delete_dirs(&[target.to_string_lossy().to_string()]);

    assert_eq!(result.deleted, 0);
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].reason, "不在可清理范围内");
}

/// Codex 的 `.tmp` 只在 Codex 名下算缓存。
#[test]
fn extra_names_are_scoped_to_their_tool() {
    let scanner = AiToolScanner::new();
    assert!(scanner.is_managed_cache_dir(&user_profile().join(".codex").join(".tmp")));
    assert!(!scanner.is_managed_cache_dir(&appdata().join("devin").join(".tmp")));
}

/// 豆包的目录结构：缓存埋在 `User Data\Default` 里，运行时要分开对待。
///
/// 这条钉的是三个容易搞错的点：
/// 1. 多层嵌套（`Doubao\User Data\Default\Cache`）必须能扫到，否则豆包会显示 0；
/// 2. `sandbox_runtime\downloads` 是**这个工具授权**的可清目录（运行时安装包，本机 234MB），
///    但它不在全局白名单里 —— 别的工具叫这个名字时可能是用户的下载目录；
/// 3. `sandbox_runtime\bases`（正在用的运行时）和 `Default\sandbox_envs_dir`（会话环境）
///    删了功能就用不了，无论如何都不能进名单。
#[test]
fn doubao_layout_separates_cache_from_sandbox_runtime() {
    let base = std::env::temp_dir().join("lightc-ai-clean-doubao");
    let _ = fs::remove_dir_all(&base);
    let user_data = base.join("User Data");
    let default = user_data.join("Default");

    fs::create_dir_all(default.join("Cache")).unwrap();
    fs::create_dir_all(default.join("GPUCache")).unwrap();
    fs::create_dir_all(default.join("Cache").join("nested")).unwrap();
    fs::create_dir_all(user_data.join("sandbox_runtime").join("bases").join("hash")).unwrap();
    fs::create_dir_all(user_data.join("sandbox_runtime").join("downloads")).unwrap();
    fs::create_dir_all(default.join("sandbox_envs_dir").join("envs")).unwrap();
    fs::create_dir_all(user_data.join("gecko_cache")).unwrap();

    fs::write(default.join("Cache").join("a.bin"), vec![0u8; 2048]).unwrap();
    fs::write(default.join("GPUCache").join("g.bin"), vec![0u8; 512]).unwrap();
    fs::write(
        user_data.join("sandbox_runtime").join("downloads").join("runtime.tar"),
        vec![0u8; 4096],
    )
    .unwrap();
    fs::write(user_data.join("gecko_cache").join("gecko2.db"), vec![0u8; 1024]).unwrap();

    let scanner = AiToolScanner::new();

    // ① 豆包自己的名单：downloads 算，bases / sandbox_envs_dir / gecko_cache 不算
    let mut entries = Vec::new();
    scanner.collect_cleanable_children(&base, &["downloads"], &mut entries);

    let mut names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["Cache", "GPUCache", "downloads"]);
    assert_eq!(
        entries.iter().map(|entry| entry.size).sum::<u64>(),
        2048 + 512 + 4096,
        "bases / sandbox_envs_dir / gecko_cache 不计入体积"
    );

    // ② 不给额外名单（其它工具）：downloads 不算。防止有人把它塞进全局白名单
    let mut without = Vec::new();
    scanner.collect_cleanable_children(&base, &[], &mut without);
    assert!(
        without.iter().all(|entry| entry.name != "downloads"),
        "downloads 只能按工具授权，不能进全局白名单"
    );

    let _ = fs::remove_dir_all(&base);
}
