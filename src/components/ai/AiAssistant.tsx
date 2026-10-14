// ============================================================================
// AI 助手：悬浮球 + 对话面板
//
// 横向新增的独立功能，挂载在 App 的全局 layer 里，**不参与任何模块的逻辑**。
// 面板做成"非模态浮层 + 可收缩"，保证不遮挡模块主页面（Evan 明确要求）。
//
// 会话状态（消息、发送中、错误）都在这一层，面板只负责展示与输入。
// ============================================================================

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { aiChat } from '../../api/ai';
import type { AiChatMessage } from '../../types/ai';
import { AiChatPanel } from './AiChatPanel';
import { buildRequestMessages, getModuleDisplayName } from './aiContext';
import { getModuleDataSummary } from './moduleDataRegistry';

/** 只保留最近若干轮对话：更早的内容交给后续版本的滚动摘要处理。 */
const MAX_HISTORY_MESSAGES = 16;

interface AiAssistantProps {
  /** 当前模块 id（App 里的 visibleModuleId）；用于让助手知道"用户现在在哪" */
  activeModuleId: string | null;
}

export function AiAssistant({ activeModuleId }: AiAssistantProps) {
  const { t } = useTranslation('ai');
  const [isOpen, setIsOpen] = useState(false);
  // 历史里**只放 user/assistant**：system 提示依赖"当前模块 + 当前数据"，
  // 每次发送现取（见 handleSend），存进历史必然过期。
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // 用 ref 保存"正在请求"的标记，避免快速连点导致并发请求
  const sendingRef = useRef(false);

  const moduleName = useMemo(() => getModuleDisplayName(activeModuleId), [activeModuleId]);

  const handleSend = useCallback(
    async (text: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setIsSending(true);
      setErrorMessage('');

      const nextMessages: AiChatMessage[] = [...messages, { role: 'user', content: text }];
      setMessages(nextMessages);

      try {
        // 每次发送现取"当前模块的数据摘要"，和请求一起交给后端 ——
        // 用户可能刚扫完或刚勾选，缓存一秒都会让助手答错。
        const dataSummary = getModuleDataSummary(activeModuleId);
        const request = buildRequestMessages(nextMessages, activeModuleId, dataSummary);
        const reply = await aiChat({ messages: trimHistory(request) });
        setMessages((previous) => [...previous, { role: 'assistant', content: reply.content }]);
      } catch (error) {
        // 失败时保留用户输入在历史里，方便直接重试；错误单独展示，不混进对话正文。
        setErrorMessage(String(error));
      } finally {
        sendingRef.current = false;
        setIsSending(false);
      }
    },
    [messages, activeModuleId],
  );

  const handleClear = useCallback(() => {
    setMessages([]);
    setErrorMessage('');
  }, []);

  const handleToggle = useCallback(() => {
    setIsOpen((previous) => !previous);
  }, []);

  return (
    <>
      {isOpen ? (
        <AiChatPanel
          messages={messages}
          isSending={isSending}
          errorMessage={errorMessage}
          moduleName={moduleName}
          onSend={(text) => void handleSend(text)}
          onCollapse={handleToggle}
          onClear={handleClear}
        />
      ) : (
        <button
          type="button"
          onClick={handleToggle}
          title={t('ballTitle')}
          aria-label={t('ballTitle')}
          /* 位置刻意压在「回到顶部」按钮上方：两者都在右下角，不这样会叠在一起。 */
          className="glass-item fixed right-5 bottom-[4.75rem] z-40 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-elevated)] text-[var(--brand-green)] shadow-lg transition-transform hover:scale-105 active:scale-95"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      )}
    </>
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
