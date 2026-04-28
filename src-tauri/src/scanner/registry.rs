// ============================================================================
// 注册表残留扫描模块
//
// 【安全声明】
//   1. 只读扫描：扫描阶段绝不修改任何注册表键值
//   2. 铁证条件：关联 exe 不存在 + 非系统路径 + 非系统进程，三项全部满足才输出
//   3. 范围收敛：只扫描 HKCR\Applications（文件关联残留），不碰系统关键区域
//   4. 真实备份：删除前使用 reg.exe export 创建可恢复的 .reg 文件
//   5. 用户确认：所有删除操作需用户明确选择
//
// 【为什么只扫描 HKCR\Applications】
//   程序安装时在此注册文件关联（如 "用 xxx 打开 .pdf"），卸载后经常残留。
//   这是最安全且最有价值的注册表清理目标——删错最多丢失文件关联，
//   不会影响系统稳定性。
// ============================================================================

use chrono;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use winreg::enums::*;
use winreg::RegKey;

use super::registry_scoring::{is_definitely_safe_to_delete, PathCache, PathResolver};

// ============================================================================
// 数据类型
// ============================================================================

/// 扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryScanResult {
    pub entries: Vec<RegistryEntry>,
    pub total_count: u32,
    pub scan_duration_ms: u64,
}

/// 单个残留条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntry {
    /// HKCR\Applications 下的完整路径
    pub path: String,
    /// 应用程序名（注册表子键名，如 "notepad.exe"）
    pub name: String,
    /// 关联的不存在的可执行文件路径
    pub associated_path: String,
    /// 人类可读的问题描述
    pub issue: String,
}

/// 删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryDeleteResult {
    pub backup_path: String,
    pub deleted_count: u32,
    pub failed_entries: Vec<String>,
    pub errors: Vec<String>,
}

// ============================================================================
// 扫描器
// ============================================================================

/// 注册表残留扫描器
///
/// 扫描 HKCR\Applications 下所有子键，检查其 shell\open\command
/// 引用的可执行文件是否仍然存在。
pub struct RegistryScanner {
    path_cache: PathCache,
    path_resolver: PathResolver,
}

impl RegistryScanner {
    pub fn new() -> Self {
        log::info!("注册表残留扫描器已初始化");
        RegistryScanner {
            path_cache: PathCache::new(),
            path_resolver: PathResolver::new(),
        }
    }

    /// 执行扫描
    pub fn scan(&mut self) -> RegistryScanResult {
        let start_time = std::time::Instant::now();
        let mut entries = Vec::new();
        let mut seen_paths: HashSet<String> = HashSet::new(); // 按关联路径去重

        log::info!("开始扫描注册表残留 (HKCR\\Applications)");

        let apps_key = match RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey_with_flags("Applications", KEY_READ)
        {
            Ok(k) => k,
            Err(e) => {
                log::warn!("无法打开 HKCR\\Applications: {}", e);
                return RegistryScanResult {
                    entries: vec![],
                    total_count: 0,
                    scan_duration_ms: start_time.elapsed().as_millis() as u64,
                };
            }
        };

        for app_name in apps_key.enum_keys().filter_map(|k| k.ok()) {
            if entries.len() >= 100 {
                break;
            }

            // 读 shell\open\command 默认值（命令行字符串）
            let shell_path = format!(r"{}\shell\open\command", app_name);
            let exe_path = match apps_key.open_subkey_with_flags(&shell_path, KEY_READ) {
                Ok(cmd_key) => match cmd_key.get_value::<String, _>("") {
                    Ok(cmd) => self
                        .path_resolver
                        .extract_and_resolve(&cmd)
                        .map(|(path, _)| path.to_string_lossy().to_string()),
                    Err(_) => None,
                },
                Err(_) => None,
            };

            let exe_path = match exe_path {
                Some(p) => p,
                None => continue,
            };

            // 铁证条件：路径不存在 + 非系统路径 + 非系统进程
            if !is_definitely_safe_to_delete(&exe_path, &mut self.path_cache) {
                continue;
            }

            // 去重：同一个 exe 可能被多个应用名注册
            let path_lower = exe_path.to_lowercase();
            if seen_paths.contains(&path_lower) {
                continue;
            }
            seen_paths.insert(path_lower);

            entries.push(RegistryEntry {
                path: format!(r"HKEY_CLASSES_ROOT\Applications\{}", app_name),
                name: app_name,
                associated_path: exe_path.clone(),
                issue: format!("关联的可执行文件不存在: {}", exe_path),
            });
        }

        entries.sort_by(|a, b| a.name.cmp(&b.name));

        let total_count = entries.len() as u32;
        let scan_duration_ms = start_time.elapsed().as_millis() as u64;

        let (cache_hits, cache_misses) = self.path_cache.stats();
        log::info!(
            "扫描完成: {} 个残留条目, 耗时 {}ms, 缓存命中率 {:.1}%",
            total_count,
            scan_duration_ms,
            if cache_hits + cache_misses > 0 {
                (cache_hits as f64 / (cache_hits + cache_misses) as f64) * 100.0
            } else {
                0.0
            }
        );

        RegistryScanResult {
            entries,
            total_count,
            scan_duration_ms,
        }
    }
}

