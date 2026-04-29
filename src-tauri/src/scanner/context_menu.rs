// ============================================================================
// 右键菜单扫描模块
// 扫描 Windows 注册表中注册的右键菜单项，识别指向不存在可执行文件的无效条目
// ============================================================================
//
// 【扫描路径】
// 以下路径同时覆盖 HKEY_LOCAL_MACHINE 和 HKEY_CURRENT_USER 两棵树：
//
//   *\shell                      — 右键点击任意文件时出现的菜单
//   Directory\shell              — 右键点击文件夹时出现的菜单
//   Directory\Background\shell   — 右键点击文件夹/桌面空白区域时出现的菜单
//   Drive\shell                  — 右键点击磁盘驱动器时出现的菜单
//   LibraryFolder\Background\shell — 右键点击库文件夹背景时出现的菜单
//
// 【核心逻辑】
// 对每个 shell 子键，读取：
//   1. (Default) 或 MUIVerb 值作为菜单显示名称
//   2. Icon 值作为图标路径
//   3. command 子键的 (Default) 值作为可执行命令
// 然后从命令字符串中提取 exe 路径，检查文件是否存在
//
// 【安全措施】
// - 扫描阶段只读，绝不修改注册表
// - 删除前需用户明确确认
// - 内置系统关键条目白名单，永不触碰
// - HKLM 条目标记为需要管理员权限
// ============================================================================

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;
use winreg::enums::*;
use winreg::RegKey;

// ============================================================================
// Windows API FFI（用于解析 MUIVerb 间接字符串 @path,-id）
// ============================================================================

#[link(name = "shlwapi")]
extern "system" {
    /// https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-shloadindirectstring
    fn SHLoadIndirectString(
        pszSource: *const u16,
        pszOutBuf: *mut u16,
        cchOutBuf: u32,
        ppvReserved: *mut *const std::ffi::c_void,
    ) -> i32;
}

/// 调用 SHLoadIndirectString 解析 @path,-id 格式的间接字符串
/// 失败时返回原始字符串
fn resolve_indirect_string(raw: &str) -> String {
    if !raw.starts_with('@') {
        return raw.to_string();
    }

    // 先展开环境变量（如 @%SystemRoot%\system32\shell32.dll,-21769）
    let expanded = expand_env_vars(raw);

    // 转换为 UTF-16 宽字符
    let source_wide: Vec<u16> = expanded.encode_utf16().chain(std::iter::once(0)).collect();
    let mut out_buf: Vec<u16> = vec![0u16; 512]; // 512 字符足够容纳菜单文字

    let hr = unsafe {
        SHLoadIndirectString(
            source_wide.as_ptr(),
            out_buf.as_mut_ptr(),
            out_buf.len() as u32,
            std::ptr::null_mut(),
        )
    };

    if hr == 0 {
        // S_OK — 成功，截取到 null
        if let Some(null_pos) = out_buf.iter().position(|&c| c == 0) {
            let resolved_wide = &out_buf[..null_pos];
            return OsString::from_wide(resolved_wide)
                .to_string_lossy()
                .to_string();
        }
    }

    // 解析失败，回退到原始值
    raw.to_string()
}

/// 简单展开常见环境变量
fn expand_env_vars(path: &str) -> String {
    let mut result = path.to_string();
    let vars = [
        ("%SystemRoot%", "C:\\Windows"),
        ("%SYSTEMROOT%", "C:\\Windows"),
        ("%ProgramFiles%", "C:\\Program Files"),
        ("%ProgramFiles(x86)%", "C:\\Program Files (x86)"),
        ("%PROGRAMFILES%", "C:\\Program Files"),
        ("%WINDIR%", "C:\\Windows"),
    ];
    for (var, default) in vars {
        if result.to_uppercase().contains(&var.to_uppercase()) {
            let env_name = var.trim_matches('%');
            let actual = std::env::var(env_name).unwrap_or_else(|_| default.to_string());
            result = result.replace(var, &actual);
        }
    }
    result
}

// ============================================================================
// 数据结构
// ============================================================================

/// 右键菜单扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuScanResult {
    /// 扫描到的所有菜单条目
    pub entries: Vec<ContextMenuEntry>,
    /// 其中无效（exe 不存在）的条目数
    pub invalid_count: usize,
    /// 扫描耗时（毫秒）
    pub scan_duration_ms: u64,
}

