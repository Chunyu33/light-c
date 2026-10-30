/**
 * AI 工具清理的调用层。
 *
 * 只做 invoke 转发，字段与 `src/types/aiToolCleanup.ts` 对应。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AiCacheDeleteResult,
  AiCacheFileList,
  AiToolScanResult,
} from '../types/aiToolCleanup';

/** 扫描各家 AI 工具的可清理缓存 */
export function scanAiToolCaches(): Promise<AiToolScanResult> {
  return invoke('scan_ai_tool_caches');
}

/**
 * 删除选中的缓存目录，返回成功数与失败明细。
 *
 * 后端会再校验一遍路径归属（不含 `..`、目录名在该工具允许的范围内、且在它的根目录之下），
 * 所以这里传上来的路径即使被篡改也删不掉越界的东西。
 *
 * 返回值必须看 `failed`：工具开着时缓存文件常被占用，删除会部分失败，
 * 只读成功数会让界面显示"已删完"而实际占用没降。
 */
export function deleteAiToolCaches(paths: string[]): Promise<AiCacheDeleteResult> {
  return invoke('delete_ai_tool_caches', { paths });
}

/**
 * 列出某个缓存目录下的全部文件。
 *
 * 按需调用：单个工具可能有上千个文件，扫描阶段只给汇总，
 * 用户点「查看全部」才拉明细，避免扫描结果变得很大。
 * 超过上限会被后端截断，`truncated` 为真时界面要说明只显示了前 N 条。
 */
export function listAiCacheFiles(path: string): Promise<AiCacheFileList> {
  return invoke('list_ai_cache_files', { path });
}
