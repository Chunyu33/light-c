// ============================================================================
// 垃圾清理模块组件
// 在仪表盘中展示垃圾文件扫描和清理功能
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import i18n from '../../i18n';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Database,
  FileSearch,
  HardDrive,
  Loader2,
  ShieldCheck,
  StopCircle,
  Timer,
  Trash2,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { CategoryCard } from '../CategoryCard';
import { ScanSummary } from '../ScanSummary';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  cancelDeepJunkScan,
  deleteDeepJunkFiles,
  enhancedDeleteFiles,
  getDeepJunkCategoryPage,
  recordCleanupAction,
  scanDeepJunkFiles,
  scanJunkFiles,
  type CleanupLogEntryInput,
  type EnhancedDeleteResult,
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { openSearchUrl } from '../../utils/searchEngine';
import type {
  CategoryScanResult,
  DeepJunkScanProgress,
  DeepJunkScanResult,
  EnhancedDeleteProgress,
  FileInfo,
  ScanResult,
} from '../../types';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

const DEEP_SCAN_STORAGE_KEY = 'lightc.junkClean.deepScan';

function loadDeepScanPreference(): boolean {
  try {
    return JSON.parse(localStorage.getItem(DEEP_SCAN_STORAGE_KEY) ?? 'false') === true;
  } catch {
    // 旧版本或手工修改 localStorage 时回退到快速模式，避免阻断模块加载。
    return false;
  }
}

function mergeDeepCategoryPage(result: ScanResult, page: CategoryScanResult): ScanResult {
  return {
    ...result,
    categories: result.categories.map((category) => (
      category.display_name === page.display_name
        ? {
          ...category,
          files: [...category.files, ...page.files],
          has_more: page.has_more,
        }
        : category
    )),
  };
}

/**
 * 深度扫描只返回分类首屏；当前页全部选中且仍有后续页时，删除应覆盖完整分类。
 * 这样用户看到分类总量时，不会因为分页而只清理首屏几百 MB。
 */
const DEEP_SCAN_STAGES = ['discover', 'mft', 'path', 'filter', 'metadata', 'result', 'summary'];

function getScanStageLabel(stage: string, isDeep: boolean): string {
  if (!isDeep) return i18n.t('scanStages.quick', { ns: 'junkClean' });
  switch (stage) {
    case 'discover': return i18n.t('scanStages.discover', { ns: 'junkClean' });
    case 'mft': return i18n.t('scanStages.mft', { ns: 'junkClean' });
    case 'path': return i18n.t('scanStages.path', { ns: 'junkClean' });
    case 'filter': return i18n.t('scanStages.filter', { ns: 'junkClean' });
    case 'metadata': return i18n.t('scanStages.metadata', { ns: 'junkClean' });
    case 'result': return i18n.t('scanStages.result', { ns: 'junkClean' });
    case 'summary': return i18n.t('scanStages.summary', { ns: 'junkClean' });
    default: return i18n.t('scanStages.default', { ns: 'junkClean' });
  }
}

function getScanStageIndex(stage: string): number {
  const index = DEEP_SCAN_STAGES.indexOf(stage);
  return index < 0 ? 0 : index;
}

function formatScanDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return i18n.t('seconds', { ns: 'common', count: seconds });
  return i18n.t('minutes', { ns: 'common', min: Math.floor(seconds / 60), sec: seconds % 60 });
}

function getDeletePhaseLabel(phase: EnhancedDeleteProgress['phase']): string {
  return i18n.t(`deleteProgress.${phase === 'preparing' ? 'preparing' : 'cleaning'}`, { ns: 'junkClean' });
}

function formatDeleteSpeed(progress: EnhancedDeleteProgress | null): string {
  if (!progress || progress.elapsed_ms < 1000 || progress.processed_count === 0) return i18n.t('calculating', { ns: 'common' });
  const filesPerSecond = progress.processed_count / (progress.elapsed_ms / 1000);
  return i18n.t('filesPerSecond', { ns: 'common', count: filesPerSecond.toFixed(0) });
}

