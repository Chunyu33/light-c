// ============================================================================
// ProgramData 安全清理模块
// 将标记为可清理的目录移动到回收站
// 核心原则：稳定性优先，宁可不删，也不能删错
// ============================================================================

use crate::scanner::programdata_rules::{ActionType, AnalyzeResult, RiskLevel};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Instant;

// ============================================================================
// 数据结构定义
// ============================================================================

/// 单个清理操作的结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanResult {
    /// 目录路径
    pub path: String,
    /// 目录大小（字节）
    pub size: u64,
    /// 是否成功
    pub success: bool,
    /// 错误信息（如果失败）
    pub error: Option<String>,
    /// 跳过原因（如果跳过）
    pub skip_reason: Option<String>,
}

/// 批量清理结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchCleanResult {
    /// 成功清理的数量
    pub success_count: usize,
    /// 失败的数量
    pub failed_count: usize,
    /// 跳过的数量
    pub skipped_count: usize,
    /// 成功释放的空间（字节）
    pub freed_size: u64,
    /// 清理耗时（毫秒）
    pub duration_ms: u64,
    /// 详细结果列表
    pub results: Vec<CleanResult>,
}

/// 清理选项
#[derive(Debug, Clone)]
pub struct CleanOptions {
    /// 是否允许清理 Warning 级别的目录（需用户确认）
    pub allow_warning: bool,
    /// 是否执行干运行（只检查，不实际删除）
    pub dry_run: bool,
    /// 是否在清理前检查目录是否存在
    pub check_exists: bool,
}

impl Default for CleanOptions {
    fn default() -> Self {
        Self {
            allow_warning: false, // 默认不清理 Warning 级别
            dry_run: false,
            check_exists: true,
        }
    }
}

impl CleanOptions {
    /// 创建允许 Warning 级别的选项
    pub fn with_warning_allowed() -> Self {
        Self {
            allow_warning: true,
            ..Default::default()
        }
    }

    /// 创建干运行选项
    pub fn dry_run() -> Self {
        Self {
            dry_run: true,
            ..Default::default()
        }
    }
}

// ============================================================================
// 清理器实现
// ============================================================================

/// ProgramData 安全清理器
pub struct ProgramDataCleaner {
    options: CleanOptions,
}

impl ProgramDataCleaner {
    /// 创建默认清理器
    pub fn new() -> Self {
        Self {
            options: CleanOptions::default(),
        }
    }

    /// 使用自定义选项创建清理器
    pub fn with_options(options: CleanOptions) -> Self {
        Self { options }
    }

    /// 执行批量清理
    pub fn clean(&self, entries: &[AnalyzeResult]) -> BatchCleanResult {
        let start = Instant::now();
        let mut results: Vec<CleanResult> = Vec::new();
        let mut success_count = 0;
        let mut failed_count = 0;
        let mut skipped_count = 0;
        let mut freed_size: u64 = 0;

        for entry in entries {
            let result = self.clean_single(entry);

            if result.success {
                success_count += 1;
                freed_size += result.size;
                log::info!("✓ 已清理: {} ({} bytes)", result.path, result.size);
            } else if result.skip_reason.is_some() {
                skipped_count += 1;
                log::debug!("⊘ 已跳过: {} - {:?}", result.path, result.skip_reason);
            } else {
                failed_count += 1;
                log::warn!("✗ 清理失败: {} - {:?}", result.path, result.error);
            }

            results.push(result);
        }

        let duration_ms = start.elapsed().as_millis() as u64;

        log::info!(
            "清理完成: 成功 {}, 失败 {}, 跳过 {}, 释放 {} bytes, 耗时 {}ms",
            success_count,
            failed_count,
            skipped_count,
            freed_size,
            duration_ms
        );

        BatchCleanResult {
            success_count,
            failed_count,
            skipped_count,
            freed_size,
            duration_ms,
            results,
        }
    }

    /// 清理单个目录
    fn clean_single(&self, entry: &AnalyzeResult) -> CleanResult {
        let path = &entry.path;
        let size = entry.size;

        // 1. 检查是否允许清理（基于风险等级和操作类型）
        if let Some(skip_reason) = self.should_skip(entry) {
            return CleanResult {
                path: path.clone(),
                size,
                success: false,
                error: None,
                skip_reason: Some(skip_reason),
            };
        }

        // 2. 检查路径是否存在
        if self.options.check_exists && !Path::new(path).exists() {
            return CleanResult {
                path: path.clone(),
                size,
                success: false,
                error: None,
                skip_reason: Some("目录不存在".to_string()),
            };
        }

        // 3. 干运行模式
        if self.options.dry_run {
            return CleanResult {
                path: path.clone(),
                size,
                success: true,
                error: None,
                skip_reason: Some("干运行模式，未实际删除".to_string()),
            };
        }

        // 4. 执行实际清理（移动到回收站）
        match self.move_to_trash(path) {
            Ok(()) => CleanResult {
                path: path.clone(),
                size,
                success: true,
                error: None,
                skip_reason: None,
            },
            Err(e) => CleanResult {
                path: path.clone(),
                size,
                success: false,
                error: Some(e),
                skip_reason: None,
            },
        }
    }

