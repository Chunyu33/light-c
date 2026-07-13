// ============================================================================
// 旧驱动清理模块
//
// 只通过 pnputil 管理 Driver Store 中的驱动包，不直接操作 DriverStore 文件，
// 这样可以让 Windows 自己负责驱动包的依赖、签名和删除安全检查。
// ============================================================================

use chrono::Local;
use log::{info, warn};
use quick_xml::{events::Event, Reader};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use walkdir::WalkDir;

const DRIVER_BACKUP_DIR: &str = "driver_backups";

// 删除操作会修改系统 Driver Store，串行化后端请求可以避免两个清理任务交叉备份或删除。
static DRIVER_DELETE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize)]
pub struct DriverPackageInfo {
    pub published_name: String,
    pub original_name: String,
    pub provider_name: String,
    pub class_name: String,
    pub driver_version: String,
    pub family_id: String,
    pub signer_name: String,
    pub driver_store_path: String,
    pub device_count: usize,
    pub active_device_count: usize,
    pub installed_device_count: usize,
    pub outranked_device_count: usize,
    pub file_count: usize,
    pub status: String,
    pub actionable: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriverScanResult {
    pub is_admin: bool,
    pub packages: Vec<DriverPackageInfo>,
    pub total_count: usize,
    pub candidate_count: usize,
    pub high_confidence_count: usize,
    pub device_match_data_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriverDeleteDetail {
    pub published_name: String,
    pub success: bool,
    pub verified_removed: bool,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriverDeleteResult {
    pub backup_directory: String,
    pub success_count: usize,
    pub failed_count: usize,
    pub needs_reboot: bool,
    pub details: Vec<DriverDeleteDetail>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DriverRestoreResult {
    pub backup_directory: String,
    pub success: bool,
    pub needs_reboot: bool,
    pub message: String,
}

#[derive(Debug, Default)]
struct RawDriverPackage {
    published_name: String,
    original_name: String,
    provider_name: String,
    class_name: String,
    driver_version: String,
    family_id: String,
    signer_name: String,
    driver_package_id: String,
    device_count: usize,
    active_device_count: usize,
    file_count: usize,
}

#[derive(Debug, Default)]
struct RawDeviceMatch {
    installed_driver_name: String,
    outranked_driver_names: Vec<String>,
}

#[derive(Debug, Default)]
struct PnputilOutput {
    stdout: String,
    stderr: String,
}

pub fn scan() -> Result<DriverScanResult, String> {
    let raw_packages = enumerate_driver_packages()?;
    let (device_matches, device_match_data_available) = match enumerate_device_matches() {
        Ok(matches) => (matches, true),
        Err(error) => {
            // 设备匹配 XML 只用于提高判定置信度；失败时保留基础扫描结果，避免影响旧系统检测。
            warn!("读取设备驱动匹配关系失败，将使用保守基础判定: {}", error);
            (Vec::new(), false)
        }
    };
    let packages = classify_packages(raw_packages, &device_matches);
    let candidate_count = packages.iter().filter(|package| package.actionable).count();
    let high_confidence_count = packages
        .iter()
        .filter(|package| package.status == "old_confirmed")
        .count();

    Ok(DriverScanResult {
        is_admin: crate::system_slim::check_admin(),
        total_count: packages.len(),
        packages,
        candidate_count,
        high_confidence_count,
        device_match_data_available,
    })
}

pub fn restore_all_backups() -> Result<DriverRestoreResult, String> {
    let _delete_guard = DRIVER_DELETE_LOCK
        .lock()
        .map_err(|_| "驱动清理锁异常，请重启 LightC 后重试".to_string())?;

    if !crate::system_slim::check_admin() {
        return Err("恢复驱动包需要管理员权限，请以管理员身份运行 LightC".to_string());
    }

    let backup_directory = crate::data_dir::get_data_dir().join(DRIVER_BACKUP_DIR);
    if !backup_directory.is_dir() {
        return Err(format!(
            "当前数据目录没有找到驱动备份目录: {}",
            backup_directory.display()
        ));
    }

    let inf_files = collect_backup_inf_files(&backup_directory)?;
    if inf_files.is_empty() {
        return Err(format!(
            "当前驱动备份目录中没有找到 INF 文件: {}",
            backup_directory.display()
        ));
    }

    // 只启动一次 pnputil，减少恢复大量驱动时的进程开销；先枚举用于校验目录确实包含备份。
    let driver_pattern = backup_directory
        .join("*.inf")
        .to_string_lossy()
        .into_owned();
    let output = run_pnputil([
        "/add-driver".to_string(),
        driver_pattern,
        "/subdirs".to_string(),
        "/install".to_string(),
    ])?;
    let command_message = format_command_output(&output.output);
    let message = format!("已发现 {} 个备份 INF。{}", inf_files.len(), command_message);
    let output_lower = command_message.to_ascii_lowercase();
    let needs_reboot = output_lower.contains("restart")
        || output_lower.contains("reboot")
        || command_message.contains("重启");

    Ok(DriverRestoreResult {
        backup_directory: backup_directory.to_string_lossy().to_string(),
        success: output.status_success,
        needs_reboot,
        message,
    })
}

pub fn delete(published_names: Vec<String>) -> Result<DriverDeleteResult, String> {
    let _delete_guard = DRIVER_DELETE_LOCK
        .lock()
        .map_err(|_| "驱动清理锁异常，请重启 LightC 后重试".to_string())?;

    if published_names.is_empty() {
        return Err("未选择要清理的驱动包".to_string());
    }
    if !crate::system_slim::check_admin() {
        return Err("删除驱动包需要管理员权限，请以管理员身份运行 LightC".to_string());
    }

    let selected_names = normalize_published_names(&published_names)?;
    let current_scan = scan()?;
    let selected_packages = validate_selected_packages(&current_scan, &selected_names)?;
    let backup_directory = create_backup_root()?;

    // 每个 OEM 包使用稳定目录；删除失败后重试会复用已有备份，不会不断产生时间戳目录。
    for package in &selected_packages {
        backup_driver_package(package, &backup_directory)?;
    }

    let mut details = Vec::with_capacity(selected_packages.len());
    let mut needs_reboot = false;
    for package in selected_packages {
        let published_name = package.published_name;
        // /uninstall 只解除该包与已断开设备的关联；正在运行的设备在扫描和后端复核中仍会被拦截。
        let command_result =
            run_pnputil(&["/delete-driver", published_name.as_str(), "/uninstall"]);
        let (command_success, output_text) = match command_result {
            Ok(output) => (output.status_success, format_command_output(&output.output)),
            Err(error) => (false, error),
        };
        if output_text.to_ascii_lowercase().contains("restart")
            || output_text.to_ascii_lowercase().contains("reboot")
            || output_text.contains("重启")
        {
            needs_reboot = true;
        }

        details.push(DriverDeleteDetail {
            published_name,
            success: command_success,
            verified_removed: false,
            error_message: if command_success {
                None
            } else {
                Some(output_text)
            },
        });
    }

    // 一次复核所有删除结果，避免每个包都重新调用 pnputil，减少系统 IO 和进程开销。
    match enumerate_driver_packages() {
        Ok(packages) => {
            let remaining_names = packages
                .into_iter()
                .map(|package| package.published_name.to_ascii_lowercase())
                .collect::<std::collections::HashSet<_>>();
            for detail in &mut details {
                detail.verified_removed =
                    !remaining_names.contains(&detail.published_name.to_ascii_lowercase());
                if detail.success && !detail.verified_removed {
                    detail.success = false;
                    detail.error_message =
                        Some("pnputil 已执行，但重新检测仍发现该驱动包".to_string());
                }
            }
        }
        Err(error) => {
            // 删除命令已经执行，复核失败不能伪装成删除失败，只能明确提示用户重新检测。
            for detail in &mut details {
                if detail.success {
                    detail.success = false;
                    detail.error_message =
                        Some(format!("删除命令已执行，但删除后复核失败: {}", error));
                }
            }
        }
    }

    let success_count = details.iter().filter(|detail| detail.success).count();
    let failed_count = details.len() - success_count;
    info!(
        "旧驱动清理完成: 成功 {}, 失败 {}, 备份目录 {}",
        success_count,
        failed_count,
        backup_directory.display()
    );

    Ok(DriverDeleteResult {
        backup_directory: backup_directory.to_string_lossy().to_string(),
        success_count,
        failed_count,
        needs_reboot,
        details,
    })
}

pub fn backup_directory() -> Result<String, String> {
    let directory = crate::data_dir::get_data_dir().join(DRIVER_BACKUP_DIR);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建驱动备份目录失败 {}: {}", directory.display(), error))?;
    Ok(directory.to_string_lossy().to_string())
}

fn enumerate_driver_packages() -> Result<Vec<RawDriverPackage>, String> {
    let xml_path = temporary_xml_path();
    let xml_path_text = xml_path.to_string_lossy().to_string();
    let result = (|| {
        let output = run_pnputil(&[
            "/enum-drivers",
            "/files",
            "/ids",
            "/devices",
            "/format",
            "xml",
            "/output-file",
            &xml_path_text,
        ])?;
        if !output.status_success {
            return Err(format!(
                "枚举驱动包失败: {}",
                format_command_output(&output.output)
            ));
        }
        parse_driver_xml(&xml_path)
    })();

    if let Err(error) = fs::remove_file(&xml_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            warn!("删除临时驱动检测文件失败 {}: {}", xml_path.display(), error);
        }
    }
    result
}

fn enumerate_device_matches() -> Result<Vec<RawDeviceMatch>, String> {
    let xml_path = temporary_xml_path();
    let xml_path_text = xml_path.to_string_lossy().to_string();
    let result = (|| {
        let output = run_pnputil(&[
            "/enum-devices",
            "/drivers",
            "/format",
            "xml",
            "/output-file",
            &xml_path_text,
        ])?;
        if !output.status_success {
            return Err(format!(
                "枚举设备驱动匹配关系失败: {}",
                format_command_output(&output.output)
            ));
        }
        parse_device_matches_xml(&xml_path)
    })();

    if let Err(error) = fs::remove_file(&xml_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            warn!("删除临时设备匹配文件失败 {}: {}", xml_path.display(), error);
        }
    }
    result
}

fn classify_packages(
    raw_packages: Vec<RawDriverPackage>,
    device_matches: &[RawDeviceMatch],
) -> Vec<DriverPackageInfo> {
    let mut family_versions: HashMap<String, Vec<Vec<u64>>> = HashMap::new();
    let mut installed_device_counts: HashMap<String, usize> = HashMap::new();
    let mut outranked_device_counts: HashMap<String, usize> = HashMap::new();
    for device in device_matches {
        let installed_name = device.installed_driver_name.to_ascii_lowercase();
        if is_published_driver_name(&installed_name) {
            *installed_device_counts.entry(installed_name).or_default() += 1;
        }
        for driver_name in &device.outranked_driver_names {
            let normalized_name = driver_name.to_ascii_lowercase();
            if is_published_driver_name(&normalized_name) {
                *outranked_device_counts.entry(normalized_name).or_default() += 1;
            }
        }
    }
    for package in &raw_packages {
        if let (Some(version), false) = (
            parse_driver_version(&package.driver_version),
            package.family_id.trim().is_empty(),
        ) {
            family_versions
                .entry(package.family_id.to_ascii_lowercase())
                .or_default()
                .push(version);
        }
    }

    raw_packages
        .into_iter()
        .map(|package| {
            let parsed_version = parse_driver_version(&package.driver_version);
            let has_newer_version = parsed_version.as_ref().is_some_and(|current_version| {
                family_versions
                    .get(&package.family_id.to_ascii_lowercase())
                    .into_iter()
                    .flatten()
                    .any(|candidate| {
                        compare_versions(candidate, current_version) == Ordering::Greater
                    })
            });
            let published_name = package.published_name.to_ascii_lowercase();
            let installed_device_count = installed_device_counts
                .get(&published_name)
                .copied()
                .unwrap_or_default();
            let outranked_device_count = outranked_device_counts
                .get(&published_name)
                .copied()
                .unwrap_or_default();
            let high_confidence_old = installed_device_count == 0
                && outranked_device_count > 0
                && package.active_device_count == 0;
            let (status, actionable, reason) = if package.active_device_count > 0 {
                (
                    "in_use",
                    false,
                    format!(
                        "有 {} 个设备处于活动状态，不能删除正在使用的驱动包",
                        package.active_device_count
                    ),
                )
            } else if high_confidence_old {
                (
                    "old_confirmed",
                    true,
                    format!(
                        "在 {} 个设备的匹配列表中被更高排名驱动替代，当前没有设备使用此包",
                        outranked_device_count
                    ),
                )
            } else if package.family_id.trim().is_empty() || parsed_version.is_none() {
                (
                    "unknown",
                    true,
                    "未关联设备，但版本信息不完整，请确认后再删除".to_string(),
                )
            } else if has_newer_version {
                (
                    "recommended",
                    true,
                    "未关联设备，且同一驱动族存在更新版本".to_string(),
                )
            } else {
                (
                    "no_newer_version",
                    true,
                    "未关联设备，未发现更高版本；删除后将从 Driver Store 移除该包".to_string(),
                )
            };

            DriverPackageInfo {
                published_name: package.published_name,
                original_name: package.original_name,
                provider_name: package.provider_name,
                class_name: package.class_name,
                driver_version: package.driver_version,
                family_id: package.family_id,
                signer_name: package.signer_name,
                driver_store_path: build_driver_store_path(&package.driver_package_id),
                device_count: package.device_count,
                active_device_count: package.active_device_count,
                installed_device_count,
                outranked_device_count,
                file_count: package.file_count,
                status: status.to_string(),
                actionable,
                reason,
            }
        })
        .collect()
}

fn is_published_driver_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    let number_part = lower
        .strip_prefix("oem")
        .and_then(|value| value.strip_suffix(".inf"));
    number_part.is_some_and(|value| {
        !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
    })
}

fn validate_selected_packages(
    scan_result: &DriverScanResult,
    selected_names: &[String],
) -> Result<Vec<DriverPackageInfo>, String> {
    let packages_by_name = scan_result
        .packages
        .iter()
        .map(|package| (package.published_name.to_ascii_lowercase(), package))
        .collect::<HashMap<_, _>>();
    let mut selected_packages = Vec::with_capacity(selected_names.len());
    for name in selected_names {
        let Some(package) = packages_by_name.get(name) else {
            return Err(format!("驱动包 {} 已不存在，请重新检测", name));
        };
        if !package.actionable {
            return Err(format!(
                "驱动包 {} 当前不满足安全清理条件: {}",
                name, package.reason
            ));
        }
        selected_packages.push((*package).clone());
    }
    Ok(selected_packages)
}

fn normalize_published_names(names: &[String]) -> Result<Vec<String>, String> {
    let mut normalized = Vec::with_capacity(names.len());
    for name in names {
        let trimmed = name.trim();
        let lower = trimmed.to_ascii_lowercase();
        let number_part = lower
            .strip_prefix("oem")
            .and_then(|value| value.strip_suffix(".inf"));
        let is_valid = lower.starts_with("oem")
            && lower.ends_with(".inf")
            && number_part.is_some_and(|value| {
                !value.is_empty() && value.chars().all(|character| character.is_ascii_digit())
            });
        if !is_valid {
            return Err(format!("非法驱动包标识: {}", name));
        }
        if !normalized.contains(&lower) {
            normalized.push(lower);
        }
    }
    Ok(normalized)
}

fn backup_driver_package(package: &DriverPackageInfo, backup_root: &Path) -> Result<(), String> {
    let backup_directory = backup_root.join(&package.published_name);
    if has_backup_inf(&backup_directory, &package.original_name) {
        info!(
            "复用已有驱动备份: {} -> {}",
            package.published_name,
            backup_directory.display()
        );
        return Ok(());
    }

    fs::create_dir_all(&backup_directory).map_err(|error| {
        format!(
            "创建驱动 {} 的备份目录失败 {}: {}",
            package.published_name,
            backup_directory.display(),
            error
        )
    })?;
    let output = run_pnputil(&[
        "/export-driver",
        package.published_name.as_str(),
        &backup_directory.to_string_lossy(),
    ])?;
    if output.status_success && has_backup_inf(&backup_directory, &package.original_name) {
        Ok(())
    } else {
        Err(format!(
            "备份驱动包 {} 失败或备份文件不完整: {}",
            package.published_name,
            format_command_output(&output.output)
        ))
    }
}

fn collect_backup_inf_files(backup_directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut inf_files = Vec::new();
    for entry in WalkDir::new(backup_directory).follow_links(false) {
        let entry = entry.map_err(|error| format!("读取驱动备份目录失败: {}", error))?;
        if entry.file_type().is_file()
            && entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("inf"))
        {
            inf_files.push(entry.into_path());
        }
    }
    inf_files.sort_unstable_by(|left, right| {
        left.to_string_lossy()
            .to_ascii_lowercase()
            .cmp(&right.to_string_lossy().to_ascii_lowercase())
    });
    Ok(inf_files)
}

