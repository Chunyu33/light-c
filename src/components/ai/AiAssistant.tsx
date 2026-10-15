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
  loadAiSession,
  localDateKey,
  readAiAttachment,
  saveAiAttachment,
  saveAiProfile,
} from '../../api/ai';
import type { AiChatMessage, AiChatReply, AiPublicConfig, AiToolCall } from '../../types/ai';
import { AiChatPanel } from './AiChatPanel';
import { AiMarkIcon } from './AiMarkIcon';
import { buildRequestMessages, getModuleDisplayName } from './aiContext';
import { getModuleDataSummary } from './moduleDataRegistry';
import { getModuleActions } from './moduleActionRegistry';
import type { AiDeleteOutcome, AiDeleteTargetSummary, ModuleActions } from './moduleActionRegistry';
import { formatReadPage } from './useAiModuleBridge';
import { clearAiAsk, useAiAskRequest } from './aiAsk';
import type { AttachedImage } from './imageAttach';

/** 只保留最近若干轮对话：更早的内容交给滚动摘要处理。 */
const MAX_HISTORY_MESSAGES = 16;

/**
 * 一次提问最多跑几轮请求。
 *
 * 一轮 = 一次请求。模型要求调只读工具时，把工具结果带上**再问一轮**，它才能据此作答 ——
 * 也就是"查资料"与"给结论"是两轮。留 3 轮是给"先 read_items 定位条目、再 read_item_detail
 * 看细节"这类两步查询留余量；**最后一轮不再给工具**，所以它必然收敛，不会一直查下去。
 */
const MAX_TOOL_ROUNDS = 3;

/**
 * 前端看门狗：这么久没有收到任何增量就判定卡住。
 *
 * 比后端的空闲超时（30 秒）**稍长一点**，让后端先报错 ——
 * 后端能给出具体原因，前端只能给一句通用提示。
 * 前端这一层存在的意义是"后端也失效时"的兜底：事件没送达、进程被挂起、
 * 或者哪天后端逻辑被改坏了。**没有它，按钮会永远停在"正在思考"，用户只能重启。**
 */
