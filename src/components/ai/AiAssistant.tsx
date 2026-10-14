// ============================================================================
// AI 助手：悬浮球 + 对话面板
//
// 横向新增的独立功能，挂载在 App 的全局 layer 里，**不参与任何模块的逻辑**。
// 面板做成"非模态浮层 + 可收缩"，保证不遮挡模块主页面（Evan 明确要求）。
//
// 会话状态（消息、发送中、错误）都在这一层，面板只负责展示与输入。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { aiChat, aiChatStream, appendAiSessionMessage, clearAiSession, getAiConfig, listenAiStream, listAiProviders, loadAiSession, localDateKey } from '../../api/ai';
import type { AiChatMessage, AiToolCall } from '../../types/ai';
import { AiChatPanel } from './AiChatPanel';
import { AiMarkIcon } from './AiMarkIcon';
import { buildRequestMessages, getModuleDisplayName } from './aiContext';
import { getModuleDataSummary } from './moduleDataRegistry';
import { getModuleActions } from './moduleActionRegistry';
import type { AiDeleteOutcome, AiDeleteTargetSummary } from './moduleActionRegistry';
import { clearAiAsk, useAiAskRequest } from './aiAsk';

/** 只保留最近若干轮对话：更早的内容交给后续版本的滚动摘要处理。 */
const MAX_HISTORY_MESSAGES = 16;

interface AiAssistantProps {
  /** 当前模块 id（App 里的 visibleModuleId）；用于让助手知道"用户现在在哪" */
  activeModuleId: string | null;
}

