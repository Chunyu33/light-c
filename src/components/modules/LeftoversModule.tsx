// ============================================================================
// 卸载残留扫描模块（支持模拟器、残留驱动深度检测）
// 扫描 AppData 和 ProgramData 中已卸载软件遗留的孤立文件夹
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Package, Loader2, Trash2, FolderOpen, AlertTriangle, CheckCircle2, Smartphone, HardDrive, ChevronDown, ChevronUp, XCircle, ShieldCheck, ShieldPlus } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ModuleScanProgress } from '../ModuleScanProgress';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { LeftoverWhitelistModal } from './LeftoverWhitelistModal';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  scanUninstallLeftovers,
  deleteLeftoverFolders,
  deleteLeftoversPermanent,
  addLeftoverWhitelistEntry,
  listLeftoverWhitelist,
  removeLeftoverWhitelistEntry,
  openInFolder,
  recordCleanupAction,
  type LeftoverScanResult,
  type LeftoverEntry,
  type PermanentDeleteResult,
  type CleanupLogEntryInput,
  type LeftoverWhitelistEntry,
  getSafetyCheckMessage,
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// ============================================================================
// 组件实现
// ============================================================================

/**
 * 统一路径比较口径。
 *
 * 中文说明：扫描结果与白名单返回的路径可能只差大小写或正反斜杠，用原始字符串比较会漏匹配，
 * 导致"已经加进白名单的条目仍然留在当前结果里"，与后端的大小写不敏感比较也不一致。
 */
