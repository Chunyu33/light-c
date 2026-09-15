use super::{
    collect_prefixed_model_files, source_from_models, unique_existing_paths, user_home_dir,
    DetectorOutput, ModelDetector,
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

pub struct ComfyUiDetector;

impl ComfyUiDetector {
    pub fn new() -> Self {
        Self
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

        // 遍历真实存在的盘符，而不是写死 C~F：把 ComfyUI 装在 G 盘及之后的用户会整体漏扫
        for drive in available_drive_roots() {
            let install_root = drive.join("ComfyUI");
            candidate_roots.push(install_root.join("models"));
            install_roots.push(install_root);
        }

        for install_root in unique_existing_paths(install_roots) {
            candidate_roots.extend(read_extra_model_paths(&install_root));
        }

        let mut models = Vec::new();
        // 来源路径记录"实际扫出模型的那个根目录"，而不是第一个存在的候选目录：
        // 两者可能不同（例如配置指向 D 盘数据目录），写错会让用户以为另一个目录占了这些空间。
        let resolved_roots = unique_existing_paths(candidate_roots);
        let mut best_root_match: Option<(PathBuf, u64)> = None;

        for root in &resolved_roots {
            let mut found = collect_comfyui_models(root);
            let found_size: u64 = found.iter().map(|model| model.size).sum();
            if found_size > 0
                && best_root_match
                    .as_ref()
                    .map(|(_, size)| found_size > *size)
                    .unwrap_or(true)
            {
                best_root_match = Some((root.clone(), found_size));
            }
            models.append(&mut found);
        }

        let source_path = best_root_match
            .map(|(path, _)| path)
            .or_else(|| resolved_roots.first().cloned())
            .unwrap_or_default();

        DetectorOutput {
            source: source_from_models("ComfyUI", source_path, models),
            warnings: Vec::new(),
        }
    }
}

/// 枚举本机真实存在的盘符根目录（如 `D:\`）。
#[cfg(target_os = "windows")]
fn available_drive_roots() -> Vec<PathBuf> {
    (b'C'..=b'Z')
        .map(|letter| PathBuf::from(format!("{}:\\", letter as char)))
        .filter(|drive| drive.exists())
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn available_drive_roots() -> Vec<PathBuf> {
    vec![PathBuf::from("/")]
}

fn collect_comfyui_models(models_root: &Path) -> Vec<ModelItem> {
    let mut models = Vec::new();

    for directory_name in COMFYUI_MODEL_DIRS {
        let model_type_dir = models_root.join(directory_name);
        if !model_type_dir.is_dir() {
            continue;
        }

        // ComfyUI 的子目录本身就是资产类型，放进名称里能降低用户理解成本。
        models.extend(collect_prefixed_model_files(&model_type_dir, directory_name));
    }

    models
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
