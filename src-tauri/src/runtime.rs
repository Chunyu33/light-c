// ============================================================================
// 运行时发行模式
//
// 安装版和便携版复用同一个 exe，发行模式必须由包内的显式元数据决定，
// 不能通过当前工作目录、安装位置或目录可写性进行推断。
// ============================================================================

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PORTABLE_MARKER_FILE: &str = "LightC.portable";
pub const PORTABLE_MANIFEST_FILE: &str = "LightC.portable.json";
const PORTABLE_MANIFEST_SCHEMA_VERSION: u32 = 1;
const PORTABLE_WEBVIEW_DIR: &str = "webview";
const WEBVIEW_MIGRATION_DIR: &str = ".migration";
const WEBVIEW_MIGRATION_STATE_FILE: &str = "legacy_webview_v1.json";
const APP_IDENTIFIER: &str = "com.chunyu.LightC";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DistributionChannel {
    Installer,
    Portable,
}

impl DistributionChannel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Installer => "安装版",
            Self::Portable => "便携版",
        }
    }
}

#[derive(Debug, Deserialize)]
struct PortableManifest {
    schema_version: u32,
    mode: String,
    data_layout: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct WebviewMigrationState {
    schema_version: u32,
    completed: bool,
    source_directory: String,
}

/// 根据当前 exe 路径识别发行模式。
///
/// 新 manifest 提供可扩展的版本化格式；旧 marker 仍然作为兼容入口，
/// 这样升级后的程序可以直接运行旧便携包，且不会因为 manifest 写入失败改变模式。
pub fn detect_distribution_channel(exe_path: &Path) -> DistributionChannel {
    let Some(application_dir) = exe_path.parent() else {
        return DistributionChannel::Installer;
    };

    let manifest_path = application_dir.join(PORTABLE_MANIFEST_FILE);
    if manifest_path.is_file() {
        match std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|content| {
                serde_json::from_str::<PortableManifest>(content.trim_start_matches('\u{feff}'))
                    .ok()
            }) {
            Some(manifest)
                if manifest.schema_version == PORTABLE_MANIFEST_SCHEMA_VERSION
                    && manifest.mode == "portable"
                    && manifest.data_layout == "relative" =>
            {
                return DistributionChannel::Portable;
            }
            Some(_) => {
                log::warn!(
                    "便携版 manifest 内容不受支持，将继续检查旧版 marker: {}",
                    manifest_path.display()
                );
            }
            None => {
                log::warn!(
                    "读取便携版 manifest 失败，将继续检查旧版 marker: {}",
                    manifest_path.display()
                );
            }
        }
    }

    if application_dir.join(PORTABLE_MARKER_FILE).is_file() {
        DistributionChannel::Portable
    } else {
        DistributionChannel::Installer
    }
}

/// 获取当前程序路径；统一错误信息，供数据目录和完整性校验复用。
pub fn current_executable_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| format!("无法读取当前程序路径: {}", error))
}

/// 获取当前发行包根目录。便携版根目录必须跟随 exe（数据随包携带），
/// 安装版根目录仍使用 LocalAppData——安装版通过 NSIS 更新时会覆盖安装目录，
/// 若数据放在安装目录会在更新/卸载时丢失，因此安装版必须落在 AppData。
pub fn current_application_root() -> Option<PathBuf> {
    let executable_path = current_executable_path().ok()?;
    match detect_distribution_channel(&executable_path) {
        DistributionChannel::Portable => executable_path.parent().map(Path::to_path_buf),
        DistributionChannel::Installer => dirs::data_local_dir().map(|dir| dir.join("LightC")),
    }
}

/// 获取便携版 WebView2 用户数据目录；安装版仍由 Tauri 使用默认 AppData 位置。
pub fn portable_webview_data_directory() -> Option<PathBuf> {
    if current_executable_path()
        .ok()
        .is_none_or(|path| detect_distribution_channel(&path) != DistributionChannel::Portable)
    {
        return None;
    }

    current_application_root().map(|root| root.join(PORTABLE_WEBVIEW_DIR))
}