fn create_backup_root() -> Result<PathBuf, String> {
    let directory = crate::data_dir::get_data_dir().join(DRIVER_BACKUP_DIR);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建驱动备份目录失败 {}: {}", directory.display(), error))?;
    Ok(directory)
}

fn has_backup_inf(directory: &Path, expected_name: &str) -> bool {
    let expected_name = expected_name.trim();
    directory.is_dir()
        && WalkDir::new(directory)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .any(|entry| {
                entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("inf"))
                    && entry
                        .path()
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.eq_ignore_ascii_case(expected_name))
            })
}

fn temporary_xml_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "lightc_driver_scan_{}_{}.xml",
        std::process::id(),
        Local::now().timestamp_nanos_opt().unwrap_or_default()
    ))
}

fn parse_driver_xml(path: &Path) -> Result<Vec<RawDriverPackage>, String> {
    let mut reader = Reader::from_file(path)
        .map_err(|error| format!("读取 pnputil XML 失败 {}: {}", path.display(), error))?;
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current_package: Option<RawDriverPackage> = None;
    let mut current_text_element: Option<String> = None;
    let mut current_text = String::new();
    let mut current_device_open = false;
    let mut packages = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let element_name = event.local_name().as_ref().to_vec();
                if element_name == b"Driver" {
                    current_package = Some(RawDriverPackage {
                        published_name: read_attribute(&event, b"DriverName")?,
                        ..RawDriverPackage::default()
                    });
                } else if let Some(package) = current_package.as_mut() {
                    if element_name == b"Device" {
                        package.device_count += 1;
                        current_device_open = true;
                    } else if element_name == b"File" {
                        package.file_count += 1;
                    } else if is_driver_text_element(&element_name) {
                        current_text_element =
                            Some(String::from_utf8_lossy(&element_name).to_string());
                        current_text.clear();
                    }
                }
            }
            Ok(Event::Empty(event)) => {
                let element_name = event.local_name();
                if let Some(package) = current_package.as_mut() {
                    if element_name.as_ref() == b"Device" {
                        package.device_count += 1;
                        current_device_open = false;
                    } else if element_name.as_ref() == b"File" {
                        package.file_count += 1;
                    }
                }
            }
            Ok(Event::Text(event)) => {
                if current_text_element.is_some() {
                    current_text.push_str(
                        &event
                            .decode()
                            .map_err(|error| format!("解析 pnputil XML 文本失败: {}", error))?,
                    );
                }
            }
            Ok(Event::End(event)) => {
                let element_name = event.local_name();
                if let Some(text_element) = current_text_element.as_deref() {
                    if text_element.as_bytes() == element_name.as_ref() {
                        if let Some(package) = current_package.as_mut() {
                            if text_element == "Status" && current_device_open {
                                if is_active_device_status(&current_text) {
                                    package.active_device_count += 1;
                                }
                            } else {
                                assign_driver_text(package, text_element, &current_text);
                            }
                        }
                        current_text_element = None;
                        current_text.clear();
                    }
                }
                if element_name.as_ref() == b"Device" {
                    current_device_open = false;
                }
                if element_name.as_ref() == b"Driver" {
                    if let Some(package) = current_package.take() {
                        packages.push(package);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("解析 pnputil XML 失败: {}", error)),
            _ => {}
        }
        buffer.clear();
    }
    Ok(packages)
}

