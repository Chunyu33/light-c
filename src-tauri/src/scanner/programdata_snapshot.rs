// ============================================================================
// ProgramData 快照系统
// 轻量级历史数据记录，用于追踪目录大小变化
// 只保存关键数据：一级目录 + Top50 + 命中规则的目录
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ============================================================================
// 配置常量
// ============================================================================

/// 快照目录名
const SNAPSHOT_DIR: &str = "snapshots";

/// 快照文件前缀
const SNAPSHOT_PREFIX: &str = "snapshot_";

/// 快照文件后缀
const SNAPSHOT_SUFFIX: &str = ".json";

/// 最大保留快照数量
const MAX_SNAPSHOTS: usize = 3;

/// Top N 最大目录数量
const TOP_N_ENTRIES: usize = 50;

// ============================================================================
// 数据结构定义
// ============================================================================

/// 快照条目（极简结构，只保存必要数据）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotEntry {
    /// 目录路径（相对于 ProgramData）
    pub path: String,
    /// 目录大小（字节）
    pub size: u64,
}

/// 快照数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    /// 快照时间戳（Unix 毫秒）
    pub timestamp: i64,
    /// 快照日期（YYYY-MM-DD 格式，用于文件名）
    pub date: String,
    /// ProgramData 总大小
    pub total_size: u64,
    /// 目录条目列表
    pub entries: Vec<SnapshotEntry>,
    /// 快照版本（用于兼容性）
    #[serde(default = "default_version")]
    pub version: u8,
}

fn default_version() -> u8 {
    1
}

/// 快照构建器（用于从扫描结果构建快照）
#[derive(Debug, Default)]
pub struct SnapshotBuilder {
    /// 一级目录
    first_level: Vec<SnapshotEntry>,
    /// 命中规则的目录
    matched_rules: Vec<SnapshotEntry>,
    /// 总大小
    total_size: u64,
}

impl SnapshotBuilder {
    /// 创建新的构建器
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置总大小
    pub fn total_size(mut self, size: u64) -> Self {
        self.total_size = size;
        self
    }

    /// 添加一级目录
    pub fn add_first_level(&mut self, path: &str, size: u64) {
        self.first_level.push(SnapshotEntry {
            path: normalize_path(path),
            size,
        });
    }

    /// 添加命中规则的目录
    pub fn add_matched_rule(&mut self, path: &str, size: u64) {
        self.matched_rules.push(SnapshotEntry {
            path: normalize_path(path),
            size,
        });
    }

    /// 批量添加一级目录
    pub fn with_first_level_entries(mut self, entries: Vec<(String, u64)>) -> Self {
        for (path, size) in entries {
            self.add_first_level(&path, size);
        }
        self
    }

    /// 批量添加命中规则的目录
    pub fn with_matched_entries(mut self, entries: Vec<(String, u64)>) -> Self {
        for (path, size) in entries {
            self.add_matched_rule(&path, size);
        }
        self
    }

    /// 构建快照
    pub fn build(self) -> Snapshot {
        // 合并所有条目并去重
        let mut all_entries: Vec<SnapshotEntry> = Vec::new();
        let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 先添加一级目录（优先保留）
        for entry in self.first_level {
            if seen_paths.insert(entry.path.clone()) {
                all_entries.push(entry);
            }
        }

        // 添加命中规则的目录
        for entry in self.matched_rules {
            if seen_paths.insert(entry.path.clone()) {
                all_entries.push(entry);
            }
        }

        // 按大小降序排序
        all_entries.sort_by(|a, b| b.size.cmp(&a.size));

        // 只保留 Top N
        all_entries.truncate(TOP_N_ENTRIES);

        // 生成时间戳和日期
        let now = chrono::Local::now();
        let timestamp = now.timestamp_millis();
        let date = now.format("%Y-%m-%d").to_string();

        Snapshot {
            timestamp,
            date,
            total_size: self.total_size,
            entries: all_entries,
            version: 1,
        }
    }
}

// ============================================================================
// 快照管理器
// ============================================================================

/// 快照管理器
pub struct SnapshotManager {
    /// 快照存储目录
    snapshot_dir: PathBuf,
}

impl SnapshotManager {
    /// 创建快照管理器（使用默认路径）
    pub fn new() -> Result<Self, SnapshotError> {
        let app_data = get_app_data_dir()?;
        let snapshot_dir = app_data.join(SNAPSHOT_DIR);
        
        // 确保目录存在
        if !snapshot_dir.exists() {
            fs::create_dir_all(&snapshot_dir)
                .map_err(|e| SnapshotError::IoError(format!("创建快照目录失败: {}", e)))?;
        }

        Ok(Self { snapshot_dir })
    }

    /// 使用自定义路径创建快照管理器
    pub fn with_path(path: PathBuf) -> Result<Self, SnapshotError> {
        if !path.exists() {
            fs::create_dir_all(&path)
                .map_err(|e| SnapshotError::IoError(format!("创建快照目录失败: {}", e)))?;
        }
        Ok(Self { snapshot_dir: path })
    }

