// ============================================================================
// 大目录分析 MFT 引擎
// 复用 big_files_engine::mft_core 的 USN 枚举与 $MFT 顺序解析能力，避免维护两套 NTFS 解析器。
// ============================================================================

#![cfg(windows)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::time::Instant;

use log::info;

use crate::scanner::big_files_engine::mft_core;
use crate::scanner::hotspot::{is_hotspot_scan_cancelled, FolderStats};

#[derive(Clone)]
struct DirectoryInfo {
    parent_id: u64,
    path: PathBuf,
    depth: u16,
}

#[derive(Clone, Copy, Default)]
struct DirectoryStats {
    total_size: u64,
    file_count: usize,
    last_modified: i64,
}

pub struct MftScanProgress {
    pub stage: &'static str,
    pub message: String,
    pub processed: usize,
    pub stage_elapsed_ms: u64,
}

struct DirectoryIndex {
    directories: HashMap<u64, DirectoryInfo>,
    deepest_depth: u16,
}

struct FileTargets {
    ids: HashSet<u64>,
    parent_pairs: Vec<(u64, u64)>,
}

pub fn scan_via_mft(
    drive_letter: char,
    progress_cb: impl Fn(MftScanProgress),
) -> Result<HashMap<PathBuf, FolderStats>, String> {
    info!(
        "[Hotspot-MFT] 开始扫描 {}:，使用 USN 枚举 + $MFT 大小解析",
        drive_letter
    );

    let handle = mft_core::open_volume(drive_letter)?;
    let stage_start = Instant::now();
    let enumerate_result = mft_core::enumerate_usn_records_v2(handle, &|processed| {
        if is_hotspot_scan_cancelled() {
            return false;
        }
        progress_cb(MftScanProgress {
            stage: "mft",
            message: if processed == 0 {
                "正在枚举 NTFS MFT 文件记录".to_string()
            } else {
                format!("正在枚举 NTFS MFT 文件记录，已处理 {} 条", processed)
            },
            processed,
            stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
        });
        true
    });
    mft_core::close_volume(handle);
    let entries = enumerate_result?;

    info!(
        "[Hotspot-MFT] USN 枚举完成：{} 条记录，开始建立目录索引",
        entries.len()
    );
    let stage_start = Instant::now();
    progress_cb(MftScanProgress {
        stage: "index",
        message: "正在建立目录父子索引".to_string(),
        processed: entries.len(),
        stage_elapsed_ms: 0,
    });
    let directory_index = build_directory_index(&entries, drive_letter);
    let directories = directory_index.directories;
    let file_targets = collect_file_targets(&entries, &directories);
    progress_cb(MftScanProgress {
        stage: "index",
        message: format!(
            "目录索引完成：{} 个目录，{} 个文件",
            directories.len(),
            file_targets.ids.len()
        ),
        processed: directories.len(),
        stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
    });

    info!(
        "[Hotspot-MFT] 目录 {} 个，文件 {} 个，开始顺序解析 $MFT 大小",
        directories.len(),
        file_targets.ids.len()
    );
    let metadata_reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let stage_start = Instant::now();
    let metadata_by_id =
        metadata_reader.read_file_metadata_map(&file_targets.ids, &|processed| {
            if is_hotspot_scan_cancelled() {
                return false;
            }
            progress_cb(MftScanProgress {
                stage: "metadata",
                message: format!("正在顺序解析 $MFT 文件大小，已处理 {} 条记录", processed),
                processed,
                stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
            });
            true
        })?;

    let stage_start = Instant::now();
    progress_cb(MftScanProgress {
        stage: "aggregate",
        message: "正在向上聚合目录大小".to_string(),
        processed: metadata_by_id.len(),
        stage_elapsed_ms: 0,
    });
    let folder_map = aggregate_to_ancestors(
        &directories,
        directory_index.deepest_depth,
        &file_targets.parent_pairs,
        &metadata_by_id,
    );
    progress_cb(MftScanProgress {
        stage: "aggregate",
        message: format!("目录聚合完成：{} 个目录", folder_map.len()),
        processed: folder_map.len(),
        stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
    });
    info!(
        "[Hotspot-MFT] 扫描完成：解析大小 {} 个，聚合目录 {} 个",
        metadata_by_id.len(),
        folder_map.len()
    );

    Ok(folder_map)
}

