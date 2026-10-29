// ============================================================================
// MFT 大文件扫描器 — 一遍顺序读 $MFT + Top-N
//
// 原来是 USN 枚举拿名字、再整表读一遍 $MFT 拿大小（同一份数据过两遍），
// 而 USN 枚举是内核遍历整张表，是两遍里慢的那一遍。
// ============================================================================

#![cfg(target_os = "windows")]

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::time::Instant;

use log::info;

use crate::scanner::big_files::{
    compute_file_risk_level, compute_source_label, is_cancelled, LargeFileEntry,
};
use crate::scanner::big_files_engine::mft_core;

pub struct MftBigFileProgress {
    pub stage: String,
    pub message: String,
    pub processed: usize,
    pub found_count: usize,
    pub elapsed_ms: u64,
    /// 该阶段的关键数字（分段/读盘/解析、记录数、候选数…），前端直接展示
    pub detail: String,
}

/// 候选池倍数：先取 TopN 的这么多倍，再做系统目录过滤，避免系统文件挤掉用户文件
const CANDIDATE_MULTIPLIER: usize = 20;
const CANDIDATE_MINIMUM: usize = 1000;
/// 进度事件间隔：发太密会挤占扫描线程
const PROGRESS_STEP: usize = 100_000;

const SKIP_PATH_SEGMENTS: &[&str] = &[
    "\\windows\\system32\\",
    "\\windows\\syswow64\\",
    "\\windows\\winsxs\\",
    "\\windows\\assembly\\",
    "\\windows\\microsoft.net\\",
];

fn is_system_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    SKIP_PATH_SEGMENTS.iter().any(|s| p.contains(s))
}