/// 单个右键菜单条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuEntry {
    /// 唯一 ID，用于删除时定位（reg_root + "||" + reg_subpath）
    pub id: String,
    /// 菜单显示名称（已解析 MUIVerb 间接字符串）
    pub display_name: String,
    /// 注册表子键名（shell 下的子键名，如 "VSCode"）
    pub key_name: String,
    /// 完整注册表路径（用于 UI 展示）
    pub registry_path: String,
    /// 注册表根（"HKCU" | "HKLM"）
    pub reg_root: String,
    /// 相对于根的子路径（如 "SOFTWARE\\Classes\\*\\shell\\MyApp"）
    pub reg_subpath: String,
    /// 右键菜单的作用范围（"任意文件", "文件夹", "桌面背景", "磁盘驱动器", "库文件夹"）
    pub scope: String,
    /// 图标路径（原始值，可能含 index 后缀如 "C:\foo.exe,0"）
    pub icon_path: Option<String>,
    /// 原始命令字符串（来自 command 子键）
    pub command: Option<String>,
    /// 从命令中提取的可执行文件路径（去掉参数后的纯路径）
    pub exe_path: Option<String>,
    /// 可执行文件是否存在于磁盘
    pub exe_exists: bool,
    /// 删除此条目是否需要管理员权限（HKLM 条目需要）
    pub needs_admin: bool,
    /// 是否为系统保护条目（不可选中删除）
    pub is_system_protected: bool,
    /// 风险等级（"safe" | "caution" | "danger"）
    pub risk_level: String,
}

/// 右键菜单条目删除请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuDeleteRequest {
    /// 条目唯一 ID
    pub id: String,
    /// 注册表根（"HKCU" | "HKLM"）
    pub reg_root: String,
    /// 相对于根的子路径
    pub reg_subpath: String,
}

/// 右键菜单删除结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuDeleteResult {
    /// 成功删除的条目数
    pub deleted_count: usize,
    /// 删除失败的条目数
    pub failed_count: usize,
    /// 每个条目的详细结果
    pub details: Vec<ContextMenuDeleteDetail>,
}

/// 单个条目的删除详情
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuDeleteDetail {
    /// 条目 ID
    pub id: String,
    /// 是否成功
    pub success: bool,
    /// 失败原因（成功时为 None）
    pub error: Option<String>,
}

// ============================================================================
// 系统白名单
// 以下条目属于系统或常见硬件驱动，绝不扫描或删除
// ============================================================================

/// shell 子键名白名单（全小写匹配）
/// 这些条目即使对应 exe 不存在，也不会被标记为无效
const SHELL_KEY_WHITELIST: &[&str] = &[
    // Windows 系统内置
    "open",
    "opennewprocess",
    "opennewwindow",
    "explore",
    "find",
    "runas",
    "runasuser",
    "print",
    "printto",
    "edit",
    "properties",
    "pin to start",
    "pin to taskbar",
    // 右键打开方式
    "openas",
    "opencontainingfolder",
    "previewnow",
    "share",
    "cast to device",
    "giveto",
    "sendto",
    "cut",
    "copy",
    "paste",
    "rename",
    "delete",
    // 常见合法软件（保守策略）
    "git",
    "cmd",
    "powershell",
    "bash",
    "wsl",
    "7-zip",
    "winrar",
    "winzip",
    "notepad",
    "notepad++",
    "vscode",
    "code",
    "sublime",
    "vim",
    "nvim",
    "emacs",
    "atom",
];

// ============================================================================
// 右键菜单扫描器
// ============================================================================

/// 右键菜单扫描器
pub struct ContextMenuScanner;

impl ContextMenuScanner {
    /// 创建新扫描器实例
    pub fn new() -> Self {
        ContextMenuScanner
    }

    /// 执行完整扫描，返回所有找到的右键菜单条目
    pub fn scan(&self) -> Result<ContextMenuScanResult, String> {
        let start = std::time::Instant::now();
        let mut entries: Vec<ContextMenuEntry> = Vec::new();

        // 扫描 HKEY_LOCAL_MACHINE（需要管理员才能删除）
        self.scan_hive(
            RegKey::predef(HKEY_LOCAL_MACHINE),
            "HKLM",
            r"SOFTWARE\Classes",
            true,
            &mut entries,
        );

        // 扫描 HKEY_CURRENT_USER（当前用户级别，无需管理员）
        self.scan_hive(
            RegKey::predef(HKEY_CURRENT_USER),
            "HKCU",
            r"Software\Classes",
            false,
            &mut entries,
        );

        // 对相同显示名称去重：优先保留 HKCU 条目（用户级优先）
        entries = Self::deduplicate(entries);

        // 按状态排序：无效条目（exe 不存在）排在前面
        entries.sort_by(|a, b| {
            b.exe_exists.cmp(&a.exe_exists).then_with(|| {
                a.display_name
                    .to_lowercase()
                    .cmp(&b.display_name.to_lowercase())
            })
        });

        let invalid_count = entries.iter().filter(|e| !e.exe_exists).count();
        let scan_duration_ms = start.elapsed().as_millis() as u64;

        log::info!(
            "右键菜单扫描完成: {} 条目（其中 {} 个无效），耗时 {}ms",
            entries.len(),
            invalid_count,
            scan_duration_ms
        );

        Ok(ContextMenuScanResult {
            entries,
            invalid_count,
            scan_duration_ms,
        })
    }

