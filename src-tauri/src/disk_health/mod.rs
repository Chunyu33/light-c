// ============================================================================
// 磁盘信息业务模块
//
// MVP 只读取 Windows Storage 提供的物理磁盘基础信息和健康状态，不解析
// SMART 私有属性，避免在不同厂商和磁盘类型上产生误导性的“寿命百分比”。
// ============================================================================

use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use std::process::Command;

const POWERSHELL_TIMEOUT_SECONDS: u64 = 12;

#[derive(Debug, Clone, Serialize)]
pub struct DiskHealthInfo {
    pub number: Option<u32>,
    pub model: String,
    pub serial_number: String,
    pub firmware_version: String,
    pub media_type: String,
    pub bus_type: String,
    pub health_status: String,
    pub operational_status: String,
    pub size: u64,
    pub drive_letters: Vec<String>,
    pub volumes: Vec<DiskVolumeInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskVolumeInfo {
    pub drive_letter: String,
    pub volume_name: String,
    pub file_system: String,
    pub total_space: u64,
    pub used_space: u64,
    pub free_space: u64,
    pub usage_percent: f32,
}

#[derive(Debug, Deserialize)]
struct StorageSnapshot {
    #[serde(default, deserialize_with = "deserialize_array_or_single")]
    physical_disks: Vec<RawPhysicalDisk>,
    #[serde(default, deserialize_with = "deserialize_array_or_single")]
    partitions: Vec<RawPartition>,
}

#[derive(Debug, Deserialize)]
struct RawPhysicalDisk {
    number: Option<u32>,
    model: Option<String>,
    serial_number: Option<String>,
    firmware_version: Option<String>,
    media_type: Option<serde_json::Value>,
    bus_type: Option<serde_json::Value>,
    health_status: Option<serde_json::Value>,
    operational_status: Option<serde_json::Value>,
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawPartition {
    disk_number: Option<u32>,
    drive_letter: Option<String>,
    volume_name: Option<String>,
    file_system: Option<String>,
    total_space: Option<u64>,
    used_space: Option<u64>,
    free_space: Option<u64>,
    usage_percent: Option<f32>,
}

fn deserialize_array_or_single<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Null => Ok(Vec::new()),
        serde_json::Value::Array(values) => values
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<Vec<T>, _>>()
            .map_err(serde::de::Error::custom),
        single => serde_json::from_value(single)
            .map(|value| vec![value])
            .map_err(serde::de::Error::custom),
    }
}

/// 查询所有物理磁盘，并尽量合并可读的盘符和卷信息。
pub fn query_disk_health() -> Result<Vec<DiskHealthInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let output = run_storage_query()?;
        let snapshot: StorageSnapshot = serde_json::from_str(&output)
            .map_err(|error| format!("解析 Windows 磁盘信息失败: {}", error))?;
        return merge_storage_snapshot(snapshot);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("磁盘信息仅支持 Windows 系统".to_string())
    }
}

