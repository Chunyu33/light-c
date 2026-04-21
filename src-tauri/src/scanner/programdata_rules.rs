// ============================================================================
// ProgramData 规则引擎模块
// 将扫描结果转换为人类可理解的分析信息
// 支持 JSON 配置文件，便于在线更新规则
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ============================================================================
// 数据结构定义
// ============================================================================

/// 风险等级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// 安全 - 可以放心清理
    Safe,
    /// 警告 - 建议用户确认后清理
    Warning,
    /// 危险 - 不建议清理，可能影响系统
    Dangerous,
}

impl Default for RiskLevel {
    fn default() -> Self {
        RiskLevel::Warning
    }
}

/// 建议操作类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActionType {
    /// 可以删除
    Delete,
    /// 建议清理（需用户确认）
    Suggest,
    /// 忽略（不建议操作）
    Ignore,
    /// 保护（禁止删除）
    Protect,
}

impl Default for ActionType {
    fn default() -> Self {
        ActionType::Ignore
    }
}

/// 路径匹配模式
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    /// 精确匹配（路径完全相等）
    Exact,
    /// 前缀匹配（路径以指定字符串开头）
    Prefix,
    /// 包含匹配（路径包含指定字符串）
    Contains,
    /// 后缀匹配（路径以指定字符串结尾）
    Suffix,
    /// 正则匹配（使用正则表达式）
    Regex,
}

impl Default for MatchMode {
    fn default() -> Self {
        MatchMode::Contains
    }
}

/// 单条规则定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    /// 规则 ID（唯一标识）
    pub id: String,
    /// 规则名称（用于显示）
    pub name: String,
    /// 匹配模式
    #[serde(default)]
    pub match_mode: MatchMode,
    /// 匹配模式（路径关键字，不区分大小写）
    pub pattern: String,
    /// 分类
    pub category: String,
    /// 风险等级
    #[serde(default)]
    pub risk: RiskLevel,
    /// 建议操作
    #[serde(default)]
    pub action: ActionType,
    /// 人类可读的说明
    pub description: String,
    /// 清理建议（显示给用户）
    #[serde(default)]
    pub suggestion: String,
    /// 最小触发大小（字节），低于此大小不触发该规则
    #[serde(default)]
    pub min_size: u64,
    /// 规则优先级（数字越大优先级越高）
    #[serde(default)]
    pub priority: i32,
    /// 是否启用
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 标签（用于分组和筛选）
    #[serde(default)]
    pub tags: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// 规则集配置文件结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleSet {
    /// 规则集版本号
    pub version: String,
    /// 规则集名称
    pub name: String,
    /// 规则集描述
    #[serde(default)]
    pub description: String,
    /// 最后更新时间（ISO 8601 格式）
    #[serde(default)]
    pub updated_at: String,
    /// 规则列表
    pub rules: Vec<Rule>,
}

impl Default for RuleSet {
    fn default() -> Self {
        Self {
            version: "1.0.0".to_string(),
            name: "ProgramData Rules".to_string(),
            description: "ProgramData 目录分析规则集".to_string(),
            updated_at: String::new(),
            rules: Vec::new(),
        }
    }
}

/// 分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeResult {
    /// 目录路径
    pub path: String,
    /// 目录大小（字节）
    pub size: u64,
    /// 分类
    pub category: String,
    /// 风险等级
    pub risk: RiskLevel,
    /// 建议操作
    pub action: ActionType,
    /// 人类可读的原因说明
    pub reason: String,
    /// 清理建议
    pub suggestion: String,
    /// 匹配的规则 ID（如果有）
    pub matched_rule_id: Option<String>,
    /// 标签
    pub tags: Vec<String>,
}

/// 批量分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchAnalyzeResult {
    /// 分析结果列表
    pub results: Vec<AnalyzeResult>,
    /// 使用的规则集版本
    pub ruleset_version: String,
    /// 分析耗时（毫秒）
    pub analyze_duration_ms: u64,
    /// 统计信息
    pub stats: AnalyzeStats,
}

