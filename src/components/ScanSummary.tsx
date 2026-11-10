// ============================================================================
// 扫描结果摘要组件 - 支持主题切换
// 支持增强删除结果显示（物理大小、跳过原因、重启待删除）
// ============================================================================

import { useState, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { FileSearch, Clock, Trash2, CheckCircle2, X, AlertTriangle, RefreshCw } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ScanResult } from '../types';
import type { EnhancedDeleteResult, FileDeleteResult } from '../api/commands';
import { getFailureReasonMessage, getFailureReasonTooltip } from '../api/commands';
import { formatSize, formatDuration } from '../utils/format';
import { StatePanel } from './StatePanel';
import { MODAL_BACKDROP_MOTION, MODAL_CARD_MOTION } from '../utils/modalMotion';
import { useTranslation } from 'react-i18next';

interface ScanSummaryProps {
  scanResult: ScanResult | null;
  deleteResult: EnhancedDeleteResult | null;
  selectedCount: number;
  selectedSize: number;
  /** 「扫描耗时」卡右上角的附加入口（耗时明细浮层），不传则不渲染 */
  timingDetail?: ReactNode;
}

// 失败明细弹窗组件
function FailedFilesModal({ 
  isOpen, 
  onClose, 
  failedFiles 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  failedFiles: FileDeleteResult[];
}) {
  const { t } = useTranslation('common');
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: failedFiles.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
        >
          {/* 遮罩层 */}
          <motion.div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm glass-backdrop"
            onClick={onClose}
            {...MODAL_BACKDROP_MOTION}
          />
          
          {/* 弹窗 */}
          <motion.div
            className="relative bg-[var(--bg-elevated)] rounded-xl glass-dialog shadow-2xl border border-[var(--border-default)] w-[42.86rem] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden"
            {...MODAL_CARD_MOTION}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)] shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-[var(--fg-primary)]">
                    {t('incompleteDetails')}
                  </h3>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {t('incompleteCount', { count: failedFiles.length.toLocaleString() })}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 列表头部 */}
            <div className="glass-bar flex items-center px-5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-card)] text-xs font-medium text-[var(--fg-muted)] shrink-0">
              <span className="flex-1">{t('filePath')}</span>
              <span className="w-32 text-right">{t('processingResult')}</span>
            </div>

            {/* 虚拟滚动列表 */}
            <div 
              ref={parentRef}
              className="overflow-auto"
              style={{ height: '400px', maxHeight: 'calc(80vh - 180px)' }}
            >
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const item = failedFiles[virtualItem.index];
                  return (
                    <div
                      key={virtualItem.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className="flex items-center px-5 py-2 border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)]"
                    >
                      <span 
                        className="flex-1 text-xs text-[var(--fg-secondary)] truncate pr-4" 
                        title={item.path}
                      >
                        {item.path}
                      </span>
                      <span 
                        className={`w-40 text-xs text-right shrink-0 ${item.marked_for_reboot ? 'text-blue-500' : 'text-amber-500'}`}
                        title={getFailureReasonTooltip(item.failure_reason)}
                      >
                        {getFailureReasonMessage(item.failure_reason)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 底部 */}
            <div className="glass-bar flex items-center justify-end px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-card)] shrink-0">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--bg-hover)] text-[var(--fg-primary)] hover:bg-[var(--bg-base)] transition-colors"
              >
                {t('close')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

export function ScanSummary({
  scanResult,
  deleteResult,
  selectedCount,
  selectedSize,
  timingDetail,
}: ScanSummaryProps) {
  const { t } = useTranslation('common');
  const [showFailedModal, setShowFailedModal] = useState(false);
  
  // 待重启条目也是本次删除尝试的结果，必须保留在明细中供用户核对。
  const failedFiles = deleteResult?.file_results.filter(f => !f.success) || [];

  // 清理完成后 scanResult 会被清空；此时若仍有删除结果，单独展示结果卡，
  // 扫描统计（发现/可清理/已选/耗时）仅在存在扫描数据时渲染。
  if (!scanResult && !deleteResult) return null;

  return (
    // 没有扫描数据时这一层只剩结果面板，必须自己撑满并把空间传下去：
    // `.module-card__body > :has(.module-scan-progress-area)` 只能让上一层变 flex，
    // 中间再夹一个普通 div，`flex-1` 就断了 —— 面板会退化成 220px 高、贴在正文顶部。
    <div className={scanResult ? 'space-y-3' : 'flex flex-1 flex-col'}>
      {/* 统计卡片（仅扫描数据存在时显示） */}
      {scanResult && (
        <div className="grid grid-cols-4 gap-3">
        {/* 发现文件 */}
        <div className="glass-block bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <FileSearch className="w-4 h-4 text-emerald-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('filesFound')}</span>
          </div>
          <p className="text-lg font-bold text-[var(--fg-primary)] tabular-nums">
            {scanResult.total_file_count.toLocaleString()}
          </p>
        </div>

        {/* 可清理 */}
        <div className="glass-block bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <Trash2 className="w-4 h-4 text-orange-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('cleanable')}</span>
          </div>
          <p className="text-lg font-bold text-orange-500 tabular-nums">
            {formatSize(scanResult.total_size)}
          </p>
        </div>

        {/* 已选中 */}
        <div className="glass-block bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('selected')}</span>
          </div>
          <p className="text-lg font-bold text-emerald-500 tabular-nums">
            {selectedCount.toLocaleString()}
            <span className="text-sm font-normal text-[var(--fg-muted)] ml-1">({formatSize(selectedSize)})</span>
          </p>
        </div>

        {/* 扫描耗时 */}
        <div className="glass-block bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-teal-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('scanDuration')}</span>
            {timingDetail && <span className="ml-auto -mr-1 flex items-center">{timingDetail}</span>}
          </div>
          <p className="text-lg font-bold text-[var(--fg-primary)] tabular-nums">
            {formatDuration(scanResult.scan_duration_ms)}
          </p>
        </div>
      </div>
      )}

      {/* 清理结果：与「删除中」共用 StatePanel（块居中、字靠左）。
          这两个是同一件事的前后两步，几何必须一模一样，只换图标与文案。
          曾经是 emerald 底 + 65vh 的整块色带（同一屏两种绿打架、底部提示悬在色块内外不定），
          也试过公共 EmptyState —— 它的文字是居中的，三四行长句每行都要重新找中轴，读起来费劲。 */}
      {deleteResult && (
        <StatePanel>
          <div className="flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[var(--brand-green-10)]">
              <CheckCircle2 className="h-5 w-5 text-[var(--brand-green)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-relaxed text-[var(--text-primary)]">
                {deleteResult.summary_message || t('cleanCompleted')}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)] tabular-nums">
                {[
                  t('deleteStats', {
                    success: deleteResult.success_count,
                    size: formatSize(deleteResult.freed_physical_size),
                  }),
                  deleteResult.skipped_size > 0 ? t('skippedSize', { size: formatSize(deleteResult.skipped_size) }) : '',
                  deleteResult.reboot_pending_count > 0 ? t('rebootPending', { count: deleteResult.reboot_pending_count }) : '',
                ].filter(Boolean).join('')}
              </p>
            </div>
          </div>

          {(deleteResult.needs_reboot || failedFiles.length > 0) && (
            <div className="mt-6 space-y-2 border-t border-[var(--border-muted)] pt-4">
              {/* 待重启是"已经安排好了"，用弱化色；删不掉才是需要用户看一眼的，用警告色 */}
              {deleteResult.needs_reboot && (
                <p className="flex items-center gap-1.5 text-xs text-[var(--fg-muted)]">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                  {t('rebootPendingDesc')}
                </p>
              )}
              {failedFiles.length > 0 && (
                <button
                  onClick={() => setShowFailedModal(true)}
                  className="flex items-center gap-1.5 text-left text-xs text-[var(--color-warning)] transition-colors hover:underline"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {t('incompleteSummary', { count: failedFiles.length })}
                </button>
              )}
            </div>
          )}
        </StatePanel>
      )}

      {/* 失败明细弹窗 */}
      {failedFiles.length > 0 && (
        <FailedFilesModal
          isOpen={showFailedModal}
          onClose={() => setShowFailedModal(false)}
          failedFiles={failedFiles}
        />
      )}
    </div>
  );
}
