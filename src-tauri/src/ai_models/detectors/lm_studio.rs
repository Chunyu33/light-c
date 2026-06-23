use super::{
    collect_model_files, source_from_models, unique_existing_paths, user_home_dir, DetectorOutput,
    ModelDetector,
};
use std::path::{Path, PathBuf};

pub struct LmStudioDetector {
    custom_paths: Vec<PathBuf>,
}

impl LmStudioDetector {
    pub fn new(custom_paths: Vec<PathBuf>) -> Self {
        Self { custom_paths }
    }
}

impl ModelDetector for LmStudioDetector {
    fn detect(&self) -> DetectorOutput {
        let mut candidate_roots = Vec::new();

        if let Some(home_dir) = user_home_dir() {
            candidate_roots.push(home_dir.join(".lmstudio").join("models"));
        }

        for custom_path in &self.custom_paths {
            if looks_like_lm_studio_root(custom_path) {
                candidate_roots.push(custom_path.clone());
            }
        }

        let mut models = Vec::new();
        let mut source_path = None;
        for root in unique_existing_paths(candidate_roots) {
            source_path.get_or_insert_with(|| root.clone());
            models.extend(collect_model_files(&root, false));
        }

        DetectorOutput {
            source: source_from_models("LM Studio", source_path.unwrap_or_default(), models),
            warnings: Vec::new(),
        }
    }
}

fn looks_like_lm_studio_root(path: &Path) -> bool {
    // LM Studio 只能用明确的 .lmstudio 路径识别；普通 models 目录太泛，会误伤 ComfyUI 等工具。
    path.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(".lmstudio")
    })
}
