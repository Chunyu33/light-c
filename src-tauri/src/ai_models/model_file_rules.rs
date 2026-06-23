use std::path::Path;

const MB: u64 = 1024 * 1024;
const HIGH_CONFIDENCE_MIN_SIZE: u64 = 50 * MB;
const MODEL_RUNTIME_MIN_SIZE: u64 = 100 * MB;
const CHECKPOINT_MIN_SIZE: u64 = 500 * MB;
const NOISY_MODEL_MIN_SIZE: u64 = 1024 * MB;

#[derive(Clone, Copy)]
enum ModelFileConfidence {
    High,
    Medium,
    Noisy,
}

#[derive(Clone, Copy)]
struct ModelFileRule {
    min_size_for_mft: u64,
    confidence: ModelFileConfidence,
}

pub fn is_model_file_path(path: &Path) -> bool {
    model_file_rule(path).is_some()
}

pub fn is_supported_model_extension(path: &Path) -> bool {
    is_model_file_path(path)
}

pub fn is_custom_directory_model_file(path: &Path, size: u64) -> bool {
    let Some(rule) = model_file_rule(path) else {
        return false;
    };

    // 自定义目录缺少平台结构背书，泛用训练产物扩展名必须排除，避免把普通开发产物误当模型资产。
    !matches!(rule.confidence, ModelFileConfidence::Noisy) && size >= HIGH_CONFIDENCE_MIN_SIZE
}

pub fn is_model_package_directory(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(extension.to_ascii_lowercase().as_str(), "mlpackage")
}

pub fn mft_model_min_size(file_name: &str) -> Option<u64> {
    model_file_rule(Path::new(file_name)).map(|rule| rule.min_size_for_mft)
}

fn model_file_rule(path: &Path) -> Option<ModelFileRule> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if is_tensorflow_checkpoint_data_file(&file_name) {
        return Some(ModelFileRule {
            min_size_for_mft: CHECKPOINT_MIN_SIZE,
            confidence: ModelFileConfidence::Medium,
        });
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();

    let rule = match extension.as_str() {
        // 本地大模型/扩散模型最常见的权重格式，扩展名本身置信度高，可以降低阈值覆盖 LoRA。
        "safetensors" | "gguf" | "ggml" => ModelFileRule {
            min_size_for_mft: HIGH_CONFIDENCE_MIN_SIZE,
            confidence: ModelFileConfidence::High,
        },
        // PyTorch/Stable Diffusion 常见 checkpoint，体积通常较大，但 .ckpt 在少量软件里也可能被复用。
        "ckpt" => ModelFileRule {
            min_size_for_mft: CHECKPOINT_MIN_SIZE,
            confidence: ModelFileConfidence::Medium,
        },
        // 推理运行时/跨平台模型格式，扩展名比较明确，适合在自定义目录和 MFT 兜底中直接识别。
        "onnx" | "ort" | "tflite" | "pb" | "h5" | "hdf5" | "keras" | "mlmodel" | "mnn" | "rknn"
        | "mindir" | "om" | "engine" | "plan" | "trt" | "uff" | "pdmodel" | "pdiparams"
        | "pdparams" | "caffemodel" | "dlc" | "hef" | "xmodel" | "bmodel" | "pte" | "task"
        | "mar" | "nemo" => ModelFileRule {
            min_size_for_mft: MODEL_RUNTIME_MIN_SIZE,
            confidence: ModelFileConfidence::Medium,
        },
        // Darknet 等老生态会使用 .weights，但这个名字也可能被普通软件复用，因此阈值高于通用运行时格式。
        "weights" | "t7" => ModelFileRule {
            min_size_for_mft: CHECKPOINT_MIN_SIZE,
            confidence: ModelFileConfidence::Medium,
        },
        // 这些扩展名在 Python/开发环境里太常见，只在体积很大或平台目录中才认为是模型候选。
        "bin" | "pt" | "pth" | "pkl" | "pickle" | "joblib" | "npz" | "params" => ModelFileRule {
            min_size_for_mft: NOISY_MODEL_MIN_SIZE,
            confidence: ModelFileConfidence::Noisy,
        },
        _ => return None,
    };

    Some(rule)
}

fn is_tensorflow_checkpoint_data_file(file_name: &str) -> bool {
    // TensorFlow checkpoint 权重常以 model.ckpt.data-00000-of-00001 形式存在，不能只按最后扩展名判断。
    file_name.contains(".ckpt.data-") || file_name.starts_with("ckpt.data-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn recognizes_mainstream_model_formats() {
        for file_name in [
            "model.safetensors",
            "qwen.gguf",
            "stable_diffusion.ckpt",
            "model.onnx",
            "model.tflite",
            "saved_model.pb",
            "model.keras",
            "model.hdf5",
            "model.mlmodel",
            "model.ort",
            "model.engine",
            "model.trt",
            "model.pdiparams",
            "model.caffemodel",
            "model.dlc",
            "model.hef",
            "model.xmodel",
            "model.bmodel",
            "model.pte",
            "model.task",
            "model.nemo",
            "model.mindir",
        ] {
            assert!(is_model_file_path(Path::new(file_name)), "{}", file_name);
        }
    }

    #[test]
    fn recognizes_model_package_directories() {
        assert!(is_model_package_directory(Path::new("MobileNet.mlpackage")));
    }

    #[test]
    fn treats_noisy_extensions_conservatively_for_custom_directory() {
        assert!(!is_custom_directory_model_file(
            Path::new("script.bin"),
            2 * MB
        ));
        assert!(!is_custom_directory_model_file(
            Path::new("checkpoint.pt"),
            2 * 1024 * MB
        ));
        assert!(is_custom_directory_model_file(
            Path::new("adapter.safetensors"),
            80 * MB
        ));
    }

    #[test]
    fn supports_tensorflow_checkpoint_data_shards() {
        assert_eq!(
            mft_model_min_size("model.ckpt.data-00000-of-00001"),
            Some(CHECKPOINT_MIN_SIZE)
        );
    }
}
