// ============================================================================
// 系统瘦身模块
// 负责休眠文件管理、WinSxS 组件清理、虚拟内存迁移引导
// ============================================================================

use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    LazyLock, RwLock,
};
use tauri::{AppHandle, Emitter, Manager, Window};

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
    pub status_text: String,
    pub enabled: bool,
    pub size: u64,
    pub actionable: bool,
    pub action_text: String,
    /// 该项仍在后台分析（目前只有 WinSxS 两项会为 true）。
    ///
    /// 中文说明：DISM 分析动辄几十秒到几分钟，不能让它挡住整个检测 ——
    /// 首屏先把这一项标成"分析中"，分析完通过 `system-slim:winsxs-ready` 事件补上结果。
    #[serde(default)]
    pub analyzing: bool,
}

/// 后台 WinSxS 分析完成后推送的条目（事件名 `system-slim:winsxs-ready`）。
///
/// 只带这两项，前端替换同 id 的条目即可；不发整个 `SystemSlimStatus`，
/// 后端不必为了发事件把休眠/虚拟内存/搜索索引再检测一遍。
#[derive(Debug, Clone, Serialize)]
pub struct WinsxsItemsPayload {
    pub items: Vec<SlimItemStatus>,
}

/// DISM 分析进度（事件名 `system-slim:winsxs-progress`）。
///
/// 单独一个事件、单独一套类型，不和清理的 `system-slim:progress` 混用 ——
/// 两者 item_id 相同，混在一起会出现"清理进度被分析进度覆盖"的串台。
#[derive(Debug, Clone, Serialize)]
pub struct WinsxsAnalyzeProgress {
    pub percent: u8,
    pub elapsed_ms: u64,
}

/// 系统瘦身状态汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemSlimStatus {
    pub is_admin: bool,
    pub items: Vec<SlimItemStatus>,
    pub total_reclaimable: u64,
}

/// 瘦身操作进度事件（事件名 `system-slim:progress`）。
///
/// 中文说明：休眠开关、组件清理、基线压缩都可能耗时几十秒到十几分钟。前端用它显示
/// 阶段、百分比和已用时间，让用户明确知道"还在跑、大概到哪一步"，而不是盯着一个不动的按钮。
#[derive(Debug, Clone, Serialize)]
pub struct SlimOperationProgress {
    /// 操作项 id，与 SlimItemStatus.id 对应，前端据此定位是哪个卡片在跑。
    pub item_id: String,
    /// 阶段标识：preparing / running / waiting / done / error。
    pub phase: String,
    /// 面向用户的中文阶段说明。
    pub message: String,
    /// 0-100；无法估算时返回 0，前端显示不确定进度条。
    pub percent: u8,
    /// running / done / error。
    pub status: String,
    /// 已用时间（毫秒），让用户能判断还要不要继续等。
    pub elapsed_ms: u64,
}

/// 统一推送瘦身进度；发送失败只记录日志，不影响操作本身。
fn emit_slim_progress(
    window: &Window,
    item_id: &str,
    phase: &str,
    message: &str,
    percent: u8,
    status: &str,
    started_at: std::time::Instant,
) {
    let progress = SlimOperationProgress {
        item_id: item_id.to_string(),
        phase: phase.to_string(),
        message: message.to_string(),
        percent,
        status: status.to_string(),
        elapsed_ms: started_at.elapsed().as_millis() as u64,
    };
    if let Err(error) = window.emit("system-slim:progress", &progress) {
        warn!("发送系统瘦身进度失败: {}", error);
    }
}

/// 单次 DISM 分析的最长等待时间。
///
/// 分析已经改成后台跑、结果用事件补推，所以这个值不再决定"用户要等多久"，
/// 只用来防止 DISM 卡死把 `WINSXS_ANALYZE_RUNNING` 永久占住。
///
/// 本机实测（2026-11-10，CBS.log 里 `Analyze: begin WinSxS tree walk` 到会话结束）
/// 一次 `analyzecomponentstore` 要 **171 秒**，比原来 30 秒的超时长出近 6 倍 ——
/// 那正是旧版"每次检测都超时、永远拿不到结果"的原因。留足余量取 600 秒：
/// 被杀掉等于白跑三分钟，宁可多等也不轻易放弃。
const WINSXS_ANALYZE_TIMEOUT_SECS: u64 = 600;
/// 内存缓存的"新鲜期"：这段时间内直接复用，不重跑 DISM。
const WINSXS_CACHE_TTL_SECS: u64 = 10 * 60;
/// 磁盘缓存可以拿来"先展示"的最长时间。
///
/// 重开应用时先显示上次的结果、同时后台重算，用户不必为了看一眼组件存储占用再等一轮 DISM。
const WINSXS_DISK_CACHE_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct WinsxsAnalyzeResult {
    reclaimable_size: u64,
    cleanup_recommended: bool,
    reclaimable_packages: u32,
    analysis_succeeded: bool,
}

#[derive(Debug, Clone, Copy)]
struct WinsxsAnalyzeCache {
    result: WinsxsAnalyzeResult,
    cached_at: std::time::Instant,
}

/// 磁盘缓存的内容：结果 + 写入时刻（Unix 秒）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WinsxsDiskCache {
    /// 解析逻辑的版本号。改了识别规则就加一，让旧缓存自动失效 ——
    /// 2026-11-10 修好中文输出解析后，磁盘里还躺着"0 可回收"的旧结论，
    /// 不失效的话用户重开应用仍会先看到"无需清理"。
    #[serde(default)]
    schema_version: u32,
    result: WinsxsAnalyzeResult,
    cached_at_unix: u64,
}

/// 当前解析规则版本，与 `WinsxsDiskCache::schema_version` 对应。
const WINSXS_CACHE_SCHEMA: u32 = 2;

static WINSXS_ANALYZE_CACHE: LazyLock<RwLock<Option<WinsxsAnalyzeCache>>> =
    LazyLock::new(|| RwLock::new(None));
static WINSXS_ANALYZE_RUNNING: AtomicBool = AtomicBool::new(false);
/// 本轮分析的开始时刻（Unix 秒），用于识别"锁住了但其实早就该结束"的僵死状态。
static WINSXS_ANALYZE_STARTED_AT: AtomicU64 = AtomicU64::new(0);

// ============================================================================
// 权限检测
// ============================================================================

/// 检查当前进程**是否真的具备管理员能力**。
///
/// ⚠️ 不要改回 `shell32!IsUserAnAdmin` —— 两者语义不同：它问的是「这个账号是不是管理员组成员」，
/// 而这里要的是「这个进程能不能读 $MFT、能不能改系统设置」。
/// 开启 UAC 后普通方式启动的进程带的是**受限令牌**，账号是管理员但进程没有权限，
/// 两个函数在这种机器上会给出相反答案 → 前端提示和「后端实际会不会降级」对不上，
/// 表现就是「功能悄悄退化成慢路径，界面上却没有任何提示」。
///
/// 统一走 `TokenElevation`（和 AI 模型深度发现、大文件/大目录引擎选择用的是同一个判定），
/// 保证「界面看到的权限状态」和「后端的行为」永远来自同一个事实。
pub fn check_admin() -> bool {
    crate::scanner::big_files_engine::mft_core::is_elevated()
}

// ============================================================================
// 状态检测（异步：避免 DISM 阻塞主线程）
// ============================================================================

/// 获取系统瘦身状态。
///
/// **WinSxS 不再参与首屏等待。** DISM 分析在本机是几十秒到几分钟的量级，
/// 以前整条 `get_status` 要等它（30 秒超时才放行），用户看到的就是"检查中"转半分钟。
/// 现在：有缓存就先用（哪怕是上次启动留下的），没有就先标成"分析中"，
/// DISM 跑完通过 `system-slim:winsxs-ready` 事件补推那两项。
pub async fn get_status(window: Window, force_refresh: bool) -> SystemSlimStatus {
    let is_admin = check_admin();

    let winsxs_items = prepare_winsxs_items(&window, is_admin, force_refresh);

    // 其余三项都是毫秒级（读注册表 + metadata），并发跑完即可
    let (hibernation, pagefile, search_index) = tokio::join!(
        async { get_hibernation_status() },
        async { get_pagefile_status() },
        async { get_search_index_status() },
    );

    let mut items = vec![hibernation];
    items.extend(winsxs_items);
    items.push(pagefile);
    items.push(search_index);
    let total_reclaimable = items.iter().filter(|i| i.enabled).map(|i| i.size).sum();

    SystemSlimStatus {
        is_admin,
        items,
        total_reclaimable,
    }
}