#[cfg(target_os = "windows")]
fn run_storage_query() -> Result<String, String> {
    // 使用 CIM 一次性读取全部对象，减少 PowerShell 进程和 WMI 查询次数。
    let script = r#"
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$logicalDisks = @{}
Get-CimInstance -ClassName Win32_LogicalDisk | ForEach-Object { $logicalDisks[$_.DeviceID] = $_ }
$physical = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_PhysicalDisk | ForEach-Object {
  $number = $null
  $numberMatch = [regex]::Match([string]$_.DeviceId, '\d+$')
  if ($numberMatch.Success) { $number = [UInt32]$numberMatch.Value }
  [PSCustomObject]@{
    number = $number
    model = $_.FriendlyName
    serial_number = $_.SerialNumber
    firmware_version = $_.FirmwareVersion
    media_type = $_.MediaType
    bus_type = $_.BusType
    health_status = $_.HealthStatus
    operational_status = $_.OperationalStatus
    size = [UInt64]$_.Size
  }
})
$partitions = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_Partition | ForEach-Object {
  $drive = $null
  $volumeName = $null
  $fileSystem = $null
  $totalSpace = $null
  $usedSpace = $null
  $freeSpace = $null
  $usagePercent = $null
  $volume = $_ | Get-CimAssociatedInstance -Association MSFT_PartitionToVolume -ResultClassName MSFT_Volume | Select-Object -First 1
  if ($volume) {
    $drive = $volume.DriveLetter
    $volumeName = $volume.FileSystemLabel
    $fileSystem = $volume.FileSystem
    if ($drive) {
      $root = "$drive`:\"
      $space = $logicalDisks["$drive`:"]
      if ($space) {
        $totalSpace = [UInt64]$space.Size
        $freeSpace = [UInt64]$space.FreeSpace
        $usedSpace = $totalSpace - $freeSpace
        if ($totalSpace -gt 0) { $usagePercent = [Math]::Round(($usedSpace / $totalSpace) * 100, 1) }
      }
    }
  }
  [PSCustomObject]@{
    disk_number = [UInt32]$_.DiskNumber
    drive_letter = $drive
    volume_name = $volumeName
    file_system = $fileSystem
    total_space = $totalSpace
    used_space = $usedSpace
    free_space = $freeSpace
    usage_percent = $usagePercent
  }
})
[PSCustomObject]@{ physical_disks = $physical; partitions = $partitions } | ConvertTo-Json -Depth 6 -Compress
"#;

    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Windows 磁盘信息查询: {}", error))?;

    let deadline = std::time::Instant::now()
        .checked_add(std::time::Duration::from_secs(POWERSHELL_TIMEOUT_SECONDS))
        .ok_or_else(|| "磁盘信息查询超时时间无效".to_string())?;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("等待磁盘信息查询失败: {}", error))?
        {
            let output = child
                .wait_with_output()
                .map_err(|error| format!("读取磁盘信息查询结果失败: {}", error))?;
            if !status.success() {
                let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if error.is_empty() {
                    "Windows 磁盘信息查询失败".to_string()
                } else {
                    format!("Windows 磁盘信息查询失败: {}", error)
                });
            }
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                return Err("Windows 未返回磁盘信息".to_string());
            }
            return Ok(stdout);
        }

        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("读取磁盘信息超时，请稍后重试".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}

fn merge_storage_snapshot(snapshot: StorageSnapshot) -> Result<Vec<DiskHealthInfo>, String> {
    let mut volume_map: std::collections::HashMap<u32, Vec<DiskVolumeInfo>> =
        std::collections::HashMap::new();
    for partition in snapshot.partitions {
        let Some(disk_number) = partition.disk_number else {
            continue;
        };
        let Some(drive_letter) = normalize_drive_letter(partition.drive_letter.as_deref()) else {
            continue;
        };
        volume_map
            .entry(disk_number)
            .or_default()
            .push(DiskVolumeInfo {
                drive_letter,
                volume_name: clean_string(partition.volume_name),
                file_system: clean_string(partition.file_system),
                total_space: partition.total_space.unwrap_or(0),
                used_space: partition.used_space.unwrap_or(0),
                free_space: partition.free_space.unwrap_or(0),
                usage_percent: partition.usage_percent.unwrap_or(0.0),
            });
    }

    let mut result = Vec::with_capacity(snapshot.physical_disks.len());
    for physical_disk in snapshot.physical_disks {
        let Some(number) = physical_disk.number else {
            // MSFT_PhysicalDisk 在部分 Windows 版本没有 Number 属性，仍保留磁盘信息。
            result.push(to_disk_health_info(physical_disk, None, Vec::new()));
            continue;
        };
        let volumes = volume_map.remove(&number).unwrap_or_default();
        result.push(to_disk_health_info(physical_disk, Some(number), volumes));
    }

    if result.is_empty() {
        return Err("未发现可读取的物理磁盘".to_string());
    }
    result.sort_by_key(|disk| disk.number.unwrap_or(u32::MAX));
    Ok(result)
}

