// ============================================================================
// ProgramData 增长对比模块
// 对比当前扫描结果和历史快照，找出增长的目录
// 这是用户最关心的功能，帮助用户发现"哪些目录在悄悄变大"
// ============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// 配置常量
// ============================================================================

/// 显著增长阈值（字节）：500MB
const SIGNIFICANT_GROWTH_THRESHOLD: i64 = 500 * 1024 * 1024;

/// 快速增长阈值（字节）：100MB
const FAST_GROWTH_THRESHOLD: i64 = 100 * 1024 * 1024;

/// 轻微增长阈值（字节）：10MB
const MINOR_GROWTH_THRESHOLD: i64 = 10 * 1024 * 1024;

// ============================================================================
// 数据结构定义
// ============================================================================

/// 增长级别
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrowthLevel {
    /// 显著增长（> 500MB）
    Significant,
    /// 快速增长（> 100MB）
    Fast,
    /// 轻微增长（> 10MB）
    Minor,
    /// 无明显变化
    Stable,
    /// 减少
    Decreased,
    /// 新增目录
    New,
}

impl GrowthLevel {
    /// 获取显示标签
    pub fn label(&self) -> &'static str {
        match self {
            GrowthLevel::Significant => "显著增长",
            GrowthLevel::Fast => "快速增长",
            GrowthLevel::Minor => "轻微增长",
            GrowthLevel::Stable => "无变化",
            GrowthLevel::Decreased => "已减少",
            GrowthLevel::New => "新增",
        }
    }

    /// 获取图标（用于前端显示）
    pub fn icon(&self) -> &'static str {
        match self {
            GrowthLevel::Significant => "🔴",
            GrowthLevel::Fast => "🟠",
            GrowthLevel::Minor => "🟡",
            GrowthLevel::Stable => "⚪",
            GrowthLevel::Decreased => "🟢",
            GrowthLevel::New => "🆕",
        }
    }
}

/// 单个目录的增长信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrowthEntry {
    /// 目录路径
    pub path: String,
    /// 旧大小（字节），新目录为 0
    pub old_size: u64,
    /// 新大小（字节）
    pub new_size: u64,
    /// 变化量（字节），正数表示增长，负数表示减少
    pub diff: i64,
    /// 增长百分比
    pub diff_percent: f64,
    /// 增长级别
    pub level: GrowthLevel,
    /// 人类可读的解释
    pub explanation: String,
    /// 建议操作
    pub suggestion: String,
}

/// 增长对比结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrowthReport {
    /// 所有变化的目录（按 diff 降序排列）
    pub entries: Vec<GrowthEntry>,
    /// 总增长量（字节）
    pub total_growth: i64,
    /// 显著增长的目录数
    pub significant_count: usize,
    /// 快速增长的目录数
    pub fast_count: usize,
    /// 新增目录数
    pub new_count: usize,
    /// 减少的目录数
    pub decreased_count: usize,
    /// 对比的时间跨度描述
    pub time_span: String,
    /// 摘要文案
    pub summary: String,
}

/// 简化的目录条目（用于输入）
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub path: String,
    pub size: u64,
}

impl From<(String, u64)> for DirEntry {
    fn from((path, size): (String, u64)) -> Self {
        Self { path, size }
    }
}

impl From<(&str, u64)> for DirEntry {
    fn from((path, size): (&str, u64)) -> Self {
        Self {
            path: path.to_string(),
            size,
        }
    }
}

// ============================================================================
// 增长分析器
// ============================================================================

/// 增长分析器
pub struct GrowthAnalyzer {
    /// 显著增长阈值
    significant_threshold: i64,
    /// 快速增长阈值
    fast_threshold: i64,
    /// 轻微增长阈值
    minor_threshold: i64,
}

impl GrowthAnalyzer {
    /// 创建默认分析器
    pub fn new() -> Self {
        Self {
            significant_threshold: SIGNIFICANT_GROWTH_THRESHOLD,
            fast_threshold: FAST_GROWTH_THRESHOLD,
            minor_threshold: MINOR_GROWTH_THRESHOLD,
        }
    }

    /// 自定义阈值
    pub fn with_thresholds(significant_mb: i64, fast_mb: i64, minor_mb: i64) -> Self {
        Self {
            significant_threshold: significant_mb * 1024 * 1024,
            fast_threshold: fast_mb * 1024 * 1024,
            minor_threshold: minor_mb * 1024 * 1024,
        }
    }

