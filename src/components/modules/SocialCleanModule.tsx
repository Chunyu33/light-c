// ============================================================================
// 社交软件专清模块组件 - 带风险分级
// 支持智能路径溯源和文件类型深度分类
// ============================================================================

import { useState, useCallback, useRef, useMemo, memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'framer-motion';
import {
  MessageCircle,
  Trash2, 
  Loader2, 
  Image, 
  FileText, 
  Share2,
  ChevronRight,
  CheckCircle2,
  FolderOpen,
  X,
  File,
  ExternalLink,
  Database,
  AlertTriangle,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Clock
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ModuleOperationToolbar } from '../ModuleOperationToolbar';
import { ModuleScanProgress } from '../ModuleScanProgress';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  scanSocialCache,
  deleteFiles,
  openInFolder,
  openFile,
  recordCleanupAction,
  type SocialScanResult,
  type SocialFileEntry,
  type SocialCategoryStats,
  type RiskLevel,
  type CleanupLogEntryInput,
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { getSourceKey, getSourceLabel } from '../../utils/socialSource';
import { applyDeletedPaths, resolveDeletedPaths } from '../../utils/socialScanResult';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// ============================================================================
// 分类配置
// ============================================================================

const categoryIcons: Record<string, typeof Image> = {
  chatdatabase: Database,
  imagevideo: Image,
  filetransfer: FileText,
  tempcache: Clock,
  momentscache: Share2,
};

const categoryColors: Record<string, { bg: string; text: string }> = {
  chatdatabase: { bg: 'bg-red-500/10', text: 'text-red-600' },
  imagevideo: { bg: 'bg-emerald-500/10', text: 'text-emerald-600' },
  filetransfer: { bg: 'bg-amber-500/10', text: 'text-amber-600' },
  tempcache: { bg: 'bg-teal-500/10', text: 'text-teal-600' },
  momentscache: { bg: 'bg-cyan-500/10', text: 'text-cyan-600' },
};

// 风险等级配置
const riskLevelConfig: Record<RiskLevel, { 
  icon: typeof Shield; 
  color: string; 
  bgColor: string;
  borderColor: string;
}> = {
  critical: { 
    icon: ShieldAlert, 
    color: 'text-red-600', 
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/30'
  },
  medium: { 
    icon: AlertTriangle, 
    color: 'text-amber-600', 
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30'
  },
  low: { 
    icon: Shield, 
    color: 'text-emerald-600', 
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-500/30'
  },
  none: { 
    icon: ShieldCheck, 
    color: 'text-teal-600', 
    bgColor: 'bg-teal-500/10',
    borderColor: 'border-teal-500/30'
  },
};

// ============================================================================
// 组件实现
// ============================================================================

export function SocialCleanModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useModuleDashboard('social');
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<SocialScanResult | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  /**
   * 详情弹窗只记录「在看哪个分类」，文件列表实时从 scanResult 取。
   * 不再持有文件快照，这样删除后本地更新 scanResult 时弹窗自动跟着更新，
   * 也不会出现「弹窗里还是旧快照」的问题。
   */
  const [fileModalData, setFileModalData] = useState<{ categoryId: string; name: string } | null>(null);
  /** 待删除范围：由触发动作决定（工具栏＝全局选中；详情弹窗＝当前筛选内选中）。
   *  确认弹窗的统计与文案都基于这个范围，保证「确认里写的」和「实际删的」始终一致。 */
  const [pendingDeletePaths, setPendingDeletePaths] = useState<string[]>([]);
  /** 本次删除的文件数快照：进度遮罩用它，避免删除完成后统计被清空导致数字闪回 0 */
  const [deletingCount, setDeletingCount] = useState(0);
  const [showTip, setShowTip] = useState(true);

  // 开始扫描
  const handleScan = useCallback(async () => {
    updateModuleState('social', { status: 'scanning', error: null });
    setScanResult(null);
    setSelectedPaths(new Set());
    setExpandedCategory(null);

    try {
      const result = await scanSocialCache();
      setScanResult(result);
      
      // 默认只选中可删除的文件（排除 Critical 级别）
      const deletablePaths = result.categories
        .flatMap(c => c.files)
        .filter(f => f.deletable)
        .map(f => f.path);
      setSelectedPaths(new Set(deletablePaths));

      updateModuleState('social', {
        status: 'done',
        fileCount: result.total_files,
        totalSize: result.total_size,
      });

      setExpandedModule('social');
    } catch (err) {
      console.error('扫描社交软件缓存失败:', err);
      updateModuleState('social', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 切换单个文件选中（只允许可删除的文件）
  const toggleFile = useCallback((file: SocialFileEntry) => {
    if (!file.deletable) return; // Critical 级别不允许选中
    
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(file.path)) {
        next.delete(file.path);
      } else {
        next.add(file.path);
      }
      return next;
    });
  }, []);

  // 批量设置选中状态：筛选内全选一次性提交，避免逐条 toggle 产生成百上千次状态更新
  const setSelectionForPaths = useCallback((paths: string[], select: boolean) => {
    setSelectedPaths(previous => {
      const next = new Set(previous);
      for (const path of paths) {
        if (select) {
          next.add(path);
        } else {
          next.delete(path);
        }
      }
      return next;
    });
  }, []);

  // 切换分类选中（只选中可删除的文件）
  const toggleCategory = useCallback((category: SocialCategoryStats) => {
    const deletableFiles = category.files.filter(f => f.deletable);
    const categoryPaths = deletableFiles.map(f => f.path);
    const allSelected = categoryPaths.every(p => selectedPaths.has(p));
    
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (allSelected) {
        categoryPaths.forEach(p => next.delete(p));
      } else {
        categoryPaths.forEach(p => next.add(p));
      }
      return next;
    });
  }, [selectedPaths]);

  // 全选/取消全选（只选中可删除的文件）
  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    const deletablePaths = scanResult.categories
      .flatMap(c => c.files)
      .filter(f => f.deletable)
      .map(f => f.path);
    
    const allSelected = deletablePaths.every(p => selectedPaths.has(p));
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(deletablePaths));
    }
  }, [scanResult, selectedPaths]);

  // 扫描结果按路径建索引：删除日志与确认统计都要按路径反查文件，
  // 用 Array.find 逐条线性查找在十万级文件下会退化成 O(n²)。
  const allFilesByPath = useMemo(() => {
    const index = new Map<string, SocialFileEntry>();
    for (const category of scanResult?.categories ?? []) {
      for (const file of category.files) {
        index.set(file.path, file);
      }
    }
    return index;
  }, [scanResult]);

  // 发起删除：范围由调用方给定，避免出现「点了当前筛选、却删了别处」的偏差
  const requestDelete = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setPendingDeletePaths(paths);
    setShowDeleteConfirm(true);
  }, []);

  // 执行删除：只删 pendingDeletePaths 记录的范围
  const handleDelete = useCallback(async () => {
    const paths = pendingDeletePaths;
    if (paths.length === 0) return;

    setIsDeleting(true);
    // 快照本次删除数量：进度遮罩用它，避免本地更新后统计变 0 导致数字闪回
    setDeletingCount(paths.length);
    try {
      const result = await deleteFiles(paths);

      // 记录清理日志
      const failedPathIndex = new Map((result.failed_files ?? []).map((item) => [item.path, item]));
      const logEntries: CleanupLogEntryInput[] = paths.map((path) => {
        const file = allFilesByPath.get(path);
        return {
          category: '社交软件专清',
          path,
          size: file?.size || 0,
          success: !failedPathIndex.has(path),
          error_message: failedPathIndex.get(path)?.reason,
        };
      });
      recordCleanupAction(logEntries).catch((err) => {
        console.warn('记录清理日志失败:', err);
      });
      
      if (result.failed_count === 0) {
        showToast({
          type: 'success',
          title: moduleT('social.deleteSuccess', { count: result.success_count }),
          description: moduleT('social.deleteSuccessDesc', { size: formatSize(result.freed_size) }),
        });
      } else if (result.success_count === 0) {
        showToast({
          type: 'error',
          title: moduleT('social.deleteFailed'),
          description: moduleT('social.deleteFailedDesc', { count: result.failed_count }),
        });
      } else {
        showToast({
          type: 'warning',
          title: moduleT('social.deletePartial'),
          description: moduleT('social.deletePartialDesc', { success: result.success_count, failed: result.failed_count }),
        });
      }

      // 删除成功后本地更新结果集，不再重跑一次全量扫描：
      // 重扫既昂贵（要重新遍历所有软件的数据目录），又会把用户的勾选整块重置成「默认全选」。
      // resolveDeletedPaths 返回 null 表示有文件无法确认是否真的被删掉（例如被标记为重启后删除），
      // 这时退回重新扫描 —— 宁可慢一点，也不能把还在磁盘上的文件显示成已删除。
      const removedPaths = resolveDeletedPaths(paths, result);
      if (result.success_count > 0) {
        if (removedPaths && removedPaths.size > 0 && scanResult) {
          const nextResult = applyDeletedPaths(scanResult, removedPaths);
          setScanResult(nextResult);
          updateModuleState('social', {
            status: 'done',
            fileCount: nextResult.total_files,
            totalSize: nextResult.total_size,
          });
          setSelectedPaths((previous) => {
            const remaining = new Set(previous);
            for (const path of removedPaths) {
              remaining.delete(path);
            }
            return remaining;
          });
        } else {
          // 本地无法安全更新，退回重扫；重扫期间结果集先被清空，关掉弹窗避免闪一下空白
          setFileModalData(null);
          handleScan();
        }
        triggerHealthRefresh();
      }
    } catch (err) {
      console.error('删除失败:', err);
      showToast({ type: 'error', title: moduleT('social.deleteFailed'), description: String(err) });
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDeletePaths, allFilesByPath, scanResult, handleScan, triggerHealthRefresh, showToast, moduleT, updateModuleState]);

  // 工具栏用的全局选中统计。原本每次渲染都重算，选择变化会反复遍历整个结果集，改成缓存 +
  // 走路径索引，复杂度从 O(全量文件) 降到 O(选中数量)。
  const selectedStats = useMemo(() => {
    let files = 0;
    let size = 0;
    for (const path of selectedPaths) {
      const file = allFilesByPath.get(path);
      if (file) {
        files += 1;
        size += file.size;
      }
    }
    return { files, size };
  }, [selectedPaths, allFilesByPath]);

  // 待删除范围的统计：确认弹窗与删除进度都基于它，保证与实际删除范围一致
  const pendingDeleteStats = useMemo(() => {
    let files = 0;
    let size = 0;
    for (const path of pendingDeletePaths) {
      const file = allFilesByPath.get(path);
      if (file) {
        files += 1;
        size += file.size;
      }
    }
    return { files, size };
  }, [pendingDeletePaths, allFilesByPath]);

  // 确认文案里的名称占位符只认「本次真正要删的文件所属分类」，避免把未涉及的软件名列出来
  const confirmTargetName = useMemo(() => {
    const pendingPathSet = new Set(pendingDeletePaths);
    const categoryNames = Array.from(new Set(
      (scanResult?.categories ?? [])
        .filter(category => category.files.some(file => pendingPathSet.has(file.path)))
        .map(category => moduleT(`social.category.${category.id}.name`)),
    ));
    return categoryNames.length > 0
      ? categoryNames.join('、')
      : moduleT('social.confirmTargetFallback');
  }, [pendingDeletePaths, scanResult, moduleT]);

  // 详情弹窗的文件列表实时取自 scanResult，不另存快照：
  // 删除后本地更新 scanResult 时弹窗自动跟着更新，也不会出现「弹窗里还是旧数据」的问题。
  const fileModalFiles = useMemo(() => {
    if (!fileModalData || !scanResult) {
      return [];
    }
    return scanResult.categories.find(category => category.id === fileModalData.categoryId)?.files ?? [];
  }, [fileModalData, scanResult]);

  const isExpanded = expandedModule === 'social';
  // 页面模式由当前模块控制可见性，卡片模式则沿用手风琴展开状态，避免误判为共用操作区。
  const shouldShowOperationToolbar = layoutMode === 'pages' ? isPageActive : isExpanded;

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !isDeleting && !showDeleteConfirm && !fileModalData) {
    return null;
  }

  return (
    <>
      {/* 删除进度遮罩 */}
      {createPortal(
        <AnimatePresence>
          {isDeleting && (
            <motion.div
              className="fixed inset-0 z-[9999] flex items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
            >
              <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
              <motion.div
                className="relative bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4"
                initial={{ opacity: 0, scale: 0.96, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 10 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="w-16 h-16 rounded-full bg-rose-500/10 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-rose-500 animate-spin" />
                </div>
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-[var(--fg-primary)]">{moduleT('social.deleting')}</h3>
                  <p className="text-sm text-[var(--fg-muted)] mt-1">
                    {moduleT('social.deletingDesc', { count: deletingCount })}
                  </p>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <SocialDeleteConfirmModal
        isOpen={showDeleteConfirm}
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        targetName={confirmTargetName}
        selectedFiles={pendingDeleteStats.files}
        selectedSize={pendingDeleteStats.size}
      />

      <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        id="social"
        title={navT('socialClean')}
        description={navT('socialCleanDesc')}
        icon={<MessageCircle className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'social')}
        onScan={handleScan}
        error={moduleState.error}
        allowStickyContent
      >
        {/* 展开内容 */}
        <div className="min-h-[300px]">
          {shouldShowOperationToolbar && scanResult && scanResult.total_files > 0 && (
            // 公共操作区统一处理固定定位和折叠状态，按钮内容仍由社交软件模块维护。
            <ModuleOperationToolbar moduleId="social">
              <button
                onClick={toggleSelectAll}
                className="module-operation-toolbar__button module-operation-toolbar__button--muted"
              >
                {selectedPaths.size === scanResult.deletable_files ? moduleT('social.deselectAll') : moduleT('social.selectAll')}
              </button>
              <button
                onClick={() => requestDelete(Array.from(selectedPaths))}
                disabled={selectedPaths.size === 0}
                className="module-operation-toolbar__button module-operation-toolbar__button--danger"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {moduleT('social.clean')} ({selectedStats.files})
              </button>
            </ModuleOperationToolbar>
          )}

          {/* 说明提示 */}
          {showTip && (
            <div className="mx-4 mt-4 mb-4 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 flex items-start gap-2 relative">
              <div className="w-4 h-4 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-amber-600 text-[10px] font-bold">!</span>
              </div>
              <p className="text-[11px] text-amber-600/80 leading-relaxed flex-1">
                <span className="font-medium">{moduleT('social.riskGuide')}</span>
                <span className="text-red-600">{moduleT('social.riskRed')}</span> {moduleT('social.riskRedDesc')}，
                <span className="text-amber-600">{moduleT('social.riskOrange')}</span> {moduleT('social.riskOrangeDesc')}，
                <span className="text-emerald-600">{moduleT('social.riskGreen')}</span> {moduleT('social.riskGreenDesc')}，
                <span className="text-teal-600">{moduleT('social.riskCyan')}</span> {moduleT('social.riskCyanDesc')}。
              </p>
              <button onClick={() => setShowTip(false)} className="text-amber-500 hover:text-amber-700 transition shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 空状态 */}
          {moduleState.status === 'idle' && (
            <div className="p-4">
              <EmptyState
                icon={MessageCircle}
              title={t('notScannedSocialCache')}
                description={moduleT('social.idleDesc')}
              />
            </div>
          )}

          {/* 扫描中状态 */}
          {/* 外层 p-4 与本模块其余状态（空状态 / 提示条）保持一致：
              模块内容容器只设了 min-h，不留内边距，padding 由各状态自己补 */}
          {moduleState.status === 'scanning' && (
            <div className="p-4">
              <ModuleScanProgress
                title={moduleT('social.scanning')}
                description={moduleT('social.scanningDesc')}
                icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
              />
            </div>
          )}

          {/* 无结果状态 */}
          {moduleState.status === 'done' && scanResult && scanResult.total_files === 0 && (
            <div className="p-4">
              <EmptyState
                icon={CheckCircle2}
                tone="success"
              title={t('nothingToClean')}
                description={moduleT('social.emptyDesc')}
              />
            </div>
          )}

          {/* 分类列表 */}
          {moduleState.status === 'done' && scanResult && scanResult.categories.map((category) => {
            const Icon = categoryIcons[category.id] || FolderOpen;
            const colors = categoryColors[category.id] || categoryColors.imagevideo;
            const isCategoryExpanded = expandedCategory === category.id;
            const hasFiles = category.file_count > 0;
            const deletableFiles = category.files.filter(f => f.deletable);
            const categoryPaths = deletableFiles.map(f => f.path);
            const selectedInCategory = categoryPaths.filter(p => selectedPaths.has(p)).length;
            const isAllSelected = selectedInCategory === categoryPaths.length && categoryPaths.length > 0;
            const isPartialSelected = selectedInCategory > 0 && selectedInCategory < categoryPaths.length;
            
            // 判断是否为危险分类（聊天记录）
            const isCriticalCategory = category.id === 'chatdatabase';

            return (
              <div key={category.id} className={`border-b border-[var(--border-default)] last:border-b-0 ${isCriticalCategory ? 'bg-red-500/5' : ''}`}>
                {/* 分类行 */}
                <div
                  className={`px-4 py-3 flex items-center gap-3 transition-all ${hasFiles ? 'cursor-pointer hover:bg-[var(--bg-hover)]' : 'opacity-50'}`}
                  onClick={() => hasFiles && setExpandedCategory(isCategoryExpanded ? null : category.id)}
                >
                  <div className={`text-[var(--fg-muted)] transition-transform duration-200 ${isCategoryExpanded ? 'rotate-90' : ''}`}>
                    <ChevronRight className="w-4 h-4" />
                  </div>

                  {/* 复选框 - 危险分类禁用 */}
                  <div
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      if (hasFiles && !isCriticalCategory) toggleCategory(category); 
                    }}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors
                      ${isCriticalCategory 
                        ? 'border-red-300 bg-red-100 cursor-not-allowed' 
                        : isAllSelected 
                          ? 'bg-emerald-500 border-emerald-500 cursor-pointer' 
                          : isPartialSelected 
                            ? 'bg-emerald-500/50 border-emerald-500 cursor-pointer' 
                            : 'border-[var(--fg-faint)] cursor-pointer'
                      }`}
                    title={isCriticalCategory ? moduleT('social.chatUndeletable') : undefined}
                  >
                    {isCriticalCategory ? (
                      <X className="w-2.5 h-2.5 text-red-500" />
                    ) : (isAllSelected || isPartialSelected) && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>

                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors.bg}`}>
                    <Icon className={`w-4 h-4 ${colors.text}`} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-[var(--fg-primary)]">{moduleT(`social.category.${category.id}.name`)}</p>
                      {isCriticalCategory ? (
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red-500/10 text-red-600 flex items-center gap-0.5">
                          <ShieldAlert className="w-2.5 h-2.5" />
                          {moduleT('social.chatUndeletable')}
                        </span>
                      ) : (
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-medium ${colors.bg} ${colors.text}`}>
                          {hasFiles ? `${moduleT('social.deletable')} ${category.deletable_count}` : t('noData')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[var(--fg-muted)] mt-0.5 truncate">{moduleT(`social.category.${category.id}.description`)}</p>
                  </div>

                  <div className="text-right shrink-0">
                    <p className={`text-sm font-bold ${isCriticalCategory ? 'text-red-600' : 'text-emerald-600'}`}>
                      {formatSize(category.total_size)}
                    </p>
                    <p className="text-[11px] text-[var(--fg-muted)]">{category.file_count.toLocaleString()} {moduleT('social.files')}</p>
                  </div>
                </div>

                {/* 展开的文件列表 */}
                <AnimatePresence initial={false}>
                  {isCategoryExpanded && hasFiles && (
                    <motion.div
                      key={`${category.id}-files`}
                      className="overflow-hidden bg-[var(--bg-base)] border-t border-[var(--border-default)]"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <div className="max-h-48 overflow-auto">
                        {category.files.slice(0, 20).map((file, index) => (
                          <FileRow
                            key={file.path}
                            index={index}
                            file={file}
                            isSelected={selectedPaths.has(file.path)}
                            onToggle={() => toggleFile(file)}
                          />
                        ))}
                      </div>
                      {category.files.length > 20 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setFileModalData({ categoryId: category.id, name: moduleT(`social.category.${category.id}.name`) }); }}
                          className="w-full px-4 py-2 text-center text-xs text-emerald-600 hover:bg-emerald-500/5 border-t border-[var(--border-default)] transition"
                        >
                          {moduleT('social.viewFiles')} ({category.files.length.toLocaleString()} {moduleT('social.files')}) →
                        </button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </ModuleCard>

      {/* 文件详情弹窗 */}
      <FileListModal
        isOpen={fileModalData !== null}
        title={fileModalData?.name || ''}
        files={fileModalFiles}
        selectedPaths={selectedPaths}
        onToggleFile={toggleFile}
        onSetSelectionForPaths={setSelectionForPaths}
        onRequestDelete={requestDelete}
        onClose={() => setFileModalData(null)}
      />
    </>
  );
}

// ============================================================================
// 文件行组件
// ============================================================================

interface SocialDeleteConfirmModalProps {
  isOpen: boolean;
  /** 本次实际会被清理的范围描述，用于填充确认文案里的名称占位符 */
  targetName: string;
  selectedFiles: number;
  selectedSize: number;
  onConfirm: () => void;
  onCancel: () => void;
}

function SocialDeleteConfirmModal({
  isOpen,
  targetName,
  selectedFiles,
  selectedSize,
  onConfirm,
  onCancel,
}: SocialDeleteConfirmModalProps) {
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[10050] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
          {/* 尺寸统一用 em：body 继承 :root 字号，弹窗随全局字号设置缩放，30em ≈ 420px */}
          <motion.div
            className="relative bg-[var(--bg-elevated)] rounded-xl shadow-2xl border border-[var(--border-default)] w-[30em] max-w-[calc(100vw-2em)] overflow-hidden"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-[1.43em] py-[1.14em] border-b border-[var(--border-default)]">
              <div className="flex items-center gap-[0.86em]">
                <div className="w-[2.86em] h-[2.86em] rounded-full bg-amber-500/15 flex items-center justify-center">
                  <AlertTriangle className="w-[1.43em] h-[1.43em] text-amber-500" />
                </div>
                <h3 className="text-[1.14em] font-semibold text-[var(--fg-primary)]">
                  {moduleT('social.confirmDelete')}
                </h3>
              </div>
              <button
                onClick={onCancel}
                className="p-[0.43em] rounded-lg text-[var(--fg-muted)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <X className="w-[1.14em] h-[1.14em]" />
              </button>
            </div>

            <div className="px-[1.43em] py-[1.14em] space-y-[1.14em]">
              <p className="text-[1em] text-[var(--fg-secondary)] leading-relaxed">
                {moduleT('social.confirmDeleteDesc', {
                  name: targetName,
                  count: selectedFiles.toLocaleString(),
                  size: formatSize(selectedSize),
                })}
              </p>
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-[0.86em]">
                <p className="text-[0.86em] text-amber-600 dark:text-amber-400 leading-relaxed">
                  {moduleT('social.risk.mediumTip')}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-[0.86em] px-[1.43em] py-[1.14em] border-t border-[var(--border-default)] bg-[var(--bg-card)]">
              <button
                onClick={onCancel}
                className="px-[1.14em] py-[0.57em] rounded-lg text-[1em] font-medium text-[var(--fg-secondary)] hover:text-[var(--fg-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                onClick={onConfirm}
                className="px-[1.14em] py-[0.57em] rounded-lg text-[1em] font-medium text-white transition-all bg-gradient-to-r from-rose-500 to-red-500 hover:from-rose-600 hover:to-red-600 shadow-lg shadow-rose-500/25"
              >
                {moduleT('social.clean')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

interface FileRowProps {
  index: number;
  file: SocialFileEntry;
  isSelected: boolean;
  onToggle: () => void;
}

// 风险文案由稳定的风险枚举驱动，避免直接展示后端返回的中文文本。
function getSocialRiskLabel(translate: (key: string) => string, level: RiskLevel): string {
  return translate(`social.risk.${level}`);
}

function getSocialRiskTooltip(translate: (key: string) => string, level: RiskLevel): string {
  return translate(`social.risk.${level}Tip`);
}

function FileRow({ index, file, isSelected, onToggle }: FileRowProps) {
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const riskConfig = riskLevelConfig[file.risk_level];
  const RiskIcon = riskConfig.icon;
  const isCritical = file.risk_level === 'critical';
  
  return (
    <div
      className={`px-4 py-2 flex items-center gap-2 text-xs border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors
        ${isCritical ? 'bg-red-500/5 cursor-not-allowed' : 'cursor-pointer'}
        ${isSelected && !isCritical ? 'bg-emerald-500/5' : ''}`}
      onClick={() => !isCritical && onToggle()}
    >
      {/* 复选框 */}
      <div 
        className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center shrink-0 transition-colors
          ${isCritical 
            ? 'border-red-300 bg-red-100' 
            : isSelected 
              ? 'bg-emerald-500 border-emerald-500' 
              : 'border-[var(--fg-faint)]'
          }`}
        title={isCritical ? getSocialRiskTooltip(moduleT, file.risk_level) : undefined}
      >
        {isCritical ? (
          <X className="w-2 h-2 text-red-500" />
        ) : isSelected && (
          <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      
      {/* 序号 */}
      <span className="w-5 text-center text-[var(--fg-faint)]">{index + 1}</span>
      
      {/* 风险等级图标 */}
      <div 
        className={`p-0.5 rounded ${riskConfig.bgColor}`}
        title={getSocialRiskTooltip(moduleT, file.risk_level)}
      >
        <RiskIcon className={`w-3 h-3 ${riskConfig.color}`} />
      </div>
      
      {/* 应用名称 */}
      <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] shrink-0 text-[10px]">
        {getSourceLabel(getSourceKey(file.app_name), moduleT)}
      </span>
      
      {/* 文件路径 */}
      <span className="flex-1 truncate text-[var(--fg-secondary)]" title={file.path}>
        {file.path}
      </span>
      
      {/* 风险标签 */}
      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${riskConfig.bgColor} ${riskConfig.color}`}>
        {getSocialRiskLabel(moduleT, file.risk_level)}
      </span>
      
      {/* 文件大小 */}
      <span className={`font-medium shrink-0 ${isCritical ? 'text-red-600' : 'text-emerald-600'}`}>
        {formatSize(file.size)}
      </span>
      
      {/* 操作按钮 */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button 
          onClick={(e) => { e.stopPropagation(); openInFolder(file.path); }} 
          className="p-1 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" 
          title={t('openInFolder')}
        >
          <FolderOpen className="w-3 h-3" />
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); openFile(file.path); }} 
          className="p-1 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" 
          title={t('openFile')}
        >
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 文件列表弹窗组件
// ============================================================================

interface FileListModalProps {
  title: string;
  files: SocialFileEntry[];
  selectedPaths: Set<string>;
  onToggleFile: (file: SocialFileEntry) => void;
  /** 批量设置选中状态：筛选内全选一次性提交，避免逐条更新触发大量重渲染 */
  onSetSelectionForPaths: (paths: string[], select: boolean) => void;
  /** 请求打开删除确认框。作用范围由弹窗给定（当前筛选内已选中的文件），
   *  避免因为「扫描后默认全选」而误删其它分类的文件。 */
  onRequestDelete: (paths: string[]) => void;
  isOpen: boolean;
  onClose: () => void;
}

/** 来源分组：同一应用的多种写法已由 getSourceKey 归一化 */
interface SourceGroup {
  key: string;
  count: number;
}

function FileListModal({
  title,
  files,
  selectedPaths,
  onToggleFile,
  onSetSelectionForPaths,
  onRequestDelete,
  isOpen,
  onClose,
}: FileListModalProps) {
  const { t: moduleT } = useTranslation('modules');
  const parentRef = useRef<HTMLDivElement>(null);
  /** 当前筛选的来源 key 集合，空集合代表「全部」 */
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set());

  // 关闭时清空筛选，避免下次打开还停在上一次的来源状态
  useEffect(() => {
    if (!isOpen) {
      setActiveSources(new Set());
    }
  }, [isOpen]);

  // 表头统计与来源分组只依赖 files，一律收进 useMemo：
  // 虚拟列表滚动会触发重渲染，不缓存的话每一帧都要重新遍历整个列表
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const deletableCount = useMemo(() => files.filter(file => file.deletable).length, [files]);

  // 来源分组只依赖 files，不依赖 moduleT：
  // t 函数的引用可能随渲染变化，一旦进依赖数组会让这个 O(N) 遍历在每次滚动重渲染时都重跑。
  // 展示名放到渲染时按 key 取（分组数很少，开销可忽略）。
  const sourceGroups = useMemo<SourceGroup[]>(() => {
    const groups = new Map<string, SourceGroup>();
    for (const file of files) {
      const key = getSourceKey(file.app_name);
      const existing = groups.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(key, { key, count: 1 });
      }
    }
    return Array.from(groups.values()).sort((left, right) => right.count - left.count);
  }, [files]);

  // 「全部」时直接复用原数组，省掉一次无意义的拷贝
  const visibleFiles = useMemo(() => {
    if (activeSources.size === 0) {
      return files;
    }
    return files.filter(file => activeSources.has(getSourceKey(file.app_name)));
  }, [files, activeSources]);

  const virtualizer = useVirtualizer({
    count: visibleFiles.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 20,
  });

  // 切换来源后列表长度变化，旧滚动位置可能落到新内容高度之外导致空白，统一回到顶部。
  // 弹窗关闭时 portal 内容已卸载、parentRef 为空，这里必须判空避免对空实例调用。
  useEffect(() => {
    if (parentRef.current) {
      virtualizer.scrollToOffset(0);
    }
  }, [activeSources]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 当前筛选下可删除的文件路径 */
  const visibleDeletablePaths = useMemo(
    () => visibleFiles.filter(file => file.deletable).map(file => file.path),
    [visibleFiles],
  );
  // 同样要缓存：不缓存的话每次滚动重渲染都要对可见集合做一次全量 every 判断
  const allVisibleSelected = useMemo(
    () => visibleDeletablePaths.length > 0
      && visibleDeletablePaths.every(path => selectedPaths.has(path)),
    [visibleDeletablePaths, selectedPaths],
  );

  // 全选/取消全选只作用于当前筛选结果，避免选中界面上看不见的文件
  const handleToggleSelectAll = useCallback(() => {
    onSetSelectionForPaths(visibleDeletablePaths, !allVisibleSelected);
  }, [onSetSelectionForPaths, visibleDeletablePaths, allVisibleSelected]);

  // 来源标签支持多选；再点一次已选中的标签即取消
  const handleToggleSource = useCallback((sourceKey: string) => {
    setActiveSources(previous => {
      const next = new Set(previous);
      if (next.has(sourceKey)) {
        next.delete(sourceKey);
      } else {
        next.add(sourceKey);
      }
      return next;
    });
  }, []);

  const handleClearSources = useCallback(() => setActiveSources(new Set()), []);

  /** 当前筛选内、且已选中的文件路径。这就是详情弹窗里删除按钮的实际作用范围。 */
  const visibleSelectedPaths = useMemo(
    () => visibleDeletablePaths.filter(path => selectedPaths.has(path)),
    [visibleDeletablePaths, selectedPaths],
  );

  // 被当前筛选隐藏、但仍处于选中状态的项。它们不会被本次删除波及，但必须告知用户，
  // 否则用户会以为「删除」等于删掉全部已选。无筛选时直接跳过整轮遍历。
  const hiddenSelectedCount = useMemo(() => {
    if (activeSources.size === 0) {
      return 0;
    }
    let count = 0;
    for (const file of files) {
      if (selectedPaths.has(file.path) && !activeSources.has(getSourceKey(file.app_name))) {
        count += 1;
      }
    }
    return count;
  }, [files, selectedPaths, activeSources]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className="relative bg-[var(--bg-card)] rounded-2xl border border-[var(--border-default)] shadow-2xl w-full max-w-5xl max-h-[80vh] flex flex-col overflow-hidden"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-[var(--fg-primary)]">{title}</h3>
                <p className="text-xs text-[var(--fg-muted)] mt-0.5">
                  {files.length.toLocaleString()} {moduleT('social.files')}，{formatSize(totalSize)}
                  <span className="mx-2">|</span>
                  {moduleT('social.deletable')} {deletableCount}
                </p>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-[var(--bg-hover)] rounded-lg transition">
                <X className="w-5 h-5 text-[var(--fg-muted)]" />
              </button>
            </div>

            {/* 来源筛选：标签可多选，再点一次已选中的标签即取消。
                「全部」仅在存在多个来源时出现，单一来源时它和来源标签等价，显示出来反而冗余。 */}
            <div className="px-6 py-2.5 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center gap-3 text-xs shrink-0">
              <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
                {sourceGroups.length > 1 && (
                  <button
                    onClick={handleClearSources}
                    className={`shrink-0 px-3 py-1 rounded-full border transition-colors ${
                      activeSources.size === 0
                        ? 'bg-[var(--brand-green)] border-[var(--brand-green)] text-white'
                        : 'bg-[var(--bg-card)] border-[var(--border-default)] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]'
                    }`}
                  >
                    {moduleT('social.allSources')} {files.length.toLocaleString()}
                  </button>
                )}
                {sourceGroups.map(group => {
                  const isActive = activeSources.has(group.key);
                  return (
                    <button
                      key={group.key}
                      onClick={() => handleToggleSource(group.key)}
                      className={`shrink-0 px-3 py-1 rounded-full border transition-colors ${
                        isActive
                          ? 'bg-[var(--brand-green)] border-[var(--brand-green)] text-white'
                          : 'bg-[var(--bg-card)] border-[var(--border-default)] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]'
                      }`}
                    >
                      {getSourceLabel(group.key, moduleT)} {group.count.toLocaleString()}
                    </button>
                  );
                })}
              </div>
              {/* 全选只覆盖当前筛选结果，避免选中界面上看不见的文件 */}
              <button
                onClick={handleToggleSelectAll}
                disabled={visibleDeletablePaths.length === 0}
                className="shrink-0 text-[var(--brand-green)] hover:underline disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
              >
                {allVisibleSelected ? moduleT('social.deselectAll') : moduleT('social.selectAll')}
                {` (${visibleDeletablePaths.length.toLocaleString()})`}
              </button>
            </div>
            <div className="px-6 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-default)] flex items-center gap-4 text-xs font-medium text-[var(--fg-muted)] shrink-0">
              <span className="w-8"></span>
              <span className="w-8 text-center">#</span>
              <span className="w-6"></span>
              <span className="w-16">{moduleT('social.source')}</span>
              <span className="flex-1">{moduleT('social.path')}</span>
              <span className="w-20">{moduleT('social.riskHeader')}</span>
              <span className="w-20 text-right">{moduleT('social.size')}</span>
              <span className="w-16"></span>
            </div>
            <div ref={parentRef} className="flex-1 overflow-auto">
              {visibleFiles.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--fg-muted)]">
                  {moduleT('social.emptyDesc')}
                </div>
              ) : (
                <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const file = visibleFiles[virtualRow.index];
                    return (
                      <VirtualFileRow
                        key={file.path}
                        index={virtualRow.index}
                        file={file}
                        isSelected={selectedPaths.has(file.path)}
                        onToggle={() => onToggleFile(file)}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtualRow.size}px`,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* 底栏：选中统计 + 删除入口。删除作用域是全局选中项，不限于当前分类，
                所以要把「被当前筛选隐藏」和「在其它分类」的数量分别说明清楚。 */}
            <div className="px-6 py-3 border-t border-[var(--border-default)] bg-[var(--bg-elevated)] flex items-center justify-between gap-4 shrink-0">
              <div className="flex-1 min-w-0 flex items-center gap-x-2 gap-y-1 text-xs text-[var(--fg-muted)] flex-wrap">
                {visibleSelectedPaths.length > 0 ? (
                  <>
                    <span className="text-[var(--fg-primary)] font-medium">
                      {moduleT('social.deleteScopeHint', { count: visibleSelectedPaths.length })}
                    </span>
                    {hiddenSelectedCount > 0 && (
                      <span>· {moduleT('social.hiddenByFilterHint', { count: hiddenSelectedCount })}</span>
                    )}
                  </>
                ) : (
                  <span>{visibleFiles.length.toLocaleString()} {moduleT('social.files')}</span>
                )}
              </div>
              <button
                onClick={() => onRequestDelete(visibleSelectedPaths)}
                disabled={visibleSelectedPaths.length === 0}
                className="shrink-0 px-4 py-1.5 rounded-lg text-xs font-medium bg-[var(--brand-green)] text-white transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {moduleT('social.deleteSelected')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

// ============================================================================
// 虚拟文件行组件
// ============================================================================

interface VirtualFileRowProps {
  index: number;
  file: SocialFileEntry;
  isSelected: boolean;
  onToggle: () => void;
  style: React.CSSProperties;
}

const VirtualFileRow = memo(function VirtualFileRow({ index, file, isSelected, onToggle, style }: VirtualFileRowProps) {
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const riskConfig = riskLevelConfig[file.risk_level];
  const RiskIcon = riskConfig.icon;
  const isCritical = file.risk_level === 'critical';
  
  return (
    <div 
      style={style} 
      className={`px-6 flex items-center gap-4 text-xs border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors
        ${isCritical ? 'bg-red-500/5' : ''}`}
    >
      {/* 复选框 */}
      <div 
        onClick={() => !isCritical && onToggle()}
        className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors
          ${isCritical 
            ? 'border-red-300 bg-red-100 cursor-not-allowed' 
            : isSelected 
              ? 'bg-emerald-500 border-emerald-500 cursor-pointer' 
              : 'border-[var(--fg-faint)] cursor-pointer'
          }`}
        title={isCritical ? getSocialRiskTooltip(moduleT, file.risk_level) : undefined}
      >
        {isCritical ? (
          <X className="w-2.5 h-2.5 text-red-500" />
        ) : isSelected && (
          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      
      <span className="w-8 text-center text-[var(--fg-faint)]">{index + 1}</span>
      
      {/* 风险图标 */}
      <div 
        className={`p-1 rounded ${riskConfig.bgColor}`}
        title={getSocialRiskTooltip(moduleT, file.risk_level)}
      >
        <RiskIcon className={`w-3.5 h-3.5 ${riskConfig.color}`} />
      </div>
      
      <span className="w-16 px-2 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] text-center truncate">
        {getSourceLabel(getSourceKey(file.app_name), moduleT)}
      </span>
      
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <File className="w-3.5 h-3.5 text-[var(--fg-faint)] shrink-0" />
        <span className="truncate text-[var(--fg-secondary)]" title={file.path}>{file.path}</span>
      </div>
      
      {/* 风险标签 */}
      <span className={`w-20 px-1.5 py-0.5 rounded text-[9px] font-medium text-center ${riskConfig.bgColor} ${riskConfig.color}`}>
        {getSocialRiskLabel(moduleT, file.risk_level)}
      </span>
      
      <span className={`w-20 text-right font-medium tabular-nums ${isCritical ? 'text-red-600' : 'text-emerald-600'}`}>
        {formatSize(file.size)}
      </span>
      
      <div className="w-16 flex items-center justify-end gap-0.5 shrink-0">
        <button onClick={() => openInFolder(file.path)} className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" title={t('openInFolder')}>
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => openFile(file.path)} className="p-1.5 hover:bg-[var(--bg-elevated)] rounded transition text-[var(--fg-muted)] hover:text-emerald-600" title={t('openFile')}>
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
});

export default SocialCleanModule;