    /// 扫描指定注册表 Hive 下的所有右键菜单路径
    fn scan_hive(
        &self,
        hive: RegKey,
        hive_name: &str,
        classes_path: &str,
        needs_admin: bool,
        entries: &mut Vec<ContextMenuEntry>,
    ) {
        // 定义要扫描的 (scope_display, relative_path_from_classes)
        let scan_targets: &[(&str, &str)] = &[
            ("任意文件", r"*\shell"),
            ("文件夹", r"Directory\shell"),
            ("桌面背景", r"Directory\Background\shell"),
            ("磁盘驱动器", r"Drive\shell"),
            ("库文件夹", r"LibraryFolder\Background\shell"),
            (
                "任意文件(ContextMenuHandlers)",
                r"*\shellex\ContextMenuHandlers",
            ),
        ];

        for (scope, rel_path) in scan_targets {
            let full_rel = format!(r"{}\{}", classes_path, rel_path);

            match hive.open_subkey_with_flags(&full_rel, KEY_READ) {
                Ok(shell_key) => {
                    self.scan_shell_key(
                        &shell_key,
                        hive_name,
                        &format!("{}\\{}", hive_name, full_rel),
                        &format!(r"{}", full_rel),
                        scope,
                        needs_admin,
                        entries,
                    );
                }
                Err(_) => {
                    // 该路径不存在，静默跳过
                }
            }
        }
    }