pub fn scan_top_files_via_mft(
    top_n: usize,
    drive_letter: char,
    progress_cb: impl Fn(MftBigFileProgress) + Sync,
) -> Result<Vec<LargeFileEntry>, String> {
    let t0 = Instant::now();
    // 大文件模块支持多盘选择，MFT 直读必须显式使用用户选择的盘符，不能再隐式绑定系统盘。
    let drive_letter = drive_letter.to_ascii_uppercase();

    info!(
        "[MFT-BigFiles] ===== 扫描开始 drive={} top_n={} =====",
        drive_letter, top_n
    );

    let progress = |stage: &str,
                    message: &str,
                    processed: usize,
                    found_count: usize,
                    detail: String| {
        info!("[MFT-BigFiles] {}: {}", message, processed);
        progress_cb(MftBigFileProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            processed,
            found_count,
            elapsed_ms: t0.elapsed().as_millis() as u64,
            detail,
        });
    };

    // ---------- Step 1: 一遍读完 $MFT（名字 / 父子 / 大小 / 时间） ----------
    let mft_started = Instant::now();
    let reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let (records, mft_stats) = reader.read_all_records(&|processed| {
        // 读盘期间也要响应取消，否则用户点了停止要等整张表读完
        if processed % PROGRESS_STEP == 0 {
            progress("mft", "正在读取 NTFS 主文件表", processed, 0, String::new());
        }
        !is_cancelled()
    })?;
    let mft_elapsed = mft_started.elapsed();
    let mft_detail = format!(
        "MFT 分段 {} · 读盘 {:.1}s、解析 {:.1}s（同时进行）",
        mft_stats.fragments,
        mft_stats.io_ms as f64 / 1000.0,
        mft_stats.parse_ms as f64 / 1000.0,
    );
    progress(
        "mft",
        &format!("$MFT 读取完成：{} 条有效记录", records.len()),
        records.len(),
        0,
        mft_detail,
    );
    info!(
        "[MFT-BigFiles] Step1: {} 条, {:.1}s",
        records.len(),
        mft_elapsed.as_secs_f32()
    );

    if records.is_empty() {
        return Err("MFT 空".into());
    }

    // ---------- Step 2: 候选池（按大小留 TopN × 20） ----------
    let candidate_limit = top_n
        .saturating_mul(CANDIDATE_MULTIPLIER)
        .max(CANDIDATE_MINIMUM);
    let mut pool: BinaryHeap<Reverse<(u64, u64, i64)>> =
        BinaryHeap::with_capacity(candidate_limit + 1);
    for record in &records {
        if is_cancelled() {
            return Err("扫描已取消".into());
        }
        // 目录的记录大小恒为 0；没有 $DATA 的文件也拿不到大小，一并跳过
        if record.is_dir || record.size == 0 {
            continue;
        }
        pool.push(Reverse((record.size, record.mft_id, record.modified)));
        if pool.len() > candidate_limit {
            pool.pop();
        }
    }

    // (大小, 记录号, 修改时间)，按大小从大到小
    let mut candidates: Vec<(u64, u64, i64)> = pool
        .into_iter()
        .map(|Reverse(found)| found)
        .collect();
    candidates.sort_unstable_by(|left, right| right.0.cmp(&left.0));

    let candidate_ids: HashSet<u64> = candidates.iter().map(|item| item.1).collect();
    progress(
        "topn",
        "正在挑选最大的文件",
        records.len(),
        candidate_ids.len(),
        format!(
            "有效记录 {} 条 → 候选 {} 个",
            records.len(),
            candidate_ids.len()
        ),
    );

    // ---------- Step 3: 只给候选重建路径 ----------
    let paths_started = Instant::now();
    let paths = mft_core::rebuild_paths_for_records(&records, drive_letter, &candidate_ids);
    let paths_elapsed = paths_started.elapsed();
    progress(
        "paths",
        "正在重建候选文件路径",
        candidate_ids.len(),
        paths.len(),
        format!("候选 {} 个，解析出 {} 条路径", candidate_ids.len(), paths.len()),
    );

    // 路径拿到之后记录就没用了，提前释放（120 万条记录带着名字，占上百 MB）
    let record_count = records.len();
    drop(records);

    // ---------- Step 4: 系统目录过滤 + TopN ----------
    let mut top: BinaryHeap<Reverse<(u64, u64)>> = BinaryHeap::with_capacity(top_n + 1);
    for (size, mft_id, _) in &candidates {
        let Some(path) = paths.get(mft_id) else {
            continue;
        };
        if is_system_path(path) {
            continue;
        }
        top.push(Reverse((*size, *mft_id)));
        if top.len() > top_n {
            top.pop();
        }
    }

    // ---------- Step 5: 结果 ----------
    let details_by_id: HashMap<u64, (u64, i64)> = candidates
        .iter()
        .map(|(size, mft_id, modified)| (*mft_id, (*size, *modified)))
        .collect();
    let mut results: Vec<LargeFileEntry> = top
        .into_iter()
        .filter_map(|Reverse((_, mft_id))| {
            let path = paths.get(&mft_id)?;
            let (size, modified) = *details_by_id.get(&mft_id)?;
            Some(LargeFileEntry {
                path: path.clone(),
                size,
                modified,
                risk_level: compute_file_risk_level(path),
                source_label: compute_source_label(path),
            })
        })
        .collect();
    results.sort_by(|left, right| right.size.cmp(&left.size));

    let total_elapsed = t0.elapsed();
    info!(
        "[MFT-BigFiles] ===== 完成: Top-{}, 总 {:.1}s =====",
        results.len(),
        total_elapsed.as_secs_f32()
    );
    progress(
        "summary",
        "扫描完成",
        results.len(),
        results.len(),
        format!(
            "总耗时 {:.1}s · 读盘 {:.1}s、解析 {:.1}s · 路径 {:.2}s · 有效记录 {} 条 → Top {}",
            total_elapsed.as_secs_f32(),
            mft_stats.io_ms as f64 / 1000.0,
            mft_stats.parse_ms as f64 / 1000.0,
            paths_elapsed.as_secs_f32(),
            record_count,
            results.len(),
        ),
    );

    Ok(results)
}