export function AiAssistant({ activeModuleId }: AiAssistantProps) {
  const { t } = useTranslation('ai');
  const [isOpen, setIsOpen] = useState(false);
  /**
   * **按模块隔离**的会话历史：每个模块一份，切换模块就换一套，没有就是空的。
   * 用「模块 id → 消息数组」而不是单一数组，是为了让"在垃圾清理聊过的话"
   * 不会出现在旧驱动的面板里（Evan 反馈过这个串台）。
   */
  const [historyByModule, setHistoryByModule] = useState<Record<string, AiChatMessage[]>>({});
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  // 流式增量拼起来的"正在生成的回答"。它不进历史 —— 只有命令返回的完整正文才入库，
  // 这样即使漏掉几个事件，最终内容也不会残缺。
  const [streamingText, setStreamingText] = useState('');

  // 用 ref 保存"正在请求"的标记，避免快速连点导致并发请求
  const sendingRef = useRef(false);
  // 已经向磁盘要过历史的模块，避免来回切换时反复读文件
  const loadedModulesRef = useRef<Set<string>>(new Set());

  const moduleName = useMemo(() => getModuleDisplayName(activeModuleId), [activeModuleId]);

  /**
   * 当前实际使用的模型与服务商，只用于**显示**。
   *
   * 必须让用户看得到：出问题时（答得差、报错）第一句话一定是"这是什么模型"。
   * 每次打开面板时读一次 —— 用户可能在设置里改过配置，面板还开着。
   */
  const [activeModelLabel, setActiveModelLabel] = useState('');
  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      try {
        const [config, providers] = await Promise.all([getAiConfig(), listAiProviders()]);
        // 显示"当前档案"的模型与服务商：多档案之后，全局字段已经不是配置单位
        const active =
          config.profiles.find((item) => item.id === config.activeProfileId) ?? config.profiles[0];
        if (!active) {
          setActiveModelLabel('');
          return;
        }
        const providerName =
          providers.find((item) => item.id === active.providerId)?.name || active.providerId || '';
        setActiveModelLabel([active.model || '未选择模型', providerName].filter(Boolean).join(' · '));
      } catch (error) {
        console.error('读取当前 AI 配置失败:', error);
      }
    })();
  }, [isOpen]);
  const currentHistory = historyByModule[activeModuleId ?? ''] ?? [];

  /** 写一条消息到该模块的历史（内存） */
  const pushMessage = useCallback((moduleId: string, message: AiChatMessage) => {
    setHistoryByModule((previous) => ({
      ...previous,
      [moduleId]: [...(previous[moduleId] ?? []), message],
    }));
  }, []);

  /**
   * 首次进入某个模块时，把当天的历史从磁盘读回来。
   * 落盘失败、读盘失败都只在控制台报错 —— 会话记录是附属能力，不该阻断对话本身。
   */
  useEffect(() => {
    const moduleId = activeModuleId ?? '';
    if (!moduleId || loadedModulesRef.current.has(moduleId)) return;
    loadedModulesRef.current.add(moduleId);

    void (async () => {
      try {
        const stored = await loadAiSession(moduleId, localDateKey());
        if (stored.length === 0) return;
        setHistoryByModule((previous) => ({
          ...previous,
          [moduleId]: stored.map((item) => ({ role: item.role, content: item.content })),
        }));
      } catch (error) {
        console.error('读取 AI 会话历史失败:', error);
      }
    })();
  }, [activeModuleId]);

  /**
   * 待确认的删除提案。**它不是历史消息**：卡片带回调、不可序列化，
   * 所以只作为临时状态展示在消息列表末尾，确认或取消后即消失。
   */
  const [pendingDelete, setPendingDelete] = useState<{
    moduleId: string;
    ids: string[];
    items: AiDeleteTargetSummary[];
  } | null>(null);
  /** 最近一次删除结果，同样只在本次会话里展示 */
  const [deleteResult, setDeleteResult] = useState<AiDeleteOutcome | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  /** 用户点了「确认删除」：这时才真正调用模块的删除入口。 */
  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { moduleId, ids } = pendingDelete;
    const actions = getModuleActions(moduleId);
    if (!actions?.deleteItems) {
      setPendingDelete(null);
      return;
    }
    setIsDeleting(true);
    try {
      const outcome = await actions.deleteItems(ids);
      setDeleteResult(outcome);
    } catch (error) {
      // 失败也要给用户一个明确交代，而不是卡片消失、什么都没发生
      setDeleteResult({ deletedCount: 0, failures: [{ name: '', reason: String(error) }] });
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }, [pendingDelete]);

  /**
   * 执行模型请求的工具调用，把结果作为一条**本地消息**写进对话。
   *
   * 结果文案由这里生成、不交给模型转述 —— 做了什么、影响了几项，
   * 一律以本地事实为准，避免出现"AI 说自己删了、其实没删"。
   */
  const runToolCalls = useCallback(
    (moduleId: string, calls: AiToolCall[]) => {
      const actions = getModuleActions(moduleId);
      for (const call of calls) {
        const rawIds = (call.arguments as { ids?: unknown }).ids;
        const ids = Array.isArray(rawIds)
          ? rawIds.filter((id): id is string => typeof id === 'string')
          : [];

        // 一律拿 id 反查模块当前数据：提案到执行之间用户可能又改过勾选、模块可能重扫过，
        // 解析不到的项直接剔除，绝不照着旧 id 硬执行。
        const resolved = actions?.resolveTargets?.(ids) ?? [];

        if (call.name === 'select_items') {
          if (resolved.length === 0) {
            pushMessage(moduleId, { role: 'assistant', content: t('tool.selectNotFound') });
            continue;
          }
          actions?.selectItems?.(resolved.map((target) => target.id));
          pushMessage(moduleId, {
            role: 'assistant',
            content: t('tool.selected', {
              count: resolved.length,
              names: resolved.map((target) => target.label).join('、'),
            }),
          });
          continue;
        }

        if (call.name === 'propose_delete') {
          if (resolved.length === 0) {
            pushMessage(moduleId, { role: 'assistant', content: t('tool.selectNotFound') });
            continue;
          }
          // **不执行**，只弹出确认卡片 —— AI 只能提案，执行权在用户手里
          setDeleteResult(null);
          setPendingDelete({
            moduleId,
            ids: resolved.map((target) => target.id),
            items: resolved,
          });
        }
      }
    },
    [pushMessage, t],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;

      // 抓一份"发送时"的模块与历史：用户可能在生成过程中切模块，
      // 这一轮的结果必须落回发起时那个模块，而不是"当前"模块（否则又串台了）。
      const moduleId = activeModuleId ?? '';
      const history = historyByModule[moduleId] ?? [];
      setIsSending(true);
      setErrorMessage('');
      setStreamingText('');

      const userMessage: AiChatMessage = { role: 'user', content: text };
      pushMessage(moduleId, userMessage);
      // 落盘失败只记日志：会话记录是附属能力，不该让对话本身失败
      void appendAiSessionMessage(moduleId, localDateKey(), {
        role: 'user',
        content: text,
        at: Date.now(),
      }).catch((error) => console.error('写入 AI 会话历史失败:', error));

      const nextMessages: AiChatMessage[] = [...history, userMessage];
      // 每次请求一个独立的流标识：事件是全局广播的，靠它过滤掉别人的增量。
      const streamId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      let unlisten: (() => void) | null = null;

      try {
        // 先挂监听再发请求，否则首批增量可能在挂上之前就到了
        unlisten = await listenAiStream((delta) => {
          if (delta.streamId !== streamId) return;
          setStreamingText((previous) => previous + delta.text);
        });

        // 每次发送现取"当前模块的数据摘要"：用户可能刚扫完或刚勾选，缓存一秒都会答错。
        const dataSummary = getModuleDataSummary(moduleId);
        const request = buildRequestMessages(nextMessages, moduleId, dataSummary);

        // 本次允许的工具：**只按该模块登记了哪些动作来给**。
        // 只分析不删除的模块（磁盘变化分析、AI 模型空间）一个都不给 ——
        // 模型连"提议删除"的入口都看不到，也就无从提议。
        const actions = getModuleActions(moduleId);
        const tools: string[] = [];
        if (actions?.selectItems) tools.push('select_items');
        if (actions?.deleteItems) tools.push('propose_delete');

        const reply = tools.length > 0
          // 带工具时走非流式：工具参数是分片吐出来的半个 JSON，拼接容易出错，
          // 而且"提案"本来就不需要边生成边看。
          ? await aiChat({ messages: trimHistory(request), tools })
          : await aiChatStream({ messages: trimHistory(request) }, streamId);

        // 模型没回话、而是要求执行动作
        if ((reply.toolCalls?.length ?? 0) > 0) {
          runToolCalls(moduleId, reply.toolCalls ?? []);
          return;
        }

        // 以命令返回的完整正文入库：事件只负责过程中的实时显示
        pushMessage(moduleId, { role: 'assistant', content: reply.content });
        void appendAiSessionMessage(moduleId, localDateKey(), {
          role: 'assistant',
          content: reply.content,
          at: Date.now(),
        }).catch((error) => console.error('写入 AI 会话历史失败:', error));
      } catch (error) {
        // 失败时保留用户输入在历史里，方便直接重试；错误单独展示，不混进对话正文。
        setErrorMessage(String(error));
      } finally {
        // 必须取消监听：否则一次对话留下一个永久监听器，下次的增量会被累加两遍
        unlisten?.();
        setStreamingText('');
        sendingRef.current = false;
        setIsSending(false);
      }
    },
    [activeModuleId, historyByModule, pushMessage],
  );

  /**
   * 重试某条用户消息：把历史截断到它之前，再重发一次。
   * 网络/接口出错、或者对回答不满意时用。
   *
   * 磁盘上的会话文件是追加写的，不回改 —— 重试内容会再追加一份，
   * 旧的那次留在文件里但界面上已经不再显示（避免为了"重试"去动文件写入逻辑）。
   */
  const handleRetry = useCallback(
    (index: number) => {
      const moduleId = activeModuleId ?? '';
      const history = historyByModule[moduleId] ?? [];
      const target = history[index];
      if (!target || target.role !== 'user') return;
      setHistoryByModule((previous) => ({ ...previous, [moduleId]: history.slice(0, index) }));
      void handleSend(target.content);
    },
    [activeModuleId, historyByModule, handleSend],
  );

  /** 清空当前模块的对话：**内存与磁盘一起清**，否则重开面板历史会"复活"。 */
  const handleClear = useCallback(() => {
    const moduleId = activeModuleId ?? '';
    setHistoryByModule((previous) => ({ ...previous, [moduleId]: [] }));
    setErrorMessage('');
    void clearAiSession(moduleId, localDateKey()).catch((error) =>
      console.error('清空 AI 会话历史失败:', error),
    );
  }, [activeModuleId]);

  const handleToggle = useCallback(() => {
    setIsOpen((previous) => !previous);
  }, []);

  // 模块里的「咨询 AI 助手」按钮 → 打开面板并直接发送，用户不用再打一遍。
  // 用 id 去重：同一个问题连点两次也要能触发两次，但又不能被重建的 handleSend 重复触发。
  const askRequest = useAiAskRequest();
  const lastAskIdRef = useRef(0);
  useEffect(() => {
    if (!askRequest || askRequest.id === lastAskIdRef.current) return;
    lastAskIdRef.current = askRequest.id;
    setIsOpen(true);
    void handleSend(askRequest.text);
    clearAiAsk();
  }, [askRequest, handleSend]);

  return (
    /* AnimatePresence 负责"离场动画"：React 卸载节点时它会把 exit 播完再移除。
       两个子节点都要有稳定 key，否则切换时会被当成同一个节点、动画不触发。 */
    <AnimatePresence mode="wait">
      {isOpen ? (
        <AiChatPanel
          key="panel"
          messages={currentHistory}
          streamingText={streamingText}
          pendingDelete={pendingDelete?.items ?? null}
          deleteResult={deleteResult}
          isDeleting={isDeleting}
          onConfirmDelete={() => void handleConfirmDelete()}
          onCancelDelete={() => setPendingDelete(null)}
          onRetry={handleRetry}
          isSending={isSending}
          errorMessage={errorMessage}
          moduleName={moduleName}
          modelLabel={activeModelLabel}
          onSend={(text) => void handleSend(text)}
          onCollapse={handleToggle}
          onClear={handleClear}
        />
      ) : (
        <motion.button
          key="ball"
          type="button"
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          /* 悬停/按下的缩放交给 framer-motion（不再写 CSS 的 hover:scale-*，否则两者会打架） */
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          onClick={handleToggle}
          title={t('ballTitle')}
          aria-label={t('ballTitle')}
          /* 位置刻意压在「回到顶部」按钮上方：两者都在右下角，不这样会叠在一起。 */
          className="glass-item fixed right-5 bottom-[4.75rem] z-40 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-elevated)] text-[var(--brand-green)] shadow-lg"
        >
          <AiMarkIcon className="h-5 w-5" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/**
 * 裁剪历史：始终保留 system 消息，其余按"最近 N 条"截断。
 * 目的是先把上下文成本压住 —— 更聪明的滚动摘要属于后续版本。
 */
function trimHistory(messages: AiChatMessage[]): AiChatMessage[] {
  const systems = messages.filter((message) => message.role === 'system');
  const rest = messages.filter((message) => message.role !== 'system');
  const kept = rest.slice(Math.max(0, rest.length - MAX_HISTORY_MESSAGES));
  return [...systems, ...kept];
}