    /// 扫描单个 shell 键下的所有子键（每个子键对应一个菜单项）
    fn scan_shell_key(
        &self,
        shell_key: &RegKey,
        hive_name: &str,
        display_prefix: &str,
        subpath_prefix: &str,
        scope: &str,
        needs_admin: bool,
        entries: &mut Vec<ContextMenuEntry>,
    ) {
        for subkey_name in shell_key.enum_keys().filter_map(|k| k.ok()) {
            // 跳过白名单条目（精确匹配，不区分大小写）
            if SHELL_KEY_WHITELIST
                .iter()
                .any(|w| subkey_name.eq_ignore_ascii_case(w))
            {
                continue;
            }

            let subkey_path = format!(r"{}\{}", subpath_prefix, subkey_name);
            let display_path = format!(r"{}\{}", display_prefix, subkey_name);

            match shell_key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                Ok(entry_key) => {
                    if let Some(entry) = self.build_entry(
                        &entry_key,
                        &subkey_name,
                        &display_path,
                        hive_name,
                        &subkey_path,
                        scope,
                        needs_admin,
                    ) {
                        entries.push(entry);
                    }
                }
                Err(_) => continue,
            }
        }
    }

    /// 从注册表键构建 ContextMenuEntry
    fn build_entry(
        &self,
        entry_key: &RegKey,
        key_name: &str,
        registry_path: &str,
        reg_root: &str,
        reg_subpath: &str,
        scope: &str,
        needs_admin: bool,
    ) -> Option<ContextMenuEntry> {
        // 读取菜单显示名称（优先 MUIVerb，其次 (Default)，最后用键名）
        let display_name_raw: String = entry_key
            .get_value::<String, _>("MUIVerb")
            .or_else(|_| entry_key.get_value::<String, _>(""))
            .unwrap_or_else(|_| key_name.to_string());

        // 过滤掉名称为空或纯空白的条目
        let display_name_raw = display_name_raw.trim().to_string();
        if display_name_raw.is_empty() && key_name.trim().is_empty() {
            return None;
        }
        let display_name_raw = if display_name_raw.is_empty() {
            key_name.to_string()
        } else {
            display_name_raw
        };

        // 解析 MUIVerb 间接字符串（@path,-id → 人类可读文字）
        let display_name = resolve_indirect_string(&display_name_raw);

        // 读取图标路径
        let icon_path: Option<String> = entry_key.get_value::<String, _>("Icon").ok();

        // 读取命令字符串（来自 command 子键的默认值）
        let command: Option<String> = entry_key
            .open_subkey_with_flags("command", KEY_READ)
            .ok()
            .and_then(|cmd_key| cmd_key.get_value::<String, _>("").ok());

        // 从命令字符串中提取 exe 路径
        let exe_path: Option<String> = command
            .as_deref()
            .and_then(|cmd| Self::extract_exe_path(cmd));

        // 检查 exe 是否存在
        let exe_exists = exe_path
            .as_deref()
            .map(|p| Path::new(p).exists())
            .unwrap_or_else(|| {
                // 无 exe 路径时：ContextMenuHandlers 等 COM 类条目视为"存在"（不可判定）
                // 但优先标记为需要谨慎（因为没有可验证的 exe）
                command.is_none() || command.as_deref().is_some_and(|c| c.trim().is_empty())
            });

        // 系统保护判定：shellex\ContextMenuHandlers 路径下的 COM 处理器
        let is_system_protected = reg_subpath.contains(r"shellex\ContextMenuHandlers");

        // 风险分级
        let risk_level = if is_system_protected {
            "danger".to_string()
        } else if needs_admin {
            "caution".to_string()
        } else {
            "safe".to_string()
        };

        let id = format!("{}||{}", reg_root, reg_subpath);

        Some(ContextMenuEntry {
            id,
            display_name,
            key_name: key_name.to_string(),
            registry_path: registry_path.to_string(),
            reg_root: reg_root.to_string(),
            reg_subpath: reg_subpath.to_string(),
            scope: scope.to_string(),
            icon_path,
            command,
            exe_path,
            exe_exists,
            needs_admin,
            is_system_protected,
            risk_level,
        })
    }

    /// 从命令字符串中提取可执行文件路径
    ///
    /// 处理以下常见格式：
    /// - `"C:\Program Files\App\app.exe" "%1"`
    /// - `C:\Windows\system32\notepad.exe %1`
    /// - `rundll32.exe shell32.dll,OpenAs_RunDLL %1`
    /// - `%SystemRoot%\system32\cmd.exe /c ...`
    fn extract_exe_path(cmd: &str) -> Option<String> {
        let cmd = cmd.trim();
        if cmd.is_empty() {
            return None;
        }

        // 对于以 % 开头的命令，先展开环境变量再检查
        if cmd.starts_with('%') {
            let expanded = expand_env_vars(cmd);
            // 展开后如果变成绝对路径，按不带引号路径处理
            if expanded.len() >= 3
                && expanded.chars().nth(1) == Some(':')
                && (expanded.chars().nth(2) == Some('\\') || expanded.chars().nth(2) == Some('/'))
            {
                let first_token = expanded.split_whitespace().next().unwrap_or(&expanded);
                return Some(first_token.to_string());
            }
            // 展开后仍无法识别，放弃（可能是系统内部命令）
            return None;
        }

        // 处理带引号的路径：`"C:\path\to\app.exe" ...`
        if cmd.starts_with('"') {
            if let Some(end_quote) = cmd[1..].find('"') {
                let path = &cmd[1..=end_quote];
                if !path.is_empty() {
                    return Some(expand_env_vars(path));
                }
            }
        }

        // 处理不带引号的路径：取第一个空格之前的部分
        let first_token = cmd.split_whitespace().next().unwrap_or(cmd);

        // 过滤掉 rundll32、msiexec 等系统委托执行器（本身存在但代理了别的程序）
        let token_lower = first_token.to_lowercase();
        if token_lower.contains("rundll32")
            || token_lower.contains("msiexec")
            || token_lower.contains("regsvr32")
            || token_lower.contains("wscript")
            || token_lower.contains("cscript")
        {
            return None;
        }

        // 只处理看起来像绝对路径的情况（含盘符或 UNC）
        if first_token.len() >= 3
            && first_token.chars().nth(1) == Some(':')
            && (first_token.chars().nth(2) == Some('\\') || first_token.chars().nth(2) == Some('/'))
        {
            return Some(expand_env_vars(first_token));
        }

        None
    }

    /// 对条目去重：HKCU 和 HKLM 中相同键名的条目只保留 HKCU 版本
    fn deduplicate(entries: Vec<ContextMenuEntry>) -> Vec<ContextMenuEntry> {
        let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut result: Vec<ContextMenuEntry> = Vec::new();

        // 先收集所有 HKCU 条目的 (scope + key_name) 组合
        let hkcu_keys: std::collections::HashSet<String> = entries
            .iter()
            .filter(|e| e.reg_root == "HKCU")
            .map(|e| format!("{}|{}", e.scope, e.key_name.to_lowercase()))
            .collect();

        for entry in entries {
            let dedup_key = format!("{}|{}", entry.scope, entry.key_name.to_lowercase());

            // 若 HKCU 已有同名条目，跳过 HKLM 版本（HKCU 优先级更高）
            if entry.reg_root == "HKLM" && hkcu_keys.contains(&dedup_key) {
                continue;
            }

            if seen_keys.insert(dedup_key) {
                result.push(entry);
            }
        }

        result
    }
}

