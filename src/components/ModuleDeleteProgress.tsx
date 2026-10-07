// ============================================================================
// 模块删除进度状态
//
// 两个由来：
// 1. 删除原先用全屏遮罩（fixed inset-0 + createPortal）呈现，会盖住标题栏 ——
//    删除期间既不能拖动窗口也不能与顶栏交互（有 issue 反馈）。删除本身在后端线程
//    执行，没有理由阻塞界面。
// 2. 呈现方式按模块的删除语义分两种：
//
//    · variant="block"（垃圾清理）
//      "放心全删"的模块 —— 默认预选风险 ≤ 2，删的时候用户不需要看着列表。
//      于是把内容整体换成这个块，并复用 ModuleScanProgress 的 module-scan-progress-area
//      尺寸规则（pages / sidebar 布局下按视口撑到 280~640px），与扫描中的等待区同尺寸。
//
//    · variant="floating"（社交专清 / 大文件 / 右键菜单 / 注册表）
//      "用户自己挑子集删除"的模块 —— 删的过程中必须保留"我在删哪几条"的参照，
//      所以列表不能动。这段内容由 ModuleOperationToolbar 承载：它是 position: fixed
//      的悬浮层，**完全不占文档流**，因此列表既不被遮挡也不会被撑开/位移。
//
// 文案由调用方传入：各模块的 i18n 命名空间和进度字段都不同，这里只负责排版。
// ============================================================================

import { Loader2 } from 'lucide-react';

interface ModuleDeleteProgressProps {
  /** 已本地化的阶段名（如「正在清理垃圾文件」） */
  phaseLabel: string;
  /** 已本地化的进度说明（如「已处理 501 / 12,731 个文件」） */
  progressLabel: string;
  /**
   * 已知进度时传 0-100；不传则显示不定进度条。
   * 部分模块的删除命令不回报进度（只有"正在删除 N 项"），它们复用同一个面板。
   */
  percent?: number;
  /** 已本地化的附加统计（仅 block 形态展示），居中铺开、窄窗口自动折行 */
  details?: string[];
  /** 可选的底部提示（仅 block 形态展示），如「请勿关闭窗口」 */
  hint?: string;
  /** 呈现形态，见文件头说明。默认 block。 */
  variant?: 'block' | 'floating';
}

export function ModuleDeleteProgress({
  phaseLabel,
  progressLabel,
  percent,
  details = [],
  hint,
  variant = 'block',
}: ModuleDeleteProgressProps) {
  const hasPercent = typeof percent === 'number';

  /** 进度条本体：有确定进度按比例填充，否则整条脉冲表示"进行中" */
  const progressBar = (
    <div className={`w-full rounded-full bg-[var(--bg-hover)] overflow-hidden ${variant === 'floating' ? 'h-1' : 'h-1.5'}`}>
      {hasPercent ? (
        <div
          className="h-full rounded-full bg-[var(--color-danger)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      ) : (
        <div className="h-full w-full rounded-full bg-[var(--color-danger)] animate-pulse" />
      )}
    </div>
  );

  // 悬浮形态：塞进 ModuleOperationToolbar 的窄列里，所以是紧凑的纵向堆叠。
  if (variant === 'floating') {
    return (
      <div className="flex w-[11em] flex-col gap-1.5 px-1 py-0.5">
        <div className="flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-danger)]" />
          <span className="truncate text-[13px] font-medium text-[var(--fg-primary)]">{phaseLabel}</span>
          {hasPercent && (
            <span className="ml-auto shrink-0 text-[11px] font-medium text-[var(--color-danger)] tabular-nums">{percent}%</span>
          )}
        </div>
        <span className="truncate text-[11px] text-[var(--fg-muted)] tabular-nums">{progressLabel}</span>
        {progressBar}
        {hint && <span className="text-[10px] text-[var(--fg-faint)]">{hint}</span>}
      </div>
    );
  }

  // 块形态：骨架与 ModuleScanProgress 一致（图标块 + 标题 + 状态徽标 + 说明，整体居中），
  // 只是把品牌绿换成危险色 —— 删除态不该长得像"正在扫描"。
  return (
    <div className="module-scan-progress-area flex flex-col items-center justify-center rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/5 p-5 text-center sm:p-6">
      <div className="flex w-fit max-w-full items-start justify-center gap-4">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--bg-card)] shadow-sm">
          <Loader2 className="h-7 w-7 animate-spin text-[var(--color-danger)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">{phaseLabel}</h4>
            {/* 百分比做成徽标而不是大字：与扫描态的状态徽标同一位置、同一量级 */}
            {hasPercent && (
              <span className="rounded-full bg-[var(--bg-card)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)] tabular-nums">
                {percent}%
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">{progressLabel}</p>
        </div>
      </div>

      <div className="mt-4 w-full max-w-lg">
        {progressBar}
        {details.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-xs text-[var(--text-muted)] tabular-nums">
            {details.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        )}
        {hint && <p className="mt-2 text-[11px] text-[var(--fg-faint)]">{hint}</p>}
      </div>
    </div>
  );
}