/// 组装 WinSxS 两项，并在需要时启动后台分析。
///
/// 数据来源优先级：内存缓存（10 分钟内）→ 磁盘缓存（24 小时内，跨重启）→ 干脆没有。
/// 后两种都会顺带起一次后台分析，结果回来再覆盖。
fn prepare_winsxs_items(
    window: &Window,
    is_admin: bool,
    force_refresh: bool,
) -> Vec<SlimItemStatus> {
    // 用户手动点"重新检测"时必须真的重跑一次，不能拿 10 分钟内的缓存糊弄他 ——
    // 旧行为是"点了没反应、界面像刷新了一下"，就是因为缓存直接命中了。
    // 刷新期间先用现有结论垫着（标 analyzing），新结果到了再覆盖。
    if force_refresh && is_admin {
        let fallback = get_any_cached_winsxs_result().or_else(load_disk_winsxs_cache);
        start_winsxs_analysis(window.clone());

        return match fallback {
            Some(result) => build_winsxs_items(result, true, None),
            None => build_winsxs_items(WinsxsAnalyzeResult::default(), true, None),
        };
    }

    if let Some(result) = get_cached_winsxs_result() {
        return build_winsxs_items(result, false, None);
    }

    let stale = load_disk_winsxs_cache();

    // 没有管理员权限时 DISM 必然失败（错误码 740），不必起进程再等它报错。
    // 但磁盘上 24 小时内的结论仍然值得展示 —— 总比一句"读不到"有用。
    if !is_admin {
        return match stale {
            Some(result) => build_winsxs_items(result, false, None),
            None => build_winsxs_items(WinsxsAnalyzeResult::default(), false, None),
        };
    }

    start_winsxs_analysis(window.clone());

    match stale {
        Some(result) => build_winsxs_items(result, true, None),
        None => build_winsxs_items(WinsxsAnalyzeResult::default(), true, None),
    }
}

/// 后台启动一次 DISM 分析，立刻返回。
///
/// 返回 `true` 表示"现在确实有分析在跑"（本次起的或更早就在跑的），前端据此显示分析中。
fn start_winsxs_analysis(window: Window) -> bool {
    #[cfg(target_os = "windows")]
    {
        // 清理正在独占组件存储：这时候起 analyze 只会和它抢 CBS 会话
        if WINSXS_CLEANUP_ACTIVE.load(Ordering::SeqCst) {
            return false;
        }

        if WINSXS_ANALYZE_RUNNING.swap(true, Ordering::SeqCst) {
            let now = unix_now();
            let started = WINSXS_ANALYZE_STARTED_AT.load(Ordering::Relaxed);
            let age = now.saturating_sub(started);

            // 正常情况：确实有分析在跑（含刚起的那个），本次不重复发起。
            // 异常情况：线程挂起/异常退出没走到解锁，锁会永远不释放 ——
            // 表现就是"点多少次重新检测都没有动静"。超过兜底时间就当作僵死，强制重来。
            if started == 0 || age <= WINSXS_ANALYZE_TIMEOUT_SECS + 60 {
                return true;
            }

            warn!(
                "上次 WinSxS 分析已持续 {} 秒仍未结束，判定为僵死并重新发起",
                age
            );
        }

        WINSXS_ANALYZE_STARTED_AT.store(unix_now(), Ordering::Relaxed);

        // 用 spawn_blocking 而不是 spawn：DISM 是阻塞进程调用，不能占着异步线程。
        // 这里不 await —— 结果通过事件补推，扫描接口提前返回。
        // 进度要推给前端，所以把 handle 一起带进后台线程
        let progress_handle = window.app_handle().clone();

        tokio::task::spawn_blocking(move || {
            let outcome = analyze_winsxs_sync(Some(progress_handle));
            // 先解锁再发事件：分析本身已经结束，后续检查可以立刻复用缓存
            WINSXS_ANALYZE_RUNNING.store(false, Ordering::SeqCst);

            let items = match outcome {
                Ok(result) => {
                    set_cached_winsxs_result(result);
                    build_winsxs_items(result, false, None)
                }
                Err(error) => {
                    warn!("DISM 分析失败，本次不更新组件存储占用: {}", error);
                    // 失败也要推一次：前端收到事件才会把"分析中"的转圈停掉，
                    // 否则它会一直转，用户误以为还在跑。原因一并带上，别让用户干猜。
                    build_winsxs_items(WinsxsAnalyzeResult::default(), false, Some(&error))
                }
            };

            let payload = WinsxsItemsPayload { items };
            if let Err(error) = window.emit("system-slim:winsxs-ready", &payload) {
                warn!("推送 WinSxS 分析结果失败: {}", error);
            }
        });

        true
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        false
    }
}

/// 获取休眠文件状态（通过注册表检测，不依赖 powercfg 编码）
fn get_hibernation_status() -> SlimItemStatus {
    let hibernation_enabled = check_hibernation_enabled();
    let hiberfil_path = std::path::Path::new("C:\\hiberfil.sys");
    let size = if hiberfil_path.exists() {
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
        status_text: if hibernation_enabled {
            "当前已启用休眠和快速启动相关能力".to_string()
        } else {
            "当前已关闭休眠，hiberfil.sys 不再占用系统盘空间".to_string()
        },
        enabled: hibernation_enabled,
        size,
        actionable: true,
        action_text: if hibernation_enabled {
            "关闭休眠".to_string()
        } else {
            "开启休眠".to_string()
        },
        analyzing: false,
    }
}

/// 通过注册表检测休眠功能是否启用（快速、编码无关、不依赖 powercfg）
fn check_hibernation_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::*, RegKey};

        // 主检测：注册表 HibernateEnabled 值（powercfg /hibernate 的权威来源）。
        // 读取成功后必须直接返回，避免旧的 hiberfil.sys 让“已关闭”再次被误判为启用。
        if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\Power", KEY_READ)
        {
            if let Ok(value) = hklm.get_value::<u32, _>("HibernateEnabled") {
                return value == 1;
            }
        }

        // 回退：检查 hiberfil.sys 是否存在
        std::path::Path::new("C:\\hiberfil.sys").exists()
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 把 DISM 分析结果转成两项界面条目。
///
/// `analyzing` 为 true 时表示后台仍在分析：此时如果有上一次的结论就先展示它，
/// 只是前端会打上"分析中"的转圈；如果什么都没有，就直说正在分析、别让用户等一个空白。
/// 截断失败原因：DISM 的输出可能带整段使用说明，界面上只留第一行有效信息。
fn truncate_reason(reason: &str) -> String {
    const MAX_CHARS: usize = 120;

    // 优先取第一行非空内容，DISM 的"Error: 740 ..."就在第一行
    let first_line = reason
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(reason);

    if first_line.chars().count() <= MAX_CHARS {
        return first_line.to_string();
    }

    let head: String = first_line.chars().take(MAX_CHARS).collect();
    format!("{}…", head)
}