// ============================================================================
// 右键菜单删除器
// ============================================================================

/// 执行右键菜单条目的删除操作
pub fn delete_context_menu_entries(
    requests: &[ContextMenuDeleteRequest],
) -> ContextMenuDeleteResult {
    let mut details: Vec<ContextMenuDeleteDetail> = Vec::new();
    let mut deleted_count: usize = 0;
    let mut failed_count: usize = 0;

    for req in requests {
        let result = delete_single_entry(req);
        let success = result.is_ok();

        if success {
            deleted_count += 1;
            log::info!("已删除右键菜单条目: {}\\{}", req.reg_root, req.reg_subpath);
        } else {
            failed_count += 1;
            let err_msg = result.err().unwrap_or_else(|| "未知错误".to_string());
            log::warn!(
                "删除右键菜单条目失败: {}\\{} - {}",
                req.reg_root,
                req.reg_subpath,
                err_msg
            );
            details.push(ContextMenuDeleteDetail {
                id: req.id.clone(),
                success: false,
                error: Some(err_msg),
            });
            continue;
        }

        details.push(ContextMenuDeleteDetail {
            id: req.id.clone(),
            success: true,
            error: None,
        });
    }

    ContextMenuDeleteResult {
        deleted_count,
        failed_count,
        details,
    }
}

/// 删除单个注册表条目（递归删除整个 shell 子键）
/// 删除前自动导出 .reg 备份文件至数据目录
fn delete_single_entry(req: &ContextMenuDeleteRequest) -> Result<(), String> {
    // 安全阀：拒绝删除系统保护的条目（shellex\ContextMenuHandlers）
    if req.reg_subpath.contains(r"shellex\ContextMenuHandlers") {
        return Err("系统保护的条目，不允许删除（ContextMenuHandlers）".to_string());
    }

    // 根据 reg_root 选择根 hive
    let hive = match req.reg_root.as_str() {
        "HKCU" => RegKey::predef(HKEY_CURRENT_USER),
        "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
        other => return Err(format!("不支持的注册表根: {}", other)),
    };

    // reg_subpath 是形如 "SOFTWARE\Classes\*\shell\MyApp" 的完整子路径
    // 需要拆分为父路径和最后一级键名
    let subpath = req.reg_subpath.as_str();
    let (parent_path, key_name) = match subpath.rfind('\\') {
        Some(pos) => (&subpath[..pos], &subpath[pos + 1..]),
        None => {
            return Err(format!("无效的子路径格式（缺少父路径）: {}", subpath));
        }
    };

    // 删除前导出 .reg 备份
    export_reg_backup(req.reg_root.as_str(), subpath);

    // 打开父键（需要写权限）
    let parent_key = hive
        .open_subkey_with_flags(parent_path, KEY_READ | KEY_WRITE)
        .map_err(|e| format!("无法打开父键 {}: {}", parent_path, e))?;

    // 递归删除该子键及其所有子内容
    parent_key
        .delete_subkey_all(key_name)
        .map_err(|e| format!("删除键 {} 失败: {}", key_name, e))?;

    Ok(())
}

/// 导出注册表键的 .reg 备份（用于误删恢复）
/// 使用 reg.exe export 命令，备份文件存放在数据目录的 reg_backups/ 下
fn export_reg_backup(reg_root: &str, subpath: &str) {
    let data_dir = crate::data_dir::get_data_dir();
    let backup_dir = data_dir.join("reg_backups");
    if let Err(e) = std::fs::create_dir_all(&backup_dir) {
        log::warn!("无法创建注册表备份目录: {}", e);
        return;
    }

    // 生成唯一文件名：reg_root_subpath_时间戳.reg
    let safe_name = format!(
        "{}_{}",
        reg_root,
        subpath.replace('\\', "_").replace('*', "all")
    );
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let file_name = format!("{}_{}.reg", safe_name, timestamp);
    let backup_path = backup_dir.join(&file_name);

    // 调用 reg.exe export 导出
    match std::process::Command::new("reg.exe")
        .args(["export", &format!("{}\\{}", reg_root, subpath)])
        .arg(&backup_path)
        .arg("/y") // 覆盖已有文件
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                log::info!("已导出注册表备份: {}", backup_path.display());
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::warn!("注册表备份导出失败: {}", stderr);
            }
        }
        Err(e) => {
            log::warn!("执行 reg.exe export 失败: {}", e);
        }
    }
}
