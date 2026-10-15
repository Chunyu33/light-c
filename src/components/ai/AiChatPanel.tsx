// ============================================================================
// AI 对话面板
//
// 交互要求（Evan 明确提过）：可收缩、**不能挡住各个模块的主页面**。
// 因此这里刻意做成：非模态浮层 + 可收缩成细条 + 不拦截底层交互。
// 只负责展示与输入，会话状态与请求都在 AiAssistant 里。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { AlertCircle, Check, Copy, Eraser, ImagePlus, Loader2, Minus, RefreshCw, Send, User, X } from 'lucide-react';
import { Select } from '../ui/Select';
import type { AiChatMessage } from '../../types/ai';
import { AiDeleteRequestCard, type AiDeleteRequestItem } from './AiDeleteRequestCard';
import { AiDeleteResultCard } from './AiDeleteResultCard';
import { AiMarkIcon } from './AiMarkIcon';
import type { AiDeleteOutcome } from './moduleActionRegistry';
import { collectImageFiles, compressImage, type AttachedImage } from './imageAttach';
import { renderMarkdown } from './renderMarkdown';
import { usePanelSize } from './usePanelSize';
import { formatSize } from '../../utils/format';

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
  /** 当前使用的模型 · 服务商，显示在标题栏下方 —— 用户必须知道自己正在用的是什么 */
  modelLabel: string;
  /** 当前档案可选的模型，用于输入框旁的就地切换 */
  modelOptions: string[];
  activeModel: string;
  onSwitchModel: (model: string) => void;
  /** 是否已配置密钥。没配置时不允许输入，也不允许发送 —— 否则用户白打一串再吃一个报错 */
  canChat: boolean;
  /** images 为空时就是纯文字发送 */
  onSend: (text: string, images: AttachedImage[]) => void;
  onCollapse: () => void;
  onClear: () => void;
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
  modelLabel,
  modelOptions,
  activeModel,
  onSwitchModel,
  canChat,
  onSend,
  onCollapse,
  onClear,
}: AiChatPanelProps) {
  const { t } = useTranslation('ai');
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleCopy = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      setTimeout(
        () => setCopiedIndex((previous) => (previous === index ? null : previous)),
        1500,
      );
    } catch (error) {
      console.error('复制对话内容失败:', error);
    }
  };

  // 新消息进来时滚到底部；用 scrollTop 而不是 scrollIntoView，避免连带滚动整个页面。
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, isSending]);

  const handleSubmit = () => {
    const text = draft.trim();
    // 只有图片没有文字也允许发送：用户常常是截个图问"这些能删吗"
    if ((!text && attachments.length === 0) || isSending || !canChat) return;
    onSend(text, attachments);
    setDraft('');
    setAttachments([]);
    setAttachError('');
  };

  const visibleMessages = messages.filter((message) => message.role !== 'system');

  // 尺寸可拖拽调整并持久化；未调整时用 CSS 里的 em + 视口计算值
  const { sizeStyle, hasCustomSize, startResize, resetSize } = usePanelSize();

  return (
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
      className="ai-panel fixed right-5 bottom-5 z-40 flex w-[min(28em,calc(100vw_-_2.5em))] max-h-[min(38em,calc(100vh_-_8em))] min-h-[14em] flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-elevated)] shadow-lg select-text"
    >
      {/* 左上角拖拽手柄：面板固定在右下角，所以「左上角」才是符合直觉的缩放角。
          双击恢复默认尺寸（回到跟随字号与窗口的自适应状态）。 */}
      <div
        onPointerDown={startResize}
        onDoubleClick={resetSize}
        title={hasCustomSize ? t('resizeHintCustom') : t('resizeHint')}
        className="absolute left-0 top-0 z-10 h-5 w-5 cursor-nwse-resize"
      >
        {/* 极简的缩放标记：两道短斜线，不抢视觉但能让人知道这里可以拖 */}
        <div className="pointer-events-none absolute left-1 top-1 h-2.5 w-2.5 border-l border-t border-[var(--text-muted)] opacity-50" />
      </div>

      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3 py-2">
        <AiMarkIcon className="h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">
          {t('panelTitle')}
          {moduleName ? <span className="text-[var(--text-muted)]"> · {moduleName}</span> : null}
        </span>
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

      {/* 当前配置：模型 · 服务商。放在对话区上方而不是标题栏里，
          因为它会随设置变化，需要能被一眼看到。 */}
      {modelLabel ? (
        <div className="shrink-0 border-b border-[var(--border-color)] px-3 pb-1.5 text-[10px] text-[var(--text-muted)]">
          {modelLabel}
        </div>
      ) : null}

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {visibleMessages.length === 0 ? (
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t('emptyHint')}</p>
        ) : (
          visibleMessages.map((message, index) => {
            const isUser = message.role === 'user';
            return (
              <div
                key={index}
                className={`group flex flex-col gap-0.5 ${isUser ? 'items-end' : 'items-start'}`}
              >
                <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
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
                    className={`max-w-[80%] whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-xs leading-relaxed ${
                      isUser ? 'bg-[var(--brand-green)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-primary)]'
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
            <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-xl bg-[var(--bg-card)] px-2.5 py-1.5 text-xs leading-relaxed text-[var(--text-primary)]">
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
        <div className="mx-3 mb-2 flex shrink-0 items-start gap-2 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 p-2 text-[11px] text-[var(--color-danger)]">
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

        <textarea
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
          rows={2}
          placeholder={canChat ? t('inputPlaceholder') : t('needConfigPlaceholder')}
          className="min-h-[3em] w-full resize-none bg-transparent px-0.5 text-xs leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-2">
          {/* 左侧：附件出错优先显示（刚发生的事），否则是未配置指引，都为空时保持安静 */}
          <span className="min-w-0 truncate text-[10px] text-[var(--text-muted)]">
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
              <span className="truncate text-[11px] text-[var(--text-muted)]">
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
    </>
  );
}
