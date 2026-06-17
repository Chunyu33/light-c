// ============================================================================
// C 盘全盘快照
//
// 全盘分析的数据量比 ProgramData 大得多，目录对比走聚合快照；文件级明细只保存轻量字段，
// 并通过懒加载命令按目录查询，避免主扫描响应携带几十万条文件记录。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use super::mft_scan::{normalize_path, DirSizeEntry, FileSnapshotEntry, FullDiskScanResult};

const SNAPSHOT_DIR: &str = "disk_growth_snapshots";
const SNAPSHOT_PREFIX: &str = "disk_growth_";
const SNAPSHOT_SUFFIX: &str = ".json";
const MAX_SNAPSHOTS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskSnapshotEntry {
    pub path: String,
    pub size: u64,
    pub depth: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskSnapshot {
    pub timestamp: i64,
    pub date: String,
    pub total_size: u64,
    pub total_files_scanned: usize,
    pub root_path: String,
    pub entries: Vec<DiskSnapshotEntry>,
    #[serde(default)]
    pub file_entries: Vec<FileSnapshotEntry>,
    pub version: u8,
}

pub struct DiskSnapshotManager {
    snapshot_dir: PathBuf,
}

impl DiskSnapshotManager {
    pub fn new() -> Result<Self, String> {
        let snapshot_dir = crate::data_dir::get_data_dir().join(SNAPSHOT_DIR);
        fs::create_dir_all(&snapshot_dir)
            .map_err(|e| format!("创建全盘快照目录失败: {}", e))?;
        Ok(Self { snapshot_dir })
    }

    pub fn save_snapshot(&self, snapshot: &DiskSnapshot) -> Result<PathBuf, String> {
        let filename = format!(
            "{}{}{}",
            SNAPSHOT_PREFIX,
            chrono::Local::now().format("%Y%m%d_%H%M%S"),
            SNAPSHOT_SUFFIX
        );
        let path = self.snapshot_dir.join(filename);
        let json = serde_json::to_string(snapshot)
            .map_err(|e| format!("序列化全盘快照失败: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("写入全盘快照失败: {}", e))?;
        self.cleanup_old_snapshots()?;
        Ok(path)
    }

    pub fn load_latest_snapshot(&self) -> Result<Option<DiskSnapshot>, String> {
        let snapshots = self.list_snapshots()?;
        let Some(path) = snapshots.first() else {
            return Ok(None);
        };
        self.load_snapshot(path)
    }

    pub fn load_latest_two_snapshots(&self) -> Result<Option<(DiskSnapshot, DiskSnapshot)>, String> {
        let snapshots = self.list_snapshots()?;
        if snapshots.len() < 2 {
            return Ok(None);
        }

        let Some(current) = self.load_snapshot(&snapshots[0])? else {
            return Ok(None);
        };
        let Some(previous) = self.load_snapshot(&snapshots[1])? else {
            return Ok(None);
        };
        Ok(Some((previous, current)))
    }

    fn list_snapshots(&self) -> Result<Vec<PathBuf>, String> {
        let mut snapshots = Vec::new();
        let entries = fs::read_dir(&self.snapshot_dir)
            .map_err(|e| format!("读取全盘快照目录失败: {}", e))?;

        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name.starts_with(SNAPSHOT_PREFIX) && name.ends_with(SNAPSHOT_SUFFIX) {
                snapshots.push(path);
            }
        }

        snapshots.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        Ok(snapshots)
    }

    fn load_snapshot(&self, path: &Path) -> Result<Option<DiskSnapshot>, String> {
        if !path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(path)
            .map_err(|e| format!("读取全盘快照失败 {}: {}", path.display(), e))?;
        let snapshot = serde_json::from_str::<DiskSnapshot>(&content)
            .map_err(|e| format!("解析全盘快照失败 {}: {}", path.display(), e))?;
        Ok(Some(snapshot))
    }

    fn cleanup_old_snapshots(&self) -> Result<(), String> {
        let snapshots = self.list_snapshots()?;
        if snapshots.len() <= MAX_SNAPSHOTS {
            return Ok(());
        }

        for path in snapshots.iter().skip(MAX_SNAPSHOTS) {
            if let Err(error) = fs::remove_file(path) {
                log::warn!("删除旧全盘快照失败 {}: {}", path.display(), error);
            }
        }

        Ok(())
    }
}

pub fn build_snapshot(scan: &FullDiskScanResult) -> DiskSnapshot {
    let now = chrono::Local::now();
    DiskSnapshot {
        timestamp: now.timestamp_millis(),
        date: now.format("%Y-%m-%d %H:%M:%S").to_string(),
        total_size: scan.total_size,
        total_files_scanned: scan.total_files_scanned,
        root_path: scan.root_path.clone(),
        entries: scan
            .entries
            .iter()
            .map(snapshot_entry_from_dir)
            .collect(),
        file_entries: scan.file_entries.clone(),
        version: 2,
    }
}

fn snapshot_entry_from_dir(entry: &DirSizeEntry) -> DiskSnapshotEntry {
    DiskSnapshotEntry {
        path: normalize_path(&entry.path),
        size: entry.size,
        depth: entry.depth,
    }
}
