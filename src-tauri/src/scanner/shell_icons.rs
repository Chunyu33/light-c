// ============================================================================
// 虚拟磁盘 / 外壳图标扫描与处理
//
// 这里只处理 Explorer\MyComputer\NameSpace 下的 CLSID 节点。
// 该范围比 DelegateFolders 更收敛，能降低把真实系统 Shell 扩展误判为“虚拟磁盘”的风险。
// ============================================================================

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{c_void, OsString};
use std::fs;
use std::io::Write;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use winapi::shared::minwindef::{FALSE, TRUE};
use winapi::shared::sddl::{self, SDDL_REVISION_1};
use winapi::um::accctrl::{
    ACCESS_MODE, DENY_ACCESS, EXPLICIT_ACCESS_W, NO_INHERITANCE, SE_REGISTRY_KEY, TRUSTEE_IS_SID,
    TRUSTEE_IS_WELL_KNOWN_GROUP,
};
use winapi::um::aclapi::{GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo};
use winapi::um::errhandlingapi::GetLastError;
use winapi::um::securitybaseapi::{AllocateAndInitializeSid, FreeSid};
use winapi::um::winbase::LocalFree;
use winapi::um::winnt::{
    ACL, DACL_SECURITY_INFORMATION, DELETE, GROUP_SECURITY_INFORMATION, KEY_ALL_ACCESS,
    KEY_CREATE_SUB_KEY, KEY_READ, KEY_SET_VALUE, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_WORLD_RID,
    SECURITY_WORLD_SID_AUTHORITY, SID_IDENTIFIER_AUTHORITY, WRITE_DAC, WRITE_OWNER,
};
use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::{RegKey, HKEY};

const NAMESPACE_PATH: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\MyComputer\NameSpace";
const SHCNE_ASSOCCHANGED: u32 = 0x0800_0000;
const SHCNF_IDLIST: u32 = 0x0000;

#[link(name = "shell32")]
extern "system" {
    fn SHChangeNotify(event_id: u32, flags: u32, item1: *const c_void, item2: *const c_void);
}
const SYSTEM_CLSIDS: &[&str] = &[
    "{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
    "{450D8FBA-AD25-11D0-98A6-006008059382}",
    "{F02C1A0D-BE21-4350-88B0-7367288F2C01}",
    "{645FF040-5081-101B-9F08-00AA002F954E}",
    "{59031A47-3F72-44A7-89C5-5595FE6B30EE}",
    "{374DE290-123F-4565-9164-39C4925E467B}",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIconInfo {
    pub clsid: String,
    pub name: String,
    pub application_name: Option<String>,
    pub reg_path: String,
    pub hive: String,
    pub registry_view: String,
    pub source_path: Option<String>,
    pub risk_level: String,
    pub risk_reason: String,
    pub is_system_protected: bool,
    pub is_locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellIconTarget {
    pub clsid: String,
    pub hive: String,
    pub registry_view: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIconOperationResult {
    pub success: bool,
    pub message: String,
    pub backup_path: Option<String>,
    pub needs_explorer_refresh: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellIconOperationLog {
    timestamp: String,
    operation: String,
    target: ShellIconTarget,
    success: bool,
    message: String,
    backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellIconBackup {
    target: ShellIconTarget,
    backup_path: String,
    acl_sddl: Option<String>,
    /// 彻底删除会锁定父级 Namespace，必须保存原 ACL 才能完整恢复。
    #[serde(default)]
    namespace_acl_sddl: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, Copy)]
struct RegistryTargetContext {
    root: HKEY,
    view_flags: u32,
}

/// 扫描所有受支持的 Hive / Registry View，避免只看当前进程视图而漏掉 32 位软件节点。
pub fn scan_shell_icons() -> Result<Vec<ShellIconInfo>, String> {
    let scan_targets = [
        (
            "HKCU",
            "default",
            RegistryTargetContext {
                root: HKEY_CURRENT_USER,
                view_flags: 0,
            },
        ),
        (
            "HKLM",
            "64",
            RegistryTargetContext {
                root: HKEY_LOCAL_MACHINE,
                view_flags: KEY_WOW64_64KEY,
            },
        ),
        (
            "HKLM",
            "32",
            RegistryTargetContext {
                root: HKEY_LOCAL_MACHINE,
                view_flags: KEY_WOW64_32KEY,
            },
        ),
    ];
    let mut entries = Vec::new();

    for (hive, view, context) in scan_targets {
        let namespace_key = match RegKey::predef(context.root)
            .open_subkey_with_flags(NAMESPACE_PATH, KEY_READ | context.view_flags)
        {
            Ok(key) => key,
            Err(_) => continue,
        };

        for raw_clsid in namespace_key.enum_keys().filter_map(Result::ok) {
            let Some(clsid) = normalize_clsid(&raw_clsid) else {
                continue;
            };
            // 某个第三方节点权限异常不应阻断其他分区视图的扫描结果。
            match build_shell_icon_info(&namespace_key, &clsid, hive, view, context) {
                Ok(info) if info.risk_level == "safe" || info.risk_level == "locked" => {
                    entries.push(info)
                }
                Ok(_) => {}
                Err(error) => log::debug!("跳过无法读取的外壳节点 {}: {}", clsid, error),
            }
        }
    }

    // 同一个 CLSID 可能同时存在于 HKCU、HKLM 或不同 Registry View；这些是真实不同的注册表节点，
    // 不能为了界面去重，否则只处理其中一个节点时，客户端仍可从另一处重新挂载图标。
    let mut unique_entries: HashMap<String, ShellIconInfo> = HashMap::new();
    for entry in entries {
        let key = format!(
            "{}:{}:{}",
            entry.hive.to_ascii_lowercase(),
            entry.registry_view.to_ascii_lowercase(),
            entry.clsid.to_ascii_lowercase()
        );
        unique_entries.entry(key).or_insert(entry);
    }
    let mut entries: Vec<ShellIconInfo> = unique_entries.into_values().collect();
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(entries)
}

fn build_shell_icon_info(
    namespace_key: &RegKey,
    clsid: &str,
    hive: &str,
    registry_view: &str,
    context: RegistryTargetContext,
) -> Result<ShellIconInfo, String> {
    let namespace_item = namespace_key
        .open_subkey_with_flags(clsid, KEY_READ | context.view_flags)
        .map_err(|error| format!("打开外壳图标节点失败 {}: {}", clsid, error))?;
    let clsid_key = RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey_with_flags(&format!(r"CLSID\{}", clsid), KEY_READ | context.view_flags)
        .ok();

    // 某些软件会写入空的 Namespace 默认值；空值不能遮蔽 CLSID 下真实的产品名称。
    let raw_name = namespace_item
        .get_value::<String, _>("")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            clsid_key
                .as_ref()
                .and_then(|key| key.get_value::<String, _>("").ok())
                .filter(|value| !value.trim().is_empty())
        });
    let name = raw_name
        .as_deref()
        .map(resolve_indirect_string)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| clsid.to_string());
    let source_path = clsid_key.as_ref().and_then(find_source_path);
    let known_application = identify_known_application(clsid, &name, source_path.as_deref());
    let application_name = identify_application(clsid, &name, source_path.as_deref());
    let system_by_clsid = SYSTEM_CLSIDS
        .iter()
        .any(|item| item.eq_ignore_ascii_case(clsid));
    // 部分网盘把自己的 Namespace 节点挂在 shdocvw.dll 等系统宿主 DLL 上，不能仅凭组件路径过滤。
    let system_by_source =
        source_path.as_deref().is_some_and(is_system_component_path) && known_application.is_none();
    let is_system_protected = system_by_clsid || system_by_source;
    let is_locked = read_acl_sddl(&namespace_item)
        .ok()
        .flatten()
        .is_some_and(is_lightc_lock_sddl);
    let (risk_level, risk_reason) = if is_system_protected {
        (
            "protected",
            "Windows 系统外壳节点或系统组件，禁止清理".to_string(),
        )
    } else if is_locked {
        (
            "locked",
            "该节点已由 LightC 清空并限制写入，可解锁恢复".to_string(),
        )
    } else if application_name.is_none() {
        ("unknown", "无法确认关联应用，默认不展示".to_string())
    } else {
        (
            "safe",
            if source_path.is_some() {
                "已确认第三方应用关联，清理前会自动备份".to_string()
            } else {
                // 部分软件只注册 Namespace 名称，组件路径可能在其他注册表视图或权限范围内不可读。
                "已根据外壳图标名称确认第三方应用，组件路径暂不可读，清理前会自动备份".to_string()
            },
        )
    };

    Ok(ShellIconInfo {
        clsid: clsid.to_string(),
        name,
        application_name,
        reg_path: format!(r"{}\{}\{}", hive, NAMESPACE_PATH, clsid),
        hive: hive.to_string(),
        registry_view: registry_view.to_string(),
        source_path,
        risk_level: risk_level.to_string(),
        risk_reason,
        is_system_protected,
        is_locked,
    })
}

/// 通过 CLSID、注册表显示名和组件文件名识别用户真正安装的应用。
/// 只有能识别应用的节点才进入 MVP 列表，避免把 RegFolder 等内部节点暴露给用户。
fn identify_application(
    clsid: &str,
    display_name: &str,
    source_path: Option<&str>,
) -> Option<String> {
    if let Some(application_name) = identify_known_application(clsid, display_name, source_path) {
        return Some(application_name.to_string());
    }

    let normalized_name = display_name.trim();
    let normalized_name_lower = normalized_name.to_ascii_lowercase();
    if !normalized_name.is_empty()
        && !normalized_name_lower.starts_with("clsid_")
        && !normalized_name_lower.contains("regfolder")
        && !normalized_name_lower.contains("thispc")
    {
        return Some(normalized_name.to_string());
    }
    None
}

/// 识别有明确产品特征的应用，用于覆盖第三方借用系统 Shell 宿主 DLL 的情况。
fn identify_known_application(
    clsid: &str,
    display_name: &str,
    source_path: Option<&str>,
) -> Option<&'static str> {
    // 百度网盘使用 shdocvw.dll 作为系统 Shell 宿主，组件路径无法反映产品归属。
    if clsid.eq_ignore_ascii_case("{679F137C-3162-45DA-BE3C-2F9C3D093F64}") {
        return Some("百度网盘");
    }
    let source_name = source_path
        .and_then(|path| Path::new(path).file_stem())
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    // GUID 只是定位键，不能参与应用名匹配，否则普通 CLSID 中的数字片段可能造成误关联。
    let haystack = format!("{} {}", display_name, source_name).to_lowercase();
    let known_applications = [
        (
            &["baidu", "baidunetdisk", "netdisk", "百度", "百度网盘"][..],
            "百度网盘",
        ),
        (&["quark", "夸克"][..], "夸克网盘"),
        (&["wps", "kingsoft", "金山"][..], "WPS"),
        (&["thunder", "xunlei", "迅雷"][..], "迅雷"),
        (&["aliyun", "阿里云"][..], "阿里云盘"),
        (&["115", "115科技"][..], "115"),
    ];
    for (markers, application_name) in known_applications {
        if markers.iter().any(|marker| haystack.contains(marker)) {
            return Some(application_name);
        }
    }
    None
}

