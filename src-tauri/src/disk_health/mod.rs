// ============================================================================
// 磁盘信息业务模块
//
// MVP 只读取 Windows Storage 提供的物理磁盘基础信息和健康状态，不解析
// SMART 私有属性，避免在不同厂商和磁盘类型上产生误导性的“寿命百分比”。
// ============================================================================

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use std::process::Command;

const POWERSHELL_TIMEOUT_SECONDS: u64 = 12;
#[cfg(target_os = "windows")]
const POWERSHELL_PROCESS_FLAGS: u32 = 0x08000000;

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
    /// 脚本内部两路查询都失败时写入的异常文本，正常情况为 null。
    #[serde(default)]
    error: Option<String>,
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
        // 脚本两路查询都没拿到物理磁盘时会带回异常文本，这里转成人话再抛给前端，
        // 避免用户看到成片的 CLIXML 乱码。
        if snapshot.physical_disks.is_empty() {
            if let Some(raw) = snapshot.error.as_deref() {
                return Err(describe_storage_query_failure(raw));
            }
        }
        return merge_storage_snapshot(snapshot);
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("磁盘信息仅支持 Windows 系统".to_string())
    }
}

#[cfg(target_os = "windows")]
fn run_storage_query() -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    // 使用 CIM 一次性读取全部对象，减少 PowerShell 进程和 WMI 查询次数。
    //
    // 中文说明：本脚本对「存储模块」与「传统 WMI 磁盘类」做了双通道降级。
    // 部分 Windows 11 机器的 WMI 仓库损坏、或 VSS / SMPHost 服务被禁用后，
    // root/Microsoft/Windows/Storage 下的 MSFT_* 类会整体缺失，
    // 查询直接抛 0x80041031（WBEM_E_CLASS_NOT_FOUND），导致设置页「读取失败」。
    // 因此这两个查询各自带 try/catch 与降级来源，任何一路失败都不影响整体出结果。
    let script = r#"
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$logicalDisks = @{}
Get-CimInstance -ClassName Win32_LogicalDisk | ForEach-Object { $logicalDisks[$_.DeviceID] = $_ }

