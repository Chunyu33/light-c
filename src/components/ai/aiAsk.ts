// ============================================================================
// 快捷提问通道
//
// 各模块的数据行上会放一个「咨询 AI 助手」按钮，点击后要：**打开助手并把问题直接发出去**。
// 但模块组件在很深的层级里，助手挂在 App 顶层 —— 用 context 逐层透传会污染一路组件。
//
// 所以这里用一个极小的模块级订阅：模块只管"发一个提问请求"，
// 助手订阅后自行打开面板并发送。与 moduleDataRegistry 是同一套思路：
// **模块不需要知道助手在哪，助手也不需要知道按钮长什么样。**
//
// 问题文本由模块决定（通常是复用它原有的"一键搜索"关键字），这里不做任何改写。
// ============================================================================

import { useSyncExternalStore } from 'react';

export interface AiAskRequest {
  /** 自增序号：相同文本连点两次也要能触发第二次 */
  id: number;
  text: string;
  /**
   * 这一问**不需要去查数据**。
   *
   * 用在"用户自己从界面上展开看到的那一行"（例如磁盘变化分析的「变化明细」弹窗）：
   * 问句里带的就是那一行本身，而这些**文件级**明细并不在模块的读取能力里 ——
   * 让模型去查只会白试一次，还会先冒出一句"没有读到内容"再作答。
   * 置位后：本轮不声明任何工具，并在系统提示里说明"数据就在问题里，直接用你自己的知识回答"。
   */
  skipLookup: boolean;
}

let sequence = 0;
let pending: AiAskRequest | null = null;
const listeners = new Set<() => void>();

/** 供 useSyncExternalStore 使用：返回订阅函数。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 模块侧调用：请求助手打开并发送这个问题。 */
export function requestAiAsk(text: string, options?: { skipLookup?: boolean }): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  sequence += 1;
  pending = { id: sequence, text: trimmed, skipLookup: options?.skipLookup === true };
  listeners.forEach((listener) => listener());
}

/** 助手处理完后清空，避免重新挂载时重复发送。 */
export function clearAiAsk(): void {
  if (pending === null) return;
  pending = null;
  listeners.forEach((listener) => listener());
}

/** 助手侧订阅：拿到待处理的提问（没有则为 null）。 */
export function useAiAskRequest(): AiAskRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => pending,
    () => null,
  );
}