fn build_winsxs_items(
    analyze_result: WinsxsAnalyzeResult,
    analyzing: bool,
    failure: Option<&str>,
) -> Vec<SlimItemStatus> {
    let can_estimate = analyze_result.analysis_succeeded;
    let has_reclaimable =
        analyze_result.reclaimable_size > 0 || analyze_result.cleanup_recommended;

    let status_text = if !can_estimate {
        if analyzing {
            "首次分析通常需要 2-3 分钟，这段时间可以先处理其他项目".to_string()
        } else {
            // 把 DISM 自己的失败原因带出来。只说"分析失败"等于让用户和开发者一起猜 ——
            // 常见的是"另一个操作正在进行"（Windows Update 占着组件存储）或权限不足。
            match failure.map(str::trim).filter(|reason| !reason.is_empty()) {
                Some(reason) => format!("未能读取组件存储信息：{}", truncate_reason(reason)),
                None => "未能读取组件存储信息（通常是没有管理员权限，或 DISM 分析失败），以管理员身份重新检测可获取准确占用".to_string(),
            }
        }
    } else if has_reclaimable {
        format!(
            "DISM 建议清理，发现 {} 个可回收组件包",
            analyze_result.reclaimable_packages
        )
    } else {
        "DISM 未发现明确可回收的组件包，当前无需执行组件清理".to_string()
    };
    // 分析中不允许点：结论还没出来，点了只会被后端拒绝（或跑一次重复的清理）。
    let winsxs_actionable = !analyzing && (!can_estimate || has_reclaimable);

    vec![
        SlimItemStatus {
            id: "winsxs".to_string(),
            name: "系统组件存储".to_string(),
            description: "执行 DISM 官方组件清理，释放 WinSxS 中已被替代的旧组件和临时组件数据"
                .to_string(),
            warning: "普通清理等同于 StartComponentCleanup，不会压缩系统更新基线，通常可安全执行"
                .to_string(),
            status_text,
            enabled: has_reclaimable,
            size: analyze_result.reclaimable_size,
            // 检测明确无可回收内容时禁用按钮，避免用户反复执行幂等 DISM 清理产生“还能清”的错觉。
            actionable: winsxs_actionable,
            action_text: if analyzing {
                "分析中…".to_string()
            } else if has_reclaimable {
                "开始清理".to_string()
            } else if !can_estimate {
                "执行清理".to_string()
            } else {
                "无需清理".to_string()
            },
            analyzing,
        },
        SlimItemStatus {
            id: "winsxs_resetbase".to_string(),
            name: "深度清理（ResetBase）".to_string(),
            description:
                "移除所有被替代的旧组件版本，包括普通清理为保留回滚能力而没有删除的部分"
                    .to_string(),
            warning:
                "会一并删除系统更新的回滚版本：执行后，当前已安装的 Windows 更新无法卸载"
                    .to_string(),
            status_text:
                "比普通清理更彻底：普通清理只删可以安全移除的旧版本，深度清理连回滚版本一起删"
                    .to_string(),
            enabled: false,
            size: 0,
            actionable: winsxs_actionable,
            action_text: if analyzing {
                "分析中…".to_string()
            } else if winsxs_actionable {
                "深度清理".to_string()
            } else {
                "无需清理".to_string()
            },
            analyzing,
        },
    ]
}

/// 取内存里的结论，**不看 TTL**：强制刷新时用来给界面垫底，避免数字先消失再出现。
fn get_any_cached_winsxs_result() -> Option<WinsxsAnalyzeResult> {
    WINSXS_ANALYZE_CACHE
        .read()
        .ok()?
        .as_ref()
        .map(|cache| cache.result)
}

fn get_cached_winsxs_result() -> Option<WinsxsAnalyzeResult> {
    let cache = WINSXS_ANALYZE_CACHE.read().ok()?;
    let cached = cache.as_ref()?;
    // WinSxS 可回收大小短时间内不会频繁变化，缓存能避免页面重复打开时反复卡在 DISM 分析。
    if cached.cached_at.elapsed().as_secs() <= WINSXS_CACHE_TTL_SECS {
        return Some(cached.result);
    }
    None
}

/// 记录一次分析结果：内存 + 磁盘都写，下次启动可以直接拿磁盘缓存垫着。
///
/// 只拒绝"分析失败"的结果。**「没有可回收内容」也会缓存** —— 那是最常见的情况，
/// 以前不缓存它，等于每次打开检测页都要重跑一轮 DISM（几十秒），
/// 而清理/压缩动作本身会调 `clear_cached_winsxs_size()` 主动作废，不会出现"清完还显示 0"。
fn set_cached_winsxs_result(result: WinsxsAnalyzeResult) {
    if !result.analysis_succeeded {
        return;
    }

    store_memory_winsxs_result(result);
    save_disk_winsxs_cache(result);
}

/// 只写内存缓存（不含磁盘），单测用它，避免往真实数据目录里写文件。
fn store_memory_winsxs_result(result: WinsxsAnalyzeResult) {
    if let Ok(mut cache) = WINSXS_ANALYZE_CACHE.write() {
        *cache = Some(WinsxsAnalyzeCache {
            result,
            cached_at: std::time::Instant::now(),
        });
    }
}

fn clear_cached_winsxs_size() {
    if let Ok(mut cache) = WINSXS_ANALYZE_CACHE.write() {
        // 清理会改变组件存储状态，必须让下次检查重新分析而不是继续展示旧估算。
        *cache = None;
    }
    // 磁盘缓存同样作废：否则用户清理完重开应用又会读到清理前的大小。
    let path = winsxs_disk_cache_path();
    if path.exists() {
        if let Err(error) = std::fs::remove_file(&path) {
            warn!("删除 WinSxS 磁盘缓存失败: {}", error);
        }
    }
}

/// 磁盘缓存文件：跟着数据目录走，便携版/自定义数据目录都能正确落位。
fn winsxs_disk_cache_path() -> std::path::PathBuf {
    crate::data_dir::get_data_dir().join("system_slim_winsxs.json")
}

fn save_disk_winsxs_cache(result: WinsxsAnalyzeResult) {
    let Some(json) = serialize_disk_cache(result, unix_now()) else {
        return;
    };
    let path = winsxs_disk_cache_path();

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // 缓存写不进去只影响下次启动的成绩，不影响本次结果，因此不往上抛错。
    if let Err(error) = std::fs::write(&path, json) {
        warn!("写入 WinSxS 磁盘缓存失败: {}", error);
    }
}

/// 序列化磁盘缓存。拆成纯函数是为了能直接测"存了再读回来是不是同一个值"。
fn serialize_disk_cache(result: WinsxsAnalyzeResult, now_unix: u64) -> Option<String> {
    serde_json::to_string(&WinsxsDiskCache {
        schema_version: WINSXS_CACHE_SCHEMA,
        result,
        cached_at_unix: now_unix,
    })
    .ok()
}

/// 解析磁盘缓存：失败结果、过期结果都当没有。
fn parse_disk_cache(text: &str, now_unix: u64) -> Option<WinsxsAnalyzeResult> {
    let cache: WinsxsDiskCache = serde_json::from_str(text).ok()?;
    if cache.schema_version != WINSXS_CACHE_SCHEMA {
        return None;
    }
    if !cache.result.analysis_succeeded {
        return None;
    }
    let age = now_unix.saturating_sub(cache.cached_at_unix);
    if age > WINSXS_DISK_CACHE_TTL_SECS {
        return None;
    }
    Some(cache.result)
}

/// 读磁盘缓存。只用来"先显示上次的结果"，因此允许它比内存缓存旧得多。
fn load_disk_winsxs_cache() -> Option<WinsxsAnalyzeResult> {
    let text = std::fs::read_to_string(winsxs_disk_cache_path()).ok()?;
    parse_disk_cache(&text, unix_now())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// 同步运行 dism /analyzecomponentstore（在 spawn_blocking 中调用）。
///
/// DISM 会边跑边打百分比，这里转发给前端：分析是几十秒到几分钟的事，
/// 界面上只有一个转圈的话，用户会以为卡死。
fn analyze_winsxs_sync(handle: Option<AppHandle>) -> Result<WinsxsAnalyzeResult, String> {
    #[cfg(target_os = "windows")]
    {
        let (stdout_bytes, stderr_bytes, success) = run_dism_analyze(handle.as_ref())?;
        let stdout = decode_command_output(&stdout_bytes);
        let stderr = decode_command_output(&stderr_bytes);

        if !success {
            // DISM 的报错（如 "Error: 740 Elevated permissions are required"）写在 stdout 里，
            // 只看 stderr 会得到一条空消息 —— 上一版排查时就卡在这里。
            let detail = if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            };
            return Err(format!("DISM 分析失败: {}", detail));
        }
        Ok(parse_winsxs_analyze_output(&stdout))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = handle;
        Ok(WinsxsAnalyzeResult::default())
    }
}