fn to_disk_health_info(
    disk: RawPhysicalDisk,
    number: Option<u32>,
    volumes: Vec<DiskVolumeInfo>,
) -> DiskHealthInfo {
    let drive_letters = volumes
        .iter()
        .map(|volume| volume.drive_letter.clone())
        .collect();
    DiskHealthInfo {
        number,
        model: clean_string(disk.model),
        serial_number: clean_string(disk.serial_number),
        firmware_version: clean_string(disk.firmware_version),
        media_type: map_media_type(disk.media_type),
        bus_type: map_bus_type(disk.bus_type),
        health_status: map_health_status(disk.health_status),
        operational_status: map_operational_status(disk.operational_status),
        size: disk.size.unwrap_or(0),
        drive_letters,
        volumes,
    }
}

fn clean_string(value: Option<String>) -> String {
    value.unwrap_or_default().trim().to_string()
}

fn normalize_drive_letter(value: Option<&str>) -> Option<String> {
    let letter = value?
        .chars()
        .find(|character| character.is_ascii_alphabetic())?;
    Some(format!("{}:", letter.to_ascii_uppercase()))
}

fn map_storage_enum(value: Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .map(value_to_label)
            .collect::<Vec<_>>()
            .join(", "),
        Some(value) => value_to_label(&value),
        None => "未知".to_string(),
    }
}

fn numeric_storage_value(value: Option<serde_json::Value>) -> Option<u32> {
    let raw = map_storage_enum(value);
    raw.parse::<u32>().ok()
}

fn storage_text(value: Option<serde_json::Value>) -> String {
    map_storage_enum(value).to_ascii_lowercase()
}

fn map_media_type(value: Option<serde_json::Value>) -> String {
    let text = storage_text(value.clone());
    if text.contains("ssd") {
        return "SSD".to_string();
    }
    if text.contains("hdd") {
        return "HDD".to_string();
    }
    if text.contains("scm") {
        return "SCM".to_string();
    }
    match numeric_storage_value(value) {
        Some(3) => "HDD".to_string(),
        Some(4) => "SSD".to_string(),
        Some(5) => "SCM".to_string(),
        _ => "未知".to_string(),
    }
}

fn map_bus_type(value: Option<serde_json::Value>) -> String {
    let text = storage_text(value.clone());
    if text.contains("nvme") {
        return "NVMe".to_string();
    }
    if text.contains("sata") {
        return "SATA".to_string();
    }
    if text.contains("usb") {
        return "USB".to_string();
    }
    match numeric_storage_value(value) {
        Some(7) => "USB".to_string(),
        Some(11) => "SATA".to_string(),
        Some(17) => "NVMe".to_string(),
        Some(10) => "SAS".to_string(),
        Some(3) => "ATA".to_string(),
        Some(8) => "RAID".to_string(),
        Some(14) => "虚拟磁盘".to_string(),
        Some(16) => "存储空间".to_string(),
        _ => "未知".to_string(),
    }
}

fn map_operational_status(value: Option<serde_json::Value>) -> String {
    let raw = map_storage_enum(value);
    if raw.eq_ignore_ascii_case("ok") || raw.eq_ignore_ascii_case("online") {
        return "正常".to_string();
    }
    let labels = raw
        .split(", ")
        .filter_map(|item| match item.parse::<u32>().ok() {
            Some(2) => Some("正常"),
            Some(3) => Some("降级"),
            Some(4) => Some("高负载"),
            Some(5) => Some("预测性故障"),
            Some(6) => Some("错误"),
            Some(7) => Some("不可恢复错误"),
            Some(10) => Some("已停止"),
            Some(11) => Some("服务中"),
            Some(12) => Some("无连接"),
            Some(13) => Some("通信中断"),
            Some(17) => Some("已完成"),
            _ => None,
        })
        .collect::<Vec<_>>();
    if labels.is_empty() {
        "未知".to_string()
    } else {
        labels.join(", ")
    }
}