    /// 检查是否应该跳过该目录
    fn should_skip(&self, entry: &AnalyzeResult) -> Option<String> {
        // 检查操作类型
        match entry.action {
            ActionType::Protect => {
                return Some("受保护目录，禁止删除".to_string());
            }
            ActionType::Ignore => {
                return Some("忽略目录，不建议删除".to_string());
            }
            ActionType::Suggest => {
                // Suggest 需要检查风险等级
            }
            ActionType::Delete => {
                // Delete 允许清理，继续检查风险等级
            }
        }

        // 检查风险等级
        match entry.risk {
            RiskLevel::Dangerous => {
                return Some("危险级别，禁止删除".to_string());
            }
            RiskLevel::Warning => {
                if !self.options.allow_warning {
                    return Some("警告级别，需用户确认".to_string());
                }
            }
            RiskLevel::Safe => {
                // 安全级别，允许清理
            }
        }

        // 额外安全检查：路径验证
        if let Some(reason) = self.validate_path(&entry.path) {
            return Some(reason);
        }

        None
    }

    /// 验证路径是否安全（使用路径组件边界匹配，防止前缀绕过）
    fn validate_path(&self, path: &str) -> Option<String> {
        let path_lower = path.to_lowercase().replace('\\', "/");

        // 必须是 ProgramData 下的路径（路径组件边界匹配）
        if !path_lower.starts_with("c:/programdata/") {
            return Some("不是 ProgramData 目录".to_string());
        }

        // 路径深度检查：至少要有 ProgramData 下的一级子目录
        let after_programdata: &str = &path_lower["c:/programdata/".len()..];
        let trimmed = after_programdata.trim_start_matches('/');

        if trimmed.is_empty() {
            return Some("不能删除 ProgramData 根目录".to_string());
        }

        None
    }

    /// 移动到回收站
    fn move_to_trash(&self, path: &str) -> Result<(), String> {
        let path = Path::new(path);

        // 再次确认路径存在
        if !path.exists() {
            return Err("目录不存在".to_string());
        }

        // 检查是否为目录
        if !path.is_dir() {
            return Err("不是目录".to_string());
        }

        // 尝试移动到回收站
        match trash::delete(path) {
            Ok(()) => Ok(()),
            Err(e) => {
                // 解析错误类型，提供友好的错误信息
                let error_msg = parse_trash_error(&e);
                Err(error_msg)
            }
        }
    }
}