# ---- 物理磁盘：优先 MSFT_PhysicalDisk，失败则降级到 Win32_DiskDrive ----
# $physicalError / $partitionError 记录首选通道的失败原因，用于两路都空时给出可读提示。
$physical = @()
$physicalError = $null
try {
  $physical = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_PhysicalDisk -ErrorAction Stop | ForEach-Object {
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
} catch {
  # 注意：Exception.Message 不含 HRESULT（例如「无效命名空间」），
  # 错误码只出现在 FullyQualifiedErrorId 里（如「HRESULT 0x80041031,...」）。
  # 这里把两者都带上，Rust 侧才认得出 WMI 类缺失这类已知故障。
  $physicalError = "$($_.Exception.Message) $($_.FullyQualifiedErrorId)"
  $physical = @()
}
if ($physical.Count -eq 0) {
  # 降级：Win32_DiskDrive 是传统类，不依赖 Storage 模块，覆盖面最广。
  # MediaType 只说明是否可移动介质，无法区分 SSD/HDD，这里统一留空（前端显示「未知」），
  # 不做猜测，避免给出错误的介质类型。
  # Status 是 Win32 的老式字符串枚举（OK / Degraded / Error 等），
  # 这里翻译成与 MSFT_PhysicalDisk.HealthStatus 相同的词汇，让下游只需一套映射。
  $physical = @(Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction SilentlyContinue | Where-Object { $_.Size -gt 0 } | ForEach-Object {
    $health = switch -Regex ([string]$_.Status) {
      '^OK$'            { 'Healthy' }
      'Degraded|Stressed' { 'Warning' }
      'Error|Pred Fail|NonRecover' { 'Unhealthy' }
      default           { $null }
    }
    [PSCustomObject]@{
      number = [UInt32]$_.Index
      model = $_.Model
      serial_number = $_.SerialNumber
      firmware_version = $_.FirmwareRevision
      media_type = $null
      bus_type = $_.InterfaceType
      health_status = $health
      operational_status = $_.Status
      size = [UInt64]$_.Size
    }
  })
}

# ---- 分区：优先 MSFT_Partition，失败则降级到 Win32_DiskPartition 关联盘符 ----
# 分区查询失败不影响整体：没有卷信息时磁盘列表照常展示，因此这里不记录错误原因。
$partitions = @()
try {
  $partitions = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_Partition -ErrorAction Stop | ForEach-Object {
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
} catch {
  # 分区查不到就交给下面的降级通道，不在这里抛错。
  $partitions = @()
}
if ($partitions.Count -eq 0) {
  # 降级：Win32_DiskPartition -> Win32_LogicalDisk 两步关联。
  # 只有真正带盘符的逻辑卷才需要展示，因此没有关联到盘符的分区直接跳过。
  $partitions = @(Get-CimInstance -ClassName Win32_DiskPartition -ErrorAction SilentlyContinue | ForEach-Object {
    $partition = $_
    $drive = $null
    $logical = $partition | Get-CimAssociatedInstance -Association Win32_LogicalDiskToPartition -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($logical) { $drive = $logical.DeviceID }
    if (-not $drive) { return }
    $letter = $drive.TrimEnd(':')
    $space = $logicalDisks[$drive]
    $totalSpace = $null
    $usedSpace = $null
    $freeSpace = $null
    $usagePercent = $null
    if ($space) {
      $totalSpace = [UInt64]$space.Size
      $freeSpace = [UInt64]$space.FreeSpace
      $usedSpace = $totalSpace - $freeSpace
      if ($totalSpace -gt 0) { $usagePercent = [Math]::Round(($usedSpace / $totalSpace) * 100, 1) }
    }
    [PSCustomObject]@{
      disk_number = [UInt32]$partition.DiskIndex
      drive_letter = $letter
      volume_name = $space.VolumeName
      file_system = $space.FileSystem
      total_space = $totalSpace
      used_space = $usedSpace
      free_space = $freeSpace
      usage_percent = $usagePercent
    }
  })
}

    # 只有当两个通道都拿不到物理磁盘时才算真正失败：把首选通道的异常文本带出去，
    # 让 Rust 侧能判断是不是 WMI 类缺失（0x80041031），从而给出可操作的提示。
    # 只要有一路出结果就正常返回，降级场景前端不做额外提示。
    # 分区查询失败不算整体失败——没有卷信息时磁盘列表照常显示。
    $errorText = $null
    if ($physical.Count -eq 0 -and $physicalError) { $errorText = $physicalError }

    $json = [PSCustomObject]@{ physical_disks = $physical; partitions = $partitions; error = $errorText } | ConvertTo-Json -Depth 6 -Compress
    [Console]::Out.Write($json)
"#;

    // 使用 PowerShell 官方的 UTF-16LE 编码参数，避免生产包中长脚本经过命令行转义后丢失输出。
    let encoded_script = encode_powershell_script(script);
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded_script.as_str(),
        ])
        // PowerShell 需要依赖重定向管道返回 JSON；不使用 DETACHED_PROCESS，
        // 避免部分 GUI/管理员环境下子进程 stdout 管道为空，同时保留无控制台标志。
        .creation_flags(POWERSHELL_PROCESS_FLAGS)
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
                let error = sanitize_powershell_error(&String::from_utf8_lossy(&output.stderr));
                return Err(if error.is_empty() {
                    "Windows 磁盘信息查询失败".to_string()
                } else {
                    describe_storage_query_failure(&error)
                });
            }
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                let stderr = sanitize_powershell_error(&String::from_utf8_lossy(&output.stderr));
                let exit_code = status
                    .code()
                    .map_or_else(|| "未知".to_string(), |code| code.to_string());
                return Err(if stderr.is_empty() {
                    format!(
                        "Windows 未返回磁盘信息（PowerShell 退出码 {}，没有 JSON 输出）",
                        exit_code
                    )
                } else {
                    format!(
                        "Windows 未返回磁盘信息（PowerShell 退出码 {}）: {}",
                        exit_code, stderr
                    )
                });
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