impl Default for RegistryScanner {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 备份
// ============================================================================

/// 注册表备份管理器
///
/// 使用 `reg.exe export` 导出完整子键为 .reg 文件，可双击恢复。
pub struct RegistryBackup;

impl RegistryBackup {
    /// 批量导出注册表键到 .reg 文件
    pub fn export_backup(entries: &[RegistryEntry], backup_dir: &Path) -> Result<PathBuf, String> {
        fs::create_dir_all(backup_dir).map_err(|e| format!("创建备份目录失败: {}", e))?;

        let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let backup_file = backup_dir.join(format!("lightc_registry_backup_{}.reg", timestamp));

        let mut file =
            File::create(&backup_file).map_err(|e| format!("创建备份文件失败: {}", e))?;

        // .reg 文件头
        writeln!(file, "Windows Registry Editor Version 5.00")
            .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file).map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(
            file,
            "; LightC 注册表备份 — {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        )
        .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(
            file,
            "; 条目数: {}, 如需恢复请双击此文件",
            entries.len()
        )
        .map_err(|e| format!("写入备份文件失败: {}", e))?;
        writeln!(file).map_err(|e| format!("写入备份文件失败: {}", e))?;

        for entry in entries {
            Self::export_key_via_reg_exe(&mut file, entry)?;
        }

        file.flush().map_err(|e| format!("刷新备份文件失败: {}", e))?;
        log::info!("注册表备份已保存: {:?}", backup_file);

        Ok(backup_file)
    }