function getDeleteRemainingTime(progress: EnhancedDeleteProgress | null): string {
  if (!progress || progress.processed_count === 0 || progress.total_count <= progress.processed_count) {
    return progress?.processed_count === progress?.total_count
      ? i18n.t('almostDone', { ns: 'common' })
      : i18n.t('calculating', { ns: 'common' });
  }
  const remainingCount = progress.total_count - progress.processed_count;
  const remainingMilliseconds = (progress.elapsed_ms / progress.processed_count) * remainingCount;
  return i18n.t('estimatedRemaining', { ns: 'common', time: formatScanDuration(remainingMilliseconds) });
}

// ============================================================================
// 组件实现
// ============================================================================

export function JunkCleanModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t } = useTranslation('junkClean');
  const {
    moduleState,
    expandedModule,
    setExpandedModule,
    updateModuleState,
    triggerHealthRefresh,
    oneClickScanTrigger,
    stopScanTrigger,
  } = useModuleDashboard('junk');
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [deleteResult, setDeleteResult] = useState<EnhancedDeleteResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<EnhancedDeleteProgress | null>(null);
  const [deleteVerificationPending, setDeleteVerificationPending] = useState(false);
  // 深度分类首屏分页展示，但分类勾选必须保留“整类清理”的明确语义。
  const [selectedCategoryNames, setSelectedCategoryNames] = useState<Set<string>>(new Set());
  const [deepScanEnabled, setDeepScanEnabled] = useState(loadDeepScanPreference);
  const [deepScanResult, setDeepScanResult] = useState<DeepJunkScanResult | null>(null);
  const [scanProgress, setScanProgress] = useState<DeepJunkScanProgress | null>(null);
  const [scanMode, setScanMode] = useState<'quick' | 'deep' | null>(null);
  const [loadingDeepCategory, setLoadingDeepCategory] = useState<string | null>(null);
  const scanningRef = useRef(false);
  const deleteVerificationRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const scanStageIndex = scanProgress ? getScanStageIndex(scanProgress.stage) : 0;
  const scanProgressPercent = scanMode === 'deep'
    ? Math.min(96, Math.round(((scanStageIndex + 0.65) / DEEP_SCAN_STAGES.length) * 100))
    : 35;

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
      if (scanMode === 'deep' && selectedCategoryNames.has(category.display_name)) {
        // 整类选择时以分类总量为基准，再扣除当前页明确取消的条目。
        const excludedSize = category.files
          .filter((file) => !selectedPaths.has(file.path))
          .reduce((sum, file) => sum + file.size, 0);
        const selectedCategorySize = Math.max(0, category.total_size - excludedSize);
        const loadedSelectedSize = category.files
          .filter((file) => selectedPaths.has(file.path))
          .reduce((sum, file) => sum + file.size, 0);
        total += Math.max(0, selectedCategorySize - loadedSelectedSize);
      }
    }
    return total;
  }, [scanMode, scanResult, selectedCategoryNames, selectedPaths]);

  const selectedFileCount = useMemo(() => {
    if (!scanResult) return selectedPaths.size;
    let count = selectedPaths.size;
    if (scanMode === 'deep') {
      scanResult.categories.forEach((category) => {
        if (selectedCategoryNames.has(category.display_name)) {
          // selectedPaths 已包含当前页，因此这里只增加未加载的文件数。
          count += Math.max(0, category.file_count - category.files.length);
        }
      });
    }
    return count;
  }, [scanMode, scanResult, selectedCategoryNames, selectedPaths]);

  const fullySelectedDeepCategoryNames = useMemo(() => (
    scanMode === 'deep' ? Array.from(selectedCategoryNames) : []
  ), [scanMode, selectedCategoryNames]);

  const excludedDeepPaths = useMemo(() => {
    if (scanMode !== 'deep' || !scanResult) return [];
    return scanResult.categories
      .filter((category) => selectedCategoryNames.has(category.display_name))
      .flatMap((category) => category.files
        .filter((file) => !selectedPaths.has(file.path))
        .map((file) => file.path));
  }, [scanMode, scanResult, selectedCategoryNames, selectedPaths]);

  useEffect(() => {
    localStorage.setItem(DEEP_SCAN_STORAGE_KEY, JSON.stringify(deepScanEnabled));
  }, [deepScanEnabled]);

  // 深度扫描阶段通过事件推送，避免前端轮询后端状态。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listen<DeepJunkScanProgress>('junk-clean:progress', (event) => {
      if (!disposed) setScanProgress(event.payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      if (!disposed) showToast({ type: 'warning', title: t('toast.listenProgressFailed'), description: String(error) });
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [showToast, t]);

  // 删除进度只传递批量统计，避免大批量文件逐条更新前端造成额外渲染压力。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listen<EnhancedDeleteProgress>('junk-clean:delete-progress', (event) => {
      if (!disposed) setDeleteProgress(event.payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      if (!disposed) showToast({ type: 'warning', title: t('toast.listenDeleteProgressFailed'), description: String(error) });
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [showToast, t]);

  // 开始扫描
  const handleScan = useCallback(async () => {
    // 核验阶段仍在同步扫描结果，禁止并发启动新扫描覆盖即将落地的数据。
    if (scanningRef.current || deleteVerificationRef.current) return;

    scanningRef.current = true;
    cancelRequestedRef.current = false;
    const currentScanMode = deepScanEnabled ? 'deep' : 'quick';
    setScanMode(currentScanMode);
    updateModuleState('junk', { status: 'scanning', error: null });
    setScanResult(null);
    setDeepScanResult(null);
    setScanProgress(null);
    setDeleteResult(null);
    setDeleteProgress(null);
    setSelectedPaths(new Set());
    setSelectedCategoryNames(new Set());

    try {
      const result = currentScanMode === 'deep'
        ? await scanDeepJunkFiles()
        : await scanJunkFiles();
      setScanResult(result);
      if (currentScanMode === 'deep') setDeepScanResult(result as DeepJunkScanResult);
      
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
      setSelectedCategoryNames(new Set());

      updateModuleState('junk', {
        status: 'done',
        fileCount: result.total_file_count,
        totalSize: result.total_size,
      });

      // 自动展开模块
      setExpandedModule('junk');
    } catch (err) {
      if (cancelRequestedRef.current) {
        updateModuleState('junk', { status: 'idle', error: null });
      } else {
        console.error('扫描失败:', err);
        updateModuleState('junk', { status: 'error', error: String(err) });
      }
    } finally {
      scanningRef.current = false;
      setScanProgress(null);
    }
  }, [deepScanEnabled, updateModuleState, setExpandedModule]);

  const handleStopScan = useCallback(async () => {
    if (!scanningRef.current || scanMode !== 'deep') return;

    cancelRequestedRef.current = true;
    try {
      await cancelDeepJunkScan();
      showToast({ type: 'info', title: t('toast.scanStopped'), description: t('toast.scanStoppedDesc') });
    } catch (error) {
      cancelRequestedRef.current = false;
      showToast({ type: 'error', title: t('toast.stopScanFailed'), description: String(error) });
    }
  }, [scanMode, showToast, t]);

  const refreshScanResultAfterDelete = useCallback(async (
    currentScanMode: 'quick' | 'deep',
    deletedPaths: Set<string>,
  ): Promise<boolean> => {
    try {
      // 删除结果只代表删除接口的处理结果，展示状态必须以重新扫描到的真实文件为准。
      const refreshedResult = currentScanMode === 'deep'
        ? await scanDeepJunkFiles()
        : await scanJunkFiles();
      const visiblePaths = new Set(
        refreshedResult.categories.flatMap((category) => category.files.map((file) => file.path)),
      );
      setScanResult(refreshedResult);
      if (currentScanMode === 'deep') setDeepScanResult(refreshedResult as DeepJunkScanResult);
      updateModuleState('junk', {
        status: 'done',
        fileCount: refreshedResult.total_file_count,
        totalSize: refreshedResult.total_size,
        error: null,
      });
      // 失败或未处理的条目只有在重扫仍能看到时才保留选中状态。
      setSelectedPaths((previous) => new Set(
        Array.from(previous).filter((path) => visiblePaths.has(path) && !deletedPaths.has(path)),
      ));
      setSelectedCategoryNames(new Set());
      setScanProgress(null);
      triggerHealthRefresh();
      return true;
    } catch (refreshError) {
      // 删除结果仍然有效，但核验失败时不能把旧的扫描统计冒充为最新状态。
      console.warn('清理后刷新扫描失败:', refreshError);
      return false;
    }
  }, [triggerHealthRefresh, updateModuleState]);

  // 顶部全局停止按钮复用深度扫描取消命令。
  useEffect(() => {
    if (stopScanTrigger > 0 && moduleState.status === 'scanning') {
      handleStopScan();
    }
  }, [handleStopScan, moduleState.status, stopScanTrigger]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 执行删除
  const handleDelete = useCallback(async () => {
    if (selectedPaths.size === 0 && selectedCategoryNames.size === 0) return;

    // 先给出准备阶段反馈，后端展开深度分类时用户不会看到无响应的遮罩。
    setDeleteProgress({
      phase: 'preparing',
      processed_count: 0,
      total_count: selectedFileCount,
      success_count: 0,
      failed_count: 0,
      reboot_pending_count: 0,
      freed_physical_size: 0,
      elapsed_ms: 0,
    });
    setIsDeleting(true);
    try {
      const paths = Array.from(selectedPaths);
      const result = scanMode === 'deep'
        ? await deleteDeepJunkFiles(paths, {
          scanId: deepScanResult?.scan_id,
          categoryNames: fullySelectedDeepCategoryNames,
          excludedPaths: excludedDeepPaths,
        })
        : await enhancedDeleteFiles(paths);

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
            title: t('toast.logFailed'),
            description: String(err),
          });
        });
      }

      // 删除命令返回后，文件操作已经完成；核验扫描改为后台执行，避免用户被长时间遮罩阻塞。
      let refreshStarted = false;
      if (result.success_count > 0 && scanMode) {
        const deletedPaths = new Set(
          result.file_results.filter((file) => file.success).map((file) => file.path),
        );
        refreshStarted = true;
        deleteVerificationRef.current = true;
        setDeleteVerificationPending(true);
        setDeleteProgress({
          phase: 'cleaning',
          processed_count: result.success_count + result.failed_count + result.reboot_pending_count,
          total_count: selectedFileCount,
          success_count: result.success_count,
          failed_count: result.failed_count,
          reboot_pending_count: result.reboot_pending_count,
          freed_physical_size: result.freed_physical_size,
          elapsed_ms: 0,
        });
        void refreshScanResultAfterDelete(scanMode, deletedPaths).then((refreshSucceeded) => {
          if (!refreshSucceeded) {
            showToast({
              type: 'warning',
              title: t('toast.refreshFailed'),
              description: t('toast.refreshFailedDesc'),
            });
          }
        }).finally(() => {
          // 核验结束后解除并发保护；失败时保留当前结果，避免用旧统计覆盖界面。
          deleteVerificationRef.current = false;
          setDeleteVerificationPending(false);
          setDeleteProgress(null);
        });
      }

      setDeleteResult(result);
      if (result.success_count > 0) {
        // 后端 summary_message 固定为中文，因此使用结构化结果在前端生成当前语言的摘要。
        const releasedText = result.freed_physical_size > 0
          ? i18n.t('freedSize', { ns: 'common', size: formatSize(result.freed_physical_size) })
          : '';
        const skippedText = result.skipped_size > 0
          ? i18n.t('skippedSize', { ns: 'common', size: formatSize(result.skipped_size) })
          : '';
        const blockedText = result.failed_count > 0
          ? t('toast.blocked', { count: result.failed_count })
          : '';
        const rebootText = result.reboot_pending_count > 0
          ? t('toast.reboot', { count: result.reboot_pending_count })
          : '';
        showToast({
          // 已经有文件成功删除时使用成功色；失败/待重启数量通过文案和明细表达，避免用户误以为整体未执行。
          type: 'success',
          title: t('toast.cleanDone'),
          description: t('toast.cleanDoneDesc', {
            summary: `${releasedText}${skippedText}`,
            blocked: blockedText,
            reboot: rebootText,
            refreshing: refreshStarted ? t('toast.refreshing') : '',
          }),
        });
      } else if (result.failed_count > 0 || result.reboot_pending_count > 0) {
        const firstFailure = result.file_results.find((f) => !f.success && !f.marked_for_reboot);
        showToast({
          type: 'warning',
          title: t('toast.cleanBlocked'),
          description: firstFailure
            ? t('toast.cleanBlockedDesc', { path: firstFailure.path })
            : t('toast.cleanBlockedReboot'),
        });
      } else {
        showToast({
          type: 'info',
          title: t('toast.noFileCleaned'),
          description: t('toast.noFileCleanedDesc'),
        });
      }

    } catch (err) {
      console.error('删除失败:', err);
      showToast({ type: 'error', title: t('toast.cleanFailed'), description: String(err) });
    } finally {
      setIsDeleting(false);
      if (!deleteVerificationRef.current) setDeleteProgress(null);
    }
  }, [deepScanResult, excludedDeepPaths, fullySelectedDeepCategoryNames, refreshScanResultAfterDelete, scanMode, selectedFileCount, selectedPaths, selectedCategoryNames, showToast, t]);

  // 垃圾文件默认使用完整路径搜索，回收站条目则搜索原始路径，避免把内部 $R 文件名交给搜索引擎。
  const handleSearchFile = useCallback(async (file: FileInfo) => {
    const searchPath = file.category === 'RecycleBin'
      ? file.original_path || file.name
      : file.path;
    try {
      await openSearchUrl(t('searchQuery', { path: searchPath }));
    } catch (error) {
      console.error('搜索文件用途失败:', error);
      showToast({ type: 'error', title: t('toast.openSearchFailed'), description: String(error) });
    }
  }, [showToast, t]);

  // 切换文件选中状态
  const toggleFileSelection = useCallback((path: string) => {
    // 后台核验会重建分类统计，期间冻结选择状态，避免用户操作被异步刷新覆盖。
    if (deleteVerificationRef.current) return;
    // 整类选择保持到删除结束，单项取消通过 excludedPaths 传给后端，避免漏删分页之外的文件。
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
  const toggleCategorySelection = useCallback((categoryName: string, files: FileInfo[], selected: boolean) => {
    // 后台核验期间不允许改变选择集合，保证核验完成后的选中状态与新结果一致。
    if (deleteVerificationRef.current) return;
    setSelectedCategoryNames((previous) => {
      const next = new Set(previous);
      if (selected) next.add(categoryName);
      else next.delete(categoryName);
      return next;
    });
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
    if (!scanResult || deleteVerificationRef.current) return;
    if (selected) {
      const allPaths = new Set<string>();
      scanResult.categories.forEach((category) => {
        category.files.forEach((file) => {
          allPaths.add(file.path);
        });
      });
      setSelectedCategoryNames(new Set(
        scanResult.categories
          .filter((category) => category.has_more)
          .map((category) => category.display_name),
      ));
      setSelectedPaths(allPaths);
    } else {
      setSelectedCategoryNames(new Set());
      setSelectedPaths(new Set());
    }
  }, [scanResult]);

  const handleDeepScanToggle = useCallback((enabled: boolean) => {
    if (scanningRef.current) return;
    setDeepScanEnabled(enabled);
    // 模式变化后旧结果不再代表当前扫描范围，必须清空以防误删上一种模式的结果。
    setScanResult(null);
    setDeepScanResult(null);
    setSelectedPaths(new Set());
    setSelectedCategoryNames(new Set());
    setDeleteResult(null);
    setScanMode(null);
    updateModuleState('junk', { status: 'idle', error: null, fileCount: 0, totalSize: 0 });
  }, [updateModuleState]);

  const handleLoadMoreDeepCategory = useCallback(async (categoryName: string) => {
    if (scanMode !== 'deep' || !deepScanResult || loadingDeepCategory || deleteVerificationRef.current) return;
    const category = scanResult?.categories.find((item) => item.display_name === categoryName);
    if (!category || !category.has_more) return;

    setLoadingDeepCategory(categoryName);
    try {
      const page = await getDeepJunkCategoryPage(
        deepScanResult.scan_id,
        categoryName,
        category.files.length,
      );
      setScanResult((previous) => previous ? mergeDeepCategoryPage(previous, page) : previous);
      setDeepScanResult((previous) => previous ? mergeDeepCategoryPage(previous, page) as DeepJunkScanResult : previous);
      if (selectedCategoryNames.has(categoryName)) {
        // 整类已选中时，后续加载的分页也必须自动加入选择，避免用户滚动加载后意外漏删。
        setSelectedPaths((previous) => {
          const next = new Set(previous);
          page.files.forEach((file) => next.add(file.path));
          return next;
        });
      }
    } catch (error) {
      showToast({ type: 'warning', title: t('toast.loadDeepPageFailed'), description: String(error) });
    } finally {
      setLoadingDeepCategory(null);
    }
  }, [deepScanResult, loadingDeepCategory, scanMode, scanResult, selectedCategoryNames, showToast]);

  const isExpanded = expandedModule === 'junk';
  const deleteTotalCount = deleteProgress?.total_count || selectedFileCount;
  const deleteProcessedCount = Math.min(deleteProgress?.processed_count ?? 0, deleteTotalCount);
  const deleteProgressPercent = deleteTotalCount > 0
    ? Math.min(100, Math.round((deleteProcessedCount / deleteTotalCount) * 100))
    : 0;

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !isDeleting && !showDeleteConfirm && !deleteVerificationPending) {
    return null;
  }

  return (
    <>
      {/* 删除进度遮罩仅覆盖实际文件操作；后续核验在页面内后台进行，避免长时间阻塞用户。 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/45 flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-rose-500 animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--fg-primary)]">
                {getDeletePhaseLabel(deleteProgress?.phase ?? 'preparing')}
              </h3>
              <p className="text-sm text-[var(--fg-muted)] mt-1">
                {t('deleteProgress.processed', { current: deleteProcessedCount.toLocaleString(), total: deleteTotalCount.toLocaleString() })}
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div
                className="h-full bg-rose-500 rounded-full transition-all duration-300"
                style={{ width: `${deleteProgressPercent}%` }}
              />
            </div>
            <div className="w-full grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
              <span>{t('deleteProgress.freed', { size: formatSize(deleteProgress?.freed_physical_size ?? 0) })}</span>
              <span className="text-right">{t('deleteProgress.failed', { count: deleteProgress?.failed_count ?? 0 })}</span>
              <span>{t('deleteProgress.speed', { speed: formatDeleteSpeed(deleteProgress) })}</span>
              <span className="text-right">{getDeleteRemainingTime(deleteProgress)}</span>
            </div>
            <p className="text-xs text-[var(--fg-faint)]">{t('deleteProgress.doNotClose')}</p>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title={t('confirmTitle')}
        description={t('confirmDesc', { count: selectedFileCount.toLocaleString(), size: formatSize(selectedSize) })}
        warning={i18n.t('disclaimer', { ns: 'common' })}
        confirmText={t('confirmTitle')}
        cancelText={i18n.t('cancel', { ns: 'common' })}
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        isDanger
      />

      <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        id="junk"
        title={t('title')}
        description={t('desc')}
        icon={<Trash2 className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'junk')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <label
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-hover)] text-xs text-[var(--fg-muted)] cursor-pointer select-none"
              title={t('deepDiscoveryTitle')}
            >
              <span>{t('deepDiscovery')}</span>
              <input
                type="checkbox"
                className="sr-only"
                checked={deepScanEnabled}
                disabled={moduleState.status === 'scanning'}
                onChange={(event) => handleDeepScanToggle(event.target.checked)}
              />
              <span className={`relative w-8 h-4 rounded-full transition-colors ${deepScanEnabled ? 'bg-[var(--brand-green)]' : 'bg-[var(--border-color)]'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${deepScanEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </span>
            </label>
            {moduleState.status === 'scanning' && deepScanEnabled && (
              <button
                onClick={handleStopScan}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg text-xs font-medium text-amber-600 transition"
              >
                <StopCircle className="w-3.5 h-3.5" />
                {i18n.t('stop', { ns: 'common' })}
              </button>
            )}
            {scanResult && scanResult.total_file_count > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleAllSelection(true)}
                  title={scanMode === 'deep' ? t('selectAllDeepTitle') : undefined}
                  className="text-xs text-[var(--fg-muted)] hover:text-emerald-600 transition"
                >
                  {scanMode === 'deep' ? i18n.t('selectAllLoaded', { ns: 'common' }) : i18n.t('selectAll', { ns: 'common' })}
                </button>
                <button
                  onClick={() => toggleAllSelection(false)}
                  className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] transition"
                >
                  {i18n.t('deselect', { ns: 'common' })}
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleteVerificationPending || (selectedPaths.size === 0 && selectedCategoryNames.size === 0)}
                  className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                    ${deleteVerificationPending || (selectedPaths.size === 0 && selectedCategoryNames.size === 0)
                      ? 'bg-[var(--bg-hover)] text-[var(--fg-faint)] cursor-not-allowed'
                      : 'bg-rose-500 text-white hover:bg-rose-600'
                    }
                  `}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('cleanBtn', { count: selectedFileCount })}
                </button>
              </div>
            )}
          </div>
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

          {deleteVerificationPending && (
            <div className="flex items-center gap-3 rounded-xl border border-[var(--brand-green-20)] bg-[var(--brand-green-10)] px-4 py-3">
              <Loader2 className="w-4 h-4 shrink-0 text-[var(--brand-green)] animate-spin" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--fg-primary)]">{t('verification.title')}</p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">{t('verification.desc')}</p>
              </div>
            </div>
          )}

          {moduleState.status === 'scanning' && (
            <div className="rounded-2xl border border-[var(--brand-green-20)] bg-[var(--brand-green-10)] p-4 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-[var(--bg-card)] flex items-center justify-center shrink-0">
                    <Activity className="w-5 h-5 text-[var(--brand-green)] animate-pulse" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-[var(--fg-primary)]">
                        {scanMode === 'deep' ? t('scanning.deepTitle') : t('scanning.quickTitle')}
                      </h4>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--bg-card)] text-[var(--brand-green)]">
                        {scanMode === 'deep' ? t('scanning.deepBadge') : t('scanning.quickBadge')}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--fg-muted)] truncate">
                      {scanProgress ? getScanStageLabel(scanProgress.stage, scanMode === 'deep') : getScanStageLabel('', scanMode === 'deep')}
                    </p>
                  </div>
                </div>
                <span className="text-xs font-semibold text-[var(--brand-green)] tabular-nums shrink-0">
                  {scanProgressPercent}%
                </span>
              </div>

              <div>
                <div className="h-2 bg-[var(--bg-card)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--brand-green)] transition-all duration-500"
                    style={{ width: `${scanProgressPercent}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-[var(--fg-muted)]">
                  <span>{scanProgress ? getScanStageLabel(scanProgress.stage, scanMode === 'deep') : t('scanning.starting')}</span>
                  <span>{scanProgress ? formatScanDuration(scanProgress.elapsed_ms) : t('scanning.preparing')}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><HardDrive className="w-3.5 h-3.5" />{t('scanning.partition')}</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)]">{scanProgress?.drive_letter || t('scanning.preparing')}</p>
                </div>
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><Database className="w-3.5 h-3.5" />{t('scanning.processedRecords')}</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)] tabular-nums">{(scanProgress?.processed ?? 0).toLocaleString()}</p>
                </div>
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><FileSearch className="w-3.5 h-3.5" />{t('scanning.candidateFiles')}</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)] tabular-nums">{(scanProgress?.matched_count ?? 0).toLocaleString()}</p>
                </div>
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><Timer className="w-3.5 h-3.5" />{t('scanning.elapsed')}</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)]">{formatScanDuration(scanProgress?.elapsed_ms ?? 0)}</p>
                </div>
              </div>

              {scanMode === 'deep' && (
                <div className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)] border-t border-[var(--brand-green-20)] pt-3">
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--brand-green)] shrink-0" />
                  <span>{t('scanning.safetyNote')}</span>
                </div>
              )}
            </div>
          )}

          {deepScanResult && deepScanResult.drives.length > 0 && (
            <div className="flex flex-wrap gap-2 text-[11px] text-[var(--fg-muted)]">
              {deepScanResult.drives.map((drive) => (
                <span key={drive.drive_letter} className="px-2 py-1 rounded-md bg-[var(--bg-hover)]" title={drive.warning ?? undefined}>
                  {drive.drive_letter} · {drive.backend === 'mft' ? t('drives.mft') : t('drives.walkdir')} · {formatSize(drive.matched_size)}
                </span>
              ))}
            </div>
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
                    onSearchFile={handleSearchFile}
                    hasMore={scanMode === 'deep' && category.has_more === true}
                    onLoadMore={() => handleLoadMoreDeepCategory(category.display_name)}
                    isLoadingMore={loadingDeepCategory === category.display_name}
                  />
                ))}

              {scanResult.categories.every((c) => c.files.length === 0) && (
                <EmptyState
                  icon={Trash2}
                  title={t('emptyTitle')}
                  description={t('emptyDesc')}
                  tone="success"
                  compact
                />
              )}
            </div>
          ) : moduleState.status === 'idle' ? (
            <EmptyState
              icon={Trash2}
              title={t('idleTitle')}
              description={t('idleDesc')}
            />
          ) : null}
        </div>
      </ModuleCard>
    </>
  );
}

export default JunkCleanModule;
