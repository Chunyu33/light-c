// ============================================================================
// 社交软件路径适配器
// ============================================================================
//
// 每个适配器只负责发现软件数据目录，实际遍历和分类由 core.rs 统一处理。
// 这样可以在增强单个软件路径时避免复制扫描、去重和风险分级逻辑。
// ============================================================================

use super::core::{FileCategory, SocialAppPath, SocialScanner};
use log::info;
use std::path::PathBuf;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

impl SocialScanner {
    // Telegram 路径检测
    // ========================================================================

    // ------------------------------------------------------------------------
    // 注册表里的安装位置
    // ------------------------------------------------------------------------

    /// 从注册表读出 Telegram 的安装目录。
    ///
    /// 为什么需要：Telegram Desktop 把 exe 和 tdata 放在同一个目录，
    /// 装到 `%APPDATA%\Telegram Desktop` 只是**默认值** —— 用户装到别的盘时
    /// 文件系统里没有任何线索，只有注册表还记着（本机实测：`D:\tmp\Telegram Desktop`）。
    fn telegram_dirs_from_registry() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // ① tg:// 协议处理器，默认值形如 "\"D:\tmp\Telegram Desktop\Telegram.exe\" -- \"%1\""
        if let Ok(key) = hkcu.open_subkey(r"Software\Classes\tg\shell\open\command") {
            if let Ok(command) = key.get_value::<String, _>("") {
                if let Some(dir) = Self::exe_dir_from_command(&command) {
                    dirs.push(dir);
                }
            }
        }

        // ② 卸载登记里的 InstallLocation 直接就是目录，比解析命令行更可靠
        if let Ok(uninstall) =
            hkcu.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall")
        {
            for name in uninstall.enum_keys().filter_map(|key| key.ok()) {
                let Ok(entry) = uninstall.open_subkey(&name) else {
                    continue;
                };
                let display: String = entry.get_value("DisplayName").unwrap_or_default();
                if !display.to_lowercase().contains("telegram") {
                    continue;
                }
                if let Ok(location) = entry.get_value::<String, _>("InstallLocation") {
                    if !location.is_empty() {
                        dirs.push(PathBuf::from(location.trim_end_matches('\\')));
                    }
                }
            }
        }

        // tg 协议和卸载登记通常指向同一个目录，去掉重复再返回，
        // 免得上层还要为"同一路径扫两遍"买单。
        dirs.sort();
        dirs.dedup();
        dirs
    }

    /// 从命令行里取出 exe 所在目录：带引号和不带引号两种写法都要认。
    fn exe_dir_from_command(command: &str) -> Option<PathBuf> {
        let exe = match command.strip_prefix('"') {
            Some(rest) => rest.split('"').next()?,
            None => command.split_whitespace().next()?,
        };
        PathBuf::from(exe).parent().map(|dir| dir.to_path_buf())
    }

    /// 检测 Telegram 路径
    pub(super) fn detect_telegram_paths(&self) -> Option<Vec<SocialAppPath>> {
        let mut paths = Vec::new();

        // 默认装在 %APPDATA%\Telegram Desktop，但用户可以装到任意盘
        // （本机实测：D:\tmp\Telegram Desktop），这种位置只有注册表还记着。
        let mut bases = vec![PathBuf::from(&self.appdata).join("Telegram Desktop")];
        for dir in Self::telegram_dirs_from_registry() {
            if !bases.iter().any(|existing| existing == &dir) {
                bases.push(dir);
            }
        }

        for telegram_base in bases {
            if !telegram_base.exists() {
                continue;
            }
            info!("发现Telegram目录: {}", telegram_base.display());

            // tdata 目录（用户数据，包含消息数据库）
            let tdata = telegram_base.join("tdata");
            if !tdata.exists() {
                continue;
            }

            // 判断这里是不是真的账号数据。
            // ⚠️ 不能只看 .db：新版 Telegram 的 tdata 里是 key_datas + D877F783D5D3EF8C
            // 这类目录，一个 .db 都没有（本机实测），只看 .db 会把新版整个跳过。
            let has_account = std::fs::read_dir(&tdata)
                .map(|entries| {
                    entries.filter_map(|e| e.ok()).any(|e| {
                        let name = e.file_name().to_string_lossy().to_lowercase();
                        name.ends_with(".db")
                            || name.contains("cache")
                            || name == "key_datas"
                            || name == "user_data"
                    })
                })
                .unwrap_or(false);

            if !has_account {
                continue;
            }

            paths.push(SocialAppPath {
                app_name: "Telegram".to_string(),
                path: tdata.clone(),
                category: FileCategory::ChatDatabase,
                is_custom_path: false,
            });

            // user_data 目录
            let user_data = tdata.join("user_data");
            if user_data.exists() {
                paths.push(SocialAppPath {
                    app_name: "Telegram".to_string(),
                    path: user_data,
                    category: FileCategory::TempCache,
                    is_custom_path: false,
                });
            }
        }

        // Microsoft Store 版本不使用 Roaming\Telegram Desktop，需检查包目录的本地状态。
        for package in self.find_package_directories(&["telegramdesktop", "telegram"]) {
            self.add_named_subdirectories(
                &package.join("LocalCache"),
                &["Cache", "Temp", "Code Cache"],
                "Telegram",
                FileCategory::TempCache,
                false,
                &mut paths,
            );
            self.add_named_subdirectories(
                &package.join(r"LocalCache\Roaming\Telegram Desktop"),
                &["Cache", "Temp", "Code Cache"],
                "Telegram",
                FileCategory::TempCache,
                false,
                &mut paths,
            );
            Self::add_scan_path(
                &mut paths,
                "Telegram",
                package.join("LocalState").join("tdata"),
                FileCategory::ChatDatabase,
                false,
            );
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }
}

// ========================================================================

#[cfg(test)]
mod tests {
    use super::SocialScanner;
    use std::path::PathBuf;

    /// 注册表里 tg 协议命令有两种写法：带引号（路径含空格）和不带引号。
    /// 解析错了就取不到安装目录，Telegram 又会变成"扫不到"。

    #[test]
    fn exe_dir_from_command_handles_quoted_and_bare_paths() {
        let quoted = r#""D:\tmp\Telegram Desktop\Telegram.exe" -- "%1""#;
        assert_eq!(
            SocialScanner::exe_dir_from_command(quoted),
            Some(PathBuf::from(r"D:\tmp\Telegram Desktop"))
        );

        let bare = r"C:\Apps\Telegram.exe -- %1";
        assert_eq!(
            SocialScanner::exe_dir_from_command(bare),
            Some(PathBuf::from(r"C:\Apps"))
        );

        // 空串不能 panic
        assert_eq!(SocialScanner::exe_dir_from_command(""), None);
    }
}