/// 跑 DISM 分析：一边转发进度，一边做超时兜底。
///
/// stdout / stderr 各用一个线程读，主线程轮询 `try_wait`：
/// 主线程自己也去读管道就没法判超时；只轮询不读，输出超过管道缓冲区（64 KB）时
/// 子进程会卡在写，两边互相等死。DISM 分析输出很小，双线程读是最省心的写法。
#[cfg(target_os = "windows")]
/// 读子进程输出，边读边转发 DISM 的百分比进度。
///
/// **必须按字节读、自己按 `\n` 切行**：`BufRead::lines()` 要求每行都是合法 UTF-8，
/// 遇到非 UTF-8 字节（中文系统下 DISM 用 GBK 输出）就返回 `Err`，
/// 而 `map_while(Result::ok)` 会**静默终止整个读取** —— 表现为"分析成功、可回收 0"。
/// 2026-11-10 那次"明明 CBS 日志写着 Superseded Packages: 2、Cleanup recommended: 1，
/// 界面却显示无需清理"，就是这条链路断在编码上。
fn read_stream_with<F>(mut reader: impl std::io::Read, mut on_line: F) -> Vec<u8>
where
    F: FnMut(&str),
{
    let mut raw = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 8192];

    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };

        raw.extend_from_slice(&buffer[..read]);
        pending.extend_from_slice(&buffer[..read]);

        // 自己按 \n 切行，不要求整行是合法 UTF-8
        while let Some(pos) = pending.iter().position(|&byte| byte == b'\n') {
            let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            on_line(&String::from_utf8_lossy(&line_bytes));
        }
    }

    raw
}

/// 分析专用的读流：把 DISM 的百分比转发成 `system-slim:winsxs-progress`。
fn read_stream(
    reader: impl std::io::Read,
    handle: Option<AppHandle>,
    started_at: std::time::Instant,
) -> Vec<u8> {
    let mut last_percent = 0u32;

    read_stream_with(reader, move |line| {
        if let Some(percent) = parse_dism_progress(line) {
            if percent > last_percent {
                last_percent = percent;
                if let Some(handle) = &handle {
                    // 发失败（比如窗口已关）不影响分析本身
                    let _ = handle.emit(
                        "system-slim:winsxs-progress",
                        &WinsxsAnalyzeProgress {
                            percent: percent.min(100) as u8,
                            elapsed_ms: started_at.elapsed().as_millis() as u64,
                        },
                    );
                }
            }
        }
    })
}

fn run_dism_analyze(handle: Option<&AppHandle>) -> Result<(Vec<u8>, Vec<u8>, bool), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let started_at = std::time::Instant::now();

    let mut child = Command::new("cmd")
        .args([
            "/C",
            // `/english` 让 DISM 用英文输出：解析器只认一套文案，
            // 不必为每种系统语言维护一份关键词表（中文的"建议执行组件存储清理"就和
            // "建议清理"对不上，线上因此漏判过）。
            "dism.exe /english /online /cleanup-image /analyzecomponentstore",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("执行 DISM 失败: {}", e))?;

    // 记录 pid：清理开始时需要把它结束掉（两个 DISM 不能同时操作组件存储）
    WINSXS_ANALYZE_PID.store(child.id(), Ordering::SeqCst);

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 DISM 输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取 DISM 错误输出".to_string())?;

    let progress_handle = handle.cloned();
    let stdout_thread =
        std::thread::spawn(move || read_stream(stdout, progress_handle, started_at));
    let stderr_thread = std::thread::spawn(move || read_stream(stderr, None, started_at));

    let deadline = started_at + std::time::Duration::from_secs(WINSXS_ANALYZE_TIMEOUT_SECS);
    let mut timed_out = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return Err(format!("等待 DISM 结束失败: {}", error));
            }
        }

        if std::time::Instant::now() >= deadline {
            // analyzecomponentstore 是只读的，kill 掉不会留下半完成的组件存储
            let _ = child.kill();
            timed_out = true;
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(150));
    }

    let status = child
        .wait()
        .map_err(|e| format!("回收 DISM 进程失败: {}", e))?;
    WINSXS_ANALYZE_PID.store(0, Ordering::SeqCst);

    let stdout_text = stdout_thread.join().unwrap_or_default();
    let stderr_text = stderr_thread.join().unwrap_or_default();

    if timed_out {
        return Err(format!(
            "DISM 分析超过 {} 秒仍未返回",
            WINSXS_ANALYZE_TIMEOUT_SECS
        ));
    }

    Ok((stdout_text, stderr_text, status.success()))
}

fn parse_winsxs_analyze_output(output: &str) -> WinsxsAnalyzeResult {
    let mut result = WinsxsAnalyzeResult {
        analysis_succeeded: true,
        ..WinsxsAnalyzeResult::default()
    };
    // 关键结论行（可回收包数 / 是否建议清理）至少要认出一行，否则就是解析失败。
    // 少了这个自检，空输出会被当成"成功且 0 可回收"，界面显示"无需清理" —— 2026-11-10 就这个坑。
    let mut saw_verdict = false;

    for line in output.lines() {
        let normalized = line.trim().to_lowercase();

        if is_winsxs_reclaimable_size_line(&normalized) {
            if let Some(size_bytes) = parse_size_from_line(&normalized) {
                result.reclaimable_size = result.reclaimable_size.saturating_add(size_bytes);
            }
        }

        if normalized.contains("number of reclaimable packages")
            || normalized.contains("reclaimable packages")
            || normalized.contains("可回收的程序包")
            || normalized.contains("可回收程序包")
            || normalized.contains("可回收的组件包")
        {
            saw_verdict = true;
            if let Some(count) = parse_first_integer(&normalized) {
                result.reclaimable_packages = count;
            }
        }

        if normalized.contains("cleanup recommended")
            || normalized.contains("建议清理")
            || normalized.contains("推荐清理")
            // 中文 DISM 的真实文案是"建议执行组件存储清理"，不含连续的"建议清理"四个字，
            // 只按字面匹配会漏判 —— 必须允许"建议……清理"这种中间插字的形式。
            || (normalized.contains("建议") && normalized.contains("清理"))
        {
            saw_verdict = true;
            if let Some(flag) = parse_yes_no(&normalized) {
                result.cleanup_recommended = flag;
            }
        }
    }

    if !saw_verdict {
        result.analysis_succeeded = false;
    }

    result
}

/// 从 "标签 : 是/否"、"Label : Yes/No" 里取值。
///
/// 不能用 `contains("是")` 判断 —— "是否建议清理"这种写法里"是"恒成立，结论会永远是"建议清理"。
fn parse_yes_no(line: &str) -> Option<bool> {
    let value = line.rsplit(|c: char| c == ':' || c == '：').next()?.trim();

    if value.starts_with('是') || value.starts_with("yes") || value.starts_with("true") {
        return Some(true);
    }
    if value.starts_with('否') || value.starts_with("no") || value.starts_with("false") {
        return Some(false);
    }

    None
}

fn is_winsxs_reclaimable_size_line(line: &str) -> bool {
    // DISM 的可回收估算由“备份和已禁用功能”与“缓存和临时数据”组成；
    // 不使用 WinSxS 总大小，避免把组件存储硬链接体积误算为可释放空间。
    line.contains("backups and disabled features")
        || line.contains("cache and temporary data")
        || line.contains("备份")
        || line.contains("已禁用")
        || line.contains("缓存和临时")
}

/// 从大小字符串解析字节数，支持 "3.50 GB"、"500 MB"、"12 KB" 等格式
fn parse_size_from_line(line: &str) -> Option<u64> {
    let line = line.to_lowercase();
    let mut value: Option<f64> = None;
    let mut unit_multiplier = 1024.0 * 1024.0;

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
                    unit_multiplier = 1024.0 * 1024.0 * 1024.0;
                    break;
                } else if rest.trim_start().starts_with("mb") {
                    unit_multiplier = 1024.0 * 1024.0;
                    break;
                } else if rest.trim_start().starts_with("kb") {
                    unit_multiplier = 1024.0;
                    break;
                }
            }
        }
    }

    value.map(|v| (v * unit_multiplier) as u64)
}