    /// 执行增长对比分析
    pub fn analyze<T: Into<DirEntry> + Clone>(
        &self,
        current: &[T],
        previous: &[T],
        time_span: Option<&str>,
    ) -> GrowthReport {
        // 构建旧数据的 HashMap（路径 -> 大小）
        let previous_map: HashMap<String, u64> = previous
            .iter()
            .map(|e| {
                let entry: DirEntry = e.clone().into();
                (normalize_path(&entry.path), entry.size)
            })
            .collect();

        // 分析每个当前目录
        let mut entries: Vec<GrowthEntry> = current
            .iter()
            .map(|e| {
                let entry: DirEntry = e.clone().into();
                let normalized_path = normalize_path(&entry.path);
                let old_size = previous_map.get(&normalized_path).copied().unwrap_or(0);
                self.create_growth_entry(&entry.path, old_size, entry.size)
            })
            .collect();

        // 按 diff 降序排序
        entries.sort_by(|a, b| b.diff.cmp(&a.diff));

        // 统计
        let total_growth: i64 = entries.iter().map(|e| e.diff).sum();
        let significant_count = entries
            .iter()
            .filter(|e| e.level == GrowthLevel::Significant)
            .count();
        let fast_count = entries
            .iter()
            .filter(|e| e.level == GrowthLevel::Fast)
            .count();
        let new_count = entries
            .iter()
            .filter(|e| e.level == GrowthLevel::New)
            .count();
        let decreased_count = entries
            .iter()
            .filter(|e| e.level == GrowthLevel::Decreased)
            .count();

        // 生成摘要
        let summary = self.generate_summary(&entries, total_growth, significant_count, fast_count);

        GrowthReport {
            entries,
            total_growth,
            significant_count,
            fast_count,
            new_count,
            decreased_count,
            time_span: time_span.unwrap_or("未知").to_string(),
            summary,
        }
    }

    /// 创建单个增长条目
    fn create_growth_entry(&self, path: &str, old_size: u64, new_size: u64) -> GrowthEntry {
        let diff = new_size as i64 - old_size as i64;

        // 计算增长百分比
        let diff_percent = if old_size > 0 {
            (diff as f64 / old_size as f64) * 100.0
        } else if new_size > 0 {
            100.0 // 新目录视为 100% 增长
        } else {
            0.0
        };

        // 判断增长级别
        let level = self.determine_level(diff, old_size);

        // 生成解释和建议
        let (explanation, suggestion) = self.generate_explanation(path, diff, &level);

        GrowthEntry {
            path: path.to_string(),
            old_size,
            new_size,
            diff,
            diff_percent,
            level,
            explanation,
            suggestion,
        }
    }

    /// 判断增长级别
    fn determine_level(&self, diff: i64, old_size: u64) -> GrowthLevel {
        if old_size == 0 && diff > 0 {
            GrowthLevel::New
        } else if diff >= self.significant_threshold {
            GrowthLevel::Significant
        } else if diff >= self.fast_threshold {
            GrowthLevel::Fast
        } else if diff >= self.minor_threshold {
            GrowthLevel::Minor
        } else if diff < 0 {
            GrowthLevel::Decreased
        } else {
            GrowthLevel::Stable
        }
    }

