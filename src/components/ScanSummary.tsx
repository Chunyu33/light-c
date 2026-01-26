// ============================================================================
// 扫描结果摘要组件 - 支持主题切换
// ============================================================================

import { FileSearch, Clock, Trash2, CheckCircle2 } from 'lucide-react';
import type { ScanResult, DeleteResult } from '../types';
import { formatSize, formatDuration } from '../utils/format';

interface ScanSummaryProps {
  scanResult: ScanResult | null;
  deleteResult: DeleteResult | null;
  selectedCount: number;
  selectedSize: number;
}

export function ScanSummary({
  scanResult,
  deleteResult,
  selectedCount,
  selectedSize,
}: ScanSummaryProps) {
  if (!scanResult) return null;

  return (
    <div className="space-y-3">
      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-3">
        {/* 发现文件 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <FileSearch className="w-4 h-4 text-emerald-500" />
            <span className="text-xs text-[var(--fg-muted)]">发现文件</span>
          </div>
          <p className="text-lg font-bold text-[var(--fg-primary)] tabular-nums">
            {scanResult.total_file_count.toLocaleString()}
          </p>
        </div>

        {/* 可清理 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <Trash2 className="w-4 h-4 text-orange-500" />
            <span className="text-xs text-[var(--fg-muted)]">可清理</span>
          </div>
          <p className="text-lg font-bold text-orange-500 tabular-nums">
            {formatSize(scanResult.total_size)}
          </p>
        </div>

        {/* 已选中 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-xs text-[var(--fg-muted)]">已选中</span>
          </div>
          <p className="text-lg font-bold text-emerald-500 tabular-nums">
            {selectedCount.toLocaleString()}
            <span className="text-sm font-normal text-[var(--fg-muted)] ml-1">({formatSize(selectedSize)})</span>
          </p>
        </div>

        {/* 扫描耗时 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-teal-500" />
            <span className="text-xs text-[var(--fg-muted)]">扫描耗时</span>
          </div>
          <p className="text-lg font-bold text-[var(--fg-primary)] tabular-nums">
            {formatDuration(scanResult.scan_duration_ms)}
          </p>
        </div>
      </div>

      {/* 删除结果提示 */}
      {deleteResult && (
        <div className={`rounded-lg border p-3 flex items-center gap-3 ${
          deleteResult.failed_count === 0
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : 'bg-amber-500/10 border-amber-500/30'
        }`}>
          <CheckCircle2 className={`w-5 h-5 ${
            deleteResult.failed_count === 0 ? 'text-emerald-500' : 'text-amber-500'
          }`} />
          <div className="flex-1">
            <span className={`text-sm font-medium ${
              deleteResult.failed_count === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
            }`}>
              {deleteResult.failed_count === 0 ? '清理完成！' : '清理完成（部分失败）'}
            </span>
            <span className="text-xs text-[var(--fg-muted)] ml-3">
              删除 {deleteResult.success_count} 个文件，释放 {formatSize(deleteResult.freed_size)}
              {deleteResult.failed_count > 0 && `，${deleteResult.failed_count} 个失败`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
