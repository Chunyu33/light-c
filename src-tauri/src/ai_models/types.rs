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
}
