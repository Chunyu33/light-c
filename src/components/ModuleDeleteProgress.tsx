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
//      于是把内容整体换成一个"正在干活"的面板：环形进度 + 阶段名与已处理数 +
//      一条分隔线 + 已释放/失败/速度/剩余。块居中、字靠左（见 StatePanel）。
//
//      ⚠️ 历史上这里翻过两次车，都别再犯：
//      ① 自绘「红框 + 玫红底 + 居中块」：和全站绿/白玻璃不是一套语言，而且没吃到
//         flex 撑高，页面模式下 100 多像素就收尾、下面整片空白；
//      ② 改成"和扫描中一模一样的骨架行"：删除不是"结果还没出来"，
//         摆一排假列表反而像界面卡住了 —— 删除态要有自己的样子（别的软件也都是
//         转圈/环形进度 + 数字，没人拿骨架屏表达删除）。
//
//    · variant="floating"（社交专清 / 大文件 / 右键菜单 / 注册表）
//      "用户自己挑子集删除"的模块 —— 删的过程中必须保留"我在删哪几条"的参照，
//      所以列表不能动。这段内容由 ModuleOperationToolbar 承载：它是 position: fixed
//      的悬浮层，**完全不占文档流**，因此列表既不被遮挡也不会被撑开/位移。
//
// 文案由调用方传入：各模块的 i18n 命名空间和进度字段都不同，这里只负责排版。
// ============================================================================

import { Loader2 } from 'lucide-react';
import { StatePanel } from './StatePanel';

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
  // 悬浮形态（删自己挑的那几条）保留危险色 —— 那个位置要的是"注意，正在永久删除"；
  // 块形态（垃圾清理整块换成状态区）跟扫描态同一套语言，用品牌绿。
  const barColorClass = variant === 'floating' ? 'bg-[var(--color-danger)]' : 'bg-[var(--brand-green)]';

  /** 进度条本体：有确定进度按比例填充，否则整条脉冲表示"进行中" */
  const progressBar = (
    <div className={`w-full rounded-full bg-[var(--bg-hover)] overflow-hidden ${variant === 'floating' ? 'h-1' : 'h-1.5'}`}>
      {hasPercent ? (
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColorClass}`}
          style={{ width: `${percent}%` }}
        />
      ) : (
        <div className={`h-full w-full rounded-full animate-pulse ${barColorClass}`} />
      )}
    </div>
  );

  // 悬浮形态：塞进底部的 ModuleOperationToolbar（横向操作条，居中一块进度面板）。
  // 宽度给足是为了让「阶段名 + 已处理数」两行都不被截断 —— 太窄会变成一串省略号。
  if (variant === 'floating') {
    return (
      <div className="flex w-[20em] flex-col gap-1.5 px-1 py-0.5">
        <div className="flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-danger)]" />
          <span className="truncate text-[0.93rem] font-medium text-[var(--fg-primary)]">{phaseLabel}</span>
          {hasPercent && (
            <span className="ml-auto shrink-0 text-[0.79rem] font-medium text-[var(--color-danger)] tabular-nums">{percent}%</span>
          )}
        </div>
        <span className="truncate text-[0.79rem] text-[var(--fg-muted)] tabular-nums">{progressLabel}</span>
        {progressBar}
        {hint && <span className="text-[0.71rem] text-[var(--fg-faint)]">{hint}</span>}
      </div>
    );
  }

  // 块形态：环形进度 + 阶段名 + 统计。不画线性进度条 —— 环里已经有百分比了，
  // 再放一条就是"两条进度线"（扫描态那条在卡片头部，这里也不该重复）。
  return (
    <StatePanel>
      <div className="flex items-center gap-4">
        <ProgressRing percent={percent} indeterminate={!hasPercent} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{phaseLabel}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)] tabular-nums">{progressLabel}</p>
        </div>
      </div>

      {details.length > 0 && (
        <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-[var(--border-muted)] pt-4 text-xs text-[var(--text-muted)] tabular-nums sm:grid-cols-4">
          {details.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      )}

      {hint && <p className="mt-4 text-[0.79rem] text-[var(--fg-faint)]">{hint}</p>}
    </StatePanel>
  );
}

/**
 * 环形进度。
 *
 * 用环比用条的原因：扫描态的进度条固定在**卡片头部**（那条流光），
 * 正文里再来一条同形状的绿条，用户分不清哪个是这次操作的进度。
 * 环把百分比收在圆心，信息密度更高，也是"删除进行中"最普遍的样子。
 */
function ProgressRing({ percent, indeterminate }: { percent?: number; indeterminate: boolean }) {
  const size = 56;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const filled = (circumference * clamped) / 100;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {/* 旋转 -90° 让进度从 12 点方向开始画 */}
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--bg-hover)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--brand-green)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          className="transition-all duration-500"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[0.79rem] font-semibold text-[var(--text-primary)] tabular-nums">
        {/* 拿不到百分比（有的删除命令只回"正在删除 N 项"）就转圈，别硬凑一个 0% */}
        {indeterminate ? <Loader2 className="h-4 w-4 animate-spin text-[var(--brand-green)]" /> : `${clamped}%`}
      </span>
    </div>
  );
}
