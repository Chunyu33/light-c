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
        .find(|entry| paths_are_equal(&entry.path, &normalized_path))
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
    entries.retain(|entry| !paths_are_equal(&entry.path, path));

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
    trim_trailing_separator(path.to_string_lossy().replace('/', "\\"))
}

fn normalize_path_for_compare(path: &Path) -> String {
    normalize_path_for_storage(path).to_lowercase()
}

fn normalize_string_path_for_compare(path: &str) -> String {
    trim_trailing_separator(path.replace('/', "\\")).to_lowercase()
}

fn trim_trailing_separator(mut path: String) -> String {
    while path.len() > 3 && path.ends_with('\\') {
        path.pop();
    }
    path
}

fn paths_are_equal(left: &str, right: &str) -> bool {
    normalize_string_path_for_compare(left) == normalize_string_path_for_compare(right)
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