fn parse_first_integer(line: &str) -> Option<u32> {
    let bytes = line.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b.is_ascii_digit() {
            let mut end = i;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            return std::str::from_utf8(&bytes[i..end])
                .ok()?
                .parse::<u32>()
                .ok();
        }
    }
    None
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
            other_drive_paths.push(format!("{} ({})", cfg.path, format_bytes(actual_size)));
        }
    }

    let is_on_c_drive = c_drive_size > 0;
    let total_size = if is_on_c_drive {
        c_drive_size
    } else {
        other_drive_size
    };

    // 构建描述文本
    let description = if pagefile_configs.is_empty()
        || pagefile_configs.len() == 1
            && pagefile_configs
                .first()
                .map_or(false, |c| c.path.to_lowercase().starts_with("c:"))
        || pagefile_configs.is_empty()
    {
        let loc_text = if pagefile_configs.is_empty() {
            "系统管理".to_string()
        } else {
            c_drive_paths
                .first()
                .cloned()
                .unwrap_or("系统管理".to_string())
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
        status_text: if is_on_c_drive {
            "检测到 C 盘分页文件，可按需迁移到其他磁盘".to_string()
        } else if pagefile_configs.is_empty() {
            "当前由系统自动管理，未读取到固定分页文件配置".to_string()
        } else {
            "C 盘未检测到分页文件，无需迁移".to_string()
        },
        enabled: is_on_c_drive,
        size: total_size,
        actionable: is_on_c_drive,
        action_text: if is_on_c_drive {
            "打开系统设置".to_string()
        } else {
            "无需操作".to_string()
        },
        analyzing: false,
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
///
/// 直接用 winreg 读 `PagingFiles`（REG_MULTI_SZ），不再起 `reg.exe` 子进程：
/// 省掉一次进程启动（实测 100-300ms，杀软环境下更久），也避开了"按 UTF-8 解码
/// reg 的控制台输出"这个坑 —— 非 UTF-8 代码页下中文路径会变成乱码。
fn get_pagefile_configs() -> Vec<PagefileConfig> {
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::*, RegKey};

        let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
            r"System\CurrentControlSet\Control\Session Manager\Memory Management",
            KEY_READ,
        ) else {
            return vec![];
        };

        let Ok(raw) = key.get_raw_value("PagingFiles") else {
            return vec![];
        };

        parse_pagefile_entries(&decode_reg_multi_sz(&raw.bytes))
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![]
    }
}

/// 解码 REG_MULTI_SZ：UTF-16LE 字符串，项之间用单个 `\0` 分隔，末尾双 `\0`。
fn decode_reg_multi_sz(bytes: &[u8]) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();

    for pair in bytes.chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        if unit == 0 {
            // 连续两个 0 表示列表结束；单个 0 只是分隔符。
            if current.is_empty() {
                break;
            }
            items.push(std::mem::take(&mut current));
        } else {
            // 路径里不会有代理对，遇到代理项按替换字符处理，不至于整条丢掉。
            current.push(char::from_u32(unit as u32).unwrap_or('\u{FFFD}'));
        }
    }

    if !current.is_empty() {
        items.push(current);
    }

    items
}

/// 解析单条分页文件配置：`C:\pagefile.sys 2048 4096`（后两个数字可省略）。
///
/// 只有路径没有数字时表示"由系统管理大小"，此时大小留 0 交给 `metadata` 去读实际文件。
fn parse_pagefile_entries(entries: &[String]) -> Vec<PagefileConfig> {
    entries
        .iter()
        .filter_map(|entry| {
            let tokens: Vec<&str> = entry.split_whitespace().collect();
            let path = tokens.first()?.trim_end_matches(',');

            // 只认盘符绝对路径；空值或 "*" 之类的占位符跳过。
            if path.len() < 3 || &path.as_bytes()[1..3] != b":\\" {
                return None;
            }

            let size_mb = |index: usize| -> u64 {
                tokens
                    .get(index)
                    .map(|token| token.trim_end_matches(','))
                    .and_then(|token| token.parse::<u64>().ok())
                    .unwrap_or(0)
            };

            Some(PagefileConfig {
                path: path.to_string(),
                initial_size: size_mb(1) * 1024 * 1024, // MB → 字节
                max_size: size_mb(2) * 1024 * 1024,
            })
        })
        .collect()
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

#[cfg(target_os = "windows")]
fn run_powercfg_hibernation_command(mode: &str) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // 休眠配置应直接交给 powercfg.exe，避免经过 cmd 后命令解析或代码页切换影响状态变更。
    Command::new("powercfg.exe")
        .args(["/hibernate", mode])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| format!("执行 powercfg 失败: {}", e))
}

#[cfg(target_os = "windows")]
fn wait_for_hibernation_disabled() -> bool {
    let hiberfil_path = std::path::Path::new("C:\\hiberfil.sys");

    // powercfg 删除系统文件可能需要短暂时间，轮询可以避免成功后立即重检造成误报。
    for _ in 0..20 {
        if !check_hibernation_enabled() && !hiberfil_path.exists() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    false
}

#[cfg(target_os = "windows")]
fn decode_command_output(raw: &[u8]) -> String {
    // DISM 输出按 UTF-8 解码（命令前已经 chcp 65001）；
    // 这里保留 lossy 回退，避免异常字节导致错误信息丢失。
    String::from_utf8_lossy(raw).into_owned()
}

/// 当前正在运行的 DISM 进程 id。
///
/// 中文说明：DISM 是独立进程，程序被强制关闭后它会继续在后台跑完，用户既看不到进度、
/// 也不知道系统仍在改动。这里记录 pid，下次启动或发起新的清理前先把它结束掉，
/// 避免留下"看不见的组件清理"。
static RUNNING_DISM_PROCESS_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 清理期间的独占标记。
///
/// DISM 的 `analyzecomponentstore` 和 `startcomponentcleanup` 不能同时在跑：
/// 后启动的那个会拿到 `0x800f0806`（另一个操作正在进行）。
/// 清理开始时先叫停分析，清理期间不再起新的分析。
static WINSXS_CLEANUP_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 正在跑的 analyze 进程 id，清理开始前要把它结束掉。
static WINSXS_ANALYZE_PID: AtomicU32 = AtomicU32::new(0);

/// 清理期间独占组件存储；`Drop` 时自动解除，函数中途 return 也不会漏复位。
struct WinsxsCleanupGuard;

impl WinsxsCleanupGuard {
    fn acquire() -> Self {
        WINSXS_CLEANUP_ACTIVE.store(true, Ordering::SeqCst);
        terminate_running_analysis();
        Self
    }
}

impl Drop for WinsxsCleanupGuard {
    fn drop(&mut self) {
        WINSXS_CLEANUP_ACTIVE.store(false, Ordering::SeqCst);
    }
}

/// 结束正在跑的 analyze 进程（如果有）。
#[cfg(target_os = "windows")]
fn terminate_running_analysis() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let pid = WINSXS_ANALYZE_PID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return;
    }

    // analyzecomponentstore 是只读的，中途结束不会破坏组件存储
    let _ = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .output();
    warn!("清理开始前结束了正在进行的 WinSxS 分析进程 (pid {})", pid);
}

#[cfg(not(target_os = "windows"))]
fn terminate_running_analysis() {}

