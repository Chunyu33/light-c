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
