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
            // VS Code 套壳家族共用同一套缓存目录名（见 core 里的白名单），
            // 所以一个白名单能吃下全部，加一个工具只是加几行路径。
            ToolSpec {
                id: "cursor",
                name: "Cursor",
                // 只扫 Roaming。用户目录下的 ~/.cursor 放的是 cli-config.json、插件和
                // worktrees（git 工作树里有用户的未提交代码），既没有缓存也不该由我们来删。
                roots: vec![appdata.join("Cursor")],
            },
            ToolSpec {
                id: "trae",
                name: "Trae",
                // 官方文档里国际版、国内版、SOLO 模式是三个独立应用名，都试一遍，
                // 不存在的会被自动跳过。~/.trae-cn 存的是项目快照和扩展，不扫。
                roots: vec![
                    appdata.join("Trae"),
                    appdata.join("Trae CN"),
                    appdata.join("TRAE SOLO CN"),
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
                id: "devin",
                name: "Devin",
                roots: vec![appdata.join("devin")],
            },
            ToolSpec {
                id: "windsurf",
                name: "Windsurf",
                // ~/.windsurf 只有 extensions 和 plans（草稿），缓存都在 Roaming 这份里
                roots: vec![appdata.join("Windsurf")],
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
            // 国内 CLI 类：目录名按公开约定，本机没装所以没实测，
            // 路径不对的唯一后果是这个工具不出现，不会误删。
            ToolSpec {
                id: "qwen",
                name: "Qwen Code",
                roots: vec![user_profile.join(".qwen")],
            },
            ToolSpec {
                // xAI 的官方终端编码助手叫 Grok Build（不是社区那个 grok-cli），
                // 全家桶都在 ~/.grok：bin 是二进制、auth.json 是凭据、sessions 是会话，
                // 只有 cache 类目录会命中白名单
                id: "grok",
                name: "Grok Build",
                roots: vec![user_profile.join(".grok")],
            },
        ]
    }


