// ============================================================================
// 注册表残留扫描模块
//
// 扫描 HKCR\Applications 中被卸载程序遗留的文件关联引用。
// 每条输出均满足铁证条件（关联文件不存在 + 非系统路径 + 非系统进程），
// 默认全选，一键删除。
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Database, Loader2, Trash2, CheckCircle2, Shield } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  scanRegistryRedundancy,
  deleteRegistryEntries,
  openRegistryBackupDir,
  recordCleanupAction,
  type RegistryScanResult,
  type RegistryEntry,
  type CleanupLogEntryInput,
} from '../../api/commands';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// ============================================================================
// 主组件
// ============================================================================

export function RegistryModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useModuleDashboard('registry');

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
        setDeleteError(`${result.errors.length} ${t('files')} ${t('errorState')}`);
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

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !isDeleting && !showDeleteConfirm) {
    return null;
  }

  return (
    <>
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">{moduleT('registry.cleaning')}</h3>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                {moduleT('registry.cleaningDesc', { count: selectedCount })}
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
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        id="registry"
        title={navT('registry')}
        description={navT('registryDesc')}
        icon={<Database className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={0}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'registry')}
        onScan={handleScan}
        error={moduleState.error}
      >
        {moduleState.status === 'idle' && !scanResult && (
          <div className="p-5">
            <EmptyState
              icon={Database}
              title={t('notScannedRegistry')}
              description={moduleT('registry.idleDesc')}
            />
          </div>
        )}

        {moduleState.status === 'scanning' && !scanResult && (
          <div className="p-5">
            {/* 注册表扫描没有文件列表进度，补充可理解的阶段提示，减少扫描期间的空白感。 */}
            <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]/80 p-5 shadow-sm">
              <div className="flex flex-col items-center text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--brand-green)]/10">
                  <Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />
                </div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">{t('scanningShort')}</p>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-[var(--text-muted)]">
                  {moduleT('registry.idleDesc')}
                </p>
              </div>

              {/* <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: '读取注册表引用', detail: '定位孤立应用关联', icon: Database },
                  { label: '验证关联文件', detail: '确认目标文件缺失', icon: CheckCircle2 },
                  { label: '过滤系统路径', detail: '跳过系统关键条目', icon: Shield },
                  { label: '准备安全备份', detail: '清理前生成可恢复备份', icon: Shield },
                ].map((step) => {
                  const StepIcon = step.icon;
                  return (
                    <div
                      key={step.label}
                      className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)]/70 p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand-green)]/10">
                          <StepIcon className="h-4 w-4 text-[var(--brand-green)]" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-[var(--text-primary)]">{step.label}</p>
                          <p className="truncate text-[11px] text-[var(--text-muted)]">{step.detail}</p>
                        </div>
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                        <div className="h-full w-2/3 animate-pulse rounded-full bg-[var(--brand-green)]/70" />
                      </div>
                    </div>
                  );
                })}
              </div> */}
            </div>
          </div>
        )}

        {scanResult && scanResult.entries.length > 0 && (
          <div className="p-5 space-y-4">
            {/* 安全提示 */}
            <div className="flex items-start justify-between gap-3 p-4 bg-emerald-500/5 rounded-xl border border-emerald-500/15">
              <div className="flex items-start gap-3">
                <Shield className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">{moduleT('registry.result')}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    {t('registryDeleteWarning')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => openRegistryBackupDir()}
                className="shrink-0 px-3 py-1.5 text-xs font-medium text-emerald-600 bg-white/50 hover:bg-white/80 rounded-lg border border-emerald-500/15 transition-colors"
              >
                {t('open')}
              </button>
            </div>

            {backupPath && (
              <div className="flex items-center justify-between p-3 bg-[var(--bg-main)] rounded-xl">
                <span className="text-xs text-[var(--text-muted)]">
                  {moduleT('registry.backup')}: {backupPath}
                </span>
                <button
                  onClick={() => openRegistryBackupDir()}
                  className="text-xs text-emerald-600 hover:underline"
                >
                  {t('open')}
                </button>
              </div>
            )}

            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={toggleSelectAll} className="text-sm text-[var(--brand-green)] hover:underline">
                  {selectedEntries.size === scanResult.entries.length ? t('deselectAll') : t('selectAll')}
                </button>
                <span className="text-sm text-[var(--text-muted)]">
                  {moduleT('registry.selected', { count: selectedCount })} / {scanResult.entries.length}
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
                {moduleT('registry.deleteSelected')}
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
                      {showErrorDetails ? t('close') : t('viewDetails')}
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
          <div className="p-5">
            <EmptyState
              icon={CheckCircle2}
                title={t('noRegistryRedundancy')}
              description={moduleT('registry.noResult')}
              tone="success"
            />
          </div>
        )}
      </ModuleCard>

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('confirmDeleteRegistry')}
        description={moduleT('registry.confirmDesc', { count: selectedCount })}
        warning={t('registryDeleteWarning')}
        confirmText={t('delete')}
        cancelText={t('cancel')}
        isDanger={true}
      />
    </>
  );
}

export default RegistryModule;
