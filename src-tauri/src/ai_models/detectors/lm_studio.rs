use super::{
    collect_model_files, source_from_models, unique_existing_paths, user_home_dir, DetectorOutput,
    ModelDetector,
};

pub struct LmStudioDetector;

impl LmStudioDetector {
    pub fn new() -> Self {
        Self
    }
}

impl ModelDetector for LmStudioDetector {
    fn detect(&self) -> DetectorOutput {
        let mut candidate_roots = Vec::new();

        if let Some(home_dir) = user_home_dir() {
            candidate_roots.push(home_dir.join(".lmstudio").join("models"));
            // 0.2.x 及更早版本的默认模型目录，升级后旧目录里的模型仍然占着空间。
            candidate_roots.push(
                home_dir
                    .join(".cache")
                    .join("lm-studio")
                    .join("models"),
            );
        }

        let mut models = Vec::new();
        let mut source_path = None;
        for root in unique_existing_paths(candidate_roots) {
            source_path.get_or_insert_with(|| root.clone());
            models.extend(collect_model_files(&root));
        }

        DetectorOutput {
            source: source_from_models("LM Studio", source_path.unwrap_or_default(), models),
            warnings: Vec::new(),
        }
    }
}
