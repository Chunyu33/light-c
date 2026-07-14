// ============================================================================
// 系统工具命令（格式化、打开系统设置等）
// ============================================================================

use log::info;

/// 格式化文件大小
#[tauri::command]
pub fn format_size(bytes: u64) -> String {
    crate::scanner::format_size(bytes)
}

/// 打开Windows磁盘清理工具
#[tauri::command]
pub fn open_disk_cleanup() -> Result<(), String> {
    info!("打开Windows磁盘清理工具");

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("cleanmgr")
            .arg("/d")
            .arg("C")
            .spawn()
            .map_err(|e| format!("无法启动磁盘清理工具: {}", e))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 在文件资源管理器中打开路径
/// - 如果是目录，直接钻入该目录
/// - 如果是文件，打开所在目录并选中该文件
#[tauri::command]
pub fn open_in_folder(path: String) -> Result<(), String> {
    info!("打开路径: {}", path);

    #[cfg(target_os = "windows")]
    {
        use std::path::Path;
        use std::process::Command;
        // Windows explorer 需要反斜杠路径，正斜杠会导致打开桌面而非目标目录
        let windows_path = path.replace('/', "\\");
        let p = Path::new(&windows_path);
        if p.is_dir() {
            // 目录：直接打开钻入
            Command::new("explorer")
                .arg(&windows_path)
                .spawn()
                .map_err(|e| format!("无法打开文件夹: {}", e))?;
        } else {
            // 文件：打开所在目录并选中
            Command::new("explorer")
                .arg("/select,")
                .arg(&windows_path)
                .spawn()
                .map_err(|e| format!("无法打开文件夹: {}", e))?;
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 直接打开文件（使用系统默认程序）
#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    info!("打开文件: {}", path);

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        let quoted_path = format!("\"{}\"", path);
        Command::new("cmd")
            .args(["/C", "start", "", &quoted_path])
            .spawn()
            .map_err(|e| format!("无法打开文件: {}", e))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 打开 Windows 系统回收站视图，而不是物理 `$Recycle.Bin` 内部目录。
#[tauri::command]
pub fn open_recycle_bin() -> Result<(), String> {
    info!("打开系统回收站");

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("shell:RecycleBinFolder")
            .spawn()
            .map_err(|error| format!("无法打开系统回收站: {}", error))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持Windows系统".to_string())
    }
}

/// 打开任务管理器的启动项管理页面
#[tauri::command]
pub fn open_startup_manager() -> Result<(), String> {
    info!("打开启动项管理器");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        Command::new("cmd")
            .args(["/c", "start", "taskmgr", "/0", "/startup"])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法打开启动项管理器: {}", e))?;
    }

    Ok(())
}

/// 打开 Windows 存储感知设置页面
#[tauri::command]
pub fn open_storage_settings() -> Result<(), String> {
    info!("打开存储感知设置");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        Command::new("cmd")
            .args(["/c", "start", "ms-settings:storagesense"])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("无法打开存储感知设置: {}", e))?;
    }

    Ok(())
}