/// 结束上一次残留的 DISM 进程（如果有）。
///
/// 中文说明：只结束我们自己启动、且仍在运行的那个 pid，不会误伤用户在命令行手动执行的 DISM。
#[cfg(target_os = "windows")]
fn terminate_previous_dism_process() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let previous_pid = RUNNING_DISM_PROCESS_ID.swap(0, Ordering::SeqCst);
    if previous_pid == 0 {
        return;
    }

    // 进程可能已经自然结束，taskkill 对不存在的 pid 会返回非零，这里不当作错误处理。
    let result = Command::new("taskkill.exe")
        .args(["/PID", &previous_pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .output();
    match result {
        Ok(output) if output.status.success() => {
            warn!("已结束后台残留的 DISM 清理进程 (pid {})", previous_pid);
        }
        Ok(_) => {}
        Err(error) => warn!("结束残留 DISM 进程失败 (pid {}): {}", previous_pid, error),
    }
}

/// 程序启动时的检查点：**有意什么都不做**。
///
/// `RUNNING_DISM_PROCESS_ID` 是进程内静态变量，重启后必然是 0 ——
/// 这里根本拿不到"上次那个 DISM"的 pid，之前写成 `terminate_previous_dism_process()`
/// 其实一次都没生效过（它读到的永远是 0，直接 return）。
///
/// 换一个角度也不该在这里杀：用户强关程序时 DISM 会继续把这次清理跑完
/// （子进程独立于父进程），让它自然结束最安全；DISM 改动组件存储的**中途**被结束，
/// 才可能留下需要系统回滚的中间状态 —— 那正是我们最该避免的事。
///
/// 如果它真的卡死，后果只是下一次清理报 `0x800f0806`（另一个操作正在进行），
/// 用户重试即可，不值得在启动路径上冒这个险。
pub fn cleanup_orphan_dism_process() {
    // 故意留空，原因见上面的文档注释。
}

// ============================================================================
// 操作执行
// ============================================================================

/// 关闭休眠功能（异步执行并推送进度）。
///
/// 中文说明：powercfg 关闭休眠后还要等待系统删除 hiberfil.sys（大文件，可能需要一两秒），
/// 同步执行会把主线程卡住、界面完全没有反馈；这里改为 spawn_blocking + 进度事件。
pub async fn disable_hibernation_with_progress(window: &Window) -> Result<String, String> {
    run_hibernation_toggle(window, false).await
}

/// 开启休眠功能（异步执行并推送进度）。
pub async fn enable_hibernation_with_progress(window: &Window) -> Result<String, String> {
    run_hibernation_toggle(window, true).await
}

/// 休眠开关的统一实现：关闭时轮询等待 hiberfil.sys 释放，并把等待过程报给前端。
async fn run_hibernation_toggle(window: &Window, enable: bool) -> Result<String, String> {
    if !check_admin() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }

    let started_at = std::time::Instant::now();
    let item_id = "hibernation";
    let item_label = if enable { "开启休眠" } else { "关闭休眠" };

    emit_slim_progress(
        window,
        item_id,
        "preparing",
        &format!("正在{}...", item_label),
        10,
        "running",
        started_at,
    );

    let progress_window = window.clone();
    let result = tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let mode = if enable { "on" } else { "off" };
            let output = run_powercfg_hibernation_command(mode)?;

            if !output.status.success() {
                return Err(format!(
                    "{}失败: {}",
                    item_label,
                    decode_command_output(&output.stderr).trim()
                ));
            }

            emit_slim_progress(
                &progress_window,
                item_id,
                "waiting",
                if enable {
                    "命令已执行，正在确认系统状态..."
                } else {
                    // 删除 hiberfil.sys 需要时间，明确告诉用户在等什么，避免误以为卡死。
                    "命令已执行，正在等待系统释放 hiberfil.sys（文件较大，通常需要几秒）..."
                },
                70,
                "running",
                started_at,
            );

            let confirmed = if enable {
                check_hibernation_enabled()
            } else {
                wait_for_hibernation_disabled()
            };
            Ok::<bool, String>(confirmed)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = progress_window;
            Err("此功能仅支持 Windows 系统".to_string())
        }
    })
    .await
    .map_err(|error| format!("任务执行失败: {}", error))?
    .map(|confirmed| {
        (
            confirmed,
            if enable {
                "休眠功能已成功开启"
            } else {
                "休眠功能已成功关闭，hiberfil.sys 文件将被删除"
            },
            if enable {
                "休眠状态尚未更新，请重新检测后再试"
            } else {
                "关闭休眠命令已返回成功，但 hiberfil.sys 仍未释放，请重新检测后再试"
            },
        )
    })?;

    let (confirmed, success_message, failure_message) = result;
    if confirmed {
        emit_slim_progress(
            window,
            item_id,
            "done",
            if enable { "休眠已开启" } else { "休眠已关闭" },
            100,
            "done",
            started_at,
        );
        info!("{}完成", item_label);
        Ok(success_message.to_string())
    } else {
        emit_slim_progress(
            window,
            item_id,
            "error",
            failure_message,
            100,
            "error",
            started_at,
        );
        Err(failure_message.to_string())
    }
}

/// 清理 WinSxS 组件存储（异步执行，实时推送进度）
pub async fn cleanup_winsxs(window: &Window) -> Result<String, String> {
    run_winsxs_cleanup(window, false).await
}

/// 深度清理 WinSxS 组件存储（ResetBase 会移除更新回滚基线）
pub async fn cleanup_winsxs_resetbase(window: &Window) -> Result<String, String> {
    run_winsxs_cleanup(window, true).await
}

async fn run_winsxs_cleanup(window: &Window, reset_base: bool) -> Result<String, String> {
    if !check_admin() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        // 独占组件存储：叫停正在跑的分析，并在本次清理结束前不再起新的
        let _cleanup_guard = WinsxsCleanupGuard::acquire();

        info!("开始清理 WinSxS 组件存储，ResetBase: {}", reset_base);

        // 先结束上一次可能残留的 DISM，避免两个清理进程同时改动组件存储。
        terminate_previous_dism_process();

        let started_at = std::time::Instant::now();
        let item_id = if reset_base { "winsxs_resetbase" } else { "winsxs" };
        // DISM 清理耗时可能从几十秒到十几分钟，首条进度必须说明"这一步很慢"，否则用户会以为卡死。
        emit_slim_progress(
            window,
            item_id,
            "preparing",
            if reset_base {
                "正在准备组件基线压缩。该步骤可能持续数分钟，请保持程序运行..."
            } else {
                "正在准备组件存储清理。该步骤可能持续数分钟，请保持程序运行..."
            },
            0,
            "running",
            started_at,
        );

        let handle = window.app_handle().clone();

        let result = tokio::task::spawn_blocking(move || {
            let mut dism_args = vec![
                "/english",
                "/online",
                "/cleanup-image",
                "/startcomponentcleanup",
            ];
            if reset_base {
                dism_args.push("/resetbase");
            }

            let mut child = Command::new("dism.exe")
                .args(&dism_args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000)
                .spawn()?;

            // 记录 pid：程序被强制关闭后，下次启动可以结束这个残留进程。
            RUNNING_DISM_PROCESS_ID.store(child.id(), Ordering::SeqCst);

            let stdout = child.stdout.take().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::Other, "无法读取 DISM 输出")
            })?;
            let stderr = child.stderr.take().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::Other, "无法读取 DISM 错误输出")
            })?;

            // stdout 交给独立线程读：主线程要等进程结束，两边不能抢同一个管道。
            // 这里和 analyze 共用 read_stream_with，按字节读 —— 中文系统下 DISM 输出是 GBK，
            // 用 BufRead::lines() 会整行解码失败，进度条就再也不动。
            let progress_handle = handle.clone();
            let stdout_thread = std::thread::spawn(move || {
                let mut last_progress = 0u32;
                read_stream_with(stdout, move |line| {
                    if let Some(pct) = parse_dism_progress(line) {
                        if pct > last_progress {
                            last_progress = pct;
                            let _ = progress_handle.emit(
                                "system-slim:progress",
                                &SlimOperationProgress {
                                    item_id: item_id.to_string(),
                                    phase: "running".to_string(),
                                    message: format!("正在处理组件存储: {}%", pct),
                                    percent: pct.min(100) as u8,
                                    status: "running".to_string(),
                                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                                },
                            );
                        }
                    }
                })
            });
            let stderr_thread = std::thread::spawn(move || read_stream_with(stderr, |_| {}));

            let status = child.wait()?;
            // 进程已结束，清掉 pid，避免下次启动或下一次清理去杀一个不存在的进程。
            RUNNING_DISM_PROCESS_ID.store(0, Ordering::SeqCst);

            let stdout_bytes = stdout_thread.join().unwrap_or_default();
            let stderr_bytes = stderr_thread.join().unwrap_or_default();
            let success = status.success();

            Ok::<(Vec<u8>, Vec<u8>, bool), std::io::Error>((stdout_bytes, stderr_bytes, success))
        })
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
        .map_err(|e| format!("执行 DISM 命令失败: {}", e))?;

        let (stdout_bytes, stderr_bytes, success) = result;

        if success {
            info!("WinSxS 清理完成，ResetBase: {}", reset_base);
            clear_cached_winsxs_size();
            emit_slim_progress(
                window,
                item_id,
                "done",
                if reset_base {
                    "组件基线压缩完成"
                } else {
                    "组件存储清理完成"
                },
                100,
                "done",
                started_at,
            );
            if reset_base {
                Ok("组件基线压缩完成，当前已安装的 Windows 更新将无法卸载".to_string())
            } else {
                Ok("系统组件存储清理完成".to_string())
            }
        } else {
            // 两个流都看：DISM 的 "Error: 740 ..." 写在 stdout，部分版本写 stderr。
            // 只取一路会得到一条空消息（旧实现就丢过一次）。
            let stderr = decode_command_output(&stderr_bytes);
            let stdout = decode_command_output(&stdout_bytes);
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };

            emit_slim_progress(
                window,
                item_id,
                "error",
                &format!("清理失败: {}", detail),
                0,
                "error",
                started_at,
            );
            Err(format!("清理失败: {}", detail))
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
            let end = bytes[i..].iter().position(|&c| c == b'%').map(|p| i + p);
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

