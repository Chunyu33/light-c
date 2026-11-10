// ============================================================================
// 模块内联扫描状态
// 用于扫描页面内部的等待状态，避免不同模块重复维护一套低矮的 Loading UI。
//
// 【为什么长这样】
// 旧版是"整块淡绿底 + 转圈"，高度写死 220px：窗口一变高就剩一条矮绿带悬在卡片顶部，
// 下面一大片空白；大面积品牌色比内容还抢眼，还和"已清理"的绿色成功态撞色。
//
// 现在的分工：
//   ① 进度条只留一条，在卡片头部（ModuleCard 负责），正文字段不再画 ——
//      同一条信息画两遍就是"两条 loading 线"；
//   ② 阶段行：图标 + 阶段名 + 耗时，字号与正文一致，不放大；
//   ③ 骨架列表：按**真实结果行的形状**摆（左侧图标位 + 主标题 + 右侧数值），
//      并随正文高度拉开行距。之前是五条居中细线，窗口一大就缩成中间一小撮，
//      上下各留一大片空 —— 那不是留白，是没填满。
// ============================================================================

import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

interface ModuleScanProgressProps {
  /** 扫描阶段标题 */
  title: string;
  /** 扫描阶段说明 */
  description?: string;
  /** 模块专属图标 */
  icon?: ReactNode;
  /** 额外的阶段信息或操作按钮 */
  footer?: ReactNode;
  /** 补充样式类名 */
  className?: string;
}

/**
 * 骨架行的形状：`[主条宽度, 数值条宽度]`（百分比）。
 *
 * 宽度错开是为了像一段真实内容（每行文字长短不同），等宽会像表格分隔线。
 * 数值条靠右，对应结果行里的文件大小 / 数量。
 */
const SKELETON_ROWS: [number, number][] = [
  [58, 14],
  [46, 10],
  [52, 12],
  [38, 9],
  [50, 11],
  [34, 8],
];

export function ModuleScanProgress({
  title,
  description,
  icon,
  footer,
  className = '',
}: ModuleScanProgressProps) {
  // 不再渲染"扫描中"胶囊：卡片头部状态徽章已经写着同样的字，正文再放一个是重复信息。
  // 外观走 `.scan-state`，`module-scan-progress-area` 只用来让页面模式把这块撑满。
  return (
    <div className={`module-scan-progress-area scan-state ${className}`}>
      <div className="scan-state__stack">
        <div className="scan-state__head">
          <div className="scan-state__icon">
            {icon ?? <Loader2 className="h-5 w-5 animate-spin text-[var(--brand-green)]" />}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
            {description && (
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">
                {description}
              </p>
            )}
          </div>
        </div>

        {/* 骨架列表只是形态暗示，读屏用户不需要，整块 aria-hidden */}
        <div className="scan-state__skeleton" aria-hidden="true">
          {SKELETON_ROWS.map(([titleWidth, metaWidth]) => (
            <div key={titleWidth} className="scan-state__skeleton-row">
              <i className="scan-state__skeleton-icon" />
              <i className="scan-state__skeleton-title" style={{ width: `${titleWidth}%` }} />
              <i className="scan-state__skeleton-meta" style={{ width: `${metaWidth}%` }} />
            </div>
          ))}
        </div>
      </div>

      {footer && <div className="scan-state__footer">{footer}</div>}
    </div>
  );
}

export default ModuleScanProgress;
