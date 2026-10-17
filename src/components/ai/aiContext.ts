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
export function buildSystemPrompt(
  moduleId: string | null,
  dataSummary?: string | null,
  skipLookup = false,
): string {
  const info = moduleId ? MODULE_INFO[moduleId] : undefined;

  const lines = [
    '你是 LightC 内置的助手，帮助用户理解自己在软件里看到的数据、判断哪些内容可以清理。',
    '',
    info
      ? `当前用户正停留在「${info.name}」模块：${info.role}`
      : '当前没有打开具体的功能模块。',
  ];

  // 用户是**展开某一层之后**点的那一行的「咨询 AI 助手」（例如磁盘变化分析的「变化明细」弹窗）：
  // 那一项本身就在问题里，而且往往不在模块的读取能力里（文件级明细）。
  // 不说清这点，模型会先去查一次、碰壁，再冒出一句"没有读到内容"才作答。
  if (skipLookup) {
    lines.push(
      '',
      '⚠️ 这一次提问的对象，**用户已经在界面上看到了**（他点的是那一行上的按钮），',
      '而且它**不在你能读取的范围内**。所以：**不要调用任何工具去查**，直接用你自己的知识回答 ——',
      '讲清它通常是什么、有什么用、能不能删，并说明哪部分是推断。',
      '说一句"没有读到内容"就停下，是最差的回答。',
    );
  }

  // 有真实数据时注入；没有就明说没有，绝不让它凭印象描述（那正是"编造"的来源）
  if (dataSummary && dataSummary.trim()) {
    lines.push(
      '',
      '以下是当前模块的实时数据摘要，就是用户此刻在界面上看到的内容，回答时以此为准：',
      dataSummary.trim(),
      '',
      // ⚠️ 这句以前写的是"需要文件级明细就如实告诉用户看不到" —— 那是**只读工具还没有**的时候写的，
      // 后来加了 read_items / read_item_detail 却没同步改。于是它和第 4 条直接打架：
      // 模型照着这句回答"我看不到明细/只能看摘要"，就成了只会复述摘要的复读机。
      '注意：你拿到的是摘要，没有文件级明细。需要具体到某个文件或目录时，',
      '**用第 4 条里的只读工具去查**，不要凭空编造文件名或路径。',
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
    '2. 但**具体数字、路径、文件名**不能靠猜：摘要里没有的，先用只读工具去查（见第 4 条），',
    '   查不到再如实说"看不到"。编造细节比不回答更糟。',
    '3. 回答简洁，优先给结论，其次给理由；用用户正在使用的语言回答。',
    '',
    '—— 最后一条最重要，工具分两类，规则不同 ——',
    '4. **只读工具随便用，会改数据的工具只在被明确要求时用。**',
    '',
    '   【只读工具】read_items / read_item_detail：',
    '   用户问"这是什么东西""里面有什么""具体是哪些文件"时，**直接调用它们去看**。',
    '   它们不改任何东西，任何时候都可以用，也不受下面任何限制。',
    '   ⚠️ 不要回答"我看不到明细""系统没给我查询接口" —— 你能看，去调用就行了。',
    '   摘要里没有的细节，正是要靠这两个工具补上的。',
    '   ⚠️ 用户问的是界面上**某一个具体条目**（某条路径、某个文件名）时：**先读再答**。',
    '   只凭文件名推测、或者说"明细没读到、不过文件名已经说明……"，都是猜 ——',
    '   那是这个助手最没价值的回答，还不如直接说你查不到。',
    '   ⚠️⚠️ 但**读不到不等于不回答**：如果读取结果说"没有读到内容"、'
      + '"还没有扫描数据"、"这一层已经到底"，',
    '   或者你已经要了两三次还是同一份数据 —— **就停下，直接回答**：',
    '   用你自己的知识讲清这个东西通常是什么、有什么用、能不能删，并明确说明哪部分是推断、'
      + '哪些数据这次没读到。',
    '   **不要一直要数据，也不要只回一句"没读到"** —— 用户要的是答案，不是你的工作汇报。',
    '',
    '   【会改数据的工具】勾选、删除：',
    '   只有用户明确要求时才调用（"帮我删掉 X""把这些删了""勾上 X"）。',
    '   用户问"这是什么 / 有什么用 / 能不能删"，是在**了解情况**，不是在要你动手 ——',
    '   「能不能删」问的是你的判断，不是命令。',
    '   看不清意图就先问一句"你是想了解，还是想让我勾上它们？"，不要猜。',
    '   **当前模块能不能清理，与用户现在想做什么，是两件事。**',
    '   ⚠️ **只承诺你这一轮真正拿到的能力**：如果你没拿到勾选/删除工具（有些模块只支持查看），',
    '   就直说"这个模块里我不能替你勾选或删除，你可以自己勾选后点删除" ——',
    '   不要写成"你说一声我就去删"这种你做不到的承诺（用户当真照做，只会白跑一轮）。',
    '',
    '   照着这几个例子判断（**「不调工具」只针对会改数据的工具，只读工具照常调**）：',
    '   - "这个文件夹里是什么？" → 先用你自己的知识讲用途；要"里面具体有哪些文件"就调 read_items',
    '   - "文件夹「某路径」是做什么用的？可以删除吗？" → 同上（这正是行内「咨询 AI 助手」按钮发出的问句）',
    '   - "回收站能删吗？删了有什么影响？" → 直接回答（说清风险），**不要调用会改数据的工具**',
    '   - "这一堆缓存是干嘛的？" → 先讲用途；要看具体是哪些文件就调 read_items',
    '   - "帮我把回收站删了" → **拿到了** propose_delete 就调用它',
    '   - "把可以安全删的都勾上" → **拿到了** select_items 就调用它',
    '   （**没拿到**这两类工具时，就是上面那句"这个模块里我不能替你勾选或删除" —— 别有别的写法）',
  );
  return lines.join('\n');
}

/**
 * 把连续的同角色消息合并成一条。
 *
 * 为什么需要：一次只读查询会产出**多条** assistant 消息（每个工具调用一条），
 * 于是历史里会连着出现好几条 assistant。OpenAI 兼容协议能容忍，
 * **Anthropic 会直接报 "roles must alternate" 拒掉整个请求** ——
 * 而只要用户用过一次「咨询 AI 助手」（必然触发只读工具），之后每次提问都会撞上。
 */
function mergeConsecutiveRoles(messages: AiChatMessage[]): AiChatMessage[] {
  const merged: AiChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    // system 不参与合并：它必须是独立的第一条
    if (previous && previous.role === message.role && message.role !== 'system') {
      merged[merged.length - 1] = {
        role: previous.role,
        content: `${previous.content}\n\n${message.content}`,
        // 图片要一起带上：同一角色连发两条时它们各自可能带图
        images:
          previous.images || message.images
            ? [...(previous.images ?? []), ...(message.images ?? [])]
            : undefined,
      };
      continue;
    }
    merged.push(message);
  }
  return merged;
}