fn parse_device_matches_xml(path: &Path) -> Result<Vec<RawDeviceMatch>, String> {
    let mut reader = Reader::from_file(path)
        .map_err(|error| format!("读取设备匹配 XML 失败 {}: {}", path.display(), error))?;
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current_device: Option<RawDeviceMatch> = None;
    let mut current_driver_name = String::new();
    let mut current_driver_status = String::new();
    let mut current_matching_driver = false;
    let mut current_text_element: Option<String> = None;
    let mut current_text = String::new();
    let mut matches = Vec::new();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let element_name = event.local_name().as_ref().to_vec();
                if element_name == b"Device" {
                    current_device = Some(RawDeviceMatch::default());
                } else if element_name == b"DriverName" {
                    let driver_name = read_attribute(&event, b"DriverName")?;
                    if driver_name.is_empty() {
                        // 设备当前驱动使用文本节点，匹配驱动使用 DriverName 属性。
                        current_matching_driver = false;
                        current_text_element = Some("DriverName".to_string());
                        current_text.clear();
                    } else {
                        current_matching_driver = true;
                        current_driver_name = driver_name;
                        current_driver_status.clear();
                    }
                } else if element_name == b"Status" {
                    current_text_element = Some("Status".to_string());
                    current_text.clear();
                }
            }
            Ok(Event::Text(event)) => {
                if current_text_element.is_some() {
                    current_text.push_str(
                        &event
                            .decode()
                            .map_err(|error| format!("解析设备匹配 XML 文本失败: {}", error))?,
                    );
                }
            }
            Ok(Event::End(event)) => {
                let element_name = event.local_name();
                if let Some(text_element) = current_text_element.as_deref() {
                    if text_element.as_bytes() == element_name.as_ref() {
                        if text_element == "DriverName" {
                            if current_driver_name.is_empty() {
                                current_driver_name = current_text.trim().to_string();
                            }
                        } else if text_element == "Status" {
                            current_driver_status = current_text.trim().to_string();
                            if current_matching_driver {
                                if let Some(device) = current_device.as_mut() {
                                    if current_driver_status.contains("Outranked") {
                                        device
                                            .outranked_driver_names
                                            .push(current_driver_name.clone());
                                    } else if current_driver_status.contains("BestRanked/Installed")
                                        || current_driver_status == "BestRanked"
                                    {
                                        device.installed_driver_name = current_driver_name.clone();
                                    }
                                }
                                current_driver_name.clear();
                                current_driver_status.clear();
                                current_matching_driver = false;
                            }
                        }
                        current_text_element = None;
                        current_text.clear();
                    }
                }
                if element_name.as_ref() == b"DriverName"
                    && !current_matching_driver
                    && !current_driver_name.is_empty()
                {
                    if let Some(device) = current_device.as_mut() {
                        // 设备节点下的文本 DriverName 就是当前已安装驱动，不能和匹配候选的属性节点混淆。
                        device.installed_driver_name = current_driver_name.clone();
                    }
                    current_driver_name.clear();
                    current_driver_status.clear();
                }
                if element_name.as_ref() == b"Device" {
                    if let Some(device) = current_device.take() {
                        matches.push(device);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("解析设备匹配 XML 失败: {}", error)),
            _ => {}
        }
        buffer.clear();
    }
    Ok(matches)
}

