// ============================================================================
// MFT 大文件扫描器 — USN 枚举 + 顺序解析 $MFT 文件大小 + Top-N
// ============================================================================

#![cfg(target_os = "windows")]

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
// use std::io::Write;
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
}

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
    progress_cb: impl Fn(MftBigFileProgress),
) -> Result<Vec<LargeFileEntry>, String> {
    // DEBUG: 需要文件日志时取消下面注释
    // let mut log_file = std::fs::OpenOptions::new().create(true).append(true).open("C:\\mft_debug.log").ok();
    macro_rules! flog {
        ($($arg:tt)*) => {
            info!($($arg)*);
            // if let Some(ref mut f) = log_file { let _ = writeln!(f, "[{}] {}", std::time::UNIX_EPOCH.elapsed().unwrap_or_default().as_secs(), format!($($arg)*)); let _ = f.flush(); }
        };
    }

    let t0 = Instant::now();
    // 大文件模块支持多盘选择，MFT 直读必须显式使用用户选择的盘符，不能再隐式绑定系统盘。
    let drive_letter = drive_letter.to_ascii_uppercase();

    flog!(
        "[MFT-BigFiles] ===== 扫描开始 drive={} top_n={} =====",
        drive_letter,
        top_n
    );

    let progress = |stage: &str, message: &str, processed: usize, found_count: usize| {
        flog!("[MFT-BigFiles] {}: {}", message, processed);
        progress_cb(MftBigFileProgress {
            stage: stage.to_string(),
            message: message.to_string(),
            processed,
            found_count,
            elapsed_ms: t0.elapsed().as_millis() as u64,
        });
        !is_cancelled()
    };

    // Step 1: USN 枚举
    flog!("[MFT-BigFiles] Step1 USN 枚举...");
    let h_device = mft_core::open_volume(drive_letter)?;
    let enumerate_result = mft_core::enumerate_usn_records_v2(h_device, &|processed| {
        // MFT 枚举期间响应取消，避免完整 MFT 模式下用户点击停止却要等到降级阶段才生效。
        if processed % 100_000 == 0 {
            progress("enumerate", "正在枚举 MFT 文件记录", processed, 0)
        } else {
            !is_cancelled()
        }
    });
    mft_core::close_volume(h_device);
    let entries = enumerate_result?;
    let t1 = Instant::now();
    flog!(
        "[MFT-BigFiles] Step1: {} 条, {:.1}s",
        entries.len(),
        t1.duration_since(t0).as_secs_f32()
    );

    if entries.is_empty() {
        return Err("USN 空".into());
    }

    // Step 2: 顺序读取 $MFT，并直接在读取过程中维护一个稍大的 TopN 候选池。
    // 先不重建全盘路径，可以避开几十万条路径字符串分配，最后只给候选文件解析路径。
    flog!("[MFT-BigFiles] Step2 顺序解析 $MFT 文件大小...");
    let metadata_reader = mft_core::NtfsFileMetadataReader::open(drive_letter)?;
    let candidate_limit = top_n.saturating_mul(20).max(1000);
    let candidates = metadata_reader.read_top_file_candidates(candidate_limit, &|processed| {
        // 顺序读 $MFT 是完整 MFT 模式的核心耗时阶段，这里保留取消检查和进度回传。
        if processed % 100_000 == 0 {
            progress("metadata", "正在顺序解析 $MFT 文件大小", processed, 0)
        } else {
            !is_cancelled()
        }
    })?;
    let t2 = Instant::now();
    flog!(
        "[MFT-BigFiles] Step2: {} 个候选, {:.1}s",
        candidates.len(),
        t2.duration_since(t1).as_secs_f32()
    );

    // Step 3: 只给候选文件重建路径，再做系统目录过滤和最终 TopN。
    flog!("[MFT-BigFiles] Step3 候选路径重建...");
    let candidate_ids: HashSet<u64> = candidates
        .iter()
        .map(|candidate| candidate.mft_id)
        .collect();
    let paths = mft_core::rebuild_paths_for_ids(&entries, drive_letter, &candidate_ids);
    let t3 = Instant::now();
    flog!(
        "[MFT-BigFiles] Step3 paths: {} 个, {:.1}s",
        paths.len(),
        t3.duration_since(t2).as_secs_f32()
    );

    // Step 4: BinaryHeap Top-N
    let mut heap: BinaryHeap<Reverse<(u64, u64)>> = BinaryHeap::new();
    for candidate in &candidates {
        if is_cancelled() {
            return Err("扫描已取消".into());
        }
        let Some(path) = paths.get(&candidate.mft_id) else {
            continue;
        };
        if is_system_path(path) {
            continue;
        }

        heap.push(Reverse((candidate.size, candidate.mft_id)));
        if heap.len() > top_n {
            heap.pop();
        }
    }

    // Step 5: risk/source
    progress_cb(MftBigFileProgress {
        stage: "topn".to_string(),
        message: "正在生成 TopN 结果".to_string(),
        processed: candidates.len(),
        found_count: heap.len(),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    });
    let mut results: Vec<LargeFileEntry> = heap
        .into_iter()
        .filter_map(|Reverse((_, mft_id))| {
            let path = paths.get(&mft_id)?;
            let candidate = candidates
                .iter()
                .find(|candidate| candidate.mft_id == mft_id)?;
            Some(LargeFileEntry {
                path: path.clone(),
                size: candidate.size,
                modified: candidate.modified,
                risk_level: compute_file_risk_level(path),
                source_label: compute_source_label(path),
            })
        })
        .collect();
    results.sort_by(|a, b| b.size.cmp(&a.size));

    let t4 = Instant::now();
    flog!(
        "[MFT-BigFiles] ===== 完成: Top-{}, 总 {:.1}s =====",
        results.len(),
        t4.duration_since(t0).as_secs_f32()
    );
    flog!(
        "[MFT-BigFiles] 枚举={:.1}s, MFT大小={:.1}s, 候选路径={:.1}s, TopN={:.1}s",
        t1.duration_since(t0).as_secs_f32(),
        t2.duration_since(t1).as_secs_f32(),
        t3.duration_since(t2).as_secs_f32(),
        t4.duration_since(t3).as_secs_f32()
    );

    progress_cb(MftBigFileProgress {
        stage: "summary".to_string(),
        message: format!(
            "总耗时 {:.1}s｜枚举 {:.1}s｜大小 {:.1}s｜路径 {:.1}s",
            t4.duration_since(t0).as_secs_f32(),
            t1.duration_since(t0).as_secs_f32(),
            t2.duration_since(t1).as_secs_f32(),
            t3.duration_since(t2).as_secs_f32()
        ),
        processed: results.len(),
        found_count: results.len(),
        elapsed_ms: t0.elapsed().as_millis() as u64,
    });

    Ok(results)
}