// ============================================================================
// Windows 搜索索引（Windows.db 膨胀时重建，官方 SearchManager COM 接口）
// ============================================================================

/// Windows Search 服务状态
#[derive(Debug, Clone, Copy, PartialEq)]
enum SearchServiceState {
    Running,
    Stopped,
    Disabled,
    NotInstalled,
}

/// 查询 Windows Search 服务状态（服务控制管理器 + 注册表启动类型）
fn get_wsearch_service_state() -> SearchServiceState {
    use winapi::um::winsvc::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_MANAGER_CONNECT,
        SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
    };

    #[cfg(target_os = "windows")]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        // 注册表启动类型：4 = 已禁用，禁用状态下无法通过 COM 调用重建接口
        let start_disabled = {
            use winreg::{enums::*, RegKey};
            if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
                r"SYSTEM\CurrentControlSet\Services\WSearch",
                KEY_READ,
            ) {
                key.get_value::<u32, _>("Start")
                    .map(|v| v == 4)
                    .unwrap_or(false)
            } else {
                false
            }
        };
        if start_disabled {
            return SearchServiceState::Disabled;
        }

        let scm = OpenSCManagerW(std::ptr::null_mut(), std::ptr::null_mut(), SC_MANAGER_CONNECT);
        if scm.is_null() {
            return SearchServiceState::NotInstalled;
        }

        let service_name: Vec<u16> = std::ffi::OsStr::new("WSearch")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let service = OpenServiceW(scm, service_name.as_ptr(), SERVICE_QUERY_STATUS);
        if service.is_null() {
            CloseServiceHandle(scm);
            return SearchServiceState::NotInstalled;
        }

        let mut status: SERVICE_STATUS = std::mem::zeroed();
        let ok = QueryServiceStatus(service, &mut status);
        CloseServiceHandle(service);
        CloseServiceHandle(scm);

        if ok == 0 {
            return SearchServiceState::Stopped;
        }
        match status.dwCurrentState {
            SERVICE_RUNNING => SearchServiceState::Running,
            _ => SearchServiceState::Stopped,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        SearchServiceState::NotInstalled
    }
}

