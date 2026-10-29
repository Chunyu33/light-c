// ============================================================================
// 大目录分析 MFT 引擎
// 复用 big_files_engine::mft_core 的顺序读取能力：一遍 $MFT 就同时拿到名字、
// 父子关系和大小。原来先 USN 枚举拿名字、再按 id 集合回读一遍 $MFT 拿大小，
// 同一份数据过两遍，而其中 USN 枚举是内核遍历整张表，比用户态顺序读慢得多。
// ============================================================================

#![cfg(windows)]

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::time::{Instant, UNIX_EPOCH};

use log::info;
use rayon::prelude::*;

use crate::scanner::big_files_engine::mft_core;
use crate::scanner::hotspot::{is_hotspot_scan_cancelled, FolderStats};

/// 卷根目录在 NTFS 里的固定记录号：MFT 前 16 条都是元文件，`$Root` 就是 5。
const ROOT_MFT_ID: u64 = 5;
/// 进度事件每处理这么多条记录发一次，发太密会挤占扫描线程
const PROGRESS_STEP: usize = 100_000;

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
    /// 该阶段的关键数字（分段/读盘/解析、目录数、回退 stat 数…）。
    ///
    /// 只给界面看：热点扫描以前只有阶段名和耗时，判断瓶颈全靠猜 ——
    /// 有了这一行才能一眼看出慢在读盘、解析还是聚合。
    pub detail: String,
}

struct DirectoryIndex {
    directories: HashMap<u64, DirectoryInfo>,
    deepest_depth: u16,
}

pub fn scan_via_mft(
    drive_letter: char,
    progress_cb: impl Fn(MftScanProgress) + Sync,
) -> Result<HashMap<PathBuf, FolderStats>, String> {
    info!("[Hotspot-MFT] 开始扫描 {}:，单遍读取 $MFT", drive_letter);

    let records = read_all_records(drive_letter, &progress_cb)?;

    // ---------- 目录索引 ----------
    let stage_start = Instant::now();
    progress_cb(MftScanProgress {
        stage: "index",
        message: "正在建立目录父子索引".to_string(),
        processed: records.len(),
        stage_elapsed_ms: 0,
        detail: String::new(),
    });
    let directory_index = build_directory_index(&records, drive_letter);
    let directories = directory_index.directories;
    progress_cb(MftScanProgress {
        stage: "index",
        message: format!("目录索引完成：{} 个目录", directories.len()),
        processed: directories.len(),
        stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
        detail: format!("有效记录 {} 条", records.len()),
    });

    // ---------- 累加文件大小 ----------
    let stage_start = Instant::now();
    let (mut stats_by_dir, fallback, file_count) =
        accumulate_file_stats(&records, &directories);
    let fallback_count = fallback.len();
    progress_cb(MftScanProgress {
        stage: "metadata",
        message: format!("正在读取 {} 个文件的大小", fallback_count),
        processed: 0,
        stage_elapsed_ms: 0,
        detail: String::new(),
    });
    read_fallback_sizes(&directories, &fallback, &mut stats_by_dir);
    progress_cb(MftScanProgress {
        stage: "metadata",
        message: format!("文件大小整理完成：{} 个文件", file_count),
        processed: fallback_count,
        stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
        detail: format!("其中 {} 个 $DATA 未解析，回退 stat", fallback_count),
    });

    // ---------- 向上聚合 ----------
    let stage_start = Instant::now();
    progress_cb(MftScanProgress {
        stage: "aggregate",
        message: "正在向上聚合目录大小".to_string(),
        processed: stats_by_dir.len(),
        stage_elapsed_ms: 0,
        detail: String::new(),
    });
    propagate_to_ancestors(&directories, directory_index.deepest_depth, &mut stats_by_dir);
    // 目录索引这时已经没用了，直接 move 出路径，不再 clone 一遍
    let folder_map = into_folder_map(directories, &mut stats_by_dir);
    progress_cb(MftScanProgress {
        stage: "aggregate",
        message: format!("目录聚合完成：{} 个目录", folder_map.len()),
        processed: folder_map.len(),
        stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
        detail: String::new(),
    });

    info!(
        "[Hotspot-MFT] 扫描完成：记录 {} 条，聚合目录 {} 个",
        records.len(),
        folder_map.len()
    );
    Ok(folder_map)
}

/// 把「目录 id → 统计」的中间结果转成对外的「路径 → 统计」。
///
/// 目录已经用完，路径直接 move 出去；没有文件的目录不入结果（与旧实现口径一致）。
fn into_folder_map(
    directories: HashMap<u64, DirectoryInfo>,
    stats_by_dir: &mut HashMap<u64, DirectoryStats>,
) -> HashMap<PathBuf, FolderStats> {
    directories
        .into_iter()
        .filter_map(|(directory_id, directory)| {
            let stats = stats_by_dir.remove(&directory_id)?;
            Some((
                directory.path,
                FolderStats {
                    total_size: stats.total_size,
                    file_count: stats.file_count,
                    last_modified: stats.last_modified,
                },
            ))
        })
        .collect()
}

