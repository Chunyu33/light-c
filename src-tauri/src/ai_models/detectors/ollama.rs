use super::{file_size, unique_existing_paths, user_home_dir, DetectorOutput, ModelDetector};
use crate::ai_models::types::{AssetSource, ModelItem};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub struct OllamaDetector {
    custom_paths: Vec<PathBuf>,
}

impl OllamaDetector {
    pub fn new(custom_paths: Vec<PathBuf>) -> Self {
        Self { custom_paths }
    }
}

impl ModelDetector for OllamaDetector {
    fn detect(&self) -> DetectorOutput {
        let mut warnings = Vec::new();
        let mut candidate_roots = Vec::new();

        if let Ok(models_path) = std::env::var("OLLAMA_MODELS") {
            candidate_roots.push(PathBuf::from(models_path));
        }

        if let Some(home_dir) = user_home_dir() {
            candidate_roots.push(home_dir.join(".ollama").join("models"));
        }

        for custom_path in &self.custom_paths {
            if looks_like_ollama_root(custom_path) {
                candidate_roots.push(custom_path.clone());
            }
        }

        let roots = unique_existing_paths(candidate_roots);
        let mut merged_models = Vec::new();
        let mut referenced_blobs = HashSet::new();
        let mut source_path = None;

        for root in roots {
            let manifests_dir = root.join("manifests");
            let blobs_dir = root.join("blobs");
            if !manifests_dir.is_dir() || !blobs_dir.is_dir() {
                continue;
            }

            source_path.get_or_insert_with(|| root.clone());
            match read_ollama_models(&root, &mut referenced_blobs) {
                Ok(models) => merged_models.extend(models),
                Err(error) => warnings.push(error),
            }
        }

        merged_models.sort_by(|left, right| right.size.cmp(&left.size));
        let total_size = referenced_blobs
            .iter()
            .filter_map(|path| file_size(path))
            .sum();

        DetectorOutput {
            source: (!merged_models.is_empty()).then(|| AssetSource {
                name: "Ollama".to_string(),
                path: source_path.unwrap_or_default(),
                total_size,
                model_count: merged_models.len(),
                models: merged_models,
            }),
            warnings,
        }
    }
}

fn looks_like_ollama_root(path: &Path) -> bool {
    path.join("manifests").is_dir() && path.join("blobs").is_dir()
}

fn read_ollama_models(
    root: &Path,
    referenced_blobs: &mut HashSet<PathBuf>,
) -> Result<Vec<ModelItem>, String> {
    let manifests_dir = root.join("manifests");
    let blobs_dir = root.join("blobs");
    let mut models = Vec::new();

    for entry in WalkDir::new(&manifests_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let manifest_path = entry.path();
        let manifest_text = fs::read_to_string(manifest_path).map_err(|error| {
            format!(
                "读取 Ollama manifest 失败：{}，{}",
                manifest_path.display(),
                error
            )
        })?;
        let manifest: Value = serde_json::from_str(&manifest_text).map_err(|error| {
            format!(
                "解析 Ollama manifest 失败：{}，{}",
                manifest_path.display(),
                error
            )
        })?;

        let mut model_blobs = HashSet::new();
        if let Some(layers) = manifest.get("layers").and_then(|value| value.as_array()) {
            for layer in layers {
                let Some(digest) = layer.get("digest").and_then(|value| value.as_str()) else {
                    continue;
                };
                if let Some(blob_path) = digest_to_blob_path(&blobs_dir, digest) {
                    model_blobs.insert(blob_path.clone());
                    referenced_blobs.insert(blob_path);
                }
            }
        }

        if let Some(config_digest) = manifest
            .get("config")
            .and_then(|value| value.get("digest"))
            .and_then(|value| value.as_str())
        {
            if let Some(blob_path) = digest_to_blob_path(&blobs_dir, config_digest) {
                model_blobs.insert(blob_path.clone());
                referenced_blobs.insert(blob_path);
            }
        }

        let size = model_blobs.iter().filter_map(|path| file_size(path)).sum();
        if size == 0 {
            continue;
        }

        models.push(ModelItem {
            name: manifest_model_name(&manifests_dir, manifest_path),
            size,
            // Ollama 的真实权重是共享 blob，展示根目录比 sha256 文件更符合用户定位心智。
            path: root.to_path_buf(),
        });
    }

    Ok(models)
}

fn digest_to_blob_path(blobs_dir: &Path, digest: &str) -> Option<PathBuf> {
    let normalized_digest = digest.strip_prefix("sha256:")?;
    Some(blobs_dir.join(format!("sha256-{}", normalized_digest)))
}

fn manifest_model_name(manifests_dir: &Path, manifest_path: &Path) -> String {
    let relative_parts: Vec<String> = manifest_path
        .strip_prefix(manifests_dir)
        .unwrap_or(manifest_path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();

    if relative_parts.len() >= 4 {
        let namespace = &relative_parts[1];
        let model_name = &relative_parts[2];
        let tag = &relative_parts[3];
        if namespace == "library" {
            return format!("{}:{}", model_name, tag);
        }
        return format!("{}/{}:{}", namespace, model_name, tag);
    }

    manifest_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Ollama 模型")
        .to_string()
}
