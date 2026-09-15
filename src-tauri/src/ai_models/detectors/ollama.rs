use super::{file_size, unique_existing_paths, user_home_dir, DetectorOutput, ModelDetector};
use crate::ai_models::types::{AssetSource, ModelItem};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// blobs 目录里未被 manifest 引用的权重，至少要有这么大才当作模型。
/// Ollama 的 blob 都是分片权重，远大于这个值；阈值只用于过滤残留的小文件。
const ORPHAN_BLOB_MIN_SIZE: u64 = 1024 * 1024;

pub struct OllamaDetector;

impl OllamaDetector {
    pub fn new() -> Self {
        Self
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

            // 有些用户的模型是通过复制目录、"导入"等方式放进去的，完全没有 manifest。
            // 只按 manifest 统计会整体报 0，因此再按文件特征补一遍，靠去重避免和上面的结果重复。
            merged_models.extend(collect_blobs_without_manifest(
                &blobs_dir,
                &mut referenced_blobs,
            ));
        }

        // 没有任何模型时不再返回空来源：目录存在但没有权重（只装过 Ollama 还没拉模型），
        // 报成"已发现 Ollama"会让用户误以为扫到了东西。
        if merged_models.is_empty() {
            return DetectorOutput {
                source: None,
                warnings,
            };
        }

        merged_models.sort_by(|left, right| right.size.cmp(&left.size));
        // 总量按"真实引用的 blob 文件"统计：多层模型之间会共享同一份权重，
        // 逐模型累加会把共享部分重复计入，导致总额大于磁盘实际占用。
        let total_size = referenced_blobs
            .iter()
            .filter_map(|path| file_size(path))
            .sum();

        DetectorOutput {
            source: Some(AssetSource {
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

/// 收集 blobs 下没有被任何 manifest 引用的权重文件。
///
/// Ollama 的 blob 文件名是 `sha256-<摘要>`，没有可读名字，这里用摘要前 12 位做展示名，
/// 保证用户至少能在列表里认出这是一个未被 manifest 记录的权重文件。
fn collect_blobs_without_manifest(
    blobs_dir: &Path,
    referenced_blobs: &mut HashSet<PathBuf>,
) -> Vec<ModelItem> {
    let mut models = Vec::new();

    for entry in WalkDir::new(blobs_dir)
        .follow_links(false)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path().to_path_buf();
        // 已由 manifest 记录过的权重不再重复统计
        if referenced_blobs.contains(&path) {
            continue;
        }

        let Some(size) = file_size(&path) else {
            continue;
        };
        // 过小的文件是残留碎片，不算模型；注意此时不能把它记进 referenced_blobs，
        // 否则会被误标成"已统计"而跳过后续判断。
        if size < ORPHAN_BLOB_MIN_SIZE {
            continue;
        }

        referenced_blobs.insert(path.clone());

        let digest = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("ollama-blob")
            .trim_start_matches("sha256-");
        let short_digest: String = digest.chars().take(12).collect();

        models.push(ModelItem {
            name: format!("未记录权重的 blob · {}", short_digest),
            size,
            path,
        });
    }

    models.sort_by(|left, right| right.size.cmp(&left.size));
    models
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn fixture(name: &str) -> PathBuf {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "lightc-ollama-{}-{}-{}",
            name,
            std::process::id(),
            sequence
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    /// 写一个 Ollama manifest，层摘要与配置文件摘要都指向 blobs 下的 sha256 文件。
    fn write_manifest(
        root: &Path,
        model: &str,
        tag: &str,
        layer_digests: &[&str],
        config_digest: &str,
    ) {
        let manifest_dir = root
            .join("manifests")
            .join("registry.ollama.ai")
            .join("library")
            .join(model);
        std::fs::create_dir_all(&manifest_dir).unwrap();

        let layers: Vec<String> = layer_digests
            .iter()
            .map(|digest| format!(r#"{{"digest":"sha256:{}"}}"#, digest))
            .collect();
        let manifest = format!(
            r#"{{"layers":[{}],"config":{{"digest":"sha256:{}"}}}}"#,
            layers.join(","),
            config_digest
        );
        std::fs::write(manifest_dir.join(tag), manifest).unwrap();
    }

    #[test]
    fn total_size_counts_shared_blobs_once() {
        let root = fixture("shared-blobs");
        let blobs_dir = root.join("blobs");
        std::fs::create_dir_all(&blobs_dir).unwrap();

        // 两个模型共享同一份权重层 d0，各自再带一个独有的小层
        std::fs::write(blobs_dir.join("sha256-d0"), vec![0u8; 1024]).unwrap();
        std::fs::write(blobs_dir.join("sha256-a1"), vec![0u8; 256]).unwrap();
        std::fs::write(blobs_dir.join("sha256-a2"), vec![0u8; 128]).unwrap();
        write_manifest(&root, "shared-a", "latest", &["d0", "a1"], "a1");
        write_manifest(&root, "shared-b", "latest", &["d0", "a2"], "a2");

        let mut referenced_blobs = HashSet::new();
        let models = read_ollama_models(&root, &mut referenced_blobs).unwrap();
        let per_model_total: u64 = models.iter().map(|model| model.size).sum();
        let distinct_total: u64 = referenced_blobs
            .iter()
            .filter_map(|path| file_size(path))
            .sum();

        assert_eq!(models.len(), 2);
        // 逐模型累加会把共享的 d0 算两次，磁盘真实占用只有一份
        assert_eq!(per_model_total, 1024 + 256 + 1024 + 128);
        assert_eq!(distinct_total, 1024 + 256 + 128);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn collects_blobs_without_manifest_once() {
        let root = fixture("orphan-blob");
        let blobs_dir = root.join("blobs");
        std::fs::create_dir_all(&blobs_dir).unwrap();
        std::fs::write(blobs_dir.join("sha256-d0"), vec![0u8; 2048]).unwrap();
        std::fs::write(blobs_dir.join("sha256-small"), vec![0u8; 16]).unwrap();
        write_manifest(&root, "imported", "latest", &["d0"], "d0");

        let mut referenced_blobs = HashSet::new();
        read_ollama_models(&root, &mut referenced_blobs).unwrap();

        // d0 已被 manifest 引用，不应再作为"未记录权重的 blob"重复出现
        let orphans = collect_blobs_without_manifest(&blobs_dir, &mut referenced_blobs);
        assert!(orphans.is_empty());

        // 未被引用的权重会被补进来；明显小于阈值（1MB）的碎片文件仍然被过滤
        std::fs::write(blobs_dir.join("sha256-orphan"), vec![0u8; 2 * 1024 * 1024]).unwrap();
        let orphans = collect_blobs_without_manifest(&blobs_dir, &mut referenced_blobs);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].size, 2 * 1024 * 1024);
        assert!(orphans[0].name.starts_with("未记录权重的 blob"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
