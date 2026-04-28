// ============================================================================
// 注册表残留扫描模块
//
// 扫描 HKCR\Applications 中被卸载程序遗留的文件关联引用。
// 每条输出均满足铁证条件（关联文件不存在 + 非系统路径 + 非系统进程），
// 默认全选，一键删除。
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Database, Loader2, Trash2, CheckCircle2, Shield } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDashboard } from '../../contexts/DashboardContext';
import {
  scanRegistryRedundancy,
  deleteRegistryEntries,
  openRegistryBackupDir,
  recordCleanupAction,
  type RegistryScanResult,
  type RegistryEntry,
  type CleanupLogEntryInput,
} from '../../api/commands';

// ============================================================================
// 主组件
// ============================================================================

export function RegistryModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.registry;

  const lastScanTriggerRef = useRef(0);

  const [scanResult, setScanResult] = useState<RegistryScanResult | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [backupPath, setBackupPath] = useState<string | null>(null);

  const selectedCount = selectedEntries.size;

  const handleScan = useCallback(async () => {
    updateModuleState('registry', { status: 'scanning', error: null });
    setScanResult(null);
    setSelectedEntries(new Set());
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);
    setBackupPath(null);

    try {
      const result = await scanRegistryRedundancy();
      setScanResult(result);

      // 所有条目都已通过铁证条件，默认全选
      setSelectedEntries(new Set(result.entries.map(e => `${e.path}|${e.name}`)));

      updateModuleState('registry', {
        status: 'done',
        fileCount: result.total_count,
        totalSize: 0,
      });

      setExpandedModule('registry');
    } catch (err) {
      console.error('注册表扫描失败:', err);
      updateModuleState('registry', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  // 一键扫描触发
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  const handleDelete = useCallback(async () => {
    if (selectedEntries.size === 0 || !scanResult) return;

    setIsDeleting(true);
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);

    try {
      const entriesToDelete = scanResult.entries.filter(
        e => selectedEntries.has(`${e.path}|${e.name}`)
      );

      const result = await deleteRegistryEntries(entriesToDelete);
      setBackupPath(result.backup_path);

      // 清理日志
      const failedSet = new Set(result.failed_entries);
      const logEntries: CleanupLogEntryInput[] = entriesToDelete.map((entry, index) => {
        const errorMsg = index < result.errors.length ? result.errors[index] : undefined;
        return {
          category: '注册表冗余',
          path: `${entry.path}\\${entry.name}`,
          size: 0,
          success: !failedSet.has(entry.path),
          error_message: failedSet.has(entry.path) ? errorMsg : undefined,
        };
      });
      recordCleanupAction(logEntries).catch((err) => {
        console.warn('记录清理日志失败:', err);
      });

      if (result.errors.length > 0) {
        setDeleteError(`${result.errors.length} 个条目删除失败`);
        setDeleteErrors(result.errors);
      }

      const remainingEntries = scanResult.entries.filter(
        e => !selectedEntries.has(`${e.path}|${e.name}`) || failedSet.has(e.path)
      );

      setScanResult({
        ...scanResult,
        entries: remainingEntries,
        total_count: remainingEntries.length,
      });

      const newSelected = new Set(
        Array.from(selectedEntries).filter(key => {
          const path = key.split('|').slice(0, -1).join('|');
          return failedSet.has(path);
        })
      );
      setSelectedEntries(newSelected);

      updateModuleState('registry', { fileCount: remainingEntries.length });
      triggerHealthRefresh();
    } catch (err) {
      console.error('删除失败:', err);
      setDeleteError(String(err));
      setDeleteErrors([String(err)]);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [selectedEntries, scanResult, updateModuleState, triggerHealthRefresh]);

  const toggleSelect = useCallback((entry: RegistryEntry) => {
    const key = `${entry.path}|${entry.name}`;
    setSelectedEntries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    if (selectedEntries.size === scanResult.entries.length) {
      setSelectedEntries(new Set());
    } else {
      setSelectedEntries(new Set(scanResult.entries.map(e => `${e.path}|${e.name}`)));
    }
  }, [scanResult, selectedEntries]);

  const isExpanded = expandedModule === 'registry';

  return (
    <>
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">正在清理注册表</h3>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                正在删除 {selectedCount} 个注册表条目，已创建备份文件...
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
          </div>
        </div>,
        document.body
      )}

      <ModuleCard
        id="registry"
        title="注册表冗余"
        description="检测已卸载程序遗留的孤立注册表引用"
        icon={<Database className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={0}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'registry')}
        onScan={handleScan}
        error={moduleState.error}
      >
        {scanResult && scanResult.entries.length > 0 && (
          <div className="p-5 space-y-4">
            {/* 安全提示 */}
            <div className="flex items-start justify-between gap-3 p-4 bg-emerald-500/5 rounded-xl border border-emerald-500/15">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">铁证过滤 · 真实备份</p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    所有条目已通过安全验证（关联文件不存在、非系统路径、非系统进程）。删除前创建完整备份，可双击 .reg 文件恢复。
                  </p>
                </div>
              </div>
              <button
                onClick={() => openRegistryBackupDir()}
                className="shrink-0 px-3 py-1.5 text-xs font-medium text-emerald-600 bg-white/50 hover:bg-white/80 rounded-lg border border-emerald-500/15 transition-colors"
              >
                打开备份目录
              </button>
            </div>

            {backupPath && (
              <div className="flex items-center justify-between p-3 bg-[var(--bg-main)] rounded-xl">
                <span className="text-xs text-[var(--text-muted)]">
                  备份已保存到: {backupPath}
                </span>
                <button
                  onClick={() => openRegistryBackupDir()}
                  className="text-xs text-emerald-600 hover:underline"
                >
                  打开目录
                </button>
              </div>
            )}

            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={toggleSelectAll} className="text-sm text-[var(--brand-green)] hover:underline">
                  {selectedEntries.size === scanResult.entries.length ? '取消全选' : '全选'}
                </button>
                <span className="text-sm text-[var(--text-muted)]">
                  已选 {selectedCount} / {scanResult.entries.length} 项
                </span>
              </div>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedCount === 0 || isDeleting}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  selectedCount === 0 || isDeleting
                    ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                    : 'bg-red-500 text-white hover:bg-red-600'
                }`}
              >
                {isDeleting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                删除选中
              </button>
            </div>

            {deleteError && (
              <div className="p-3 bg-red-500/10 rounded-xl border border-red-500/20">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-red-500">{deleteError}</span>
                  {deleteErrors.length > 0 && (
                    <button
                      onClick={() => setShowErrorDetails(!showErrorDetails)}
                      className="text-xs text-red-500 hover:underline"
                    >
                      {showErrorDetails ? '收起详情' : '查看详情'}
                    </button>
                  )}
                </div>
                {showErrorDetails && deleteErrors.length > 0 && (
                  <div className="mt-2 pt-2 border-t border-red-500/20 space-y-1 max-h-32 overflow-auto">
                    {deleteErrors.map((err, idx) => (
                      <p key={idx} className="text-xs text-red-500/80 break-all">{err}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 条目列表 */}
            <div className="space-y-2">
              {scanResult.entries.map((entry) => {
                const key = `${entry.path}|${entry.name}`;
                const isSelected = selectedEntries.has(key);

                return (
                  <div
                    key={key}
                    className={`p-4 rounded-xl transition-colors ${
                      isSelected
                        ? 'bg-emerald-500/5 cursor-pointer'
                        : 'bg-[var(--bg-main)] hover:bg-[var(--bg-hover)] cursor-pointer'
                    }`}
                    onClick={() => toggleSelect(entry)}
                  >
                    <div className="flex items-center gap-3">
                      {/* 复选框 */}
                      <div
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                          isSelected
                            ? 'bg-emerald-500 border-emerald-500'
                            : 'border-[var(--text-faint)]'
                        }`}
                      >
                        {isSelected && (
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>

                      {/* 信息 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{entry.name}</p>
                        </div>
                        <p className="text-xs text-[var(--text-muted)] truncate mt-0.5" title={entry.path}>
                          {entry.path}
                        </p>
                        <p className="text-xs text-[var(--text-faint)] mt-1">{entry.issue}</p>
                        <p className="text-[10px] text-[var(--text-faint)] mt-0.5 truncate">
                          {entry.associated_path}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {scanResult && scanResult.entries.length === 0 && (
          <div className="p-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
            <p className="text-sm font-medium text-[var(--text-primary)]">没有发现注册表冗余</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">您的注册表很干净！</p>
          </div>
        )}
      </ModuleCard>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="确认删除注册表条目"
        description={`确定要删除选中的 ${selectedCount} 个注册表条目吗？所有条目已通过安全验证。`}
        warning="删除前已使用 reg.exe export 创建完整备份文件，您可以通过双击 .reg 文件恢复。"
        confirmText="删除"
        cancelText="取消"
        isDanger={true}
      />
    </>
  );
}

export default RegistryModule;
