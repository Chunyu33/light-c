// ============================================================================
// 模块接入 AI 助手的唯一入口
//
// 设计目标：**模块侧只写这一个 hook，且不同模块写的东西形状完全一样。**
//
// 为什么值得单独抽一层：模块之间的差异是**业务本身**带来的，不可能消除 ——
// 垃圾清理的数据是分类列表、旧驱动是驱动包、大文件是目录树，摘要内容必然不同。
// 但"把差异喂给 AI"的**管道**必须完全一致，否则接 11 个模块就是 11 种写法，
// 那才是真正难维护的地方。
//
// 于是分工变成：
//   - 模块提供：**数据长什么样**（summary）+ **哪些东西能被操作**（targets）+ **怎么操作**（onSelect / onDelete）
//   - 公共层提供：摘要里 id 的格式、注入时机、动作登记、确认卡片、权限与开关
//
// ⚠️ 关于删除：onDelete **必须调用模块原有的删除函数**。这里不会、也不该替模块实现删除 ——
//    模块自己的校验、备份、复核逻辑必须继续生效，否则就会出现"手动删很安全、
//    AI 删走了另一条路"的分裂。
// ============================================================================

import type { AiDeleteOutcome, AiReadPage } from './moduleActionRegistry';
import { useModuleActions } from './moduleActionRegistry';
import { useModuleDataSummary } from './moduleDataRegistry';

/** 一个可被 AI 操作的对象。id 必须稳定（模块自己能解析回来），label 给人看。 */
export interface AiModuleTarget {
  id: string;
  label: string;
  /** 大小、项数等说明，模块格式化好 */
  detail?: string;
  /** 删除后不可恢复（回收站这类），界面会单独标注 */
  irreversible?: boolean;
}

/**
 * 把一页明细渲染成给模型看的文本，**并强制附上"这是第几条到第几条、共多少条"**。
 *
 * 这一句是整个渐进式读取里最关键的约束：模型只有在明确知道自己没看全时，
 * 才会说"还需要再看"；否则它会默认看到的就是全部，直接给出错误结论。
 */
export function formatReadPage(page: AiReadPage, offset: number): string {
  const shown = page.lines.length;
  const more = page.total > offset + shown;
  const footer = more
    ? `\n\n（以上是第 ${offset + 1} 到 ${offset + shown} 条，共 ${page.total} 条，**还有更多未显示**；需要时再调用并加大 offset）`
    : `\n\n（以上是全部 ${page.total} 条）`;
  return page.lines.join('\n') + footer;
}

export interface AiModuleBridge {
  /** 一段自然语言摘要：扫描了什么、多大多小、用户当前在做什么。返回 null 表示还没有数据。 */
  summary?: () => string | null;
  /** 可被 AI 操作的对象列表。返回空数组表示当前没有可操作项。 */
  targets?: () => AiModuleTarget[];
  /** AI 请求"勾选这些项"时调用（P3a，无风险）。 */
  onSelect?: (ids: string[]) => void;
  /** AI 请求删除时，**用户确认之后**才会调用（P3b）。必须走模块原有删除入口。 */
  onDelete?: (ids: string[]) => Promise<AiDeleteOutcome>;

  /**
   * 只读：读取某个可操作项下的一页明细。
   * 登记了它，模型才会拿到 read_items 工具 —— 也才知道自己"能往下看"。
   */
  readItems?: (targetId: string, offset: number, limit: number) => AiReadPage | null;
  /** 只读：读取单条条目详情。 */
  readItemDetail?: (itemId: string) => string | null;
}

/**
 * 把模块数据与动作渲染成给模型看的摘要。
 *
 * **id 的呈现格式由这里统一决定**，模块不用关心 ——
 * 这正是"不同模块写法一致"的关键：模块只交出结构化数据，格式化在公共层。
 */
export function composeModuleSummary(bridge: AiModuleBridge): string | null {
  const summaryText = bridge.summary?.() ?? null;
  const targets = bridge.targets?.() ?? [];

  if (!summaryText && targets.length === 0) return null;

  const lines: string[] = [];
  if (summaryText) lines.push(summaryText.trim());

  if (targets.length > 0) {
    lines.push(
      '',
      '可操作项（要操作某一项时请使用方括号里的 id，不要用名称）：',
      ...targets.map((target) => {
        const parts = [`[id: ${target.id}]`, target.label];
        if (target.detail) parts.push(target.detail);
        if (target.irreversible) parts.push('（删除后不可恢复）');
        return `- ${parts.join(' · ')}`;
      }),
    );
  }

  return lines.join('\n');
}

/**
 * 模块接入 AI 助手只需要调这一个 hook。
 *
 * ```tsx
 * useAiModuleBridge('junk-clean', {
 *   summary: () => `共 ${result.total_file_count} 个文件…`,
 *   targets: () => result.categories.map((c) => ({
 *     id: c.display_name, label: c.display_name, detail: formatSize(c.total_size),
 *   })),
 *   onSelect: (ids) => selectCategories(ids),
 *   onDelete: (ids) => deleteCategories(ids),   // 走模块原有删除入口
 * });
 * ```
 */
export function useAiModuleBridge(moduleId: string, bridge: AiModuleBridge): void {
  // 摘要：每次发送时现取（内部已保证拿最新闭包）
  useModuleDataSummary(moduleId, () => composeModuleSummary(bridge));

  // 动作：只登记模块真正提供了的那几个，其余保持 undefined ——
  // 调用方据此判断"这个模块能不能被 AI 操作"，而不是点了才发现没实现
  useModuleActions(moduleId, {
    resolveTargets: bridge.targets
      ? (ids) => {
          const available = bridge.targets?.() ?? [];
          // 用 id 反查：**不接受模型直接给的名称**，也不信任过期的 id
          return ids
            .map((id) => available.find((target) => target.id === id))
            .filter((target): target is AiModuleTarget => Boolean(target))
            .map((target) => ({
              id: target.id,
              label: target.label,
              detail: target.detail,
              irreversible: target.irreversible,
            }));
        }
      : undefined,
    selectItems: bridge.onSelect,
    deleteItems: bridge.onDelete,
    // 只读能力直接透传：没有登记就是 undefined，前端据此决定要不要声明工具
    readItems: bridge.readItems,
    readItemDetail: bridge.readItemDetail,
  });
}
