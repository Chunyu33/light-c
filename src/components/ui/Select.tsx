// ============================================================================
// 通用下拉选择组件 - 适配主题配色
// ============================================================================

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
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
  /**
   * 在下拉顶部显示搜索框，按子串过滤选项（大小写不敏感）。
   * 用于选项可能上百的场景（例如接入上百个模型的服务商），纯滚动列表没法用。
   * 打开时自动聚焦；↑↓ 在过滤结果里移动、Enter 选中当前项。
   */
  searchable?: boolean;
  /** 搜索框的占位文案（组件不碰 i18n，由调用方给本地化字符串） */
  searchPlaceholder?: string;
  /** 过滤后没有匹配项时的提示文案；不给则什么都不显示 */
  emptyText?: string;
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
  searchable = false,
  searchPlaceholder = '',
  emptyText = '',
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
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 搜索词；只在 searchable 模式下使用 */
  const [query, setQuery] = useState('');
  /** 键盘 ↑↓ 高亮在过滤结果里的位置 */
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * 菜单的水平对齐与宽度夹持。
   *
   * 菜单是 `w-max`（按最长选项撑开），触发器一旦贴近窗口右缘（AI 面板的模型选择器
   * 就在右下角），菜单会整块探出窗口外 —— 模型名"显示不全"其实是被窗口边裁掉了。
   * 打开后实测一次：右边放不下就改成右对齐（菜单右缘对齐触发器右缘），
   * 右对齐后左边还放不下，就把宽度夹在窗口内，选项自然截断（title 里有全名）。 */
  const [menuAlign, setMenuAlign] = useState<'left' | 'right'>('left');
  const [menuMaxWidth, setMenuMaxWidth] = useState<number | null>(null);

  /** 下拉大致需要的高度；低于这个值就认为"下方放不下"。 */
  const MENU_MIN_SPACE = 180;
  /** 菜单与窗口边缘之间保留的距离（px） */
  const VIEWPORT_MARGIN = 8;


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

  // 打开时把焦点交给搜索框。query / 高亮 / 对齐 / 宽度的复位都在关闭时做掉 ——
  // 若留到打开时才复位，首帧会带着上次的过滤词渲染（列表窄一截），
  // 紧接着全量列表再渲染一次，宽度一变就是用户看到的"闪跳"。
  useEffect(() => {
    if (!open) return;
    if (searchable) searchInputRef.current?.focus();
  }, [open, searchable]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 打开后实测一次水平位置：左右都放不下时夹宽度。
  // ⚠️ 水平可用区间 = 窗口 ∩ 最近的会裁剪内容的祖先 —— 只夹窗口不够：
  //    设置弹窗的滚动容器会被 w-max 的菜单撑出横向滚动条（用户 2026-11-25 反馈）。
  // ⚠️ 必须用 layout effect：先量后画，避免菜单先在溢出位置闪一帧再跳回来。
  // ⚠️ 关闭时必须把对齐/宽度复位：实测的是“当前渲染位置”，上一轮的右对齐若残留，
  //    这次打开会被误判成“左对齐放得下”，表现就是一会弹左、一会弹右。
  //    复位后每次打开都从自然形态（左对齐、不夹宽）重新实测。
  useLayoutEffect(() => {
    if (!open) {
      setMenuAlign('left');
      setMenuMaxWidth(null);
      // 搜索词与高亮也在这里复位：保证下次打开的首帧就是全量列表的尺寸，
      // 不再出现"过滤列表 → 全量列表"两次渲染之间的宽度跳变
      setQuery('');
      setActiveIndex(0);
      return;
    }
    const menu = menuRef.current;
    const container = containerRef.current;
    if (!menu || !container) return;

    const menuRect = menu.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const clip = findClipBounds(container);

    let leftBound = VIEWPORT_MARGIN;
    let rightBound = window.innerWidth - VIEWPORT_MARGIN;
    if (clip) {
      leftBound = Math.max(leftBound, clip.left + VIEWPORT_MARGIN);
      rightBound = Math.min(rightBound, clip.right - VIEWPORT_MARGIN);
    }

    // 两种对齐逐一试（宽度两个方向都一样，判定只依赖几何）：
    // 左对齐 = [触发器左缘，左缘 + 宽度]；右对齐 = [触发器右缘 - 宽度，触发器右缘]。
    // 都放不下时选溢出更少的一侧，并把菜单宽度夹进可用区间 ——
    // 选项自带 truncate，全名在 title 里。
    const width = menuRect.width;
    if (containerRect.left + width <= rightBound) {
      setMenuAlign('left');
      setMenuMaxWidth(null);
    } else if (containerRect.right - width >= leftBound) {
      setMenuAlign('right');
      setMenuMaxWidth(null);
    } else {
      const leftOverflow = containerRect.left + width - rightBound;
      const rightOverflow = leftBound - (containerRect.right - width);
      setMenuAlign(rightOverflow < leftOverflow ? 'right' : 'left');
      setMenuMaxWidth(rightBound - leftBound);
    }
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  // 过滤按子串匹配（label / value / title 三个字段都算），大小写不敏感 ——
  // 模型名既有 qwen-max 这类小写 id，也有"通义千问-Max"这类显示名
  const filteredOptions = normalizedQuery
    ? options.filter((option) =>
        option.label.toLowerCase().includes(normalizedQuery)
          || option.value.toLowerCase().includes(normalizedQuery)
          || (option.title ?? '').toLowerCase().includes(normalizedQuery),
      )
    : options;

  // 过滤结果变化时高亮归零：旧的高亮位置对新列表毫无意义，还会越界
  useEffect(() => {
    setActiveIndex((previous) => (previous < filteredOptions.length ? previous : 0));
  }, [filteredOptions.length]);

  // 键盘高亮移动后把当前项滚进可视区
  useEffect(() => {
    if (!open || !searchable) return;
    menuListRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open, searchable, filteredOptions.length]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      // 过滤结果里循环移动
      event.preventDefault();
      setActiveIndex((previous) => (filteredOptions.length === 0 ? 0 : (previous + 1) % filteredOptions.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((previous) => (filteredOptions.length === 0 ? 0 : (previous - 1 + filteredOptions.length) % filteredOptions.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (!option) return;
      onChange(option.value);
      setOpen(false);
    }
  };

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
          ref={menuRef}
          /* ⚠️ 水平对齐与宽度夹持在打开后实测（见 useLayoutEffect）：
             触发器贴近窗口右缘时改为右对齐、必要时夹宽度，选项靠 truncate + title 兑底 */
          style={menuMaxWidth !== null ? { maxWidth: `${menuMaxWidth}px` } : undefined}
          className={`glass-overlay absolute ${menuAlign === 'right' ? 'right-0' : 'left-0'} min-w-full w-max py-1 rounded-xl
            ${openUpward ? 'bottom-full mb-1.5 slide-in-from-bottom-1' : 'top-full mt-1.5 slide-in-from-top-1'}
            /* 底色用浮层专用的 --glass-overlay-bg：.glass-overlay 的默认值会被
               bg-[var(--bg-card)]（玻璃态只有 0.42 白）覆盖，菜单会透出背后的列表文字，
               读选项时很干扰。非玻璃主题下该变量未定义，回退到 --bg-card。 */
            bg-[var(--glass-overlay-bg,var(--bg-card))] border border-[var(--border-color)]
            shadow-lg shadow-black/5 z-50
            animate-in fade-in duration-150`}
        >
          {searchable && (
            /* 搜索框在滚动区**外面**：列表滚动时它必须一直可见，
               否则百页模型翻到深处想改搜索词还得先滚回顶部 */
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={searchPlaceholder}
              className="m-1 mb-0.5 w-[calc(100%-0.5em)] rounded-lg border border-[var(--border-color)]
                bg-[var(--bg-input)] px-2 py-1.5 text-sm text-[var(--text-primary)]
                placeholder:text-[var(--text-muted)]
                focus:outline-none focus:border-[var(--brand-green)]/50"
            />
          )}
          {/* 滚动区单独一层：搜索框不跟着滚 */}
          <div ref={menuListRef} className={`overflow-y-auto ${menuMaxHeightClass}`}>
            {/* 筛选项可能来自平台/模型类型，数量不可控；截断与滚动能避免下拉层挤压结果区。 */}
            {filteredOptions.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = searchable && index === activeIndex && !isSelected;
              return (
                <button
                  key={option.value}
                  type="button"
                  data-active={isActive || undefined}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2 ${optionSizeClass} ${textClass}
                    transition-colors duration-100
                    ${isSelected
                      ? 'bg-[var(--brand-green)]/10 text-[var(--brand-green)] font-medium'
                      : isActive
                        ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
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
            {filteredOptions.length === 0 && emptyText && (
              <div className={`${optionSizeClass} ${textClass} text-[var(--text-muted)]`}>{emptyText}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 向上找最近的会裁剪内容的祖先（overflow 非 visible），返回它的可视矩形。
 *
 * 绝对定位的菜单会被这类祖先横向裁剪或撑出滚动条：设置弹窗的滚动容器、
 * overflow-hidden 的模块卡都是。没有这类祖先（一路 visible 到根）时返回 null，
 * 此时只按窗口夹持。
 */
function findClipBounds(element: Element): { left: number; right: number } | null {
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const rect = parent.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }
    parent = parent.parentElement;
  }
  return null;
}
