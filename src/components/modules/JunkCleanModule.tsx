// ============================================================================
// 垃圾清理模块组件
// 在仪表盘中展示垃圾文件扫描和清理功能
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Loader2 } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { CategoryCard } from '../CategoryCard';
import { ScanSummary } from '../ScanSummary';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import { scanJunkFiles, enhancedDeleteFiles, recordCleanupAction, type EnhancedDeleteResult, type CleanupLogEntryInput } from '../../api/commands';
import { formatSize } from '../../utils/format';
import type { ScanResult, FileInfo } from '../../types';

// ============================================================================
// 组件实现
// ============================================================================

export function JunkCleanModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.junk;
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [deleteResult, setDeleteResult] = useState<EnhancedDeleteResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // 计算选中文件大小
  const selectedSize = useMemo(() => {
    if (!scanResult) return 0;
    let total = 0;
    for (const category of scanResult.categories) {
      for (const f of category.files) {
        if (selectedPaths.has(f.path)) {
          total += f.size;
        }
      }
    }
    return total;
  }, [scanResult, selectedPaths]);

  // 开始扫描
  const handleScan = useCallback(async () => {
    updateModuleState('junk', { status: 'scanning', error: null });
    setScanResult(null);
    setDeleteResult(null);
    setSelectedPaths(new Set());

    try {
      const result = await scanJunkFiles();
      setScanResult(result);
      
      // 默认选中风险等级 <= 2 的文件
      const defaultSelected = new Set<string>();
      result.categories.forEach((category) => {
        if (category.risk_level <= 2) {
          category.files.forEach((file) => {
            defaultSelected.add(file.path);
          });
        }
      });
      setSelectedPaths(defaultSelected);

      updateModuleState('junk', {
        status: 'done',
        fileCount: result.total_file_count,
        totalSize: result.total_size,
      });

      // 自动展开模块
      setExpandedModule('junk');
    } catch (err) {
      console.error('扫描失败:', err);
      updateModuleState('junk', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 执行删除
  const handleDelete = useCallback(async () => {
    if (selectedPaths.size === 0) return;

    setIsDeleting(true);
    try {
      const paths = Array.from(selectedPaths);
      const result = await enhancedDeleteFiles(paths);
      setDeleteResult(result);

      // 记录清理日志（所有操作都记录，包括成功和失败）
      if (result.file_results.length > 0) {
        const logEntries: CleanupLogEntryInput[] = result.file_results.map((f) => ({
          category: '垃圾清理',
          path: f.path,
          size: f.physical_size,
          success: f.success,
          error_message: f.failure_reason ? JSON.stringify(f.failure_reason) : undefined,
        }));
        // 异步记录日志，不阻塞 UI
        recordCleanupAction(logEntries).catch((err) => {
          console.warn('记录清理日志失败:', err);
          showToast({
            type: 'warning',
            title: '清理完成，但日志记录失败',
            description: String(err),
          });
        });
      }

      if (result.success_count > 0) {
        const blockedText = result.failed_count > 0
          ? `，${result.failed_count} 个文件因占用或权限问题跳过`
          : '';
        const rebootText = result.reboot_pending_count > 0
          ? `，${result.reboot_pending_count} 个文件将在重启后删除`
          : '';
        showToast({
          type: result.failed_count > 0 || result.reboot_pending_count > 0 ? 'warning' : 'success',
          title: '垃圾清理完成',
          description: `${result.summary_message || `成功释放 ${formatSize(result.freed_physical_size)}`}${blockedText}${rebootText}`,
        });
      } else if (result.failed_count > 0 || result.reboot_pending_count > 0) {
        const firstFailure = result.file_results.find((f) => !f.success && !f.marked_for_reboot);
        showToast({
          type: 'warning',
          title: '清理受阻',
          description: firstFailure
            ? `部分文件未能删除：${firstFailure.path}`
            : result.summary_message || '部分文件将在重启后删除',
        });
      } else {
        showToast({
          type: 'info',
          title: '没有文件被清理',
          description: result.summary_message || '所选文件未发生变化',
        });
      }

      // 从扫描结果中移除已删除的文件
      if (scanResult && result.success_count > 0) {
        // 获取成功删除的路径（不包括失败和标记重启的）
        const deletedPaths = new Set(
          result.file_results
            .filter((f) => f.success)
            .map((f) => f.path)
        );

        const updatedCategories = scanResult.categories.map((category) => {
          const remainingFiles = category.files.filter((f) => !deletedPaths.has(f.path));
          return {
            ...category,
            files: remainingFiles,
            file_count: remainingFiles.length,
            total_size: remainingFiles.reduce((sum, f) => sum + f.size, 0),
          };
        });

        const newResult = {
          ...scanResult,
          categories: updatedCategories,
          total_file_count: updatedCategories.reduce((acc, c) => acc + c.file_count, 0),
          total_size: updatedCategories.reduce((acc, c) => acc + c.total_size, 0),
        };

        setScanResult(newResult);
        updateModuleState('junk', {
          fileCount: newResult.total_file_count,
          totalSize: newResult.total_size,
        });

        // 清除已删除文件的选中状态
        setSelectedPaths((prev) => {
          const newSet = new Set(prev);
          deletedPaths.forEach((p) => newSet.delete(p));
          return newSet;
        });

        // 触发健康评分刷新
        triggerHealthRefresh();
      }
    } catch (err) {
      console.error('删除失败:', err);
      showToast({ type: 'error', title: '垃圾清理失败', description: String(err) });
    } finally {
      setIsDeleting(false);
    }
  }, [selectedPaths, scanResult, updateModuleState, triggerHealthRefresh, showToast]);

  // 切换文件选中状态
  const toggleFileSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  }, []);

  // 切换分类选中状态
  const toggleCategorySelection = useCallback((files: FileInfo[], selected: boolean) => {
    setSelectedPaths((prev) => {
      const newSet = new Set(prev);
      files.forEach((file) => {
        if (selected) {
          newSet.add(file.path);
        } else {
          newSet.delete(file.path);
        }
      });
      return newSet;
    });
  }, []);

  // 全选/取消全选
  const toggleAllSelection = useCallback((selected: boolean) => {
    if (!scanResult) return;
    if (selected) {
      const allPaths = new Set<string>();
      scanResult.categories.forEach((category) => {
        category.files.forEach((file) => {
          allPaths.add(file.path);
        });
      });
      setSelectedPaths(allPaths);
    } else {
      setSelectedPaths(new Set());
    }
  }, [scanResult]);

  const isExpanded = expandedModule === 'junk';

  return (
    <>
      {/* 删除进度遮罩 - 使用 Portal 渲染到 body 确保覆盖全屏 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-rose-500 animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--fg-primary)]">正在清理垃圾文件</h3>
              <p className="text-sm text-[var(--fg-muted)] mt-1">
                正在删除 {selectedPaths.size} 个文件，请稍候...
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-rose-500 rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
            <p className="text-xs text-[var(--fg-faint)]">请勿关闭窗口</p>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认清理"
        description={`您即将删除 ${selectedPaths.size.toLocaleString()} 个文件，预计释放 ${formatSize(selectedSize)} 空间。此操作不可撤销。`}
        warning="免责声明：本软件仅清理常见的系统垃圾文件，但不对任何数据丢失承担责任。请确保您已了解所选文件的内容，重要数据请提前备份。"
        confirmText="确认清理"
        cancelText="取消"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isDanger
      />

      <ModuleCard
        id="junk"
        title="垃圾清理"
        description="清理系统缓存、临时文件、日志等垃圾文件"
        icon={<Trash2 className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'junk')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          scanResult && scanResult.total_file_count > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleAllSelection(true)}
                className="text-xs text-[var(--fg-muted)] hover:text-emerald-600 transition"
              >
                全选
              </button>
              <button
                onClick={() => toggleAllSelection(false)}
                className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] transition"
              >
                取消
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedPaths.size === 0}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                  ${selectedPaths.size === 0
                    ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                    : 'bg-rose-500 text-white hover:bg-rose-600'
                  }
                `}
              >
                <Trash2 className="w-3.5 h-3.5" />
                清理 ({selectedPaths.size})
              </button>
            </div>
          )
        }
      >
        {/* 展开内容 */}
        <div className="p-4 space-y-3">
          {/* 扫描结果摘要 */}
          {scanResult && (
            <ScanSummary
              scanResult={scanResult}
              deleteResult={deleteResult}
              selectedCount={selectedPaths.size}
              selectedSize={selectedSize}
              onClearDeleteResult={() => setDeleteResult(null)}
            />
          )}

          {/* 分类列表 */}
          {scanResult ? (
            <div className="space-y-2">
              {scanResult.categories
                .filter((c) => c.files.length > 0)
                .sort((a, b) => b.total_size - a.total_size)
                .map((category) => (
                  <CategoryCard
                    key={category.display_name}
                    category={category}
                    selectedPaths={selectedPaths}
                    onToggleFile={toggleFileSelection}
                    onToggleCategory={toggleCategorySelection}
                  />
                ))}

              {scanResult.categories.every((c) => c.files.length === 0) && (
                <div className="text-center py-8 bg-[var(--bg-base)] rounded-lg">
                  <p className="text-[var(--fg-muted)] text-sm">🎉 太棒了！没有发现可清理的垃圾文件</p>
                </div>
              )}
            </div>
          ) : moduleState.status === 'idle' ? (
            <EmptyState />
          ) : null}
        </div>
      </ModuleCard>
    </>
  );
}

export default JunkCleanModule;
