// ============================================================================
// 数据行上的「咨询 AI 助手」快捷按钮
//
// 各模块的数据行统一挂这个组件，样式与行为就自然一致，不用各写一遍。
// 点击后由助手打开面板并把问题直接发出去 —— 用户不需要把关键字再手打一遍。
//
// 问题文本由调用方给出，通常是**复用模块原有的「一键搜索」关键字**（路径 + 是什么/能删吗），
// 这样浏览器搜索与问 AI 用的是同一句话，不会出现两套措辞。
// ============================================================================

import { useTranslation } from 'react-i18next';
import { AiMarkIcon } from './AiMarkIcon';
import { requestAiAsk } from './aiAsk';

interface AiAskButtonProps {
  /** 要问 AI 的问题；空字符串时按钮不渲染，避免出现点了没反应的入口 */
  question: string;
  /** 允许调用方补充定位类（例如模块自己的 hover 态） */
  className?: string;
}

export function AiAskButton({ question, className = '' }: AiAskButtonProps) {
  const { t } = useTranslation('ai');

  if (!question.trim()) return null;

  return (
    <button
      type="button"
      onClick={() => requestAiAsk(question)}
      title={t('askHint')}
      aria-label={t('askHint')}
      className={`rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] ${className}`}
    >
      <AiMarkIcon className="h-3.5 w-3.5" />
    </button>
  );
}
