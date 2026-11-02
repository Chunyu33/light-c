// ============================================================================
// 通用下拉选择组件 - 适配主题配色
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** 完整提示文本；下拉项需要短标签时，用 title 保留完整信息。 */
  title?: string;
}

interface SelectProps<T extends string = string> {
  /** 当前选中值 */
  value: T;
  /** 选项列表 */
  options: SelectOption<T>[];
  /** 选中回调 */
  onChange: (value: T) => void;
  /** 宽度类名，默认 w-28 */
  widthClass?: string;
  /** 尺寸模式，小尺寸用于模块筛选条，默认保持设置页现有观感 */
  size?: 'sm' | 'md';
  /** 下拉列表高度类名，长列表需要限制高度避免撑破模块布局 */
  menuMaxHeightClass?: string;
  /** 是否禁用 */
  disabled?: boolean;
  /**
   * 触发器的视觉形态。
   * - `default`：带底色和描边，用于设置页、筛选条这类独立控件；
   * - `bare`：去掉底色和描边，只在悬停时浮现一层淡底。
   *   用于顶栏这类**本身已经有材质**的容器 —— 在上面再压一个白底带边框的小方块，
   *   会读成"贴在玻璃上的另一样东西"，而不是同一层。
   */
  variant?: 'default' | 'bare';
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  widthClass = 'w-28',
  size = 'md',
  menuMaxHeightClass = 'max-h-64',
  disabled = false,
  variant = 'default',
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  /**
   * 下拉向上弹出。
   *
   * **自动判断**而不是让调用方传参数：贴在窗口底部的控件（例如 AI 助手面板的输入区）
   * 向下展开会被裁掉或顶出屏幕，而调用方很难自己判断"我离底部还有多少"。
   * 打开时量一次，下方空间不够、上方更宽裕就翻上去。
   */
  const [openUpward, setOpenUpward] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  /** 下拉大致需要的高度；低于这个值就认为"下方放不下"。 */
  const MENU_MIN_SPACE = 180;

  const updateDirection = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    setOpenUpward(below < MENU_MIN_SPACE && above > below);
  }, []);

  // 点击外部关闭
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open, handleClickOutside]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const selectedOption = options.find(o => o.value === value);
  // 尺寸只管内边距和圆角，**字号不跟尺寸走**。
  // 之前 sm=12px、md=14px，同一个控件在筛选条和设置页里差一档，看着像两个组件。
  // 现在统一 text-sm（0.875rem，跟随全局字号设置）；
  // 只有 bare 变体（顶栏）用 inherit —— 那处要跟顶栏自己的字号节奏，属于特调。
  const triggerSizeClass = size === 'sm' ? 'px-2.5 py-1.5 rounded-lg' : 'px-3 py-2 rounded-xl';
  const textClass = variant === 'bare' ? 'text-[inherit]' : 'text-sm';
  const optionSizeClass = size === 'sm' ? 'px-2.5 py-1.5' : 'px-3 py-2';
  // bare：没有底色和描边，靠悬停时的一层淡底表达可点；打开时也不画绿色描边，
  // 否则在玻璃顶栏上会突然冒出一个绿框。
  const triggerVariantClass = variant === 'bare'
    ? 'bg-transparent border border-transparent hover:bg-[var(--bg-hover)]'
    : `bg-[var(--bg-card)] border border-[var(--border-color)] hover:border-[var(--brand-green)]/50 hover:bg-[var(--bg-hover)] ${
      open ? 'border-[var(--brand-green)] ring-2 ring-[var(--brand-green)]/20' : ''
    }`;

  return (
    <div ref={containerRef} className={`relative ${widthClass}`}>
      {/* 触发器 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          // 打开前先量一次方向：贴在窗口底部的控件要向上弹
          if (!open) updateDirection();
          setOpen(!open);
        }}
        className={`w-full flex items-center ${variant === 'bare' ? 'justify-start gap-1' : 'justify-between gap-2'} ${triggerSizeClass} ${textClass}
          ${triggerVariantClass}
          text-[var(--text-primary)] font-medium
          focus:outline-none focus:ring-2 focus:ring-[var(--brand-green)]/20
          transition-all duration-200
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span className="min-w-0 truncate" title={selectedOption?.title ?? selectedOption?.label ?? value}>
          {selectedOption?.label ?? value}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-[var(--text-muted)] transition-transform duration-200 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* 下拉列表 */}
      {open && (
        <div
          /* ⚠️ 宽度不能是 w-full：那是"跟着触发器宽度走"，
             触发器一旦是自适应（w-auto，比如顶栏那个盘符选择器只有 "C: ⌄" 那么宽），
             菜单项就会被截成 "D: o..."。这里改成「至少和触发器一样宽，
             内容更多时按最长的那一项撑开」—— 两侧都照顾到。 */
          className={`glass-overlay absolute left-0 min-w-full w-max py-1 rounded-xl
            ${openUpward ? 'bottom-full mb-1.5 slide-in-from-bottom-1' : 'top-full mt-1.5 slide-in-from-top-1'}
            /* 底色用浮层专用的 --glass-overlay-bg：.glass-overlay 的默认值会被
               bg-[var(--bg-card)]（玻璃态只有 0.42 白）覆盖，菜单会透出背后的列表文字，
               读选项时很干扰。非玻璃主题下该变量未定义，回退到 --bg-card。 */
            bg-[var(--glass-overlay-bg,var(--bg-card))] border border-[var(--border-color)]
            shadow-lg shadow-black/5 z-50 overflow-y-auto ${menuMaxHeightClass}
            animate-in fade-in duration-150`}
        >
          {/* 筛选项可能来自平台/模型类型，数量不可控；截断与滚动能避免下拉层挤压结果区。 */}
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between gap-2 ${optionSizeClass} ${textClass}
                  transition-colors duration-100
                  ${isSelected
                    ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)] font-medium'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
              >
                <span className="min-w-0 truncate" title={option.title ?? option.label}>{option.label}</span>
                {isSelected && (
                  <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-[var(--brand-green)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