/// 分析统计信息
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AnalyzeStats {
    /// 总目录数
    pub total_count: usize,
    /// 可删除数量
    pub deletable_count: usize,
    /// 建议清理数量
    pub suggest_count: usize,
    /// 忽略数量
    pub ignore_count: usize,
    /// 保护数量
    pub protect_count: usize,
    /// 未知分类数量
    pub unknown_count: usize,
    /// 可删除总大小
    pub deletable_size: u64,
    /// 建议清理总大小
    pub suggest_size: u64,
}

// ============================================================================
// 规则引擎实现
// ============================================================================

/// ProgramData 规则引擎
pub struct RuleEngine {
    /// 已加载的规则集
    ruleset: RuleSet,
    /// 规则文件路径（用于热更新）
    rules_path: Option<PathBuf>,
}

impl RuleEngine {
    /// 创建空的规则引擎
    pub fn new() -> Self {
        Self {
            ruleset: RuleSet::default(),
            rules_path: None,
        }
    }

    /// 从 JSON 文件加载规则
    pub fn from_file(path: &Path) -> Result<Self, RuleEngineError> {
        let content = fs::read_to_string(path)
            .map_err(|e| RuleEngineError::IoError(e.to_string()))?;
        
        let ruleset: RuleSet = serde_json::from_str(&content)
            .map_err(|e| RuleEngineError::ParseError(e.to_string()))?;

        Ok(Self {
            ruleset,
            rules_path: Some(path.to_path_buf()),
        })
    }

    /// 从 JSON 字符串加载规则
    pub fn from_json(json: &str) -> Result<Self, RuleEngineError> {
        let ruleset: RuleSet = serde_json::from_str(json)
            .map_err(|e| RuleEngineError::ParseError(e.to_string()))?;

        Ok(Self {
            ruleset,
            rules_path: None,
        })
    }

    /// 使用内置默认规则
    pub fn with_builtin_rules() -> Self {
        Self {
            ruleset: get_builtin_ruleset(),
            rules_path: None,
        }
    }

    /// 重新加载规则文件
    pub fn reload(&mut self) -> Result<(), RuleEngineError> {
        if let Some(path) = &self.rules_path {
            let content = fs::read_to_string(path)
                .map_err(|e| RuleEngineError::IoError(e.to_string()))?;
            
            self.ruleset = serde_json::from_str(&content)
                .map_err(|e| RuleEngineError::ParseError(e.to_string()))?;
        }
        Ok(())
    }

    /// 更新规则集（用于在线更新）
    pub fn update_ruleset(&mut self, ruleset: RuleSet) {
        self.ruleset = ruleset;
    }

    /// 获取当前规则集版本
    pub fn version(&self) -> &str {
        &self.ruleset.version
    }

    /// 获取规则数量
    pub fn rule_count(&self) -> usize {
        self.ruleset.rules.iter().filter(|r| r.enabled).count()
    }

    /// 分析单个目录
    pub fn analyze(&self, path: &str, size: u64) -> AnalyzeResult {
        // 标准化路径（统一使用小写和正斜杠进行匹配）
        let normalized_path = normalize_path(path);

        // 查找匹配的规则（按优先级排序）
        let mut matched_rules: Vec<&Rule> = self.ruleset.rules
            .iter()
            .filter(|r| r.enabled && self.match_rule(r, &normalized_path, size))
            .collect();

        // 按优先级降序排序
        matched_rules.sort_by(|a, b| b.priority.cmp(&a.priority));

        // 使用第一个匹配的规则，或返回默认结果
        if let Some(rule) = matched_rules.first() {
            AnalyzeResult {
                path: path.to_string(),
                size,
                category: rule.category.clone(),
                risk: rule.risk,
                action: rule.action,
                reason: rule.description.clone(),
                suggestion: rule.suggestion.clone(),
                matched_rule_id: Some(rule.id.clone()),
                tags: rule.tags.clone(),
            }
        } else {
            // 未匹配到规则，返回默认结果
            self.default_result(path, size)
        }
    }