/// 普通删除或强力锁定前统一重新校验目标，不能信任前端传入任意注册表路径。
pub fn remove_shell_icon(
    target: &ShellIconTarget,
    mode: u8,
) -> Result<ShellIconOperationResult, String> {
    if mode != 1 && mode != 2 {
        return Err("不支持的清理模式".to_string());
    }
    let target = normalize_target(target)?;
    let context = target_context(&target)?;
    // 先只申请读取和修改 ACL 的权限，兼容之前由 LightC 添加拒绝 ACE 后无法申请 FullControl 的节点。
    let initial_key = open_target_key(
        &target,
        context,
        KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
    )?;
    // 先用能读取和改 ACL 的权限打开父键，兼容旧版本已经添加拒绝 ACE 的情况。
    let initial_namespace_key = open_namespace_key(context, KEY_READ | WRITE_DAC | WRITE_OWNER)?;
    let info = build_shell_icon_info_from_key(&initial_key, &target, context)?;
    if info.is_system_protected || info.risk_level == "unknown" {
        return Err("该节点无法确认是第三方外壳图标，已阻止操作".to_string());
    }

    let original_acl = read_acl_sddl(&initial_key)?;
    let original_namespace_acl = read_acl_sddl(&initial_namespace_key)?;
    // 必须在解除旧锁前备份，确保恢复功能保留用户看到的原始 ACL 状态。
    let backup = create_backup(&target, &initial_key, &initial_namespace_key, context)?;

    // 旧版本已经锁定过的节点会拒绝 KEY_ALL_ACCESS，先恢复到无 LightC 拒绝 ACE 的临时状态。
    let had_lightc_lock = original_acl.as_deref().is_some_and(is_lightc_lock_sddl_ref);
    if had_lightc_lock {
        remove_lightc_lock_acl(&initial_key)?;
        let unlocked_key = open_target_key(
            &target,
            context,
            KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
        )?;
        if read_acl_sddl(&unlocked_key)?
            .as_deref()
            .is_some_and(is_lightc_lock_sddl_ref)
        {
            return Err("解除旧版防复活权限失败，已停止删除操作".to_string());
        }
    }
    drop(initial_key);

    // 兼容旧版本留下的父级 LightC 锁，先临时解除，否则无法删除旧占位节点。
    if original_namespace_acl
        .as_deref()
        .is_some_and(is_lightc_namespace_lock_sddl_ref)
    {
        remove_lightc_lock_acl(&initial_namespace_key)?;
    }

    drop(initial_namespace_key);
    let key = match open_target_key(
        &target,
        context,
        KEY_ALL_ACCESS | WRITE_DAC | WRITE_OWNER | context.view_flags,
    ) {
        Ok(key) => key,
        Err(error) if had_lightc_lock => {
            // 重新打开失败时恢复旧 ACL，避免留下“已解锁但操作未完成”的中间状态。
            if let Ok(rollback_key) = open_target_key(
                &target,
                context,
                KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
            ) {
                if let Some(acl) = original_acl.as_deref() {
                    let _ = restore_acl(&rollback_key, acl);
                }
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    // 父键必须在加拒绝 ACL 前以可删除权限打开；之后复用该句柄完成删除，避免竞态复活。
    let namespace_key = match open_namespace_key(context, KEY_ALL_ACCESS | WRITE_DAC | WRITE_OWNER)
    {
        Ok(namespace_key) => namespace_key,
        Err(error) => {
            drop(key);
            return Err(error);
        }
    };
    let operation_result = (|| {
        match mode {
            1 => {
                // 先清空目标内容，避免子键自身 ACL 或残留句柄导致父键递归删除失败。
                clear_key_contents(&key)?;
                drop(key);
                delete_target_key_from_parent(&namespace_key, &target, context)?;
                // 普通删除只处理当前节点；如果是兼容旧版本临时解除的父级锁，成功后恢复它。
                if original_namespace_acl
                    .as_deref()
                    .is_some_and(is_lightc_namespace_lock_sddl_ref)
                {
                    restore_acl(
                        &namespace_key,
                        original_namespace_acl
                            .as_deref()
                            .ok_or_else(|| "缺少原始父级 ACL 备份".to_string())?,
                    )?;
                }
                verify_target_absent(&target, context)
            }
            2 => {
                // 先锁父键，再复用已取得删除权限的句柄删除目标，消除客户端抢先重建节点的窗口。
                add_namespace_lock_and_verify(&namespace_key)?;
                clear_key_contents(&key)?;
                drop(key);
                delete_target_key_from_parent(&namespace_key, &target, context)?;
                verify_target_absent(&target, context)
            }
            _ => unreachable!("已在入口校验清理模式"),
        }
    })();
    if let Err(error) = operation_result {
        // 任一核验失败都恢复操作前 ACL，避免留下“半清理、半锁定”的不可解释状态。
        if let Ok(rollback_key) = open_target_key(
            &target,
            context,
            KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
        ) {
            if let Some(acl) = original_acl.as_deref() {
                let _ = restore_acl(&rollback_key, acl);
            }
        }
        if let Some(namespace_acl) = original_namespace_acl.as_deref() {
            let _ = restore_acl(&namespace_key, namespace_acl);
        }
        return Err(error);
    }

    let refresh_message = if mode == 2 {
        // 物理删除后刷新 Explorer，确保旧的 Shell Namespace 缓存立即失效。
        match restart_explorer() {
            Ok(()) => "节点已物理删除，已锁定父级防止复活并刷新 Explorer".to_string(),
            Err(error) => format!(
                "节点已物理删除并锁定父级，但 Explorer 刷新失败，请手动刷新：{}",
                error
            ),
        }
    } else {
        "节点已删除".to_string()
    };

    Ok(ShellIconOperationResult {
        success: true,
        message: refresh_message,
        backup_path: Some(backup.backup_path),
        needs_explorer_refresh: true,
    })
}

/// 解锁只恢复原 ACL，不自动重新导入内容，避免用户只想允许软件重新注册时被意外恢复图标。
pub fn unlock_shell_icon(target: &ShellIconTarget) -> Result<ShellIconOperationResult, String> {
    let target = normalize_target(target)?;
    let context = target_context(&target)?;
    let backup =
        find_latest_backup(&target)?.ok_or_else(|| "未找到该节点的 ACL 备份".to_string())?;
    let namespace_key = open_namespace_key(context, KEY_READ | WRITE_DAC | WRITE_OWNER)?;
    // 新版防复活锁在父级，解锁时必须同时恢复父级，否则软件仍无法重新创建节点。
    if let Some(namespace_sddl) = backup.namespace_acl_sddl.as_deref() {
        restore_acl(&namespace_key, namespace_sddl)?;
    } else if read_acl_sddl(&namespace_key)?
        .as_deref()
        .is_some_and(is_lightc_namespace_lock_sddl_ref)
    {
        // 旧版备份没有父级快照，只能移除 LightC 自己的拒绝 ACE，保留其他系统 ACL。
        remove_lightc_lock_acl(&namespace_key)?;
    }
    // 物理删除后的目标键不存在是正常状态，解锁只需恢复父级权限即可。
    if let Ok(key) = open_target_key(
        &target,
        context,
        KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
    ) {
        if let Some(acl_sddl) = backup.acl_sddl.as_deref() {
            restore_acl(&key, acl_sddl)?;
        }
    }
    Ok(ShellIconOperationResult {
        success: true,
        message: "防复活权限已解除，当前节点内容未恢复".to_string(),
        backup_path: Some(backup.backup_path),
        needs_explorer_refresh: true,
    })
}

/// 从最近一次备份导入注册表内容，并恢复原始 ACL，覆盖普通删除和强力清理两种场景。
pub fn restore_shell_icon(target: &ShellIconTarget) -> Result<ShellIconOperationResult, String> {
    let target = normalize_target(target)?;
    let context = target_context(&target)?;
    let backup =
        find_latest_backup(&target)?.ok_or_else(|| "未找到该节点的注册表备份".to_string())?;
    let namespace_key = open_namespace_key(context, KEY_READ | WRITE_DAC | WRITE_OWNER)?;
    let runtime_namespace_acl = read_acl_sddl(&namespace_key)?;
    let mut namespace_acl_changed = false;
    // 导入前先恢复父级写权限；旧版元数据没有父级快照时，兼容移除 LightC 旧锁。
    if let Some(namespace_sddl) = backup.namespace_acl_sddl.as_deref() {
        restore_acl(&namespace_key, namespace_sddl)?;
        namespace_acl_changed = true;
    } else if runtime_namespace_acl
        .as_deref()
        .is_some_and(is_lightc_namespace_lock_sddl_ref)
    {
        remove_lightc_lock_acl(&namespace_key)?;
        namespace_acl_changed = true;
    }
    let restore_result = (|| {
        // 强力模式的目标键仍可能带有拒绝写入 ACL，导入前先恢复目标 ACL。
        if let Some(sddl) = backup.acl_sddl.as_deref() {
            if let Ok(key) = open_target_key(
                &target,
                context,
                KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
            ) {
                restore_acl(&key, sddl)?;
            }
        }
        import_registry_backup(&backup.backup_path, &target)?;
        // reg.exe import 会重建节点；导入后的 ACL 仍需再恢复一次，兼容备份中带有完整安全描述符的情况。
        if let Some(sddl) = backup.acl_sddl.as_deref() {
            let key = open_target_key(
                &target,
                context,
                KEY_READ | WRITE_DAC | WRITE_OWNER | context.view_flags,
            )?;
            restore_acl(&key, sddl)?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = restore_result {
        // 导入失败时恢复操作前的父级 ACL，避免留下“可写权限已被改变”的中间状态。
        if namespace_acl_changed {
            if let Some(runtime_sddl) = runtime_namespace_acl.as_deref() {
                let _ = restore_acl(&namespace_key, runtime_sddl);
            }
        }
        return Err(error);
    }
    Ok(ShellIconOperationResult {
        success: true,
        message: "注册表节点和原始 ACL 已恢复".to_string(),
        backup_path: Some(backup.backup_path),
        needs_explorer_refresh: true,
    })
}

pub fn open_shell_icon_backup_dir() -> Result<(), String> {
    let path = backup_dir();
    fs::create_dir_all(&path).map_err(|error| format!("创建备份目录失败: {}", error))?;
    Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("打开备份目录失败: {}", error))?;
    Ok(())
}

/// 打开独立的虚拟磁盘操作记录，避免用户只能依赖一次性的 Toast 回顾历史。
pub fn open_shell_icon_log() -> Result<(), String> {
    let path = shell_icon_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建操作记录目录失败: {}", error))?;
    }
    if !path.exists() {
        fs::write(&path, "").map_err(|error| format!("创建操作记录失败: {}", error))?;
    }
    // 直接打开日志内容比只定位文件更符合“操作记录”的预期，且不依赖资源管理器刷新状态。
    Command::new("notepad.exe")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("打开操作记录失败: {}", error))?;
    Ok(())
}

/// 记录虚拟磁盘操作结果；日志写入失败不影响注册表操作本身。
pub fn record_shell_icon_operation(
    target: &ShellIconTarget,
    operation: &str,
    result: &Result<ShellIconOperationResult, String>,
) {
    let (success, message, backup_path) = match result {
        Ok(value) => (
            value.success,
            value.message.clone(),
            value.backup_path.clone(),
        ),
        Err(error) => (false, error.clone(), None),
    };
    let entry = ShellIconOperationLog {
        timestamp: Local::now().to_rfc3339(),
        operation: operation.to_string(),
        target: target.clone(),
        success,
        message,
        backup_path,
    };
    let Ok(json) = serde_json::to_string(&entry) else {
        log::warn!("序列化虚拟磁盘操作记录失败");
        return;
    };
    let path = shell_icon_log_path();
    let write_result = (|| -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建操作记录目录失败: {}", error))?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("打开操作记录失败: {}", error))?;
        writeln!(file, "{}", json).map_err(|error| format!("写入操作记录失败: {}", error))
    })();
    if let Err(error) = write_result {
        log::warn!("{}", error);
    }
}

fn shell_icon_log_path() -> PathBuf {
    crate::data_dir::get_data_dir()
        .join("logs")
        .join("shell_icons.log")
}

/// 将目标键写入 Regedit 的 LastKey 后打开注册表编辑器，避免用户手动复制长路径。
pub fn open_shell_icon_registry(target: &ShellIconTarget) -> Result<(), String> {
    let target = normalize_target(target)?;
    let context = target_context(&target)?;
    let _key = open_target_key(&target, context, KEY_READ | context.view_flags)?;
    let (regedit_config, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Applets\Regedit")
        .map_err(|error| format!("写入注册表编辑器定位信息失败: {}", error))?;
    let root_name = regedit_root_name(&regedit_config);
    let registry_path = format!(
        r"{}\HKEY_{}\{}\{}",
        root_name,
        if target.hive == "HKCU" {
            "CURRENT_USER"
        } else {
            "LOCAL_MACHINE"
        },
        NAMESPACE_PATH,
        target.clsid
    );
    regedit_config
        .set_value("LastKey", &registry_path)
        .map_err(|error| format!("保存注册表定位信息失败: {}", error))?;
    // Regedit 已经运行时通常不会重新读取 LastKey；关闭旧进程后再启动，才能稳定展开到目标键。
    let regedit_status = hidden_command("taskkill", &["/f", "/im", "regedit.exe"])?;
    if !regedit_status.status.success() && regedit_status.status.code() != Some(128) {
        return Err("关闭已有注册表编辑器失败，无法定位到目标节点".to_string());
    }
    Command::new("regedit.exe")
        .spawn()
        .map_err(|error| format!("打开注册表编辑器失败: {}", error))?;
    Ok(())
}

/// Regedit 的 LastKey 使用本地化的根节点名称，沿用已有值可兼容中英文系统。
fn regedit_root_name(regedit_config: &RegKey) -> String {
    regedit_config
        .get_value::<String, _>("LastKey")
        .ok()
        .and_then(|last_key| {
            last_key
                .split_once(r"\HKEY_")
                .map(|(root_name, _)| root_name.trim().to_string())
        })
        .filter(|root_name| !root_name.is_empty())
        .unwrap_or_else(|| "计算机".to_string())
}

pub fn restart_explorer() -> Result<(), String> {
    // 只发送 Shell 变更通知，不结束 explorer.exe，避免 TranslucentTB 等任务栏扩展丢失注入状态。
    unsafe {
        SHChangeNotify(
            SHCNE_ASSOCCHANGED,
            SHCNF_IDLIST,
            std::ptr::null(),
            std::ptr::null(),
        );
    }
    Ok(())
}

fn build_shell_icon_info_from_key(
    key: &RegKey,
    target: &ShellIconTarget,
    context: RegistryTargetContext,
) -> Result<ShellIconInfo, String> {
    let namespace_root = RegKey::predef(context.root)
        .open_subkey_with_flags(NAMESPACE_PATH, KEY_READ | context.view_flags)
        .map_err(|error| format!("打开 Namespace 根键失败: {}", error))?;
    build_shell_icon_info(
        &namespace_root,
        &target.clsid,
        &target.hive,
        &target.registry_view,
        context,
    )
    .or_else(|_| {
        let source_path = None;
        let is_protected = SYSTEM_CLSIDS
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&target.clsid));
        Ok(ShellIconInfo {
            clsid: target.clsid.clone(),
            name: target.clsid.clone(),
            application_name: None,
            reg_path: registry_path(target),
            hive: target.hive.clone(),
            registry_view: target.registry_view.clone(),
            source_path,
            risk_level: if is_protected { "protected" } else { "unknown" }.to_string(),
            risk_reason: "目标状态发生变化，请重新扫描".to_string(),
            is_system_protected: is_protected,
            is_locked: read_acl_sddl(key)
                .ok()
                .flatten()
                .is_some_and(is_lightc_lock_sddl),
        })
    })
}

fn normalize_target(target: &ShellIconTarget) -> Result<ShellIconTarget, String> {
    let clsid = normalize_clsid(&target.clsid).ok_or_else(|| "CLSID 格式无效".to_string())?;
    if SYSTEM_CLSIDS
        .iter()
        .any(|system_clsid| system_clsid.eq_ignore_ascii_case(&clsid))
    {
        return Err("系统外壳节点受保护，禁止修改".to_string());
    }
    if target.hive != "HKCU" && target.hive != "HKLM" {
        return Err("不支持的注册表 Hive".to_string());
    }
    if target.registry_view != "default"
        && target.registry_view != "32"
        && target.registry_view != "64"
    {
        return Err("不支持的 Registry View".to_string());
    }
    if target.hive == "HKCU" && target.registry_view != "default" {
        return Err("当前版本只允许操作 HKCU 默认视图".to_string());
    }
    Ok(ShellIconTarget {
        clsid,
        hive: target.hive.clone(),
        registry_view: target.registry_view.clone(),
    })
}

fn target_context(target: &ShellIconTarget) -> Result<RegistryTargetContext, String> {
    let root = if target.hive == "HKCU" {
        HKEY_CURRENT_USER
    } else {
        HKEY_LOCAL_MACHINE
    };
    let view_flags = match target.registry_view.as_str() {
        "default" => 0,
        "32" => KEY_WOW64_32KEY,
        "64" => KEY_WOW64_64KEY,
        _ => return Err("不支持的 Registry View".to_string()),
    };
    Ok(RegistryTargetContext { root, view_flags })
}

fn open_target_key(
    target: &ShellIconTarget,
    context: RegistryTargetContext,
    flags: u32,
) -> Result<RegKey, String> {
    RegKey::predef(context.root)
        .open_subkey_with_flags(format!(r"{}\{}", NAMESPACE_PATH, target.clsid), flags)
        .map_err(|error| format!("打开目标注册表节点失败: {}", error))
}

fn open_namespace_key(context: RegistryTargetContext, flags: u32) -> Result<RegKey, String> {
    RegKey::predef(context.root)
        .open_subkey_with_flags(NAMESPACE_PATH, flags | context.view_flags)
        .map_err(|error| format!("打开 Namespace 父键失败: {}", error))
}

fn delete_target_key_from_parent(
    parent: &RegKey,
    target: &ShellIconTarget,
    context: RegistryTargetContext,
) -> Result<(), String> {
    // 父键句柄必须在加锁前取得，否则新加入的拒绝 ACE 会让删除再次返回拒绝访问。
    parent
        .delete_subkey_with_flags(&target.clsid, context.view_flags)
        .map_err(|error| format!("删除外壳图标节点失败: {}", error))
}

fn clear_key_contents(key: &RegKey) -> Result<(), String> {
    // 不能忽略枚举错误，否则部分子键清理失败时仍会返回“成功”，留下可复活内容。
    let child_names = key
        .enum_keys()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("枚举注册表子键失败: {}", error))?;
    for child in child_names {
        key.delete_subkey_all(child)
            .map_err(|error| format!("清空子键失败: {}", error))?;
    }
    let value_names = key
        .enum_values()
        .map(|value| value.map(|item| item.0))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("枚举注册表键值失败: {}", error))?;
    for value in value_names {
        key.delete_value(value)
            .map_err(|error| format!("清空键值失败: {}", error))?;
    }
    Ok(())
}