function normalizePathForCompare(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isSamePath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

export function LeftoversModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useModuleDashboard('leftovers');
  const { showToast } = useToast();

  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<LeftoverScanResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]); // 详细错误列表
  const [showErrorDetails, setShowErrorDetails] = useState(false); // 是否显示错误详情

  // 深度清理（永久删除）相关状态
  const [showDeepCleanWarning, setShowDeepCleanWarning] = useState(false); // 首次深度清理警告
  const [showDeepCleanConfirm, setShowDeepCleanConfirm] = useState(false); // 深度清理确认
  const [deepCleanResult, setDeepCleanResult] = useState<PermanentDeleteResult | null>(null); // 深度清理结果
  const [showDeepCleanResult, setShowDeepCleanResult] = useState(false); // 显示深度清理结果
  const [whitelistEntries, setWhitelistEntries] = useState<LeftoverWhitelistEntry[]>([]);
  const [showWhitelistManager, setShowWhitelistManager] = useState(false);
  const [whitelistCandidate, setWhitelistCandidate] = useState<LeftoverEntry | null>(null);
  const [isUpdatingWhitelist, setIsUpdatingWhitelist] = useState(false);
  const [whitelistError, setWhitelistError] = useState<string | null>(null);

  // 动画状态 - 删除进度遮罩
  const [isDeletingVisible, setIsDeletingVisible] = useState(false);
  const [isDeletingAnimating, setIsDeletingAnimating] = useState(false);
  const deletingEnteredRef = useRef(false);
  if (isDeletingVisible) deletingEnteredRef.current = true;
  useEffect(() => {
    if (isDeleting) {
      setIsDeletingAnimating(true);
      setIsDeletingVisible(true);
    } else {
      setIsDeletingVisible(false);
      const timer = setTimeout(() => setIsDeletingAnimating(false), 200);
      return () => clearTimeout(timer);
    }
  }, [isDeleting]);

  // 动画状态 - 深度清理警告弹窗
  const [isWarningVisible, setIsWarningVisible] = useState(false);
  const [isWarningAnimating, setIsWarningAnimating] = useState(false);
  const warningEnteredRef = useRef(false);
  if (isWarningVisible) warningEnteredRef.current = true;
  useEffect(() => {
    if (showDeepCleanWarning) {
      setIsWarningAnimating(true);
      setIsWarningVisible(true);
    } else {
      setIsWarningVisible(false);
      const timer = setTimeout(() => setIsWarningAnimating(false), 200);
      return () => clearTimeout(timer);
    }
  }, [showDeepCleanWarning]);

  // 动画状态 - 深度清理结果弹窗
  const [isResultVisible, setIsResultVisible] = useState(false);
  const [isResultAnimating, setIsResultAnimating] = useState(false);
  const resultEnteredRef = useRef(false);
  if (isResultVisible) resultEnteredRef.current = true;
  useEffect(() => {
    if (showDeepCleanResult && deepCleanResult) {
      setIsResultAnimating(true);
      setIsResultVisible(true);
    } else {
      setIsResultVisible(false);
      const timer = setTimeout(() => setIsResultAnimating(false), 200);
      return () => clearTimeout(timer);
    }
  }, [showDeepCleanResult, deepCleanResult]);

  // 计算选中大小
  const selectedSize = useMemo(() => {
    if (!scanResult) return 0;
    return scanResult.leftovers
      .filter(l => selectedPaths.has(l.path))
      .reduce((sum, l) => sum + l.size, 0);
  }, [scanResult, selectedPaths]);

  const loadWhitelist = useCallback(async () => {
    try {
      const entries = await listLeftoverWhitelist();
      setWhitelistEntries(entries);
      setWhitelistError(null);
    } catch (error) {
      // 白名单是删除安全边界的一部分，加载失败时明确提示，避免用户误以为保护已生效。
      setWhitelistError(String(error));
    }
  }, []);

  useEffect(() => {
    void loadWhitelist();
  }, [loadWhitelist]);

  const handleAddToWhitelist = useCallback(async () => {
    if (!whitelistCandidate) return;

    setIsUpdatingWhitelist(true);
    try {
      const entry = await addLeftoverWhitelistEntry(whitelistCandidate.path);
      setWhitelistEntries((entries) => {
        const withoutDuplicate = entries.filter((item) => item.path.toLowerCase() !== entry.path.toLowerCase());
        return [...withoutDuplicate, entry];
      });

      // 立即移除当前结果，避免用户在同一次扫描中继续误删已保护路径。
      // 路径比较必须与后端同口径（忽略大小写与斜杠），否则保护成功但列表里还在。
      setScanResult((result) => {
        if (!result) return result;
        const leftovers = result.leftovers.filter((item) => !isSamePath(item.path, whitelistCandidate.path));
        const totalSize = leftovers.reduce((sum, item) => sum + item.size, 0);
        updateModuleState('leftovers', { fileCount: leftovers.length, totalSize });
        return { ...result, leftovers, total_size: totalSize };
      });
      setSelectedPaths((paths) => {
        const next = new Set(paths);
        for (const selected of paths) {
          if (isSamePath(selected, whitelistCandidate.path)) next.delete(selected);
        }
        return next;
      });
      setWhitelistCandidate(null);
      setWhitelistError(null);
    } catch (error) {
      /*
        添加失败必须让用户看到：此前只写入 whitelistError，而该文案仅在白名单管理弹窗里展示，
        确认框照常关闭，用户会以为保护已生效。这里改为弹提示并重新拉取列表。
      */
      const message = String(error);
      setWhitelistError(message);
      showToast({
        type: 'error',
        title: moduleT('leftovers.addToWhitelistFailed'),
        description: message,
      });
    } finally {
      setIsUpdatingWhitelist(false);
    }
  }, [moduleT, showToast, updateModuleState, whitelistCandidate]);

  const handleRemoveWhitelist = useCallback(async (path: string) => {
    setIsUpdatingWhitelist(true);
    try {
      await removeLeftoverWhitelistEntry(path);
      setWhitelistEntries((entries) => entries.filter((entry) => !isSamePath(entry.path, path)));
      setWhitelistError(null);
    } catch (error) {
      setWhitelistError(String(error));
      // 删除失败时重新拉取，避免界面显示"已移除"而文件里仍然保留。
      await loadWhitelist();
    } finally {
      setIsUpdatingWhitelist(false);
    }
  }, [loadWhitelist]);

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

      // 卸载残留属于事后推断，即使高置信也可能误伤仍在使用的数据，因此首版结果全部交给用户主动确认。
      setSelectedPaths(new Set());

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

      // 记录清理日志（所有操作都记录）
      const failedPathSet = new Set(result.failed_paths || []);
      const logEntries: CleanupLogEntryInput[] = paths.map((path) => {
        const entry = scanResult?.leftovers.find((l) => l.path === path);
        const errorIndex = result.failed_paths?.indexOf(path);
        return {
          category: '卸载残留',
          path,
          size: entry?.size || 0,
          success: !failedPathSet.has(path),
          error_message: errorIndex !== undefined && errorIndex >= 0 ? result.errors[errorIndex] : undefined,
        };
      });
      recordCleanupAction(logEntries).catch((err) => {
        console.warn('记录清理日志失败:', err);
      });

      if (result.errors.length > 0) {
        const skippedMsg = result.skipped_executables?.length
          ? moduleT('leftoversExtra.skippedExecutables', { count: result.skipped_executables.length })
          : '';
        setDeleteError(moduleT('leftoversExtra.deleteErrorSummary', { count: result.errors.length, skipped: skippedMsg }));
        setDeleteErrors(result.errors);
      }

      // 从结果中移除已删除的项（保留失败和因可执行文件跳过的项）
      if (scanResult) {
        const skippedSet = new Set(result.skipped_executables || []);
        const remainingLeftovers = scanResult.leftovers.filter(
          l => !selectedPaths.has(l.path)
            || result.failed_paths.includes(l.path)
            || skippedSet.has(l.path)
        );
        const newTotalSize = remainingLeftovers.reduce((sum, l) => sum + l.size, 0);

        setScanResult({
          ...scanResult,
          leftovers: remainingLeftovers,
          total_size: newTotalSize,
        });

        // 更新选中状态（仅保留未成功删除的项）
        const newSelected = new Set(
          Array.from(selectedPaths).filter(
            p => result.failed_paths.includes(p) || skippedSet.has(p)
          )
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
  }, [selectedPaths, scanResult, updateModuleState, triggerHealthRefresh, moduleT]);

  // 深度清理（永久删除）- 首次点击显示警告
  const handleDeepCleanClick = useCallback(() => {
    if (selectedPaths.size === 0) return;
    // 首次深度清理显示警告弹窗
    setShowDeepCleanWarning(true);
  }, [selectedPaths]);

  // 确认深度清理警告后显示最终确认
  const handleDeepCleanWarningConfirm = useCallback(() => {
    setShowDeepCleanWarning(false);
    setShowDeepCleanConfirm(true);
  }, []);

  // 执行深度清理（永久删除）
  const handleDeepClean = useCallback(async () => {
    if (selectedPaths.size === 0) return;

    setIsDeleting(true);
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);
    setShowDeepCleanConfirm(false);

    try {
      const paths = Array.from(selectedPaths);
      const result = await deleteLeftoversPermanent(paths);

      setDeepCleanResult(result);
      setShowDeepCleanResult(true);

      // 从结果中移除已删除的项
      if (scanResult) {
        const deletedPaths = new Set(
          result.details
            .filter(d => d.success)
            .map(d => d.path)
        );

        const remainingLeftovers = scanResult.leftovers.filter(
          l => !deletedPaths.has(l.path)
        );
        const newTotalSize = remainingLeftovers.reduce((sum, l) => sum + l.size, 0);

        setScanResult({
          ...scanResult,
          leftovers: remainingLeftovers,
          total_size: newTotalSize,
        });

        // 更新选中状态 - 只保留未成功删除的
        const newSelected = new Set(
          Array.from(selectedPaths).filter(p => !deletedPaths.has(p))
        );
        setSelectedPaths(newSelected);

        updateModuleState('leftovers', {
          fileCount: remainingLeftovers.length,
          totalSize: newTotalSize,
        });
      }

      // 显示错误信息
      if (result.failed_count > 0 || result.manual_review_count > 0) {
        const errorMessages: string[] = [];
        result.details.forEach(d => {
          if (!d.success && d.failure_reason) {
            errorMessages.push(`${d.path}: ${d.failure_reason}`);
          }
          if (d.needs_manual_review) {
            errorMessages.push(`${d.path}: ${getSafetyCheckMessage(d.safety_check)}`);
          }
        });
        if (errorMessages.length > 0) {
          setDeleteErrors(errorMessages);
        }
      }

      triggerHealthRefresh();
    } catch (err) {
      console.error('深度清理失败:', err);
      setDeleteError(String(err));
      setDeleteErrors([String(err)]);
    } finally {
      setIsDeleting(false);
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

  // 选择全部可疑项
  const selectAllSuspicious = useCallback(() => {
    if (!scanResult) return;
    const suspicious = new Set(
      scanResult.leftovers
        .filter(l => l.detection_category === 'Suspicious')
        .map(l => l.path)
    );
    setSelectedPaths(suspicious);
  }, [scanResult]);

  // 获取来源显示名称
  const getSourceName = (source: LeftoverEntry['source']) => {
    switch (source) {
      case 'LocalAppData': return moduleT('leftovers.source.local');
      case 'RoamingAppData': return moduleT('leftovers.source.roaming');
      case 'LocalLowAppData': return moduleT('leftovers.source.localLow');
      case 'ProgramData': return moduleT('leftovers.source.programData');
      case 'VirtualDiskFile': return moduleT('leftovers.source.virtualDisk');
      default: return source;
    }
  };

  // 统计模拟器和虚拟磁盘残留数量
  const emulatorCount = useMemo(() => {
    if (!scanResult) return 0;
    return scanResult.leftovers.filter(l => l.is_emulator).length;
  }, [scanResult]);

  const virtualDiskCount = useMemo(() => {
    if (!scanResult) return 0;
    return scanResult.leftovers.filter(l => l.is_virtual_disk).length;
  }, [scanResult]);

  // 统计各置信度级别数量
  const highConfidenceCount = useMemo(() => {
    if (!scanResult) return 0;
    return scanResult.leftovers.filter(l => l.detection_category === 'HighConfidenceLeftover').length;
  }, [scanResult]);

  const suspiciousCount = useMemo(() => {
    if (!scanResult) return 0;
    return scanResult.leftovers.filter(l => l.detection_category === 'Suspicious').length;
  }, [scanResult]);

  // 置信度分类标签
  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'HighConfidenceLeftover': return moduleT('leftovers.category.high_confidence');
      case 'Suspicious': return moduleT('leftovers.category.suspicious');
      case 'LikelyAppData': return moduleT('leftovers.category.possibly_in_use');
      case 'SystemShared': return moduleT('leftovers.category.system_shared');
      default: return category;
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'HighConfidenceLeftover': return 'text-[var(--color-danger)] bg-[var(--color-danger)]/10';
      case 'Suspicious': return 'text-[var(--color-warning)] bg-[var(--color-warning)]/10';
      case 'LikelyAppData': return 'text-[var(--brand-green)] bg-[var(--brand-green-10)]';
      case 'SystemShared': return 'text-[var(--text-muted)] bg-[var(--bg-hover)]';
      default: return 'text-[var(--text-muted)] bg-[var(--bg-hover)]';
    }
  };

  const isExpanded = expandedModule === 'leftovers';

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !isDeletingAnimating) {
    return null;
  }

  return (
    <>
      {/* 删除进度遮罩 - 使用 Portal 渲染到 body 确保覆盖全屏 */}
      {isDeletingAnimating && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className={`absolute inset-0 bg-black/50 backdrop-blur-sm ${isDeletingVisible ? 'modal-overlay-in' : deletingEnteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`} />
          {/* 尺寸用 em 跟随全局字号，20em 的上限对应原来的 max-w-sm */}
          <div className={`relative bg-[var(--bg-card)] rounded-2xl p-[2.29em] shadow-2xl flex flex-col items-center gap-[1.14em] max-w-[20em] mx-[1em] ${isDeletingVisible ? 'modal-content-in' : deletingEnteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
            <div className="w-[4.57em] h-[4.57em] rounded-full bg-[var(--color-warning)]/10 flex items-center justify-center">
              <Loader2 className="w-[2.29em] h-[2.29em] text-[var(--color-warning)] animate-spin" />
            </div>
            <div className="text-center">
        <h3 className="text-[1.29em] font-semibold text-[var(--text-primary)]">{moduleT('leftovers.deleting')}</h3>
              <p className="text-[1em] text-[var(--text-muted)] mt-[0.29em]">
                {moduleT('leftovers.deletingFolder')} ({selectedPaths.size})...
              </p>
            </div>
            <div className="w-full h-[0.57em] bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-[var(--color-warning)] rounded-full animate-pulse" style={{ width: '100%' }} />
            </div>
            <p className="text-[0.86em] text-[var(--text-faint)]">{moduleT('leftovers.doNotClose')}</p>
          </div>
        </div>,
        document.body
      )}

      <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        id="leftovers"
        title={navT('leftovers')}
        description={navT('leftoversDesc')}
        icon={<Package className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'leftovers')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <button
            onClick={() => {
              setShowWhitelistManager(true);
              void loadWhitelist();
            }}
            className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
            title={moduleT('leftovers.whitelistManage')}
          >
            <ShieldCheck className="w-4 h-4" />
          </button>
        }
      >
        {moduleState.status === 'idle' && !scanResult && (
          <div className="p-5">
            <EmptyState
              icon={Package}
              title={t('notScannedLeftovers')}
              description={moduleT('leftovers.idleDesc')}
            />
          </div>
        )}

        {moduleState.status === 'scanning' && !scanResult && (
          <div className="p-5">
            <ModuleScanProgress
              title={moduleT('leftovers.scanning')}
              description={moduleT('leftovers.scanningDesc')}
              icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
            />
          </div>
        )}

        {/* 扫描结果内容 */}
        {scanResult && scanResult.leftovers.length > 0 && (
          <div className="p-5 space-y-4">
            {/* 风险提示 + 置信度统计 */}
            <div className="flex items-start gap-3 p-4 bg-[var(--color-warning)]/10 rounded-xl border border-[var(--color-warning)]/20">
              <AlertTriangle className="w-5 h-5 text-[var(--color-warning)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{moduleT('leftovers.confidenceTitle')}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {moduleT('leftovers.confidenceDesc')}
                  {highConfidenceCount > 0 && <span className="text-[var(--color-danger)] font-medium">{moduleT('leftovers.highConfidence', { count: highConfidenceCount })}</span>}
                  {highConfidenceCount > 0 && suspiciousCount > 0 && ' · '}
                  {suspiciousCount > 0 && <span className="text-[var(--color-warning)] font-medium">{moduleT('leftovers.suspicious', { count: suspiciousCount })}</span>}
                  {` ${moduleT('leftovers.accuracy')}`}
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
                  {selectedPaths.size === scanResult.leftovers.length ? t('deselectAll') : t('selectAll')}
                </button>
                {suspiciousCount > 0 && (
                  <button
                    onClick={selectAllSuspicious}
                    className="text-sm text-[var(--color-warning)] hover:underline"
                  >
                    {moduleT('leftovers.selectSuspicious')}
                  </button>
                )}
                <span className="text-sm text-[var(--text-muted)]">
                  {moduleT('leftovers.selected', { count: selectedPaths.size, size: formatSize(selectedSize) })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* 普通删除按钮 */}
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={selectedPaths.size === 0 || isDeleting}
                  className={`
                      flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors
                    ${selectedPaths.size === 0 || isDeleting
                      ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                      : 'bg-[var(--color-warning)] text-white hover:opacity-90'
                    }
                  `}
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  {moduleT('leftovers.deleteSelected')}
                </button>
                {/* 深度清理按钮 */}
                <button
                  onClick={handleDeepCleanClick}
                  disabled={selectedPaths.size === 0 || isDeleting}
                  className={`
                      flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors
                    ${selectedPaths.size === 0 || isDeleting
                      ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                      : 'bg-[var(--color-danger)] text-white hover:opacity-90'
                    }
                  `}
                title={t('permanentDeleteWarning')}
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  {moduleT('leftovers.deepClean')}
                </button>
              </div>
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
                      {showErrorDetails ? moduleT('leftovers.collapseDetails') : moduleT('leftovers.viewDetails')}
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

            {/* 模拟器/虚拟磁盘残留提示 */}
            {(emulatorCount > 0 || virtualDiskCount > 0) && (
              <div className="flex items-start gap-3 p-4 bg-[var(--color-danger)]/10 rounded-xl border border-[var(--color-danger)]/20">
                <Smartphone className="w-5 h-5 text-[var(--color-danger)] shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">{moduleT('leftovers.emulatorTitle')}</p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    {moduleT('leftovers.emulatorDesc', {
                      emulator: emulatorCount > 0 ? moduleT('leftovers.emulatorItem', { count: emulatorCount }) : '',
                      separator: emulatorCount > 0 && virtualDiskCount > 0 ? '、' : '',
                      virtualDisk: virtualDiskCount > 0 ? moduleT('leftovers.virtualDiskItem', { count: virtualDiskCount }) : '',
                    })}
                  </p>
                </div>
              </div>
            )}

            {/* 残留列表 */}
            <div className="space-y-2">
              {scanResult.leftovers.map((leftover) => (
                <div
                  key={leftover.path}
                  className={`
                    flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-colors
                    ${leftover.is_emulator || leftover.is_virtual_disk
                      ? 'border-2 border-[var(--color-danger)]/30'
                      : ''
                    }
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
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  {/* 图标 - 根据类型显示不同图标 */}
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${leftover.is_emulator
                      ? 'bg-[var(--color-danger)]/10'
                      : leftover.is_virtual_disk
                        ? 'bg-purple-500/10'
                        : 'bg-[var(--brand-green-10)]'
                    }`}>
                    {leftover.is_emulator ? (
                      <Smartphone className="w-5 h-5 text-[var(--color-danger)]" />
                    ) : leftover.is_virtual_disk ? (
                      <HardDrive className="w-5 h-5 text-purple-500" />
                    ) : (
                      <Package className="w-5 h-5 text-[var(--brand-green)]" />
                    )}
                  </div>

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {leftover.app_name}
                      </p>
                      {/* 置信度分类标签 */}
                      <span className={`flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${getCategoryColor(leftover.detection_category)}`}>
                        {getCategoryLabel(leftover.detection_category)}
                      </span>
                      {/* 模拟器/虚拟磁盘标签 */}
                      {leftover.is_emulator && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded text-[var(--color-danger)] bg-[var(--color-danger)]/10">
                          {moduleT('leftovers.emulatorTag')}
                        </span>
                      )}
                      {leftover.is_virtual_disk && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded text-purple-500 bg-purple-500/10">
                          {moduleT('leftovers.virtualDiskTag')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] truncate mt-0.5" title={leftover.path}>
                      {leftover.path}
                    </p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-[var(--text-faint)]">
                      <span>{getSourceName(leftover.source)}</span>
                      <span>{leftover.file_count} {moduleT('leftovers.files')}</span>
                      <span title={leftover.reasons.join('\n')}>{moduleT('leftovers.confidence', { percent: Math.round(leftover.confidence * 100) })}</span>
                    </div>
                  </div>

                  {/* 大小 - 大文件高亮 */}
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-bold tabular-nums ${leftover.size > 1024 * 1024 * 1024
                        ? 'text-[var(--color-danger)]'
                        : leftover.size > 100 * 1024 * 1024
                          ? 'text-[var(--color-warning)]'
                          : 'text-[var(--text-primary)]'
                      }`}>
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
              title={t('openInFolder')}
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setWhitelistCandidate(leftover);
                    }}
                    className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
                    title={moduleT('leftovers.addToWhitelist')}
                  >
                    <ShieldPlus className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 空状态 */}
        {scanResult && scanResult.leftovers.length === 0 && (
          <div className="p-5">
            <EmptyState
              icon={CheckCircle2}
              title={t('noLeftovers')}
              description={moduleT('leftovers.noResultDesc')}
              tone="success"
            />
          </div>
        )}
      </ModuleCard>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('confirmDeleteLeftovers')}
        description={moduleT('leftovers.confirmDesc', { count: selectedPaths.size, size: formatSize(selectedSize) })}
        warning={t('leftoversDeleteWarning')}
        confirmText={t('delete')}
        cancelText={t('cancel')}
        isDanger={true}
      />

      <ConfirmDialog
        isOpen={whitelistCandidate !== null}
        onCancel={() => setWhitelistCandidate(null)}
        onConfirm={handleAddToWhitelist}
        title={moduleT('leftovers.addToWhitelist')}
        description={moduleT('leftovers.whitelistConfirmDesc', { path: whitelistCandidate?.path ?? '' })}
        warning={moduleT('leftovers.whitelistConfirmWarning')}
        confirmText={moduleT('leftovers.addToWhitelist')}
        cancelText={t('cancel')}
      />

      {/* 白名单管理弹窗自身用 AnimatePresence 处理进出场，因此这里始终挂载、由 isOpen 控制 */}
      <LeftoverWhitelistModal
        isOpen={showWhitelistManager}
        entries={whitelistEntries}
        error={whitelistError}
        isUpdating={isUpdatingWhitelist}
        onClose={() => setShowWhitelistManager(false)}
        onOpen={openInFolder}
        onRemove={handleRemoveWhitelist}
        t={moduleT}
        commonT={t}
      />

      {/* 深度清理警告弹窗 - 微信风格 */}
      {isWarningAnimating && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className={`absolute inset-0 bg-black/50 backdrop-blur-sm ${isWarningVisible ? 'modal-overlay-in' : warningEnteredRef.current ? 'modal-overlay-out' : 'opacity-0'}`} onClick={() => setShowDeepCleanWarning(false)} />
          {/* 尺寸用 em 跟随全局字号，25em 的上限对应原来的 max-w-md */}
          <div className={`relative bg-[var(--bg-card)] rounded-2xl p-[1.43em] shadow-2xl max-w-[25em] mx-[1em] ${isWarningVisible ? 'modal-content-in' : warningEnteredRef.current ? 'modal-content-out' : 'opacity-0'}`}>
            {/* 警告图标 */}
            <div className="flex justify-center mb-[1.14em]">
              <div className="w-[4.57em] h-[4.57em] rounded-full bg-[var(--color-danger)]/10 flex items-center justify-center">
                <AlertTriangle className="w-[2.29em] h-[2.29em] text-[var(--color-danger)]" />
              </div>
            </div>

            {/* 标题 */}
            <h3 className="text-[1.29em] font-bold text-[var(--text-primary)] text-center mb-[0.86em]">
              {moduleT('leftovers.deepWarningTitle')}
            </h3>

            {/* 内容 */}
            <div className="space-y-[0.86em] mb-[1.71em]">
              <p className="text-[1em] text-[var(--text-secondary)] text-center">
                {moduleT('leftovers.deepWarningDesc')}
              </p>
              <div className="bg-[var(--color-warning)]/10 rounded-xl p-[1.14em] border border-[var(--color-warning)]/20">
                <p className="text-[0.86em] text-[var(--text-muted)]">
                  <span className="font-semibold text-[var(--color-warning)]">{moduleT('leftovers.safetyTitle')}</span>
                  {moduleT('leftovers.safetyDesc')}
                </p>
              </div>
            </div>

            {/* 按钮 */}
            <div className="flex gap-[0.86em]">
              <button
                onClick={() => setShowDeepCleanWarning(false)}
                className="flex-1 px-[1.14em] py-[0.86em] rounded-xl text-[1em] font-medium bg-[var(--bg-hover)] text-[var(--text-primary)] hover:bg-[var(--bg-main)] transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleDeepCleanWarningConfirm}
                className="flex-1 px-[1.14em] py-[0.86em] rounded-xl text-[1em] font-medium bg-[var(--color-danger)] text-white hover:opacity-90 transition-colors"
              >
                {moduleT('leftovers.understood')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 深度清理最终确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeepCleanConfirm}
        onCancel={() => setShowDeepCleanConfirm(false)}
        onConfirm={handleDeepClean}
        title={t('confirmPermanentCleanup')}
        description={moduleT('leftovers.confirmDesc', { count: selectedPaths.size, size: formatSize(selectedSize) })}
        warning={t('permanentCleanupWarning')}
        confirmText={t('permanentDelete')}
        cancelText={t('cancel')}
        isDanger={true}
      />

      {/* 深度清理结果弹窗 */}
      {isResultAnimating && deepCleanResult && createPortal(
        <DeepCleanResultModal
          result={deepCleanResult}
          isVisible={isResultVisible}
          hasEntered={resultEnteredRef.current}
          onClose={() => setShowDeepCleanResult(false)}
        />,
        document.body
      )}
    </>
  );
}

