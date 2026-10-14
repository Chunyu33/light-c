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
import {
  aiChatStream,
  appendAiSessionMessage,
  clearAiSession,
  getAiConfig,
  listenAiStream,
  listAiProviders,
  loadAiSession,
  localDateKey,
  readAiAttachment,
  saveAiAttachment,
  saveAiProfile,
} from '../../api/ai';
import type { AiChatMessage, AiPublicConfig, AiToolCall } from '../../types/ai';
import { AiChatPanel } from './AiChatPanel';
import { AiMarkIcon } from './AiMarkIcon';
import { buildRequestMessages, getModuleDisplayName } from './aiContext';
import { getModuleDataSummary } from './moduleDataRegistry';
import { getModuleActions } from './moduleActionRegistry';
import type { AiDeleteOutcome, AiDeleteTargetSummary } from './moduleActionRegistry';
import { formatReadPage } from './useAiModuleBridge';
import { clearAiAsk, useAiAskRequest } from './aiAsk';
import type { AttachedImage } from './imageAttach';

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
  /**
   * 当前配置（整份）。存整份而不是一段显示文本，是因为面板还要据此判断：
   * 有没有配置密钥、有哪些模型可选、当前选的是哪个 —— 没配置时要禁用输入与发送。
   */
  const [aiConfig, setAiConfig] = useState<AiPublicConfig | null>(null);
  /** 服务商 id → 显示名，用于面板顶部那行"模型 · 服务商" */
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});

  const reloadAiConfig = useCallback(async () => {
    try {
      const [config, providers] = await Promise.all([getAiConfig(), listAiProviders()]);
      setAiConfig(config);
      setProviderNames(
        Object.fromEntries(providers.map((item) => [item.id, item.name])) as Record<string, string>,
      );
    } catch (error) {
      console.error('读取当前 AI 配置失败:', error);
    }
  }, []);

  // 打开面板时刷新：用户可能刚在设置里改过配置
  useEffect(() => {
    if (!isOpen) return;
    void reloadAiConfig();
  }, [isOpen, reloadAiConfig]);

  /** 当前档案：显示与判断都以它为准。 */
  const activeProfile = useMemo(
    () =>
      aiConfig
        ? aiConfig.profiles.find((item) => item.id === aiConfig.activeProfileId) ?? aiConfig.profiles[0]
        : undefined,
    [aiConfig],
  );

  /** 能不能对话：**必须有密钥**。没配置时不让人白打一长串字再报错。 */
  const canChat = Boolean(activeProfile?.hasApiKey);

  const activeModelLabel = activeProfile
    ? [activeProfile.model || t('noModel'), providerNames[activeProfile.providerId] || activeProfile.providerId]
        .filter(Boolean)
        .join(' · ')
    : '';

  /** 就地切换模型：写回当前档案，下一句话即生效。 */
  const handleSwitchModel = useCallback(
    async (model: string) => {
      if (!activeProfile || !aiConfig) return;
      try {
        const next = await saveAiProfile({
          id: activeProfile.id,
          name: activeProfile.name,
          providerId: activeProfile.providerId,
          baseUrl: activeProfile.baseUrl,
          model,
          apiKey: '', // 留空 = 不改动已保存的密钥
        });
        setAiConfig(next);
      } catch (error) {
        console.error('切换模型失败:', error);
      }
    },
    [activeProfile, aiConfig],
  );
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
        // 把附件文件名读回成 data URL：这样重开面板也能看到当时发的图，
        // 而且这些图会一并进入后续请求的上下文（与编辑器的行为一致）。
        const restored = await Promise.all(
          stored.map(async (item) => {
            const names = item.images ?? [];
            if (names.length === 0) return { role: item.role, content: item.content };
            const dataUrls = await Promise.all(names.map((name) => readAiAttachment(name)));
            return {
              role: item.role,
              content: item.content,
              images: dataUrls
                .filter((url) => url.length > 0)
                .map((url) => ({ mediaType: 'image/jpeg', dataBase64: url.split(',')[1] ?? '' })),
            };
          }),
        );
        setHistoryByModule((previous) => ({ ...previous, [moduleId]: restored }));
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

  // 切模块时清掉上一个模块残留的提案与结果卡片。
  // 不清就会出现：在垃圾清理里生成的删除提案，切到旧驱动后**卡片还留在面板上**，
  // 用户点确认才发现"当前模块没有删除能力" —— 看着像旧驱动也能触发删除，其实是串台。
  useEffect(() => {
    setPendingDelete(null);
    setDeleteResult(null);
  }, [activeModuleId]);

  /** 用户点了「确认删除」：这时才真正调用模块的删除入口。 */
  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const { moduleId, ids } = pendingDelete;
    const actions = getModuleActions(moduleId);
    if (!actions?.deleteItems) {
      // 走到这里说明提案所属的模块已经不可用（多半是切了模块或模块被卸载）。
      // 明确告诉用户原因与怎么办，不要只让卡片默默消失。
      setDeleteResult({
        deletedCount: 0,
        failures: [{ name: '', reason: t('delete.wrongModule') }],
      });
      setPendingDelete(null);
      return;
    }
    setIsDeleting(true);
    try {
      const outcome = await actions.deleteItems(ids);
      setDeleteResult(outcome);
      // 结果卡片是临时的（带回调、不可序列化），所以另外落一条文字记录：
      // 否则用户切走模块再回来，会以为"这次删除根本没发生过"。
      pushAndPersist(
        moduleId,
        outcome.failures.length > 0
          ? t('delete.persistedWithFailures', {
              count: outcome.deletedCount,
              failed: outcome.failures.length,
            })
          : t('delete.persisted', { count: outcome.deletedCount }),
      );
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
  /** 推一条消息并**同时落盘**：工具执行结果也要进历史，否则切走再回来就看不到。 */
  const pushAndPersist = useCallback(
    (moduleId: string, content: string) => {
      pushMessage(moduleId, { role: 'assistant', content });
      void appendAiSessionMessage(moduleId, localDateKey(), {
        role: 'assistant',
        content,
        at: Date.now(),
      }).catch((error) => console.error('写入 AI 会话历史失败:', error));
    },
    [pushMessage],
  );

  const runToolCalls = useCallback(
    (moduleId: string, calls: AiToolCall[]) => {
      const actions = getModuleActions(moduleId);
      for (const call of calls) {
        const rawIds = (call.arguments as { ids?: unknown }).ids;
        const ids = Array.isArray(rawIds)
          ? rawIds.filter((id): id is string => typeof id === 'string')
          : [];

        // 只读读取：**先把结果落进对话**，模型下一轮就能引用这些内容。
        // 这两个工具不改任何东西，所以不受"必须用户明确要求"的限制。
        if (call.name === 'read_items') {
          const args = call.arguments as { target_id?: unknown; offset?: unknown; limit?: unknown };
          const targetId = typeof args.target_id === 'string' ? args.target_id : '';
          const offset = Math.max(0, Number(args.offset) || 0);
          // 上限 100：再大就把上下文吃光了，而"看得多"并不等于"答得准"
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
          const page = actions?.readItems?.(targetId, offset, limit) ?? null;
          pushAndPersist(moduleId, page ? formatReadPage(page, offset) : t('tool.readEmpty'));
          continue;
        }

        if (call.name === 'read_item_detail') {
          const args = call.arguments as { item_id?: unknown };
          const itemId = typeof args.item_id === 'string' ? args.item_id : '';
          const detail = actions?.readItemDetail?.(itemId) ?? null;
          pushAndPersist(moduleId, detail || t('tool.readEmpty'));
          continue;
        }

        // 一律拿 id 反查模块当前数据：提案到执行之间用户可能又改过勾选、模块可能重扫过，
        // 解析不到的项直接剔除，绝不照着旧 id 硬执行。
        const resolved = actions?.resolveTargets?.(ids) ?? [];

        if (call.name === 'select_items') {
          if (resolved.length === 0) {
            pushAndPersist(moduleId, t('tool.selectNotFound'));
            continue;
          }
          actions?.selectItems?.(resolved.map((target) => target.id));
          pushAndPersist(
            moduleId,
            t('tool.selected', {
              count: resolved.length,
              names: resolved.map((target) => target.label).join('、'),
            }),
          );
          continue;
        }

        if (call.name === 'propose_delete') {
          if (resolved.length === 0) {
            pushAndPersist(moduleId, t('tool.selectNotFound'));
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
    [pushMessage, pushAndPersist, t],
  );

  const handleSend = useCallback(
    async (text: string, images: AttachedImage[] = []) => {
      if (sendingRef.current) return;
      sendingRef.current = true;

      // 抓一份"发送时"的模块与历史：用户可能在生成过程中切模块，
      // 这一轮的结果必须落回发起时那个模块，而不是"当前"模块（否则又串台了）。
      const moduleId = activeModuleId ?? '';
      const history = historyByModule[moduleId] ?? [];
      setIsSending(true);
      setErrorMessage('');
      setStreamingText('');

      // 落盘与会话历史里**只记文字与占位符**：图片 base64 动辄几百 KB，
      // 写进 jsonl 会让文件迅速膨胀，重新加载时也毫无用处。
      const persistedText =
        images.length > 0 ? `${text}\n[已附加 ${images.length} 张图片]`.trim() : text;
      // 界面上保留缩略图（用的是刚压好的 data URL），所以这一条带上图片
      pushMessage(moduleId, {
        role: 'user',
        content: persistedText,
        images: images.map((image) => ({ mediaType: image.mediaType, dataBase64: image.base64 })),
      });
      // 落盘：图片另存成文件，会话记录里只放文件名
      void (async () => {
        try {
          const names = await Promise.all(
            images.map((image) => saveAiAttachment(image.base64, image.mediaType)),
          );
          await appendAiSessionMessage(moduleId, localDateKey(), {
            role: 'user',
            content: persistedText,
            images: names,
            at: Date.now(),
          });
        } catch (error) {
          console.error('写入 AI 会话历史失败:', error);
        }
      })();

      // 发给模型的这一条**带上图片**（图片只活在这一轮请求里，不进历史状态）
      const nextMessages: AiChatMessage[] = [
        ...history,
        {
          role: 'user',
          content: text,
          images:
            images.length > 0
              ? images.map((image) => ({ mediaType: image.mediaType, dataBase64: image.base64 }))
              : undefined,
        },
      ];
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
        // 只读工具：登记了读取能力才声明。没实现的模块，模型压根不知道自己能往下看。
        if (actions?.readItems) tools.push('read_items');
        if (actions?.readItemDetail) tools.push('read_item_detail');

        // 一律走流式。工具调用以前会因此丢掉，所以当时只能"带工具就不流式"——
        // 代价是垃圾清理这类模块**永远看不到边生成边显示**，得不偿失。
        // 现在解码器会把分片的工具参数按索引拼回来（见 stream.rs），两者兼得。
        const reply = await aiChatStream({ messages: trimHistory(request), tools }, streamId);

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
          modelOptions={activeProfile?.models ?? []}
          activeModel={activeProfile?.model ?? ''}
          canChat={canChat}
          onSwitchModel={handleSwitchModel}
          onSend={(text, attached) => void handleSend(text, attached)}
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

  // **只保留最近一条消息里的图片**。
  // 图片是 base64 进请求的，而对话无状态、整个历史每轮重发 ——
  // 一堆历史截图会让每轮请求变成好几 MB。旧图对"回答当前这个问题"帮助很小，
  // 保留最近一张就够（用户通常就是针对刚发的图提问）。
  let seenLatestImage = false;
  const trimmed = [...kept].reverse().map((message) => {
    if (!message.images || message.images.length === 0) return message;
    if (!seenLatestImage) {
      seenLatestImage = true;
      return message;
    }
    return { ...message, images: undefined };
  });

  return [...systems, ...trimmed.reverse()];
}