    /// 批量分析目录
    pub fn analyze_batch(&self, entries: &[(String, u64)]) -> BatchAnalyzeResult {
        let start = std::time::Instant::now();

        let results: Vec<AnalyzeResult> = entries
            .iter()
            .map(|(path, size)| self.analyze(path, *size))
            .collect();

        // 统计信息
        let mut stats = AnalyzeStats {
            total_count: results.len(),
            ..Default::default()
        };

        for result in &results {
            match result.action {
                ActionType::Delete => {
                    stats.deletable_count += 1;
                    stats.deletable_size += result.size;
                }
                ActionType::Suggest => {
                    stats.suggest_count += 1;
                    stats.suggest_size += result.size;
                }
                ActionType::Ignore => {
                    stats.ignore_count += 1;
                }
                ActionType::Protect => {
                    stats.protect_count += 1;
                }
            }

            if result.category == "Unknown" {
                stats.unknown_count += 1;
            }
        }

        BatchAnalyzeResult {
            results,
            ruleset_version: self.ruleset.version.clone(),
            analyze_duration_ms: start.elapsed().as_millis() as u64,
            stats,
        }
    }

    /// 检查规则是否匹配
    fn match_rule(&self, rule: &Rule, normalized_path: &str, size: u64) -> bool {
        // 检查最小大小
        if size < rule.min_size {
            return false;
        }

        // 标准化规则模式
        let pattern = normalize_path(&rule.pattern);

        // 根据匹配模式进行匹配
        match rule.match_mode {
            MatchMode::Exact => normalized_path == pattern,
            MatchMode::Prefix => normalized_path.starts_with(&pattern),
            MatchMode::Contains => normalized_path.contains(&pattern),
            MatchMode::Suffix => normalized_path.ends_with(&pattern),
            MatchMode::Regex => {
                // 正则匹配（简化实现，生产环境建议使用 regex crate）
                // 这里暂时退化为包含匹配
                normalized_path.contains(&pattern)
            }
        }
    }

    /// 生成默认分析结果（未匹配规则时）
    fn default_result(&self, path: &str, size: u64) -> AnalyzeResult {
        // 尝试从路径推断分类
        let (category, risk, action, reason) = infer_from_path(path, size);

        AnalyzeResult {
            path: path.to_string(),
            size,
            category,
            risk,
            action,
            reason,
            suggestion: "建议手动检查后决定是否清理".to_string(),
            matched_rule_id: None,
            tags: vec![],
        }
    }
}

impl Default for RuleEngine {
    fn default() -> Self {
        Self::with_builtin_rules()
    }
}

// ============================================================================
// 错误类型
// ============================================================================

/// 规则引擎错误
#[derive(Debug, Clone)]
pub enum RuleEngineError {
    /// IO 错误
    IoError(String),
    /// JSON 解析错误
    ParseError(String),
    /// 规则验证错误
    ValidationError(String),
}

impl std::fmt::Display for RuleEngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RuleEngineError::IoError(msg) => write!(f, "IO 错误: {}", msg),
            RuleEngineError::ParseError(msg) => write!(f, "解析错误: {}", msg),
            RuleEngineError::ValidationError(msg) => write!(f, "验证错误: {}", msg),
        }
    }
}

impl std::error::Error for RuleEngineError {}

// ============================================================================
// 辅助函数
// ============================================================================

/// 标准化路径（小写 + 正斜杠）
fn normalize_path(path: &str) -> String {
    path.to_lowercase().replace('\\', "/")
}

/// 从路径推断分类（用于未匹配规则的情况）
fn infer_from_path(path: &str, size: u64) -> (String, RiskLevel, ActionType, String) {
    let lower_path = path.to_lowercase();

    // 根据路径关键字推断
    if lower_path.contains("cache") || lower_path.contains("temp") || lower_path.contains("tmp") {
        return (
            "Cache".to_string(),
            RiskLevel::Safe,
            ActionType::Suggest,
            "检测到缓存目录，通常可以安全清理".to_string(),
        );
    }

    if lower_path.contains("log") || lower_path.contains("logs") {
        return (
            "Logs".to_string(),
            RiskLevel::Safe,
            ActionType::Suggest,
            "检测到日志目录，可以清理旧日志".to_string(),
        );
    }

    if lower_path.contains("update") || lower_path.contains("download") {
        return (
            "Updates".to_string(),
            RiskLevel::Warning,
            ActionType::Suggest,
            "检测到更新/下载目录，建议确认后清理".to_string(),
        );
    }

    if lower_path.contains("microsoft") {
        return (
            "Microsoft".to_string(),
            RiskLevel::Warning,
            ActionType::Ignore,
            "Microsoft 系统组件目录，建议谨慎处理".to_string(),
        );
    }

    // 根据大小判断
    if size > 1024 * 1024 * 1024 {
        // > 1GB
        return (
            "第三方软件".to_string(),
            RiskLevel::Warning,
            ActionType::Suggest,
            format!("第三方软件目录（{:.2} GB），需自行判断，建议保留", size as f64 / 1024.0 / 1024.0 / 1024.0),
        );
    }

    // 默认
    (
        "第三方软件".to_string(),
        RiskLevel::Warning,
        ActionType::Ignore,
        "第三方软件目录，需自行判断，建议保留".to_string(),
    )
}

