// ============================================================================
// AI 对话上下文构造
//
// 分三层（见 docs/dev/AI助手-设计方案.md）：
//   ① 系统提示 —— 固定且体积很小，本文件负责
//   ② 模块数据摘要 —— 下一阶段由各模块提供适配器
//   ③ 对话历史 —— 由面板维护（保留最近若干轮）
//
// ⚠️ 明确禁止的做法：把模块的原始列表塞进 prompt。
// 垃圾清理一次能扫出几千个文件，全量注入会直接把上下文撑爆，又慢又贵还答不准。
// 正确的做法是"摘要 + 让 AI 用工具按需取明细"。
// ============================================================================

import type { AiChatMessage } from '../../types/ai';

/**
 * 各模块对 AI 的说明：显示名 + 一句话职责。
 * 只交代"这个模块在做什么"，不含任何用户数据。
 */
const MODULE_INFO: Record<string, { name: string; role: string }> = {
  'junk-clean': { name: '垃圾清理', role: '扫描系统与各类应用的临时文件、缓存，由用户勾选后删除。' },
  'big-files': { name: '大文件清理', role: '按大小找出占空间的大文件，供用户判断后删除。' },
  'social-clean': { name: '社交软件专清', role: '定位微信、QQ 等聊天软件产生的缓存。' },
  'system-slim': { name: '系统瘦身', role: '处理系统组件、休眠文件、还原点等系统级占用。' },
  'driver-cleanup': { name: '旧驱动清理', role: '识别被更高版本替代的旧驱动包，删除前会自动备份。' },
  leftovers: { name: '残留清理', role: '查找软件卸载后遗留的目录与文件。' },
  registry: { name: '注册表清理', role: '检查孤立键值与无效引用。' },
  'context-menu': { name: '右键菜单管理', role: '管理资源管理器右键菜单项。' },
  hotspot: { name: '大目录分析', role: '递归分析目录占用，定位空间被谁吃掉。' },
  'disk-growth': { name: '磁盘变化分析', role: '对比两次快照，找出空间增减的来源。' },
  'ai-models': { name: 'AI 模型空间', role: '统计本地大模型文件占用。' },
  'shell-icons': { name: '外壳入口管理', role: '管理系统「此电脑」等位置的第三方入口。' },
};

/**
 * 组装系统提示：应用身份 + 当前模块角色 + **实时数据摘要** + 行为约束。
 *
 * 摘要由模块在每次发送时现取（见 moduleDataRegistry），这里不做缓存 ——
 * 用户可能刚扫完、刚勾选，缓存一秒都会让助手答错。
 */
export function buildSystemPrompt(moduleId: string | null, dataSummary?: string | null): string {
  const info = moduleId ? MODULE_INFO[moduleId] : undefined;

  const lines = [
    '你是 LightC 内置的助手，帮助用户理解自己在软件里看到的数据、判断哪些内容可以清理。',
    '',
    info
      ? `当前用户正停留在「${info.name}」模块：${info.role}`
      : '当前没有打开具体的功能模块。',
  ];

  // 有真实数据时注入；没有就明说没有，绝不让它凭印象描述（那正是"编造"的来源）
  if (dataSummary && dataSummary.trim()) {
    lines.push(
      '',
      '以下是当前模块的实时数据摘要，就是用户此刻在界面上看到的内容，回答时以此为准：',
      dataSummary.trim(),
      '',
      '注意：你拿到的是摘要，没有文件级明细。需要具体到某个文件时，如实告诉用户"需要查看完整明细"，不要凭空编造文件名或路径。',
    );
  } else {
    lines.push(
      '',
      '当前没有取到该模块的数据（用户可能还没有扫描）。不要凭猜测描述里面的内容，直接说明"还没有扫描数据"。',
    );
  }

  lines.push(
    '',
    '行为约束：',
    '1. **用你自己的知识回答**。用户问"这个文件/驱动/项目是什么、有什么用、能不能删"时，',
    '   这正是期望你做的 —— 你了解 Windows 系统与常见软件，请直接讲清楚。',
    '   （不要因为"摘要里没写它的用途"就拒答，那样助手就没有价值了。）',
    '2. 但**具体数字、路径、文件名**必须以摘要为准：摘要里没有的，不要凭印象编造，',
    '   直接说"这里看不到明细"。编造细节比不回答更糟。',
    '3. 你可以调用工具替用户**准备**操作（勾选、申请删除）。注意"申请"不等于"已经删除"：',
    '   申请之后界面会弹出确认框，由用户自己决定要不要执行 —— 所以放心提案，',
    '   但**绝不要说"我已经删掉了"**，也不要说自己没有权限而拒绝提案。',
    '4. 如果本次没有提供某个工具，说明当前模块不支持这类操作，这时如实说明即可。',
    '5. 回答简洁，优先给结论，其次给理由；用用户正在使用的语言回答。',
  );
  return lines.join('\n');
}

/**
 * 组装本次请求的完整消息：**现取的 system 提示** + 历史。
 *
 * system 刻意不进历史 —— 它依赖"当前模块"和"当前数据"，存下来必然过期。
 * 历史里只保留 user/assistant，于是切模块、重新扫描都不需要清理旧消息。
 */
export function buildRequestMessages(
  history: AiChatMessage[],
  moduleId: string | null,
  dataSummary: string | null,
): AiChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(moduleId, dataSummary) },
    ...history.filter((message) => message.role !== 'system'),
  ];
}

/** 取模块显示名。未知模块返回空串，界面据此不显示"· xxx"尾巴。 */
export function getModuleDisplayName(moduleId: string | null): string {
  if (!moduleId) return '';
  return MODULE_INFO[moduleId]?.name ?? '';
}
