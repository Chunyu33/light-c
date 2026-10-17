// ============================================================================
// AI 删除结果卡片（独立可复用）
//
// 和请求卡片一样是纯展示组件。存在的意义是：**删除结果一律以后端返回为准**，
// 不用对话气泡里的文字表达 —— 模型复述数字是最容易出错的地方，
// 而这里显示的字符串直接来自调用方拿到的结果结构。
//
// 失败项做成可展开的列表：用户最需要知道的是"哪一项没删掉、为什么"。
// ============================================================================

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RotateCw } from 'lucide-react';

export interface AiDeleteFailure {
  name: string;
  reason: string;
}

export interface AiDeleteResultCardProps {
  /** 成功摘要，例如 "已删除 1,233 项，释放 615.02 MB" */
  successLabel: string;
  /** 失败摘要；没有失败时不传 */
  failedLabel?: string;
  /** 失败明细（名称 + 原因），可展开 */
  failures?: AiDeleteFailure[];
  /** 失败明细的展开/收起按钮文案 */
  detailsLabel?: string;
  /** 需要重启才能生效时的提示 */
  rebootNotice?: string;
}

export function AiDeleteResultCard({
  successLabel,
  failedLabel,
  failures,
  detailsLabel,
  rebootNotice,
}: AiDeleteResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const hasFailures = Boolean(failedLabel) && (failures?.length ?? 0) > 0;

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-2 px-3 py-2">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
        <span className="min-w-0 flex-1 text-xs font-medium text-[var(--text-primary)]">{successLabel}</span>
      </div>

      {hasFailures ? (
        <div className="border-t border-[var(--border-color)] px-3 py-2">
          <button
            type="button"
            onClick={() => setExpanded((previous) => !previous)}
            className="flex w-full items-center gap-1.5 text-left text-xs text-[var(--color-warning)]"
          >
            {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="min-w-0 flex-1">{failedLabel}</span>
            {detailsLabel ? <span className="shrink-0 text-[var(--text-muted)]">{detailsLabel}</span> : null}
          </button>

          {expanded ? (
            <ul className="mt-1.5 space-y-1 pl-6">
              {failures?.map((failure, index) => (
                <li key={`${failure.name}-${index}`} className="text-[0.79rem] leading-relaxed">
                  <span className="break-all text-[var(--text-primary)]">{failure.name}</span>
                  <span className="ml-1 break-all text-[var(--text-muted)]">{failure.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {rebootNotice ? (
        <div className="flex items-start gap-1.5 border-t border-[var(--border-color)] px-3 py-2 text-[0.79rem] text-[var(--text-muted)]">
          <RotateCw className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0">{rebootNotice}</span>
        </div>
      ) : null}
    </div>
  );
}
