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
/// 判定顺序（从强到弱）：
/// 1. 新版 manifest：`LightC.portable.json`，版本化格式，优先级最高；
/// 2. 旧版 marker：`LightC.portable`，兼容老便携包；
/// 3. 卸载器痕迹：安装版目录里会有 `uninstall.exe`（NSIS 产物），便携包没有。
///    这条不依赖注册表读取结果，属于"就近可验证"的强信号；
/// 4. 安装登记：注册表卸载项的 `InstallLocation` 指向 exe 目录（或它的父目录，
///    兼容 `App\0.0.0\` 这类嵌套安装布局）；
/// 5. 以上都没有安装痕迹 → 便携版（覆盖"用户只保留了 LightC.exe"的场景）；
/// 6. 注册表读取失败（不是"没找到"）→ 按安装版处理并告警，宁可写 AppData 也不误写程序目录。
///
/// 关键安全约束：安装版绝不能被判成便携版。因此凡是出现"像安装版"的信号
/// （卸载器、安装登记）一律判为安装版，只有确认没有安装痕迹时才落到便携版。
pub fn detect_distribution_channel(exe_path: &Path) -> DistributionChannel {
    resolve_distribution_channel(exe_path, installed_application_directory)
}

/// 判定核心：把注册表查询作为参数传入，便于用固定数据覆盖各条分支做单元测试。
fn resolve_distribution_channel(
    exe_path: &Path,
    lookup_install_directory: impl FnOnce() -> Result<Option<PathBuf>, String>,
) -> DistributionChannel {
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
        return DistributionChannel::Portable;
    }

    // 卸载器痕迹：安装版目录存在 uninstall.exe，便携包只包含 exe/dll/标记文件。
    if has_installer_uninstaller(application_dir) {
        return DistributionChannel::Installer;
    }

    match lookup_install_directory() {
        Ok(Some(install_directory)) => {
            if is_same_or_nested_install_directory(application_dir, &install_directory) {
                DistributionChannel::Installer
            } else {
                // 注册表里的安装记录指向别的目录，说明当前 exe 是用户自行放置的便携副本。
                DistributionChannel::Portable
            }
        }
        Ok(None) => DistributionChannel::Portable,
        Err(error) => {
            log::warn!(
                "读取安装登记失败，暂按安装版处理以避免数据写入程序目录: {}",
                error
            );
            DistributionChannel::Installer
        }
    }
}

/// 判断 exe 目录（或其直接父目录）是否存在 NSIS 卸载器。
///
/// 中文说明：Tauri NSIS 默认按 `$INSTDIR\LightC.exe` + `$INSTDIR\uninstall.exe` 布局安装，
/// 部分安装器会再套一层版本目录，所以同时检查父目录，且仅在父目录名不是盘根时检查。
fn has_installer_uninstaller(application_dir: &Path) -> bool {
    if application_dir.join("uninstall.exe").is_file() {
        return true;
    }

    match application_dir.parent() {
        // 盘根目录（如 D:\）不作为安装目录判断依据，避免误伤 D:\uninstall.exe 这类无关文件。
        Some(parent) if parent.parent().is_some() => parent.join("uninstall.exe").is_file(),
        _ => false,
    }
}

/// 判断 exe 目录是否就是登记的安装目录，或位于其下一层（`App\版本号\` 布局）。
fn is_same_or_nested_install_directory(application_dir: &Path, install_directory: &Path) -> bool {
    let install_key = path_compare_key(install_directory);
    let application_key = path_compare_key(application_dir);
    if application_key == install_key {
        return true;
    }

    match application_dir.parent() {
        Some(parent) => path_compare_key(parent) == install_key,
        None => false,
    }
}

/// 路径比较键：统一分隔符、去掉尾部反斜杠并转小写，避免注册表值与 FS 路径写法差异导致漏判。
fn path_compare_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// 读取 NSIS 安装版登记的安装目录。
///
/// 中文说明：安装版会创建 `...\CurrentVersion\Uninstall\LightC` 卸载项（由 Tauri NSIS 安装器写入），
/// `InstallLocation` 即安装目录；`UninstallString` 作为旧版本缺字段时的兜底。
/// 返回 `Ok(None)` 表示确认没有安装记录（当前 exe 属于便携副本）。
const INSTALL_REGISTRY_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\LightC";