fn verify_target_absent(
    target: &ShellIconTarget,
    context: RegistryTargetContext,
) -> Result<(), String> {
    let path = format!(r"{}\{}", NAMESPACE_PATH, target.clsid);
    match RegKey::predef(context.root).open_subkey_with_flags(path, KEY_READ | context.view_flags) {
        Ok(_) => {
            Err("删除操作已返回，但注册表节点仍然存在，请关闭占用该节点的软件后重试".to_string())
        }
        Err(error) if matches!(error.raw_os_error(), Some(2 | 3)) => Ok(()),
        Err(error) => Err(format!(
            "无法核验注册表节点是否删除，可能仍存在或权限不足: {}",
            error
        )),
    }
}

/// 在父级 Namespace 上拒绝普通用户创建、修改和删除子键，避免目标被软件重新注册。
fn add_namespace_lock_and_verify(namespace_key: &RegKey) -> Result<(), String> {
    add_lock_acl(namespace_key)?;
    let acl = read_acl_sddl(namespace_key)?;
    if !acl
        .as_deref()
        .is_some_and(is_lightc_namespace_lock_sddl_ref)
    {
        return Err("防复活父级权限未成功应用".to_string());
    }
    Ok(())
}

fn is_lightc_namespace_lock_sddl_ref(sddl: &str) -> bool {
    is_lightc_lock_sddl_ref(sddl)
}

