// ============================================================================
// 注册表和右键菜单清理命令
// ============================================================================

use crate::scanner::{
    RegistryBackup, RegistryDeleteResult, RegistryEntry, RegistryScanResult, RegistryScanner,
};
use log::info;

// ============================================================================
// 注册表冗余
// ============================================================================

/// 扫描注册表冗余
#[tauri::command]
pub async fn scan_registry_redundancy() -> Result<RegistryScanResult, String> {
    info!("开始扫描注册表冗余...");

    let result = tokio::task::spawn_blocking(|| {
        let mut scanner = RegistryScanner::new();
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务失败: {}", e))?;

    info!("注册表扫描完成: 发现 {} 个冗余条目", result.total_count);

    Ok(result)
}

/// 备份并删除注册表条目
#[tauri::command]
pub async fn delete_registry_entries(
    entries: Vec<RegistryEntry>,
) -> Result<RegistryDeleteResult, String> {
    info!("开始删除 {} 个注册表条目...", entries.len());

    let backup_dir = RegistryBackup::get_backup_dir();
    let backup_path = RegistryBackup::export_backup(&entries, &backup_dir)
        .map_err(|e| format!("创建备份失败: {}", e))?;

    info!("注册表备份已保存到: {:?}", backup_path);

    let result = tokio::task::spawn_blocking(move || {
        let mut deleted_count = 0u32;
        let mut failed_entries = Vec::new();
        let mut errors = Vec::new();

        for entry in entries {
            match crate::scanner::delete_registry_entry(&entry) {
                Ok(_) => {
                    deleted_count += 1;
                }
                Err(e) => {
                    failed_entries.push(entry.path.clone());
                    errors.push(e);
                }
            }
        }

        RegistryDeleteResult {
            backup_path: backup_path.to_string_lossy().to_string(),
            deleted_count,
            failed_entries,
            errors,
        }
    })
    .await
    .map_err(|e| format!("删除任务失败: {}", e))?;

    info!(
        "注册表删除完成: 成功 {}, 失败 {}",
        result.deleted_count,
        result.failed_entries.len()
    );

    Ok(result)
}

/// 打开注册表备份目录
#[tauri::command]
pub async fn open_registry_backup_dir() -> Result<(), String> {
    let backup_dir = RegistryBackup::get_backup_dir();

    std::fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {}", e))?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&backup_dir)
            .spawn()
            .map_err(|e| format!("打开目录失败: {}", e))?;
    }

    Ok(())
}

// ============================================================================
// 右键菜单
// ============================================================================

/// 扫描 Windows 注册表中的右键菜单条目
#[tauri::command]
pub async fn scan_context_menu() -> Result<crate::scanner::ContextMenuScanResult, String> {
    use crate::scanner::ContextMenuScanner;

    info!("开始扫描右键菜单注册表条目");

    let result = tokio::task::spawn_blocking(move || {
        let scanner = ContextMenuScanner::new();
        scanner.scan()
    })
    .await
    .map_err(|e| format!("扫描任务执行失败: {}", e))??;

    info!(
        "右键菜单扫描完成: {} 条目，其中 {} 个无效，耗时 {}ms",
        result.entries.len(),
        result.invalid_count,
        result.scan_duration_ms
    );

    Ok(result)
}

/// 删除选中的右键菜单注册表条目
#[tauri::command]
pub async fn delete_context_menu_entries(
    entries: Vec<crate::scanner::ContextMenuDeleteRequest>,
) -> Result<crate::scanner::ContextMenuDeleteResult, String> {
    use crate::scanner::delete_context_menu_entries as do_delete;

    info!("开始删除 {} 个右键菜单条目", entries.len());

    let result = tokio::task::spawn_blocking(move || do_delete(&entries))
        .await
        .map_err(|e| format!("删除任务执行失败: {}", e))?;

    info!(
        "右键菜单清理完成: 成功 {} 个，失败 {} 个",
        result.deleted_count, result.failed_count
    );

    Ok(result)
}