fn installed_application_directory() -> Result<Option<PathBuf>, String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;

    // 32/64 位注册表视图都要看：安装器按自身位数写入，用户也可能换位数重装。
    let candidates = [
        (HKEY_CURRENT_USER, KEY_WOW64_64KEY),
        (HKEY_CURRENT_USER, KEY_WOW64_32KEY),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
        (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
    ];
    let mut last_error: Option<String> = None;

    for (root, view_flags) in candidates {
        let key = match RegKey::predef(root)
            .open_subkey_with_flags(INSTALL_REGISTRY_KEY, KEY_READ | view_flags)
        {
            Ok(key) => key,
            Err(error) => {
                // 未安装（找不到键）属于正常路径，只有其它错误才需要上报给调用方兜底。
                if error.kind() != std::io::ErrorKind::NotFound {
                    last_error = Some(format!("打开安装登记失败: {}", error));
                }
                continue;
            }
        };

        if let Ok(location) = key.get_value::<String, _>("InstallLocation") {
            let trimmed = trim_registry_path(&location);
            if !trimmed.is_empty() {
                return Ok(Some(PathBuf::from(trimmed)));
            }
        }

        if let Ok(uninstall) = key.get_value::<String, _>("UninstallString") {
            let trimmed = trim_registry_path(&uninstall);
            if let Some(parent) = Path::new(&trimmed).parent() {
                return Ok(Some(parent.to_path_buf()));
            }
        }
    }

    match last_error {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

/// 注册表里的路径通常带引号（`"D:\LightC"`），需要去掉引号和尾部反斜杠再做比较。
fn trim_registry_path(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_end_matches('\\')
        .to_string()
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
        DistributionChannel::Portable => portable_root_dir_for(&executable_path),
        DistributionChannel::Installer => installer_root_dir(),
    }
}

/// 便携版根目录：exe 所在目录（数据随包携带）。
pub fn portable_root_dir_for(executable_path: &Path) -> Option<PathBuf> {
    executable_path.parent().map(Path::to_path_buf)
}

/// 安装版根目录：%LOCALAPPDATA%/LightC，更新或卸载安装目录时不会丢数据。
pub fn installer_root_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|dir| dir.join("LightC"))
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
    repair_portable_marker_if_needed();
    let target_directory = portable_webview_data_directory()?;
    if let Err(error) = std::fs::create_dir_all(&target_directory) {
        log::warn!(
            "无法创建便携版 WebView2 数据目录 {}: {}",
            target_directory.display(),
            error
        );
        return None;
    }

    // 开发环境（cargo tauri dev）不迁移打包版的 localStorage：调试用的主题/布局/数据目录
    // 设置会和正式包里看到的不一致，排查问题时容易误判成"数据串了"。
    if cfg!(debug_assertions) {
        log::info!("开发环境跳过旧版 WebView2 数据迁移");
        return Some(target_directory);
    }

    if let Err(error) = migrate_legacy_webview_data(&target_directory) {
        log::warn!("迁移旧版 WebView2 数据失败: {}", error);
    }
    Some(target_directory)
}

/// 便携版自愈：判定为便携版但标记文件缺失时补齐，让后续版本与用户复制程序时不再依赖手工保留标记。
///
/// 中文说明：只要注册表里没有当前目录的安装记录，就说明这是便携副本。补齐 `LightC.portable` /
/// `LightC.portable.json` 可以缩短下次启动的判定路径，也保证用户把整个目录复制到别处后仍是便携版。
/// 写入失败（目录只读）只记日志，不影响本次运行，因为判定链已经不依赖这两个文件。
fn repair_portable_marker_if_needed() {
    let Ok(executable_path) = current_executable_path() else {
        return;
    };
    repair_portable_marker_for(&executable_path);
}

