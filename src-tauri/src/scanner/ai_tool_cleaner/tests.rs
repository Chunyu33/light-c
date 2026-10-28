//! 白名单边界与异常输入。

use super::super::AiToolScanner;
use std::fs;
use std::path::Path;

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
        base.join("extensions").join("foo.pkg").join("node_modules").join("bar").join("cache"),
        base.join("plugins").join("cache"),
        base.join(".git").join("logs"),
    ] {
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("x.bin"), vec![0u8; 4096]).unwrap();
    }

    let scanner = AiToolScanner::new();
    let mut entries = Vec::new();
    scanner.collect_cleanable_children(&base, &mut entries);

    assert_eq!(entries.len(), 1, "只有根目录下的 Cache 应该被收集");
    assert_eq!(entries[0].name, "Cache");

    let _ = fs::remove_dir_all(&base);
}
