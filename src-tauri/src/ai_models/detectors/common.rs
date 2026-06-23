use crate::ai_models::types::{AssetSource, ModelItem};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

const CUSTOM_MODEL_MIN_SIZE: u64 = 100 * 1024 * 1024;

pub fn user_home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

pub fn normalize_existing_path(path: PathBuf) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }

    // canonicalize 可以合并同一路径的不同写法，失败时保留原路径避免权限问题中断扫描。
    Some(path.canonicalize().unwrap_or(path))
}

pub fn unique_existing_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut unique_paths = Vec::new();

    for path in paths {
        if let Some(existing_path) = normalize_existing_path(path) {
            let key = existing_path.to_string_lossy().to_lowercase();
            if seen.insert(key) {
                unique_paths.push(existing_path);
            }
        }
    }

    unique_paths
}

pub fn directory_size(path: &Path) -> u64 {
    WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

pub fn file_size(path: &Path) -> Option<u64> {
    path.metadata()
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

pub fn is_model_extension(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        extension.to_ascii_lowercase().as_str(),
        "gguf" | "safetensors" | "ckpt" | "onnx" | "pt" | "pth" | "bin"
    )
}

pub fn is_high_confidence_model_extension(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        extension.to_ascii_lowercase().as_str(),
        "gguf" | "safetensors" | "ckpt"
    )
}

pub fn collect_model_files(root: &Path, custom_mode: bool) -> Vec<ModelItem> {
    let mut models: Vec<ModelItem> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(skip_hidden_system_noise)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let path = entry.path();
            if !is_model_extension(path) {
                return None;
            }

            let size = file_size(path)?;
            // 自定义目录没有平台结构兜底，必须收紧条件，避免 .bin/.pt 这类扩展造成大量误判。
            if custom_mode
                && (size < CUSTOM_MODEL_MIN_SIZE || !is_high_confidence_model_extension(path))
            {
                return None;
            }

            Some(ModelItem {
                name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("未命名模型")
                    .to_string(),
                size,
                path: path.to_path_buf(),
            })
        })
        .collect();

    models.sort_by(|left, right| right.size.cmp(&left.size));
    models
}

pub fn source_from_models(
    name: &str,
    path: PathBuf,
    mut models: Vec<ModelItem>,
) -> Option<AssetSource> {
    if models.is_empty() {
        return None;
    }

    models.sort_by(|left, right| right.size.cmp(&left.size));
    let total_size = models.iter().map(|model| model.size).sum();

    Some(AssetSource {
        name: name.to_string(),
        path,
        total_size,
        model_count: models.len(),
        models,
    })
}

fn skip_hidden_system_noise(entry: &DirEntry) -> bool {
    let file_name = entry.file_name().to_string_lossy();

    // 这些目录不会承载用户可管理的模型资产，跳过可以减少递归成本和误判。
    !matches!(
        file_name.as_ref(),
        ".git" | "node_modules" | "target" | "$RECYCLE.BIN" | "System Volume Information"
    )
}
