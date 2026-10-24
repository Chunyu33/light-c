/**
 * 「beta」标记。
 *
 * 用在两处：设置里的「AI 助手」入口、AI 面板标题。
 * 为什么硬编码中文/英文：beta 是通用写法，各语言里都不翻译，
 * 所以不进语言包 —— 避免在四个语言文件里各维护一份一模一样的字符串。
 *
 * 样式刻意做得低调（弱化色 + 1px 边）：它是状态说明，不该抢标题的注意力。
 */
export function BetaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`shrink-0 whitespace-nowrap rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[0.71rem] font-medium leading-none text-[var(--text-muted)] ${className}`}
    >
      beta
    </span>
  );
}
