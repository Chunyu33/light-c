// ============================================================================
// 轻量图表组件 - 不引入图表库，保持模块渲染成本和打包体积可控
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

export const CHART_PALETTE = ['#07c160', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];

export interface ChartItem {
  id: string;
  label: string;
  value: number;
  color?: string;
  valueLabel: string;
  percentLabel?: string;
  secondaryLabel?: string;
}

interface ChartTooltipState {
  item: ChartItem;
  x: number;
  y: number;
}

interface PendingTooltipPointer {
  item: ChartItem;
  clientX: number;
  clientY: number;
}

interface DonutChartProps {
  items: ChartItem[];
  totalLabel: string;
  totalValueLabel: string;
  emptyText: string;
}

interface ColumnChartProps {
  items: ChartItem[];
  emptyText: string;
}

const TOOLTIP_WIDTH = 192;
const TOOLTIP_ESTIMATED_HEIGHT = 82;
const TOOLTIP_OFFSET = 12;
const TOOLTIP_EDGE_PADDING = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function calculateTooltipPosition(clientX: number, clientY: number, containerRect: DOMRect) {
  const pointerX = clientX - containerRect.left;
  const pointerY = clientY - containerRect.top;
  const shouldFlipX = pointerX + TOOLTIP_OFFSET + TOOLTIP_WIDTH > containerRect.width;
  const shouldFlipY = pointerY + TOOLTIP_OFFSET + TOOLTIP_ESTIMATED_HEIGHT > containerRect.height;
  const rawX = shouldFlipX
    ? pointerX - TOOLTIP_OFFSET - TOOLTIP_WIDTH
    : pointerX + TOOLTIP_OFFSET;
  const rawY = shouldFlipY
    ? pointerY - TOOLTIP_OFFSET - TOOLTIP_ESTIMATED_HEIGHT
    : pointerY + TOOLTIP_OFFSET;

  // tooltip 必须留在图表容器内部，否则卡片右侧/底部会把浮层裁掉。
  return {
    x: Math.round(clamp(rawX, TOOLTIP_EDGE_PADDING, Math.max(TOOLTIP_EDGE_PADDING, containerRect.width - TOOLTIP_WIDTH - TOOLTIP_EDGE_PADDING))),
    y: Math.round(clamp(rawY, TOOLTIP_EDGE_PADDING, Math.max(TOOLTIP_EDGE_PADDING, containerRect.height - TOOLTIP_ESTIMATED_HEIGHT - TOOLTIP_EDGE_PADDING))),
  };
}

function useChartHover() {
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<ChartTooltipState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeItemIdRef = useRef<string | null>(null);
  const pendingPointerRef = useRef<PendingTooltipPointer | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const flushTooltip = useCallback(() => {
    animationFrameRef.current = null;
    const pendingPointer = pendingPointerRef.current;
    const containerRect = containerRef.current?.getBoundingClientRect();
    if (!pendingPointer || !containerRect) return;

    const position = calculateTooltipPosition(
      pendingPointer.clientX,
      pendingPointer.clientY,
      containerRect
    );

    setTooltip(previousTooltip => {
      const unchanged =
        previousTooltip?.item.id === pendingPointer.item.id &&
        previousTooltip.x === position.x &&
        previousTooltip.y === position.y;

      // 鼠标移动频率远高于界面需要，位置没变时不触发 React 重渲染。
      if (unchanged) return previousTooltip;

      return {
        item: pendingPointer.item,
        x: position.x,
        y: position.y,
      };
    });
  }, []);

  const updateTooltip = useCallback((event: MouseEvent, item: ChartItem) => {
    if (activeItemIdRef.current !== item.id) {
      activeItemIdRef.current = item.id;
      setActiveItemId(item.id);
    }

    pendingPointerRef.current = {
      item,
      clientX: event.clientX,
      clientY: event.clientY,
    };

    if (animationFrameRef.current === null) {
      // 用 RAF 合并 mousemove，避免每个鼠标事件都 setState 导致图表掉帧。
      animationFrameRef.current = window.requestAnimationFrame(flushTooltip);
    }
  }, [flushTooltip]);

  const clearHover = useCallback(() => {
    activeItemIdRef.current = null;
    pendingPointerRef.current = null;
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setActiveItemId(null);
    setTooltip(null);
  }, []);

  useEffect(() => clearHover, [clearHover]);

  return {
    activeItemId,
    tooltip,
    containerRef,
    updateTooltip,
    clearHover,
  };
}