impl Default for ProgramDataCleaner {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 解析 trash crate 的错误，返回友好的错误信息
fn parse_trash_error(error: &trash::Error) -> String {
    let error_str = format!("{:?}", error);
    let error_lower = error_str.to_lowercase();

    // 检查常见错误模式
    if error_lower.contains("access")
        || error_lower.contains("denied")
        || error_lower.contains("permission")
    {
        "权限不足，请以管理员身份运行".to_string()
    } else if error_lower.contains("in use")
        || error_lower.contains("being used")
        || error_lower.contains("locked")
    {
        "文件正在被占用，请关闭相关程序后重试".to_string()
    } else if error_lower.contains("aborted") || error_lower.contains("cancelled") {
        "部分文件被占用或权限不足，无法完整移动到回收站".to_string()
    } else if error_lower.contains("not found") || error_lower.contains("not exist") {
        "目录不存在".to_string()
    } else if error_lower.contains("not empty") {
        "目录不为空".to_string()
    } else if error_lower.contains("root") {
        "不能删除根目录".to_string()
    } else {
        format!("删除失败: {}", error)
    }
}

/// 检查目录是否正在被使用（简单检查）
#[allow(dead_code)]
fn is_directory_in_use(path: &Path) -> bool {
    // 尝试以独占方式打开目录
    // 如果失败，说明目录可能正在被使用
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    {
        Ok(_) => false,
        Err(_) => true,
    }
}

// ============================================================================
// 公共 API
// ============================================================================

/// 清理分析结果中标记为可清理的目录（使用默认选项）
///
/// # 安全说明
/// - 只清理 Safe 级别 + Delete/Suggest 操作的目录
/// - 所有文件移动到回收站，不会永久删除
/// - Dangerous 和 Protect 级别的目录会被跳过
pub fn clean(entries: &[AnalyzeResult]) -> BatchCleanResult {
    let cleaner = ProgramDataCleaner::new();
    cleaner.clean(entries)
}

/// 清理分析结果（允许 Warning 级别，需用户确认后调用）
pub fn clean_with_warning(entries: &[AnalyzeResult]) -> BatchCleanResult {
    let cleaner = ProgramDataCleaner::with_options(CleanOptions::with_warning_allowed());
    cleaner.clean(entries)
}

/// 干运行：检查哪些目录会被清理，但不实际执行
pub fn clean_dry_run(entries: &[AnalyzeResult]) -> BatchCleanResult {
    let cleaner = ProgramDataCleaner::with_options(CleanOptions::dry_run());
    cleaner.clean(entries)
}

/// 筛选出可以安全清理的目录
pub fn filter_cleanable(entries: &[AnalyzeResult]) -> Vec<&AnalyzeResult> {
    entries
        .iter()
        .filter(|e| {
            matches!(e.risk, RiskLevel::Safe)
                && matches!(e.action, ActionType::Delete | ActionType::Suggest)
        })
        .collect()
}

/// 筛选出需要用户确认的目录
pub fn filter_needs_confirmation(entries: &[AnalyzeResult]) -> Vec<&AnalyzeResult> {
    entries
        .iter()
        .filter(|e| {
            matches!(e.risk, RiskLevel::Warning)
                && matches!(e.action, ActionType::Delete | ActionType::Suggest)
        })
        .collect()
}

/// 计算可清理的总大小
pub fn calculate_cleanable_size(entries: &[AnalyzeResult]) -> u64 {
    filter_cleanable(entries).iter().map(|e| e.size).sum()
}

/// 计算需要确认的总大小
pub fn calculate_confirmation_size(entries: &[AnalyzeResult]) -> u64 {
    filter_needs_confirmation(entries)
        .iter()
        .map(|e| e.size)
        .sum()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_entry(path: &str, risk: RiskLevel, action: ActionType) -> AnalyzeResult {
        AnalyzeResult {
            path: path.to_string(),
            size: 1024 * 1024, // 1MB
            category: "Test".to_string(),
            risk,
            action,
            reason: "测试".to_string(),
            suggestion: "".to_string(),
            matched_rule_id: None,
            tags: vec![],
        }
    }

    #[test]
    fn test_should_skip_dangerous() {
        let cleaner = ProgramDataCleaner::new();
        let entry = create_test_entry(
            "C:\\ProgramData\\Test",
            RiskLevel::Dangerous,
            ActionType::Delete,
        );

        let skip = cleaner.should_skip(&entry);
        assert!(skip.is_some());
        assert!(skip.unwrap().contains("危险"));
    }

    #[test]
    fn test_should_skip_protect() {
        let cleaner = ProgramDataCleaner::new();
        let entry = create_test_entry(
            "C:\\ProgramData\\Test",
            RiskLevel::Safe,
            ActionType::Protect,
        );

        let skip = cleaner.should_skip(&entry);
        assert!(skip.is_some());
        assert!(skip.unwrap().contains("保护"));
    }

    #[test]
    fn test_should_not_skip_safe_delete() {
        let cleaner = ProgramDataCleaner::new();
        let entry = create_test_entry("C:\\ProgramData\\Test", RiskLevel::Safe, ActionType::Delete);

        let skip = cleaner.should_skip(&entry);
        assert!(skip.is_none());
    }

    #[test]
    fn test_warning_needs_confirmation() {
        let cleaner = ProgramDataCleaner::new();
        let entry = create_test_entry(
            "C:\\ProgramData\\Test",
            RiskLevel::Warning,
            ActionType::Delete,
        );

        let skip = cleaner.should_skip(&entry);
        assert!(skip.is_some());
        assert!(skip.unwrap().contains("确认"));
    }

    #[test]
    fn test_warning_allowed() {
        let cleaner = ProgramDataCleaner::with_options(CleanOptions::with_warning_allowed());
        let entry = create_test_entry(
            "C:\\ProgramData\\Test",
            RiskLevel::Warning,
            ActionType::Delete,
        );

        let skip = cleaner.should_skip(&entry);
        assert!(skip.is_none());
    }

    #[test]
    fn test_validate_path_forbidden() {
        let cleaner = ProgramDataCleaner::new();

        assert!(cleaner
            .validate_path("C:\\Windows\\System32")
            .is_some());
        assert!(cleaner
            .validate_path("C:\\Program Files\\Test")
            .is_some());
        assert!(cleaner.validate_path("C:\\Users\\Test").is_some());
        // 不能删除 ProgramData 根目录
        assert!(cleaner.validate_path("C:\\ProgramData").is_some());
        assert!(cleaner.validate_path("C:\\ProgramData\\").is_some());
    }

    #[test]
    fn test_validate_path_valid() {
        let cleaner = ProgramDataCleaner::new();

        assert!(cleaner.validate_path("C:\\ProgramData\\Test").is_none());
        assert!(cleaner
            .validate_path("C:\\ProgramData\\Microsoft\\Windows\\WER")
            .is_none());
    }

    #[test]
    fn test_filter_cleanable() {
        let entries = vec![
            create_test_entry("C:\\ProgramData\\A", RiskLevel::Safe, ActionType::Delete),
            create_test_entry("C:\\ProgramData\\B", RiskLevel::Warning, ActionType::Delete),
            create_test_entry(
                "C:\\ProgramData\\C",
                RiskLevel::Dangerous,
                ActionType::Delete,
            ),
            create_test_entry("C:\\ProgramData\\D", RiskLevel::Safe, ActionType::Protect),
        ];

        let cleanable = filter_cleanable(&entries);
        assert_eq!(cleanable.len(), 1);
        assert_eq!(cleanable[0].path, "C:\\ProgramData\\A");
    }
}
