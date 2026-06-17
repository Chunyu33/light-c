// ============================================================================
// C 盘空间变化分析
//
// 对比本次 MFT 聚合结果和上一次快照，找出新增、减少和增长最快的目录。
// 这里只做变化分析，不做清理判断，避免把“能不能删”的语义误加到全盘目录上。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use super::mft_scan::{
    normalize_path, scan_system_drive_with_progress, DirSizeEntry, DiskGrowthPhaseDuration,
    DiskGrowthScanProgress, FileSnapshotEntry,
};
use super::snapshot::{build_snapshot, DiskSnapshot, DiskSnapshotEntry, DiskSnapshotManager};

const SIGNIFICANT_THRESHOLD: i64 = 1024 * 1024 * 1024;
const FAST_THRESHOLD: i64 = 300 * 1024 * 1024;
// 小变化也需要进入列表，否则会出现汇总有净变化、明细变化量为空的割裂体验。
const MINOR_THRESHOLD: i64 = 1;
const DEFAULT_MAX_CHANGE_ENTRIES: usize = 300;
const MIN_CHANGE_ENTRIES: usize = 50;
const MAX_CHANGE_ENTRIES: usize = 1000;
const MAX_DETAIL_ENTRIES: usize = 50;
const DEFAULT_DETAIL_PAGE_SIZE: usize = 200;
const MAX_DETAIL_PAGE_SIZE: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiskGrowthLevel {
    Significant,
    Fast,
    Minor,
    Stable,
    Decreased,
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthDetailEntry {
    pub path: String,
    pub name: String,
    pub old_size: u64,
    pub new_size: u64,
    pub diff: i64,
    pub level: DiskGrowthLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthEntry {
    pub path: String,
    pub old_size: u64,
    pub new_size: u64,
    pub diff: i64,
    pub diff_percent: f64,
    pub level: DiskGrowthLevel,
    pub explanation: String,
    pub suggestion: String,
    pub details: Vec<DiskGrowthDetailEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthReport {
    pub entries: Vec<DiskGrowthEntry>,
    pub total_growth: i64,
    pub significant_count: usize,
    pub fast_count: usize,
    pub new_count: usize,
    pub decreased_count: usize,
    pub time_span: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskAnalyzeEntry {
    pub path: String,
    pub size: u64,
    pub depth: u8,
    pub category: String,
    pub reason: String,
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskAnalyzeResult {
    pub entries: Vec<DiskAnalyzeEntry>,
    pub changed_size: u64,
    pub increased_size: u64,
    pub decreased_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskScanAndAnalyzeResponse {
    pub total_size: u64,
    pub total_files_scanned: usize,
    pub scan_duration_ms: u64,
    pub root_path: String,
    pub previous_scan_time: Option<String>,
    pub current_scan_time: String,
    pub backend: String,
    pub phase_durations: Vec<DiskGrowthPhaseDuration>,
    pub mft_size_count: usize,
    pub metadata_fallback_count: usize,
    pub analyze: DiskAnalyzeResult,
    pub growth: DiskGrowthReport,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthFileDetailEntry {
    pub path: String,
    pub name: String,
    pub old_size: u64,
    pub new_size: u64,
    pub diff: i64,
    pub level: DiskGrowthLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthFileDetailsResponse {
    pub path: String,
    pub previous_scan_time: String,
    pub current_scan_time: String,
    pub entries: Vec<DiskGrowthFileDetailEntry>,
    pub total_changed_files: usize,
    pub returned_files: usize,
    pub offset: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskGrowthDirectoryDetailsResponse {
    pub path: String,
    pub previous_scan_time: String,
    pub current_scan_time: String,
    pub entries: Vec<DiskGrowthDetailEntry>,
    pub total_changed_dirs: usize,
    pub returned_dirs: usize,
    pub offset: usize,
    pub has_more: bool,
}

pub fn scan_and_analyze_system_drive_with_progress<F>(
    progress: &F,
    max_change_entries: Option<usize>,
) -> Result<DiskScanAndAnalyzeResponse, String>
where
    F: Fn(DiskGrowthScanProgress) + Sync,
{
    let max_change_entries = normalize_max_change_entries(max_change_entries);
    let manager = DiskSnapshotManager::new()?;
    let previous = manager.load_latest_snapshot()?;
    let previous_scan_time = previous.as_ref().map(|snapshot| snapshot.date.clone());
    let scan = scan_system_drive_with_progress(progress)?;
    let current_snapshot = build_snapshot(&scan);
    let growth = compare_snapshots(&current_snapshot, previous.as_ref(), max_change_entries);
    manager.save_snapshot(&current_snapshot)?;

    let analyze_entries = build_analyze_entries(&scan.entries, &growth);
    let increased_size = growth
        .entries
        .iter()
        .filter(|entry| entry.diff > 0)
        .map(|entry| entry.diff as u64)
        .sum();
    let decreased_size = growth
        .entries
        .iter()
        .filter(|entry| entry.diff < 0)
        .map(|entry| entry.diff.unsigned_abs())
        .sum();

    Ok(DiskScanAndAnalyzeResponse {
        total_size: scan.total_size,
        total_files_scanned: scan.total_files_scanned,
        scan_duration_ms: scan.scan_duration_ms,
        root_path: scan.root_path,
        previous_scan_time,
        current_scan_time: current_snapshot.date,
        backend: scan.backend,
        phase_durations: scan.phase_durations,
        mft_size_count: scan.mft_size_count,
        metadata_fallback_count: scan.metadata_fallback_count,
        analyze: DiskAnalyzeResult {
            entries: analyze_entries,
            changed_size: growth.total_growth.unsigned_abs(),
            increased_size,
            decreased_size,
        },
        growth,
    })
}

pub fn get_file_change_details(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<DiskGrowthFileDetailsResponse, String> {
    let manager = DiskSnapshotManager::new()?;
    let Some((previous, current)) = manager.load_latest_two_snapshots()? else {
        return Err("至少完成两次 C 盘全盘扫描后，才能查看文件级变化明细".to_string());
    };

    if previous.file_entries.is_empty() || current.file_entries.is_empty() {
        return Err("最近快照不包含文件级明细，请再完成一次全盘扫描后重试".to_string());
    }

    let normalized_path = normalize_query_path(&path);
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_DETAIL_PAGE_SIZE).clamp(1, MAX_DETAIL_PAGE_SIZE);
    let previous_map = file_snapshot_map(&previous.file_entries, &normalized_path);
    let current_map = file_snapshot_map(&current.file_entries, &normalized_path);
    let mut all_paths: HashSet<String> = previous_map.keys().cloned().collect();
    all_paths.extend(current_map.keys().cloned());

    let mut entries: Vec<DiskGrowthFileDetailEntry> = all_paths
        .into_iter()
        .filter_map(|file_path| {
            let old_size = previous_map.get(&file_path).copied().unwrap_or(0);
            let new_size = current_map.get(&file_path).copied().unwrap_or(0);
            let diff = new_size as i64 - old_size as i64;
            if diff == 0 {
                return None;
            }

            Some(DiskGrowthFileDetailEntry {
                name: display_name_from_path(&file_path),
                path: file_path,
                old_size,
                new_size,
                diff,
                level: determine_level(diff, old_size),
            })
        })
        .collect();

    entries.sort_by(|left, right| {
        right
            .diff
            .abs()
            .cmp(&left.diff.abs())
            .then_with(|| left.path.cmp(&right.path))
    });
    let total_changed_files = entries.len();
    let paged_entries: Vec<DiskGrowthFileDetailEntry> =
        entries.into_iter().skip(offset).take(limit).collect();
    let returned_files = paged_entries.len();

    Ok(DiskGrowthFileDetailsResponse {
        path: normalized_path,
        previous_scan_time: previous.date,
        current_scan_time: current.date,
        returned_files,
        total_changed_files,
        has_more: offset + returned_files < total_changed_files,
        offset,
        entries: paged_entries,
    })
}

pub fn get_directory_change_details(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<DiskGrowthDirectoryDetailsResponse, String> {
    let manager = DiskSnapshotManager::new()?;
    let Some((previous, current)) = manager.load_latest_two_snapshots()? else {
        return Err("至少完成两次 C 盘全盘扫描后，才能查看目录变化明细".to_string());
    };

    let normalized_path = normalize_query_path(&path);
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_DETAIL_PAGE_SIZE).clamp(1, MAX_DETAIL_PAGE_SIZE);
    let previous_children = direct_child_map(&previous.entries);
    let current_children = direct_child_map(&current.entries);
    let details = build_detail_entries_unlimited(&normalized_path, &previous_children, &current_children);
    let total_changed_dirs = details.len();
    let paged_entries: Vec<DiskGrowthDetailEntry> =
        details.into_iter().skip(offset).take(limit).collect();
    let returned_dirs = paged_entries.len();

    Ok(DiskGrowthDirectoryDetailsResponse {
        path: normalized_path,
        previous_scan_time: previous.date,
        current_scan_time: current.date,
        returned_dirs,
        total_changed_dirs,
        has_more: offset + returned_dirs < total_changed_dirs,
        offset,
        entries: paged_entries,
    })
}

pub fn compare_snapshots(
    current: &DiskSnapshot,
    previous: Option<&DiskSnapshot>,
    max_change_entries: usize,
) -> DiskGrowthReport {
    let Some(previous) = previous else {
        return first_scan_report(current);
    };

    let current_map = snapshot_map(&current.entries);
    let previous_map = snapshot_map(&previous.entries);
    let current_children = direct_child_map(&current.entries);
    let previous_children = direct_child_map(&previous.entries);
    let mut all_paths: HashSet<String> = current_map.keys().cloned().collect();
    all_paths.extend(previous_map.keys().cloned());

    let mut entries: Vec<DiskGrowthEntry> = all_paths
        .into_iter()
        .filter_map(|path| {
            let old_size = previous_map.get(&path).copied().unwrap_or(0);
            let new_size = current_map.get(&path).copied().unwrap_or(0);
            let details = build_detail_entries(&path, &previous_children, &current_children);
            create_growth_entry(path, old_size, new_size, details)
        })
        .collect();

    remove_redundant_parent_entries(&mut entries);
    entries.sort_by(|left, right| {
        right
            .diff
            .abs()
            .cmp(&left.diff.abs())
            .then_with(|| left.path.cmp(&right.path))
    });
    entries.truncate(max_change_entries);

    let total_growth = current.total_size as i64 - previous.total_size as i64;
    let significant_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::Significant)
        .count();
    let fast_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::Fast)
        .count();
    let new_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::New)
        .count();
    let decreased_count = entries
        .iter()
        .filter(|entry| entry.level == DiskGrowthLevel::Decreased)
        .count();

    DiskGrowthReport {
        summary: build_summary(total_growth, significant_count, fast_count, decreased_count),
        entries,
        total_growth,
        significant_count,
        fast_count,
        new_count,
        decreased_count,
        time_span: format!("{} -> {}", previous.date, current.date),
    }
}

fn normalize_max_change_entries(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_MAX_CHANGE_ENTRIES)
        .clamp(MIN_CHANGE_ENTRIES, MAX_CHANGE_ENTRIES)
}

fn first_scan_report(current: &DiskSnapshot) -> DiskGrowthReport {
    DiskGrowthReport {
        entries: Vec::new(),
        total_growth: 0,
        significant_count: 0,
        fast_count: 0,
        new_count: 0,
        decreased_count: 0,
        time_span: "暂无历史快照".to_string(),
        summary: format!(
            "首次完成 C 盘快照，已记录 {} 个文件。下次扫描后会展示空间新增和减少的目录。",
            current.total_files_scanned
        ),
    }
}

fn snapshot_map(entries: &[DiskSnapshotEntry]) -> HashMap<String, u64> {
    entries
        .iter()
        .map(|entry| (entry.path.clone(), entry.size))
        .collect()
}

fn file_snapshot_map(entries: &[FileSnapshotEntry], parent_path: &str) -> HashMap<String, u64> {
    entries
        .iter()
        .filter(|entry| is_same_or_child_path(&entry.path, parent_path))
        .map(|entry| (entry.path.clone(), entry.size))
        .collect()
}

fn normalize_query_path(path: &str) -> String {
    normalize_path(path).trim_end_matches('/').to_string()
}

fn is_same_or_child_path(path: &str, parent_path: &str) -> bool {
    if path == parent_path {
        return true;
    }
    let prefix = format!("{}/", parent_path.trim_end_matches('/'));
    // 文件级明细只在用户点击的目录范围内比较，避免全盘文件快照一次性进入排序。
    path.starts_with(&prefix)
}

fn remove_redundant_parent_entries(entries: &mut Vec<DiskGrowthEntry>) {
    let diff_by_path: HashMap<String, i64> = entries
        .iter()
        .map(|entry| (entry.path.clone(), entry.diff))
        .collect();

    entries.retain(|entry| {
        // 只有父目录变化量与某个直接子目录完全一致时才折叠父级，避免多个子目录共同变化时误删有效汇总。
        !entry.details.iter().any(|detail| {
            detail.diff == entry.diff
                && detail.diff.signum() == entry.diff.signum()
                && diff_by_path.get(&detail.path).copied() == Some(detail.diff)
        })
    });
}

fn direct_child_map(entries: &[DiskSnapshotEntry]) -> HashMap<String, HashMap<String, u64>> {
    let mut child_map: HashMap<String, HashMap<String, u64>> = HashMap::new();
    for entry in entries {
        let Some(parent) = parent_path(&entry.path) else {
            continue;
        };
        // 变化明细只展示直接子目录，避免把所有后代目录重复摊开造成列表噪音。
        child_map
            .entry(parent)
            .or_default()
            .insert(entry.path.clone(), entry.size);
    }
    child_map
}

fn build_detail_entries(
    parent: &str,
    previous_children: &HashMap<String, HashMap<String, u64>>,
    current_children: &HashMap<String, HashMap<String, u64>>,
) -> Vec<DiskGrowthDetailEntry> {
    let mut details = build_detail_entries_unlimited(parent, previous_children, current_children);
    details.truncate(MAX_DETAIL_ENTRIES);
    details
}

fn build_detail_entries_unlimited(
    parent: &str,
    previous_children: &HashMap<String, HashMap<String, u64>>,
    current_children: &HashMap<String, HashMap<String, u64>>,
) -> Vec<DiskGrowthDetailEntry> {
    let previous = previous_children.get(parent);
    let current = current_children.get(parent);
    let mut all_paths = HashSet::new();

    if let Some(previous) = previous {
        all_paths.extend(previous.keys().cloned());
    }
    if let Some(current) = current {
        all_paths.extend(current.keys().cloned());
    }

    let mut details: Vec<DiskGrowthDetailEntry> = all_paths
        .into_iter()
        .filter_map(|path| {
            let old_size = previous.and_then(|map| map.get(&path)).copied().unwrap_or(0);
            let new_size = current.and_then(|map| map.get(&path)).copied().unwrap_or(0);
            let diff = new_size as i64 - old_size as i64;
            if diff == 0 {
                return None;
            }

            Some(DiskGrowthDetailEntry {
                name: display_name_from_path(&path),
                path,
                old_size,
                new_size,
                diff,
                level: determine_level(diff, old_size),
            })
        })
        .collect();

    details.sort_by(|left, right| {
        right
            .diff
            .abs()
            .cmp(&left.diff.abs())
            .then_with(|| left.path.cmp(&right.path))
    });
    details
}

fn parent_path(path: &str) -> Option<String> {
    let normalized = path.trim_end_matches('/');
    let separator_index = normalized.rfind('/')?;
    if separator_index <= 2 {
        return Some(format!("{}/", &normalized[..separator_index]));
    }
    Some(normalized[..separator_index].to_string())
}

fn display_name_from_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn create_growth_entry(
    path: String,
    old_size: u64,
    new_size: u64,
    details: Vec<DiskGrowthDetailEntry>,
) -> Option<DiskGrowthEntry> {
    let diff = new_size as i64 - old_size as i64;
    if diff == 0 {
        return None;
    }

    let level = determine_level(diff, old_size);
    if level == DiskGrowthLevel::Stable {
        return None;
    }

    let diff_percent = if old_size > 0 {
        diff as f64 / old_size as f64 * 100.0
    } else {
        100.0
    };
    let (explanation, suggestion) = explain_path(&path, diff, level);

    Some(DiskGrowthEntry {
        path,
        old_size,
        new_size,
        diff,
        diff_percent,
        level,
        explanation,
        suggestion,
        details,
    })
}

fn determine_level(diff: i64, old_size: u64) -> DiskGrowthLevel {
    if old_size == 0 && diff > 0 {
        DiskGrowthLevel::New
    } else if diff >= SIGNIFICANT_THRESHOLD {
        DiskGrowthLevel::Significant
    } else if diff >= FAST_THRESHOLD {
        DiskGrowthLevel::Fast
    } else if diff >= MINOR_THRESHOLD {
        DiskGrowthLevel::Minor
    } else if diff <= -MINOR_THRESHOLD {
        DiskGrowthLevel::Decreased
    } else {
        DiskGrowthLevel::Stable
    }
}

fn build_analyze_entries(
    scan_entries: &[DirSizeEntry],
    growth: &DiskGrowthReport,
) -> Vec<DiskAnalyzeEntry> {
    if growth.entries.is_empty() {
        return scan_entries
            .iter()
            .take(50)
            .map(|entry| DiskAnalyzeEntry {
                path: entry.path.clone(),
                size: entry.size,
                depth: entry.depth,
                category: classify_path(&entry.path),
                reason: "当前占用较大的目录".to_string(),
                suggestion: "下次扫描后会显示该目录的空间变化".to_string(),
            })
            .collect();
    }

    growth
        .entries
        .iter()
        .map(|entry| DiskAnalyzeEntry {
            path: entry.path.clone(),
            size: entry.new_size,
            depth: path_depth(&entry.path),
            category: classify_path(&entry.path),
            reason: entry.explanation.clone(),
            suggestion: entry.suggestion.clone(),
        })
        .collect()
}

fn explain_path(path: &str, diff: i64, level: DiskGrowthLevel) -> (String, String) {
    let lower_path = path.to_lowercase();
    let readable = format_size(diff.abs() as u64);
    let direction = if diff > 0 { "增加" } else { "减少" };

    if lower_path.contains("/windows/softwaredistribution") {
        (
            format!("Windows 更新缓存{}了 {}", direction, readable),
            "可在系统更新完成后通过 Windows 磁盘清理处理".to_string(),
        )
    } else if lower_path.contains("/users/") && lower_path.contains("/appdata/") {
        (
            format!("用户 AppData 目录{}了 {}", direction, readable),
            "建议展开对应用户目录，确认具体应用缓存来源".to_string(),
        )
    } else if lower_path.contains("/program files") || lower_path.contains("/program files (x86)") {
        (
            format!("程序安装目录{}了 {}", direction, readable),
            "通常与软件安装、更新或游戏资源变化有关，请谨慎处理".to_string(),
        )
    } else if lower_path.contains("/programdata") {
        (
            format!("ProgramData 后台数据{}了 {}", direction, readable),
            "可能来自系统组件、驱动或应用后台缓存".to_string(),
        )
    } else if lower_path.contains("cache") || lower_path.contains("temp") {
        (
            format!("缓存/临时目录{}了 {}", direction, readable),
            "可结合应用状态判断是否需要清理缓存".to_string(),
        )
    } else {
        let label = match level {
            DiskGrowthLevel::Significant => "显著变化",
            DiskGrowthLevel::Fast => "快速变化",
            DiskGrowthLevel::Minor => "轻微变化",
            DiskGrowthLevel::Decreased => "空间释放",
            DiskGrowthLevel::New => "新增目录",
            DiskGrowthLevel::Stable => "基本稳定",
        };
        (
            format!("{}，空间{} {}", label, direction, readable),
            "建议打开目录确认具体文件来源".to_string(),
        )
    }
}

fn classify_path(path: &str) -> String {
    let lower_path = path.to_lowercase();
    if lower_path.contains("/windows") {
        "Windows".to_string()
    } else if lower_path.contains("/users/") {
        "用户数据".to_string()
    } else if lower_path.contains("/program files") || lower_path.contains("/program files (x86)") {
        "程序目录".to_string()
    } else if lower_path.contains("/programdata") {
        "后台数据".to_string()
    } else if lower_path.contains("$recycle.bin") {
        "回收站".to_string()
    } else {
        "其他目录".to_string()
    }
}

fn build_summary(
    total_growth: i64,
    significant_count: usize,
    fast_count: usize,
    decreased_count: usize,
) -> String {
    if total_growth > 0 {
        format!(
            "相比上次扫描，C 盘净增加 {}。发现 {} 个显著增长目录、{} 个快速增长目录。",
            format_size(total_growth as u64),
            significant_count,
            fast_count
        )
    } else if total_growth < 0 {
        format!(
            "相比上次扫描，C 盘净减少 {}，其中 {} 个目录释放了明显空间。",
            format_size(total_growth.unsigned_abs()),
            decreased_count
        )
    } else {
        "相比上次扫描，C 盘总占用基本没有变化。".to_string()
    }
}

fn path_depth(path: &str) -> u8 {
    path.trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1) as u8
}

fn format_size(bytes: u64) -> String {
    let value = bytes as f64;
    if value >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.2} GB", value / 1024.0 / 1024.0 / 1024.0)
    } else if value >= 1024.0 * 1024.0 {
        format!("{:.1} MB", value / 1024.0 / 1024.0)
    } else if value >= 1024.0 {
        format!("{:.1} KB", value / 1024.0)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_growth_levels() {
        assert_eq!(
            determine_level(2 * 1024 * 1024 * 1024, 1),
            DiskGrowthLevel::Significant
        );
        assert_eq!(
            determine_level(-100 * 1024 * 1024, 1),
            DiskGrowthLevel::Decreased
        );
    }
}
