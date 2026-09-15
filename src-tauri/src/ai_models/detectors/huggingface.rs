use super::{
    directory_size_deduped, linked_file_size, source_from_models, unique_existing_paths,
    user_home_dir, DetectorOutput, ModelDetector,
};
use crate::ai_models::types::ModelItem;
use std::path::{Path, PathBuf};

pub struct HuggingFaceDetector;

impl HuggingFaceDetector {
    pub fn new() -> Self {
        Self
    }
}

impl ModelDetector for HuggingFaceDetector {
    fn detect(&self) -> DetectorOutput {
        let mut candidate_roots = Vec::new();

        if let Ok(hf_home) = std::env::var("HF_HOME") {
            // HuggingFace 官方允许通过 HF_HOME 改缓存根目录，优先读取它能覆盖大多数迁移到其他盘的用户。
            candidate_roots.push(PathBuf::from(hf_home));
        }

        if let Some(home_dir) = user_home_dir() {
            candidate_roots.push(home_dir.join(".cache").join("huggingface"));
        }

        let mut models = Vec::new();
        let mut source_path = None;

        for root in unique_existing_paths(candidate_roots) {
            source_path.get_or_insert_with(|| root.clone());
            let mut collected = collect_huggingface_models(&root);
            models.append(&mut collected);
        }

        // 各模型体积按"自己引用的数据"累加，共享同一个 blob 时总数会大于磁盘占用，
        // 因此整体占用单独按缓存目录的真实文件统计（符号链接不计入，由 blobs 负责）。
        let total_size = source_path
            .as_deref()
            .map(directory_size_deduped)
            .unwrap_or(0);

        DetectorOutput {
            source: source_from_models("HuggingFace", source_path.unwrap_or_default(), models)
                .map(|source| crate::ai_models::types::AssetSource {
                    total_size: total_size.max(source.total_size),
                    ..source
                }),
            warnings: Vec::new(),
        }
    }
}

/// 收集 HuggingFace 缓存里的模型。
///
/// 单个模型的体积等于"目录内真实文件"加上"该目录内符号链接指向的目标文件"：
/// 快照文件全部是指向 blobs 的链接，Windows 上链接自身长度为 0，必须按目标解析，
/// 否则模型会被算成 0 字节并从列表里丢掉。
fn collect_huggingface_models(root: &Path) -> Vec<ModelItem> {
    let mut models = Vec::new();

    let hub_dir = root.join("hub");
    if !hub_dir.is_dir() {
        return models;
    }

    let Ok(entries) = hub_dir.read_dir() else {
        return models;
    };

    for entry in entries.filter_map(Result::ok) {
        let model_dir = entry.path();
        if !model_dir.is_dir() {
            continue;
        }

        let Some(dir_name) = model_dir.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !dir_name.starts_with("models--") {
            continue;
        }

        // 缓存未下载完成时目录存在但没有任何权重，这种空壳不该出现在模型列表里
        let size = model_cache_size(&model_dir);
        if size == 0 {
            continue;
        }

        models.push(ModelItem {
            name: huggingface_model_name(&model_dir),
            size,
            path: model_dir,
        });
    }

    models.sort_by(|left, right| right.size.cmp(&left.size));
    models
}

/// 统计单个模型缓存的体积。
///
/// 快照里的权重都是指向 blobs 的符号链接，这里按"链接指向的目标"计入，
/// 但**不**再递归统计 blobs 目录本身：否则同一份数据会被算两次
/// （blobs 里的真实文件一次、快照链接一次）。
fn model_cache_size(model_dir: &Path) -> u64 {
    let mut total = 0u64;
    let snapshots_dir = model_dir.join("snapshots");

    for version_dir in std::fs::read_dir(&snapshots_dir)
        .map(|entries| entries.filter_map(Result::ok).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        // 只取最新一轮快照：同一模型可能有多个版本目录，逐版本累加会重复计算共享权重
        let Ok(files) = std::fs::read_dir(version_dir.path()) else {
            continue;
        };
        total = total.max(
            files
                .filter_map(Result::ok)
                .filter_map(|file| linked_file_size(&file.path()))
                .sum(),
        );
    }

    if total > 0 {
        return total;
    }

    // 没有标准快照结构的缓存（旧版本或手工放置）：退化为统计目录内的真实文件
    directory_size_deduped(model_dir)
}

fn huggingface_model_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|name| {
            name.strip_prefix("models--")
                .unwrap_or(name)
                .replace("--", "/")
        })
        .unwrap_or_else(|| "HuggingFace 模型缓存".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn fixture(name: &str) -> PathBuf {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "lightc-hf-{}-{}-{}",
            name,
            std::process::id(),
            sequence
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建测试目录失败");
        dir
    }

    /// 复刻 HuggingFace 的缓存结构：真实文件在 blobs，snapshots 里全是指向它的符号链接。
    /// 修复前按目录逐层累加会把模型算成 0 字节并从列表里丢掉。
    #[cfg(target_os = "windows")]
    #[test]
    fn counts_symlinked_model_weights_from_blobs() {
        let root = fixture("symlink");
        let model_dir = root.join("hub").join("models--Systran--faster-whisper-base");
        let blobs_dir = model_dir.join("blobs");
        let snapshot_dir = model_dir
            .join("snapshots")
            .join("ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66");
        std::fs::create_dir_all(&blobs_dir).unwrap();
        std::fs::create_dir_all(&snapshot_dir).unwrap();

        // 权重 1MB，配置 1KB
        std::fs::write(blobs_dir.join("weight-blob"), vec![0u8; 1024 * 1024]).unwrap();
        std::fs::write(blobs_dir.join("config-blob"), vec![0u8; 1024]).unwrap();

        // 无法创建符号链接（未开启开发者模式）时跳过，避免测试环境误报失败
        if std::os::windows::fs::symlink_file(
            blobs_dir.join("weight-blob"),
            snapshot_dir.join("model.bin"),
        )
        .is_err()
        {
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        std::os::windows::fs::symlink_file(
            blobs_dir.join("config-blob"),
            snapshot_dir.join("config.json"),
        )
        .unwrap();

        let models = collect_huggingface_models(&root);

        assert_eq!(models.len(), 1, "符号链接指向的模型不应被丢弃");
        assert_eq!(models[0].name, "Systran/faster-whisper-base");
        assert_eq!(
            models[0].size,
            1024 * 1024 + 1024,
            "应按真实权重统计，而不是符号链接自身的 0 字节"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn counts_plain_files_when_blobs_are_not_used() {
        // 旧版本或手工放置的缓存没有 blobs，直接放真实文件
        let root = fixture("plain");
        let model_dir = root.join("hub").join("models--org--model");
        std::fs::create_dir_all(model_dir.join("snapshots").join("v1")).unwrap();
        std::fs::write(
            model_dir.join("snapshots").join("v1").join("pytorch_model.bin"),
            vec![0u8; 4096],
        )
        .unwrap();

        let models = collect_huggingface_models(&root);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].size, 4096);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_empty_model_shells() {
        let root = fixture("empty");
        std::fs::create_dir_all(root.join("hub").join("models--org--empty")).unwrap();

        let models = collect_huggingface_models(&root);

        assert!(models.is_empty(), "没有任何权重的空壳不应出现在列表里");

        let _ = std::fs::remove_dir_all(&root);
    }
}
