// ============================================================================
// 卸载残留扫描模块
// 扫描 AppData 和 ProgramData 中已卸载软件遗留的孤立文件夹
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Package, Loader2, Trash2, FolderOpen, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDashboard } from '../../contexts/DashboardContext';
import { 
  scanUninstallLeftovers, 
  deleteLeftoverFolders,
  openInFolder,
  type LeftoverScanResult,
  type LeftoverEntry,
} from '../../api/commands';
import { formatSize } from '../../utils/format';

// ============================================================================
// 组件实现
// ============================================================================

export function LeftoversModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.leftovers;

  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<LeftoverScanResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]); // 详细错误列表
  const [showErrorDetails, setShowErrorDetails] = useState(false); // 是否显示错误详情

  // 计算选中大小
  const selectedSize = useMemo(() => {
    if (!scanResult) return 0;
    return scanResult.leftovers
      .filter(l => selectedPaths.has(l.path))
      .reduce((sum, l) => sum + l.size, 0);
  }, [scanResult, selectedPaths]);

  // 开始扫描
  const handleScan = useCallback(async () => {
    updateModuleState('leftovers', { status: 'scanning', error: null });
    setScanResult(null);
    setSelectedPaths(new Set());
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);

    try {
      const result = await scanUninstallLeftovers();
      setScanResult(result);
      
      // 默认全选
      const defaultSelected = new Set(result.leftovers.map(l => l.path));
      setSelectedPaths(defaultSelected);

      updateModuleState('leftovers', {
        status: 'done',
        fileCount: result.leftovers.length,
        totalSize: result.total_size,
      });

      setExpandedModule('leftovers');
    } catch (err) {
      console.error('卸载残留扫描失败:', err);
      updateModuleState('leftovers', { status: 'error', error: String(err) });
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
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);
    
    try {
      const paths = Array.from(selectedPaths);
      const result = await deleteLeftoverFolders(paths);

      if (result.errors.length > 0) {
        setDeleteError(`${result.errors.length} 个文件夹删除失败`);
        setDeleteErrors(result.errors); // 保存详细错误列表
      }

      // 从结果中移除已删除的项
      if (scanResult) {
        const remainingLeftovers = scanResult.leftovers.filter(
          l => !selectedPaths.has(l.path) || result.failed_paths.includes(l.path)
        );
        const newTotalSize = remainingLeftovers.reduce((sum, l) => sum + l.size, 0);
        
        setScanResult({
          ...scanResult,
          leftovers: remainingLeftovers,
          total_size: newTotalSize,
        });

        // 更新选中状态
        const newSelected = new Set(
          Array.from(selectedPaths).filter(p => result.failed_paths.includes(p))
        );
        setSelectedPaths(newSelected);

        updateModuleState('leftovers', {
          fileCount: remainingLeftovers.length,
          totalSize: newTotalSize,
        });
      }

      triggerHealthRefresh();
    } catch (err) {
      console.error('删除失败:', err);
      setDeleteError(String(err));
      setDeleteErrors([String(err)]);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [selectedPaths, scanResult, updateModuleState, triggerHealthRefresh]);

  // 切换选择
  const toggleSelect = useCallback((path: string) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    if (selectedPaths.size === scanResult.leftovers.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(scanResult.leftovers.map(l => l.path)));
    }
  }, [scanResult, selectedPaths]);

  // 获取来源显示名称
  const getSourceName = (source: LeftoverEntry['source']) => {
    switch (source) {
      case 'LocalAppData': return '本地应用数据';
      case 'RoamingAppData': return '漫游应用数据';
      case 'ProgramData': return '程序数据';
      default: return source;
    }
  };

  const isExpanded = expandedModule === 'leftovers';

  return (
    <>
      {/* 删除进度遮罩 - 使用 Portal 渲染到 body 确保覆盖全屏 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-[var(--color-warning)]/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-[var(--color-warning)] animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">正在清理卸载残留</h3>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                正在删除 {selectedPaths.size} 个文件夹，请稍候...
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-[var(--color-warning)] rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
            <p className="text-xs text-[var(--text-faint)]">请勿关闭窗口</p>
          </div>
        </div>,
        document.body
      )}

      <ModuleCard
        id="leftovers"
        title="卸载残留"
        description="扫描已卸载软件遗留的配置文件和缓存"
        icon={<Package className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'leftovers')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] border border-[var(--color-warning)]/20">
            深度
          </span>
        }
      >
        {/* 扫描结果内容 */}
        {scanResult && scanResult.leftovers.length > 0 && (
          <div className="p-5 space-y-4">
            {/* 风险提示 */}
            <div className="flex items-start gap-3 p-4 bg-[var(--color-warning)]/10 rounded-xl border border-[var(--color-warning)]/20">
              <AlertTriangle className="w-5 h-5 text-[var(--color-warning)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">深度清理提示</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  这些文件夹可能是已卸载软件的残留数据。删除前请确认您不再需要这些数据。
                </p>
              </div>
            </div>

            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleSelectAll}
                  className="text-sm text-[var(--brand-green)] hover:underline"
                >
                  {selectedPaths.size === scanResult.leftovers.length ? '取消全选' : '全选'}
                </button>
                <span className="text-sm text-[var(--text-muted)]">
                  已选 {selectedPaths.size} 项，共 {formatSize(selectedSize)}
                </span>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedPaths.size === 0 || isDeleting}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors
                  ${selectedPaths.size === 0 || isDeleting
                    ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                    : 'bg-[var(--color-danger)] text-white hover:opacity-90'
                  }
                `}
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                删除选中
              </button>
            </div>

            {/* 错误提示 */}
            {deleteError && (
              <div className="p-3 bg-[var(--color-danger)]/10 rounded-xl border border-[var(--color-danger)]/20">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--color-danger)]">{deleteError}</span>
                  {deleteErrors.length > 0 && (
                    <button
                      onClick={() => setShowErrorDetails(!showErrorDetails)}
                      className="text-xs text-[var(--color-danger)] hover:underline"
                    >
                      {showErrorDetails ? '收起详情' : '查看详情'}
                    </button>
                  )}
                </div>
                {showErrorDetails && deleteErrors.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-[var(--color-danger)]/20 space-y-1 max-h-32 overflow-auto">
                    {deleteErrors.map((err, idx) => (
                      <p key={idx} className="text-xs text-[var(--color-danger)]/80 break-all">
                        • {err}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 残留列表 */}
            <div className="space-y-2 max-h-80 overflow-auto">
              {scanResult.leftovers.map((leftover) => (
                <div
                  key={leftover.path}
                  className={`
                    flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-colors
                    ${selectedPaths.has(leftover.path)
                      ? 'bg-[var(--brand-green-10)]'
                      : 'bg-[var(--bg-main)] hover:bg-[var(--bg-hover)]'
                    }
                  `}
                  onClick={() => toggleSelect(leftover.path)}
                >
                  {/* 复选框 */}
                  <div className={`
                    w-5 h-5 rounded border-2 flex items-center justify-center shrink-0
                    ${selectedPaths.has(leftover.path)
                      ? 'bg-[var(--brand-green)] border-[var(--brand-green)]'
                      : 'border-[var(--text-faint)]'
                    }
                  `}>
                    {selectedPaths.has(leftover.path) && (
                      <CheckCircle2 className="w-3 h-3 text-white" />
                    )}
                  </div>

                  {/* 图标 */}
                  <div className="w-10 h-10 rounded-xl bg-[var(--brand-green-10)] flex items-center justify-center shrink-0">
                    <Package className="w-5 h-5 text-[var(--brand-green)]" />
                  </div>

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                      {leftover.app_name}
                    </p>
                    <p className="text-xs text-[var(--text-muted)] truncate mt-0.5" title={leftover.path}>
                      {leftover.path}
                    </p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-faint)]">
                      <span>{getSourceName(leftover.source)}</span>
                      <span>{leftover.file_count} 个文件</span>
                    </div>
                  </div>

                  {/* 大小 */}
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-[var(--text-primary)] tabular-nums">
                      {formatSize(leftover.size)}
                    </p>
                  </div>

                  {/* 打开文件夹按钮 */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openInFolder(leftover.path);
                    }}
                    className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
                    title="打开所在文件夹"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 空状态 */}
        {scanResult && scanResult.leftovers.length === 0 && (
          <div className="p-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-[var(--brand-green)] mx-auto mb-3" />
            <p className="text-sm font-medium text-[var(--text-primary)]">没有发现卸载残留</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">您的系统很干净！</p>
          </div>
        )}
      </ModuleCard>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="确认删除卸载残留"
        description={`确定要删除选中的 ${selectedPaths.size} 个文件夹吗？这将释放约 ${formatSize(selectedSize)} 空间。`}
        warning="此操作不可撤销，请确认您不再需要这些数据。"
        confirmText="删除"
        cancelText="取消"
        isDanger={true}
      />
    </>
  );
}

export default LeftoversModule;