/// 准备便携版 WebView2 数据目录，并兼容迁移旧版本的 WebView localStorage。
///
/// WebView2 的缓存和 localStorage 不属于 LightC 自有文件，因此单独记录迁移状态，
/// 避免和日志、驱动备份等清理数据混在同一白名单中。
pub fn prepare_portable_webview_data_directory() -> Option<PathBuf> {
    let target_directory = portable_webview_data_directory()?;
    if let Err(error) = std::fs::create_dir_all(&target_directory) {
        log::warn!(
            "无法创建便携版 WebView2 数据目录 {}: {}",
            target_directory.display(),
            error
        );
        return None;
    }

    if let Err(error) = migrate_legacy_webview_data(&target_directory) {
        log::warn!("迁移旧版 WebView2 数据失败: {}", error);
    }
    Some(target_directory)
}

fn migrate_legacy_webview_data(target_directory: &Path) -> Result<(), String> {
    let state_path = target_directory
        .join(WEBVIEW_MIGRATION_DIR)
        .join(WEBVIEW_MIGRATION_STATE_FILE);
    if read_webview_migration_state(&state_path)
        .is_some_and(|state| state.schema_version == 1 && state.completed)
    {
        return Ok(());
    }

    let Some(local_data_dir) = dirs::data_local_dir() else {
        return Ok(());
    };
    let source_directory = local_data_dir.join(APP_IDENTIFIER);
    if !source_directory.is_dir() || same_path(&source_directory, target_directory) {
        return write_webview_migration_state(
            &state_path,
            &WebviewMigrationState {
                schema_version: 1,
                completed: true,
                source_directory: source_directory.to_string_lossy().to_string(),
            },
        );
    }

    copy_webview_directory_contents(&source_directory, target_directory)?;
    write_webview_migration_state(
        &state_path,
        &WebviewMigrationState {
            schema_version: 1,
            completed: true,
            source_directory: source_directory.to_string_lossy().to_string(),
        },
    )
}

fn copy_webview_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    for entry_result in std::fs::read_dir(source)
        .map_err(|error| format!("读取旧版 WebView2 目录失败 {}: {}", source.display(), error))?
    {
        let entry = entry_result.map_err(|error| format!("读取 WebView2 条目失败: {}", error))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 WebView2 条目类型失败: {}", error))?;

        // 不跟随符号链接，避免迁移时越出旧 WebView2 数据目录边界。
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            std::fs::create_dir_all(&target_path)
                .map_err(|error| format!("创建 WebView2 子目录失败: {}", error))?;
            copy_webview_directory_contents(&source_path, &target_path)?;
        } else if file_type.is_file() && !target_path.exists() {
            std::fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "复制 WebView2 数据失败 {} -> {}: {}",
                    source_path.display(),
                    target_path.display(),
                    error
                )
            })?;
        }
    }
    Ok(())
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .eq_ignore_ascii_case(
            right
                .to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\'),
        )
}

fn read_webview_migration_state(path: &Path) -> Option<WebviewMigrationState> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(content.trim_start_matches('\u{feff}')).ok()
}

fn write_webview_migration_state(path: &Path, state: &WebviewMigrationState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("WebView2 迁移状态路径无效: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("创建 WebView2 迁移状态目录失败: {}", error))?;
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| format!("序列化 WebView2 迁移状态失败: {}", error))?;
    std::fs::write(path, content)
        .map_err(|error| format!("写入 WebView2 迁移状态失败 {}: {}", path.display(), error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lightc-runtime-{}-{}", name, std::process::id()))
    }

    #[test]
    fn detects_versioned_portable_manifest() {
        let root = test_directory("manifest");
        fs::create_dir_all(&root).unwrap();
        let manifest = r#"{"schema_version":1,"mode":"portable","data_layout":"relative"}"#;
        let mut manifest_with_bom = vec![0xEF, 0xBB, 0xBF];
        manifest_with_bom.extend_from_slice(manifest.as_bytes());
        fs::write(root.join(PORTABLE_MANIFEST_FILE), manifest_with_bom).unwrap();

        assert_eq!(
            detect_distribution_channel(&root.join("LightC.exe")),
            DistributionChannel::Portable
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detects_legacy_portable_marker() {
        let root = test_directory("legacy-marker");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(PORTABLE_MARKER_FILE), "portable").unwrap();

        assert_eq!(
            detect_distribution_channel(&root.join("LightC.exe")),
            DistributionChannel::Portable
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_manifest_does_not_make_installer_portable() {
        let root = test_directory("invalid-manifest");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(PORTABLE_MANIFEST_FILE), "invalid").unwrap();

        assert_eq!(
            detect_distribution_channel(&root.join("LightC.exe")),
            DistributionChannel::Installer
        );
        let _ = fs::remove_dir_all(root);
    }
}
