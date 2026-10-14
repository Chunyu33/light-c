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
export function requestAiAsk(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  sequence += 1;
  pending = { id: sequence, text: trimmed };
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