fn is_driver_text_element(name: &[u8]) -> bool {
    matches!(
        name,
        b"OriginalName"
            | b"ProviderName"
            | b"ClassName"
            | b"DriverVersion"
            | b"FamilyId"
            | b"SignerName"
            | b"DriverPackageId"
            | b"Status"
    )
}

fn is_active_device_status(status: &str) -> bool {
    // 只有 Windows 明确报告设备已启动或正在运行时才禁止删除，避免把已断开设备误判为在用。
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "started" | "running"
    )
}

fn assign_driver_text(package: &mut RawDriverPackage, element: &str, text: &str) {
    let target = match element {
        "OriginalName" => &mut package.original_name,
        "ProviderName" => &mut package.provider_name,
        "ClassName" => &mut package.class_name,
        "DriverVersion" => &mut package.driver_version,
        "FamilyId" => &mut package.family_id,
        "SignerName" => &mut package.signer_name,
        "DriverPackageId" => &mut package.driver_package_id,
        _ => return,
    };
    *target = text.trim().to_string();
}

fn build_driver_store_path(driver_package_id: &str) -> String {
    if driver_package_id.trim().is_empty() {
        return String::new();
    }

    #[cfg(target_os = "windows")]
    {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        return system_root
            .join("System32")
            .join("DriverStore")
            .join("FileRepository")
            .join(driver_package_id.trim())
            .to_string_lossy()
            .to_string();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = driver_package_id;
        String::new()
    }
}

