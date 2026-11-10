// ============================================================================
// 系统相关命令（系统瘦身 + 健康评分 + 系统信息）
// ============================================================================

use log::info;
use tauri::Window;

// 重新导出供前端使用
pub use crate::health_score::HealthScoreResult;
pub use crate::system_info::SystemInfo;
pub use crate::system_slim::SystemSlimStatus;

// ============================================================================
// 系统瘦身
// ============================================================================

/// 检查是否以管理员权限运行
#[tauri::command]
pub fn check_admin_privilege() -> bool {
    crate::system_slim::check_admin()
}

/// 以管理员权限重新启动当前程序。
///
/// 走 Windows 标准 UAC（`ShellExecuteW` 的 `runas` 动词），不绕过、不静默提权 ——
/// 用户仍然要在系统弹窗里点确认。
///
/// 返回 `true` 表示管理员实例已经拉起、当前进程随后自动退出；
/// 返回 `false` 表示用户取消了 UAC（或者本来就已经是管理员，无需重启）。
/// 取消是正常选择，不当失败处理，调用方也不该弹错误提示。
#[tauri::command]
pub fn relaunch_as_admin(app: tauri::AppHandle) -> Result<bool, String> {
    if crate::system_slim::check_admin() {
        // 已经是管理员：调用方不必重启
        return Ok(false);
    }

    let exe_path = std::env::current_exe()
        .map_err(|error| format!("无法定位当前程序路径: {}", error))?;

    #[cfg(target_os = "windows")]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use winapi::um::shellapi::ShellExecuteW;
        use winapi::um::winuser::SW_SHOWNORMAL;

        /// 转成 NUL 结尾的宽字符串，ShellExecuteW 只接受这种形式
        fn to_wide(value: &OsStr) -> Vec<u16> {
            value.encode_wide().chain(std::iter::once(0)).collect()
        }

        let operation = to_wide(OsStr::new("runas"));
        let file = to_wide(exe_path.as_os_str());
        let parameters = to_wide(OsStr::new(""));
        // 工作目录跟随 exe，便携版按相对路径找数据目录的判定才不会歪
        let working_directory = exe_path
            .parent()
            .map(|parent| to_wide(parent.as_os_str()))
            .unwrap_or_else(|| to_wide(OsStr::new(".")));

        // SAFETY: 四个字符串都是 NUL 结尾的宽字符，且在整个调用期间存活
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                parameters.as_ptr(),
                working_directory.as_ptr(),
                SW_SHOWNORMAL,
            )
        };

        // 约定：返回值 <= 32 表示失败；1223 = 用户在 UAC 里点了「否」
        let code = result as isize;
        if code <= 32 {
            if code == 1223 || code == 5 {
                info!("用户取消了管理员权限请求（错误码 {}）", code);
                return Ok(false);
            }
            return Err(format!("请求管理员权限失败（ShellExecute 返回 {}）", code));
        }
        info!("已启动管理员实例，准备退出当前进程");
    }

    #[cfg(not(target_os = "windows"))]
    return Err("只有 Windows 需要提权重启".to_string());

    // 两个实例同时跑会抢同一批日志和配置文件，所以旧进程必须让位。
    // 延迟 300ms 是给新实例留出初始化窗口 —— 它一启动就要读配置，撞上旧进程正在写就会读到半份。
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app_handle.exit(0);
    });

    Ok(true)
}

/// 获取系统瘦身状态。
///
/// WinSxS 的 DISM 分析走后台任务，本命令只返回当前已知结果 + `analyzing` 标记，
/// 分析完成后通过 `system-slim:winsxs-ready` 事件补推，所以需要 window 来发事件。
///
/// `force_refresh`：用户手动点"重新检测"时传 true，跳过 10 分钟缓存、真的重跑一次 DISM。
/// 不传（或 false）时走缓存，供自动刷新等场景使用。
#[tauri::command]
pub async fn get_system_slim_status(
    window: Window,
    force_refresh: Option<bool>,
) -> SystemSlimStatus {
    crate::system_slim::get_status(window, force_refresh.unwrap_or(false)).await
}

/// 关闭休眠功能（异步 + 进度推送）
#[tauri::command]
pub async fn disable_hibernation(window: Window) -> Result<String, String> {
    crate::system_slim::disable_hibernation_with_progress(&window).await
}

/// 开启休眠功能（异步 + 进度推送）
#[tauri::command]
pub async fn enable_hibernation(window: Window) -> Result<String, String> {
    crate::system_slim::enable_hibernation_with_progress(&window).await
}

/// 清理 WinSxS 组件存储
#[tauri::command]
pub async fn cleanup_winsxs(window: Window) -> Result<String, String> {
    crate::system_slim::cleanup_winsxs(&window).await
}

/// 深度清理 WinSxS 组件基线
#[tauri::command]
pub async fn cleanup_winsxs_resetbase(window: Window) -> Result<String, String> {
    crate::system_slim::cleanup_winsxs_resetbase(&window).await
}

/// 打开系统虚拟内存设置
#[tauri::command]
pub fn open_virtual_memory_settings() -> Result<(), String> {
    crate::system_slim::open_virtual_memory_settings()
}

/// 重建 Windows 搜索索引
#[tauri::command]
pub async fn rebuild_search_index() -> Result<String, String> {
    // COM 调用放阻塞线程里：搜索服务异常时 CoCreateInstance 可能卡住，
    // 同步命令会连带把这条 IPC 线程占死。
    tokio::task::spawn_blocking(crate::system_slim::rebuild_search_index)
        .await
        .map_err(|e| format!("任务执行失败: {}", e))?
}

// ============================================================================
// 健康评分
// ============================================================================

/// 计算系统健康评分
#[tauri::command]
pub fn get_health_score() -> HealthScoreResult {
    crate::health_score::calculate()
}

// ============================================================================
// 系统信息
// ============================================================================

/// 获取系统信息
#[tauri::command]
pub async fn get_system_info() -> Result<SystemInfo, String> {
    info!("获取系统信息");
    crate::system_info::gather()
}
