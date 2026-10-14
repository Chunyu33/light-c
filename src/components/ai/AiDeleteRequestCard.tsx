// ============================================================================
// AI 删除请求确认卡片（独立可复用）
//
// 刻意做成**纯展示组件**：不认识 AI、不认识任何模块，只认 props。
//   - 文案全部由调用方传入（标题、每项说明、合计、警示、按钮）→ 天然支持多语言与变化
//   - 按钮动作由调用方给（onConfirm / onCancel）→ "删除"是谁来执行由模块决定
//   - 不自己发请求、不自己弹窗、不自己跳转设置
//
// 这样同一个卡片可以被任意模块复用：垃圾清理、旧驱动、大文件……
// 它们各自提供"删什么、怎么删"，卡片只负责把范围讲清楚、把确认门槛立住。
//
// ⚠️ 设计约束：**这是写操作的最后一道门**。所以
//   1. 必须逐项列出范围，不能只说"帮你清一下"；
//   2. 不可恢复的项要单独标注（回收站这类）；
//   3. 确认按钮用危险色，和模块里原有的删除按钮保持一致。
// ============================================================================

import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';

export interface AiDeleteRequestItem {
  /** 稳定标识，回调时原样带回，模块据此定位真实目标 */
  id: string;
  /** 主文案：名称 */
  label: string;
  /** 次要说明：大小、项数等，由调用方格式化好（组件不做单位换算） */
  detail?: string;
  /** 该项删除后不可恢复：会单独标注，提醒用户这不是普通缓存 */
  irreversible?: boolean;
}

export interface AiDeleteRequestCardProps {
  title: string;
  items: AiDeleteRequestItem[];
  /** 合计说明，例如 "合计 616.14 MB / 1,235 项" */
  totalLabel: string;
  /** 风险提示；不传则不显示这一段 */
  warning?: string;
  /** 被禁用时展示的原因（例如"需先在设置 - AI 助手中开启"）。
   * 有值时确认按钮禁用 —— 关着开关时**仍显示卡片**，比让 AI 装作不会更清楚。
   */
  disabledReason?: string;
  /** 「不可恢复」标记的文案。有 irreversible 项时**必须**由调用方传入（保证多语言）。 */
  irreversibleLabel?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 正在执行：两个按钮都禁用并转圈，避免重复提交 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AiDeleteRequestCard({
  title,
  items,
  totalLabel,
  warning,
  disabledReason,
  irreversibleLabel,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: AiDeleteRequestCardProps) {
  const confirmDisabled = busy || Boolean(disabledReason);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-danger)]/40 bg-[var(--bg-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 px-3 py-2">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]" />
        <span className="min-w-0 flex-1 text-xs font-medium text-[var(--text-primary)]">{title}</span>
      </div>

      <ul className="max-h-[12em] space-y-1 overflow-y-auto px-3 py-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[var(--text-primary)]">{item.label}</span>
              {item.irreversible && irreversibleLabel ? (
                <span className="shrink-0 rounded px-1 py-0.5 text-[10px] text-[var(--color-danger)] ring-1 ring-inset ring-[var(--color-danger)]/40">
                  {irreversibleLabel}
                </span>
              ) : null}
            </span>
            {item.detail ? (
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{item.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="border-t border-[var(--border-color)] px-3 py-2">
        <p className="text-xs font-medium text-[var(--text-primary)]">{totalLabel}</p>
        {warning ? (
          <p className="mt-1 flex items-start gap-1.5 text-[11px] text-[var(--color-warning)]">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0">{warning}</span>
          </p>
        ) : null}
        {disabledReason ? (
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{disabledReason}</p>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border-color)] px-3 py-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-[var(--border-color)] px-2.5 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