fn read_attribute(
    event: &quick_xml::events::BytesStart<'_>,
    name: &[u8],
) -> Result<String, String> {
    for attribute in event.attributes().with_checks(false) {
        let attribute =
            attribute.map_err(|error| format!("解析 pnputil XML 属性失败: {}", error))?;
        if attribute.key.as_ref() == name {
            return attribute
                .unescape_value()
                .map(|value| value.into_owned())
                .map_err(|error| format!("解析 pnputil XML 属性值失败: {}", error));
        }
    }
    Ok(String::new())
}

fn parse_driver_version(version: &str) -> Option<Vec<u64>> {
    let version_token = version.split_whitespace().last()?;
    let components = version_token
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (!components.is_empty()).then_some(components)
}

fn compare_versions(left: &[u64], right: &[u64]) -> Ordering {
    let max_length = left.len().max(right.len());
    (0..max_length)
        .map(|index| {
            (
                left.get(index).copied().unwrap_or(0),
                right.get(index).copied().unwrap_or(0),
            )
        })
        .find_map(
            |(left_value, right_value)| match left_value.cmp(&right_value) {
                Ordering::Equal => None,
                ordering => Some(ordering),
            },
        )
        .unwrap_or(Ordering::Equal)
}

struct CommandResult {
    status_success: bool,
    output: PnputilOutput,
}

