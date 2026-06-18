use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use super::mft_scan::{
    normalize_path, DirSizeEntry, FileSizeRecord, FileSnapshotEntry, FullDiskScanResult,
};

const SNAPSHOT_DIR: &str = "disk_growth_snapshots";
const SNAPSHOT_PREFIX: &str = "disk_growth_";
const SNAPSHOT_SUFFIX: &str = ".json";
// 文件级明细体量远大于目录聚合快照，单独落到同名 .files 分片目录，避免主 JSON 过大。
const FILE_SHARD_SUFFIX: &str = "files";
// 256 个桶能让百万级文件分散到较小 JSONL 文件，同时不会产生过多目录项。
const FILE_SHARD_BUCKETS: u64 = 256;
const MAX_SNAPSHOTS: usize = 3;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskFileShardEntry {
    // parent 和 name 分开存储，减少每行重复完整路径带来的快照膨胀。
    pub parent: String,
    pub name: String,
    pub size: u64,
}

pub struct DiskSnapshotManager {
    snapshot_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DiskSnapshotHandle {
    // 明细查询需要同时知道快照内容和快照文件路径，才能定位旁路分片目录。
    pub snapshot: DiskSnapshot,
    pub path: PathBuf,
}

impl DiskSnapshotManager {
    pub fn new() -> Result<Self, String> {
        let snapshot_dir = crate::data_dir::get_data_dir().join(SNAPSHOT_DIR);
        fs::create_dir_all(&snapshot_dir).map_err(|e| format!("创建全盘快照目录失败: {}", e))?;
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
        let json =
            serde_json::to_string(snapshot).map_err(|e| format!("序列化全盘快照失败: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("写入全盘快照失败: {}", e))?;
        Ok(path)
    }

    pub fn save_scan_snapshot(
        &self,
        scan: &FullDiskScanResult,
        file_records: Vec<FileSizeRecord>,
    ) -> Result<PathBuf, String> {
        let snapshot = build_snapshot(scan);
        let path = self.save_snapshot(&snapshot)?;
        // 文件级明细单独按目录分片保存，避免主 JSON 在百万文件场景下膨胀到数百 MB。
        if let Err(error) = self.save_file_shards(&path, file_records) {
            // 主快照和文件分片必须成对成功，否则明细查询会拿到不完整的新快照。
            let _ = fs::remove_file(&path);
            let _ = fs::remove_dir_all(self.file_shard_dir(&path));
            return Err(error);
        }
        // 清理放在整组快照写入成功之后，避免磁盘满等异常导致旧快照被提前删掉。
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

    pub fn load_latest_two_snapshots(
        &self,
    ) -> Result<Option<(DiskSnapshot, DiskSnapshot)>, String> {
        Ok(self
            .load_latest_two_snapshot_handles()?
            .map(|(previous, current)| (previous.snapshot, current.snapshot)))
    }

    pub fn load_latest_two_snapshot_handles(
        &self,
    ) -> Result<Option<(DiskSnapshotHandle, DiskSnapshotHandle)>, String> {
        let snapshots = self.list_snapshots()?;
        if snapshots.len() < 2 {
            return Ok(None);
        }

        let Some(current) = self.load_snapshot_handle(&snapshots[0])? else {
            return Ok(None);
        };
        let Some(previous) = self.load_snapshot_handle(&snapshots[1])? else {
            return Ok(None);
        };
        Ok(Some((previous, current)))
    }

    fn list_snapshots(&self) -> Result<Vec<PathBuf>, String> {
        let mut snapshots = Vec::new();
        let entries =
            fs::read_dir(&self.snapshot_dir).map_err(|e| format!("读取全盘快照目录失败: {}", e))?;

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

    fn load_snapshot_handle(&self, path: &Path) -> Result<Option<DiskSnapshotHandle>, String> {
        let Some(snapshot) = self.load_snapshot(path)? else {
            return Ok(None);
        };
        Ok(Some(DiskSnapshotHandle {
            snapshot,
            path: path.to_path_buf(),
        }))
    }

    pub fn load_file_entries_for_parent(
        &self,
        snapshot_path: &Path,
        snapshot: &DiskSnapshot,
        parent_path: &str,
    ) -> Result<Vec<FileSnapshotEntry>, String> {
        let parent = normalize_path(parent_path)
            .trim_end_matches('/')
            .to_string();
        let shard_dir = self.file_shard_dir(snapshot_path);
        if shard_dir.exists() {
            let shard_path = self.file_shard_path(snapshot_path, &parent);
            if !shard_path.exists() {
                return Ok(Vec::new());
            }
            return self.load_file_shard(&shard_path, &parent);
        }

        // 旧版快照兼容：历史 JSON 里可能仍包含 file_entries，只在没有分片时回退使用。
        Ok(snapshot
            .file_entries
            .iter()
            .filter(|entry| parent_path_of(&entry.path).as_deref() == Some(parent.as_str()))
            .cloned()
            .collect())
    }

    pub fn has_file_detail_storage(&self, snapshot_path: &Path, snapshot: &DiskSnapshot) -> bool {
        // 新版快照使用旁路分片，旧版快照可能仍把文件级明细塞在主 JSON 里；两者都算可查询。
        self.file_shard_dir(snapshot_path).exists() || !snapshot.file_entries.is_empty()
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
            if let Err(error) = fs::remove_dir_all(self.file_shard_dir(path)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("删除旧全盘文件分片失败 {}: {}", path.display(), error);
                }
            }
        }

        Ok(())
    }

    fn save_file_shards(
        &self,
        snapshot_path: &Path,
        entries: Vec<FileSizeRecord>,
    ) -> Result<(), String> {
        let dir = self.file_shard_dir(snapshot_path);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("清理旧文件级快照分片失败 {}: {}", dir.display(), e))?;
        }
        fs::create_dir_all(&dir)
            .map_err(|e| format!("创建文件级快照分片目录失败 {}: {}", dir.display(), e))?;

        let mut writers: Vec<Option<BufWriter<File>>> =
            (0..FILE_SHARD_BUCKETS).map(|_| None).collect();

        for entry in entries {
            let Some(parent) = parent_path_of(&entry.path) else {
                continue;
            };
            let name = display_name_from_path(&entry.path);
            let bucket = shard_bucket(&parent) as usize;
            if writers[bucket].is_none() {
                let path = dir.join(format!("{:03}.jsonl", bucket));
                let file = File::create(&path)
                    .map_err(|e| format!("创建文件级快照分片失败 {}: {}", path.display(), e))?;
                writers[bucket] = Some(BufWriter::new(file));
            }

            let Some(writer) = writers[bucket].as_mut() else {
                continue;
            };
            let row = DiskFileShardEntry {
                parent,
                name,
                size: entry.size,
            };
            serde_json::to_writer(&mut *writer, &row)
                .map_err(|e| format!("写入文件级快照分片失败: {}", e))?;
            writer
                .write_all(b"\n")
                .map_err(|e| format!("写入文件级快照分片失败: {}", e))?;
        }

        for writer in writers.into_iter().flatten() {
            writer
                .into_inner()
                .map_err(|e| format!("刷新文件级快照分片失败: {}", e))?;
        }

        Ok(())
    }

