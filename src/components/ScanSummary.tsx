// ============================================================================
// 扫描结果摘要组件 - 支持主题切换
// 支持增强删除结果显示（物理大小、跳过原因、重启待删除）
// ============================================================================

import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { FileSearch, Clock, Trash2, CheckCircle2, X, AlertTriangle, RefreshCw } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ScanResult } from '../types';
import type { EnhancedDeleteResult, FileDeleteResult } from '../api/commands';
import { getFailureReasonMessage, getFailureReasonTooltip } from '../api/commands';
import { formatSize, formatDuration } from '../utils/format';
import { useTranslation } from 'react-i18next';

interface ScanSummaryProps {
  scanResult: ScanResult | null;
  deleteResult: EnhancedDeleteResult | null;
  selectedCount: number;
  selectedSize: number;
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
          transition={{ duration: 0.18 }}
        >
          {/* 遮罩层 */}
          <motion.div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
          
          {/* 弹窗 */}
          <motion.div
            className="relative bg-[var(--bg-elevated)] rounded-xl shadow-2xl border border-[var(--border-default)] w-[600px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden"
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
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
            <div className="flex items-center px-5 py-2 border-b border-[var(--border-default)] bg-[var(--bg-card)] text-xs font-medium text-[var(--fg-muted)] shrink-0">
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
            <div className="flex items-center justify-end px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-card)] shrink-0">
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
}: ScanSummaryProps) {
  const { t } = useTranslation('common');
  const [showFailedModal, setShowFailedModal] = useState(false);
  
  // 待重启条目也是本次删除尝试的结果，必须保留在明细中供用户核对。
  const failedFiles = deleteResult?.file_results.filter(f => !f.success) || [];

  // 清理完成后 scanResult 会被清空；此时若仍有删除结果，单独展示结果卡，
  // 扫描统计（发现/可清理/已选/耗时）仅在存在扫描数据时渲染。
  if (!scanResult && !deleteResult) return null;

  return (
    <div className="space-y-3">
      {/* 统计卡片（仅扫描数据存在时显示） */}
      {scanResult && (
        <div className="grid grid-cols-4 gap-3">
        {/* 发现文件 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <FileSearch className="w-4 h-4 text-emerald-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('filesFound')}</span>
          </div>
          <p className="text-lg font-bold text-[var(--fg-primary)] tabular-nums">
            {scanResult.total_file_count.toLocaleString()}
          </p>
        </div>

        {/* 可清理 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <Trash2 className="w-4 h-4 text-orange-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('cleanable')}</span>
          </div>
          <p className="text-lg font-bold text-orange-500 tabular-nums">
            {formatSize(scanResult.total_size)}
          </p>
        </div>

        {/* 已选中 */}
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
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
        <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-default)] p-3">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-4 h-4 text-teal-500" />
            <span className="text-xs text-[var(--fg-muted)]">{t('scanDuration')}</span>
          </div>
          <p className="text-lg font-bold text-[var(--fg-primary)] tabular-nums">
            {formatDuration(scanResult.scan_duration_ms)}
          </p>
        </div>
      </div>
      )}

      {/* 删除结果提示 - 成功色主题，主体表达"成功释放"语义；
          未完成的记录（失败/待重启）仅在各自明细区使用警告色/蓝色 */}
      {deleteResult && (
        <div
          className="flex flex-col rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-5"
          style={scanResult ? undefined : { minHeight: '65vh' }}
        >
          {/* 主信息区：清理完成后（无扫描数据）撑满卡片居中展示，避免底部留白 */}
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-7 h-7 text-emerald-500" />
            </div>
            <span className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
              {deleteResult.summary_message || t('cleanCompleted')}
            </span>
            {/* 详细统计 */}
            <div className="text-sm text-[var(--fg-muted)]">
              {t('deleteStats', { success: deleteResult.success_count, size: formatSize(deleteResult.freed_physical_size) })}
              {deleteResult.skipped_size > 0 && (
                <>{t('skippedSize', { size: formatSize(deleteResult.skipped_size) })}</>
              )}
              {deleteResult.reboot_pending_count > 0 && (
                <>{t('rebootPending', { count: deleteResult.reboot_pending_count })}</>
              )}
            </div>
          </div>

          {/* 需要重启提示（待完成记录，使用蓝色区分） */}
          {deleteResult.needs_reboot && (
            <div className="mt-4 pt-4 border-t border-blue-500/20 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-blue-500" />
              <span className="text-xs text-blue-500">
                {t('rebootPendingDesc')}
              </span>
            </div>
          )}

          {/* 失败原因详情：默认折叠为一行聚合提示，点击展开明细，
              避免冗长的系统错误（如 os error 5）逐条铺满结果卡打扰用户 */}
          {failedFiles.length > 0 && (
            <div className="mt-4 pt-4 border-t border-amber-500/20">
              <button
                onClick={() => setShowFailedModal(true)}
                className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 hover:text-amber-500 transition-colors"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>{t('incompleteSummary', { count: failedFiles.length })}</span>
              </button>
            </div>
          )}
        </div>
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