// ============================================================================
// 内置规则集
// ============================================================================

/// 获取内置规则集
pub fn get_builtin_ruleset() -> RuleSet {
    RuleSet {
        version: "1.0.0".to_string(),
        name: "ProgramData 内置规则集".to_string(),
        description: "Light-C 内置的 ProgramData 目录分析规则".to_string(),
        updated_at: "2026-04-21".to_string(),
        rules: vec![
            // ==================== Windows Update 相关 ====================
            Rule {
                id: "win-delivery-optimization".to_string(),
                name: "Windows 传递优化缓存".to_string(),
                match_mode: MatchMode::Contains,
                pattern: "Microsoft/Windows/DeliveryOptimization".to_string(),
                category: "Windows Update".to_string(),
                risk: RiskLevel::Safe,
                action: ActionType::Delete,
                description: "Windows 更新的 P2P 分发缓存，可安全删除".to_string(),
                suggestion: "删除后不影响系统，Windows 会在需要时重新下载".to_string(),
                min_size: 0,
                priority: 100,
                enabled: true,
                tags: vec!["windows".to_string(), "update".to_string(), "cache".to_string()],
            },
            Rule {
                id: "win-softwaredistribution".to_string(),
                name: "Windows Update 下载缓存".to_string(),
                match_mode: MatchMode::Contains,
                pattern: "Microsoft/Windows/SoftwareDistribution".to_string(),
                category: "Windows Update".to_string(),
                risk: RiskLevel::Warning,
                action: ActionType::Suggest,
                description: "Windows Update 下载的更新包缓存".to_string(),
                suggestion: "建议在 Windows Update 完成后清理".to_string(),
                min_size: 100 * 1024 * 1024, // 100MB
                priority: 90,
                enabled: true,
                tags: vec!["windows".to_string(), "update".to_string()],
            },
            Rule {
                id: "win-wer".to_string(),
                name: "Windows 错误报告".to_string(),
                match_mode: MatchMode::Contains,
                pattern: "Microsoft/Windows/WER".to_string(),
                category: "Windows Error".to_string(),
                risk: RiskLevel::Safe,
                action: ActionType::Delete,
                description: "Windows 错误报告和崩溃转储文件".to_string(),
                suggestion: "可以安全删除，不影响系统运行".to_string(),
                min_size: 0,
                priority: 100,
                enabled: true,
                tags: vec!["windows".to_string(), "error".to_string(), "dump".to_string()],
            },

            // ==================== Windows Defender 相关 ====================
            Rule {
                id: "defender-scans".to_string(),
                name: "Defender 扫描历史".to_string(),
                match_mode: MatchMode::Contains,
                pattern: "Microsoft/Windows Defender/Scans".to_string(),
                category: "Defender".to_string(),
                risk: RiskLevel::Safe,
                action: ActionType::Suggest,
                description: "Windows Defender 的扫描历史和隔离文件".to_string(),
                suggestion: "可以清理旧的扫描记录，保留最近的".to_string(),
                min_size: 50 * 1024 * 1024, // 50MB
                priority: 80,
                enabled: true,
                tags: vec!["defender".to_string(), "security".to_string()],
            },
            Rule {
                id: "defender-definition".to_string(),
                name: "Defender 病毒定义".to_string(),
                match_mode: MatchMode::Contains,
                pattern: "Microsoft/Windows Defender/Definition Updates".to_string(),
                category: "Defender".to_string(),
                risk: RiskLevel::Dangerous,
                action: ActionType::Protect,
                description: "Windows Defender 病毒库定义文件".to_string(),
                suggestion: "请勿删除，这是系统安全的重要组成部分".to_string(),
                min_size: 0,
                priority: 200,
                enabled: true,
                tags: vec!["defender".to_string(), "security".to_string(), "protected".to_string()],
            },

            // ==================== 驱动程序缓存 ====================
            Rule {
                id: "nvidia-cache".to_string(),
                name: "NVIDIA 驱动缓存".to_string(),
                match_mode: MatchMode::Prefix,
                pattern: "NVIDIA Corporation".to_string(),
                category: "Driver Cache".to_string(),
                risk: RiskLevel::Safe,
                action: ActionType::Suggest,
                description: "NVIDIA 显卡驱动的着色器缓存和临时文件".to_string(),
                suggestion: "可以清理，驱动会自动重建缓存".to_string(),
                min_size: 100 * 1024 * 1024, // 100MB
                priority: 70,
                enabled: true,
                tags: vec!["driver".to_string(), "nvidia".to_string(), "cache".to_string()],
            },
            Rule {
                id: "amd-cache".to_string(),
                name: "AMD 驱动缓存".to_string(),
                match_mode: MatchMode::Prefix,
                pattern: "AMD".to_string(),
                category: "Driver Cache".to_string(),
                risk: RiskLevel::Safe,
                action: ActionType::Suggest,
                description: "AMD 显卡驱动缓存文件".to_string(),
                suggestion: "可以清理，驱动会自动重建".to_string(),
                min_size: 100 * 1024 * 1024,
                priority: 70,
                enabled: true,
                tags: vec!["driver".to_string(), "amd".to_string(), "cache".to_string()],
            },
            Rule {
                id: "intel-cache".to_string(),
                name: "Intel 驱动数据".to_string(),
                match_mode: MatchMode::Prefix,
                pattern: "Intel".to_string(),
                category: "Driver Cache".to_string(),
                risk: RiskLevel::Warning,
                action: ActionType::Ignore,
                description: "Intel 驱动程序数据".to_string(),
                suggestion: "建议保留，可能包含重要配置".to_string(),
                min_size: 0,
                priority: 60,
                enabled: true,
                tags: vec!["driver".to_string(), "intel".to_string()],
            },

            // ==================== 软件包管理器 ====================
            Rule {
                id: "package-cache".to_string(),
                name: "软件包缓存".to_string(),
                match_mode: MatchMode::Exact,
                pattern: "Package Cache".to_string(),
                category: "Package Cache".to_string(),
                risk: RiskLevel::Warning,
                action: ActionType::Suggest,
                description: "Visual Studio 等软件的安装包缓存".to_string(),
                suggestion: "清理后可能影响软件修复/卸载，建议保留".to_string(),
                min_size: 500 * 1024 * 1024, // 500MB
                priority: 50,
                enabled: true,
                tags: vec!["package".to_string(), "installer".to_string()],
            },
            Rule {
                id: "chocolatey".to_string(),
                name: "Chocolatey 包管理器".to_string(),
                match_mode: MatchMode::Prefix,
                pattern: "chocolatey".to_string(),
                category: "Package Manager".to_string(),
                risk: RiskLevel::Dangerous,
                action: ActionType::Protect,
                description: "Chocolatey 包管理器数据".to_string(),
                suggestion: "请勿删除，这是包管理器的核心数据".to_string(),
                min_size: 0,
                priority: 200,
                enabled: true,
                tags: vec!["package".to_string(), "chocolatey".to_string(), "protected".to_string()],
            },

            // ==================== 应用程序数据 ====================
            Rule {
                id: "docker-data".to_string(),
                name: "Docker 数据".to_string(),
                match_mode: MatchMode::Prefix,
                pattern: "Docker".to_string(),
                category: "Application".to_string(),
                risk: RiskLevel::Dangerous,
                action: ActionType::Protect,
                description: "Docker 容器和镜像数据".to_string(),
                suggestion: "请勿直接删除，使用 docker system prune 清理".to_string(),
                min_size: 0,
                priority: 200,
                enabled: true,
                tags: vec!["docker".to_string(), "container".to_string(), "protected".to_string()],
            },
            Rule {
                id: "adobe-cache".to_string(),
                name: "Adobe 缓存".to_string(),
                match_mode: MatchMode::Prefix,
                pattern: "Adobe".to_string(),
                category: "Application".to_string(),
                risk: RiskLevel::Safe,
                action: ActionType::Suggest,
                description: "Adobe 软件的缓存和临时文件".to_string(),
                suggestion: "可以清理缓存，不影响软件使用".to_string(),
                min_size: 200 * 1024 * 1024,
                priority: 60,
                enabled: true,
                tags: vec!["adobe".to_string(), "cache".to_string()],
            },

            // ==================== 系统保护目录 ====================
            Rule {
                id: "regid".to_string(),
                name: "软件注册信息".to_string(),
                match_mode: MatchMode::Exact,
                pattern: "regid.1991-06.com.microsoft".to_string(),
                category: "System".to_string(),
                risk: RiskLevel::Dangerous,
                action: ActionType::Protect,
                description: "软件许可证和注册信息".to_string(),
                suggestion: "请勿删除，可能导致软件激活失效".to_string(),
                min_size: 0,
                priority: 200,
                enabled: true,
                tags: vec!["system".to_string(), "license".to_string(), "protected".to_string()],
            },
            Rule {
                id: "ssh".to_string(),
                name: "SSH 配置".to_string(),
                match_mode: MatchMode::Exact,
                pattern: "ssh".to_string(),
                category: "System".to_string(),
                risk: RiskLevel::Dangerous,
                action: ActionType::Protect,
                description: "OpenSSH 服务器配置和密钥".to_string(),
                suggestion: "请勿删除，包含重要的安全配置".to_string(),
                min_size: 0,
                priority: 200,
                enabled: true,
                tags: vec!["system".to_string(), "ssh".to_string(), "protected".to_string()],
            },
        ],
    }
}

