// ============================================================================
// 应用运行环境命令
// ============================================================================

use serde::Serialize;

const PORTABLE_MARKER_FILE: &str = "LightC.portable";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DistributionChannel {
    Installer,
    Portable,
}

/// 获取当前发行渠道。
///
/// 便携版和安装版复用同一个 exe，不能依赖编译参数区分；发布流程会在便携包中放入
/// LightC.portable 标记文件，因此这里按 exe 同目录的 marker 判断运行渠道。
#[tauri::command]
pub fn get_distribution_channel() -> DistributionChannel {
    let marker_exists = std::env::current_exe()
        .ok()
        .and_then(|exe_path| {
            exe_path
                .parent()
                .map(|parent| parent.join(PORTABLE_MARKER_FILE))
        })
        .is_some_and(|marker_path| marker_path.is_file());

    if marker_exists {
        DistributionChannel::Portable
    } else {
        DistributionChannel::Installer
    }
}
