// ============================================================================
// 垃圾清理模块组件
// 在仪表盘中展示垃圾文件扫描和清理功能
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  if (!isDeep) return '检查已知垃圾目录';
  switch (stage) {
    case 'discover': return '发现本地分区';
    case 'mft': return '枚举 NTFS 文件记录';
    case 'path': return '重建候选文件路径';
    case 'filter': return '匹配安全清理规则';
    case 'metadata': return '读取文件大小与时间';
    case 'result': return '整理扫描结果';
    case 'summary': return '汇总扫描结果';
    default: return '准备扫描';
  }
}

function getScanStageIndex(stage: string): number {
  const index = DEEP_SCAN_STAGES.indexOf(stage);
  return index < 0 ? 0 : index;
}

function formatScanDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function getDeletePhaseLabel(phase: EnhancedDeleteProgress['phase']): string {
  return phase === 'preparing' ? '正在准备清理任务' : '正在清理垃圾文件';
}

function formatDeleteSpeed(progress: EnhancedDeleteProgress | null): string {
  if (!progress || progress.elapsed_ms < 1000 || progress.processed_count === 0) return '计算中';
  const filesPerSecond = progress.processed_count / (progress.elapsed_ms / 1000);
  return `${filesPerSecond.toFixed(0)} 个/秒`;
}

function getDeleteRemainingTime(progress: EnhancedDeleteProgress | null): string {
  if (!progress || progress.processed_count === 0 || progress.total_count <= progress.processed_count) {
    return progress?.processed_count === progress?.total_count ? '即将完成' : '计算中';
  }
  const remainingCount = progress.total_count - progress.processed_count;
  const remainingMilliseconds = (progress.elapsed_ms / progress.processed_count) * remainingCount;
  return `预计剩余 ${formatScanDuration(remainingMilliseconds)}`;
}

// ============================================================================
// 组件实现
// ============================================================================

