// ============================================================================
// AI 对话面板
//
// 交互要求（Evan 明确提过）：可收缩、**不能挡住各个模块的主页面**。
// 因此这里刻意做成：非模态浮层 + 可收缩成细条 + 不拦截底层交互。
// 只负责展示与输入，会话状态与请求都在 AiAssistant 里。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { AlertCircle, Check, Copy, Eraser, History, ImagePlus, Loader2, Minus, RefreshCw, Send, User, X } from 'lucide-react';
import { Select } from '../ui/Select';
import { ConfirmDialog } from '../ConfirmDialog';
import i18n from '../../i18n';
import type { AiChatMessage } from '../../types/ai';
import { AiDeleteRequestCard, type AiDeleteRequestItem } from './AiDeleteRequestCard';
import { AiDeleteResultCard } from './AiDeleteResultCard';
import { AiMarkIcon } from './AiMarkIcon';
import type { AiDeleteOutcome } from './moduleActionRegistry';
import { collectImageFiles, compressImage, type AttachedImage } from './imageAttach';
import { renderMarkdown } from './renderMarkdown';
import { usePanelSize } from './usePanelSize';
import { BetaBadge } from '../BetaBadge';
import { formatSize } from '../../utils/format';

/**
 * 消息所属日期的显示文案（跨天加载后的日期分隔线用）。
 *
 * 用 `Intl.DateTimeFormat` 跟界面语言走，不自己拼"月/日"（各语言写法不同）。
 * 没有时间戳的旧数据返回空串 —— 那就干脆不插分隔线，比插错一条好。
 */
function formatDayLabel(at: number | undefined): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

interface AiChatPanelProps {
  messages: AiChatMessage[];
  /** 正在流式生成的内容；为空表示这一轮还没开始出字 */
  streamingText: string;
  /** 待确认的删除提案；非空时在消息列表下方显示确认卡片 */
  pendingDelete: AiDeleteRequestItem[] | null;
  /** 最近一次删除结果 */
  deleteResult: AiDeleteOutcome | null;
  /** 删除执行中：两个按钮都会禁用并转圈 */
  isDeleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  /** 重试某条用户消息（网络或接口出错时用）：组件只上报序号，截断与重发由上层决定 */
  onRetry: (index: number) => void;
  /** 重试最近一次提问 —— 错误提示旁边那个按钮用，用户不用去上面找 */
  onRetryLast: () => void;
  isSending: boolean;
  errorMessage: string;
  /** 当前模块显示名，只用于标题，让用户知道在跟"哪个模块的助手"说话 */
  moduleName: string;
  /** 当前档案可选的模型，用于输入框旁的就地切换 */
  modelOptions: string[];
  activeModel: string;
  onSwitchModel: (model: string) => void;
  /** 是否已配置密钥。没配置时不允许输入，也不允许发送 —— 否则用户白打一串再吃一个报错 */
  canChat: boolean;
  /** images 为空时就是纯文字发送 */
  onSend: (text: string, images: AttachedImage[]) => void;
  onCollapse: () => void;
  /** 点「清空」：只负责**弹出二次确认**，不直接清 */
  onClear: () => void;
  /** 是否还有更早的历史没加载（顶部「加载更早」按钮） */
  hasEarlier: boolean;
  isLoadingEarlier: boolean;
  onLoadEarlier: () => void;
  /** 「清空对话」二次确认的开关与回调（清空的是**所有日期**，必须确认） */
  isClearConfirmOpen: boolean;
  onConfirmClear: () => void;
  onCancelClear: () => void;
}

