// ============================================================================
// 系统瘦身模块
// 负责休眠文件管理、WinSxS 组件清理、虚拟内存迁移引导
// ============================================================================

use log::info;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, Window};

// ============================================================================
// 数据结构
// ============================================================================

/// 系统瘦身项状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlimItemStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub warning: String,
    pub enabled: bool,
    pub size: u64,
    pub actionable: bool,
    pub action_text: String,
}

/// 系统瘦身状态汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSlimStatus {
    pub is_admin: bool,
    pub items: Vec<SlimItemStatus>,
    pub total_reclaimable: u64,
}

// ============================================================================
// 权限检测
// ============================================================================

/// 检查是否以管理员权限运行（直接调用 shell32::IsUserAnAdmin）
pub fn check_admin() -> bool {
    #[cfg(target_os = "windows")]
    {
        #[link(name = "shell32")]
        extern "system" {
            fn IsUserAnAdmin() -> i32;
        }
        unsafe { IsUserAnAdmin() != 0 }
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

// ============================================================================
// 状态检测
// ============================================================================

/// 获取系统瘦身状态
pub fn get_status() -> SystemSlimStatus {
    let is_admin = check_admin();
    let mut items = Vec::new();
    let mut total_reclaimable: u64 = 0;

    // 1. 休眠文件检测
    let hibernation = get_hibernation_status();
    if hibernation.enabled {
        total_reclaimable += hibernation.size;
    }
    items.push(hibernation);

    // 2. WinSxS 组件存储
    let winsxs = get_winsxs_status();
    total_reclaimable += winsxs.size;
    items.push(winsxs);

    // 3. 虚拟内存检测
    let pagefile = get_pagefile_status();
    items.push(pagefile);

    SystemSlimStatus {
        is_admin,
        items,
        total_reclaimable,
    }
}

/// 获取休眠文件状态（通过 powercfg /a 检测实际休眠状态）
fn get_hibernation_status() -> SlimItemStatus {
    let hibernation_enabled = check_hibernation_enabled();
    let hiberfil_path = std::path::Path::new("C:\\hiberfil.sys");
    let exists = hiberfil_path.exists();
    let size = if exists {
        std::fs::metadata(hiberfil_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    SlimItemStatus {
        id: "hibernation".to_string(),
        name: "休眠文件".to_string(),
        description: "Windows 休眠功能会在 C 盘创建与内存大小相当的 hiberfil.sys 文件".to_string(),
        warning: "关闭休眠将导致快速启动功能失效，电脑无法进入休眠状态".to_string(),
        enabled: hibernation_enabled,
        size,
        actionable: true, // 休眠始终可切换（开启/关闭）
        action_text: if hibernation_enabled {
            "关闭休眠".to_string()
        } else {
            "开启休眠".to_string()
        },
    }
}

/// 通过 powercfg /a 检测休眠功能是否已启用
fn check_hibernation_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let output = Command::new("powercfg")
            .args(["/a"])
            .creation_flags(0x08000000)
            .output();

        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                // 休眠已禁用时会输出 "尚未启用休眠" 或 "Hibernation has not been enabled"
                let has_disabled_msg = stdout.contains("尚未启用休眠")
                    || stdout.contains("not been enabled")
                    || stdout.contains("未启用");
                // 休眠可用时会列出 "休眠" 或 "Hibernate"
                let has_hibernate = stdout.contains("休眠")
                    || stdout.lines().any(|l| l.contains("Hibernate"));

                !has_disabled_msg && has_hibernate
            }
            Err(_) => {
                // 回退到文件存在性检测
                std::path::Path::new("C:\\hiberfil.sys").exists()
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 获取 WinSxS 组件存储状态（通过 dism /analyzecomponentstore 获取真实可回收大小）
fn get_winsxs_status() -> SlimItemStatus {
    let estimated_reclaimable = analyze_winsxs_reclaimable();

    SlimItemStatus {
        id: "winsxs".to_string(),
        name: "系统组件存储".to_string(),
        description: "Windows 组件存储 (WinSxS) 包含系统更新的旧版本文件，可安全清理冗余部分"
            .to_string(),
        warning: "清理过程可能需要 5-15 分钟，期间请勿关闭程序或电脑".to_string(),
        enabled: true,
        size: estimated_reclaimable,
        actionable: estimated_reclaimable > 0,
        action_text: if estimated_reclaimable > 0 {
            "开始清理".to_string()
        } else {
            "无需清理".to_string()
        },
    }
}

/// 运行 dism /analyzecomponentstore 获取实际可回收大小
fn analyze_winsxs_reclaimable() -> u64 {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let output = Command::new("dism.exe")
            .args([
                "/online",
                "/cleanup-image",
                "/analyzecomponentstore",
                "/quiet",
            ])
            .creation_flags(0x08000000)
            .output();

        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                let combined = format!("{}\n{}", stdout, String::from_utf8_lossy(&o.stderr));

                // 解析 "Recommended cleanup size" 或 "Recommended :" 行
                // 格式示例: "推荐清理大小 : 3.50 GB" 或 "Recommended cleanup size : 3.50 GB"
                // 也可能是 MB 单位
                for line in combined.lines() {
                    if line.contains("Recommended")
                        || line.contains("推荐")
                        || line.contains("cleanup")
                    {
                        if let Some(size_bytes) = parse_size_from_line(line) {
                            return size_bytes;
                        }
                    }
                }
                // 无法解析时回退到保守估计
                0
            }
            Err(_) => 0,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

/// 从大小字符串解析字节数，支持 "3.50 GB"、"500 MB"、"1.2 GB" 等格式
fn parse_size_from_line(line: &str) -> Option<u64> {
    let line = line.to_lowercase();
    // 找到类似 "3.50 gb" 或 "500 mb" 的模式
    let mut value: Option<f64> = None;
    let mut is_gb = false;

    let bytes_line = line.as_bytes();
    for (i, &b) in bytes_line.iter().enumerate() {
        if b.is_ascii_digit() || b == b'.' {
            // 从当前位置提取数字
            let start = i;
            let mut end = i;
            while end < bytes_line.len()
                && (bytes_line[end].is_ascii_digit() || bytes_line[end] == b'.')
            {
                end += 1;
            }
            if let Ok(v) = std::str::from_utf8(&bytes_line[start..end])
                .unwrap_or("0")
                .parse::<f64>()
            {
                value = Some(v);
                // 检查这个数字后面是否跟着 GB 或 MB
                let rest = &line[end..];
                if rest.trim_start().starts_with("gb") {
                    is_gb = true;
                    break;
                } else if rest.trim_start().starts_with("mb") {
                    is_gb = false;
                    break;
                }
            }
        }
    }

    value.map(|v| {
        let bytes = if is_gb {
            v * 1024.0 * 1024.0 * 1024.0
        } else {
            v * 1024.0 * 1024.0
        };
        bytes as u64
    })
}

/// 获取虚拟内存状态（支持多磁盘分页文件检测）
fn get_pagefile_status() -> SlimItemStatus {
    let pagefile_configs = get_pagefile_configs();

    // 统计 C 盘上的分页文件大小
    let mut c_drive_size: u64 = 0;
    let mut other_drive_size: u64 = 0;
    let mut c_drive_paths: Vec<String> = Vec::new();
    let mut other_drive_paths: Vec<String> = Vec::new();

    for cfg in &pagefile_configs {
        let path_lower = cfg.path.to_lowercase();
        let actual_size = std::fs::metadata(&cfg.path)
            .map(|m| m.len())
            .unwrap_or(cfg.max_size);

        if path_lower.starts_with("c:") {
            c_drive_size += actual_size;
            c_drive_paths.push(format!("{} ({})", cfg.path, format_bytes(actual_size)));
        } else {
            other_drive_size += actual_size;
            other_drive_paths
                .push(format!("{} ({})", cfg.path, format_bytes(actual_size)));
        }
    }

    let is_on_c_drive = c_drive_size > 0;
    let total_size = if is_on_c_drive { c_drive_size } else { other_drive_size };

    // 构建描述文本
    let description = if pagefile_configs.is_empty() || pagefile_configs.len() == 1
        && pagefile_configs.first().map_or(false, |c| c.path.to_lowercase().starts_with("c:"))
        || pagefile_configs.is_empty()
    {
        let loc_text = if pagefile_configs.is_empty() {
            "系统管理".to_string()
        } else {
            c_drive_paths.first().cloned().unwrap_or("系统管理".to_string())
        };
        format!(
            "当前分页文件: {}。建议将虚拟内存迁移到非系统盘以释放 C 盘空间",
            loc_text
        )
    } else {
        let all_paths: Vec<String> = c_drive_paths
            .iter()
            .chain(other_drive_paths.iter())
            .cloned()
            .collect();
        format!(
            "分页文件分布在 {} 个磁盘: {}。",
            if is_on_c_drive && other_drive_size > 0 {
                "多"
            } else {
                "1"
            },
            all_paths.join(", ")
        )
    };

    SlimItemStatus {
        id: "pagefile".to_string(),
        name: "虚拟内存".to_string(),
        description,
        warning: "虚拟内存对系统稳定性至关重要，不建议直接删除，请通过系统设置迁移到其他磁盘"
            .to_string(),
        enabled: is_on_c_drive,
        size: total_size,
        actionable: is_on_c_drive,
        action_text: if is_on_c_drive {
            "打开系统设置".to_string()
        } else {
            "无需操作".to_string()
        },
    }
}

/// 分页文件配置项
struct PagefileConfig {
    path: String,
    #[allow(dead_code)]
    initial_size: u64,
    max_size: u64,
}

/// 从注册表读取分页文件配置（支持多磁盘）
fn get_pagefile_configs() -> Vec<PagefileConfig> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let output = Command::new("reg")
            .args([
                "query",
                r"HKLM\System\CurrentControlSet\Control\Session Manager\Memory Management",
                "/v",
                "PagingFiles",
            ])
            .creation_flags(0x08000000)
            .output();

        match output {
            Ok(o) => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                if let Some(line) = stdout.lines().find(|l| l.contains("PagingFiles")) {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    // 格式: "PagingFiles REG_MULTI_SZ C:\pagefile.sys 2048 4096 D:\pagefile.sys 1024 1024"
                    if parts.len() >= 3 {
                        return parse_pagefile_configs(&parts[2..].join(" "));
                    }
                }
                vec![]
            }
            Err(_) => vec![],
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![]
    }
}

/// 解析分页文件配置字符串
/// 格式: "C:\pagefile.sys 2048 4096 D:\pagefile.sys 1024 1024"
fn parse_pagefile_configs(raw: &str) -> Vec<PagefileConfig> {
    let mut configs = Vec::new();
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut i = 0;

    while i < tokens.len() {
        let token = tokens[i];
        // 检查是否为盘符路径格式 (如 "C:\..." 或 "c:\...")
        if token.len() >= 3 && &token.as_bytes()[1..3] == b":\\" {
            let path = if token.ends_with(',') {
                token[..token.len() - 1].to_string()
            } else {
                token.to_string()
            };

            let initial_size = if i + 1 < tokens.len() {
                tokens[i + 1].trim_end_matches(',').parse::<u64>().unwrap_or(0)
            } else {
                0
            };
            let max_size = if i + 2 < tokens.len() {
                tokens[i + 2].trim_end_matches(',').parse::<u64>().unwrap_or(0)
            } else {
                0
            };

            configs.push(PagefileConfig {
                path,
                initial_size: initial_size * 1024 * 1024, // MB → 字节
                max_size: max_size * 1024 * 1024,
            });
            i += 3;
        } else {
            i += 1;
        }
    }

    configs
}

/// 格式化字节为可读字符串
fn format_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", bytes / 1024)
    }
}