    /// 生成解释和建议
    fn generate_explanation(&self, path: &str, diff: i64, level: &GrowthLevel) -> (String, String) {
        let path_lower = path.to_lowercase();
        let diff_mb = diff as f64 / 1024.0 / 1024.0;

        // 根据路径关键字生成针对性解释
        let (explanation, suggestion) = if path_lower.contains("deliveryoptimization") {
            (
                format!("Windows 更新缓存增长了 {:.1} MB", diff_mb),
                "可以在 Windows 设置中清理传递优化缓存".to_string(),
            )
        } else if path_lower.contains("softwaredistribution") {
            (
                format!("Windows Update 下载缓存增长了 {:.1} MB", diff_mb),
                "等待更新安装完成后可清理".to_string(),
            )
        } else if path_lower.contains("windows defender") || path_lower.contains("defender") {
            (
                format!("Windows Defender 数据增长了 {:.1} MB", diff_mb),
                "病毒定义更新导致，属于正常现象".to_string(),
            )
        } else if path_lower.contains("wer") || path_lower.contains("error") {
            (
                format!("Windows 错误报告增长了 {:.1} MB", diff_mb),
                "可以安全清理错误报告文件".to_string(),
            )
        } else if path_lower.contains("nvidia") {
            (
                format!("NVIDIA 驱动缓存增长了 {:.1} MB", diff_mb),
                "可以清理着色器缓存，驱动会自动重建".to_string(),
            )
        } else if path_lower.contains("amd") {
            (
                format!("AMD 驱动缓存增长了 {:.1} MB", diff_mb),
                "可以清理驱动缓存".to_string(),
            )
        } else if path_lower.contains("adobe") {
            (
                format!("Adobe 软件缓存增长了 {:.1} MB", diff_mb),
                "可以在 Adobe 软件中清理缓存".to_string(),
            )
        } else if path_lower.contains("docker") {
            (
                format!("Docker 数据增长了 {:.1} MB", diff_mb),
                "使用 docker system prune 清理未使用的镜像和容器".to_string(),
            )
        } else if path_lower.contains("package cache") {
            (
                format!("软件安装包缓存增长了 {:.1} MB", diff_mb),
                "Visual Studio 等软件的安装包缓存，清理后可能影响修复功能".to_string(),
            )
        } else if path_lower.contains("cache") || path_lower.contains("temp") {
            (
                format!("缓存目录增长了 {:.1} MB", diff_mb),
                "缓存文件通常可以安全清理".to_string(),
            )
        } else if path_lower.contains("log") {
            (
                format!("日志目录增长了 {:.1} MB", diff_mb),
                "可以清理旧日志文件".to_string(),
            )
        } else if path_lower.contains("microsoft") {
            (
                format!("Microsoft 组件数据增长了 {:.1} MB", diff_mb),
                "建议谨慎处理 Microsoft 系统组件".to_string(),
            )
        } else {
            // 默认解释
            match level {
                GrowthLevel::Significant => (
                    format!("该目录显著增长了 {:.1} MB", diff_mb),
                    "建议检查该目录的用途".to_string(),
                ),
                GrowthLevel::Fast => (
                    format!("该目录快速增长了 {:.1} MB", diff_mb),
                    "建议关注该目录的变化".to_string(),
                ),
                GrowthLevel::Minor => (
                    format!("该目录轻微增长了 {:.1} MB", diff_mb),
                    "属于正常范围".to_string(),
                ),
                GrowthLevel::New => (
                    format!("新增目录，大小 {:.1} MB", diff_mb),
                    "可能是新安装的软件".to_string(),
                ),
                GrowthLevel::Decreased => (
                    format!("该目录减少了 {:.1} MB", diff_mb.abs()),
                    "空间已释放".to_string(),
                ),
                GrowthLevel::Stable => ("该目录大小基本稳定".to_string(), "无需处理".to_string()),
            }
        };

        (explanation, suggestion)
    }

    /// 生成报告摘要
    fn generate_summary(
        &self,
        entries: &[GrowthEntry],
        total_growth: i64,
        significant_count: usize,
        fast_count: usize,
    ) -> String {
        let total_mb = total_growth as f64 / 1024.0 / 1024.0;

        if significant_count > 0 {
            format!(
                "⚠️ 发现 {} 个目录显著增长，总计增长 {:.1} MB，建议及时清理",
                significant_count, total_mb
            )
        } else if fast_count > 0 {
            format!(
                "📊 发现 {} 个目录快速增长，总计增长 {:.1} MB",
                fast_count, total_mb
            )
        } else if total_growth > 0 {
            format!("✅ ProgramData 总计增长 {:.1} MB，属于正常范围", total_mb)
        } else if total_growth < 0 {
            format!(
                "🎉 ProgramData 总计减少 {:.1} MB，空间已释放",
                total_mb.abs()
            )
        } else {
            "✅ ProgramData 大小基本稳定，无明显变化".to_string()
        }
    }
}

impl Default for GrowthAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 标准化路径（小写 + 统一分隔符）
fn normalize_path(path: &str) -> String {
    path.to_lowercase().replace('\\', "/")
}

/// 格式化大小变化为人类可读字符串
pub fn format_size_diff(diff: i64) -> String {
    let abs_diff = diff.abs() as f64;
    let sign = if diff >= 0 { "+" } else { "-" };

    if abs_diff >= 1024.0 * 1024.0 * 1024.0 {
        format!("{}{:.2} GB", sign, abs_diff / 1024.0 / 1024.0 / 1024.0)
    } else if abs_diff >= 1024.0 * 1024.0 {
        format!("{}{:.1} MB", sign, abs_diff / 1024.0 / 1024.0)
    } else if abs_diff >= 1024.0 {
        format!("{}{:.1} KB", sign, abs_diff / 1024.0)
    } else {
        format!("{}{} B", sign, diff.abs())
    }
}

// ============================================================================
// 公共 API
// ============================================================================

