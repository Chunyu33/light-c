//! AI 工具清理的数据结构。
//!
//! 只放 serde 结构体，不放逻辑 —— 前端 `src/types/aiToolCleanup.ts` 与本文件一一对应。

use serde::Serialize;

/// 单个缓存目录的统计结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCacheEntry {
    /// 目录名（用于界面展示，如 "Cache" / "media_cache"）
    pub name: String,
    pub path: String,
    pub size: u64,
    pub file_count: usize,
}

/// 缓存目录里的单个文件，供明细弹窗按需拉取。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCacheFile {
    pub path: String,
    pub size: u64,
}

/// 一个工具的汇总。界面按工具分组展示，用户先看到"哪个工具占了多少"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolGroup {
    pub tool_id: String,
    pub tool_name: String,
    pub total_size: u64,
    pub file_count: usize,
    /// 该工具下命中的缓存目录，按体积从大到小
    pub entries: Vec<AiCacheEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolScanResult {
    pub groups: Vec<AiToolGroup>,
    pub total_size: u64,
    pub total_files: usize,
}


