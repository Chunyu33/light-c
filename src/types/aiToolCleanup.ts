/**
 * AI 工具清理的数据结构。
 *
 * 字段与后端 `ai_tool_cleaner.rs` 的 Serialize 输出一一对应（camelCase）。
 * 分组按工具来：用户先看到"哪个工具占了多少"，再决定删哪一项。
 */

/** 单个缓存目录 */
export interface AiCacheEntry {
  /** 目录名，如 "Cache" / "code cache" */
  name: string;
  path: string;
  size: number;
  fileCount: number;
}

/** 一个工具的汇总 */
export interface AiToolGroup {
  toolId: string;
  toolName: string;
  totalSize: number;
  fileCount: number;
  /** 该工具命中的缓存目录，按体积从大到小 */
  entries: AiCacheEntry[];
}

export interface AiToolScanResult {
  groups: AiToolGroup[];
  totalSize: number;
  totalFiles: number;
}