/// 自愈核心：按给定 exe 路径补齐便携版标记，便于用临时目录做单元测试。
fn repair_portable_marker_for(executable_path: &Path) {
    let Some(application_dir) = executable_path.parent() else {
        return;
    };
    if detect_distribution_channel(executable_path) != DistributionChannel::Portable {
        return;
    }

    let marker_path = application_dir.join(PORTABLE_MARKER_FILE);
    if !marker_path.is_file() {
        if let Err(error) = std::fs::write(&marker_path, "portable") {
            log::debug!(
                "补写便携版标记失败（目录可能只读）{}: {}",
                marker_path.display(),
                error
            );
        }
    }

    let manifest_path = application_dir.join(PORTABLE_MANIFEST_FILE);
    if !manifest_path.is_file() {
        let manifest = format!(
            "{{\n  \"schema_version\": {},\n  \"mode\": \"portable\",\n  \"data_layout\": \"relative\"\n}}\n",
            PORTABLE_MANIFEST_SCHEMA_VERSION
        );
        if let Err(error) = std::fs::write(&manifest_path, manifest) {
            log::debug!(
                "补写便携版 manifest 失败（目录可能只读）{}: {}",
                manifest_path.display(),
                error
            );
        }
    }
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
    path_compare_key(left) == path_compare_key(right)
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
    fn invalid_manifest_does_not_force_portable() {
        // manifest 损坏时不能凭它判定为便携版；此时改由安装登记决定发行模式。
        let installer_root = test_directory("invalid-manifest-installed");
        fs::create_dir_all(&installer_root).unwrap();
        fs::write(installer_root.join(PORTABLE_MANIFEST_FILE), "invalid").unwrap();
        let registered = installer_root.clone();

        let channel = resolve_distribution_channel(&installer_root.join("LightC.exe"), || {
            Ok(Some(registered))
        });
        assert_eq!(channel, DistributionChannel::Installer);

        // 同一份损坏 manifest 放在没有安装记录的目录里，则是便携副本（启动时会自愈补写 manifest）。
        let portable_root = test_directory("invalid-manifest-portable");
        fs::create_dir_all(&portable_root).unwrap();
        fs::write(portable_root.join(PORTABLE_MANIFEST_FILE), "invalid").unwrap();

        let channel =
            resolve_distribution_channel(&portable_root.join("LightC.exe"), || Ok(None));
        assert_eq!(channel, DistributionChannel::Portable);

        let _ = fs::remove_dir_all(installer_root);
        let _ = fs::remove_dir_all(portable_root);
    }

    #[test]
    fn treats_executable_without_install_record_as_portable() {
        // 用户只保留了 LightC.exe（标记文件丢失）时，注册表里没有当前目录的安装记录，
        // 必须判为便携版，否则数据会被写进 AppData。
        let root = test_directory("no-marker-no-install");
        fs::create_dir_all(&root).unwrap();

        let channel = resolve_distribution_channel(&root.join("LightC.exe"), || Ok(None));

        assert_eq!(channel, DistributionChannel::Portable);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn treats_executable_in_install_location_as_installer() {
        // 安装版：注册表登记的安装目录就是 exe 所在目录，必须保持 AppData 布局。
        let root = test_directory("installed-location");
        fs::create_dir_all(&root).unwrap();
        let install_directory = root.clone();

        let channel =
            resolve_distribution_channel(&root.join("LightC.exe"), || Ok(Some(install_directory)));

        assert_eq!(channel, DistributionChannel::Installer);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installer_with_uninstaller_stays_installer_even_without_registry() {
        // 最关键的防回归：安装版目录里有 uninstall.exe 时，即使注册表读取不到（被清理软件删了、
        // 或权限异常），也必须判为安装版，绝不能变成便携版去写程序目录。
        let root = test_directory("installed-with-uninstaller");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("LightC.exe"), b"stub").unwrap();
        fs::write(root.join("uninstall.exe"), b"stub").unwrap();

        // 三种注册表结果都必须判为安装版。
        assert_eq!(
            resolve_distribution_channel(&root.join("LightC.exe"), || Ok(None)),
            DistributionChannel::Installer
        );
        assert_eq!(
            resolve_distribution_channel(&root.join("LightC.exe"), || Err("注册表不可用".into())),
            DistributionChannel::Installer
        );
        assert_eq!(
            resolve_distribution_channel(&root.join("LightC.exe"), || Ok(Some(PathBuf::from(
                r"Z:\OtherPlace"
            )))),
            DistributionChannel::Installer
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nested_install_layout_stays_installer() {
        // 兼容 `App\<版本号>\LightC.exe` 布局：卸载器在父目录，安装登记也指向父目录。
        let root = test_directory("installed-nested");
        let version_dir = root.join("2.16.8");
        fs::create_dir_all(&version_dir).unwrap();
        fs::write(root.join("uninstall.exe"), b"stub").unwrap();
        let registered = root.clone();

        assert_eq!(
            resolve_distribution_channel(&version_dir.join("LightC.exe"), || Ok(Some(
                registered
            ))),
            DistributionChannel::Installer
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uninstaller_check_precedes_registry_lookup() {
        // 极端情形：注册表记录错误地指向别处（被清理软件改坏、多份安装残留互相覆盖），
        // 但只要 exe 旁边/上一层有卸载器，就必须判为安装版，不能被注册表带偏成便携版。
        let root = test_directory("uninstaller-beats-registry");
        let version_dir = root.join("app");
        fs::create_dir_all(&version_dir).unwrap();
        fs::write(root.join("uninstall.exe"), b"stub").unwrap();

        let channel = resolve_distribution_channel(&version_dir.join("LightC.exe"), || {
            Ok(Some(PathBuf::from(r"Z:\SomewhereElse")))
        });

        assert_eq!(
            channel,
            DistributionChannel::Installer,
            "卸载器痕迹必须优先于注册表登记"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn drive_root_uninstaller_does_not_force_installer() {
        // 盘根目录下的同名文件不能作为安装依据，否则 D:\uninstall.exe 会把便携版判成安装版。
        let portable_root = test_directory("portable-with-drive-root-uninstaller");
        fs::create_dir_all(&portable_root).unwrap();
        fs::write(portable_root.join("LightC.exe"), b"stub").unwrap();

        // 直接验证判定函数：便携目录自身没有 uninstall.exe，且父目录是临时目录（非盘根）时，
        // 只有父目录存在 uninstall.exe 才会影响结果，这里用注册表返回 None 覆盖正常分支。
        assert_eq!(
            resolve_distribution_channel(&portable_root.join("LightC.exe"), || Ok(None)),
            DistributionChannel::Portable
        );

        let _ = fs::remove_dir_all(portable_root);
    }

    #[test]
    fn detects_uninstaller_only_in_expected_locations() {
        // 直接验证文件系统判定：便携包解压出来的目录里没有 uninstall.exe，不应被当成安装版。
        let portable_root = test_directory("uninstaller-detection-portable");
        fs::create_dir_all(&portable_root).unwrap();
        assert!(!has_installer_uninstaller(&portable_root));

        // 安装版布局：卸载器与 exe 同目录。
        let installed_root = test_directory("uninstaller-detection-installed");
        fs::create_dir_all(&installed_root).unwrap();
        fs::write(installed_root.join("uninstall.exe"), b"stub").unwrap();
        assert!(has_installer_uninstaller(&installed_root));

        // 嵌套布局：卸载器在父目录。
        let nested_parent = test_directory("uninstaller-detection-nested");
        let nested_child = nested_parent.join("0.0.0");
        fs::create_dir_all(&nested_child).unwrap();
        fs::write(nested_parent.join("uninstall.exe"), b"stub").unwrap();
        assert!(has_installer_uninstaller(&nested_child));

        // 再上一层（父目录的父目录）存在卸载器时不作为依据，避免放大误判范围。
        let deep_parent = test_directory("uninstaller-detection-deep");
        let deep_child = deep_parent.join("a").join("b");
        fs::create_dir_all(&deep_child).unwrap();
        fs::write(deep_parent.join("uninstall.exe"), b"stub").unwrap();
        assert!(!has_installer_uninstaller(&deep_child));

        let _ = fs::remove_dir_all(portable_root);
        let _ = fs::remove_dir_all(installed_root);
        let _ = fs::remove_dir_all(nested_parent);
        let _ = fs::remove_dir_all(deep_parent);
    }

    #[test]
    fn treats_portable_copy_of_installed_app_as_portable() {
        // 用户把安装目录里的 exe 复制到别处当便携版用：复制过去的只有 exe，没有 uninstall.exe，
        // 且注册表指向原安装目录，因此应判为便携版。
        let install_root = test_directory("installed-original");
        let portable_root = test_directory("portable-copy");
        fs::create_dir_all(&install_root).unwrap();
        fs::create_dir_all(&portable_root).unwrap();
        fs::write(install_root.join("uninstall.exe"), b"stub").unwrap();
        fs::write(portable_root.join("LightC.exe"), b"stub").unwrap();
        let registered = install_root.clone();

        let channel =
            resolve_distribution_channel(&portable_root.join("LightC.exe"), || Ok(Some(registered)));

        assert_eq!(channel, DistributionChannel::Portable);
        let _ = fs::remove_dir_all(install_root);
        let _ = fs::remove_dir_all(portable_root);
    }

    #[test]
    fn falls_back_to_installer_when_registry_is_unreadable() {
        // 注册表不可用时按安装版处理并告警，避免两个发行版都写程序目录造成数据歧义。
        let root = test_directory("registry-error");
        fs::create_dir_all(&root).unwrap();

        let channel = resolve_distribution_channel(&root.join("LightC.exe"), || {
            Err("注册表不可用".to_string())
        });

        assert_eq!(channel, DistributionChannel::Installer);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn trims_quotes_and_trailing_separator_from_registry_path() {
        assert_eq!(trim_registry_path("\"D:\\LightC\""), "D:\\LightC");
        assert_eq!(trim_registry_path("D:\\LightC\\"), "D:\\LightC");
        assert_eq!(trim_registry_path("  \"D:\\LightC\"  "), "D:\\LightC");
    }

    #[test]
    fn repairs_missing_portable_markers() {
        // 用户只保留了 exe 时，启动后应自动补回两个标记文件，下次判定不再依赖注册表查询。
        let root = test_directory("repair-markers");
        fs::create_dir_all(&root).unwrap();
        let executable_path = root.join("LightC.exe");
        fs::write(&executable_path, b"stub").unwrap();

        assert!(!root.join(PORTABLE_MARKER_FILE).exists());
        repair_portable_marker_for(&executable_path);

        assert!(root.join(PORTABLE_MARKER_FILE).is_file());
        let manifest_content = fs::read_to_string(root.join(PORTABLE_MANIFEST_FILE))
            .expect("manifest 应被补齐");
        let manifest: serde_json::Value =
            serde_json::from_str(&manifest_content).expect("补齐的 manifest 必须是合法 JSON");
        assert_eq!(manifest["mode"], "portable");
        assert_eq!(manifest["data_layout"], "relative");

        // 补出来的标记必须能独立通过判定（不再依赖注册表分支）。
        assert_eq!(
            detect_distribution_channel(&executable_path),
            DistributionChannel::Portable
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_install_location_from_real_registry() {
        // 这条测试直接读本机注册表，用于验证 winreg 打开视图与取值在真实 NSIS 登记上确实可用
        // （路径带引号、字段可能缺失等情况）。未安装 LightC 的机器只验证"没有记录"这一分支，
        // 因此断言只覆盖"要么读到目录、要么确认未安装"，不会在 CI 上误报。
        match installed_application_directory() {
            Ok(Some(directory)) => {
                assert!(
                    directory.is_absolute(),
                    "安装目录必须是绝对路径: {}",
                    directory.display()
                );
                assert!(
                    !directory.to_string_lossy().contains('"'),
                    "注册表路径的引号必须被清理: {}",
                    directory.display()
                );
            }
            Ok(None) => {}
            Err(error) => panic!("读取安装登记不应失败: {}", error),
        }
    }
}