fn run_pnputil<I, S>(arguments: I) -> Result<CommandResult, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    #[cfg(target_os = "windows")]
    {
        let output = Command::new(pnputil_path())
            .args(arguments)
            .output()
            .map_err(|error| format!("启动 pnputil 失败: {}", error))?;
        return Ok(CommandResult {
            status_success: output.status.success(),
            output: PnputilOutput {
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            },
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = arguments;
        Err("旧驱动清理仅支持 Windows 系统".to_string())
    }
}

#[cfg(target_os = "windows")]
fn pnputil_path() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("pnputil.exe")
}

fn format_command_output(output: &PnputilOutput) -> String {
    let combined = format!("{} {}", output.stdout.trim(), output.stderr.trim());
    if combined.trim().is_empty() {
        "pnputil 未返回详细错误信息".to_string()
    } else {
        combined.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        compare_versions, normalize_published_names, parse_device_matches_xml, parse_driver_version,
    };
    use std::cmp::Ordering;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn parses_pnputil_version_with_date_prefix() {
        assert_eq!(
            parse_driver_version("02/08/2024 2406.5.5.0"),
            Some(vec![2406, 5, 5, 0])
        );
    }

    #[test]
    fn compares_versions_with_different_component_lengths() {
        assert_eq!(compare_versions(&[1, 2], &[1, 2, 0]), Ordering::Equal);
        assert_eq!(compare_versions(&[1, 3], &[1, 2, 9]), Ordering::Greater);
    }

    #[test]
    fn rejects_non_published_driver_names() {
        assert!(normalize_published_names(&["DriverStore\\oem1.inf".to_string()]).is_err());
        assert_eq!(
            normalize_published_names(&["OEM12.INF".to_string()]).unwrap(),
            vec!["oem12.inf"]
        );
    }

    #[test]
    fn parses_current_and_outranked_device_drivers() {
        let path = PathBuf::from(std::env::temp_dir()).join(format!(
            "lightc_driver_match_test_{}_{}.xml",
            std::process::id(),
            1
        ));
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<PnpUtil>
  <Device>
    <DeviceDescription>Test device</DeviceDescription>
    <DriverName>oem10.inf</DriverName>
    <MatchingDrivers>
      <DriverName DriverName="oem10.inf">
        <Status>BestRanked/Installed</Status>
      </DriverName>
      <DriverName DriverName="oem3.inf">
        <Status>Outranked</Status>
      </DriverName>
    </MatchingDrivers>
  </Device>
</PnpUtil>"#;
        fs::write(&path, xml).expect("write test XML");
        let result = parse_device_matches_xml(&path).expect("parse test XML");
        fs::remove_file(&path).expect("remove test XML");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].installed_driver_name, "oem10.inf");
        assert_eq!(result[0].outranked_driver_names, vec!["oem3.inf"]);
    }
}