/// Windows 搜索索引数据库路径（默认位于 ProgramData，实际路径跟随环境变量）
fn search_index_db_path() -> Option<std::path::PathBuf> {
    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    let path = std::path::Path::new(&program_data)
        .join(r"Microsoft\Search\Data\Applications\Windows\Windows.db");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// 获取搜索索引瘦身项状态
/// 注意：不把数据库大小计入可回收总量（size 仅用于展示），因为重建后索引会重新生成。
fn get_search_index_status() -> SlimItemStatus {
    let service_state = get_wsearch_service_state();
    let db_size = search_index_db_path()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    let (actionable, action_text, status_text) = match service_state {
        SearchServiceState::Running => (
            true,
            "重建索引".to_string(),
            format!(
                "Windows Search 服务运行中，索引数据库约 {}",
                format_bytes(db_size)
            ),
        ),
        SearchServiceState::Stopped => (
            false,
            "服务未运行".to_string(),
            "Windows Search 服务已停止，启动服务后可重建索引".to_string(),
        ),
        SearchServiceState::Disabled => (
            false,
            "服务已禁用".to_string(),
            "Windows Search 服务已被禁用，无法重建索引".to_string(),
        ),
        SearchServiceState::NotInstalled => (
            false,
            "未安装搜索服务".to_string(),
            "未检测到 Windows Search 服务".to_string(),
        ),
    };

    SlimItemStatus {
        id: "search_index".to_string(),
        name: "Windows 搜索索引".to_string(),
        description:
            "Windows 搜索索引数据库（Windows.db）异常膨胀时，重建可释放数 GB 空间，重建在后台进行"
                .to_string(),
        warning:
            "重建期间搜索结果可能不完整，重建需数小时且会重新索引全部文件；膨胀问题可能再次出现"
                .to_string(),
        status_text,
        enabled: false,
        size: db_size,
        actionable,
        action_text,
        analyzing: false,
    }
}

/// 重建 Windows 搜索索引（通过官方 SearchManager COM 接口，与系统"索引选项"中的重建等效）
pub fn rebuild_search_index() -> Result<String, String> {
    if !check_admin() {
        return Err("需要管理员权限才能执行此操作，请以管理员身份运行程序".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        };
        use windows::Win32::System::Search::{
            CatalogPausedReason, CatalogStatus, CSearchManager, ISearchManager,
            CATALOG_STATUS_FULL_CRAWL, CATALOG_STATUS_RECOVERING,
        };

        info!("开始重建 Windows 搜索索引...");

        // COM 初始化：S_OK(0) 表示本次初始化成功，结束时需 CoUninitialize；
        // S_FALSE(1) / RPC_E_CHANGED_MODE 表示线程已有 COM 状态，直接复用。
        let co_result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let mut need_uninitialize = false;
        match co_result.0 {
            0 => need_uninitialize = true,
            1 => {}
            code if code == RPC_E_CHANGED_MODE.0 => {}
            code => {
                return Err(format!("COM 初始化失败: 0x{:08X}", code as u32));
            }
        }

        // 索引已在重建/恢复时直接返回提示，避免重复触发
        let mut already_rebuilding = false;
        let rebuild_result = (|| -> windows::core::Result<()> {
            // CSearchManager 为 SearchAPI.dll 中 SearchManager coclass 的 CLSID
            let manager: ISearchManager =
                unsafe { CoCreateInstance(&CSearchManager, None, CLSCTX_ALL)? };
            let catalog = unsafe { manager.GetCatalog(&HSTRING::from("SystemIndex")) }?;

            let mut status = CatalogStatus::default();
            let mut paused_reason = CatalogPausedReason::default();
            unsafe { catalog.GetCatalogStatus(&mut status, &mut paused_reason) }?;
            if status == CATALOG_STATUS_FULL_CRAWL || status == CATALOG_STATUS_RECOVERING {
                already_rebuilding = true;
                return Ok(());
            }

            unsafe { catalog.Reindex() }
        })();

        if need_uninitialize {
            unsafe { CoUninitialize() };
        }

        match rebuild_result {
            Ok(()) if already_rebuilding => {
                Err("搜索索引正在重建中，请稍后再试".to_string())
            }
            Ok(()) => {
                info!("搜索索引重建已启动");
                Ok("已开始重建 Windows 搜索索引，重建在后台进行，完成后搜索结果将恢复正常"
                    .to_string())
            }
            Err(e) => Err(format!(
                "重建索引失败: {}（请确认 Windows Search 服务已启用）",
                e.message()
            )),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("此功能仅支持 Windows 系统".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dism_progress_percentages() {
        // DISM 的输出形如 "[==========35.5%==========          ]"，必须能取出百分比。
        assert_eq!(parse_dism_progress("[==========35.5%==========          ]"), Some(35));
        assert_eq!(parse_dism_progress("[===========================85.0%==================        ]"), Some(85));
        assert_eq!(parse_dism_progress("[100.0%]"), Some(100));
        // 没有百分比的行（普通日志）不应被误判为进度。
        assert_eq!(parse_dism_progress("Deployment Image Servicing and Management tool"), None);
        assert_eq!(parse_dism_progress(""), None);
    }

    #[test]
    fn parses_whole_and_fractional_percentages() {
        // DISM 不同版本会给 "35.5%" 或 "35%" 两种写法，都要能解析。
        assert_eq!(parse_dism_progress("[===== 7% =====]"), Some(7));
        assert_eq!(parse_dism_progress("[===== 7.9% =====]"), Some(7));
    }

    #[test]
    fn caches_successful_analysis_but_not_failures() {
        // 成功结果（包括"没有可回收内容"）都要缓存：0 是最常见的情况，不缓存等于每次
        // 打开检测页都重跑一轮 DISM。清理动作会调 clear_cached_winsxs_size() 主动作废。
        *WINSXS_ANALYZE_CACHE.write().unwrap() = None;

        store_memory_winsxs_result(WinsxsAnalyzeResult {
            reclaimable_size: 1024,
            cleanup_recommended: true,
            reclaimable_packages: 3,
            analysis_succeeded: true,
        });
        assert_eq!(
            get_cached_winsxs_result().map(|result| result.reclaimable_size),
            Some(1024)
        );

        store_memory_winsxs_result(WinsxsAnalyzeResult {
            reclaimable_size: 0,
            cleanup_recommended: false,
            reclaimable_packages: 0,
            analysis_succeeded: true,
        });
        assert_eq!(
            get_cached_winsxs_result().map(|result| result.reclaimable_size),
            Some(0),
            "0 可回收也是有效结论，必须缓存"
        );

        // 分析失败不覆盖已有缓存：上次的结论比"什么都没有"更有用
        store_memory_winsxs_result(WinsxsAnalyzeResult {
            reclaimable_size: 1024,
            cleanup_recommended: true,
            reclaimable_packages: 3,
            analysis_succeeded: true,
        });
        set_cached_winsxs_result(WinsxsAnalyzeResult::default());
        assert_eq!(
            get_cached_winsxs_result().map(|result| result.reclaimable_size),
            Some(1024),
            "失败结果不能覆盖成功结果"
        );

        *WINSXS_ANALYZE_CACHE.write().unwrap() = None;
    }

    #[test]
    fn disk_cache_round_trips_and_stops_being_usable_when_stale() {
        let result = WinsxsAnalyzeResult {
            reclaimable_size: 2 * 1024 * 1024 * 1024,
            cleanup_recommended: true,
            reclaimable_packages: 7,
            analysis_succeeded: true,
        };

        let json = serialize_disk_cache(result, 1_000).expect("应可序列化");
        let parsed = parse_disk_cache(&json, 1_500).expect("未过期应能读回");
        assert_eq!(parsed.reclaimable_size, result.reclaimable_size);
        assert_eq!(parsed.reclaimable_packages, 7);

        // 超过磁盘 TTL 后不再拿来展示，避免把好几天前的结论当成现状
        let too_old = 1_000 + WINSXS_DISK_CACHE_TTL_SECS + 1;
        assert!(parse_disk_cache(&json, too_old).is_none(), "过期缓存应被丢弃");

        // 分析失败的结果即使刚写进去也不认
        let failed = serialize_disk_cache(WinsxsAnalyzeResult::default(), 1_000).unwrap();
        assert!(parse_disk_cache(&failed, 1_000).is_none());

        assert!(parse_disk_cache("not json", 1_000).is_none());
    }

    #[test]
    fn decodes_multi_sz_pagefile_list() {
        // REG_MULTI_SZ 是 UTF-16LE：项之间单 \0，末尾双 \0
        let mut bytes = Vec::new();
        for entry in [r"C:\pagefile.sys 2048 4096", r"D:\pagefile.sys 1024 1024"] {
            for unit in entry.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes.extend_from_slice(&0u16.to_le_bytes());
        }
        bytes.extend_from_slice(&0u16.to_le_bytes());

        let entries = decode_reg_multi_sz(&bytes);
        assert_eq!(entries.len(), 2);
        assert!(entries[0].starts_with(r"C:\pagefile.sys"));
        assert!(entries[1].starts_with(r"D:\pagefile.sys"));

        // 空值（全 0）应得到空列表，而不是一个空字符串项
        assert!(decode_reg_multi_sz(&[0, 0, 0, 0]).is_empty());
    }

    #[test]
    fn parses_pagefile_entries_with_and_without_sizes() {
        let entries = vec![
            r"C:\pagefile.sys 2048 4096".to_string(),
            r"D:\pagefile.sys".to_string(),
            // 非盘符路径、占位符都要跳过
            "".to_string(),
            "*".to_string(),
        ];
        let configs = parse_pagefile_entries(&entries);

        assert_eq!(configs.len(), 2);
        assert_eq!(configs[0].max_size, 4096 * 1024 * 1024);
        // 没写数字 = 系统管理大小，大小留 0 交给实文件读取
        assert_eq!(configs[1].max_size, 0);
    }

    #[test]
    fn parses_english_and_chinese_analyze_reports() {
        // 英文（加 /english 后的实际输出形态）
        let english = "Number of Reclaimable Packages : 2\n\
                       Component Store Cleanup Recommended : Yes\n\
                           Backups and Disabled Features : 4.46 GB\n";
        let result = parse_winsxs_analyze_output(english);
        assert!(result.analysis_succeeded);
        assert_eq!(result.reclaimable_packages, 2);
        assert!(result.cleanup_recommended);
        assert!(result.reclaimable_size > 4 * 1024 * 1024 * 1024);

        // 中文：标签是"建议执行组件存储清理"，中间插了"执行组件存储"，
        // 只按 contains("建议清理") 匹配会漏判 —— 真机上因此显示过"无需清理"。
        let chinese = "可回收的程序包数 : 2\n\
                       建议执行组件存储清理 : 是\n\
                           备份和禁用的组件 : 4.46 GB\n";
        let result = parse_winsxs_analyze_output(chinese);
        assert!(result.analysis_succeeded);
        assert_eq!(result.reclaimable_packages, 2);
        assert!(result.cleanup_recommended, "「建议执行组件存储清理 : 是」必须判为建议清理");
    }

    #[test]
    fn unparseable_report_is_not_reported_as_clean() {
        // 空输出 / 错误输出不能当成"成功且 0 可回收"—— 那会让界面显示"无需清理"，
        // 用户会以为扫过了确实没有。必须判为分析失败。
        assert!(!parse_winsxs_analyze_output("").analysis_succeeded);
        assert!(!parse_winsxs_analyze_output("Error: 740 Elevated permissions").analysis_succeeded);

        // 认得出结论、且结论是"否"：这才是真正的"没有可回收内容"
        let clean = parse_winsxs_analyze_output(
            "Number of Reclaimable Packages : 0\nCleanup Recommended : No\n",
        );
        assert!(clean.analysis_succeeded);
        assert_eq!(clean.reclaimable_packages, 0);
        assert!(!clean.cleanup_recommended);
    }

    #[test]
    fn slim_progress_payload_serializes_expected_fields() {
        let progress = SlimOperationProgress {
            item_id: "winsxs".to_string(),
            phase: "running".to_string(),
            message: "正在处理组件存储: 42%".to_string(),
            percent: 42,
            status: "running".to_string(),
            elapsed_ms: 1234,
        };
        let json = serde_json::to_value(&progress).expect("进度结构应可序列化");
        // 前端依赖这些字段名，改动字段会让进度条直接失效，因此在这里锁定。
        for key in ["item_id", "phase", "message", "percent", "status", "elapsed_ms"] {
            assert!(json.get(key).is_some(), "缺少字段: {}", key);
        }
    }
}