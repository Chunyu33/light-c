// ============================================================================
// AI 配置的"已变更"信号
//
// 磁盘上的 AI 配置只有一份，但内存里有**两份副本**：助手面板一份（`AiAssistant` 的
// `aiConfig`）、设置页一份（`AiSettings` 的 `saved`）。设置页保存后只更新自己那份，
// 助手那份不动 —— 于是"刚配好服务商就点快捷提问"仍会被拦下（`canChat` 还是 false）。
//
// 这里按 `aiAsk.ts` 的同一套思路做极小的模块级广播：**设置页只管喊一声"变了"，
// 助手自己去磁盘重新读**。不在两个组件之间传状态，也不引入新的状态库。
//
// 为什么不让设置页直接把新配置塞给助手：助手需要的永远是"磁盘上的当前状态"，
// 中间态（保存失败、切换档案、删档案）太多了，让唯一的真相源（磁盘）说话更不容易错。
// ============================================================================

type Listener = () => void;

const listeners = new Set<Listener>();

/** 广播"AI 配置已变更"。设置页在任何一次写入磁盘后调用。 */
export function notifyAiConfigChanged(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      // 单个订阅者出错不能影响其它订阅者（也避免把设置页的保存流程带崩）
      console.error('AI 配置变更通知处理失败:', error);
    }
  });
}

/** 订阅配置变更，返回取消订阅函数（直接用于 useEffect 的清理）。 */
export function subscribeAiConfig(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
