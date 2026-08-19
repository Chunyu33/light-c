// ============================================================================
// 大文件清理模块组件
// 在仪表盘中展示大文件扫描和清理功能
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { FileBox, Trash2, Loader2, FileWarning, FolderOpen, Copy, StopCircle, Search } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import {
  defaultDriveLetter,
  DriveSelect,
  driveDisplayName,
  normalizeDriveLetter,
  useLocalDrives,
} from '../ui/DriveSelect';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import { useSettings } from '../../contexts';
import { scanLargeFiles, cancelLargeFileScan, deleteFiles, openInFolder, recordCleanupAction, type CleanupLogEntryInput } from '../../api/commands';
import { formatSize, formatDate, getRiskLevelColor, getRiskLevelBgColor, getRiskLevelKey } from '../../utils/format';
import { openSearchUrl } from '../../utils/searchEngine';
import type { LargeFileEntry, LargeFileScanProgress } from '../../types';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// 后端当前返回固定来源标签；只映射已知枚举，未知值不展示，避免误译真实文件信息。
function getLocalizedSourceLabel(sourceLabel: string, translate: (key: string) => string): string {
  const sourceKey: Record<string, string> = {
    '虚拟机磁盘': 'bigFiles.source.virtualDisk',
    '内存转储': 'bigFiles.source.memoryDump',
    '光盘镜像': 'bigFiles.source.diskImage',
    '数据库文件': 'bigFiles.source.database',
    '压缩包': 'bigFiles.source.archive',
    '日志文件': 'bigFiles.source.log',
    '系统临时文件': 'bigFiles.source.systemTemp',
    'Windows 更新缓存': 'bigFiles.source.windowsUpdate',
    'Steam 游戏文件': 'bigFiles.source.steam',
    '微信文件': 'bigFiles.source.wechat',
    'Chrome 浏览器': 'bigFiles.source.chrome',
    'Edge 浏览器': 'bigFiles.source.edge',
    'Firefox 浏览器': 'bigFiles.source.firefox',
    '下载文件': 'bigFiles.source.downloads',
    '桌面文件': 'bigFiles.source.desktop',
    '回收站': 'bigFiles.source.recycleBin',
    '视频文件': 'bigFiles.source.video',
    '音频文件': 'bigFiles.source.audio',
    '图片文件': 'bigFiles.source.image',
  };
  const key = sourceKey[sourceLabel];
  return key ? translate(key) : '';
}

// ============================================================================
// 组件实现
// ============================================================================

