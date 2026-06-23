use super::{
    collect_model_files, source_from_models, unique_existing_paths, DetectorOutput, ModelDetector,
};
use std::path::PathBuf;

const COMFYUI_MODEL_DIRS: [&str; 12] = [
    "checkpoints",
    "diffusion_models",
    "unet",
    "loras",
    "embeddings",
    "vae",
    "text_encoders",
    "clip",
    "clip_vision",
    "controlnet",
    "upscale_models",
    "photomaker",
];

pub struct CustomDirectoryDetector {
    custom_paths: Vec<PathBuf>,
}

impl CustomDirectoryDetector {
    pub fn new(custom_paths: Vec<PathBuf>) -> Self {
        Self { custom_paths }
    }
}

impl ModelDetector for CustomDirectoryDetector {
    fn detect(&self) -> DetectorOutput {
        let roots = unique_existing_paths(self.custom_paths.clone());
        let mut models = Vec::new();
        let mut source_path = None;

        for root in roots {
            if looks_like_known_platform_root(&root) {
                continue;
            }
            source_path.get_or_insert_with(|| root.clone());
            models.extend(collect_model_files(&root, true));
        }

        DetectorOutput {
            source: source_from_models("自定义目录", source_path.unwrap_or_default(), models),
            warnings: Vec::new(),
        }
    }
}

fn looks_like_known_platform_root(path: &std::path::Path) -> bool {
    // 已知平台目录由专属 Detector 解析，自定义兜底跳过它们，避免同一模型重复计数。
    path.join("manifests").is_dir() && path.join("blobs").is_dir()
        || COMFYUI_MODEL_DIRS
            .iter()
            .any(|directory_name| path.join(directory_name).is_dir())
        || path.join("hub").is_dir()
        || path.components().any(|component| {
            let name = component.as_os_str().to_string_lossy();
            name.eq_ignore_ascii_case(".lmstudio") || name.eq_ignore_ascii_case("huggingface")
        })
}