/// 导出规则集为 JSON 字符串
pub fn export_ruleset_json(ruleset: &RuleSet) -> Result<String, RuleEngineError> {
    serde_json::to_string_pretty(ruleset)
        .map_err(|e| RuleEngineError::ParseError(e.to_string()))
}

/// 导出内置规则集为 JSON 文件
pub fn export_builtin_rules_to_file(path: &Path) -> Result<(), RuleEngineError> {
    let ruleset = get_builtin_ruleset();
    let json = export_ruleset_json(&ruleset)?;
    fs::write(path, json).map_err(|e| RuleEngineError::IoError(e.to_string()))
}

// ============================================================================
// 公共 API
// ============================================================================

/// 使用内置规则分析目录
pub fn analyze_programdata_entry(path: &str, size: u64) -> AnalyzeResult {
    let engine = RuleEngine::with_builtin_rules();
    engine.analyze(path, size)
}

/// 使用内置规则批量分析目录
pub fn analyze_programdata_entries(entries: &[(String, u64)]) -> BatchAnalyzeResult {
    let engine = RuleEngine::with_builtin_rules();
    engine.analyze_batch(entries)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_path() {
        assert_eq!(
            normalize_path("C:\\ProgramData\\Microsoft"),
            "c:/programdata/microsoft"
        );
    }

    #[test]
    fn test_builtin_rules() {
        let engine = RuleEngine::with_builtin_rules();
        assert!(engine.rule_count() > 0);
    }

    #[test]
    fn test_analyze_delivery_optimization() {
        let engine = RuleEngine::with_builtin_rules();
        let result = engine.analyze(
            "C:\\ProgramData\\Microsoft\\Windows\\DeliveryOptimization",
            1024 * 1024 * 500, // 500MB
        );
        
        assert_eq!(result.category, "Windows Update");
        assert_eq!(result.risk, RiskLevel::Safe);
        assert_eq!(result.action, ActionType::Delete);
    }

    #[test]
    fn test_analyze_unknown() {
        let engine = RuleEngine::with_builtin_rules();
        let result = engine.analyze(
            "C:\\ProgramData\\SomeUnknownApp",
            1024 * 1024, // 1MB
        );
        
        assert_eq!(result.category, "第三方软件");
    }

    #[test]
    fn test_export_json() {
        let ruleset = get_builtin_ruleset();
        let json = export_ruleset_json(&ruleset).unwrap();
        assert!(json.contains("ProgramData"));
    }
}