export function BigFilesModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useModuleDashboard('bigFiles');
  const { showToast } = useToast();
  const { settings } = useSettings();
  const { drives } = useLocalDrives();

  // 防止重复扫描
  const scanningRef = useRef(false);
  // 扫描开始时间
  const scanStartRef = useRef(0);
  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [files, setFiles] = useState<LargeFileEntry[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [currentPath, setCurrentPath] = useState('');
  const [scanBackend, setScanBackend] = useState(''); // "mft" | "walkdir"

  // 复制路径比打开文件更适合清理列表：用户可以先在其他工具中确认文件用途，再决定是否删除。
  const copyFilePath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      showToast({ type: 'success', title: t('copyFilePathSuccess') });
    } catch (error) {
      showToast({ type: 'error', title: t('copyFilePathFailed'), description: String(error) });
    }
  }, [showToast, t]);
  const [scanStage, setScanStage] = useState('');
  const [backendElapsedMs, setBackendElapsedMs] = useState(0);
  const [scannedCount, setScannedCount] = useState(0);
  const [scanElapsed, setScanElapsed] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedDriveLetter, setSelectedDriveLetter] = useState('C:');
  const selectedDriveLabel = driveDisplayName(selectedDriveLetter);

  useEffect(() => {
    if (drives.length > 0) {
      setSelectedDriveLetter((current) => {
        const normalized = normalizeDriveLetter(current);
        return drives.some((drive) => drive.drive_letter === normalized)
          ? normalized
          : defaultDriveLetter(drives);
      });
    }
  }, [drives]);

  const resetBigFilesResult = useCallback(() => {
    // 切换磁盘后旧结果已经不再对应当前目标盘，必须清空避免用户误删其他盘文件。
    setFiles([]);
    setSelectedFiles(new Set());
    setCurrentPath('');
    setScanBackend('');
    setScanStage('');
    setBackendElapsedMs(0);
    setScannedCount(0);
    updateModuleState('bigFiles', { status: 'idle', error: null, fileCount: 0, totalSize: 0, progress: 0 });
  }, [updateModuleState]);

  const handleDriveChange = useCallback((driveLetter: string) => {
    if (scanningRef.current) return;
    setSelectedDriveLetter(normalizeDriveLetter(driveLetter));
    resetBigFilesResult();
  }, [resetBigFilesResult]);

  // 监听扫描进度事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen<LargeFileScanProgress>('large-file-scan:progress', (event) => {
        const { current_path, scanned_count, backend, stage, elapsed_ms } = event.payload;
        setCurrentPath(current_path);
        setScannedCount(scanned_count);
        setScanStage(stage || '');
        setBackendElapsedMs(elapsed_ms || 0);
        if (backend) {
          setScanBackend(backend);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // 扫描计时器
  useEffect(() => {
    if (moduleState.status !== 'scanning') { setScanElapsed(0); return; }
    const interval = setInterval(() => {
      if (scanStartRef.current > 0) {
        setScanElapsed(Math.floor((performance.now() - scanStartRef.current) / 1000));
      }
    }, 200);
    return () => clearInterval(interval);
  }, [moduleState.status]);

  // 开始扫描 (带防抖 — scanningRef 防止重复触发)
  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;

    updateModuleState('bigFiles', { status: 'scanning', error: null });
    setFiles([]);
    setCurrentPath('');
    setScanBackend('');
    setScanStage('');
    setBackendElapsedMs(0);
    setScannedCount(0);
    setScanElapsed(0);
    scanStartRef.current = performance.now();
    setSelectedFiles(new Set());

    try {
      const results = await scanLargeFiles(settings.bigFilesScanLimit, selectedDriveLetter);
      setFiles(results);

      const totalSize = results.reduce((sum, f) => sum + f.size, 0);
      updateModuleState('bigFiles', {
        status: 'done',
        fileCount: results.length,
        totalSize,
      });

      setExpandedModule('bigFiles');
    } catch (err) {
      console.error('扫描大文件失败:', err);
      updateModuleState('bigFiles', { status: 'error', error: String(err) });
    } finally {
      scanningRef.current = false;
    }
  }, [updateModuleState, setExpandedModule, settings.bigFilesScanLimit, selectedDriveLetter]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 停止扫描
  const handleStopScan = useCallback(async () => {
    try {
      await cancelLargeFileScan();
      showToast({ type: 'info', title: t('bigFiles.scanStopped'), description: t('bigFiles.scanStoppedDesc') });
    } catch (err) {
      console.error('停止扫描失败:', err);
    }
  }, [showToast, t]);

  // 切换文件选中状态（后端风险等级 >= 4 锁定不可选）
  const handleSearchFile = useCallback(async (path: string) => {
    try {
      // 搜索时带上完整路径，帮助用户在删除前确认文件来源和风险。
      await openSearchUrl(t('bigFiles.searchQuery', { path }));
    } catch (err) {
      console.error('搜索文件用途失败:', err);
      showToast({
        type: 'error',
        title: t('openSearchFailed'),
        description: String(err),
      });
    }
  }, [showToast, t]);

  const toggleFileSelection = useCallback((path: string, riskLevel: number) => {
    if (riskLevel >= 4) return;

    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // 全选/取消全选（后端风险等级 >= 4 锁定不可选）
  const toggleSelectAll = useCallback(() => {
    const selectable = files.filter((f) => f.risk_level <= 3);
    if (selectedFiles.size === selectable.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(selectable.map((f) => f.path)));
    }
  }, [selectedFiles.size, files]);

  // 执行删除
  const handleDelete = useCallback(async () => {
    const paths = Array.from(selectedFiles);
    if (paths.length === 0) return;

    setIsDeleting(true);

    try {
      const result = await deleteFiles(paths);

      // 记录清理日志（所有操作都记录）
      const failedPathSet = new Set(result.failed_files?.map((f) => f.path) || []);
      const logEntries: CleanupLogEntryInput[] = paths.map((path) => {
        const file = files.find((f) => f.path === path);
        const failedFile = result.failed_files?.find((f) => f.path === path);
        return {
          category: '大文件清理',
          path,
          size: file?.size || 0,
          success: !failedPathSet.has(path),
          error_message: failedFile?.reason,
        };
      });
      recordCleanupAction(logEntries).catch((err) => {
        console.warn('记录清理日志失败:', err);
      });

      if (result.failed_count === 0) {
        showToast({
          type: 'success',
          title: t('bigFiles.deleteSuccess', { count: result.success_count }),
          description: t('bigFiles.deleteSuccessDesc', { size: formatSize(result.freed_size) }),
        });
      } else if (result.success_count === 0) {
        showToast({
          type: 'error',
          title: t('bigFiles.deleteFailed'),
          description: t('bigFiles.deleteFailedDesc', { count: result.failed_count }),
        });
      } else {
        showToast({
          type: 'warning',
          title: t('bigFiles.deletePartial'),
          description: t('bigFiles.deletePartialDesc', { success: result.success_count, failed: result.failed_count }),
        });
      }

      // 从列表中移除成功删除的文件，以返回结果为准重建状态
      if (result.success_count > 0) {
        const failedPaths = new Set(result.failed_files?.map((f) => f.path) ?? []);

        // 从文件列表中移除成功删除的（选中且不在失败列表中的）
        const newFiles = files.filter(
          (file) => !selectedFiles.has(file.path) || failedPaths.has(file.path)
        );
        setFiles(newFiles);

        // 选中状态只保留实际失败的文件
        setSelectedFiles(
          new Set([...failedPaths].filter((p) => selectedFiles.has(p)))
        );

        const newTotalSize = newFiles.reduce((sum, f) => sum + f.size, 0);
        updateModuleState('bigFiles', {
          fileCount: newFiles.length,
          totalSize: newTotalSize,
        });

        triggerHealthRefresh();
      }
    } catch (err) {
      console.error('删除大文件失败:', err);
      showToast({
        type: 'error',
        title: t('bigFiles.deleteFailed'),
        description: String(err),
      });
    } finally {
      setIsDeleting(false);
    }
  }, [selectedFiles, files, updateModuleState, triggerHealthRefresh, showToast, t]);

  // 计算选中文件的总大小
  const selectedSize = files
    .filter((f) => selectedFiles.has(f.path))
    .reduce((sum, f) => sum + f.size, 0);

  // 可选中文件数量（risk_level >= 4 被锁定，不可选）
  const selectableCount = files.filter((f) => f.risk_level <= 3).length;

  const isExpanded = expandedModule === 'bigFiles';
  // 页面模式由当前模块控制可见性，卡片模式则沿用手风琴展开状态，确保操作区跟随各自结果。
  const shouldShowOperationToolbar = layoutMode === 'pages' ? isPageActive : isExpanded;
  const isScanning = moduleState.status === 'scanning';
  const displayElapsedSeconds = isScanning
    ? scanElapsed
    : Math.round(backendElapsedMs / 1000);
  // 当前后端所有进度分支都提供稳定 stage，未知阶段统一回退到本地化提示，避免显示历史中文 message。
  const localizedScanStage = scanStage
    ? t(`bigFilesStages.${scanStage}`, { defaultValue: t('bigFiles.detecting') })
    : t('bigFiles.detecting');
  const displayScanPath = /^[A-Za-z]:[\\/]/.test(currentPath) ? currentPath : '';
  const driveSelector = (
    <div className="flex items-center gap-2 shrink-0" onClick={(event) => event.stopPropagation()}>
      <DriveSelect
        value={selectedDriveLetter}
        drives={drives}
        onChange={handleDriveChange}
        disabled={isScanning}
      />
    </div>
  );

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !isDeleting && !showDeleteConfirm) {
    return null;
  }

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
            <h3 className="text-lg font-semibold text-[var(--fg-primary)]">{t('bigFiles.deleting')}</h3>
              <p className="text-sm text-[var(--fg-muted)] mt-1">
                {t('bigFiles.deletingDesc', { count: selectedFiles.size.toLocaleString() })}
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        title={t('confirmDeleteLargeFiles')}
        description={t('bigFiles.confirmDesc', { count: selectedFiles.size.toLocaleString(), size: formatSize(selectedSize) })}
        warning={t('largeFileDeleteWarning')}
        confirmText={t('confirmDelete')}
        cancelText={t('cancel')}
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
        id="bigFiles"
        title={navT('bigFiles')}
        description={`${navT('bigFilesDesc')} (${selectedDriveLabel})`}
        icon={<FileBox className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'bigFiles')}
        onScan={handleScan}
        error={moduleState.error}
        titleExtra={driveSelector}
        headerExtra={
          <>
            {isScanning && (
              <button
                onClick={handleStopScan}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/20 rounded-lg text-xs font-medium text-amber-600 transition"
              >
                <StopCircle className="w-3.5 h-3.5" />
                {t('stop')}
              </button>
            )}
          </>
        }
        allowStickyContent
      >
        {/* 展开内容 */}
        <div>
          {shouldShowOperationToolbar && files.length > 0 && !isScanning && createPortal(
            // 挂载到 body，避免页面过渡容器的 transform 让 fixed 退化为局部定位。
            <div className="module-operation-toolbar">
              <button
                onClick={toggleSelectAll}
                className="module-operation-toolbar__button module-operation-toolbar__button--muted"
              >
                {selectedFiles.size === selectableCount && selectableCount > 0 ? t('deselectAll') : t('selectAll')}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedFiles.size === 0}
                className="module-operation-toolbar__button module-operation-toolbar__button--danger"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {t('cleanSelected', { count: selectedFiles.size })}
              </button>
            </div>,
            document.body,
          )}

          {/* 扫描进度 + 引擎 + 时长（扫描中 & 扫描完成后都显示） */}
          {(isScanning || scanBackend) && (displayScanPath || localizedScanStage) && (
            <div className={`px-4 py-2 border-b border-[var(--border-default)] text-xs truncate flex items-center gap-3 ${
              scanBackend === 'mft' ? 'bg-[var(--brand-green-10)]' : 'bg-emerald-500/5'
            }`}>
              <span className="truncate text-[var(--fg-muted)]">{isScanning ? t('bigFiles.scanningPrefix') : t('bigFiles.scanCompletedPrefix')} {localizedScanStage}{displayScanPath ? ` · ${displayScanPath}` : ''}</span>
              {scanBackend && (
                <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  scanBackend === 'mft'
                    ? 'bg-[var(--brand-green)] text-white'
                    : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'
                }`}>
                  {scanBackend === 'mft' ? t('bigFiles.mftFullScan') : t('bigFiles.normalScan')}
                </span>
              )}
              <span className="shrink-0 text-[var(--fg-faint)]">{t('fileCount', { count: scannedCount.toLocaleString() })}</span>
              {scanStage && scanBackend === 'mft' && (
                <span className="shrink-0 text-[var(--fg-faint)]">{localizedScanStage}</span>
              )}
              {displayElapsedSeconds > 0 && (
                <span className="shrink-0 text-[var(--fg-faint)]">{displayElapsedSeconds}s</span>
              )}
            </div>
          )}

          {/* 空状态 */}
          {moduleState.status === 'idle' && files.length === 0 && (
            <div className="p-4">
              <EmptyState
                icon={FileBox}
                  title={t('notScannedLargeFiles')}
                description={t('bigFiles.emptyDesc')}
              />
            </div>
          )}

          {/* 扫描中状态 */}
          {isScanning && files.length === 0 && (
            <div className="py-12 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-3">
                <Loader2 className="w-7 h-7 text-emerald-500 animate-spin" />
              </div>
              {/* 扫描引擎模式 — 居中醒目展示 */}
              {scanBackend === 'mft' && (
                <span className="mb-2 px-3 py-1 rounded-full text-xs font-semibold bg-[var(--brand-green-10)] text-[var(--brand-green)] border border-[var(--brand-green-20)]">
                  {t('bigFiles.mftFullScan')}
                </span>
              )}
              <p className="text-sm font-medium text-[var(--fg-secondary)]">
                {scanBackend === 'mft' ? t('bigFiles.mftScanning', { drive: selectedDriveLabel })
                  : scanBackend === 'walkdir' ? t('bigFiles.walkdirScanning', { drive: selectedDriveLabel })
                  : t('scanningShort')}
              </p>
              <p className="text-xs text-[var(--fg-muted)] mt-1">
                {t('bigFiles.engineLabel')}: {scanBackend === 'mft' ? t('bigFiles.mft') : scanBackend === 'walkdir' ? t('bigFiles.walkdir') : t('bigFiles.detecting')}
              </p>
              {(localizedScanStage || displayScanPath) && (
                <p className="text-xs text-[var(--fg-faint)] mt-1 max-w-md truncate">
                  {localizedScanStage}{displayScanPath ? ` · ${displayScanPath}` : ''}
                </p>
              )}
            </div>
          )}

          {/* 文件列表 */}
          {files.length > 0 && (
            <div className="divide-y divide-[var(--border-default)]">
              {files.map((file, index) => {
                const riskLevel = file.risk_level;
                const isSelected = selectedFiles.has(file.path);
                const isLocked = riskLevel >= 4; // 后端风险等级 >= 4，锁定不可删除
                const localizedSourceLabel = getLocalizedSourceLabel(file.source_label, t);

                return (
                  <div
                    key={file.path}
                    onClick={() => toggleFileSelection(file.path, riskLevel)}
                    className={`
                      px-4 py-3 flex items-center gap-3 cursor-pointer transition-all
                      ${isLocked ? 'bg-rose-500/5 cursor-not-allowed' :
                        isSelected ? 'bg-[var(--brand-green-10)] hover:bg-[var(--brand-green-10)]' : 'hover:bg-[var(--bg-hover)]'}
                    `}
                  >
                    {/* 序号 + 复选框 */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="w-5 text-center text-xs font-medium text-[var(--fg-faint)]">
                        {index + 1}
                      </span>
                      <div className={`
                        w-5 h-5 rounded border-2 flex items-center justify-center
                        ${isLocked
                          ? 'border-rose-300 bg-rose-100'
                          : isSelected
                            ? 'bg-[var(--brand-green)] border-[var(--brand-green)] cursor-pointer'
                            : 'border-[var(--text-faint)] cursor-pointer'
                        }
                      `}>
                        {isLocked ? (
                          <svg className="w-3 h-3 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        ) : isSelected ? (
                          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        ) : null}
                      </div>
                    </div>

                    {/* 文件图标 */}
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${getRiskLevelBgColor(riskLevel)}`}>
                      <FileWarning className={`w-4 h-4 ${getRiskLevelColor(riskLevel)}`} />
                    </div>

                    {/* 文件信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-[var(--fg-primary)] truncate font-medium" title={file.path}>
                          {file.path.split('\\').pop() || file.path}
                        </p>
                        {localizedSourceLabel && (
                          <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                            {localizedSourceLabel}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--fg-muted)] truncate mt-0.5" title={file.path}>
                        {file.path}
                      </p>
                    </div>

                    {/* 右侧信息 */}
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-600">{formatSize(file.size)}</p>
                      <div className="flex items-center justify-end gap-2 mt-0.5">
                        <span className="text-[10px] text-[var(--fg-muted)]">{formatDate(file.modified)}</span>
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-semibold ${getRiskLevelColor(riskLevel)} ${getRiskLevelBgColor(riskLevel)}`}>
                          {isLocked ? '🔒 ' : ''}{t(getRiskLevelKey(riskLevel))}
                        </span>
                      </div>
                    </div>

                    {/* 操作按钮 */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSearchFile(file.path);
                        }}
                        className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
                  title={t('searchDeletionAdvice')}
                      >
                        <Search className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openInFolder(file.path);
                        }}
                        className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
                  title={t('openInFolder')}
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyFilePath(file.path);
                        }}
                        className="p-1.5 hover:bg-[var(--bg-hover)] rounded-lg transition text-[var(--fg-muted)] hover:text-emerald-600"
                  title={t('copyFilePath')}
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </ModuleCard>
    </>
  );
}

export default BigFilesModule;
