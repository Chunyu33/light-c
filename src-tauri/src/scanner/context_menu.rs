// ============================================================================
// 右键菜单扫描模块
// 扫描 Windows 注册表中注册的右键菜单项，识别指向不存在可执行文件的无效条目
// ============================================================================
//
// 【扫描路径】
// 以下路径同时覆盖 HKEY_LOCAL_MACHINE 和 HKEY_CURRENT_USER 两棵树，
// 每个位置都有 `shell\<键名>`（传统写法）和 `shellex\ContextMenuHandlers\<键名>`（COM 处理器）两种：
//
//   *\shell                        — 右键点任意文件
//   Directory\shell                — 右键点文件夹图标
//   Directory\Background\shell     — 右键点**文件夹窗口里的空白处**（桌面壁纸那一处是
//                                    DesktopBackground 类，不是这里）
//   Drive\shell                    — 右键点磁盘驱动器
//   LibraryFolder\Background\shell — 右键点"库"里的空白
//   Folder\shellex\...             — 文件夹类 COM 处理器
//   AllFilesystemObjects\shellex\… — 文件和文件夹通用的 COM 处理器
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
// - 删除前需用户明确确认，每条删之前单独导出 .reg 备份
// - 只有"路径能提出来、文件确实不在"的条目标为失效并默认勾选；
//   COM 处理器（shellex\ContextMenuHandlers）一律只读展示，前端禁选、后端再拦一道
// - HKLM 条目标记为需要管理员权限，前端会给出提权提示
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

/// 展开命令里的 `%NAME%` 环境变量。
///
/// 不用固定名单：右键命令里常见的不止 `%SystemRoot%`，用户级安装的软件写的是
/// `%LOCALAPPDATA%\Programs\...`，一律按系统实际值展开。变量不存在时原样保留，
/// 这样界面还能看出命令原本长什么样，调用方也会因为解不出绝对路径而判 Unknown。
fn expand_env_vars(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    let mut rest = path;

    while let Some(start) = rest.find('%') {
        result.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            // 找到配对的 %：看看中间是不是个真实存在的变量名
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) => result.push_str(&value),
                    Err(_) => {
                        result.push('%');
                        result.push_str(name);
                        result.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            // 落单的 %：按普通字符处理，别把后面的内容吞掉
            _ => {
                result.push('%');
                rest = after;
            }
        }
    }
    result.push_str(rest);
    result
}

/// 排序权重：失效的最前面；正常项其次（列表一打开就是"没什么问题"的样子）；
/// 判定不了的垫底 —— 它们既不需要处理也不该占住第一屏。
fn status_rank(status: ExeStatus) -> u8 {
    match status {
        ExeStatus::Missing => 0,
        ExeStatus::Ok => 1,
        ExeStatus::Unknown => 2,
    }
}

/// 目标程序三态判定。
///
/// 只有"提到了路径、文件却不在"才算失效。提不出路径（COM 处理器、级联菜单、
/// 委托执行器）一律 Unknown —— 不参与无效统计、不默认勾选。
fn classify_exe_status(exe_path: Option<&str>) -> ExeStatus {
    match exe_path {
        Some(path) if Path::new(path).exists() => ExeStatus::Ok,
        Some(_) => ExeStatus::Missing,
        None => ExeStatus::Unknown,
    }
}

/// 是否形如 `{90AA3A4E-1CBA-4233-B8BB-535773D48449}` 的 CLSID
fn looks_like_clsid(value: &str) -> bool {
    let value = value.trim();
    value.len() == 38 && value.starts_with('{') && value.ends_with('}')
}

