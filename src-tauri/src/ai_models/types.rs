use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
pub struct ModelItem {
    pub name: String,
    pub size: u64,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetSource {
    pub name: String,
    pub path: PathBuf,
    pub total_size: u64,
    pub model_count: usize,
    pub models: Vec<ModelItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiModelScanResult {
    pub total_size: u64,
    pub total_model_count: usize,
    pub source_count: usize,
    pub sources: Vec<AssetSource>,
    pub warnings: Vec<String>,
    pub scan_duration_ms: u128,
    pub discovery_mode: String,
    pub phase_durations: Vec<AiModelPhaseDuration>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiModelPhaseDuration {
    pub stage: String,
    pub label: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiModelScanProgress {
    pub stage: String,
    pub message: String,
    pub elapsed_ms: u128,
    pub stage_elapsed_ms: u128,
    /// 当前阶段涉及的盘符（如 "C"）。
    /// MFT 阶段文案需要它做插值，后端不传的话前端只能显示成 "正在枚举 {{drive}} 盘"。
    pub drive_label: Option<String>,
}
