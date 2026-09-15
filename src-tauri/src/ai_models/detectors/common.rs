use crate::ai_models::model_file_rules::{
    is_model_package_directory, is_supported_model_extension,
};
use crate::ai_models::types::{AssetSource, ModelItem};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

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

/// 读取文件的真实占用：符号链接要跟随到目标文件。
///
/// HuggingFace 等工具的缓存目录里，实际文件放在 blobs 下，模型目录里全是符号链接。
/// Windows 上符号链接自身的长度是 0，用 symlink_metadata 会把有数据的模型算成 0 字节。
pub fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

/// 目录遍历的安全上限。
///
/// 统计对象可能是用户通过环境变量指定的目录（HF_HOME / OLLAMA_MODELS），
/// 指向超大目录时不能让一次扫描无限展开，因此同时限制深度和条目数。
const MAX_SIZE_WALK_DEPTH: usize = 12;
const MAX_SIZE_WALK_ENTRIES: usize = 200_000;

/// 目录自身的真实占用：只统计真实文件，不跟随重解析点。
///
/// 用于"缓存根目录"这类统计：其中的符号链接由目标目录负责计入，因此总额等于真实磁盘占用。
pub fn directory_size_deduped(path: &Path) -> u64 {
    let mut budget = MAX_SIZE_WALK_ENTRIES;
    directory_size_with_budget(path, 0, &mut budget)
}

fn directory_size_with_budget(path: &Path, depth: usize, budget: &mut usize) -> u64 {
    if depth > MAX_SIZE_WALK_DEPTH || *budget == 0 {
        return 0;
    }

    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };

    if metadata.is_file() {
        return metadata.len();
    }

    if !metadata.is_dir() {
        return 0;
    }

    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };

    let mut total = 0u64;
    for entry in entries.filter_map(Result::ok) {
        if *budget == 0 {
            break;
        }
        *budget -= 1;

        let name = entry.file_name();
        if is_noise_directory_name(&name.to_string_lossy()) {
            continue;
        }

        total += directory_size_with_budget(&entry.path(), depth + 1, budget);
    }

    total
}

/// 解析一个重解析点（符号链接/联接）指向的真实路径。
///
/// HuggingFace 的快照文件是指向 blobs 的符号链接，需要按目标文件统计，
/// 否则 Windows 上链接自身长度为 0，模型会被算成空模型。
pub fn resolve_reparse_target(path: &Path) -> Option<PathBuf> {
    let target = std::fs::read_link(path).ok()?;
    if target.is_absolute() {
        return Some(target);
    }

    // 相对链接的基准是链接所在目录
    path.parent().map(|parent| parent.join(&target))
}

/// 解析模型目录里某个条目的真实体积：真实文件直接取大小，符号链接取目标文件大小。
pub fn linked_file_size(path: &Path) -> Option<u64> {
    let metadata = std::fs::symlink_metadata(path).ok()?;

    if metadata.is_file() {
        return Some(metadata.len());
    }

    if !metadata.file_type().is_symlink() {
        return None;
    }

    let target = resolve_reparse_target(path)?;
    std::fs::symlink_metadata(&target)
        .ok()
        .filter(|target_metadata| target_metadata.is_file())
        .map(|target_metadata| target_metadata.len())
}

/// 统计时需要跳过的目录名。
fn is_noise_directory_name(file_name: &str) -> bool {
    matches!(
        file_name,
        ".git" | "node_modules" | "target" | "$RECYCLE.BIN" | "System Volume Information"
    )
}

pub fn is_model_extension(path: &Path) -> bool {
    is_supported_model_extension(path)
}

pub fn collect_model_files(root: &Path) -> Vec<ModelItem> {
    collect_model_files_with_min_size(root, 0)
}

/// 按最小体积阈值收集模型文件。
///
/// 已知平台目录（ComfyUI 各类型目录等）里文件语义明确，用 0 阈值即可；
/// 但把用户自定义根目录（OLLAMA_MODELS / HF_HOME）直接挂进来时必须加阈值，
/// 否则该目录下的 config.json 之类小文件会被当成模型资产。
pub fn collect_model_files_with_min_size(root: &Path, min_size: u64) -> Vec<ModelItem> {
    let mut models: Vec<ModelItem> = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(skip_hidden_system_noise)
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if entry.file_type().is_dir() && is_model_package_directory(path) {
                // Core ML 的 .mlpackage 是目录包，不会被文件扩展名逻辑命中，需要按目录整体计入资产。
                let size = directory_size(path);
                if size > 0 {
                    return Some(ModelItem {
                        name: path
                            .file_name()
                            .and_then(|value| value.to_str())
                            .unwrap_or("未命名模型包")
                            .to_string(),
                        size,
                        path: path.to_path_buf(),
                    });
                }
            }

            if !entry.file_type().is_file() {
                return None;
            }

            if !is_model_extension(path) {
                return None;
            }

            let size = file_size(path)?;
            if size < min_size {
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

/// 带上来源前缀的模型文件收集：同名文件在不同模型目录里用"来源 / 文件名"区分，便于在列表里定位。
pub fn collect_prefixed_model_files(root: &Path, prefix: &str) -> Vec<ModelItem> {
    let mut models = collect_model_files(root);
    for model in &mut models {
        model.name = format!("{} / {}", prefix, model.name);
    }
    models
}

fn skip_hidden_system_noise(entry: &DirEntry) -> bool {
    let file_name = entry.file_name().to_string_lossy();

    // 这些目录不会承载用户可管理的模型资产，跳过可以减少递归成本和误判。
    !matches!(
        file_name.as_ref(),
        ".git" | "node_modules" | "target" | "$RECYCLE.BIN" | "System Volume Information"
    )
}
