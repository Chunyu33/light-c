// ============================================================================
// 扫描结果摘要组件 - 支持主题切换
// ============================================================================

import { useState, useRef, useEffect } from 'react';
import { FileSearch, Clock, Trash2, CheckCircle2, X, AlertTriangle } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ScanResult, DeleteResult, DeleteError } from '../types';
import { formatSize, formatDuration } from '../utils/format';

interface ScanSummaryProps {
  scanResult: ScanResult | null;
  deleteResult: DeleteResult | null;
  selectedCount: number;
  selectedSize: number;
  onClearDeleteResult?: () => void;
}

// 失败明细弹窗组件
function FailedFilesModal({ 
  isOpen, 
  onClose, 
  failedFiles 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  failedFiles: DeleteError[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  
  const virtualizer = useVirtualizer({
    count: failedFiles.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
      requestAnimationFrame(() => {
        setIsVisible(true);
      });
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setIsAnimating(false);
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0'}`}>
      {/* 遮罩层 */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* 弹窗 */}
      <div className={`relative bg-[var(--bg-elevated)] rounded-xl shadow-2xl border border-[var(--border-default)] w-[600px] max-w-[90vw] max-h-[80vh] flex flex-col overflow-hidden transition-all duration-200 ${isVisible ? 'scale-100 opacity-100' : 'scale-95 opacity-0'}`}>
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-[var(--fg-primary)]">
                清理失败明细
              </h3>
              <p className="text-xs text-[var(--fg-muted)]">
                共 {failedFiles.length.toLocaleString()} 个文件清理失败
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
          <span className="flex-1">文件路径</span>
          <span className="w-32 text-right">失败原因</span>
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
                  <span className="w-32 text-xs text-amber-500 text-right shrink-0">
                    {item.reason}
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
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

export function ScanSummary({
  scanResult,
  deleteResult,
  selectedCount,
  selectedSize,
  onClearDeleteResult,
}: ScanSummaryProps) {
  const [showFailedModal, setShowFailedModal] = useState(false);
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
        <div className={`rounded-lg border p-3 ${
          deleteResult.failed_count === 0
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : 'bg-amber-500/10 border-amber-500/30'
        }`}>
          <div className="flex items-center gap-3">
            <CheckCircle2 className={`w-5 h-5 shrink-0 ${
              deleteResult.failed_count === 0 ? 'text-emerald-500' : 'text-amber-500'
            }`} />
            <div className="flex-1">
              <span className={`text-sm font-medium ${
                deleteResult.failed_count === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
              }`}>
                {deleteResult.failed_count === 0 ? '清理完成！' : '清理完成（部分失败）'}
              </span>
              <span className="text-xs text-[var(--fg-muted)] ml-3">
                删除 {deleteResult.success_count} 个文件，释放 <span className="text-emerald-500 font-medium">{formatSize(deleteResult.freed_size)}</span>
                {deleteResult.failed_count > 0 && (
                  <>，<span className="text-red-500 font-medium">{deleteResult.failed_count}</span> 个失败</>
                )}
              </span>
            </div>
            {/* 关闭按钮 */}
            {onClearDeleteResult && (
              <button
                onClick={onClearDeleteResult}
                className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors shrink-0"
                title="关闭"
              >
                <X className="w-4 h-4 text-[var(--fg-muted)]" />
              </button>
            )}
          </div>
          
          {/* 失败原因详情 */}
          {deleteResult.failed_files && deleteResult.failed_files.length > 0 && (
            <div className="mt-3 pt-3 border-t border-amber-500/20">
              <p className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-2">
                失败原因：
              </p>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {deleteResult.failed_files.slice(0, 10).map((item, index) => (
                  <div key={index} className="text-xs text-[var(--fg-muted)] flex gap-2">
                    <span className="text-amber-500 shrink-0">•</span>
                    <span className="truncate flex-1" title={item.path}>
                      {item.path.split('\\').pop()}
                    </span>
                    <span className="text-amber-500 shrink-0">
                      {item.reason}
                    </span>
                  </div>
                ))}
                {deleteResult.failed_files.length > 10 && (
                  <button
                    onClick={() => setShowFailedModal(true)}
                    className="text-xs text-amber-500 hover:text-amber-400 underline underline-offset-2 cursor-pointer transition-colors"
                  >
                    ...还有 {deleteResult.failed_files.length - 10} 个失败项，点击查看全部
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 失败明细弹窗 */}
      {deleteResult?.failed_files && (
        <FailedFilesModal
          isOpen={showFailedModal}
          onClose={() => setShowFailedModal(false)}
          failedFiles={deleteResult.failed_files}
        />
      )}
    </div>
  );
}