    fn load_file_shard(
        &self,
        shard_path: &Path,
        parent_path: &str,
    ) -> Result<Vec<FileSnapshotEntry>, String> {
        let file = File::open(shard_path)
            .map_err(|e| format!("读取文件级快照分片失败 {}: {}", shard_path.display(), e))?;
        let reader = BufReader::new(file);
        let mut entries = Vec::new();

        for line in reader.lines() {
            let line = line
                .map_err(|e| format!("读取文件级快照分片失败 {}: {}", shard_path.display(), e))?;
            if line.trim().is_empty() {
                continue;
            }
            let row: DiskFileShardEntry = serde_json::from_str(&line)
                .map_err(|e| format!("解析文件级快照分片失败 {}: {}", shard_path.display(), e))?;
            if row.parent == parent_path {
                entries.push(FileSnapshotEntry {
                    path: format!("{}/{}", row.parent.trim_end_matches('/'), row.name),
                    size: row.size,
                });
            }
        }

        Ok(entries)
    }

    fn file_shard_dir(&self, snapshot_path: &Path) -> PathBuf {
        snapshot_path.with_extension(FILE_SHARD_SUFFIX)
    }

    fn file_shard_path(&self, snapshot_path: &Path, parent_path: &str) -> PathBuf {
        self.file_shard_dir(snapshot_path)
            .join(format!("{:03}.jsonl", shard_bucket(parent_path)))
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
        entries: scan.entries.iter().map(snapshot_entry_from_dir).collect(),
        // 文件级明细已拆到旁路分片文件，主 JSON 只保留目录聚合快照，避免极端文件数下主快照过大。
        file_entries: Vec::new(),
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

fn parent_path_of(path: &str) -> Option<String> {
    let normalized = normalize_path(path).trim_end_matches('/').to_string();
    normalized
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .filter(|parent| !parent.is_empty())
}

fn display_name_from_path(path: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn shard_bucket(parent_path: &str) -> u64 {
    // 分片文件是持久化数据，不能依赖 std::DefaultHasher 这类实现细节不稳定的哈希器。
    let mut hash = 0xcbf29ce484222325u64;
    for byte in parent_path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash % FILE_SHARD_BUCKETS
}