#[cfg(target_os = "windows")]
fn encode_powershell_script(script: &str) -> String {
    let utf16_bytes = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect::<Vec<_>>();
    BASE64_STANDARD.encode(utf16_bytes)
}

/// 把 PowerShell / WMI 的原始异常文本转成用户能看懂的一句话。
///
/// 背景：PowerShell 在非交互宿主里会把异常序列化成 CLIXML（`#< CLIXML …<S S="Error">…`），
/// 直接展示给用户就是一屏幕乱码，这也是 issue 里「读取失败」框里那一大段东西的来源。
/// 这里按已知的 HRESULT 给出结论和排查建议，未知错误只保留清洗后的短文本。
fn describe_storage_query_failure(raw: &str) -> String {
    let text = sanitize_powershell_error(raw);

    // 已知 HRESULT 的处理建议。顺序有意义：更具体的错误放前面。
    const KNOWN_FAILURES: &[(&str, &str)] = &[
        (
            "0x80041031",
            "系统 WMI 存储信息不完整，无法读取磁盘列表。可尝试以管理员身份运行，或在系统服务中启用 Volume Shadow Copy、SMI 服务后重试。",
        ),
        (
            "0x8004100e",
            "系统 WMI 存储信息不完整，无法读取磁盘列表。可尝试以管理员身份运行，或重启系统后重试。",
        ),
        (
            "0x80041010",
            "系统的 WMI 存储信息不完整，无法读取磁盘列表。可尝试以管理员身份运行后重试。",
        ),
        (
            "0x80041013",
            "访问系统 WMI 信息超时，请稍后重试。",
        ),
        (
            "0x80041003",
            "没有权限读取系统 WMI 信息，请以管理员身份运行后重试。",
        ),
        (
            "0x80070005",
            "没有权限读取系统 WMI 信息，请以管理员身份运行后重试。",
        ),
        (
            "0x80070422",
            "系统相关服务未启动，无法读取磁盘信息。请在系统服务中启用 Windows Management Instrumentation 后重试。",
        ),
    ];

    let lower = text.to_ascii_lowercase();
    for (code, hint) in KNOWN_FAILURES {
        if lower.contains(&code.to_ascii_lowercase()) {
            return (*hint).to_string();
        }
    }

    if text.is_empty() {
        return "无法读取系统磁盘信息，请稍后重试。".to_string();
    }
    // 未知错误：限长，避免异常文本撑破弹窗。
    let summary: String = text.chars().take(180).collect();
    if text.chars().count() > 180 {
        return format!("无法读取系统磁盘信息：{}…", summary);
    }
    format!("无法读取系统磁盘信息：{}", summary)
}

