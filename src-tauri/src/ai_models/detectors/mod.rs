mod comfyui;
mod common;
mod custom;
mod huggingface;
mod lm_studio;
mod ollama;

use crate::ai_models::types::AssetSource;
use std::path::PathBuf;

pub trait ModelDetector: Send + Sync {
    fn detect(&self) -> DetectorOutput;
}

#[derive(Debug, Default)]
pub struct DetectorOutput {
    pub source: Option<AssetSource>,
    pub warnings: Vec<String>,
}

pub fn create_detectors(custom_paths: Vec<PathBuf>) -> Vec<Box<dyn ModelDetector>> {
    vec![
        Box::new(ollama::OllamaDetector::new(custom_paths.clone())),
        Box::new(lm_studio::LmStudioDetector::new(custom_paths.clone())),
        Box::new(comfyui::ComfyUiDetector::new(custom_paths.clone())),
        Box::new(huggingface::HuggingFaceDetector::new(custom_paths.clone())),
        Box::new(custom::CustomDirectoryDetector::new(custom_paths)),
    ]
}

pub(crate) use common::{
    collect_model_files, directory_size, file_size, source_from_models, unique_existing_paths,
    user_home_dir,
};
