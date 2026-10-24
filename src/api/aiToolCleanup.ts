/**
 * AI 工具清理的调用层。
 *
 * 只做 invoke 转发，字段与 `src/types/aiToolCleanup.ts` 对应。
 */
import { invoke } from '@tauri-apps/api/core';
import type { AiToolScanResult } from '../types/aiToolCleanup';

/** 扫描各家 AI 工具的可清理缓存 */
export function scanAiToolCaches(): Promise<AiToolScanResult> {
  return invoke('scan_ai_tool_caches');
}