export function JunkCleanModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
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
      if (!disposed) showToast({ type: 'warning', title: '深度扫描进度监听失败', description: String(error) });
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [showToast]);

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
      if (!disposed) showToast({ type: 'warning', title: '删除进度监听失败', description: String(error) });
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [showToast]);

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
      showToast({ type: 'info', title: '扫描已停止', description: '已取消本次深度垃圾扫描' });
    } catch (error) {
      cancelRequestedRef.current = false;
      showToast({ type: 'error', title: '停止扫描失败', description: String(error) });
    }
  }, [scanMode, showToast]);

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
            title: '清理完成，但日志记录失败',
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
              title: '清理已完成，但核验失败',
              description: '最新扫描结果未能同步，请稍后手动重新扫描。',
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
        const blockedText = result.failed_count > 0
          ? `，${result.failed_count} 个文件清理失败`
          : '';
        const rebootText = result.reboot_pending_count > 0
          ? `，${result.reboot_pending_count} 个文件将在重启后删除`
          : '';
        showToast({
          // 已经有文件成功删除时使用成功色；失败/待重启数量通过文案和明细表达，避免用户误以为整体未执行。
          type: 'success',
          title: '垃圾清理完成',
          description: `${result.summary_message || `成功释放 ${formatSize(result.freed_physical_size)}`}${blockedText}${rebootText}${refreshStarted ? '，正在后台核验最新结果' : ''}`,
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

    } catch (err) {
      console.error('删除失败:', err);
      showToast({ type: 'error', title: '垃圾清理失败', description: String(err) });
    } finally {
      setIsDeleting(false);
      if (!deleteVerificationRef.current) setDeleteProgress(null);
    }
  }, [deepScanResult, excludedDeepPaths, fullySelectedDeepCategoryNames, refreshScanResultAfterDelete, scanMode, selectedFileCount, selectedPaths, selectedCategoryNames, showToast]);

  // 垃圾文件默认使用完整路径搜索，回收站条目则搜索原始路径，避免把内部 $R 文件名交给搜索引擎。
  const handleSearchFile = useCallback(async (file: FileInfo) => {
    const searchPath = file.category === 'RecycleBin'
      ? file.original_path || file.name
      : file.path;
    try {
      await openSearchUrl(`Windows 文件 ${searchPath} 可以删除吗`);
    } catch (error) {
      console.error('搜索文件用途失败:', error);
      showToast({ type: 'error', title: '打开搜索失败', description: String(error) });
    }
  }, [showToast]);

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
      showToast({ type: 'warning', title: '加载深度扫描结果失败', description: String(error) });
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
                已处理 {deleteProcessedCount.toLocaleString()} / {deleteTotalCount.toLocaleString()} 个文件
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div
                className="h-full bg-rose-500 rounded-full transition-all duration-300"
                style={{ width: `${deleteProgressPercent}%` }}
              />
            </div>
            <div className="w-full grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
              <span>已释放 {formatSize(deleteProgress?.freed_physical_size ?? 0)}</span>
              <span className="text-right">失败 {deleteProgress?.failed_count ?? 0}</span>
              <span>速度 {formatDeleteSpeed(deleteProgress)}</span>
              <span className="text-right">{getDeleteRemainingTime(deleteProgress)}</span>
            </div>
            <p className="text-xs text-[var(--fg-faint)]">请勿关闭窗口，清理完成后可继续使用其他功能</p>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title="确认清理"
        description={`您即将删除 ${selectedFileCount.toLocaleString()} 个文件，预计释放 ${formatSize(selectedSize)} 空间。此操作不可撤销。`}
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
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
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
          <div className="flex items-center gap-2">
            <label
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--bg-hover)] text-xs text-[var(--fg-muted)] cursor-pointer select-none"
              title="扫描所有固定分区，NTFS 分区使用 MFT 快速识别明确的缓存目录"
            >
              <span>深度发现</span>
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
                停止
              </button>
            )}
            {scanResult && scanResult.total_file_count > 0 && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleAllSelection(true)}
                  title={scanMode === 'deep' ? '当前页全部选中；执行清理时会包含这些分类的完整扫描结果' : undefined}
                  className="text-xs text-[var(--fg-muted)] hover:text-emerald-600 transition"
                >
                  {scanMode === 'deep' ? '全选已加载' : '全选'}
                </button>
                <button
                  onClick={() => toggleAllSelection(false)}
                  className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg-secondary)] transition"
                >
                  取消
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
                  清理 ({selectedFileCount})
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
                <p className="text-sm font-medium text-[var(--fg-primary)]">清理已完成，正在同步最新结果</p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">后台核验不会阻塞当前页面操作，完成后会自动更新分类统计。</p>
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
                        {scanMode === 'deep' ? '正在进行全盘深度发现' : '正在检查系统垃圾'}
                      </h4>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--bg-card)] text-[var(--brand-green)]">
                        {scanMode === 'deep' ? 'MFT / 多分区' : '快速扫描'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--fg-muted)] truncate">
                      {scanProgress?.message ?? getScanStageLabel('', scanMode === 'deep')}
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
                  <span>{scanProgress ? getScanStageLabel(scanProgress.stage, scanMode === 'deep') : '正在启动扫描'}</span>
                  <span>{scanProgress ? formatScanDuration(scanProgress.elapsed_ms) : '准备中'}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><HardDrive className="w-3.5 h-3.5" />当前分区</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)]">{scanProgress?.drive_letter || '准备中'}</p>
                </div>
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><Database className="w-3.5 h-3.5" />已处理记录</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)] tabular-nums">{(scanProgress?.processed ?? 0).toLocaleString()}</p>
                </div>
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><FileSearch className="w-3.5 h-3.5" />候选文件</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)] tabular-nums">{(scanProgress?.matched_count ?? 0).toLocaleString()}</p>
                </div>
                <div className="rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"><Timer className="w-3.5 h-3.5" />扫描耗时</div>
                  <p className="mt-1 text-sm font-semibold text-[var(--fg-primary)]">{formatScanDuration(scanProgress?.elapsed_ms ?? 0)}</p>
                </div>
              </div>

              {scanMode === 'deep' && (
                <div className="flex items-center gap-2 text-[11px] text-[var(--fg-muted)] border-t border-[var(--brand-green-20)] pt-3">
                  <ShieldCheck className="w-3.5 h-3.5 text-[var(--brand-green)] shrink-0" />
                  <span>仅匹配明确的缓存、临时文件和错误报告目录，系统文件与持久化用户数据会自动跳过</span>
                </div>
              )}
            </div>
          )}

          {deepScanResult && deepScanResult.drives.length > 0 && (
            <div className="flex flex-wrap gap-2 text-[11px] text-[var(--fg-muted)]">
              {deepScanResult.drives.map((drive) => (
                <span key={drive.drive_letter} className="px-2 py-1 rounded-md bg-[var(--bg-hover)]" title={drive.warning ?? undefined}>
                  {drive.drive_letter} · {drive.backend === 'mft' ? 'MFT' : '常规遍历'} · {formatSize(drive.matched_size)}
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
                  title="没有发现可清理的垃圾文件"
                  description="常见临时文件、缓存和日志都很干净。"
                  tone="success"
                  compact
                />
              )}
            </div>
          ) : moduleState.status === 'idle' ? (
            <EmptyState
              icon={Trash2}
              title="尚未扫描垃圾文件"
              description="点击开始扫描，查找系统缓存、临时文件和日志等可清理内容。"
            />
          ) : null}
        </div>
      </ModuleCard>
    </>
  );
}

export default JunkCleanModule;
