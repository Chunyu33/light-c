// ============================================================================
// 主题化开关
// 与 Checkbox 保持同一套约定：尺寸用 em 跟随全局字号设置缩放，颜色一律走主题变量。
// 底层仍是原生 checkbox，只是 role 改成 switch，键盘操作与读屏软件都能直接用。
// ============================================================================

import type { ChangeEvent, InputHTMLAttributes } from 'react';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  /** 开关状态变化回调 */
  onChange?: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void;
}

export function Switch({ className = '', onChange, ...props }: SwitchProps) {
  return (
    <span className="relative inline-flex h-[1.43em] w-[2.57em] shrink-0 items-center">
      {/* 轨道：原生 input 本体，承担点击、焦点与无障碍语义 */}
      <input
        {...props}
        type="checkbox"
        role="switch"
        onChange={(event) => onChange?.(event.currentTarget.checked, event)}
        className={`peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none rounded-full border border-[var(--border-color)] bg-[var(--bg-switch)] transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-green)]/30 checked:border-[var(--brand-green)] checked:bg-[var(--brand-green)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      />
      {/* 滑块：纯装饰，位移量 = 轨道宽 - 滑块宽 - 左右留白 */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[0.14em] top-[0.14em] h-[1.14em] w-[1.14em] rounded-full bg-white shadow-sm transition-transform duration-150 peer-checked:translate-x-[1.15em]"
      />
    </span>
  );
}