    /// 保存快照
    pub fn save_snapshot(&self, snapshot: &Snapshot) -> Result<PathBuf, SnapshotError> {
        // 生成文件名
        let filename = format!("{}{}{}", SNAPSHOT_PREFIX, snapshot.date, SNAPSHOT_SUFFIX);
        let filepath = self.snapshot_dir.join(&filename);

        // 序列化为 JSON（紧凑格式，减小文件大小）
        let json = serde_json::to_string(snapshot)
            .map_err(|e| SnapshotError::SerializeError(e.to_string()))?;

        // 写入文件
        fs::write(&filepath, json)
            .map_err(|e| SnapshotError::IoError(format!("写入快照失败: {}", e)))?;

        // 清理旧快照
        self.cleanup_old_snapshots()?;

        log::info!("快照已保存: {}", filepath.display());
        Ok(filepath)
    }

    /// 加载最新快照
    pub fn load_latest_snapshot(&self) -> Result<Option<Snapshot>, SnapshotError> {
        let snapshots = self.list_snapshots()?;
        
        if snapshots.is_empty() {
            return Ok(None);
        }

        // 获取最新的快照文件
        let latest = &snapshots[0];
        self.load_snapshot(latest)
    }

    /// 加载指定日期的快照
    pub fn load_snapshot_by_date(&self, date: &str) -> Result<Option<Snapshot>, SnapshotError> {
        let filename = format!("{}{}{}", SNAPSHOT_PREFIX, date, SNAPSHOT_SUFFIX);
        let filepath = self.snapshot_dir.join(&filename);
        
        if !filepath.exists() {
            return Ok(None);
        }

        self.load_snapshot(&filepath)
    }

    /// 加载所有快照（按时间降序）
    pub fn load_all_snapshots(&self) -> Result<Vec<Snapshot>, SnapshotError> {
        let snapshots = self.list_snapshots()?;
        let mut results = Vec::new();

        for path in snapshots {
            if let Ok(Some(snapshot)) = self.load_snapshot(&path) {
                results.push(snapshot);
            }
        }

        Ok(results)
    }

    /// 列出所有快照文件（按时间降序）
    pub fn list_snapshots(&self) -> Result<Vec<PathBuf>, SnapshotError> {
        let mut snapshots: Vec<PathBuf> = Vec::new();

        let entries = fs::read_dir(&self.snapshot_dir)
            .map_err(|e| SnapshotError::IoError(format!("读取快照目录失败: {}", e)))?;

        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                if filename.starts_with(SNAPSHOT_PREFIX) && filename.ends_with(SNAPSHOT_SUFFIX) {
                    snapshots.push(path);
                }
            }
        }

        // 按文件名降序排序（日期越新越靠前）
        snapshots.sort_by(|a, b| b.file_name().cmp(&a.file_name()));

        Ok(snapshots)
    }

    /// 加载单个快照文件
    fn load_snapshot(&self, path: &Path) -> Result<Option<Snapshot>, SnapshotError> {
        if !path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(path)
            .map_err(|e| SnapshotError::IoError(format!("读取快照文件失败: {}", e)))?;

        let snapshot: Snapshot = serde_json::from_str(&content)
            .map_err(|e| SnapshotError::ParseError(format!("解析快照失败: {}", e)))?;

        Ok(Some(snapshot))
    }

    /// 清理旧快照（只保留最近 N 个）
    fn cleanup_old_snapshots(&self) -> Result<(), SnapshotError> {
        let snapshots = self.list_snapshots()?;

        if snapshots.len() <= MAX_SNAPSHOTS {
            return Ok(());
        }

        // 删除多余的旧快照
        for path in snapshots.iter().skip(MAX_SNAPSHOTS) {
            if let Err(e) = fs::remove_file(path) {
                log::warn!("删除旧快照失败: {} - {}", path.display(), e);
            } else {
                log::info!("已删除旧快照: {}", path.display());
            }
        }

        Ok(())
    }

    /// 获取快照目录路径
    pub fn snapshot_dir(&self) -> &Path {
        &self.snapshot_dir
    }

    /// 检查是否存在今日快照
    pub fn has_today_snapshot(&self) -> Result<bool, SnapshotError> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let filename = format!("{}{}{}", SNAPSHOT_PREFIX, today, SNAPSHOT_SUFFIX);
        let filepath = self.snapshot_dir.join(&filename);
        Ok(filepath.exists())
    }
}

impl Default for SnapshotManager {
    fn default() -> Self {
        Self::new().expect("无法创建快照管理器")
    }
}

// ============================================================================
// 错误类型
// ============================================================================