/// 一遍顺序读完 `$MFT`，返回全部有效记录。
fn read_all_records(
    drive_letter: char,
    progress_cb: &(impl Fn(MftScanProgress) + Sync),
) -> Result<Vec<mft_core::MftRecordInfo>, String> {
    let stage_start = Instant::now();
    let metadata_reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let (records, mft_stats) = metadata_reader.read_all_records(&|processed| {
        if is_hotspot_scan_cancelled() {
            return false;
        }
        if processed % PROGRESS_STEP == 0 {
            progress_cb(MftScanProgress {
                stage: "mft",
                message: format!("正在读取 NTFS 主文件表，已处理 {} 条记录", processed),
                processed,
                stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
                detail: String::new(),
            });
        }
        true
    })?;

    progress_cb(MftScanProgress {
        stage: "mft",
        message: format!("$MFT 读取完成：{} 条有效记录", records.len()),
        processed: records.len(),
        stage_elapsed_ms: stage_start.elapsed().as_millis() as u64,
        detail: format!(
            "MFT 分段 {} · 读盘 {:.1}s、解析 {:.1}s（同时进行）",
            mft_stats.fragments,
            mft_stats.io_ms as f64 / 1000.0,
            mft_stats.parse_ms as f64 / 1000.0,
        ),
    });

    Ok(records)
}

fn build_directory_index(
    entries: &[mft_core::MftRecordInfo],
    drive_letter: char,
) -> DirectoryIndex {
    let mut directories = HashMap::new();
    // 只有目录会出现在父子关系里，文件没有子节点
    let mut children: HashMap<u64, Vec<usize>> = HashMap::with_capacity(entries.len() / 6);
    let mut deepest_depth = 0u16;

    for (index, entry) in entries.iter().enumerate() {
        if entry.is_dir && entry.mft_id != 0 {
            children.entry(entry.parent_id).or_default().push(index);
        }
    }

    let root_path = PathBuf::from(format!("{}:\\", drive_letter));
    directories.insert(
        ROOT_MFT_ID,
        DirectoryInfo {
            parent_id: 0,
            path: root_path,
            depth: 0,
        },
    );

    let mut queue = VecDeque::new();
    if let Some(root_children) = children.get(&ROOT_MFT_ID) {
        queue.extend(root_children.iter().copied());
    }

    while let Some(index) = queue.pop_front() {
        let entry = &entries[index];
        // 已经建过路径的目录直接跳过：这也挡住了异常父链造成的死循环
        if directories.contains_key(&entry.mft_id) {
            continue;
        }

        // 父目录不在索引里说明这条链从根不可达，整支都建不出来
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

/// 把每个文件的大小记到它的直接父目录上，返回(统计表, 需要回退 stat 的文件, 文件总数)。
///
/// 有 `$DATA` 的记录直接用记录里的大小；缺 `$DATA` 的（约 6%）先攒起来，
/// 交给 `read_fallback_sizes` 并行补一次 stat —— 这部分不补会让目录少算体积。
fn accumulate_file_stats<'a>(
    entries: &'a [mft_core::MftRecordInfo],
    directories: &HashMap<u64, DirectoryInfo>,
) -> (
    HashMap<u64, DirectoryStats>,
    Vec<(u64, &'a str)>,
    usize,
) {
    let mut stats_by_dir: HashMap<u64, DirectoryStats> = HashMap::with_capacity(directories.len());
    let mut fallback: Vec<(u64, &str)> = Vec::new();
    let mut file_count = 0usize;

    for entry in entries {
        if entry.is_dir || entry.mft_id == 0 {
            continue;
        }
        // 父目录不在索引里（从根不可达）的文件直接忽略，与原来的口径一致
        if !directories.contains_key(&entry.parent_id) {
            continue;
        }
        file_count += 1;

        if entry.has_data_stream {
            if entry.size > 0 {
                add_file_stats(
                    &mut stats_by_dir,
                    entry.parent_id,
                    entry.size,
                    entry.modified.saturating_mul(1000),
                );
            }
        } else {
            fallback.push((entry.parent_id, entry.name.as_str()));
        }
    }

    (stats_by_dir, fallback, file_count)
}

/// 给缺 `$DATA` 的文件并行补一次 `fs::metadata`。
///
/// 这类文件几万个、位置分散，串行 stat 要几百毫秒；并行之后耗时基本被 IO 摊平。
fn read_fallback_sizes(
    directories: &HashMap<u64, DirectoryInfo>,
    fallback: &[(u64, &str)],
    stats_by_dir: &mut HashMap<u64, DirectoryStats>,
) {
    if fallback.is_empty() {
        return;
    }

    let measured: Vec<(u64, u64, i64)> = fallback
        .par_iter()
        .filter_map(|(parent_id, name)| {
            if is_hotspot_scan_cancelled() {
                return None;
            }
            let parent = directories.get(parent_id)?;
            let metadata = std::fs::metadata(parent.path.join(name)).ok()?;
            Some((
                *parent_id,
                metadata.len(),
                metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0),
            ))
        })
        .collect();

    for (parent_id, size, modified_millis) in measured {
        if size > 0 {
            add_file_stats(stats_by_dir, parent_id, size, modified_millis);
        }
    }
}

/// 从最深的目录往上加：处理到某一层时，它的所有子目录都已经汇总完。
fn propagate_to_ancestors(
    directories: &HashMap<u64, DirectoryInfo>,
    deepest_depth: u16,
    stats_by_dir: &mut HashMap<u64, DirectoryStats>,
) {
    let mut ids_by_depth = vec![Vec::<u64>::new(); deepest_depth as usize + 1];
    for (directory_id, directory) in directories {
        if let Some(bucket) = ids_by_depth.get_mut(directory.depth as usize) {
            bucket.push(*directory_id);
        }
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
                add_directory_stats(stats_by_dir, directory.parent_id, stats);
            }
        }
    }
}