fn create_backup(
    target: &ShellIconTarget,
    key: &RegKey,
    namespace_key: &RegKey,
    context: RegistryTargetContext,
) -> Result<ShellIconBackup, String> {
    let directory = backup_dir();
    fs::create_dir_all(&directory).map_err(|error| format!("创建备份目录失败: {}", error))?;
    let canonical_path = directory.join(format!("shell_icon_{}.reg", backup_stem(target)));
    let existing_backups = find_backups(target)?;
    if let Some(existing) = existing_backups
        .iter()
        .find(|backup| backup.backup_path == canonical_path.to_string_lossy())
        .or_else(|| {
            existing_backups
                .iter()
                .find(|backup| Path::new(&backup.backup_path).is_file())
        })
    {
        return consolidate_backup(target, context, existing);
    }

    // 备份文件使用稳定名称，同一个注册表目标只维护一份原始备份，避免每次点击都产生重复文件。
    let backup_path = canonical_path;
    export_registry_key(target, &backup_path)?;
    let metadata = ShellIconBackup {
        target: target.clone(),
        backup_path: backup_path.to_string_lossy().to_string(),
        acl_sddl: read_acl_sddl(key)?,
        namespace_acl_sddl: read_acl_sddl(namespace_key)?,
        created_at: Local::now().to_rfc3339(),
    };
    let metadata_path = backup_path.with_extension("json");
    let json = serde_json::to_string_pretty(&metadata)
        .map_err(|error| format!("序列化备份信息失败: {}", error))?;
    fs::write(metadata_path, json).map_err(|error| format!("写入备份信息失败: {}", error))?;
    let _ = context;
    Ok(metadata)
}

