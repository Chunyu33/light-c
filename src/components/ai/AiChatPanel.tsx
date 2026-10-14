// ============================================================================
// AI 对话面板
//
// 交互要求（Evan 明确提过）：可收缩、**不能挡住各个模块的主页面**。
// 因此这里刻意做成：非模态浮层 + 可收缩成细条 + 不拦截底层交互。
// 只负责展示与输入，会话状态与请求都在 AiAssistant 里。
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Eraser, Loader2, Minus, Send, Sparkles, User } from 'lucide-react';
import type { AiChatMessage } from '../../types/ai';

interface AiChatPanelProps {
  messages: AiChatMessage[];
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

  return (
    /* 尺寸全部用 em + vw/vh 计算，不写死像素：
       - em 跟随全局字号设置一起缩放；
       - 上限再被视口夹住，窗口变小会自动收窄，不会顶出屏幕。 */
    <div className="ai-panel fixed right-5 bottom-5 z-40 flex w-[28em] max-w-[calc(100vw-2.5em)] max-h-[min(38em,calc(100vh-8em))] min-h-[14em] flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-elevated)] shadow-lg">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
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
                  {isUser ? <User className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
                </div>
                <div
                  className={`max-w-[80%] whitespace-pre-wrap break-words rounded-xl px-2.5 py-1.5 text-xs leading-relaxed ${
                    isUser ? 'bg-[var(--brand-green)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-primary)]'
                  }`}
                >
                  {message.content}
                </div>
              </div>
            );
          })
        )}

        {isSending ? (
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('thinking')}
          </div>
        ) : null}
      </div>

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
    </div>
  );
}