const STREAM_IDLE_MS = 45_000;

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

  const reloadAiConfig = useCallback(async () => {
    try {
      setAiConfig(await getAiConfig());
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
          // 原样带回：这一项用户在设置里配过，切换模型不该把它清掉
          reasoningEffort: activeProfile.reasoningEffort,
        });
        setAiConfig(next);
      } catch (error) {
        // 写回失败必须让人看见：下拉框看起来已经切过去了，其实没生效
        setErrorMessage(t('switchModelFailed', { message: String(error) }));
      }
    },
    [activeProfile, aiConfig, t],
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
            // 思维链、"本地工具结果"标记、以及"是哪份档案产出的"都要一起恢复：
            // 前者不回传会被服务端 400；第二个决定这条算 assistant 还是用户侧内容；
            // 第三个决定换服务商之后它还要不要带出去。
            const carried = {
              reasoningContent: item.reasoningContent,
              localToolOutput: item.localToolOutput,
              producedByProfile: item.producedByProfile,
            };
            const names = item.images ?? [];
            if (names.length === 0) {
              return { role: item.role, content: item.content, ...carried };
            }
            const dataUrls = await Promise.all(names.map((name) => readAiAttachment(name)));
            return {
              role: item.role,
              content: item.content,
              images: dataUrls
                .filter((url) => url.length > 0)
                .map((url) => ({ mediaType: 'image/jpeg', dataBase64: url.split(',')[1] ?? '' })),
              ...carried,
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

  /**
   * 当前模块 id 的 ref。
   *
   * 异步回调（流式增量、删除结果、请求失败）落地时，闭包里的 activeModuleId 是**发起时**的值，
   * 要判断"用户现在还在不在那个模块"只能靠 ref。不在那个模块时就不要往界面上写 ——
   * 否则在 A 模块问出来的回答、错误、删除结果会显示到 B 模块的面板上。
   */
  const activeModuleIdRef = useRef(activeModuleId);
  activeModuleIdRef.current = activeModuleId;

  // 切模块时清掉上一个模块残留的提案、结果卡片、错误提示与流式正文。
  // 不清就会出现：在垃圾清理里生成的删除提案，切到旧驱动后**卡片还留在面板上**，
  // 用户点确认才发现"当前模块没有删除能力" —— 看着像旧驱动也能触发删除，其实是串台。
  // 流式正文同理：它是"当前这一轮"的临时内容，在 A 里生成中切到 B 时不该出现在 B 上。
  useEffect(() => {
    setPendingDelete(null);
    setDeleteResult(null);
    // 错误提示同样是"上一个模块的"：不清就会串到别的模块对话框里
    setErrorMessage('');
    setStreamingText('');
  }, [activeModuleId]);

  /**
   * 推一条消息并**同时落盘**：工具执行结果也要进历史，否则切走再回来就看不到。
   *
   * `extra` 带三件事，前两件是服务端的硬要求：
   *   - `reasoningContent`：思考模式的思维链，后续请求必须原样回传，否则 400；
   *   - `localToolOutput`：这条是本地生成的工具结果，发出去时按用户侧内容处理；
   *   - `producedByProfile`：是哪份档案产出的 —— 换服务商之后这份思维链就不再回传。
   */
  const pushAndPersist = useCallback(
    (
      moduleId: string,
      content: string,
      extra?: {
        reasoningContent?: string;
        localToolOutput?: boolean;
        producedByProfile?: string;
      },
    ) => {
      const message = {
        role: 'assistant' as const,
        content,
        reasoningContent: extra?.reasoningContent,
        localToolOutput: extra?.localToolOutput,
        producedByProfile: extra?.producedByProfile,
      };
      pushMessage(moduleId, message);
      void appendAiSessionMessage(moduleId, localDateKey(), {
        ...message,
        at: Date.now(),
      }).catch((error) => console.error('写入 AI 会话历史失败:', error));
    },
    [pushMessage],
  );

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
      // 用户可能在删除执行期间切走了模块：结果卡片只贴给发起时那个模块看，
      // 文字记录照旧落进该模块历史（切回去能看到这次删除确实发生过）。
      if (activeModuleIdRef.current === moduleId) setDeleteResult(outcome);
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
      if (activeModuleIdRef.current === moduleId) {
        setDeleteResult({ deletedCount: 0, failures: [{ name: '', reason: String(error) }] });
      } else {
        console.error('执行删除失败（用户已切走模块）:', error);
      }
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, pushAndPersist, t]);

  /**
   * 执行模型请求的工具调用，把结果作为一条**本地消息**写进对话。
   *
   * 结果文案由这里生成、不交给模型转述 —— 做了什么、影响了几项，
   * 一律以本地事实为准，避免出现"AI 说自己删了、其实没删"。
   *
   * `allowedTools` 是**本轮声明给模型的那几个工具**：执行前必须再卡一遍。
   */
  const runToolCalls = useCallback(
    (
      moduleId: string,
      calls: AiToolCall[],
      allowedTools: string[],
    ): { texts: string[]; changedData: boolean } => {
      const actions = getModuleActions(moduleId);
      // 结果既落进对话，也收集起来还给调用方 ——
      // 只读工具跑完之后要**带着这些结果再问模型一轮**，它才能据此作答。
      // 只显示工具输出、不给模型下一次机会的话，用户看到的就是一堆原始数据、没有结论。
      const texts: string[] = [];
      /** 是否真的改动了数据（勾选 / 删除提案）。只读工具不会把它置为 true。 */
      let changedData = false;
      const report = (text: string) => {
        texts.push(text);
        // 标成"本地工具结果"：发请求时会转成用户侧内容 ——
        // 否则它就是一条没有 reasoning_content 的 assistant，带 tools 的请求会被 400 拒掉。
        pushAndPersist(moduleId, text, { localToolOutput: true });
      };

      for (const call of calls) {
        // ⚠️ 第二道闸只做在"声明"那一层是不够的：模型可以在正文里直接写出一段调用，
        // 后端的内联兜底会把它解析出来 —— 那条路径根本不经过工具声明。
        // 它落到 select_items 上就是**直接改勾选、没有任何确认环节**，所以执行前必须再挡一次。
        if (!allowedTools.includes(call.name)) continue;
        const rawIds = (call.arguments as { ids?: unknown }).ids;
        const ids = Array.isArray(rawIds)
          ? rawIds.filter((id): id is string => typeof id === 'string')
          : [];

        // 只读读取：**先把结果落进对话**，模型下一轮就能引用这些内容。
        // 这两个工具不改任何东西，所以不受"必须用户明确要求"的限制。
        if (call.name === 'read_items') {
          // ⚠️ 失败原因**分开报**。这三种情况的排查方向完全不同：
          // 没登记 / 没实现 / 数据为空。合成一句"没有读到内容"，
          // 会让问题看起来像"功能没做"，排查时白绕很多圈。
          if (!actions) {
            report(t('tool.moduleNotReady', { module: moduleId }));
            continue;
          }
          if (!actions.readItems) {
            report(t('tool.readNotProvided', { module: moduleId }));
            continue;
          }
          const args = call.arguments as { target_id?: unknown; offset?: unknown; limit?: unknown };
          const targetId = typeof args.target_id === 'string' ? args.target_id : '';
          const offset = Math.max(0, Number(args.offset) || 0);
          // 上限 100：再大就把上下文吃光了，而"看得多"并不等于"答得准"
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
          const page = actions.readItems(targetId, offset, limit);
          if (!page || page.lines.length === 0) {
            report(t('tool.readEmpty'));
            continue;
          }
          report(formatReadPage(page, offset));
          continue;
        }

        if (call.name === 'read_item_detail') {
          if (!actions) {
            report(t('tool.moduleNotReady', { module: moduleId }));
            continue;
          }
          if (!actions.readItemDetail) {
            report(t('tool.detailNotProvided', { module: moduleId }));
            continue;
          }
          const args = call.arguments as { item_id?: unknown };
          const itemId = typeof args.item_id === 'string' ? args.item_id : '';
          const detail = actions.readItemDetail(itemId);
          report(detail || t('tool.readEmpty'));
          continue;
        }

        // 一律拿 id 反查模块当前数据：提案到执行之间用户可能又改过勾选、模块可能重扫过，
        // 解析不到的项直接剔除，绝不照着旧 id 硬执行。
        const resolved = actions?.resolveTargets?.(ids) ?? [];

        if (call.name === 'select_items') {
          if (resolved.length === 0) {
            report(t('tool.selectNotFound'));
            continue;
          }
          actions?.selectItems?.(resolved.map((target) => target.id));
          changedData = true;
          report(
            t('tool.selected', {
              count: resolved.length,
              names: resolved.map((target) => target.label).join('、'),
            }),
          );
          continue;
        }

        if (call.name === 'propose_delete') {
          if (resolved.length === 0) {
            report(t('tool.selectNotFound'));
            continue;
          }
          // **不执行**，只弹出确认卡片 —— AI 只能提案，执行权在用户手里
          setDeleteResult(null);
          setPendingDelete({
            moduleId,
            ids: resolved.map((target) => target.id),
            items: resolved,
          });
          changedData = true;
        }
      }

      return { texts, changedData };
    },
    [pushAndPersist, t],
  );

  const handleSend = useCallback(
    async (text: string, images: AttachedImage[] = [], historyOverride?: AiChatMessage[]) => {
      if (sendingRef.current) return;
      sendingRef.current = true;

      // 抓一份"发送时"的模块与历史：用户可能在生成过程中切模块，
      // 这一轮的结果必须落回发起时那个模块，而不是"当前"模块（否则又串台了）。
      const moduleId = activeModuleId ?? '';
      // 重试会显式传进截断后的历史：setState 还没生效，同步读闭包拿到的仍是**截断前**的旧值，
      // 那样被"重试掉"的那条提问会跟着再发一次（界面已截断、请求没截断）。
      const history = historyOverride ?? historyByModule[moduleId] ?? [];
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
      // 落盘与界面的分工交给 persistUserTurn：界面留缩略图，磁盘只留文件名
      void persistUserTurn(moduleId, persistedText, images);

      // 每次请求一个独立的流标识：事件是全局广播的，靠它过滤掉别人的增量。
      const streamId = `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const request = buildTurnMessages(history, text, images, moduleId, activeProfile?.id ?? '');
      // 工具声明、请求、看门狗、收尾各自成函数（见文件末的"发送流程里的几个步骤"）
      const tools = buildAllowedTools(getModuleActions(moduleId), request);

      try {
        // 一轮 = 一次请求。模型要求调只读工具时，把结果带上**再问一轮**，它才能据此作答。
        // 少了这一轮，用户看到的就是一堆原始数据、没有结论（"查了但不说话"）。
        let turnMessages = request;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          // 最后一轮不再给工具：逼它用已经查到的数据作答，避免一直查下去烧额度
          const isLastRound = round === MAX_TOOL_ROUNDS - 1;
          const toolsForRound = isLastRound ? [] : tools;

          const reply = await requestStreamReply({
            // 每轮一个独立的流标识：上一轮的迟到增量不该被算进这一轮
            streamId: `${streamId}-r${round}`,
            messages: turnMessages,
            tools: toolsForRound,
            timeoutMessage: t('streamTimeout'),
            // 用户已经切走了就别再往面板上贴字：这一轮的完整正文最后仍会落进
            // 发起时那个模块的历史，切回去看得到。
            onDelta: (delta) => {
              if (activeModuleIdRef.current !== moduleId) return;
              setStreamingText((previous) => previous + delta);
            },
          });

          const calls = reply.toolCalls ?? [];
          if (calls.length === 0) {
            // 没有工具调用 = 这一轮就是答案。记下产出它的档案：
            // 换服务商之后这份思维链就不能再回传了（见 toRequestMessage）。
            pushAndPersist(moduleId, reply.content, {
              reasoningContent: reply.reasoningContent,
              producedByProfile: activeProfile?.id,
            });
            return;
          }

          // 把**本次声明过的工具**一并传下去：执行层要按它再过滤一次（见 runToolCalls）
          const { texts, changedData } = runToolCalls(moduleId, calls, toolsForRound);

          // 会改数据的动作到此为止：勾选已经改了、删除提案在等用户确认，
          // 再自动发一轮只会让模型对着"已勾选"再复述一遍，没有意义。
          if (changedData) return;
          // 最后一轮既然没给工具，就没有下一轮可喂了：有正文就用正文收尾
          if (isLastRound) {
            if (reply.content.trim()) {
              pushAndPersist(moduleId, reply.content, {
                reasoningContent: reply.reasoningContent,
                producedByProfile: activeProfile?.id,
              });
            }
            return;
          }
          // 工具全部越界或被挡下来（没登记/没实现），没什么可喂回去的
          if (texts.length === 0) return;

          // 只读工具的结果作为 assistant 消息带进上下文 —— 这正是原来"下一轮"缺的那一步。
          // ⚠️ 必须**合成一条**，不是一条一个：Anthropic 要求 user/assistant 交替出现，
          // 连着两条 assistant 会被它直接拒掉整个请求。
          turnMessages = [
            ...turnMessages,
            { role: 'assistant' as const, content: texts.join('\n\n') },
          ];
          // 下一轮的正文从零开始显示：工具输出已经落在对话里了，不必和它拼在一起
          setStreamingText('');
        }
      } catch (error) {
        // 失败时保留用户输入在历史里，方便直接重试；错误单独展示，不混进对话正文。
        // 用户已经切走时不要再把错误冒到别的模块上（这一轮的记录仍留在发起时那个模块里）。
        if (activeModuleIdRef.current === moduleId) {
          setErrorMessage(String(error));
        } else {
          console.error('AI 请求失败（用户已切走模块）:', error);
        }
      } finally {
        // 监听与看门狗的清理在 requestStreamReply 里就做完了，这里只收这一轮的状态
        setStreamingText('');
        sendingRef.current = false;
        setIsSending(false);
      }
    },
    [activeModuleId, activeProfile, historyByModule, pushMessage, pushAndPersist, runToolCalls, t],
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
      const truncated = history.slice(0, index);
      setHistoryByModule((previous) => ({ ...previous, [moduleId]: truncated }));
      // 显式把截断后的数组传进去：否则 handleSend 读到的仍是旧的整段历史，
      // 被重试的那条提问会连着它后面的旧回复一起再发一次（界面已截断、请求没截断）。
      void handleSend(target.content, [], truncated);
    },
    [activeModuleId, historyByModule, handleSend],
  );

  /** 重试最近一次提问：从后往前找最后一条用户消息，走与单条重试同一条路径。 */
  const handleRetryLast = useCallback(() => {
    const moduleId = activeModuleId ?? '';
    const history = historyByModule[moduleId] ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].role === 'user') {
        handleRetry(index);
        return;
      }
    }
  }, [activeModuleId, historyByModule, handleRetry]);

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
          onRetryLast={handleRetryLast}
          moduleName={moduleName}
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
          /* 贴右边缘、**垂直居中**。
             原来压在右下角（回到顶部按钮上方），那儿正好压着各行的右侧操作图标：
             既挡视线，又不好点 —— 列表整列图标都在那个位置。
             竖直居中之后，右侧这一带始终没有内容。

             ⚠️ 居中刻意**不用 transform**（既不是 Tailwind 的 -translate-y-1/2，
             也不是 framer-motion 的 style={{ y }}）：
             这个元素同时还在用 framer-motion 做 scale 动画，而它会往同一个元素写
             inline transform —— 两处都要写 transform 必然打架，谁赢取决于执行顺序。
             改成「上下都贴 0 + margin auto」这种纯盒模型居中，跟 transform 完全无关，
             不管外面怎么写动画都不会错位。 */
          className="glass-item fixed right-5 top-0 bottom-0 my-auto z-40 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-elevated)] text-[var(--brand-green)] shadow-lg"
        >
          {/* 上方的小气泡：光一个图标，新用户不知道这是干什么的。
              动画拆成两层 —— 外层负责"冒出来"（只跑一次），内层负责缓慢浮动（循环）。
              合成一层写会有个坑：关键帧循环时会跳回起始位移，看起来像在抽搐。

              居中同样**不用 transform**：外层是 motion 元素（要做 scale/y 动画），
              跟球的理由一样，交给「左右都贴 0 + margin auto + w-fit」更稳。 */}
          <motion.span
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.7, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ delay: 0.25, type: 'spring', stiffness: 320, damping: 20 }}
            className="pointer-events-none absolute bottom-full left-0 right-0 mx-auto mb-2 w-fit"
          >
            <motion.span
              animate={{ y: [0, -3, 0] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative block rounded-lg border border-[var(--brand-green-20)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] font-medium leading-4 text-[var(--brand-green)] shadow-sm"
            >
              {t('ballBadge')}
              {/* 指向小球的小尖角：一个旋转 45° 的方块，只留底边与右边，
                  正好拼出朝下的三角，而且边框颜色与气泡一致（两层三角那种写法太啰嗦）。
                  这一层不是 motion 元素，所以这里用 translate 居中不会被覆盖。 */}
              <span className="absolute left-1/2 top-full h-1.5 w-1.5 -translate-x-1/2 -translate-y-[3px] rotate-45 border-b border-r border-[var(--brand-green-20)] bg-[var(--bg-elevated)]" />
            </motion.span>
          </motion.span>
          {/* 图标要比别处大一号：这个 SVG 的 viewBox 是 24 格，但图形本身只占
              中间一带（左右各让出 4 格、底部让出 6 格），所以 h-5 渲染出来
              可见的机器人还不到 14px，放在 44px 的圆里显得很空。
              提到 h-7 之后实际大小才和相邻的其他图标相当。 */}
          <AiMarkIcon className="h-7 w-7" />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

// ============================================================================
// 发送流程里的几个步骤
//
// 拆出来不是因为"看起来长"，而是这几步各自有独立的约束（谁能声明工具、什么必须
// 先于什么、失败时怎么办），混在一个函数里改一处很容易碰坏另一处。
// ============================================================================

/**
 * 组装发给模型的这一轮消息：历史 + 本次提问（**图片只活在这一轮请求里**，不进历史状态）。
 * 数据摘要现取 —— 用户可能刚扫完或刚勾选，缓存一秒都会答错。
 */
function buildTurnMessages(
  history: AiChatMessage[],
  text: string,
  images: AttachedImage[],
  moduleId: string,
  activeProfileId: string,
): AiChatMessage[] {
  return buildRequestMessages(
    [
      ...history,
      {
        role: 'user',
        content: text,
        images:
          images.length > 0
            ? images.map((image) => ({ mediaType: image.mediaType, dataBase64: image.base64 }))
            : undefined,
      },
    ],
    moduleId,
    getModuleDataSummary(moduleId),
    activeProfileId,
  );
}

/**
 * 本轮允许声明给模型的工具。
 *
 * 只读工具：模块登记了就给 —— 它们不改任何东西，用户问「这里有什么」正该直接读。
 * 会改数据的工具：**只在这次看起来是在要求动手时**才给。这是请求层的硬约束，
 * 比在提示词里反复叮嘱可靠得多：提示词只能"劝"，不给工具是"不能"。
 */
function buildAllowedTools(actions: ModuleActions | null, messages: AiChatMessage[]): string[] {
  const tools: string[] = [];
  if (actions?.readItems) tools.push('read_items');
  if (actions?.readItemDetail) tools.push('read_item_detail');
  if (looksLikeActionRequest(messages)) {
    if (actions?.selectItems) tools.push('select_items');
    if (actions?.deleteItems) tools.push('propose_delete');
  }
  return tools;
}

/**
 * 把这一轮的用户消息写进磁盘：图片先落成文件，会话记录里只留文件名。
 * 失败只记控制台 —— 会话记录是附属能力，不能因为写盘失败就把这一轮对话拦下来。
 */
async function persistUserTurn(
  moduleId: string,
  content: string,
  images: AttachedImage[],
): Promise<void> {
  try {
    const names = await Promise.all(
      images.map((image) => saveAiAttachment(image.base64, image.mediaType)),
    );
    await appendAiSessionMessage(moduleId, localDateKey(), {
      role: 'user',
      content,
      images: names,
      at: Date.now(),
    });
  } catch (error) {
    console.error('写入 AI 会话历史失败:', error);
  }
}

/**
 * 发一次流式请求并把增量交给 `onDelta`，最后返回模型回复。
 *
 * 这里集中了三件容易写错的事，所以单独成函数：
 *   1. **先挂监听再发请求** —— 否则首批增量可能赶在监听挂上之前就到了；
 *   2. **看门狗** —— 45 秒没有任何增量就判定卡住并结束这一轮。它是"后端也失效时"的
 *      兜底（事件没送达、进程被挂起），没有它按钮会永远停在"正在思考"；
 *   3. **无论成功失败都要解绑监听、清掉定时器** —— 一次对话留下一个永久监听器，
 *      下次的增量会被累加两遍。
 */
async function requestStreamReply(options: {
  streamId: string;
  /** 已经是完整请求消息（含 system） */
  messages: AiChatMessage[];
  tools: string[];
  /** 看门狗触发时的提示语；由调用方传入，好跟着界面语言走 */
  timeoutMessage: string;
  onDelta: (text: string) => void;
}): Promise<AiChatReply> {
  const { streamId, messages, tools, timeoutMessage, onDelta } = options;
  let unlisten: (() => void) | null = null;
  let watchdogHandle: number | undefined;
  let resetWatchdog: () => void = () => {};

  try {
    // 先挂监听再发请求，否则首批增量可能在挂上之前就到了
    unlisten = await listenAiStream((delta) => {
      if (delta.streamId !== streamId) return;
      resetWatchdog(); // 有增量就说明还活着，重新计时
      onDelta(delta.text);
    });

    // 与看门狗赛跑：卡住时后者先 reject，把这一轮结束掉并把按钮放开
    return await Promise.race([
      aiChatStream({ messages: trimHistory(messages), tools }, streamId),
      new Promise<never>((_, reject) => {
        const arm = () => {
          watchdogHandle = window.setTimeout(
            () => reject(new Error(timeoutMessage)),
            STREAM_IDLE_MS,
          );
        };
        resetWatchdog = () => {
          window.clearTimeout(watchdogHandle);
          arm();
        };
        arm();
      }),
    ]);
  } finally {
    // 清理看门狗：不清理虽然无害（已结束的 Promise 再 reject 是空操作），
    // 但会留一个无意义的定时器
    window.clearTimeout(watchdogHandle);
    // 必须取消监听：否则一次对话留下一个永久监听器，下次的增量会被累加两遍
    unlisten?.();
  }
}

/**
 * 看起来像"在要求动手"的表达。
 *
 * 命中才把**会改数据**的工具声明给模型 —— 这是请求层的硬约束，
 * 比在提示词里反复叮嘱可靠得多：提示词只能"劝"，不给工具是"不能"。
 *
 * ⚠️ 刻意做得**保守**：宁可漏判（该动时没动，助手会反问一句），
 * 也不要误判（不该动时动了，弹出一张删除卡片）。
 * ⚠️ 只收"动手"的词，**不要收「对」「好」「确认」这类应答词** ——
 * 它们在任何一句闲聊里都可能出现，那样等于这道闸常开。
 */
const ACTION_HINTS = [
  // 简体（"清理""清除"两种字形通用，只列一次）
  '删', '清理', '清掉', '清空', '清除', '勾选', '勾上', '选中', '移除',
  // 繁体
  '刪', '勾選', '選取',
  // 日文
  '削除', '消去', '選択', '選んで',
  // 英文
  'delete', 'remove', 'clean up', 'clear out', 'erase', 'wipe', 'uninstall',
];

/**
 * 用户最近两条消息里出现"动手"类词，就算"在要求操作"。
 *
 * ⚠️ 只扫**用户**消息：早先连助手自己的回复一起扫，于是"这些文件不建议删除"
 * 这种正文也会把删除工具重新声明出来 —— 模型的措辞反过来把闸打开了。
 * 看两条是为了兼容"助手问一句、用户接着回一句"。
 * 已知取舍：纯应答（只回一个「对」「好」，不含动词）不会命中，那种情况下
 * 助手会再问一句，功能不会静默失效。
 */
function looksLikeActionRequest(messages: AiChatMessage[]): boolean {
  const recent = messages
    .filter((message) => message.role === 'user')
    .slice(-2)
    .map((message) => message.content.toLowerCase());
  return recent.some((text) => ACTION_HINTS.some((hint) => text.includes(hint)));
}

/**
 * 被裁掉的那部分历史压成一段摘要。
 *
 * **在本地做，不额外调模型** —— 多一次请求既慢又要花钱，而这些内容本来也不复杂：
 * 有价值的只是"问过什么、执行过什么"。保留这两样，早期的上下文就不会彻底消失。
 */
function summarizeDropped(dropped: AiChatMessage[]): string {
  const asked = dropped
    .filter((message) => message.role === 'user')
    .map((message) => message.content.split('\n')[0].slice(0, 40))
    .filter(Boolean);
  // 工具执行结果也是 assistant 消息，但内容以结论句开头，单独收一行更有用
  const acted = dropped
    .filter((message) => message.role === 'assistant' && message.content.startsWith('已'))
    .map((message) => message.content.slice(0, 60));

  const parts: string[] = [];
  if (asked.length > 0) parts.push(`用户此前问过：${asked.join('；')}`);
  if (acted.length > 0) parts.push(`期间执行过：${acted.join('；')}`);
  if (parts.length === 0) return '';
  return `【更早的对话摘要（原始消息已从上下文移除）】${parts.join('。')}。需要细节时请让用户重新说明，不要凭这段摘要编造具体数字。`;
}

/**
 * 裁剪历史：始终保留 system 消息，其余按"最近 N 条"截断。
 * 目的是先把上下文成本压住 —— 被裁掉的那部分由 summarizeDropped 压成一段摘要，
 * 所以早期上下文不会彻底消失。
 */
function trimHistory(messages: AiChatMessage[]): AiChatMessage[] {
  const systems = messages.filter((message) => message.role === 'system');
  const rest = messages.filter((message) => message.role !== 'system');
  const cutIndex = Math.max(0, rest.length - MAX_HISTORY_MESSAGES);
  const kept = rest.slice(cutIndex);
  // 被裁掉的部分不直接丢：压成一段摘要，作为额外的 system 内容带上。
  // （两个协议的构造都会把 system 消息提出去，所以放这里是对的。）
  const droppedSummary = cutIndex > 0 ? summarizeDropped(rest.slice(0, cutIndex)) : '';

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

  const summaryMessage: AiChatMessage[] = droppedSummary
    ? [{ role: 'system', content: droppedSummary }]
    : [];
  return [...systems, ...summaryMessage, ...trimmed.reverse()];
}