/// 解析 `shellex\ContextMenuHandlers\<键名>` 这个 COM 处理器实际加载的 DLL。
///
/// 注册表里两种写法都要认：
/// 1. 键名本身就是 CLSID（`{90AA3A4E-...}`）；
/// 2. 键名是友好名（`TortoiseSVN`），`(Default)` 值才是 CLSID。
///
/// 拿到 CLSID 再去 `Classes\CLSID\<guid>\InprocServer32` 取 DLL 路径。
/// 先查 HKCU 再查 HKLM —— 与 Windows 的覆盖顺序一致。
/// 解析不出来返回 `None`，调用方据此判 `Unknown`（不是"失效"）。
fn resolve_handler_dll(entry_key: &RegKey, key_name: &str) -> Option<String> {
    let clsid = if looks_like_clsid(key_name) {
        key_name.trim().to_string()
    } else {
        let raw = entry_key.get_value::<String, _>("").ok()?;
        if !looks_like_clsid(&raw) {
            return None;
        }
        raw.trim().to_string()
    };

    let hives = [
        (RegKey::predef(HKEY_CURRENT_USER), r"Software\Classes\CLSID"),
        (RegKey::predef(HKEY_LOCAL_MACHINE), r"SOFTWARE\Classes\CLSID"),
    ];
    for (hive, prefix) in hives {
        let path = format!(r"{}\{}\InprocServer32", prefix, clsid);
        let Ok(key) = hive.open_subkey_with_flags(&path, KEY_READ) else {
            continue;
        };
        let Ok(dll) = key.get_value::<String, _>("") else {
            continue;
        };
        // DLL 路径常写成 REG_EXPAND_SZ（`%SystemRoot%\system32\foo.dll`）
        let expanded = expand_env_vars(dll.trim());
        if expanded.is_empty() {
            continue;
        }
        // 托管扩展的 InprocServer32 只写裸文件名（`mscoree.dll`）。
        // 拿裸名去 exists() 是按当前工作目录找，必然 false —— 会在界面上变成
        // "文件不存在"的误报，而且这类条目是可删的，等于给用户一把误删的刀。
        if let Some(resolved) = resolve_bare_module(&expanded) {
            return Some(resolved);
        }
        // 这一层解析不出来就继续看下一层（HKCU 里写坏了不代表 HKLM 那份也不行）
    }
    None
}

/// 把裸文件名（`mscoree.dll`）补全成真实路径。
///
/// 依次查 System32 / SysWOW64 / 系统根 / `PATH`；都没有就返回 `None`，
/// 让调用方判 `Unknown` 而不是"文件已不存在"。
fn resolve_bare_module(name: &str) -> Option<String> {
    if name.contains('\\') || name.contains('/') {
        return Some(name.to_string());
    }

    let system_root =
        std::env::var("SystemRoot").unwrap_or_else(|_| String::from(r"C:\Windows"));
    let root = Path::new(&system_root);
    let system_dirs = [
        root.join("System32").join(name),
        root.join("SysWOW64").join(name),
        root.join(name),
    ];
    if let Some(found) = system_dirs.into_iter().find(|candidate| candidate.exists()) {
        return Some(found.to_string_lossy().to_string());
    }

    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

/// 取命令行里的第一个 token（按空白切分）
fn first_token(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or(command)
}

/// 是否够格当 exe 路径（只认 `.exe` 结尾，避免把目录当成程序）
fn is_exe_path(candidate: &str) -> bool {
    candidate.len() > 4 && candidate.to_ascii_lowercase().ends_with(".exe")
}

/// 是否绝对路径（盘符开头或 UNC `\\server\share`）
fn is_absolute_path(token: &str) -> bool {
    let mut chars = token.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(letter), Some(':'), Some('\\' | '/')) => letter.is_ascii_alphabetic(),
        _ => token.starts_with(r"\\"),
    }
}

/// 是否是"委托执行器"：命令本身不是真正的目标，真目标在参数里
fn is_delegate_executor(token: &str) -> bool {
    let lower = token.to_lowercase();
    ["rundll32", "msiexec", "regsvr32", "wscript", "cscript"]
        .iter()
        .any(|name| lower.contains(name))
}

/// 在"路径带空格又没加引号"的命令里，按空白逐段拼回真正的 exe。
///
/// 只看"以 .exe 结尾且文件真实存在"的候选，找不到就返回 None 交回调用方 ——
/// 不猜、不拼，猜错就是一次误报级的误删。
fn find_existing_exe_prefix(command: &str) -> Option<String> {
    let mut candidate = String::new();
    for part in command.split_whitespace() {
        if !candidate.is_empty() {
            candidate.push(' ');
        }
        candidate.push_str(part);
        if is_exe_path(&candidate) && Path::new(&candidate).exists() {
            return Some(candidate);
        }
    }
    None
}