// ============================================================================
// 操作执行
// ============================================================================

/// 关闭休眠功能
pub fn disable_hibernation() -> Result<String, String> {
    if !check_admin() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        info!("正在关闭休眠功能...");

        let output = Command::new("powercfg")
            .args(["-h", "off"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("执行命令失败: {}", e))?;

        if output.status.success() {
            info!("休眠功能已关闭");
            Ok("休眠功能已成功关闭，hiberfil.sys 文件将被删除".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("关闭休眠失败: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

/// 开启休眠功能
pub fn enable_hibernation() -> Result<String, String> {
    if !check_admin() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        info!("正在开启休眠功能...");

        let output = Command::new("powercfg")
            .args(["-h", "on"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| format!("执行命令失败: {}", e))?;

        if output.status.success() {
            info!("休眠功能已开启");
            Ok("休眠功能已成功开启".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("开启休眠失败: {}", stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

/// 清理 WinSxS 组件存储（异步执行，实时推送进度）
pub async fn cleanup_winsxs(window: &Window) -> Result<String, String> {
    if !check_admin() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::io::BufRead;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        info!("开始清理 WinSxS 组件存储...");

        let _ = window.emit(
            "winsxs-cleanup-progress",
            serde_json::json!({
                "status": "running",
                "message": "正在清理系统组件存储，请耐心等待...",
                "progress": 0
            }),
        );

        let handle = window.app_handle().clone();

        let result = tokio::task::spawn_blocking(move || {
            let mut child = Command::new("dism.exe")
                .args([
                    "/online",
                    "/cleanup-image",
                    "/startcomponentcleanup",
                    "/resetbase",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000)
                .spawn()?;

            let stdout = child.stdout.take().unwrap();
            let reader = std::io::BufReader::new(stdout);
            let mut last_progress: u32 = 0;

            for line in reader.lines() {
                if let Ok(line) = line {
                    // DISM 进度格式: "[=====      15.0%                          ]"
                    if let Some(pct) = parse_dism_progress(&line) {
                        if pct > last_progress {
                            last_progress = pct;
                            let _ = handle.emit(
                                "winsxs-cleanup-progress",
                                serde_json::json!({
                                    "status": "running",
                                    "message": format!("正在清理: {}%", pct),
                                    "progress": pct
                                }),
                            );
                        }
                    }
                }
            }

            let output = child.wait_with_output()?;
            Ok::<std::process::Output, std::io::Error>(output)
        })
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
        .map_err(|e| format!("执行 DISM 命令失败: {}", e))?;

        if result.status.success() {
            info!("WinSxS 清理完成");
            let _ = window.emit(
                "winsxs-cleanup-progress",
                serde_json::json!({
                    "status": "done",
                    "message": "清理完成",
                    "progress": 100
                }),
            );
            Ok("系统组件存储清理完成".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let stdout = String::from_utf8_lossy(&result.stdout);
            let _ = window.emit(
                "winsxs-cleanup-progress",
                serde_json::json!({
                    "status": "error",
                    "message": format!("清理失败: {}", stderr),
                    "progress": 0
                }),
            );
            Err(format!("清理失败: {} {}", stdout, stderr))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

/// 从 DISM 输出行解析进度百分比
/// DISM 进度行格式: "[===========================85.0%==================        ]"
fn parse_dism_progress(line: &str) -> Option<u32> {
    // 查找形如 "XX.X%" 的进度标记
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b.is_ascii_digit() {
            // 检查后面是否有 '%' 符号
            let end = bytes[i..]
                .iter()
                .position(|&c| c == b'%')
                .map(|p| i + p);
            if let Some(pct_pos) = end {
                let num_str = std::str::from_utf8(&bytes[i..pct_pos]).ok()?;
                if let Ok(val) = num_str.parse::<f64>() {
                    return Some(val as u32);
                }
            }
        }
    }
    None
}

/// 打开系统虚拟内存设置
pub fn open_virtual_memory_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        info!("打开虚拟内存设置...");

        Command::new("SystemPropertiesAdvanced.exe")
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法打开系统设置: {}", e))?;

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}
