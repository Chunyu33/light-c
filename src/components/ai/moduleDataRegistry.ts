// ============================================================================
// 模块数据摘要登记表
//
// 让 AI 助手能拿到「当前模块正在展示什么」，但**不要求模块改造自己的结构**：
// 模块只在挂载时登记一个"取摘要"的函数，助手在每次发送前调用它拿最新数据。
//
// 三条硬约束：
// 1. 只登记**摘要**。明细绝不进 prompt —— 垃圾清理一次能扫出几千个文件，
//    全量注入会直接撑爆上下文，又慢又贵还答不准。明细留给后续的工具调用按需取。
// 2. 用**函数**而不是快照：模块里的数据会随着扫描、勾选不断变，每次发送都要取最新的。
// 3. 卸载必须注销。否则助手会拿着上一个模块的旧数据回答 —— 那比"不知道"更糟。
// ============================================================================

import { useEffect, useRef } from 'react';

/** 返回一段纯文本摘要；返回 null 表示"当前没有数据"（例如还没扫描）。 */
export type ModuleDataSummaryProvider = () => string | null;

const providers = new Map<string, ModuleDataSummaryProvider>();

/** 登记某个模块的数据摘要提供者，返回注销函数。 */
export function registerModuleDataProvider(
  moduleId: string,
  provider: ModuleDataSummaryProvider,
): () => void {
  providers.set(moduleId, provider);
  return () => {
    // 只有"当前登记的还是自己"才删除：避免旧实例卸载时把新实例的登记顶掉
    // （页面模式下模块实例可能先挂载后卸载，顺序不保证）。
    if (providers.get(moduleId) === provider) {
      providers.delete(moduleId);
    }
  };
}

/** 取某个模块的摘要。没有任何登记、或摘要生成抛错时都返回 null（助手如实说"没数据"）。 */
export function getModuleDataSummary(moduleId: string | null): string | null {
  if (!moduleId) return null;
  const provider = providers.get(moduleId);
  if (!provider) return null;
  try {
    return provider();
  } catch (error) {
    // 摘要生成失败不该影响对话本身，降级为"没有数据"
    console.error('生成模块数据摘要失败:', error);
    return null;
  }
}

/**
 * 模块侧使用的登记钩子。
 * builder 存在 ref 里：否则每次渲染都会重新登记/注销一遍，白白制造副作用。
 */
export function useModuleDataSummary(moduleId: string, builder: () => string | null): void {
  const builderRef = useRef(builder);
  builderRef.current = builder;

  useEffect(() => registerModuleDataProvider(moduleId, () => builderRef.current()), [moduleId]);
}