fn backup_stem(target: &ShellIconTarget) -> String {
    format!(
        "{}_{}_{}",
        target.hive,
        target.registry_view,
        target.clsid.trim_matches(['{', '}'])
    )
}

fn consolidate_backup(
    target: &ShellIconTarget,
    context: RegistryTargetContext,
    original: &ShellIconBackup,
) -> Result<ShellIconBackup, String> {
    let directory = backup_dir();
    let canonical_path = directory.join(format!("shell_icon_{}.reg", backup_stem(target)));
    if original.backup_path != canonical_path.to_string_lossy()
        && Path::new(&original.backup_path).is_file()
        && !canonical_path.is_file()
    {
        // 兼容旧版带时间戳备份：以最早的一份为原始快照并迁移为稳定文件名。
        fs::copy(&original.backup_path, &canonical_path)
            .map_err(|error| format!("整理注册表备份失败: {}", error))?;
    }

    let mut canonical = original.clone();
    if canonical.namespace_acl_sddl.is_none() {
        let namespace_key = open_namespace_key(context, KEY_READ | WRITE_DAC | WRITE_OWNER)?;
        canonical.namespace_acl_sddl = read_acl_sddl(&namespace_key)?;
    }
    canonical.backup_path = canonical_path.to_string_lossy().to_string();
    let metadata_path = canonical_path.with_extension("json");
    let json = serde_json::to_string_pretty(&canonical)
        .map_err(|error| format!("写入整理后的备份信息失败: {}", error))?;
    fs::write(&metadata_path, json).map_err(|error| format!("写入备份信息失败: {}", error))?;

    // 同一个目标只保留稳定名称的一组文件，避免备份目录持续膨胀。
    for backup in find_backups(target)? {
        if backup.backup_path == canonical.backup_path {
            continue;
        }
        let _ = fs::remove_file(&backup.backup_path);
        let _ = fs::remove_file(Path::new(&backup.backup_path).with_extension("json"));
    }
    Ok(canonical)
}