export function AiChatPanel({
  messages,
  streamingText,
  pendingDelete,
  deleteResult,
  isDeleting,
  onConfirmDelete,
  onCancelDelete,
  onRetry,
  isSending,
  errorMessage,
  onRetryLast,
  moduleName,
  modelOptions,
  activeModel,
  onSwitchModel,
  canChat,
  onSend,
  onCollapse,
  onClear,
  hasEarlier,
  isLoadingEarlier,
  onLoadEarlier,
  isClearConfirmOpen,
  onConfirmClear,
  onCancelClear,
}: AiChatPanelProps) {
  const { t } = useTranslation('ai');
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 输入框节点：高度要跟着内容长，所以需要拿到它量 scrollHeight */
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * 输入框随内容长高。
   *
   * 顺序有讲究：**先归零再按 scrollHeight 设高** —— 直接设 scrollHeight 的话，
   * 删字时高度只会增不会减（scrollHeight 不会自己变小）。
   *
   * 上下限交给 CSS 的 min-h / max-h，这里只给"自然高度"：
   * 将来调边界不用改这段逻辑。⚠️ max-h 里额外叠了 30vh ——
   * 窗口很矮时不能让它把上面的消息列表整个挤没（与弹窗尺寸同一套写法）。
   */
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  /** 待发送的图片（已压缩）。发出去即清空 —— 图片不进会话历史。 */
  const [attachments, setAttachments] = useState<AttachedImage[]>([]);
  /** 附件相关的提示（压缩失败、超出张数等），显示在输入区左下角 */
  const [attachError, setAttachError] = useState('');
  /** 正在放大预览的图片（data URL）；为空表示没有预览 */
  const [previewUrl, setPreviewUrl] = useState('');

  /** 单条消息最多带几张：再多对模型没有帮助，只会让每轮请求越来越重。 */
  const MAX_ATTACHMENTS = 4;

  const handleAddImages = async (files: File[]) => {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(t('attachTooMany', { count: MAX_ATTACHMENTS }));
      return;
    }
    const accepted = files.slice(0, room);
    if (files.length > room) setAttachError(t('attachTooMany', { count: MAX_ATTACHMENTS }));

    const compressed: AttachedImage[] = [];
    for (const file of accepted) {
      try {
        compressed.push(await compressImage(file));
      } catch (error) {
        // 逐张处理：一张失败不该把其余几张也丢掉
        setAttachError(error instanceof Error ? error.message : String(error));
      }
    }
    if (compressed.length > 0) {
      setAttachments((previous) => [...previous, ...compressed]);
      if (files.length <= room) setAttachError('');
    }
  };
  /** 刚复制成功的那条消息序号：图标短暂变成对勾，给"确实复制了"一个反馈 */
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  /** 复制反馈的定时器句柄：卸载时要清掉，否则面板收起后回调还会跑，连点还会叠出好几个 */
  const copyResetHandleRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyResetHandleRef.current), []);

  const handleCopy = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      // 先清掉上一个：连点两次不该留下两个回调
      window.clearTimeout(copyResetHandleRef.current);
      copyResetHandleRef.current = window.setTimeout(
        () => setCopiedIndex((previous) => (previous === index ? null : previous)),
        1500,
      );
    } catch (error) {
      console.error('复制对话内容失败:', error);
    }
  };

  /**
   * 是否跟随到底部。
   *
   * 为什么需要这个开关：流式输出时**每个增量都会触发跟随** —— 无条件拉到底的话，
   * 用户想往回读上半段会被每一帧拽回来，等于没法回看。所以只在"他本来就贴着底部"
   * 时跟随；往上滚就停止跟随，自己滚回底部（或重新发消息）才恢复。
   */
  const stickToBottomRef = useRef(true);

  /** 距底部多少像素以内算"还贴着底"。字号缩放与浮点累积都可能差几像素。 */
  const FOLLOW_BOTTOM_THRESHOLD_PX = 24;

  const handleListScroll = () => {
    const node = listRef.current;
    if (!node) return;
    // scrollHeight - clientHeight - scrollTop 就是"离底部还有多远"
    const overflow = node.scrollHeight - node.clientHeight;
    // 内容不足一屏时不存在"贴不贴底"，直接恢复跟随 ——
    // 否则清空会话之后会一直卡在"不跟随"，新回答不再自动滚动。
    stickToBottomRef.current =
      overflow <= FOLLOW_BOTTOM_THRESHOLD_PX ||
      overflow - node.scrollTop <= FOLLOW_BOTTOM_THRESHOLD_PX;
  };

  // 消息、流式增量、发送状态变化时跟随到底部；用 scrollTop 而不是 scrollIntoView，
  // 避免连带滚动整个页面。
  //
  // ⚠️ 依赖里必须有 streamingText：正文是一段段追加的，而 messages 在整轮结束前
  // 不会变 —— 少了它，流式输出期间就完全不会滚动，只有回答落定那一下才跳到底部。
  useEffect(() => {
    const node = listRef.current;
    if (!node || !stickToBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, streamingText, isSending]);

  const handleSubmit = () => {
    const text = draft.trim();
    // 只有图片没有文字也允许发送：用户常常是截个图问"这些能删吗"
    if ((!text && attachments.length === 0) || isSending || !canChat) return;
    // 用户主动发了消息：无论刚才翻到哪儿都回到跟随状态，否则自己的消息会落在视口外
    stickToBottomRef.current = true;
    onSend(text, attachments);
    setDraft('');
    setAttachments([]);
    setAttachError('');
  };

  const visibleMessages = messages.filter((message) => message.role !== 'system');

  // 尺寸可拖拽调整并持久化；未调整时用 CSS 里的 em + 视口计算值
  const { sizeStyle, hasCustomSize, startResize, resetSize } = usePanelSize();

  /**
   * 整块 portal 到 `document.body`。
   *
   * 为什么：面板是 `position: fixed`，DOM 位置不影响布局；但留在 App 根节点里时，
   * 它和模块卡共享同一套合成上下文 —— WebView2 会把模块卡的 `backdrop-filter` 层
   * 画到面板之上（"幽灵残影"）。移到 body 下，两者彻底解耦。
   *
   * ⚠️ 不会丢样式/上下文：主题类挂在 `<html>` 上，CSS 变量照样继承；
   * React 的 portal 也保留 context。预览浮层一起搬（它本来就该在最顶层）。
   */
  return createPortal(
    <>
    {/* 放大预览。刻意放在面板**之外**：面板用了 framer-motion（带 transform），
        一旦有 transform，内部 position:fixed 的元素会被它的 overflow-hidden 裁掉。 */}
    {previewUrl ? (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
        onClick={() => setPreviewUrl('')}
        role="button"
        tabIndex={-1}
      >
        <img src={previewUrl} alt="" className="max-h-full max-w-full rounded-xl shadow-2xl" />
      </div>
    ) : null}
    {/* 尺寸全部用 em + vw/vh 计算，不写死像素：em 跟随全局字号设置缩放，
        上限再被视口夹住，窗口变小会自动收窄。
        ⚠️ calc 里的减号必须带空格 —— Tailwind 里要写成下划线形式，
        否则整条属性会被浏览器丢掉（这个坑踩过）。
        ⚠️ 上面这两句原本写成 JS 注释，自从 return 被包进 Fragment 之后，
        它就成了 JSX 的兄弟节点；而 JSX 里裸写 JS 注释会被当**文本渲染到界面上**。
        所以这里必须是花括号包起来的形式。（注释里也不能出现闭合符本身，
        否则这段注释会提前结束。） */}
    <motion.div
      /* 应用根节点设了 select-none（防止界面像网页一样被拖选），
         但对话内容**必须能选中复制** —— 这里显式覆盖回来。 */
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      style={sizeStyle}
      className="ai-panel fixed right-5 bottom-5 z-40 flex w-[min(28em,calc(100vw_-_2.5em))] max-h-[min(38em,calc(100vh_-_8em))] min-h-[22em] flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-elevated)] shadow-lg select-text"
    >
      {/* 左上角拖拽手柄：面板固定在右下角，所以「左上角」才是符合直觉的缩放角。
          双击恢复默认尺寸（回到跟随字号与窗口的自适应状态）。 */}
      <div
        onPointerDown={startResize}
        onDoubleClick={resetSize}
        title={hasCustomSize ? t('resizeHintCustom') : t('resizeHint')}
        className="group absolute left-0 top-0 z-10 h-5 w-5 cursor-nwse-resize"
      >
        {/* 极简的缩放标记：一个角括号，不抢视觉但能让人知道这里可以拖。
            颜色走品牌绿而不是 --text-muted —— 后者是深灰，在浅色面板上看着像一块黑斑，
            跟整个面板的绿色调也不搭。悬停时加深，暗示"这里能拖"。
            （侧边栏那个拖拽手柄同样用品牌绿，保持一致。） */}
        <div className="pointer-events-none absolute left-1 top-1 h-2.5 w-2.5 border-l border-t border-[var(--brand-green)] opacity-40 transition-opacity group-hover:opacity-90" />
      </div>

      {/* ⚠️ 这里**不能**挂 glass-block：「去边框去底色」是给"卡片里的子区块"用的，
          挂到浮层的头部上就等于让头部完全透明，背后的模块内容会清晰透上来（看着像一块幽灵）。
          头部现在跟面板共用同一层底色，分隔线也保留。 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3 py-2">
        <AiMarkIcon className="h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">
          {t('panelTitle')}
          {moduleName ? <span className="text-[var(--text-muted)]"> · {moduleName}</span> : null}
        </span>
        <BetaBadge />
        <button
          type="button"
          onClick={onClear}
          title={t('clear')}
          aria-label={t('clear')}
          className="shrink-0 rounded-lg p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Eraser className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          title={t('collapse')}
          aria-label={t('collapse')}
          className="shrink-0 rounded-lg p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
      </header>

      <div ref={listRef} onScroll={handleListScroll} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {/* 加载更早：历史是跨天读取的，到底或到内存上限时按钮就消失 */}
        {hasEarlier && visibleMessages.length > 0 ? (
          <button
            type="button"
            onClick={onLoadEarlier}
            disabled={isLoadingEarlier}
            className="mx-auto flex items-center gap-1 rounded-full border border-[var(--border-color)] px-2.5 py-1 text-[0.79rem] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-60"
          >
            {isLoadingEarlier ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <History className="h-3 w-3" />
            )}
            {isLoadingEarlier ? t('history.loadingEarlier') : t('history.loadEarlier')}
          </button>
        ) : null}
        {visibleMessages.length === 0 ? (
          <p className="text-sm leading-relaxed text-[var(--text-muted)]">{t('emptyHint')}</p>
        ) : (
          visibleMessages.map((message, index) => {
            const isUser = message.role === 'user';
            // 跨天加载后插一条日期分隔线：不然看不出这段是昨天还是今天
            const dayLabel = formatDayLabel(message.at);
            const previousDayLabel = index > 0 ? formatDayLabel(visibleMessages[index - 1]?.at) : '';
            return (
              <div
                key={index}
                className={`group flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}
              >
                {dayLabel && dayLabel !== previousDayLabel ? (
                  <div className="flex w-full items-center gap-2 py-1 text-[0.72rem] text-[var(--text-faint)]">
                    <span className="h-px flex-1 bg-[var(--border-color)]" />
                    <span className="shrink-0">{dayLabel}</span>
                    <span className="h-px flex-1 bg-[var(--border-color)]" />
                  </div>
                ) : null}
                <div style={{ userSelect: 'all' }} className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                  <div
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                      isUser
                        ? 'bg-[var(--bg-hover)] text-[var(--text-muted)]'
                        : 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
                    }`}
                  >
                    {isUser ? <User className="h-3.5 w-3.5" /> : <AiMarkIcon className="h-3.5 w-3.5" />}
                  </div>
                  <div
                    className={`max-w-[80%] select-text whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-sm leading-relaxed ${
                      isUser ? 'bg-[var(--brand-green)] text-white' : 'bg-[var(--ai-bubble-bg)] text-[var(--text-primary)]'
                    }`}
                  >
                    {/* 用户发的图片：缩略图在上、文字在下，点击放大。
                        这里显示的是随消息一起存下来的图，所以重开面板也还在。 */}
                    {isUser && message.images && message.images.length > 0 ? (
                      <div className="mb-1.5 flex flex-wrap gap-1.5">
                        {message.images.map((image, imageIndex) => (
                          <button
                            key={imageIndex}
                            type="button"
                            onClick={() => setPreviewUrl(`data:${image.mediaType};base64,${image.dataBase64}`)}
                            title={t('previewImage')}
                            className="overflow-hidden rounded-lg ring-1 ring-inset ring-white/30"
                          >
                            <img
                              src={`data:${image.mediaType};base64,${image.dataBase64}`}
                              alt=""
                              className="h-16 w-16 object-cover transition-transform hover:scale-105"
                            />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {/* 助手返回的是 Markdown，要渲染（走 React 节点，不用内联 HTML）；
                        用户自己的输入按纯文本放，不解析 —— 免得手打的标记被吃掉。 */}
                    {isUser ? message.content : renderMarkdown(message.content)}
                  </div>
                </div>
                {/* 动作条放在**气泡下方**（悬停出现）：复制每条、重试仅对用户消息。
                    放在上方会和头像挤在一起，也不符合这类界面的习惯。 */}
                <div
                  className={`flex items-center gap-0.5 pl-8 pr-1 opacity-0 transition-opacity group-hover:opacity-100 ${
                    isUser ? 'justify-end self-end' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void handleCopy(message.content, index)}
                    title={t('copy')}
                    aria-label={t('copy')}
                    className="rounded-lg p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    {copiedIndex === index ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  </button>
                  {isUser ? (
                    <button
                      type="button"
                      onClick={() => onRetry(index)}
                      disabled={isSending}
                      title={t('retry')}
                      aria-label={t('retry')}
                      className="rounded-lg p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}

        {/* 正在生成的回答：边收边显示，让人看到"它在写字"而不是干等 */}
        {streamingText ? (
          <div className="flex items-start gap-2">
            <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--brand-green-10)] text-[var(--brand-green)]">
              <AiMarkIcon className="h-3.5 w-3.5" />
            </div>
            {/* 流式过程中的气泡必须与落定后的**同一个底色**：
                否则回答结束的一瞬间气泡会变一次色，很跳。 */}
            <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-[var(--ai-bubble-bg)] px-2.5 py-1.5 text-sm leading-relaxed text-[var(--text-primary)]">
              {renderMarkdown(streamingText)}
              {/* 光标：暗示还在继续输出 */}
              <span className="ml-0.5 inline-block h-3 w-1 translate-y-0.5 animate-pulse bg-[var(--brand-green)]" />
            </div>
          </div>
        ) : isSending ? (
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('thinking')}
          </div>
        ) : null}
      </div>

      {/* 删除提案：**不执行、只确认**。AI 只能提案，执行权在用户手里。 */}
      {pendingDelete && pendingDelete.length > 0 ? (
        <div className="shrink-0 px-3 pb-2">
          <AiDeleteRequestCard
            title={t('delete.title')}
            items={pendingDelete}
            totalLabel={t('delete.total', { count: pendingDelete.length })}
            warning={t('delete.warning')}
            irreversibleLabel={t('delete.irreversible')}
            confirmLabel={t('delete.confirm')}
            cancelLabel={t('delete.cancel')}
            busy={isDeleting}
            onConfirm={onConfirmDelete}
            onCancel={onCancelDelete}
          />
        </div>
      ) : null}

      {/* 删除结果：数字全部来自后端返回，不由模型转述 */}
      {deleteResult ? (
        <div className="shrink-0 px-3 pb-2">
          <AiDeleteResultCard
            successLabel={
              deleteResult.freedBytes
                ? t('delete.doneWithSize', {
                    count: deleteResult.deletedCount,
                    size: formatSize(deleteResult.freedBytes),
                  })
                : t('delete.doneCount', { count: deleteResult.deletedCount })
            }
            failedLabel={
              deleteResult.failures.length > 0
                ? t('delete.failedCount', { count: deleteResult.failures.length })
                : undefined
            }
            failures={deleteResult.failures}
            detailsLabel={t('delete.details')}
            rebootNotice={deleteResult.needsReboot ? t('delete.needsReboot') : undefined}
          />
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 p-2 text-[0.79rem] text-[var(--color-danger)]">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          {/* break-all 会把服务商返回的英文长句切得很难读，用 normal 断词 + 允许换行 */}
          <span className="min-w-0 whitespace-pre-wrap break-words select-text">{errorMessage}</span>
          {/* 出错时最可能想做的就是"再试一次"。让用户去上面悬停找重试按钮，
              等于把最有用的动作藏起来了。 */}
          <button
            type="button"
            onClick={onRetryLast}
            className="ml-auto shrink-0 rounded-lg border border-[var(--color-danger)]/40 px-2 py-0.5 transition-colors hover:bg-[var(--color-danger)]/10"
          >
            {t('retry')}
          </button>
        </div>
      ) : null}

      {/* 输入区：**整体一个容器**，文字在上、底部一行放模型与发送 —— 与 ds harness 一致。
          模型放在右下角，因为它属于"这条消息用什么发"，和输入内容是一体的。 */}
      <div className="mx-2.5 mb-2.5 flex shrink-0 flex-col gap-1.5 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-2.5 transition-colors focus-within:border-[var(--brand-green)]">
        {/* 已附加的图片：缩略图 + 移除。放在输入框上方，一眼能看到自己带了什么 */}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((image, index) => (
              <div key={index} className="group relative">
                <img
                  src={image.previewUrl}
                  alt=""
                  className="h-14 w-14 rounded-lg border border-[var(--border-color)] object-cover"
                />
                <button
                  type="button"
                  onClick={() => setAttachments((previous) => previous.filter((_, i) => i !== index))}
                  title={t('attachRemove')}
                  aria-label={t('attachRemove')}
                  className="absolute -right-1 -top-1 rounded-full bg-[var(--bg-elevated)] p-0.5 text-[var(--text-muted)] shadow ring-1 ring-[var(--border-color)] transition-colors hover:text-[var(--color-danger)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* ⚠️ 注释不能写在属性之间（rows={1} 那一带是属性位置，只能放属性）。
            rows 只是初始值：真实高度由上面的 effect 按内容算。
            真正定边界的是 min-h / max-h —— 少了 max-h，长提示词会一直长到把消息区挤没。 */}
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={!canChat}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            // 粘贴截图是最顺手的入口：用户刚截完图直接 Ctrl+V
            const files = collectImageFiles(event.clipboardData?.files);
            if (files.length > 0) {
              event.preventDefault();
              void handleAddImages(files);
            }
          }}
          onKeyDown={(event) => {
            // Enter 发送、Shift+Enter 换行：长问题可以分行写
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          rows={1}
          placeholder={canChat ? t('inputPlaceholder') : t('needConfigPlaceholder')}
          className="min-h-[3em] max-h-[min(13em,30vh)] w-full resize-none overflow-y-auto bg-transparent px-0.5 text-sm leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2">
          {/* 左侧：附件出错优先显示（刚发生的事），否则是未配置指引，都为空时保持安静 */}
          <span className="min-w-0 truncate text-[0.72rem] text-[var(--text-muted)]">
            {attachError || (canChat ? '' : t('needConfig'))}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 选图入口。放在左下角，与 ds harness 的位置一致 */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                void handleAddImages(collectImageFiles(event.target.files));
                // 清空 value：否则连续选同一张图不会触发 change
                event.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canChat}
              title={t('attachImage')}
              aria-label={t('attachImage')}
              className="rounded-xl border border-[var(--border-color)] p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </button>
            {modelOptions.length > 0 ? (
              <Select<string>
                value={activeModel}
                options={modelOptions.map((id) => ({ value: id, label: id }))}
                onChange={onSwitchModel}
                size="sm"
                widthClass="w-44"
              />
            ) : (
              <span className="truncate text-[0.79rem] text-[var(--text-muted)]">
                {activeModel || t('noModel')}
              </span>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canChat || isSending || (!draft.trim() && attachments.length === 0)}
              title={t('send')}
              aria-label={t('send')}
              className="shrink-0 rounded-xl bg-[var(--brand-green)] p-2 text-white transition-colors hover:bg-[var(--brand-green-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
      {/* 清空对话的二次确认：清空的是该模块**所有日期**的历史，不能点一下就执行 */}
      <ConfirmDialog
        isOpen={isClearConfirmOpen}
        title={t('clearTitle')}
        description={t('clearBody')}
        confirmText={t('clearConfirm')}
        isDanger
        onConfirm={onConfirmClear}
        onCancel={onCancelClear}
      />
    </>,
    document.body,
  );
}
