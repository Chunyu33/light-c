mod comfyui;
mod common;
mod huggingface;
mod lm_studio;
mod ollama;

use crate::ai_models::types::AssetSource;

pub trait ModelDetector: Send + Sync {
    fn detect(&self) -> DetectorOutput;
}

#[derive(Debug, Default)]
pub struct DetectorOutput {
    pub source: Option<AssetSource>,
    pub warnings: Vec<String>,
}

pub fn create_detectors() -> Vec<Box<dyn ModelDetector>> {
    vec![
        Box::new(ollama::OllamaDetector::new()),
        Box::new(lm_studio::LmStudioDetector::new()),
        Box::new(comfyui::ComfyUiDetector::new()),
        Box::new(huggingface::HuggingFaceDetector::new()),
    ]
}

pub(crate) use common::{
    collect_model_files, collect_prefixed_model_files, directory_size_deduped, file_size,
    linked_file_size, source_from_models, unique_existing_paths, user_home_dir,
};
