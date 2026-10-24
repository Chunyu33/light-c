//! 工具清单。
//!
//! **新增一个工具只需要在这里加一段**：扫描、界面、删除都不用改。
//! 每个工具给多个候选根目录，因为同一个工具在不同安装方式下位置不同
//! （如 dsh 桌面端在 AppData、CLI 缓存在用户目录点目录）。

use std::path::{Path, PathBuf};

/// 一个工具的数据根目录候选。
///
/// 用多个候选而不是单个，是因为同一个工具在不同安装方式下位置不同：
/// 比如 dsh 的桌面端缓存在 AppData 里，CLI 缓存却在用户目录的点目录下。
pub(super) struct ToolSpec {
    pub(super) id: &'static str,
    pub(super) name: &'static str,
    pub(super) roots: Vec<PathBuf>,
}

    /// 工具清单。
    ///
    /// Trae 这类用户量小的先不做；Codex 和 dsh 按用户反馈优先排进来。
    /// 新增一个工具只需要在这里加一段，扫描与界面都不用改。
pub(super) fn build_specs(appdata: &Path, local_appdata: &Path, user_profile: &Path) -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                id: "claude-code",
                name: "Claude Code",
                roots: vec![user_profile.join(".claude")],
            },
            ToolSpec {
                id: "codex",
                name: "Codex",
                roots: vec![user_profile.join(".codex")],
            },
            ToolSpec {
                id: "dsh",
                name: "DeepSeek（dsh）",
                roots: vec![
                    user_profile.join(".dsh"),
                    // 壁纸引擎的缓存单独放在同级目录，体积往往是最大的
                    user_profile.join(".dsh-wallpaper-engine"),
                    appdata.join("@deepseek-ai").join("dsh-desktop"),
                ],
            },
            ToolSpec {
                id: "workbuddy",
                name: "WorkBuddy",
                roots: vec![
                    local_appdata.join("WorkBuddy"),
                    appdata.join("WorkBuddy"),
                    // CLI 的缓存写在用户目录点目录下，和桌面端 AppData 是两套
                    user_profile.join(".workbuddy"),
                ],
            },
            ToolSpec {
                id: "codeium",
                name: "Codeium / Windsurf",
                roots: vec![user_profile.join(".codeium")],
            },
            ToolSpec {
                id: "continue",
                name: "Continue",
                roots: vec![user_profile.join(".continue")],
            },
            ToolSpec {
                id: "codebuddy",
                name: "CodeBuddy",
                roots: vec![user_profile.join(".codebuddy")],
            },
            ToolSpec {
                id: "gemini",
                name: "Gemini CLI",
                roots: vec![user_profile.join(".gemini")],
            },
            ToolSpec {
                id: "antigravity",
                name: "Antigravity",
                roots: vec![appdata.join("Antigravity")],
            },
            ToolSpec {
                id: "kimi",
                name: "Kimi",
                roots: vec![appdata.join("kimi-desktop")],
            },
        ]
    }