/// 命令里的裸 exe 名（`cmd.exe`、`explorer.exe`）解析成真实路径。
///
/// 只接受 `.exe` 结尾、且不带路径分隔符的写法，再交给 `resolve_bare_module`。
/// 找不到返回 `None`（Unknown）—— **绝不返回拼出来的路径**，靠 PATH 解析的
/// 第三方命令会被误判成"文件已不存在"。
fn resolve_system_executable(token: &str) -> Option<String> {
    if !is_exe_path(token) || token.contains('\\') || token.contains('/') {
        return None;
    }
    resolve_bare_module(token)
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

/// 目标程序（exe）的存在性判定结果。
///
/// 刻意分成三态而不是一个 `bool`：从命令里提不出路径和"路径存在但文件没了"是两件事。
/// 前者（`rundll32 shell32.dll,...`、`explorer.exe`、走了未知环境变量的写法）目标其实
/// 藏在参数里或另一个位置，判成"失效"会让用户把正常菜单一起删掉。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExeStatus {
    /// 提到了路径，文件也在
    Ok,
    /// 提到了路径，但文件已经不在磁盘上 —— 只有这一种算"无效条目"
    Missing,
    /// 提不出可判定的路径，无从判断
    Unknown,
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
    /// 右键菜单的作用范围，稳定英文 id：
    /// `file`（任意文件）/ `folder`（文件夹）/ `background`（文件夹窗口空白处）/
    /// `drive`（磁盘驱动器）/ `library`（库文件夹）。界面文案由前端翻译。
    pub scope: String,
    /// 图标路径（原始值，可能含 index 后缀如 "C:\foo.exe,0"）
    pub icon_path: Option<String>,
    /// 原始命令字符串（来自 command 子键）
    pub command: Option<String>,
    /// 从命令中提取的可执行文件路径（去掉参数后的纯路径）
    pub exe_path: Option<String>,
    /// 目标程序是否还在磁盘（三态，见 `ExeStatus`）
    pub exe_status: ExeStatus,
    /// 删除此条目是否需要管理员权限（HKLM 条目需要）
    pub needs_admin: bool,
    /// 是否为系统保护条目（不可选中删除）。
    ///
    /// COM 处理器默认只读；处理器 DLL 已经不在了的不算保护 —— 那是残留，可以清。
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
// 关于白名单
//
// 这里曾经有一份"跳过 VSCode / 7-Zip / WinRAR / cmd ……"的键名白名单。
// 它把"已知的正常软件"整条跳过，代价是**卸载残留反过来扫不到**——软件卸掉后
// 注册项还留在这些键名下，而那正是这个模块最该抓的东西（`HKCU\...\*\shell\VSCode`
// 在本机实测就被整条吞掉）。
//
// 现在不按键名预判，全部交给目标程序是否存在来说话：文件在就是正常条目（默认
// 不勾选），文件没了就是残留。系统内置动词（open / print / properties 等）本来
// 就不在这些 `shell` 子键下，不需要名单挡。
// ============================================================================

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

        // 排序：失效的最前面，无法判定的居中，正常的垫底；同组内按显示名排
        entries.sort_by(|a, b| {
            status_rank(a.exe_status)
                .cmp(&status_rank(b.exe_status))
                .then_with(|| {
                    a.display_name
                        .to_lowercase()
                        .cmp(&b.display_name.to_lowercase())
                })
        });

        let invalid_count = entries
            .iter()
            .filter(|entry| entry.exe_status == ExeStatus::Missing)
            .count();
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
        // 定义要扫描的 (scope_id, relative_path_from_classes)
        //
        // scope 只放**稳定的英文 id**，界面文案由前端按语言渲染。
        // 这里曾经写的是中文（"任意文件" / "桌面背景"），结果是双份 bug：
        //   · 非中文界面原样漏出中文标签；
        //   · 同一个 id 在两处写死，改一个漏一个。
        //
        // 两种注册方式都要扫：
        //   * `...\shell\<键名>`            — 传统写法，命令写在 command 子键里
        //   * `...\shellex\ContextMenuHandlers\<键名>` — COM 处理器，命令是 CLSID 指向的 DLL
        // 后者是卸载残留最常见的藏身处（软件删了、CLSID 注册还在）。
        let scan_targets: &[(&str, &str)] = &[
            ("file", r"*\shell"),
            ("folder", r"Directory\shell"),
            // Directory\Background 是**文件夹窗口里的空白处**，不是桌面壁纸那一处
            // （那是 DesktopBackground 类）。旧标签叫"桌面背景"是起错了
            ("background", r"Directory\Background\shell"),
            ("drive", r"Drive\shell"),
            ("library", r"LibraryFolder\Background\shell"),
            // COM 处理器：scope 沿用"右键点在哪"，不单独造一个 scope
            ("file", r"*\shellex\ContextMenuHandlers"),
            ("folder", r"Directory\shellex\ContextMenuHandlers"),
            (
                "background",
                r"Directory\Background\shellex\ContextMenuHandlers",
            ),
            ("folder", r"Folder\shellex\ContextMenuHandlers"),
            ("drive", r"Drive\shellex\ContextMenuHandlers"),
            ("file", r"AllFilesystemObjects\shellex\ContextMenuHandlers"),
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

        // COM 处理器不是靠 command 子键驱动的，命令是 CLSID 指向的 DLL。
        // 不解析它，这一整类条目就永远是"无法判定"，补再多扫描位置也没用。
        let is_com_handler = reg_subpath
            .to_lowercase()
            .contains(r"shellex\contextmenuhandlers");

        // 读取命令字符串（来自 command 子键的默认值）
        let command: Option<String> = entry_key
            .open_subkey_with_flags("command", KEY_READ)
            .ok()
            .and_then(|cmd_key| cmd_key.get_value::<String, _>("").ok());

        // 从命令字符串中提取 exe 路径；COM 处理器改从 CLSID 解析出处理器 DLL
        let exe_path: Option<String> = if is_com_handler {
            resolve_handler_dll(entry_key, key_name)
        } else {
            command
                .as_deref()
                .and_then(|cmd| Self::extract_exe_path(cmd))
        };

        // 目标程序三态判定：只有"提到了路径、文件却不在"才算无效。
        // 提不出路径（级联菜单、委托执行器、解析不了的 CLSID）一律 Unknown，
        // 不参与无效统计、不默认勾选 —— 宁可漏报也不给用户一个误删的机会。
        let exe_status = classify_exe_status(exe_path.as_deref());

        // 系统保护判定：COM 处理器默认只读，但**处理器 DLL 已经不在了**的不算 ——
        // 那正是卸载残留，留着只会让资源管理器每次右键都去找一个不存在的 DLL。
        let is_system_protected = is_com_handler && exe_status != ExeStatus::Missing;

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
            exe_status,
            needs_admin,
            is_system_protected,
            risk_level,
        })
    }

    /// 从命令字符串中提取可执行文件路径
    ///
    /// 处理以下常见格式：
    /// - `"C:\Program Files\App\app.exe" "%1"`（常规写法）
    /// - `C:\Program Files\App\app.exe %1`（路径带空格却没加引号，老安装器常见）
    /// - `%SystemRoot%\system32\cmd.exe /c ...`、`%LOCALAPPDATA%\Programs\App\App.exe`
    /// - `cmd.exe /c ...`（只有裸文件名，靠系统目录解析）
    ///
    /// 返回 `None` 表示**无法判定**，调用方据此给 `ExeStatus::Unknown`。
    /// 不要把 `None` 当成"文件不存在" —— 那会制造一整类误报。
    fn extract_exe_path(cmd: &str) -> Option<String> {
        let raw = cmd.trim();
        if raw.is_empty() {
            return None;
        }

        // 环境变量先展开：用户级安装的软件（Chrome / VSCode / 各类 Electron 应用）
        // 写的多是 %LOCALAPPDATA%，只认 %SystemRoot% 那六个变量会整类漏掉
        let expanded = expand_env_vars(raw);

        // 委托执行器（rundll32 / msiexec / regsvr32 / wscript / cscript）本身一定存在，
        // 真正被调起来的东西在参数里（.dll / .msi / .vbs），单看 exe 判不出有效性
        if is_delegate_executor(first_token(&expanded)) {
            return None;
        }

        // 带引号：取第一对引号里的内容
        if let Some(rest) = expanded.strip_prefix('"') {
            if let Some(end) = rest.find('"') {
                let path = rest[..end].trim();
                if !path.is_empty() {
                    return Some(path.to_string());
                }
            }
            // 只有开引号（注册表写坏了），退回去按裸路径处理
        }

        // 不带引号但路径里有空格：取最早一个"以 .exe 结尾且文件真实存在"的前缀。
        // 按空白切第一段会切出 `C:\Program`，那是误报的主要来源之一
        if let Some(found) = find_existing_exe_prefix(&expanded) {
            return Some(found);
        }

        let token = first_token(&expanded);
        if is_absolute_path(token) {
            return Some(token.to_string());
        }

        // 裸文件名：只在系统目录里确实存在时才算数
        resolve_system_executable(token)
    }

    /// 对条目去重：同一条注册表路径在 HKCU / HKLM 各有一份时只保留一条。
    ///
    /// 去重键用**去掉 hive 的完整子路径**，不再用 `(scope, key_name)`：
    /// 现在同一个 scope 下有 `shell` 和 `shellex\ContextMenuHandlers` 两种父路径，
    /// 按名字去重会把不同位置的两条误判成同一条。
    ///
    /// 保留谁：失效的那条优先。HKCU 有一条能用的、HKLM 有一条同名的残留时，
    /// 只留 HKCU 会让那条残留永远显示不出来 —— 而它才是这个模块要找的东西。
    fn deduplicate(entries: Vec<ContextMenuEntry>) -> Vec<ContextMenuEntry> {
        use std::collections::HashMap;

        let mut best: HashMap<String, ContextMenuEntry> = HashMap::new();
        // 单独记顺序：HashMap 无序，直接遍历会让列表顺序每次扫描都不一样
        let mut order: Vec<String> = Vec::new();

        for entry in entries {
            let key = entry.reg_subpath.to_lowercase();
            match best.get(&key) {
                None => {
                    order.push(key.clone());
                    best.insert(key, entry);
                }
                Some(existing) => {
                    let replace = match (existing.exe_status, entry.exe_status) {
                        // 已经留下的是失效项，不换
                        (ExeStatus::Missing, _) => false,
                        // 新来的是失效项，换掉那条"看起来正常"的
                        (_, ExeStatus::Missing) => true,
                        // 都不是失效项：沿用 HKCU 覆盖 HKLM 的规则
                        _ => existing.reg_root == "HKLM" && entry.reg_root == "HKCU",
                    };
                    if replace {
                        best.insert(key, entry);
                    }
                }
            }
        }

        order
            .into_iter()
            .filter_map(|key| best.remove(&key))
            .collect()
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

    // 删完通知外壳刷新。不做这一步，用户回到桌面右键会发现菜单还在 ——
    // 资源管理器缓存了菜单，要注销或重启才看得到变化，看起来像"删了没生效"。
    // 只发变更通知，不结束 explorer.exe（那会连带任务栏扩展一起重启）。
    if deleted_count > 0 {
        if let Err(error) = crate::scanner::shell_icons::restart_explorer() {
            log::warn!("通知外壳刷新失败: {}", error);
        }
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
    let subpath = req.reg_subpath.as_str();
    let lower_subpath = subpath.to_lowercase();

    // 安全阀一：路径必须落在允许清理的右键菜单位置内。
    // 前端只回传 id/root/subpath 三个字段，这条命令本身对调用方完全开放 ——
    // 不校验的话，一次错误调用就能删掉注册表里任意一个键。
    if !is_deletable_subpath(&lower_subpath) {
        return Err(format!(
            "不在允许清理的右键菜单位置内，已拒绝删除: {}",
            subpath
        ));
    }

    // 根据 reg_root 选择根 hive
    let hive = match req.reg_root.as_str() {
        "HKCU" => RegKey::predef(HKEY_CURRENT_USER),
        "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
        other => return Err(format!("不支持的注册表根: {}", other)),
    };

    // reg_subpath 是形如 "SOFTWARE\Classes\*\shell\MyApp" 的完整子路径
    // 需要拆分为父路径和最后一级键名
    let (parent_path, key_name) = match subpath.rfind('\\') {
        Some(pos) => (&subpath[..pos], &subpath[pos + 1..]),
        None => {
            return Err(format!("无效的子路径格式（缺少父路径）: {}", subpath));
        }
    };

    // 安全阀二：COM 处理器只放行"处理器 DLL 已经不在了"的那些。
    // 这一步必须重新解析一次，不能信扫描结果 —— 扫描到删除之间用户可能重装过软件，
    // 也可能有人绕过界面直接调命令。判不准就不删。
    if lower_subpath.contains(r"shellex\contextmenuhandlers") {
        let entry_key = hive
            .open_subkey_with_flags(subpath, KEY_READ)
            .map_err(|error| format!("无法读取条目 {}: {}", subpath, error))?;
        match resolve_handler_dll(&entry_key, key_name) {
            Some(dll) if !Path::new(&dll).exists() => { /* DLL 已经不在了，属于残留，放行 */ }
            Some(dll) => {
                return Err(format!("处理器程序仍然存在（{}），不允许删除", dll));
            }
            None => {
                return Err("无法确认处理器程序是否还存在，已拒绝删除".to_string());
            }
        }
    }

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

/// 允许删除的父路径（不含 hive，统一小写）。必须命中其中之一，且后面只跟一个键名。
///
/// 与扫描位置一一对应。改了 `scan_targets` 就要同步这里，否则新位置扫得到、删不掉。
const DELETABLE_PARENTS: &[&str] = &[
    r"software\classes\*\shell\",
    r"software\classes\directory\shell\",
    r"software\classes\directory\background\shell\",
    r"software\classes\drive\shell\",
    r"software\classes\libraryfolder\background\shell\",
    r"software\classes\*\shellex\contextmenuhandlers\",
    r"software\classes\directory\shellex\contextmenuhandlers\",
    r"software\classes\directory\background\shellex\contextmenuhandlers\",
    r"software\classes\folder\shellex\contextmenuhandlers\",
    r"software\classes\drive\shellex\contextmenuhandlers\",
    r"software\classes\allfilesystemobjects\shellex\contextmenuhandlers\",
];

/// 子路径是否落在允许清理的位置内（入参需已小写）
fn is_deletable_subpath(lower_subpath: &str) -> bool {
    DELETABLE_PARENTS.iter().any(|parent| {
        lower_subpath
            .strip_prefix(parent)
            .is_some_and(|name| !name.is_empty() && !name.contains('\\'))
    })
}

/// 右键菜单条目的 `.reg` 备份目录。
///
/// 与注册表冗余模块的 `RegistryBackups` 不是同一个目录 —— 两边文件名格式也不同，
/// 混在一起用户分不清哪份是哪个模块导出的。
pub fn context_menu_backup_dir() -> std::path::PathBuf {
    crate::data_dir::get_data_dir().join("reg_backups")
}

/// 导出注册表键的 .reg 备份（用于误删恢复）
/// 使用 reg.exe export 命令，备份文件存放在数据目录的 reg_backups/ 下
fn export_reg_backup(reg_root: &str, subpath: &str) {
    let backup_dir = context_menu_backup_dir();
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

// ============================================================================
// 单元测试
//
// 这个模块的错误代价很高（误判"失效"→ 用户全选 → 删掉正常菜单），
// 所以纯函数部分必须有用例兜住：路径提取、变量展开、三态判定。
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_any_env_var_and_keeps_unknown_ones() {
        let system_root = std::env::var("SystemRoot").expect("Windows 一定有 SystemRoot");
        assert_eq!(
            expand_env_vars(r"%SystemRoot%\System32\cmd.exe"),
            format!(r"{}\System32\cmd.exe", system_root)
        );
        // 未定义的变量原样保留，界面才能看出命令本来的样子
        assert_eq!(
            expand_env_vars(r"%LIGHTC_NOT_A_REAL_VAR%\app.exe"),
            r"%LIGHTC_NOT_A_REAL_VAR%\app.exe"
        );
        // 落单的 % 不能被吞
        assert_eq!(expand_env_vars(r"app.exe %1"), r"app.exe %1");
    }

    #[test]
    fn extracts_quoted_path_with_spaces() {
        let extracted = ContextMenuScanner::extract_exe_path(
            r#""C:\Program Files\App\app.exe" "%1""#,
        );
        assert_eq!(extracted.as_deref(), Some(r"C:\Program Files\App\app.exe"));
    }

    #[test]
    fn extracts_unquoted_path_with_spaces() {
        // 造一个带空格的临时目录，模拟"路径有空格但没加引号"的老式写法
        let dir = std::env::temp_dir().join("lightc ctx menu test");
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let exe = dir.join("app.exe");
        std::fs::write(&exe, [0u8; 1]).expect("写入临时文件失败");

        let command = format!(r"{} -open", exe.display());
        let extracted = ContextMenuScanner::extract_exe_path(&command);

        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(extracted, Some(exe.to_string_lossy().to_string()));
    }

    #[test]
    fn leaves_delegate_executors_unknown() {
        // 真目标在参数里（.dll / .msi / .vbs），判不了，也不能判成失效
        for command in [
            r"rundll32.exe shell32.dll,OpenAs_RunDLL %1",
            r"C:\Windows\System32\msiexec.exe /i foo.msi",
            r"regsvr32.exe /s something.dll",
        ] {
            assert_eq!(
                ContextMenuScanner::extract_exe_path(command),
                None,
                "不该给出路径: {}",
                command
            );
        }
    }

    #[test]
    fn resolves_bare_system_executable() {
        // `cmd.exe /c ...` 这种靠系统目录解析，解出来就是 Ok，不该标成未知
        let extracted = ContextMenuScanner::extract_exe_path(r"cmd.exe /c dir");
        let path = extracted.expect("cmd.exe 应该能落到系统目录");
        assert!(Path::new(&path).exists(), "解析出的路径应真实存在: {}", path);
    }

    #[test]
    fn never_fabricates_path_for_unknown_bare_command() {
        // 裸文件名找不到就必须承认找不到，不能拼一个"像是路径"的东西出来
        assert_eq!(
            ContextMenuScanner::extract_exe_path("lightc_no_such_command.exe /silent"),
            None
        );
    }

    #[test]
    fn recognizes_clsid_shapes() {
        assert!(looks_like_clsid("{90AA3A4E-1CBA-4233-B8BB-535773D48449}"));
        assert!(looks_like_clsid("  {f81e9010-6ea4-11ce-a7ff-00aa003ca9f6}  "));
        // 友好名、空串、长度不对的都不算
        assert!(!looks_like_clsid("TortoiseSVN"));
        assert!(!looks_like_clsid("{90AA3A4E-1CBA}"));
        assert!(!looks_like_clsid(""));
    }

    #[test]
    fn completes_bare_module_names_against_system_dirs() {
        // 托管扩展的 InprocServer32 就是裸名（mscoree.dll），不补全就会误判成"文件不存在"
        let resolved = resolve_bare_module("kernel32.dll").expect("kernel32.dll 一定在系统目录");
        assert!(Path::new(&resolved).exists());
        assert_eq!(resolve_bare_module("lightc_no_such_module.dll"), None);
        // 带路径的原样返回，不去瞎猜
        assert_eq!(
            resolve_bare_module(r"C:\x\y.dll").as_deref(),
            Some(r"C:\x\y.dll")
        );
    }

    #[test]
    fn only_deletes_paths_inside_known_context_menu_locations() {
        // 允许：扫描位置 + 一个键名
        assert!(is_deletable_subpath(
            r"software\classes\*\shell\myapp"
        ));
        assert!(is_deletable_subpath(
            r"software\classes\directory\shellex\contextmenuhandlers\tortoisesvn"
        ));
        // 拒绝：位置之外
        assert!(!is_deletable_subpath(
            r"software\microsoft\windows\currentversion\run\evil"
        ));
        assert!(!is_deletable_subpath(r"software\classes\*\shell"));
        // 拒绝：想借前缀再往下钻一层
        assert!(!is_deletable_subpath(
            r"software\classes\*\shell\myapp\command"
        ));
        // 拒绝：父级本身就是目标（没有键名）
        assert!(!is_deletable_subpath(r"software\classes\directory\shell\"));
    }

    #[test]
    fn classifies_only_known_missing_paths_as_invalid() {
        // 说了路径但文件不在 → 失效
        assert_eq!(
            classify_exe_status(Some(r"C:\lightc_no_such_dir\app.exe")),
            ExeStatus::Missing
        );
        // 提不出路径 → 未知，不算失效
        assert_eq!(classify_exe_status(None), ExeStatus::Unknown);
        // 路径真实存在 → 正常
        let system_root = std::env::var("SystemRoot").expect("Windows 一定有 SystemRoot");
        let existing = format!(r"{}\System32\cmd.exe", system_root);
        assert_eq!(classify_exe_status(Some(&existing)), ExeStatus::Ok);
    }
}
