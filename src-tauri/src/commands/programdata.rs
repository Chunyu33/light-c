// ============================================================================
// ProgramData 分析与清理命令
// ============================================================================

use log::info;
use serde::{Deserialize, Serialize};

// ============================================================================
// 前端通信数据结构
// ============================================================================

/// 分析结果的前端响应格式（单条）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramDataAnalyzeEntryResponse {
    pub path: String,
    pub size: u64,
    pub category: String,
    pub risk: crate::scanner::programdata_rules::RiskLevel,
    pub action: crate::scanner::programdata_rules::ActionType,
    pub reason: String,
    pub suggestion: String,
    pub matched_rule_id: Option<String>,
    pub tags: Vec<String>,
}

/// 分析结果的前端响应格式（批量）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramDataAnalyzeResponse {
    pub entries: Vec<ProgramDataAnalyzeEntryResponse>,
    pub cleanable_size: u64,
    pub warning_size: u64,
}

/// 合并扫描+分析的前端响应格式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramDataScanAndAnalyzeResponse {
    pub total_size: u64,
    pub total_files_scanned: usize,
    pub scan_duration_ms: u64,
    pub inaccessible_count: usize,
    pub analyze: ProgramDataAnalyzeResponse,
}

// ============================================================================
// 命令
// ============================================================================

