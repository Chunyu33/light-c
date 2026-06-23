use super::{
    collect_model_files, source_from_models, unique_existing_paths, user_home_dir, DetectorOutput,
    ModelDetector,
};
use crate::ai_models::types::ModelItem;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

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

pub struct ComfyUiDetector {
    custom_paths: Vec<PathBuf>,
}

impl ComfyUiDetector {
    pub fn new(custom_paths: Vec<PathBuf>) -> Self {
        Self { custom_paths }
    }
}

impl ModelDetector for ComfyUiDetector {
    fn detect(&self) -> DetectorOutput {
        let mut candidate_roots = Vec::new();
        let mut install_roots = Vec::new();

        if let Some(home_dir) = user_home_dir() {
            for install_root in [
                home_dir.join("ComfyUI"),
                home_dir.join("Desktop").join("ComfyUI"),
                home_dir.join("Documents").join("ComfyUI"),
            ] {
                candidate_roots.push(install_root.join("models"));
                install_roots.push(install_root);
            }
        }

        if let Some(app_data_dir) = std::env::var_os("APPDATA").map(PathBuf::from) {
            let desktop_config_dir = app_data_dir.join("ComfyUI");
            candidate_roots.extend(read_comfyui_desktop_model_paths(&desktop_config_dir));
            candidate_roots.extend(read_extra_model_paths_file(
                &desktop_config_dir,
                &desktop_config_dir.join("extra_models_config.yaml"),
            ));
        }

        for drive_letter in ["C", "D", "E", "F"] {
            let install_root = PathBuf::from(format!("{}:\\ComfyUI", drive_letter));
            candidate_roots.push(install_root.join("models"));
            install_roots.push(install_root);
        }

        for custom_path in &self.custom_paths {
            if let Some(install_root) = find_comfyui_install_root(custom_path) {
                install_roots.push(install_root);
            }
            if let Some(models_path) = resolve_comfyui_models_path(custom_path) {
                candidate_roots.push(models_path);
            }
        }

        for install_root in unique_existing_paths(install_roots) {
            candidate_roots.extend(read_extra_model_paths(&install_root));
        }

        let mut models = Vec::new();
        let mut source_path = None;
        for root in unique_existing_paths(candidate_roots) {
            source_path.get_or_insert_with(|| root.clone());
            models.extend(collect_comfyui_models(&root));
        }

        DetectorOutput {
            source: source_from_models("ComfyUI", source_path.unwrap_or_default(), models),
            warnings: Vec::new(),
        }
    }
}

fn resolve_comfyui_models_path(path: &Path) -> Option<PathBuf> {
    if is_comfyui_models_dir(path) {
        return Some(path.to_path_buf());
    }

    let nested_models_path = path.join("models");
    if is_comfyui_models_dir(&nested_models_path) {
        return Some(nested_models_path);
    }

    None
}

fn is_comfyui_models_dir(path: &Path) -> bool {
    COMFYUI_MODEL_DIRS
        .iter()
        .any(|directory_name| path.join(directory_name).is_dir())
}

fn collect_comfyui_models(models_root: &Path) -> Vec<ModelItem> {
    let mut models = Vec::new();

    for directory_name in COMFYUI_MODEL_DIRS {
        let model_type_dir = models_root.join(directory_name);
        if !model_type_dir.is_dir() {
            continue;
        }

        let mut typed_models = collect_model_files(&model_type_dir, false);
        for model in &mut typed_models {
            // ComfyUI 的子目录本身就是资产类型，放进名称里能降低用户理解成本。
            model.name = format!("{} / {}", directory_name, model.name);
        }
        models.extend(typed_models);
    }

    models
}

fn find_comfyui_install_root(path: &Path) -> Option<PathBuf> {
    let mut current_path = Some(path);

    // 用户常选 models 或 models/checkpoints，向上少量回溯即可定位 ComfyUI 根目录，不做全盘搜索。
    for _ in 0..=3 {
        let candidate = current_path?;
        if candidate.join("extra_model_paths.yaml").is_file() || candidate.join("main.py").is_file()
        {
            return Some(candidate.to_path_buf());
        }
        current_path = candidate.parent();
    }

    None
}

fn read_extra_model_paths(install_root: &Path) -> Vec<PathBuf> {
    let yaml_path = install_root.join("extra_model_paths.yaml");
    read_extra_model_paths_file(install_root, &yaml_path)
}

fn read_extra_model_paths_file(base_dir: &Path, yaml_path: &Path) -> Vec<PathBuf> {
    let Ok(content) = fs::read_to_string(&yaml_path) else {
        return Vec::new();
    };

    parse_extra_model_paths(base_dir, &content)
}

fn read_comfyui_desktop_model_paths(config_dir: &Path) -> Vec<PathBuf> {
    let config_path = config_dir.join("config.json");
    let Ok(content) = fs::read_to_string(&config_path) else {
        return Vec::new();
    };

    let Ok(config) = serde_json::from_str::<Value>(&content) else {
        return Vec::new();
    };

    let Some(base_path_value) = find_json_string_key(&config, "basePath") else {
        return Vec::new();
    };

    let base_path = resolve_yaml_path(config_dir, &base_path_value);
    // 桌面版 basePath 指向 ComfyUI 工作区，模型仍按标准 models 子目录组织。
    vec![base_path.join("models")]
}

fn parse_extra_model_paths(install_root: &Path, content: &str) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut base_path: Option<PathBuf> = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || !line.contains(':') {
            continue;
        }

        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = cleanup_yaml_value(value);

        if key == "base_path" {
            base_path = Some(resolve_yaml_path(install_root, &value));
            continue;
        }

        let Some(current_base_path) = &base_path else {
            continue;
        };

        if key == "models" {
            roots.push(resolve_yaml_path(current_base_path, &value));
            continue;
        }

        if COMFYUI_MODEL_DIRS.contains(&key) {
            if let Some(parent_path) = resolve_model_type_parent(current_base_path, key, &value) {
                roots.push(parent_path);
            }
        }
    }

    if roots.is_empty() {
        if let Some(base_path) = base_path {
            roots.push(base_path.join("models"));
        }
    }

    roots
}

fn resolve_model_type_parent(
    base_path: &Path,
    directory_name: &str,
    value: &str,
) -> Option<PathBuf> {
    if value.is_empty() {
        return None;
    }

    let configured_path = resolve_yaml_path(base_path, value);
    if configured_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case(directory_name))
        .unwrap_or(false)
    {
        return configured_path.parent().map(Path::to_path_buf);
    }

    Some(configured_path)
}

fn cleanup_yaml_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_end_matches('/')
        .trim_end_matches('\\')
        .to_string()
}

fn resolve_yaml_path(base_path: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base_path.join(path)
    }
}

fn find_json_string_key(value: &Value, target_key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            for (key, child_value) in map {
                if key == target_key {
                    if let Some(text) = child_value.as_str() {
                        return Some(text.to_string());
                    }
                }

                if let Some(found_value) = find_json_string_key(child_value, target_key) {
                    return Some(found_value);
                }
            }
            None
        }
        Value::Array(values) => values
            .iter()
            .find_map(|child_value| find_json_string_key(child_value, target_key)),
        _ => None,
    }
}
