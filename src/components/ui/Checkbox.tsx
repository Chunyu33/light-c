// ============================================================================
// 主题化复选框
// 统一处理勾选、禁用和键盘焦点状态，避免各模块重复维护原生样式。
// ============================================================================

import type { ChangeEvent, InputHTMLAttributes } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  /** 复选框状态变化回调。 */
  onChange?: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void;
}

export function Checkbox({ className = '', onChange, ...props }: CheckboxProps) {
  return (
    <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <input
        {...props}
        type="checkbox"
        onChange={(event) => onChange?.(event.currentTarget.checked, event)}
        className={`peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-card)] transition-all duration-150 hover:border-[var(--brand-green)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-green)]/25 checked:border-[var(--brand-green)] checked:bg-[var(--brand-green)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      />
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none relative z-10 h-3 w-3 scale-75 text-white opacity-0 transition-all duration-150 peer-checked:scale-100 peer-checked:opacity-100"
      >
        <path d="m3.25 8.25 3 3 6.5-6.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    </span>
  );
}

export default Checkbox;