/// 对比当前扫描结果和历史快照
///
/// # 参数
/// - `current`: 当前扫描结果 (路径, 大小)
/// - `previous`: 历史快照 (路径, 大小)
///
/// # 返回
/// 增长报告，包含所有变化的目录（按增长量降序排列）
pub fn compare_growth(current: &[(String, u64)], previous: &[(String, u64)]) -> GrowthReport {
    let analyzer = GrowthAnalyzer::new();

    let current_entries: Vec<DirEntry> = current
        .iter()
        .map(|(p, s)| DirEntry {
            path: p.clone(),
            size: *s,
        })
        .collect();

    let previous_entries: Vec<DirEntry> = previous
        .iter()
        .map(|(p, s)| DirEntry {
            path: p.clone(),
            size: *s,
        })
        .collect();

    analyzer.analyze(&current_entries, &previous_entries, None)
}

/// 对比当前扫描结果和历史快照（带时间跨度描述）
pub fn compare_growth_with_timespan(
    current: &[(String, u64)],
    previous: &[(String, u64)],
    time_span: &str,
) -> GrowthReport {
    let analyzer = GrowthAnalyzer::new();

    let current_entries: Vec<DirEntry> = current
        .iter()
        .map(|(p, s)| DirEntry {
            path: p.clone(),
            size: *s,
        })
        .collect();

    let previous_entries: Vec<DirEntry> = previous
        .iter()
        .map(|(p, s)| DirEntry {
            path: p.clone(),
            size: *s,
        })
        .collect();

    analyzer.analyze(&current_entries, &previous_entries, Some(time_span))
}

/// 筛选出显著增长的目录
pub fn filter_significant_growth(report: &GrowthReport) -> Vec<&GrowthEntry> {
    report
        .entries
        .iter()
        .filter(|e| e.level == GrowthLevel::Significant)
        .collect()
}

/// 筛选出需要关注的目录（显著 + 快速增长）
pub fn filter_needs_attention(report: &GrowthReport) -> Vec<&GrowthEntry> {
    report
        .entries
        .iter()
        .filter(|e| matches!(e.level, GrowthLevel::Significant | GrowthLevel::Fast))
        .collect()
}

/// 获取增长最快的 N 个目录
pub fn top_growing(report: &GrowthReport, n: usize) -> Vec<&GrowthEntry> {
    report
        .entries
        .iter()
        .filter(|e| e.diff > 0)
        .take(n)
        .collect()
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_growth_level() {
        let analyzer = GrowthAnalyzer::new();

        // 显著增长
        assert_eq!(
            analyzer.determine_level(600 * 1024 * 1024, 100),
            GrowthLevel::Significant
        );

        // 快速增长
        assert_eq!(
            analyzer.determine_level(150 * 1024 * 1024, 100),
            GrowthLevel::Fast
        );

        // 轻微增长
        assert_eq!(
            analyzer.determine_level(50 * 1024 * 1024, 100),
            GrowthLevel::Minor
        );

        // 稳定
        assert_eq!(
            analyzer.determine_level(5 * 1024 * 1024, 100),
            GrowthLevel::Stable
        );

        // 减少
        assert_eq!(
            analyzer.determine_level(-100 * 1024 * 1024, 200 * 1024 * 1024),
            GrowthLevel::Decreased
        );

        // 新增
        assert_eq!(
            analyzer.determine_level(100 * 1024 * 1024, 0),
            GrowthLevel::New
        );
    }

    #[test]
    fn test_compare_growth() {
        let current = vec![
            ("Microsoft".to_string(), 200 * 1024 * 1024),
            ("NVIDIA".to_string(), 150 * 1024 * 1024),
            ("NewApp".to_string(), 50 * 1024 * 1024),
        ];

        let previous = vec![
            ("Microsoft".to_string(), 100 * 1024 * 1024),
            ("NVIDIA".to_string(), 150 * 1024 * 1024),
        ];

        let report = compare_growth(&current, &previous);

        assert_eq!(report.entries.len(), 3);
        assert!(report.total_growth > 0);

        // 第一个应该是增长最多的
        assert_eq!(report.entries[0].path, "Microsoft");
        assert_eq!(report.entries[0].diff, 100 * 1024 * 1024);
    }

    #[test]
    fn test_format_size_diff() {
        assert_eq!(format_size_diff(1024 * 1024 * 100), "+100.0 MB");
        assert_eq!(format_size_diff(-1024 * 1024 * 50), "-50.0 MB");
        assert_eq!(format_size_diff(1024 * 500), "+500.0 KB");
    }

    #[test]
    fn test_normalize_path() {
        assert_eq!(
            normalize_path("C:\\ProgramData\\Microsoft"),
            "c:/programdata/microsoft"
        );
    }
}