fn value_to_label(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) if !text.trim().is_empty() => text.trim().to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        _ => "未知".to_string(),
    }
}

fn map_health_status(value: Option<serde_json::Value>) -> String {
    let raw = map_storage_enum(value);
    match raw.to_ascii_lowercase().as_str() {
        "healthy" | "0" => "Healthy".to_string(),
        "warning" | "1" => "Warning".to_string(),
        "unhealthy" | "2" | "failed" | "3" => "Unhealthy".to_string(),
        _ => "Unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_disk(model: &str, number: Option<u32>, health: Option<&str>) -> RawPhysicalDisk {
        RawPhysicalDisk {
            number,
            model: Some(model.to_string()),
            serial_number: None,
            firmware_version: None,
            media_type: Some(serde_json::Value::String("SSD".to_string())),
            bus_type: Some(serde_json::Value::String("NVMe".to_string())),
            health_status: health.map(|value| serde_json::Value::String(value.to_string())),
            operational_status: Some(serde_json::Value::String("OK".to_string())),
            size: Some(1024),
        }
    }

    #[test]
    fn maps_health_status_without_fabricating_percentage() {
        assert_eq!(
            map_health_status(Some(serde_json::json!("Healthy"))),
            "Healthy"
        );
        assert_eq!(
            map_health_status(Some(serde_json::json!("Warning"))),
            "Warning"
        );
        assert_eq!(
            map_health_status(Some(serde_json::json!("Unhealthy"))),
            "Unhealthy"
        );
        assert_eq!(map_health_status(None), "Unknown");
    }

    #[test]
    fn maps_storage_enums_from_text_and_numeric_values() {
        assert_eq!(map_media_type(Some(serde_json::json!(4))), "SSD");
        assert_eq!(map_media_type(Some(serde_json::json!("HDD"))), "HDD");
        assert_eq!(map_bus_type(Some(serde_json::json!(17))), "NVMe");
        assert_eq!(map_bus_type(Some(serde_json::json!("USB"))), "USB");
        assert_eq!(
            map_operational_status(Some(serde_json::json!("OK"))),
            "正常"
        );
    }

    #[test]
    fn accepts_single_object_or_array_storage_json() {
        let single = serde_json::json!({
            "physical_disks": { "number": 0, "model": "SSD", "size": 100 },
            "partitions": null
        });
        let snapshot: StorageSnapshot = serde_json::from_value(single).expect("应接受单对象 JSON");
        assert_eq!(snapshot.physical_disks.len(), 1);
        assert!(snapshot.partitions.is_empty());
    }

    #[test]
    fn merges_multiple_disks_and_skips_partitions_without_drive_letters() {
        let snapshot = StorageSnapshot {
            physical_disks: vec![
                raw_disk("System SSD", Some(0), Some("Healthy")),
                raw_disk("Data HDD", Some(1), None),
            ],
            partitions: vec![
                RawPartition {
                    disk_number: Some(0),
                    drive_letter: Some("C".to_string()),
                    volume_name: Some("System".to_string()),
                    file_system: Some("NTFS".to_string()),
                    total_space: Some(100),
                    used_space: Some(40),
                    free_space: Some(60),
                    usage_percent: Some(40.0),
                },
                RawPartition {
                    disk_number: Some(1),
                    drive_letter: None,
                    volume_name: None,
                    file_system: None,
                    total_space: None,
                    used_space: None,
                    free_space: None,
                    usage_percent: None,
                },
            ],
        };
        let result = merge_storage_snapshot(snapshot).expect("应合并磁盘信息");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].drive_letters, vec!["C:"]);
        assert!(result[1].drive_letters.is_empty());
        assert_eq!(result[1].health_status, "Unknown");
    }
}
