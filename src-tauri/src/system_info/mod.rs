// ============================================================================
// 系统信息模块
// 获取 OS 版本、CPU、内存、架构、运行时间等系统信息
// ============================================================================

use serde::{Deserialize, Serialize};

/// 系统信息结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    /// 操作系统名称
    pub os_name: String,
    /// 操作系统版本
    pub os_version: String,
    /// 系统架构
    pub os_arch: String,
    /// 计算机名称
    pub computer_name: String,
    /// 用户名
    pub user_name: String,
    /// CPU 信息
    pub cpu_info: String,
    /// CPU 核心数
    pub cpu_cores: u32,
    /// 总内存（字节）
    pub total_memory: u64,
    /// 可用内存（字节）
    pub available_memory: u64,
    /// 系统启动时间（秒）
    pub uptime_seconds: u64,
}

/// 获取系统信息
pub fn gather() -> Result<SystemInfo, String> {
    #[cfg(target_os = "windows")]
    {
        use winapi::um::sysinfoapi::{GetSystemInfo, SYSTEM_INFO};

        let os_version = get_windows_version();
        let os_arch = get_arch_string();
        let computer_name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "未知".to_string());
        let user_name = std::env::var("USERNAME").unwrap_or_else(|_| "未知".to_string());
        let cpu_info = get_cpu_info();
        let cpu_cores = unsafe {
            let mut sys_info: SYSTEM_INFO = std::mem::zeroed();
            GetSystemInfo(&mut sys_info);
            sys_info.dwNumberOfProcessors
        };
        let (total_memory, available_memory) = get_memory_info();
        let uptime_seconds = unsafe { winapi::um::sysinfoapi::GetTickCount64() / 1000 };

        Ok(SystemInfo {
            os_name: "Microsoft Windows".to_string(),
            os_version,
            os_arch,
            computer_name,
            user_name,
            cpu_info,
            cpu_cores,
            total_memory,
            available_memory,
            uptime_seconds,
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

fn get_arch_string() -> String {
    if cfg!(target_arch = "x86_64") {
        "x64 (64位)".to_string()
    } else if cfg!(target_arch = "x86") {
        "x86 (32位)".to_string()
    } else if cfg!(target_arch = "aarch64") {
        "ARM64".to_string()
    } else {
        std::env::consts::ARCH.to_string()
    }
}

fn get_memory_info() -> (u64, u64) {
    #[cfg(target_os = "windows")]
    {
        use winapi::um::sysinfoapi::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        unsafe {
            let mut mem_status: MEMORYSTATUSEX = std::mem::zeroed();
            mem_status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut mem_status) != 0 {
                (mem_status.ullTotalPhys, mem_status.ullAvailPhys)
            } else {
                (0, 0)
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        (0, 0)
    }
}

#[cfg(target_os = "windows")]
fn get_windows_version() -> String {
    use winreg::enums::*;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion") {
        let product_name: String = key.get_value("ProductName").unwrap_or_default();
        let display_version: String = key.get_value("DisplayVersion").unwrap_or_default();
        let current_build: String = key.get_value("CurrentBuild").unwrap_or_default();
        let ubr: u32 = key.get_value("UBR").unwrap_or(0);

        if !product_name.is_empty() {
            // 根据 Build 号判断是否为 Windows 11（Build 22000+）
            let build_num: u32 = current_build.parse().unwrap_or(0);
            let corrected_name = if build_num >= 22000 && product_name.contains("Windows 10") {
                product_name.replace("Windows 10", "Windows 11")
            } else {
                product_name
            };

            let version_str = if !display_version.is_empty() {
                format!(
                    "{} {} (Build {}.{})",
                    corrected_name, display_version, current_build, ubr
                )
            } else {
                format!("{} (Build {}.{})", corrected_name, current_build, ubr)
            };
            return version_str;
        }
    }

    "Windows".to_string()
}

#[cfg(target_os = "windows")]
fn get_cpu_info() -> String {
    use winreg::enums::*;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(key) = hklm.open_subkey("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0") {
        let processor_name: String = key.get_value("ProcessorNameString").unwrap_or_default();
        if !processor_name.is_empty() {
            return processor_name.trim().to_string();
        }
    }

    std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "未知处理器".to_string())
}

#[cfg(not(target_os = "windows"))]
fn get_windows_version() -> String {
    "非Windows系统".to_string()
}

#[cfg(not(target_os = "windows"))]
fn get_cpu_info() -> String {
    "未知处理器".to_string()
}
