/**
 * AI 工具清理的调用层。
 *
 * 只做 invoke 转发，字段与 `src/types/aiToolCleanup.ts` 对应。
 */
import { invoke } from '@tauri-apps/api/core';
import type { AiCacheFile, AiToolScanResult } from '../types/aiToolCleanup';

/** 扫描各家 AI 工具的可清理缓存 */
export function scanAiToolCaches(): Promise<AiToolScanResult> {
  return invoke('scan_ai_tool_caches');
}

/**
 * 删除选中的缓存目录，返回实际删掉的目录数。
 *
 * 后端会再校验一遍路径归属（目录名在白名单里、且在已登记工具的根目录下），
 * 所以这里传上来的路径即使被篡改也删不掉越界的东西。
 */
export function deleteAiToolCaches(paths: string[]): Promise<number> {
  return invoke('delete_ai_tool_caches', { paths });
}

/**
 * 列出某个缓存目录下的全部文件。
 *
 * 按需调用：单个工具可能有上千个文件，扫描阶段只给汇总，
 * 用户点「查看全部」才拉明细，避免扫描结果变得很大。
 */
export function listAiCacheFiles(path: string): Promise<AiCacheFile[]> {
  return invoke('list_ai_cache_files', { path });
}