fn export_registry_key(target: &ShellIconTarget, backup_path: &Path) -> Result<(), String> {
    let mut args = vec![
        "export".to_string(),
        registry_path(target),
        backup_path.to_string_lossy().to_string(),
        "/y".to_string(),
    ];
    append_view_arg(&mut args, target.registry_view.as_str());
    let output = hidden_command(
        "reg.exe",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "导出注册表备份失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn import_registry_backup(path: &str, target: &ShellIconTarget) -> Result<(), String> {
    let mut args = vec!["import".to_string(), path.to_string()];
    append_view_arg(&mut args, target.registry_view.as_str());
    let output = hidden_command(
        "reg.exe",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "导入注册表备份失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn append_view_arg(args: &mut Vec<String>, view: &str) {
    if view == "32" {
        args.push("/reg:32".to_string());
    }
    if view == "64" {
        args.push("/reg:64".to_string());
    }
}

fn backup_dir() -> PathBuf {
    crate::data_dir::get_data_dir()
        .join("reg_backups")
        .join("shell_icons")
}

fn find_latest_backup(target: &ShellIconTarget) -> Result<Option<ShellIconBackup>, String> {
    Ok(find_backups(target)?.pop())
}

fn find_backups(target: &ShellIconTarget) -> Result<Vec<ShellIconBackup>, String> {
    let directory = backup_dir();
    let mut candidates = Vec::new();
    if !directory.is_dir() {
        return Ok(candidates);
    }
    for entry in fs::read_dir(directory).map_err(|error| format!("读取备份目录失败: {}", error))?
    {
        let path = entry
            .map_err(|error| format!("读取备份项失败: {}", error))?
            .path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(json) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(backup) = serde_json::from_str::<ShellIconBackup>(&json) else {
            continue;
        };
        if &backup.target == target {
            candidates.push(backup);
        }
    }
    candidates.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Ok(candidates)
}

fn find_source_path(clsid_key: &RegKey) -> Option<String> {
    for subkey_name in ["InProcServer32", "LocalServer32"] {
        let Ok(key) = clsid_key.open_subkey_with_flags(subkey_name, KEY_READ) else {
            continue;
        };
        if let Ok(path) = key.get_value::<String, _>("") {
            return Some(path);
        }
    }
    None
}

fn is_system_component_path(path: &str) -> bool {
    let expanded = expand_environment_variables(path)
        .replace('/', "\\")
        .to_ascii_lowercase();
    let windows_root = std::env::var("WINDIR")
        .unwrap_or_else(|_| "C:\\Windows".to_string())
        .to_ascii_lowercase();
    expanded.starts_with(&format!("{}\\system32", windows_root))
        || expanded.starts_with(&format!("{}\\syswow64", windows_root))
        || expanded.contains("\\microsoft\\")
}

fn expand_environment_variables(path: &str) -> String {
    let mut expanded = path.to_string();
    let environment_names = [
        ("WINDIR", None),
        // SystemRoot 在部分精简系统或测试环境中未暴露，回退到 Windir 才能继续过滤系统组件。
        ("SYSTEMROOT", Some("WINDIR")),
        ("SYSTEMDRIVE", None),
        ("PROGRAMFILES", None),
        ("PROGRAMFILES(X86)", None),
    ];
    for (name, fallback_name) in environment_names {
        let marker = format!("%{}%", name);
        let value = std::env::var(name)
            .or_else(|_| match fallback_name {
                Some(fallback) => std::env::var(fallback),
                None => Err(std::env::VarError::NotPresent),
            })
            .or_else(|_| {
                if name == "SYSTEMDRIVE" {
                    std::env::var("WINDIR").map(|windows_root| {
                        windows_root
                            .split_once('\\')
                            .map(|(drive, _)| drive.to_string())
                            .unwrap_or_else(|| "C:".to_string())
                    })
                } else {
                    Err(std::env::VarError::NotPresent)
                }
            });
        if let Ok(value) = value {
            expanded = replace_case_insensitive(&expanded, &marker, &value);
        }
    }
    expanded
}

/// Windows 环境变量名称不区分大小写，替换时也必须兼容注册表返回的混合大小写写法。
fn replace_case_insensitive(source: &str, marker: &str, replacement: &str) -> String {
    let source_upper = source.to_ascii_uppercase();
    let marker_upper = marker.to_ascii_uppercase();
    let mut result = String::with_capacity(source.len());
    let mut cursor = 0;
    while let Some(relative_index) = source_upper[cursor..].find(&marker_upper) {
        let start = cursor + relative_index;
        result.push_str(&source[cursor..start]);
        result.push_str(replacement);
        cursor = start + marker.len();
    }
    result.push_str(&source[cursor..]);
    result
}

fn normalize_clsid(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let value = trimmed
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))?;
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != groups.len()
        || parts.iter().zip(groups).any(|(part, expected)| {
            part.len() != expected || !part.chars().all(|ch| ch.is_ascii_hexdigit())
        })
    {
        return None;
    }
    Some(format!("{{{}}}", value.to_ascii_uppercase()))
}