export function DonutChart({ items, totalLabel, totalValueLabel, emptyText }: DonutChartProps) {
  const { activeItemId, tooltip, containerRef, updateTooltip, clearHover } = useChartHover();
  const totalValue = useMemo(() => items.reduce((sum, item) => sum + item.value, 0), [items]);
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const segments = useMemo(() => {
    let accumulatedRatio = 0;
    return items.map((item, index) => {
      const ratio = totalValue > 0 ? item.value / totalValue : 0;
      const dashLength = Math.max(0, ratio * circumference);
      const dashOffset = -accumulatedRatio * circumference;
      accumulatedRatio += ratio;

      return {
        item,
        ratio,
        dashLength,
        dashOffset,
        color: item.color ?? CHART_PALETTE[index % CHART_PALETTE.length],
      };
    });
  }, [circumference, items, totalValue]);

  return (
    <div
      ref={containerRef}
      className="relative grid gap-4 md:grid-cols-[140px_minmax(0,1fr)] md:items-center"
      onMouseLeave={clearHover}
    >
      <div className="relative mx-auto h-32 w-32">
        <svg viewBox="0 0 120 120" className="-rotate-90">
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            stroke="var(--bg-hover)"
            strokeWidth="16"
          />
          {segments.map(({ item, ratio, dashLength, dashOffset, color }) => {
            const isActive = activeItemId === item.id;

            return (
              <circle
                key={item.id}
                cx="60"
                cy="60"
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={isActive ? 19 : 16}
                strokeDasharray={`${dashLength} ${circumference - dashLength}`}
                strokeDashoffset={dashOffset}
                strokeLinecap={ratio > 0.03 ? 'round' : 'butt'}
                className="cursor-pointer transition-[opacity,stroke-width] duration-150"
                opacity={activeItemId && !isActive ? 0.35 : 1}
                onMouseEnter={(event) => updateTooltip(event, item)}
                onMouseMove={(event) => updateTooltip(event, item)}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[11px] text-[var(--text-muted)]">{totalLabel}</span>
          <span className="text-sm font-bold text-[var(--text-primary)]">{totalValueLabel}</span>
        </div>
      </div>

      <div className="space-y-2">
        {items.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">{emptyText}</p>
        ) : (
          items.map((item, index) => {
            const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
            const isActive = activeItemId === item.id;

            return (
              <button
                key={item.id}
                type="button"
                className={`flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition ${
                  isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
                }`}
                onMouseEnter={(event) => updateTooltip(event, item)}
                onMouseMove={(event) => updateTooltip(event, item)}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]" title={item.label}>
                  {item.label}
                </span>
                {item.percentLabel && (
                  <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{item.percentLabel}</span>
                )}
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-[var(--brand-green)]">
                  {item.valueLabel}
                </span>
              </button>
            );
          })
        )}
      </div>

      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}

export function ColumnChart({ items, emptyText }: ColumnChartProps) {
  const { activeItemId, tooltip, containerRef, updateTooltip, clearHover } = useChartHover();
  const maxValue = useMemo(() => Math.max(...items.map(item => item.value), 1), [items]);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseLeave={clearHover}
    >
      <div className="flex h-36 items-end gap-2 border-b border-[var(--border-color)] pb-2">
        {items.length === 0 ? (
          <div className="flex h-full w-full items-center justify-center text-xs text-[var(--text-muted)]">
            {emptyText}
          </div>
        ) : (
          items.map((item, index) => {
            const heightPercent = Math.max(6, (item.value / maxValue) * 100);
            const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
            const isActive = activeItemId === item.id;

            return (
              <div key={item.id} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <div className="flex h-28 w-full items-end justify-center">
                  <button
                    type="button"
                    className="w-full max-w-10 cursor-pointer rounded-t-lg transition-[filter,opacity,transform] duration-150 hover:brightness-110"
                    style={{
                      height: `${heightPercent}%`,
                      backgroundColor: color,
                      opacity: activeItemId && !isActive ? 0.35 : 1,
                      transform: isActive ? 'translateY(-3px)' : 'translateY(0)',
                    }}
                    aria-label={item.label}
                    onMouseEnter={(event) => updateTooltip(event, item)}
                    onMouseMove={(event) => updateTooltip(event, item)}
                  />
                </div>
                <span className="w-full truncate text-center text-[10px] text-[var(--text-muted)]" title={item.label}>
                  {item.label}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {items.map((item, index) => {
          const color = item.color ?? CHART_PALETTE[index % CHART_PALETTE.length];
          const isActive = activeItemId === item.id;

          return (
            <button
              key={item.id}
              type="button"
              className={`flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition ${
                isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
              onMouseEnter={(event) => updateTooltip(event, item)}
              onMouseMove={(event) => updateTooltip(event, item)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
              <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={item.label}>{item.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-[var(--brand-green)]">{item.valueLabel}</span>
            </button>
          );
        })}
      </div>

      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}

function ChartTooltip({ tooltip }: { tooltip: ChartTooltipState | null }) {
  if (!tooltip) return null;

  return (
    <div
      className="glass-overlay pointer-events-none absolute z-30 w-48 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-2 shadow-lg shadow-black/10"
      style={{
        left: tooltip.x,
        top: tooltip.y,
      }}
    >
      <p className="max-w-56 truncate text-xs font-semibold text-[var(--text-primary)]" title={tooltip.item.label}>
        {tooltip.item.label}
      </p>
      <p className="mt-1 text-sm font-bold tabular-nums text-[var(--brand-green)]">{tooltip.item.valueLabel}</p>
      {(tooltip.item.percentLabel || tooltip.item.secondaryLabel) && (
        <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
          {[tooltip.item.percentLabel, tooltip.item.secondaryLabel].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}