fn build_directory_index(entries: &[mft_core::MftEntry], drive_letter: char) -> DirectoryIndex {
    let mut directories = HashMap::new();
    let mut children: HashMap<u64, Vec<usize>> = HashMap::with_capacity(entries.len());
    let mut deepest_depth = 0u16;

    for (index, entry) in entries.iter().enumerate() {
        if entry.is_dir {
            children.entry(entry.parent_id).or_default().push(index);
        }
    }

    let root_path = PathBuf::from(format!("{}:\\", drive_letter));
    directories.insert(
        5,
        DirectoryInfo {
            parent_id: 0,
            path: root_path,
            depth: 0,
        },
    );

    let mut queue = VecDeque::new();
    if let Some(root_children) = children.get(&5) {
        queue.extend(root_children.iter().copied());
    }

    while let Some(index) = queue.pop_front() {
        let entry = &entries[index];
        if directories.contains_key(&entry.mft_id) {
            continue;
        }

        let Some(parent) = directories.get(&entry.parent_id) else {
            continue;
        };
        let path = parent.path.join(&entry.name);
        let depth = parent.depth.saturating_add(1);
        deepest_depth = deepest_depth.max(depth);
        directories.insert(
            entry.mft_id,
            DirectoryInfo {
                parent_id: entry.parent_id,
                path,
                depth,
            },
        );

        if let Some(next_children) = children.get(&entry.mft_id) {
            queue.extend(next_children.iter().copied());
        }
    }

    DirectoryIndex {
        directories,
        deepest_depth,
    }
}

fn collect_file_targets(
    entries: &[mft_core::MftEntry],
    directories: &HashMap<u64, DirectoryInfo>,
) -> FileTargets {
    let mut ids = HashSet::new();
    let mut parent_pairs = Vec::new();

    for entry in entries.iter().filter(|entry| !entry.is_dir) {
        if directories.contains_key(&entry.parent_id) {
            // 聚合阶段需要父目录关系；这里一次性保存，避免后面再次遍历完整 MFT entries。
            ids.insert(entry.mft_id);
            parent_pairs.push((entry.mft_id, entry.parent_id));
        }
    }

    FileTargets { ids, parent_pairs }
}

fn aggregate_to_ancestors(
    directories: &HashMap<u64, DirectoryInfo>,
    deepest_depth: u16,
    file_parent_pairs: &[(u64, u64)],
    metadata_by_id: &HashMap<u64, mft_core::MftFileMetadata>,
) -> HashMap<PathBuf, FolderStats> {
    let mut stats_by_dir: HashMap<u64, DirectoryStats> = HashMap::with_capacity(directories.len());
    let mut ids_by_depth = vec![Vec::<u64>::new(); deepest_depth as usize + 1];

    for (directory_id, directory) in directories {
        if let Some(bucket) = ids_by_depth.get_mut(directory.depth as usize) {
            bucket.push(*directory_id);
        }
    }

    for (file_id, parent_id) in file_parent_pairs {
        let Some(metadata) = metadata_by_id.get(file_id) else {
            continue;
        };
        if metadata.size == 0 {
            continue;
        }
        add_file_to_directory(&mut stats_by_dir, *parent_id, metadata);
    }

    for depth in (0..ids_by_depth.len()).rev() {
        for directory_id in &ids_by_depth[depth] {
            let Some(stats) = stats_by_dir.get(directory_id).copied() else {
                continue;
            };
            let Some(directory) = directories.get(directory_id) else {
                continue;
            };
            if directory.parent_id == 0 || directory.parent_id == *directory_id {
                continue;
            }
            if directories.contains_key(&directory.parent_id) {
                add_directory_stats(&mut stats_by_dir, directory.parent_id, stats);
            }
        }
    }

    stats_by_dir
        .into_iter()
        .filter_map(|(directory_id, stats)| {
            let directory = directories.get(&directory_id)?;
            Some((
                directory.path.clone(),
                FolderStats {
                    total_size: stats.total_size,
                    file_count: stats.file_count,
                    last_modified: stats.last_modified,
                },
            ))
        })
        .collect()
}

fn add_file_to_directory(
    stats_by_dir: &mut HashMap<u64, DirectoryStats>,
    directory_id: u64,
    metadata: &mft_core::MftFileMetadata,
) {
    let stats = stats_by_dir.entry(directory_id).or_default();
    stats.total_size = stats.total_size.saturating_add(metadata.size);
    stats.file_count += 1;
    // MFT 核心解析出的时间戳是 Unix 秒，而 HotspotEntry 对外约定为毫秒；在聚合入口统一转换，避免前端显示到 1970 年。
    let modified_millis = metadata.modified.saturating_mul(1000);
    if modified_millis > stats.last_modified {
        stats.last_modified = modified_millis;
    }
}

fn add_directory_stats(
    stats_by_dir: &mut HashMap<u64, DirectoryStats>,
    directory_id: u64,
    child_stats: DirectoryStats,
) {
    let stats = stats_by_dir.entry(directory_id).or_default();
    stats.total_size = stats.total_size.saturating_add(child_stats.total_size);
    stats.file_count += child_stats.file_count;
    if child_stats.last_modified > stats.last_modified {
        stats.last_modified = child_stats.last_modified;
    }
}

pub fn is_elevated() -> bool {
    mft_core::is_elevated()
}

pub fn is_ntfs(drive_letter: char) -> bool {
    mft_core::is_ntfs(drive_letter)
}