fn registry_path(target: &ShellIconTarget) -> String {
    format!(r"{}\{}\{}", target.hive, NAMESPACE_PATH, target.clsid)
}

fn read_acl_sddl(key: &RegKey) -> Result<Option<String>, String> {
    unsafe {
        let mut owner: PSID = std::ptr::null_mut();
        let mut group: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = GetSecurityInfo(
            key.raw_handle() as _,
            SE_REGISTRY_KEY,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            return Err(format!("读取注册表 ACL 失败: {}", status));
        }
        let mut string_descriptor = std::ptr::null_mut();
        let mut length = 0;
        let converted = sddl::ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1 as u32,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut string_descriptor,
            &mut length,
        );
        if converted == FALSE {
            LocalFree(descriptor);
            return Err(format!("转换注册表 ACL 失败: {}", GetLastError()));
        }
        let value = OsString::from_wide(std::slice::from_raw_parts(
            string_descriptor,
            length as usize,
        ))
        .to_string_lossy()
        .to_string();
        LocalFree(string_descriptor as _);
        LocalFree(descriptor);
        Ok(Some(value))
    }
}

fn add_lock_acl(key: &RegKey) -> Result<(), String> {
    unsafe {
        // 重复点击彻底删除时不重复追加相同 ACE，避免 ACL 和备份一样持续膨胀。
        if read_acl_sddl(key)?
            .as_deref()
            .is_some_and(is_lightc_lock_sddl_ref)
        {
            return Ok(());
        }
        let mut owner: PSID = std::ptr::null_mut();
        let mut group: PSID = std::ptr::null_mut();
        let mut old_dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = GetSecurityInfo(
            key.raw_handle() as _,
            SE_REGISTRY_KEY,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut old_dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        );
        if status != 0 {
            return Err(format!("读取注册表 ACL 失败: {}", status));
        }
        let mut everyone_sid: PSID = std::ptr::null_mut();
        let mut authority = SID_IDENTIFIER_AUTHORITY {
            Value: SECURITY_WORLD_SID_AUTHORITY,
        };
        if AllocateAndInitializeSid(
            &mut authority,
            1,
            SECURITY_WORLD_RID,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut everyone_sid,
        ) != TRUE
        {
            LocalFree(descriptor);
            return Err(format!("创建 Everyone SID 失败: {}", GetLastError()));
        }
        let mut trustee: winapi::um::accctrl::TRUSTEE_W = std::mem::zeroed();
        trustee.TrusteeForm = TRUSTEE_IS_SID;
        trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
        trustee.ptstrName = everyone_sid as _;
        let mut entry: EXPLICIT_ACCESS_W = std::mem::zeroed();
        entry.grfAccessPermissions = KEY_SET_VALUE | KEY_CREATE_SUB_KEY | DELETE;
        entry.grfAccessMode = DENY_ACCESS as ACCESS_MODE;
        entry.grfInheritance = NO_INHERITANCE;
        entry.Trustee = trustee;
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let acl_status = SetEntriesInAclW(1, &mut entry, old_dacl, &mut new_dacl);
        if acl_status != 0 {
            FreeSid(everyone_sid);
            LocalFree(descriptor);
            return Err(format!("构造锁定 ACL 失败: {}", acl_status));
        }
        let set_status = SetSecurityInfo(
            key.raw_handle() as _,
            SE_REGISTRY_KEY,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            new_dacl,
            std::ptr::null_mut(),
        );
        LocalFree(new_dacl as _);
        FreeSid(everyone_sid);
        LocalFree(descriptor);
        if set_status != 0 {
            return Err(format!("应用锁定 ACL 失败: {}", set_status));
        }
        Ok(())
    }
}

fn restore_acl(key: &RegKey, sddl: &str) -> Result<(), String> {
    unsafe {
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let mut length = 0;
        if sddl::ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1 as u32,
            &mut descriptor,
            &mut length,
        ) == FALSE
        {
            return Err(format!("解析备份 ACL 失败: {}", GetLastError()));
        }
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut dacl_present = FALSE;
        let mut dacl_defaulted = FALSE;
        let mut owner: PSID = std::ptr::null_mut();
        let mut group: PSID = std::ptr::null_mut();
        let mut owner_defaulted = FALSE;
        let mut group_defaulted = FALSE;
        if winapi::um::securitybaseapi::GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        ) == FALSE
        {
            LocalFree(descriptor);
            return Err(format!("读取备份 ACL 失败: {}", GetLastError()));
        }
        if winapi::um::securitybaseapi::GetSecurityDescriptorOwner(
            descriptor,
            &mut owner,
            &mut owner_defaulted,
        ) == FALSE
            || winapi::um::securitybaseapi::GetSecurityDescriptorGroup(
                descriptor,
                &mut group,
                &mut group_defaulted,
            ) == FALSE
        {
            LocalFree(descriptor);
            return Err(format!("读取备份所有者失败: {}", GetLastError()));
        }
        let status = SetSecurityInfo(
            key.raw_handle() as _,
            SE_REGISTRY_KEY,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            owner,
            group,
            if dacl_present == TRUE {
                dacl
            } else {
                std::ptr::null_mut()
            },
            std::ptr::null_mut(),
        );
        LocalFree(descriptor);
        if status != 0 {
            Err(format!("恢复注册表 ACL 失败: {}", status))
        } else {
            Ok(())
        }
    }
}

fn is_lightc_lock_sddl(sddl: String) -> bool {
    is_lightc_lock_sddl_ref(&sddl)
}

