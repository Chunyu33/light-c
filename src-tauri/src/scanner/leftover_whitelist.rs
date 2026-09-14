// ============================================================================
// 卸载残留用户白名单
// ============================================================================
//
// 白名单按完整路径保存，且保护该路径下的全部子项。这样用户可以针对一次
// 误报精确处理，不会因为应用名称相似而扩大保护范围。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const WHITELIST_FILE_NAME: &str = "leftover_whitelist.json";
const WHITELIST_SCHEMA_VERSION: u32 = 1;

/// 串行化读改写操作，避免连续点击或并发命令互相覆盖白名单内容。
static WHITELIST_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverWhitelistEntry {
    pub path: String,
    pub added_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LeftoverWhitelistFile {
    #[serde(default = "default_schema_version")]
    version: u32,
    #[serde(default)]
    entries: Vec<LeftoverWhitelistEntry>,
}

fn default_schema_version() -> u32 {
    WHITELIST_SCHEMA_VERSION
}

fn whitelist_file_path() -> PathBuf {
    crate::data_dir::get_data_dir().join(WHITELIST_FILE_NAME)
}

/// 获取白名单条目，损坏或缺失的文件不会阻断清理主流程。
pub fn list_entries() -> Result<Vec<LeftoverWhitelistEntry>, String> {
    load_entries_from(&whitelist_file_path())
}

/// 添加扫描结果对应的路径。仅接受已存在的绝对路径，避免前端构造无效保护规则。
pub fn add_entry(path: &str) -> Result<LeftoverWhitelistEntry, String> {
    let _guard = WHITELIST_WRITE_LOCK
        .lock()
        .map_err(|_| "卸载残留白名单锁定失败".to_string())?;
    let store_path = whitelist_file_path();
    let normalized_path = normalize_existing_path(path)?;
    let mut entries = load_entries_from(&store_path)?;

    if let Some(entry) = entries
        .iter()
        .find(|entry| normalize_string_path_for_compare(&entry.path) == normalize_string_path_for_compare(&normalized_path))
    {
        return Ok(entry.clone());
    }

    let entry = LeftoverWhitelistEntry {
        path: normalized_path,
        added_at: Utc::now().to_rfc3339(),
    };
    entries.push(entry.clone());
    save_entries_to(&store_path, &entries)?;
    Ok(entry)
}

/// 移除精确白名单项；路径即使已不存在，也允许用户清理过期配置。
pub fn remove_entry(path: &str) -> Result<(), String> {
    let _guard = WHITELIST_WRITE_LOCK
        .lock()
        .map_err(|_| "卸载残留白名单锁定失败".to_string())?;
    let store_path = whitelist_file_path();
    let mut entries = load_entries_from(&store_path)?;
    let previous_len = entries.len();
    // 与 contains_path 使用同一套比较规则：前端传回的路径可能带 `\\?\` 前缀或大小写不同，
    // 直接用原始字符串比较会导致"界面上删掉了、文件里还在"。
    let target = normalize_string_path_for_compare(path);
    entries.retain(|entry| normalize_string_path_for_compare(&entry.path) != target);

    if entries.len() != previous_len {
        save_entries_to(&store_path, &entries)?;
    }
    Ok(())
}

/// 路径匹配使用不区分大小写的目录边界，防止 `App` 误匹配 `AppData`。
pub fn contains_path(entries: &[LeftoverWhitelistEntry], candidate: &Path) -> bool {
    let candidate_path = normalize_path_for_compare(candidate);
    entries.iter().any(|entry| {
        let protected_path = normalize_string_path_for_compare(&entry.path);
        candidate_path == protected_path
            || candidate_path
                .strip_prefix(&protected_path)
                .is_some_and(|suffix| suffix.starts_with('\\'))
    })
}
fn load_entries_from(store_path: &Path) -> Result<Vec<LeftoverWhitelistEntry>, String> {
    if !store_path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(store_path)
        .map_err(|error| format!("读取卸载残留白名单失败 {}: {}", store_path.display(), error))?;
    let file: LeftoverWhitelistFile = serde_json::from_str(&content)
        .map_err(|error| format!("解析卸载残留白名单失败 {}: {}", store_path.display(), error))?;
    Ok(file.entries)
}

fn save_entries_to(store_path: &Path, entries: &[LeftoverWhitelistEntry]) -> Result<(), String> {
    let parent = store_path
        .parent()
        .ok_or_else(|| "卸载残留白名单存储路径无效".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建卸载残留白名单目录失败 {}: {}", parent.display(), error))?;
    let file = LeftoverWhitelistFile {
        version: WHITELIST_SCHEMA_VERSION,
        entries: entries.to_vec(),
    };
    let content = serde_json::to_string_pretty(&file)
        .map_err(|error| format!("序列化卸载残留白名单失败: {}", error))?;
    fs::write(store_path, content)
        .map_err(|error| format!("保存卸载残留白名单失败 {}: {}", store_path.display(), error))
}

fn normalize_existing_path(path: &str) -> Result<String, String> {
    let input = Path::new(path);
    if !input.is_absolute() {
        return Err(format!("白名单路径必须是绝对路径: {}", path));
    }
    let canonical_path = fs::canonicalize(input)
        .map_err(|error| format!("无法确认白名单路径 {}: {}", path, error))?;
    Ok(normalize_path_for_storage(&canonical_path))
}

fn normalize_path_for_storage(path: &Path) -> String {
    trim_trailing_separator(strip_extended_length_prefix(&path.to_string_lossy().replace('/', "\\")))
}

fn normalize_path_for_compare(path: &Path) -> String {
    normalize_path_for_storage(path).to_lowercase()
}

fn normalize_string_path_for_compare(path: &str) -> String {
    trim_trailing_separator(strip_extended_length_prefix(&path.replace('/', "\\"))).to_lowercase()
}

/// 去掉 Windows 扩展长度路径前缀（`\\?\` 与 `\\.\`）。
///
/// 中文说明：白名单入库走 `fs::canonicalize`，Windows 会在绝对路径前加 `\\?\`；
/// 而扫描结果里的路径没有这个前缀，导致字符串比较永远不相等、白名单实际失效。
/// 两边统一去掉前缀后再比较，路径本身不变，只是让两者可比。
fn strip_extended_length_prefix(path: &str) -> String {
    // UNC 长路径 `\\?\UNC\server\share` 还原成 `\\server\share`。
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }
    path.strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix(r"\\.\"))
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

fn trim_trailing_separator(mut path: String) -> String {
    while path.len() > 3 && path.ends_with('\\') {
        path.pop();
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_path_protects_descendants_without_matching_similar_prefixes() {
        let entries = vec![LeftoverWhitelistEntry {
            path: r"C:\Fixture\App".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }];

        assert!(contains_path(&entries, Path::new(r"c:\fixture\app\cache")));
        assert!(contains_path(&entries, Path::new(r"C:\Fixture\App")));
        assert!(!contains_path(&entries, Path::new(r"C:\Fixture\AppData")));
    }

    #[test]
    fn strips_extended_length_path_prefix() {
        // \\?\ 与 \\.\ 前缀必须去掉，否则和扫描结果里的普通路径无法比较。
        assert_eq!(
            strip_extended_length_prefix(r"\\?\C:\Users\Test\AppData\Local\App"),
            r"C:\Users\Test\AppData\Local\App"
        );
        assert_eq!(
            strip_extended_length_prefix(r"\\.\C:\Users\Test"),
            r"C:\Users\Test"
        );
        // UNC 形式要还原成 \\server\share，而不是变成 server\share。
        assert_eq!(
            strip_extended_length_prefix(r"\\?\UNC\server\share\App"),
            r"\\server\share\App"
        );
        // 普通路径保持不变。
        assert_eq!(
            strip_extended_length_prefix(r"C:\Users\Test"),
            r"C:\Users\Test"
        );
    }

    #[test]
    fn canonicalized_whitelist_entry_matches_scanned_path() {
        // 这条是本次白名单失效的回归测试：入库路径来自 fs::canonicalize（Windows 会加 \\?\ 前缀），
        // 扫描路径来自目录遍历（无前缀），两者必须判定为同一路径。
        let root = std::env::temp_dir().join(format!(
            "lightc-whitelist-prefix-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let scanned_directory = root.join("AppData").join("Local").join("SomeApp");
        fs::create_dir_all(&scanned_directory).expect("创建测试目录失败");

        let canonical = fs::canonicalize(&scanned_directory).expect("canonicalize 失败");
        let entries = vec![LeftoverWhitelistEntry {
            path: normalize_path_for_storage(&canonical),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }];

        // 扫描侧给的是未加前缀的路径，也必须命中白名单。
        assert!(
            contains_path(&entries, &scanned_directory),
            "带 \\\\?\\ 前缀的入库路径必须能匹配扫描路径"
        );
        assert!(contains_path(&entries, &scanned_directory.join("cache")));
        assert!(!contains_path(&entries, &root.join("AppData").join("Local").join("OtherApp")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn comparison_ignores_case_separators_and_prefix() {
        // 前端传回的路径可能大小写不同、用正斜杠或带 \\?\ 前缀，都必须视为同一条目，
        // 否则会出现"界面上删掉了、实际上还在"或"保护了但没生效"。
        let stored = r"\\?\C:\Users\Test\AppData\Local\SomeApp";
        let candidates = [
            r"C:\Users\Test\AppData\Local\SomeApp",
            r"c:\users\test\appdata\local\someapp",
            r"C:/Users/Test/AppData/Local/SomeApp",
            r"C:\Users\Test\AppData\Local\SomeApp\",
        ];

        let entries = vec![LeftoverWhitelistEntry {
            path: stored.to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }];
        for candidate in candidates {
            assert!(
                contains_path(&entries, Path::new(candidate)),
                "应命中白名单: {}",
                candidate
            );
            assert_eq!(
                normalize_string_path_for_compare(stored),
                normalize_string_path_for_compare(candidate),
                "比较口径应一致: {}",
                candidate
            );
        }
    }
    #[test]
    fn whitelist_store_round_trip_preserves_entries() {
        let root = std::env::temp_dir().join(format!(
            "lightc-leftover-whitelist-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let store_path = root.join(WHITELIST_FILE_NAME);
        let entries = vec![LeftoverWhitelistEntry {
            path: r"C:\Fixture\App".to_string(),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }];

        save_entries_to(&store_path, &entries).expect("保存测试白名单失败");
        let loaded = load_entries_from(&store_path).expect("读取测试白名单失败");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].path, entries[0].path);

        let _ = fs::remove_dir_all(root);
    }
}
