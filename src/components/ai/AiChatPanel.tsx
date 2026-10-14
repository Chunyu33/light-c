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
import { AlertCircle, Eraser, Loader2, Minus, Send, User } from 'lucide-react';
import type { AiChatMessage } from '../../types/ai';
import { AiDeleteRequestCard, type AiDeleteRequestItem } from './AiDeleteRequestCard';
import { AiDeleteResultCard } from './AiDeleteResultCard';
import { AiMarkIcon } from './AiMarkIcon';
import type { AiDeleteOutcome } from './moduleActionRegistry';
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
  isSending: boolean;
  errorMessage: string;
  /** 当前模块显示名，只用于标题，让用户知道在跟"哪个模块的助手"说话 */
  moduleName: string;
  onSend: (text: string) => void;
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
  isSending,
  errorMessage,
  moduleName,
  onSend,
  onCollapse,
  onClear,
}: AiChatPanelProps) {
  const { t } = useTranslation('ai');
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息进来时滚到底部；用 scrollTop 而不是 scrollIntoView，避免连带滚动整个页面。
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, isSending]);

  const handleSubmit = () => {
    const text = draft.trim();
    if (!text || isSending) return;
    onSend(text);
    setDraft('');
  };

  const visibleMessages = messages.filter((message) => message.role !== 'system');

  // 尺寸可拖拽调整并持久化；未调整时用 CSS 里的 em + 视口计算值
  const { sizeStyle, hasCustomSize, startResize, resetSize } = usePanelSize();

  return (
    /* 尺寸全部用 em + vw/vh 计算，不写死像素：em 跟随全局字号设置缩放，
       上限再被视口夹住，窗口变小会自动收窄。
       ⚠️ calc() 里的减号**必须带空格** —— 在 Tailwind 里写成下划线 `_-_`。
       写成 `calc(100vh-8em)` 是无效 CSS，整条属性会被浏览器丢掉（这个坑踩过）。 */
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      style={sizeStyle}
      className="ai-panel fixed right-5 bottom-5 z-40 flex w-[min(28em,calc(100vw_-_2.5em))] max-h-[min(38em,calc(100vh_-_8em))] min-h-[14em] flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-elevated)] shadow-lg"
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

      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {visibleMessages.length === 0 ? (
          <p className="text-xs leading-relaxed text-[var(--text-muted)]">{t('emptyHint')}</p>
        ) : (
          visibleMessages.map((message, index) => {
            const isUser = message.role === 'user';
            return (
              <div key={index} className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                {/* 默认头像：用户用中性小人、助手用品牌色星标 —— 一眼分清谁在说话。
                    用户侧镜像排布，气泡贴近右侧。 */}
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
                  {/* 助手返回的是 Markdown，要渲染（走 React 节点，不用内联 HTML）；
                      用户自己的输入按纯文本放，不解析 —— 免得手打的标记被吃掉。 */}
                  {isUser ? message.content : renderMarkdown(message.content)}
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
          <span className="min-w-0 break-all">{errorMessage}</span>
        </div>
      ) : null}

      <footer className="flex shrink-0 items-end gap-2 border-t border-[var(--border-color)] p-2.5">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送、Shift+Enter 换行：长问题可以分行写
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          rows={2}
          placeholder={t('inputPlaceholder')}
          className="min-h-[2.6em] min-w-0 flex-1 resize-none rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--brand-green)]"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={isSending || !draft.trim()}
          title={t('send')}
          aria-label={t('send')}
          className="shrink-0 rounded-xl bg-[var(--brand-green)] p-2 text-white transition-colors hover:bg-[var(--brand-green-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </footer>
    </motion.div>
  );
}