fn is_lightc_lock_sddl_ref(sddl: &str) -> bool {
    sddl.split('(')
        .skip(1)
        .filter_map(|part| part.split(')').next())
        .any(|ace| {
            let fields: Vec<&str> = ace.split(';').collect();
            if fields.len() < 6 || fields[0] != "D" || fields[5] != "WD" {
                return false;
            }
            is_lightc_lock_mask(fields[2])
        })
}

fn is_lightc_lock_mask(mask: &str) -> bool {
    let normalized = mask.trim().to_ascii_uppercase();
    if normalized == "DCLCSD" {
        return true;
    }
    normalized
        .strip_prefix("0X")
        .and_then(|value| u32::from_str_radix(value, 16).ok())
        .is_some_and(|value| {
            (value & (KEY_SET_VALUE | KEY_CREATE_SUB_KEY | DELETE))
                == (KEY_SET_VALUE | KEY_CREATE_SUB_KEY | DELETE)
        })
}

/// 从当前安全描述符中移除 LightC 自己添加的 Everyone 拒绝 ACE，保留其他用户 ACL 不变。
fn remove_lightc_lock_acl(key: &RegKey) -> Result<(), String> {
    let current_sddl = read_acl_sddl(key)?.ok_or_else(|| "读取目标注册表 ACL 失败".to_string())?;
    let unlocked_sddl = remove_lightc_lock_aces_from_sddl(&current_sddl)
        .ok_or_else(|| "目标节点不存在 LightC 防复活 ACL".to_string())?;
    restore_acl(key, &unlocked_sddl)
}

fn remove_lightc_lock_aces_from_sddl(sddl: &str) -> Option<String> {
    let mut result = String::with_capacity(sddl.len());
    let mut cursor = 0;
    let mut removed = false;
    while let Some(relative_open) = sddl[cursor..].find('(') {
        let open = cursor + relative_open;
        let relative_close = sddl[open..].find(')')?;
        let close = open + relative_close;
        let ace = &sddl[open + 1..close];
        result.push_str(&sddl[cursor..open]);
        if is_lightc_lock_ace(ace) {
            removed = true;
        } else {
            result.push_str(&sddl[open..=close]);
        }
        cursor = close + 1;
    }
    result.push_str(&sddl[cursor..]);
    removed.then_some(result)
}

fn is_lightc_lock_ace(ace: &str) -> bool {
    let fields: Vec<&str> = ace.split(';').collect();
    fields.len() >= 6 && fields[0] == "D" && fields[5] == "WD" && is_lightc_lock_mask(fields[2])
}

fn resolve_indirect_string(raw: &str) -> String {
    if !raw.starts_with('@') {
        return raw.to_string();
    }
    let source: Vec<u16> = raw.encode_utf16().chain(std::iter::once(0)).collect();
    let mut output = vec![0u16; 512];
    #[link(name = "shlwapi")]
    extern "system" {
        fn SHLoadIndirectString(
            source: *const u16,
            output: *mut u16,
            length: u32,
            reserved: *mut *const c_void,
        ) -> i32;
    }
    let result = unsafe {
        SHLoadIndirectString(
            source.as_ptr(),
            output.as_mut_ptr(),
            output.len() as u32,
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        if let Some(end) = output.iter().position(|value| *value == 0) {
            return OsString::from_wide(&output[..end])
                .to_string_lossy()
                .to_string();
        }
    }
    raw.to_string()
}

fn hidden_command(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    Command::new(program)
        .args(args)
        .creation_flags(0x08000000)
        .output()
        .map_err(|error| format!("执行 {} 失败: {}", program, error))
}

#[cfg(test)]
mod tests {
    use super::{
        identify_application, identify_known_application, is_lightc_lock_sddl,
        is_system_component_path, normalize_clsid, registry_path,
        remove_lightc_lock_aces_from_sddl, ShellIconTarget,
    };

    #[test]
    fn normalizes_only_guid_clsid() {
        assert_eq!(
            normalize_clsid("{20d04fe0-3aea-1069-a2d8-08002b30309d}"),
            Some("{20D04FE0-3AEA-1069-A2D8-08002B30309D}".to_string())
        );
        assert!(normalize_clsid("not-a-clsid").is_none());
    }

    #[test]
    fn builds_fixed_namespace_path() {
        let target = ShellIconTarget {
            clsid: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}".to_string(),
            hive: "HKCU".to_string(),
            registry_view: "default".to_string(),
        };
        assert!(registry_path(&target)
            .contains("MyComputer\\NameSpace\\{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"));
    }

    #[test]
    fn detects_lightc_deny_ace() {
        assert!(is_lightc_lock_sddl("D:(D;;0x00010006;;;WD)".to_string()));
        assert!(is_lightc_lock_sddl("D:(D;;DCLCSD;;;WD)".to_string()));
        assert!(!is_lightc_lock_sddl("D:(A;;0x00010006;;;WD)".to_string()));
    }

    #[test]
    fn removes_only_lightc_lock_ace_from_sddl() {
        let sddl = "O:USG:WDD:(D;;DCLCSD;;;WD)(A;;KA;;;BA)";
        let unlocked = remove_lightc_lock_aces_from_sddl(sddl).expect("lock ACE should be found");
        assert_eq!(unlocked, "O:USG:WDD:(A;;KA;;;BA)");
        assert!(remove_lightc_lock_aces_from_sddl("O:USG:WDD:(A;;KA;;;BA)").is_none());
    }

    #[test]
    fn identifies_known_cloud_disk_application() {
        assert_eq!(
            identify_application(
                "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
                "CLSID_BaiduNetdisk",
                Some(r"C:\Program Files\BaiduNetdisk\BaiduNetdiskShellExt.dll")
            ),
            Some("百度网盘".to_string())
        );
    }

    #[test]
    fn identifies_known_application_without_component_path() {
        assert_eq!(
            identify_application("{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}", "百度网盘", None),
            Some("百度网盘".to_string())
        );
    }

    #[test]
    fn keeps_known_application_when_using_system_shell_host() {
        assert_eq!(
            identify_known_application(
                "{679F137C-3162-45DA-BE3C-2F9C3D093F64}",
                "百度网盘",
                Some(r"C:\Windows\System32\shdocvw.dll"),
            ),
            Some("百度网盘")
        );
    }

    #[test]
    fn does_not_identify_application_from_clsid_digits() {
        assert_eq!(
            identify_application(
                "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
                "CLSID_Unknown",
                Some(r"C:\Program Files\Vendor\ShellExt.dll"),
            ),
            None
        );
    }

    #[test]
    fn expands_windows_environment_path_before_system_filtering() {
        assert!(is_system_component_path(
            r"%SystemRoot%\System32\shell32.dll"
        ));
    }
}
