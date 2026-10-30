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

/** 缓存目录里的单个文件（明细弹窗按需拉取） */
export interface AiCacheFile {
  path: string;
  size: number;
}

/** 明细弹窗的文件列表 */
export interface AiCacheFileList {
  files: AiCacheFile[];
  /** 目录文件数超过上限被截断：界面必须说明只显示了前 N 条 */
  truncated: boolean;
}

/** 单个删除失败的目录 */
export interface AiCacheDeleteFailure {
  path: string;
  /** 失败原因（系统错误原文），仅用于排查，界面上不直接展示 */
  reason: string;
}

/** 批量删除结果 */
export interface AiCacheDeleteResult {
  /** 成功删掉的目录数 */
  deleted: number;
  /** 没删掉的目录及原因（工具开启时文件被占用是最常见的情况） */
  failed: AiCacheDeleteFailure[];
}