    /// 使用 reg.exe export 导出完整注册表键
    fn export_key_via_reg_exe(file: &mut File, entry: &RegistryEntry) -> Result<(), String> {
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join(format!("lightc_temp_export_{}.reg", std::process::id()));

        let reg_subpath = Self::to_reg_exe_format(&entry.path)?;

        let output = Command::new("reg")
            .args([
                "export",
                &reg_subpath,
                &temp_file.to_string_lossy(),
                "/y",
            ])
            .output()
            .map_err(|e| format!("执行 reg export 失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // 回退：手动记录路径头
            writeln!(
                file,
                "; [回退] reg export 失败: {}. 手动记录路径",
                stderr.trim()
            )
            .map_err(|e| format!("写入备份注释失败: {}", e))?;
            writeln!(file, "[{}]", entry.path)
                .map_err(|e| format!("写入备份路径失败: {}", e))?;
            writeln!(file, "; 此条目备份失败，请手动检查: {}", entry.issue)
                .map_err(|e| format!("写入备份注释失败: {}", e))?;
            writeln!(file).map_err(|e| format!("写入备份失败: {}", e))?;
            return Ok(());
        }

        let content = fs::read_to_string(&temp_file)
            .map_err(|e| format!("读取临时导出文件失败: {}", e))?;

        // 跳过 .reg 文件头，追加内容
        let mut started = false;
        for line in content.lines() {
            if !started {
                if line.is_empty() || line.starts_with("Windows Registry Editor") {
                    continue;
                }
                started = true;
            }
            writeln!(file, "{}", line).map_err(|e| format!("写入备份内容失败: {}", e))?;
        }
        writeln!(file).map_err(|e| format!("写入备份换行失败: {}", e))?;

        let _ = fs::remove_file(&temp_file);
        Ok(())
    }

    /// 路径转换: HKEY_CLASSES_ROOT\Applications\xxx → Applications\xxx (供 reg.exe)
    fn to_reg_exe_format(path: &str) -> Result<String, String> {
        if let Some(subpath) = path.strip_prefix("HKEY_CURRENT_USER\\") {
            Ok(format!("HKCU\\{}", subpath))
        } else if let Some(subpath) = path.strip_prefix("HKEY_LOCAL_MACHINE\\") {
            Ok(format!("HKLM\\{}", subpath))
        } else if let Some(subpath) = path.strip_prefix("HKEY_CLASSES_ROOT\\") {
            Ok(format!("HKCR\\{}", subpath))
        } else {
            Err(format!("无法解析注册表路径: {}", path))
        }
    }

    /// 默认备份目录
    pub fn get_backup_dir() -> PathBuf {
        dirs::document_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\"))
            .join("LightC")
            .join("RegistryBackups")
    }
}

// ============================================================================
// 删除
// ============================================================================

/// 删除单个注册表条目（删除整个子键）
///
/// 调用前必须通过 RegistryBackup::export_backup 创建备份。
pub fn delete_registry_entry(entry: &RegistryEntry) -> Result<(), String> {
    let (root_key, subpath) = parse_registry_path_components(&entry.path)?;
    let (parent_path, child_name) = split_last_component(subpath)?;

    let parent_key = root_key
        .open_subkey_with_flags(parent_path, KEY_WRITE)
        .map_err(|e| format!("打开父键失败: {}", e))?;

    parent_key
        .delete_subkey_all(child_name)
        .map_err(|e| format!("删除注册表键失败: {}", e))?;

    log::info!("已删除注册表键: {}", entry.path);
    Ok(())
}

fn parse_registry_path_components(path: &str) -> Result<(RegKey, &str), String> {
    if let Some(subpath) = path.strip_prefix("HKEY_CURRENT_USER\\") {
        Ok((RegKey::predef(HKEY_CURRENT_USER), subpath))
    } else if let Some(subpath) = path.strip_prefix("HKEY_LOCAL_MACHINE\\") {
        Ok((RegKey::predef(HKEY_LOCAL_MACHINE), subpath))
    } else if let Some(subpath) = path.strip_prefix("HKEY_CLASSES_ROOT\\") {
        Ok((RegKey::predef(HKEY_CLASSES_ROOT), subpath))
    } else {
        Err(format!("无法解析注册表路径: {}", path))
    }
}

fn split_last_component(path: &str) -> Result<(&str, &str), String> {
    path.rsplit_once('\\')
        .ok_or_else(|| format!("无法分割路径: {}", path))
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scanner_creation() {
        let scanner = RegistryScanner::new();
        assert!(scanner.path_cache.stats().0 == 0);
    }

    #[test]
    fn test_to_reg_exe_format() {
        // HKCR\Applications\xxx → HKCR\Applications\xxx
        let result = RegistryBackup::to_reg_exe_format(
            r"HKEY_CLASSES_ROOT\Applications\notepad.exe",
        );
        assert_eq!(result.unwrap(), r"HKCR\Applications\notepad.exe");
    }

    #[test]
    fn test_is_definitely_safe_with_fake_path() {
        let mut cache = PathCache::new();
        assert!(is_definitely_safe_to_delete(
            r"C:\ThisPathDoesNotExist\fake.exe",
            &mut cache
        ));
    }

    #[test]
    fn test_is_definitely_safe_system32_rejected() {
        let mut cache = PathCache::new();
        assert!(!is_definitely_safe_to_delete(
            r"C:\Windows\System32\some.exe",
            &mut cache
        ));
    }

    #[test]
    fn test_is_definitely_safe_svchost_rejected() {
        let mut cache = PathCache::new();
        assert!(!is_definitely_safe_to_delete(
            r"C:\Program Files\SomeApp\svchost.exe",
            &mut cache
        ));
    }
}