/// 快照错误
#[derive(Debug, Clone)]
pub enum SnapshotError {
    /// IO 错误
    IoError(String),
    /// 序列化错误
    SerializeError(String),
    /// 解析错误
    ParseError(String),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotError::IoError(msg) => write!(f, "IO 错误: {}", msg),
            SnapshotError::SerializeError(msg) => write!(f, "序列化错误: {}", msg),
            SnapshotError::ParseError(msg) => write!(f, "解析错误: {}", msg),
        }
    }
}

impl std::error::Error for SnapshotError {}

// ============================================================================
// 辅助函数
// ============================================================================

/// 获取应用数据目录
fn get_app_data_dir() -> Result<PathBuf, SnapshotError> {
    // 优先使用 dirs crate 获取 LocalAppData
    if let Some(local_data) = dirs::data_local_dir() {
        return Ok(local_data.join("LightC"));
    }

    // 回退：使用环境变量
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data).join("LightC"));
    }

    Err(SnapshotError::IoError("无法获取应用数据目录".to_string()))
}

/// 标准化路径（移除 ProgramData 前缀，统一格式）
fn normalize_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    
    // 移除 C:/ProgramData/ 前缀
    let prefixes = [
        "c:/programdata/",
        "C:/ProgramData/",
        "c:\\programdata\\",
        "C:\\ProgramData\\",
    ];
    
    for prefix in prefixes {
        if let Some(stripped) = path.strip_prefix(prefix) {
            return stripped.to_string();
        }
    }
    
    // 如果没有前缀，返回原路径
    path
}

// ============================================================================
// 公共 API
// ============================================================================

/// 保存快照（简化 API）
pub fn save_snapshot(snapshot: &Snapshot) -> Result<PathBuf, SnapshotError> {
    let manager = SnapshotManager::new()?;
    manager.save_snapshot(snapshot)
}

/// 加载最新快照（简化 API）
pub fn load_latest_snapshot() -> Result<Option<Snapshot>, SnapshotError> {
    let manager = SnapshotManager::new()?;
    manager.load_latest_snapshot()
}

/// 加载所有快照（简化 API）
pub fn load_all_snapshots() -> Result<Vec<Snapshot>, SnapshotError> {
    let manager = SnapshotManager::new()?;
    manager.load_all_snapshots()
}

/// 检查是否有今日快照
pub fn has_today_snapshot() -> Result<bool, SnapshotError> {
    let manager = SnapshotManager::new()?;
    manager.has_today_snapshot()
}

/// 从扫描结果快速创建快照
/// 
/// # 参数
/// - `entries`: 目录列表 (路径, 大小)
/// - `total_size`: 总大小
/// - `matched_paths`: 命中规则的路径列表
pub fn create_snapshot_from_scan(
    entries: &[(String, u64)],
    total_size: u64,
    matched_paths: &[String],
) -> Snapshot {
    let matched_set: std::collections::HashSet<&str> = 
        matched_paths.iter().map(|s| s.as_str()).collect();

    let mut builder = SnapshotBuilder::new().total_size(total_size);

    for (path, size) in entries {
        // 一级目录（不包含子路径分隔符的就是一级目录）
        let normalized = normalize_path(path);
        if !normalized.contains('/') {
            builder.add_first_level(path, *size);
        }

        // 命中规则的目录
        if matched_set.contains(path.as_str()) {
            builder.add_matched_rule(path, *size);
        }
    }

    builder.build()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_path() {
        assert_eq!(
            normalize_path("C:\\ProgramData\\Microsoft"),
            "Microsoft"
        );
        assert_eq!(
            normalize_path("c:/programdata/NVIDIA"),
            "NVIDIA"
        );
        assert_eq!(
            normalize_path("SomeDir"),
            "SomeDir"
        );
    }

    #[test]
    fn test_snapshot_builder() {
        let mut builder = SnapshotBuilder::new().total_size(1024 * 1024 * 100);
        builder.add_first_level("C:\\ProgramData\\Microsoft", 50 * 1024 * 1024);
        builder.add_first_level("C:\\ProgramData\\NVIDIA", 30 * 1024 * 1024);
        builder.add_matched_rule("C:\\ProgramData\\Microsoft\\Windows\\WER", 10 * 1024 * 1024);

        let snapshot = builder.build();

        assert_eq!(snapshot.total_size, 100 * 1024 * 1024);
        assert!(snapshot.entries.len() <= TOP_N_ENTRIES);
        assert!(!snapshot.date.is_empty());
    }

    #[test]
    fn test_snapshot_serialization() {
        let snapshot = Snapshot {
            timestamp: 1234567890000,
            date: "2026-04-21".to_string(),
            total_size: 1024 * 1024 * 100,
            entries: vec![
                SnapshotEntry {
                    path: "Microsoft".to_string(),
                    size: 50 * 1024 * 1024,
                },
            ],
            version: 1,
        };

        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(json.contains("Microsoft"));
        assert!(json.contains("2026-04-21"));

        // 反序列化
        let parsed: Snapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.date, "2026-04-21");
        assert_eq!(parsed.entries.len(), 1);
    }
}