/** 本地工具结果发给模型时的前缀：说清"这是你要的数据"，而不是让模型以为这话是它自己说的。 */
const TOOL_OUTPUT_PREFIX = '【以下是你刚才要求查询的数据】\n';

/**
 * 把历史消息整理成可发送的形态。
 *
 * 唯一的转换是**本地工具结果**：它在界面上是一条 assistant 气泡，但发出去必须算用户侧内容 ——
 * 服务端要求"带 tools 的请求里，assistant 消息必须带上它的 reasoning_content"，
 * 而这条是本地拼出来的、没有思维链，当成 assistant 发出去会被直接 400 拒掉
 *（实测报错：The reasoning_content in the thinking mode must be passed back to the API）。
 */
function toRequestMessage(message: AiChatMessage, activeProfileId: string): AiChatMessage {
  if (message.role === 'assistant' && message.localToolOutput) {
    return { role: 'user', content: `${TOOL_OUTPUT_PREFIX}${message.content}` };
  }
  // 思维链只回传给**产出它的那份档案**：用户在会话中途换了服务商之后，
  // 它对新服务商就是个陌生字段 —— 而 OpenAI 的 messages 只认
  // role / content / name / tool_calls / tool_call_id / refusal，
  // 严格的网关会因此拒掉整个请求。宁可少回传，也不能让整个请求失败。
  if (message.reasoningContent && message.producedByProfile !== activeProfileId) {
    return { ...message, reasoningContent: undefined };
  }
  return message;
}

/**
 * 组装本次请求的完整消息：**现取的 system 提示** + 历史。
 *
 * system 刻意不进历史 —— 它依赖"当前模块"和"当前数据"，存下来必然过期。
 * 历史里只保留 user/assistant，于是切模块、重新扫描都不需要清理旧消息。
 *
 * `activeProfileId` 用来判断每条消息的思维链还该不该回传（见 toRequestMessage）。
 */
export function buildRequestMessages(
  history: AiChatMessage[],
  moduleId: string | null,
  dataSummary: string | null,
  activeProfileId: string,
  skipLookup = false,
): AiChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(moduleId, dataSummary, skipLookup) },
    ...mergeConsecutiveRoles(
      history
        .filter((message) => message.role !== 'system')
        .map((message) => toRequestMessage(message, activeProfileId)),
    ),
  ];
}

/** 取模块显示名。未知模块返回空串，界面据此不显示"· xxx"尾巴。 */
export function getModuleDisplayName(moduleId: string | null): string {
  if (!moduleId) return '';
  return MODULE_INFO[moduleId]?.name ?? '';
}