fn add_file_stats(
    stats_by_dir: &mut HashMap<u64, DirectoryStats>,
    directory_id: u64,
    size: u64,
    modified_millis: i64,
) {
    let stats = stats_by_dir.entry(directory_id).or_default();
    stats.total_size = stats.total_size.saturating_add(size);
    stats.file_count += 1;
    // `FolderStats.last_modified` 对外约定是毫秒，调用方已经统一换算过，这里只取最新
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一条记录。目录不会有 `$DATA`，和真实 MFT 的形态一致。
    fn record(
        mft_id: u64,
        parent_id: u64,
        name: &str,
        is_dir: bool,
        size: u64,
        has_data_stream: bool,
    ) -> mft_core::MftRecordInfo {
        mft_core::MftRecordInfo {
            mft_id,
            parent_id,
            name: name.to_string(),
            is_dir,
            size,
            // 固定时间戳，方便断言 last_modified
            modified: 1_700_000_000,
            has_data_stream,
        }
    }

    /// 目录体积必须一层层加上去，且只看「从根可达」的那部分。
    ///
    /// 这是界面排行榜的依据：少算一层，用户看到的目录大小就是错的，
    /// 而这种错不会报错、只会显示成一个偏小的数字。
    #[test]
    fn file_sizes_are_aggregated_up_to_the_root() {
        let entries = vec![
            record(ROOT_MFT_ID, ROOT_MFT_ID, ".", true, 0, false),
            record(26, ROOT_MFT_ID, "Users", true, 0, false),
            record(30, 26, "Evan", true, 0, false),
            record(40, 30, "a.bin", false, 100, true),
            record(41, 30, "b.bin", false, 200, true),
            // 空文件：占用为 0，不计入体积，但仍是文件
            record(42, 30, "empty.bin", false, 0, true),
            record(50, 26, "Other", true, 0, false),
            record(51, 50, "c.bin", false, 300, true),
            // 父目录不在索引里（从根不可达）：整条忽略
            record(60, 999, "orphan.bin", false, 400, true),
            // 缺 $DATA 的文件：这次不 stat（表里没这个文件，stat 也会失败），
            // 只验证它被归到回退队列而不是被当成 0
            record(43, 30, "no-data.bin", false, 0, false),
        ];

        let index = build_directory_index(&entries, 'C');
        // 根 0 → Users 1 → Evan/Other 2
        assert_eq!(index.deepest_depth, 2);

        let (mut stats_by_dir, fallback, file_count) =
            accumulate_file_stats(&entries, &index.directories);
        assert_eq!(file_count, 5, "a/b/empty/no-data/c 五个文件，orphan 不算");
        assert_eq!(fallback, vec![(30u64, "no-data.bin")]);

        propagate_to_ancestors(
            &index.directories,
            index.deepest_depth,
            &mut stats_by_dir,
        );
        let folder_map = into_folder_map(index.directories, &mut stats_by_dir);

        let evan = &folder_map[&PathBuf::from("C://Users//Evan")];
        assert_eq!(evan.total_size, 300);
        assert_eq!(evan.file_count, 2);
        assert_eq!(evan.last_modified, 1_700_000_000 * 1000);

        let other = &folder_map[&PathBuf::from("C://Users//Other")];
        assert_eq!(other.total_size, 300);

        // 上层目录是「自己 + 所有子目录」的合计
        assert_eq!(folder_map[&PathBuf::from("C://Users")].total_size, 600);
        assert_eq!(folder_map[&PathBuf::from("C://")].total_size, 600);
        assert_eq!(folder_map[&PathBuf::from("C://")].file_count, 3);
    }
}