export default LeftoversModule;

// ============================================================================
// 深度清理结果弹窗组件
// ============================================================================

interface DeepCleanResultModalProps {
  result: PermanentDeleteResult;
  isVisible: boolean;
  hasEntered: boolean;
  onClose: () => void;
}

function DeepCleanResultModal({ result, isVisible, hasEntered, onClose }: DeepCleanResultModalProps) {
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const [expandedSection, setExpandedSection] = useState<'review' | 'failed' | null>(null);

  // 获取需要审核的项目
  const reviewItems = result.details.filter(d => d.needs_manual_review);
  // 获取失败的项目
  const failedItems = result.details.filter(d => !d.success && !d.needs_manual_review && !d.marked_for_reboot);

  // 获取失败原因的友好描述
  const getFailureReason = (detail: typeof result.details[0]): string => {
    if (detail.failure_reason) {
      // 简化常见错误信息
      if (detail.failure_reason.includes('拒绝访问') || detail.failure_reason.includes('Access is denied')) {
        return moduleT('leftoversExtra.permissionDenied');
      }
      if (detail.failure_reason.includes('正由另一个进程使用') || detail.failure_reason.includes('being used')) {
        return moduleT('leftoversExtra.fileLocked');
      }
      if (detail.failure_reason.includes('找不到') || detail.failure_reason.includes('not find')) {
        return moduleT('leftoversExtra.fileMissing');
      }
      return detail.failure_reason;
    }
    return getSafetyCheckMessage(detail.safety_check);
  };

  // 获取文件夹名称
  const getFolderName = (path: string): string => {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm ${isVisible ? 'modal-overlay-in' : hasEntered ? 'modal-overlay-out' : 'opacity-0'}`}
        onClick={onClose}
      />
      {/* 尺寸统一用 em：body 继承 :root 字号，弹窗随全局字号设置缩放，30em ≈ 420px。
          高度叠加视口约束：只写 57.14em 时窗口高度低于 832px 就会上下溢出，头部与底栏被切掉。 */}
      <div className={`relative bg-[var(--bg-card)] rounded-2xl p-[1.43em] shadow-2xl w-[30em] max-h-[min(57.14em,calc(100vh_-_2em))] overflow-hidden flex flex-col mx-[1em] ${isVisible ? 'modal-content-in' : hasEntered ? 'modal-content-out' : 'opacity-0'}`}>
        {/* 结果图标 */}
        <div className="flex justify-center mb-[1.14em]">
          <div className={`w-[4.57em] h-[4.57em] rounded-full flex items-center justify-center ${result.success_count > 0
              ? 'bg-[var(--brand-green)]/10'
              : 'bg-[var(--color-danger)]/10'
            }`}>
            {result.success_count > 0 ? (
              <CheckCircle2 className="w-[2.29em] h-[2.29em] text-[var(--brand-green)]" />
            ) : (
              <AlertTriangle className="w-[2.29em] h-[2.29em] text-[var(--color-danger)]" />
            )}
          </div>
        </div>

        {/* 标题 */}
        <h3 className="text-[1.29em] font-bold text-[var(--text-primary)] text-center mb-[1.14em]">
          {moduleT('leftovers.completed')}
        </h3>

        {/* 统计信息 - 可滚动区域 */}
        <div className="flex-1 overflow-auto space-y-[0.86em] mb-[1.14em]">
          {/* 成功删除 */}
          {result.success_count > 0 && (
            <div className="flex items-center justify-between p-[0.86em] bg-[var(--brand-green)]/10 rounded-xl">
              <span className="text-[1em] text-[var(--text-secondary)]">{moduleT('leftovers.successDeleted')}</span>
              <span className="text-[1em] font-bold text-[var(--brand-green)]">
                {moduleT('leftoversExtra.successSummary', { count: result.success_count, size: formatSize(result.freed_size) })}
              </span>
            </div>
          )}

          {/* 需要人工审核 - 可展开 */}
          {reviewItems.length > 0 && (
            <div className="bg-[var(--color-warning)]/10 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedSection(expandedSection === 'review' ? null : 'review')}
                className="w-full flex items-center justify-between p-[0.86em] hover:bg-[var(--color-warning)]/5 transition-colors"
              >
                <span className="text-[1em] text-[var(--text-secondary)]">{moduleT('leftovers.manualReview')}</span>
                <div className="flex items-center gap-[0.57em]">
                  <span className="text-[1em] font-bold text-[var(--color-warning)]">
                    {moduleT('leftoversExtra.count', { count: reviewItems.length })}
                  </span>
                  {expandedSection === 'review' ? (
                    <ChevronUp className="w-[1.14em] h-[1.14em] text-[var(--color-warning)]" />
                  ) : (
                    <ChevronDown className="w-[1.14em] h-[1.14em] text-[var(--color-warning)]" />
                  )}
                </div>
              </button>
              {expandedSection === 'review' && (
                <div className="px-[0.86em] pb-[0.86em] space-y-[0.57em]">
                  <p className="text-[0.86em] text-[var(--text-muted)] mb-[0.57em]">
                    {moduleT('leftovers.manualReviewDesc')}
                  </p>
                  {reviewItems.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-[0.57em] p-[0.57em] bg-[var(--bg-card)] rounded-lg">
                      <div className="flex-1 min-w-0">
                        <p className="text-[0.86em] font-medium text-[var(--text-primary)] truncate" title={item.path}>
                          {getFolderName(item.path)}
                        </p>
                        <p className="text-[0.71em] text-[var(--text-muted)] truncate" title={item.path}>
                          {item.path}
                        </p>
                      </div>
                      <button
                        onClick={() => openInFolder(item.path)}
                        className="shrink-0 p-[0.43em] rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
                    title={t('openInFolder')}
                      >
                        <FolderOpen className="w-[1.14em] h-[1.14em]" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 待重启删除 */}
          {result.reboot_pending_count > 0 && (
            <div className="flex items-center justify-between p-[0.86em] bg-[var(--color-info)]/10 rounded-xl">
              <span className="text-[1em] text-[var(--text-secondary)]">{moduleT('leftovers.pendingReboot')}</span>
              <span className="text-[1em] font-bold text-[var(--color-info)]">
                {moduleT('leftoversExtra.count', { count: result.reboot_pending_count })}
              </span>
            </div>
          )}

          {/* 删除失败 - 可展开 */}
          {failedItems.length > 0 && (
            <div className="bg-[var(--color-danger)]/10 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpandedSection(expandedSection === 'failed' ? null : 'failed')}
                className="w-full flex items-center justify-between p-[0.86em] hover:bg-[var(--color-danger)]/5 transition-colors"
              >
                <span className="text-[1em] text-[var(--text-secondary)]">{moduleT('leftovers.deleteFailed')}</span>
                <div className="flex items-center gap-[0.57em]">
                  <span className="text-[1em] font-bold text-[var(--color-danger)]">
                    {moduleT('leftoversExtra.count', { count: failedItems.length })}
                  </span>
                  {expandedSection === 'failed' ? (
                    <ChevronUp className="w-[1.14em] h-[1.14em] text-[var(--color-danger)]" />
                  ) : (
                    <ChevronDown className="w-[1.14em] h-[1.14em] text-[var(--color-danger)]" />
                  )}
                </div>
              </button>
              {expandedSection === 'failed' && (
                <div className="px-[0.86em] pb-[0.86em] space-y-[0.57em]">
                  {failedItems.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-[0.57em] p-[0.57em] bg-[var(--bg-card)] rounded-lg">
                      <XCircle className="w-[1.14em] h-[1.14em] text-[var(--color-danger)] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[0.86em] font-medium text-[var(--text-primary)] truncate" title={item.path}>
                          {getFolderName(item.path)}
                        </p>
                        <p className="text-[0.71em] text-[var(--color-danger)]">
                          {getFailureReason(item)}
                        </p>
                      </div>
                      <button
                        onClick={() => openInFolder(item.path)}
                        className="shrink-0 p-[0.43em] rounded-lg text-[var(--text-muted)] hover:text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
                    title={t('openInFolder')}
                      >
                        <FolderOpen className="w-[1.14em] h-[1.14em]" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          className="w-full px-[1.14em] py-[0.86em] rounded-xl text-[1em] font-medium bg-[var(--brand-green)] text-white hover:opacity-90 transition-colors shrink-0"
        >
          {moduleT('leftoversExtra.confirm')}
        </button>
      </div>
    </div>
  );
}