/// 清洗 PowerShell 异常文本：剥离 CLIXML 外壳与转义实体，压掉多余空白，只留可读的一行。
fn sanitize_powershell_error(raw: &str) -> String {
    let mut text = raw.trim().to_string();

    // 去掉 CLIXML 头，例如 `#< CLIXML\r\n<Objs Version="1.1.0.1" …>`
    if let Some(index) = text.find("<Objs") {
        text = text[index..].to_string();
    }
    // 只取 <S S="Error">…</S> 里的内容，这是 PowerShell 实际想表达的异常行。
    let mut collected = String::new();
    let marker = "<S S=\"Error\">";
    let mut rest = text.as_str();
    while let Some(start) = rest.find(marker) {
        let after = &rest[start + marker.len()..];
        if let Some(end) = after.find("</S>") {
            collected.push_str(&after[..end]);
            collected.push(' ');
            rest = &after[end + 4..];
        } else {
            break;
        }
    }
    let text = if collected.trim().is_empty() { text } else { collected };

    // 还原 CLIXML 的 XML 实体与 _xHHHH_ 形式的转义（如 _x000D__x000A_ 代表换行），再合并空白。
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("_x000D_", " ")
        .replace("_x000A_", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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
    // 降级路径（Win32_DiskDrive.InterfaceType）只给 SCSI / IDE / HDC 这类粗略值，
    // NVMe 与 SATA 盘在该字段里通常都报 SCSI，因此按「未知」处理更诚实，不做具体总线猜测。
    if text.contains("scsi") || text.contains("raid") {
        return "SCSI".to_string();
    }
    if text.contains("ide") || text.contains("hdc") || text.contains("ata") {
        return "ATA".to_string();
    }
    if text.contains("1394") {
        return "IEEE 1394".to_string();
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
            error: None,
        };
        let result = merge_storage_snapshot(snapshot).expect("应合并磁盘信息");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].drive_letters, vec!["C:"]);
        assert!(result[1].drive_letters.is_empty());
        assert_eq!(result[1].health_status, "Unknown");
    }

    #[test]
    fn maps_legacy_disk_drive_fields_from_fallback_channel() {
        // 降级路径（Win32_DiskDrive）给的是另一套取值：media_type 为 null、
        // bus_type 是 SCSI 这类粗粒度字符串、health_status 已由脚本归一化。
        assert_eq!(map_media_type(None), "未知");
        assert_eq!(map_bus_type(Some(serde_json::json!("SCSI"))), "SCSI");
        assert_eq!(map_bus_type(Some(serde_json::json!("ATA"))), "ATA");
        assert_eq!(
            map_health_status(Some(serde_json::json!("Healthy"))),
            "Healthy"
        );
    }

    #[test]
    fn sanitizes_clixml_error_into_single_line() {
        let raw = "#< CLIXML\n<Objs Version=\"1.1.0.1\"><S S=\"Error\">Get-CimInstance : \u{65e0}\u{6cd5}\u{627e}\u{5230}_x000D__x000A_</S><S S=\"Error\">FullyQualifiedErrorId : HRESULT 0x80041031</S></Objs>";
        let clean = sanitize_powershell_error(raw);
        assert!(!clean.contains("CLIXML"), "应剥离 CLIXML 外壳");
        assert!(!clean.contains("<S S="), "应剥离 XML 标记");
        assert!(!clean.contains("_x000D_"), "应去掉转义换行");
        assert!(!clean.contains('\n'), "应压成单行");
        assert!(clean.contains("0x80041031"), "应保留关键错误码");
    }

    #[test]
    fn describes_known_hresult_with_actionable_hint() {
        // 0x80041031 = WBEM_E_CLASS_NOT_FOUND，即 Storage 命名空间下的 MSFT_* 类缺失。
        let hint = describe_storage_query_failure(
            "#< CLIXML<Objs><S S=\"Error\">FullyQualifiedErrorId : HRESULT 0x80041031</S></Objs>",
        );
        assert!(hint.contains("WMI"), "应给出 WMI 方向的提示: {}", hint);
        assert!(!hint.contains("0x80041031"), "不应把原始错误码丢给用户");

        let denied = describe_storage_query_failure("HRESULT 0x80070005");
        assert!(denied.contains("管理员"), "权限错误应提示提权: {}", denied);
    }

    #[test]
    fn truncates_unknown_error_to_stay_readable() {
        let long = "X".repeat(500);
        let hint = describe_storage_query_failure(&long);
        // 180 个字符 + 前后缀，留一点余量。
        assert!(hint.chars().count() < 220, "未知错误应限长: {}", hint.chars().count());
        assert!(hint.ends_with('…'), "截断应有省略号");
    }
}