/// 扫描 ProgramData 目录
#[tauri::command]
pub async fn scan_programdata() -> Result<crate::scanner::ProgramDataScanResult, String> {
    use crate::scanner::{ProgramDataScanner, SnapshotBuilder};

    info!("开始扫描 ProgramData 目录");

    let result = tokio::task::spawn_blocking(move || {
        let scanner = ProgramDataScanner::new();
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务执行失败: {}", e))?;

    info!(
        "ProgramData 扫描完成: {} 个目录，总大小 {} 字节，耗时 {}ms",
        result.entries.len(),
        result.total_size,
        result.scan_duration_ms
    );

    // 同步保存快照
    let snapshot_entries: Vec<(String, u64)> = result
        .entries
        .iter()
        .map(|e| (e.path.clone(), e.size))
        .collect();
    let total_size = result.total_size;

    let snapshot = SnapshotBuilder::new()
        .total_size(total_size)
        .with_first_level_entries(snapshot_entries)
        .build();
    if let Err(e) = crate::scanner::save_snapshot(&snapshot) {
        log::warn!("保存快照失败（不影响扫描结果）: {:?}", e);
    } else {
        log::info!("已保存 ProgramData 快照");
    }

    Ok(result)
}

/// 扫描并分析 ProgramData（合并 scan + analyze，减少前端 IPC 往返）
#[tauri::command]
pub async fn scan_and_analyze_programdata(
) -> Result<ProgramDataScanAndAnalyzeResponse, String> {
    use crate::scanner::programdata_rules::{ActionType as PdActionType, RiskLevel as PdRiskLevel};
    use crate::scanner::{ProgramDataScanner, RuleEngine, SnapshotBuilder};

    info!("开始扫描并分析 ProgramData");

    let result = tokio::task::spawn_blocking(move || {
        let scanner = ProgramDataScanner::new();
        let scan_result = scanner.scan();

        let engine = RuleEngine::default();
        let analyze_input: Vec<(String, u64)> = scan_result
            .entries
            .iter()
            .map(|e| (e.path.clone(), e.size))
            .collect();
        let batch_result = engine.analyze_batch(&analyze_input);

        let cleanable_size: u64 = batch_result
            .results
            .iter()
            .filter(|r| {
                r.risk == PdRiskLevel::Safe
                    && matches!(r.action, PdActionType::Delete | PdActionType::Suggest)
            })
            .map(|r| r.size)
            .sum();
        let warning_size: u64 = batch_result
            .results
            .iter()
            .filter(|r| r.risk == PdRiskLevel::Warning)
            .map(|r| r.size)
            .sum();

        let response_entries: Vec<ProgramDataAnalyzeEntryResponse> = batch_result
            .results
            .into_iter()
            .map(|r| ProgramDataAnalyzeEntryResponse {
                path: r.path,
                size: r.size,
                category: r.category,
                risk: r.risk,
                action: r.action,
                reason: r.reason,
                suggestion: r.suggestion,
                matched_rule_id: r.matched_rule_id,
                tags: r.tags,
            })
            .collect();

        // 同步保存快照
        let snapshot_entries: Vec<(String, u64)> = scan_result
            .entries
            .iter()
            .map(|e| (e.path.clone(), e.size))
            .collect();
        let total_size = scan_result.total_size;
        let snapshot = SnapshotBuilder::new()
            .total_size(total_size)
            .with_first_level_entries(snapshot_entries)
            .build();
        if let Err(e) = crate::scanner::save_snapshot(&snapshot) {
            log::warn!("保存快照失败（不影响扫描结果）: {:?}", e);
        }

        Ok::<_, String>(ProgramDataScanAndAnalyzeResponse {
            total_size: scan_result.total_size,
            total_files_scanned: scan_result.total_files_scanned,
            scan_duration_ms: scan_result.scan_duration_ms,
            inaccessible_count: scan_result.inaccessible_count,
            analyze: ProgramDataAnalyzeResponse {
                entries: response_entries,
                cleanable_size,
                warning_size,
            },
        })
    })
    .await
    .map_err(|e| format!("扫描分析任务执行失败: {}", e))??;

    info!(
        "ProgramData 扫描分析完成: {} 条目，可清理 {} 字节",
        result.analyze.entries.len(),
        result.analyze.cleanable_size
    );

    Ok(result)
}

/// 分析 ProgramData 扫描结果
#[tauri::command]
pub async fn analyze_programdata(
    entries: Vec<crate::scanner::ProgramDataEntry>,
) -> Result<ProgramDataAnalyzeResponse, String> {
    use crate::scanner::programdata_rules::{ActionType as PdActionType, RiskLevel as PdRiskLevel};
    use crate::scanner::RuleEngine;

    info!("开始分析 ProgramData，共 {} 个条目", entries.len());

    let result = tokio::task::spawn_blocking(move || {
        let engine = RuleEngine::default();
        let analyze_input: Vec<(String, u64)> =
            entries.iter().map(|e| (e.path.clone(), e.size)).collect();
        engine.analyze_batch(&analyze_input)
    })
    .await
    .map_err(|e| format!("分析任务执行失败: {}", e))?;

    let cleanable_size: u64 = result
        .results
        .iter()
        .filter(|r| {
            r.risk == PdRiskLevel::Safe
                && matches!(r.action, PdActionType::Delete | PdActionType::Suggest)
        })
        .map(|r| r.size)
        .sum();
    let warning_size: u64 = result
        .results
        .iter()
        .filter(|r| r.risk == PdRiskLevel::Warning)
        .map(|r| r.size)
        .sum();

    let response_entries: Vec<ProgramDataAnalyzeEntryResponse> = result
        .results
        .into_iter()
        .map(|r| ProgramDataAnalyzeEntryResponse {
            path: r.path,
            size: r.size,
            category: r.category,
            risk: r.risk,
            action: r.action,
            reason: r.reason,
            suggestion: r.suggestion,
            matched_rule_id: r.matched_rule_id,
            tags: r.tags,
        })
        .collect();

    info!(
        "ProgramData 分析完成: {} 条结果，可清理 {} 字节",
        response_entries.len(),
        cleanable_size
    );

    Ok(ProgramDataAnalyzeResponse {
        entries: response_entries,
        cleanable_size,
        warning_size,
    })
}

/// 对比 ProgramData 增长
#[tauri::command]
pub async fn diff_programdata() -> Result<crate::scanner::GrowthReport, String> {
    use crate::scanner::{compare_growth_with_timespan, SnapshotManager};

    info!("开始对比 ProgramData 增长");

    let result = tokio::task::spawn_blocking(
        move || -> Result<crate::scanner::GrowthReport, String> {
            let manager =
                SnapshotManager::new().map_err(|e| format!("初始化快照管理器失败: {:?}", e))?;

            let snapshots = manager
                .load_all_snapshots()
                .map_err(|e| format!("加载快照失败: {:?}", e))?;

            if snapshots.len() < 2 {
                return Ok(crate::scanner::GrowthReport {
                    entries: Vec::new(),
                    total_growth: 0,
                    significant_count: 0,
                    fast_count: 0,
                    new_count: 0,
                    decreased_count: 0,
                    time_span: "暂无历史数据".to_string(),
                    summary: "首次扫描，暂无增长对比数据。下次扫描后将自动生成增长报告。"
                        .to_string(),
                });
            }

            let current_snapshot = &snapshots[0];
            let previous_snapshot = &snapshots[1];

            let current: Vec<(String, u64)> = current_snapshot
                .entries
                .iter()
                .map(|e| (e.path.clone(), e.size))
                .collect();

            let previous: Vec<(String, u64)> = previous_snapshot
                .entries
                .iter()
                .map(|e| (e.path.clone(), e.size))
                .collect();

            let time_span = format!("{} → {}", previous_snapshot.date, current_snapshot.date);

            let report = compare_growth_with_timespan(&current, &previous, &time_span);

            // 如果所有条目都被判定为"新增"，说明快照格式不兼容（旧版 strip 前缀 vs 新版全路径）
            if report.new_count > 0 && report.new_count == report.entries.len() {
                log::warn!(
                    "增长对比：所有 {} 个条目均被判定为新增，返回空报告",
                    report.new_count
                );
                return Ok(crate::scanner::GrowthReport {
                    entries: Vec::new(),
                    total_growth: 0,
                    significant_count: 0,
                    fast_count: 0,
                    new_count: 0,
                    decreased_count: 0,
                    time_span: format!("{} → {}", previous_snapshot.date, current_snapshot.date),
                    summary: "历史数据格式已更新，本次暂无对比数据。下次扫描后将正常显示增长趋势。"
                        .to_string(),
                });
            }

            Ok(report)
        },
    )
    .await
    .map_err(|e| format!("增长对比任务执行失败: {}", e))??;

    info!(
        "ProgramData 增长对比完成: {} 个变化，总增长 {} 字节",
        result.entries.len(),
        result.total_growth
    );

    Ok(result)
}

/// 清理 ProgramData 目录
#[tauri::command]
pub async fn clean_programdata(
    entries: Vec<ProgramDataAnalyzeEntryResponse>,
    allow_warning: Option<bool>,
) -> Result<crate::scanner::BatchCleanResult, String> {
    use crate::scanner::{CleanOptions, ProgramDataCleaner};

    let allow_warning = allow_warning.unwrap_or(false);

    info!(
        "开始清理 ProgramData: {} 个条目，allow_warning={}",
        entries.len(),
        allow_warning
    );

    let analyze_entries: Vec<crate::scanner::AnalyzeResult> = entries
        .into_iter()
        .map(|e| crate::scanner::AnalyzeResult {
            path: e.path,
            size: e.size,
            category: e.category,
            risk: e.risk,
            action: e.action,
            reason: e.reason,
            suggestion: e.suggestion,
            matched_rule_id: e.matched_rule_id,
            tags: e.tags,
        })
        .collect();

    let result = tokio::task::spawn_blocking(move || {
        let options = if allow_warning {
            CleanOptions::with_warning_allowed()
        } else {
            CleanOptions::default()
        };
        let cleaner = ProgramDataCleaner::with_options(options);
        cleaner.clean(&analyze_entries)
    })
    .await
    .map_err(|e| format!("清理任务执行失败: {}", e))?;

    info!(
        "ProgramData 清理完成: 成功 {} 个，失败 {} 个，跳过 {} 个，释放 {} 字节",
        result.success_count, result.failed_count, result.skipped_count, result.freed_size
    );

    Ok(result)
}
