// ============================================================================
// 多盘全盘变化分析模块
//
// 全盘变化只负责定位空间增减来源，不提供删除能力，避免把“变化目录”误当成“可清理目录”。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  HardDrive,
  Loader2,
  Minus,
  Search,
  XCircle,
  X,
  ChevronRight,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Download,
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import {
  defaultDriveLetter,
  DriveSelect,
  driveDisplayName,
  driveOptionTitle,
  normalizeDriveLetter,
  useLocalDrives,
} from '../ui/DriveSelect';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import { useSettings } from '../../contexts';
import { openSearchUrl } from '../../utils/searchEngine';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';
import {
  checkAdminPrivilege,
  cancelDiskGrowthScan,
  getDiskGrowthDirectoryDetails,
  getDiskGrowthExportTree,
  getDiskGrowthFileDetails,
  openInFolder,
  scanDiskGrowth,
  saveDiskGrowthHtml,
  type DiskGrowthAnalyzeEntry,
  type DiskGrowthDetailEntry,
  type DiskGrowthDirectoryDetailsResponse,
  type DiskGrowthEntry,
  type DiskGrowthFileDetailEntry,
  type DiskGrowthFileDetailsResponse,
  type DiskGrowthReport,
  type DiskGrowthScanProgress,
  type DiskGrowthScanResponse,
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { useToast } from '../Toast';
import { buildDiskGrowthHtml } from '../../utils/diskGrowthHtml';

function simplifyPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `.../${parts.slice(-3).join('/')}`;
}

function formatDiff(diff: number): string {
  const sign = diff >= 0 ? '+' : '-';
  return `${sign}${formatSize(Math.abs(diff))}`;
}

function formatProgressCount(progress: DiskGrowthScanProgress | null): string {
  if (!progress) return '';
  const processed = progress.processed.toLocaleString();
  if (typeof progress.total === 'number' && progress.total > 0) {
    return `${processed} / ${progress.total.toLocaleString()}`;
  }
  return processed;
}

function getPhaseLabel(stage: string): string {
  return i18n.t(`scanStages.${stage}`, {
    ns: 'common',
    defaultValue: i18n.t('scanStages.scanning', { ns: 'common' }),
  });
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPreviousScanTime(scanSummary: DiskGrowthScanResponse): string {
  return scanSummary.previous_scan_time || i18n.t('diskGrowth.noHistory', { ns: 'modules' });
}

function formatModifiedTime(timestamp?: number | null, compact = false): string {
  if (!timestamp) return '-';
  const normalizedTimestamp = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalizedTimestamp);
  if (Number.isNaN(date.getTime())) return '-';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return compact ? `${month}-${day} ${hours}:${minutes}` : `${year}-${month}-${day} ${hours}:${minutes}`;
}

function buildPathTitle(path: string, modified?: number | null, extraLine?: string): string {
  const lines = [path];
  if (extraLine) lines.push(extraLine);
  const modifiedText = formatModifiedTime(modified);
  if (modifiedText !== '-') {
    // title 支持换行，路径很长时把真实修改时间单独放一行，避免关键信息被长路径淹没。
    lines.push(i18n.t('diskGrowth.modifiedTimeTitle', { ns: 'modules', time: modifiedText }));
  }
  return lines.join('\n');
}

function normalizeDiskPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function isDescendantPath(path: string, parentPath: string): boolean {
  const normalizedPath = normalizeDiskPath(path);
  const normalizedParentPath = normalizeDiskPath(parentPath);
  // 仅按完整路径段判断父子关系，避免 C:/data 与 C:/database 发生错误嵌套。
  return normalizedPath.startsWith(`${normalizedParentPath}/`);
}

function buildChildGrowthEntry(parent: DiskGrowthEntry, path: string): DiskGrowthEntry | null {
  const detail = (parent.details ?? []).find((item) => normalizeDiskPath(item.path) === normalizeDiskPath(path));
  if (!detail) return null;
  const style = getGrowthStyle(detail.level);
  const direction = detail.diff > 0
    ? i18n.t('diskGrowth.increase', { ns: 'modules' })
    : i18n.t('diskGrowth.decrease', { ns: 'modules' });
  return {
    path: detail.path,
    old_size: detail.old_size,
    new_size: detail.new_size,
    diff: detail.diff,
    diff_percent: detail.old_size > 0 ? (detail.diff / detail.old_size) * 100 : 100,
    modified: detail.modified,
    level: detail.level,
    explanation: i18n.t('diskGrowth.growthExplanation', {
      ns: 'modules',
      level: style.label,
      direction,
      size: formatSize(Math.abs(detail.diff)),
    }),
    suggestion: i18n.t('diskGrowth.growthSuggestion', { ns: 'modules' }),
    details: [],
  };
}

function getGrowthStyle(level: DiskGrowthEntry['level']) {
  switch (level) {
    case 'significant':
      return { icon: TrendingUp, color: 'text-red-500', label: i18n.t('diskGrowth.level.significant', { ns: 'modules' }) };
    case 'fast':
      return { icon: TrendingUp, color: 'text-orange-500', label: i18n.t('diskGrowth.level.fast', { ns: 'modules' }) };
    case 'minor':
      return { icon: TrendingUp, color: 'text-amber-500', label: i18n.t('diskGrowth.level.minor', { ns: 'modules' }) };
    case 'decreased':
      return { icon: TrendingDown, color: 'text-green-500', label: i18n.t('diskGrowth.level.decreased', { ns: 'modules' }) };
    case 'new':
      return { icon: Sparkles, color: 'text-blue-500', label: i18n.t('diskGrowth.level.new', { ns: 'modules' }) };
    default:
      return { icon: Minus, color: 'text-[var(--text-faint)]', label: i18n.t('diskGrowth.level.stable', { ns: 'modules' }) };
  }
}

function SummaryCards({
  scanSummary,
  growthReport,
  driveLabel,
}: {
  scanSummary: DiskGrowthScanResponse;
  growthReport: DiskGrowthReport;
  driveLabel: string;
}) {
  const { t: moduleT } = useTranslation('modules');
  const totalGrowth = growthReport.total_growth;
  const indexedSizeText = formatSize(scanSummary.total_size);
  const totalGrowthText = totalGrowth === 0 ? moduleT('diskGrowth.noChange') : formatDiff(totalGrowth);
  const previousScanText = formatPreviousScanTime(scanSummary);
  const scannedFileCountText = scanSummary.total_files_scanned.toLocaleString();

  return (
    <div className="grid grid-cols-4 gap-3">
      <div className="min-w-0 bg-[var(--bg-main)] rounded-xl px-3 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1 truncate" title={`${driveLabel} ${moduleT('diskGrowth.indexed')}`}>
          {driveLabel} {moduleT('diskGrowth.indexed')}
        </p>
        <p className="text-base font-bold text-[var(--text-primary)] tabular-nums truncate" title={indexedSizeText}>
          {indexedSizeText}
        </p>
      </div>
      <div className="min-w-0 bg-[var(--bg-main)] rounded-xl px-3 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1 truncate" title={moduleT('diskGrowth.netChange')}>{moduleT('diskGrowth.netChange')}</p>
        <p
          className={`text-base font-bold tabular-nums truncate ${
            totalGrowth > 0
              ? 'text-red-500'
              : totalGrowth < 0
                ? 'text-green-500'
                : 'text-[var(--text-muted)]'
          }`}
          title={totalGrowthText}
        >
          {totalGrowthText}
        </p>
      </div>
      <div className="min-w-0 bg-[var(--bg-main)] rounded-xl px-3 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1 truncate" title={moduleT('diskGrowth.previousScan')}>{moduleT('diskGrowth.previousScan')}</p>
        <p className="text-[13px] font-semibold text-[var(--text-primary)] tabular-nums truncate" title={previousScanText}>
          {previousScanText}
        </p>
      </div>
      <div className="min-w-0 bg-[var(--bg-main)] rounded-xl px-3 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1 truncate" title={moduleT('diskGrowth.fileCount')}>{moduleT('diskGrowth.fileCount')}</p>
        <p className="text-base font-bold text-[var(--brand-green)] tabular-nums truncate" title={scannedFileCountText}>
          {scannedFileCountText}
        </p>
      </div>
      {growthReport.entries.length > 0 && (
        <div className="col-span-4 flex items-center gap-3 text-[12px] text-[var(--text-muted)] min-w-0 overflow-hidden whitespace-nowrap">
          <span className="text-red-500">{moduleT('diskGrowth.increased', { size: formatSize(scanSummary.analyze.increased_size ?? 0) })}</span>
          <span className="text-green-500">{moduleT('diskGrowth.decreased', { size: formatSize(scanSummary.analyze.decreased_size ?? 0) })}</span>
          <span className="truncate">{moduleT('diskGrowth.sorted')}</span>
        </div>
      )}
    </div>
  );
}

function DiagnosticBanner({ report }: { report: DiskGrowthReport }) {
  const hasGrowth = report.significant_count > 0 || report.fast_count > 0;

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-xl text-[13px] ${
        hasGrowth
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
      }`}
    >
      {hasGrowth ? (
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
      )}
      <span>{report.summary}</span>
    </div>
  );
}

function DiskGrowthDiagnostics({
  scanSummary,
  resultMode,
  maxEntries,
}: {
  scanSummary: DiskGrowthScanResponse;
  resultMode: 'change' | 'usage';
  maxEntries: number;
}) {
  const { t: moduleT } = useTranslation('modules');
  // 与大目录分析复用同一类诊断布局，让用户在不同 MFT 模块里看到一致的阶段耗时信息。
  const hasPhaseDurations = scanSummary.phase_durations.length > 0;
  const latestPhase = hasPhaseDurations
    ? scanSummary.phase_durations[scanSummary.phase_durations.length - 1]
    : null;

  return (
    <div className="rounded-xl bg-[var(--bg-main)] border border-[var(--border-color)] px-4 py-3 text-xs space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 md:gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 px-2 py-0.5 rounded-md bg-[var(--brand-green)] text-white font-medium">
            {latestPhase ? getPhaseLabel(latestPhase.stage) : moduleT('diskGrowth.completed')}
          </span>
          <span className="truncate text-[var(--text-primary)]">
            {resultMode === 'change'
              ? moduleT('diskGrowthExtra.changeSummary', { count: maxEntries })
              : moduleT('diskGrowthExtra.baselineSummary')}
          </span>
        </div>
        <div className="flex items-center justify-start md:justify-end gap-4 text-[var(--text-muted)] tabular-nums">
          <span>{moduleT('diskGrowth.processed', { count: scanSummary.total_files_scanned.toLocaleString() })}</span>
          <span>{moduleT('diskGrowth.elapsed', { time: formatDuration(scanSummary.scan_duration_ms) })}</span>
        </div>
      </div>

      {hasPhaseDurations && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {scanSummary.phase_durations.map((phase, index) => (
            <div
              key={`${phase.stage}-${index}`}
              className="min-w-0 rounded-lg bg-[var(--bg-card)] border border-[var(--border-color)] px-2.5 py-2"
            >
              <div className="truncate text-[var(--text-muted)]">{getPhaseLabel(phase.stage)}</div>
              <div className="mt-0.5 text-[var(--text-primary)] font-semibold tabular-nums">
                {formatDuration(phase.duration_ms)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-[var(--text-faint)]">
        <span>{moduleT('diskGrowth.engine', { name: scanSummary.backend === 'mft' ? 'MFT' : scanSummary.backend })}</span>
        <span>
          {moduleT('diskGrowth.sizeSource', { mft: scanSummary.mft_size_count.toLocaleString(), fallback: scanSummary.metadata_fallback_count.toLocaleString() })}
        </span>
      </div>
    </div>
  );
}

function entryFromGrowth(growth: DiskGrowthEntry): DiskGrowthAnalyzeEntry {
  return {
    path: growth.path,
    size: growth.new_size,
    category: '变化目录',
    modified: growth.modified,
    risk: 'safe',
    action: 'ignore',
    reason: growth.explanation,
    suggestion: growth.suggestion,
    matched_rule_id: null,
    tags: [],
  };
}

function ChangeRow({
  entry,
  growth,
  onOpenFolder,
  onSearchPath,
  onShowDetails,
}: {
  entry: DiskGrowthAnalyzeEntry;
  growth: DiskGrowthEntry | null;
  onOpenFolder: (path: string) => void;
  onSearchPath: (path: string) => void;
  onShowDetails: (growth: DiskGrowthEntry) => void;
}) {
  const { t: moduleT } = useTranslation('modules');
  const style = growth ? getGrowthStyle(growth.level) : getGrowthStyle('stable');
  const Icon = style.icon;
  const diff = growth?.diff ?? 0;
  const modified = growth?.modified ?? entry.modified;
  const modifiedTimeLabel = formatModifiedTime(modified, true);
  const modifiedTimeTitle = formatModifiedTime(modified);
  const rowTitle = buildPathTitle(entry.path, modified, growth?.explanation ?? entry.reason);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors group">
      <div
        className={`w-1.5 h-8 rounded-full shrink-0 ${
          diff > 0 ? 'bg-red-400' : diff < 0 ? 'bg-green-400' : 'bg-gray-300'
        }`}
      />

      <div className="flex-1 min-w-0">
        <p
          className="text-[13px] text-[var(--text-primary)] truncate cursor-pointer hover:text-[var(--brand-green)] transition-colors"
          title={rowTitle}
          onClick={() => onOpenFolder(entry.path)}
        >
          {simplifyPath(entry.path)}
        </p>
        <p className="text-[11px] text-[var(--text-faint)] mt-0.5 truncate">
          {growth?.explanation ?? entry.reason}
        </p>
      </div>

      <span
        className="w-20 text-center text-[11px] text-[var(--text-muted)] tabular-nums shrink-0"
        title={modifiedTimeTitle === '-'
          ? moduleT('diskGrowth.modifiedTimeMissing')
          : moduleT('diskGrowth.modifiedTimeTitle', { time: modifiedTimeTitle })}
      >
        {modifiedTimeLabel}
      </span>

      <span className={`flex items-center gap-1 w-24 justify-end text-[12px] shrink-0 ${style.color}`}>
        <Icon className="w-3.5 h-3.5" />
        {style.label}
      </span>

      <span className="text-[13px] font-medium text-[var(--text-primary)] tabular-nums w-20 text-right shrink-0">
        {formatSize(entry.size)}
      </span>

      <button
        onClick={() => growth && onShowDetails(growth)}
        disabled={!growth}
        className={`text-[13px] font-medium tabular-nums w-24 text-right shrink-0 ${style.color} ${
          growth ? 'hover:underline underline-offset-4 cursor-pointer' : 'cursor-default'
        }`}
        title={growth ? moduleT('diskGrowth.viewDetails') : undefined}
      >
        {diff === 0 ? '-' : formatDiff(diff)}
      </button>

      <div className="flex w-16 shrink-0 justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
        <button
          onClick={() => onSearchPath(entry.path)}
          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition"
          title={moduleT('diskGrowth.searchPath')}
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={() => onOpenFolder(entry.path)}
          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition"
          title={moduleT('diskGrowth.openFolder')}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function DiskGrowthDetailsModal({
  entry,
  driveLetter,
  onClose,
  onOpenFolder,
}: {
  entry: DiskGrowthEntry | null;
  driveLetter: string;
  onClose: () => void;
  onOpenFolder: (path: string) => void;
}) {
  const { t: moduleT } = useTranslation('modules');
  const [currentEntry, setCurrentEntry] = useState<DiskGrowthEntry | null>(entry);
  const [fileDetails, setFileDetails] = useState<DiskGrowthFileDetailsResponse | null>(null);
  const [directoryDetails, setDirectoryDetails] = useState<DiskGrowthDirectoryDetailsResponse | null>(null);
  const [fileRows, setFileRows] = useState<DiskGrowthFileDetailEntry[]>([]);
  const [directoryRows, setDirectoryRows] = useState<DiskGrowthDetailEntry[]>([]);
  const [fileLoading, setFileLoading] = useState(false);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const fileScrollRef = useRef<HTMLDivElement | null>(null);
  const directoryScrollRef = useRef<HTMLDivElement | null>(null);
  const rootPath = entry?.path ?? '';
  const currentPath = currentEntry?.path ?? rootPath;
  const detailPageSize = 200;

  useEffect(() => {
    setCurrentEntry(entry);
  }, [entry]);

  useEffect(() => {
    if (!currentEntry) return;

    let cancelled = false;
    setFileDetails(null);
    setDirectoryDetails(null);
    setFileRows([]);
    setDirectoryRows([]);
    setFileError(null);
    setDirectoryError(null);
    setFileLoading(true);
    setDirectoryLoading(true);

    // 文件级明细按需懒加载，避免主扫描结果一次性携带几十万文件记录。
    getDiskGrowthFileDetails(currentEntry.path, 0, detailPageSize, driveLetter)
      .then((result) => {
        if (!cancelled) {
          setFileDetails(result);
          setFileRows(result.entries);
        }
      })
      .catch((err) => {
        if (!cancelled) setFileError(String(err));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });

    // 目录明细也按当前目录懒加载，避免主结果只带少量 details 时无法继续分页。
    getDiskGrowthDirectoryDetails(currentEntry.path, 0, detailPageSize, driveLetter)
      .then((result) => {
        if (!cancelled) {
          setDirectoryDetails(result);
          setDirectoryRows(result.entries);
        }
      })
      .catch((err) => {
        if (!cancelled) setDirectoryError(String(err));
      })
      .finally(() => {
        if (!cancelled) setDirectoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentEntry, driveLetter]);

  const fileVirtualizer = useVirtualizer({
    count: fileRows.length,
    getScrollElement: () => fileScrollRef.current,
    estimateSize: () => 58,
    overscan: 8,
  });
  const directoryVirtualizer = useVirtualizer({
    count: directoryRows.length,
    getScrollElement: () => directoryScrollRef.current,
    estimateSize: () => 58,
    overscan: 8,
  });

  if (!entry || !currentEntry) return null;

  const style = getGrowthStyle(currentEntry.level);
  const rootNormalized = normalizeDiskPath(rootPath);
  const currentNormalized = normalizeDiskPath(currentPath);
  const relativeParts = currentNormalized.startsWith(rootNormalized)
    ? currentPath
        .slice(rootPath.length)
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
    : [];
  const breadcrumbItems = [
    { label: rootPath, path: rootPath },
    ...relativeParts.map((part, index) => ({
      label: part,
      path: `${rootPath.replace(/\/+$/g, '')}/${relativeParts.slice(0, index + 1).join('/')}`,
    })),
  ];
  const handleEnterDirectory = (path: string) => {
    const childEntry = buildChildGrowthEntry(
      { ...currentEntry, details: directoryRows.length > 0 ? directoryRows : currentEntry.details },
      path
    );
    if (childEntry) setCurrentEntry(childEntry);
  };
  const loadMoreFiles = async () => {
    if (!currentEntry || fileLoading || !fileDetails?.has_more) return;
    setFileLoading(true);
    try {
      const result = await getDiskGrowthFileDetails(currentEntry.path, fileRows.length, detailPageSize, driveLetter);
      setFileDetails(result);
      setFileRows((rows) => [...rows, ...result.entries]);
    } catch (err) {
      setFileError(String(err));
    } finally {
      setFileLoading(false);
    }
  };
  const loadMoreDirectories = async () => {
    if (!currentEntry || directoryLoading || !directoryDetails?.has_more) return;
    setDirectoryLoading(true);
    try {
      const result = await getDiskGrowthDirectoryDetails(currentEntry.path, directoryRows.length, detailPageSize, driveLetter);
      setDirectoryDetails(result);
      setDirectoryRows((rows) => [...rows, ...result.entries]);
    } catch (err) {
      setDirectoryError(String(err));
    } finally {
      setDirectoryLoading(false);
    }
  };
  // 弹窗必须挂到 body 下，避免被页面模式外层 motion transform 改写 fixed 定位的参照物。
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onClick={onClose}
    >
      <motion.div
        className="w-[1040px] max-w-[calc(100vw-32px)] h-[90vh] max-h-[calc(100vh-32px)] rounded-2xl bg-[var(--bg-card)] shadow-2xl border border-[var(--border-color)] overflow-hidden flex flex-col"
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{moduleT('diskGrowth.details')}</h3>
            <div className="mt-1 flex items-center gap-1 text-xs text-[var(--text-muted)] min-w-0">
              {breadcrumbItems.map((item, index) => (
                <div key={item.path} className="flex items-center gap-1 min-w-0">
                  {index > 0 && <ChevronRight className="w-3 h-3 shrink-0 text-[var(--text-faint)]" />}
                  <button
                    onClick={() => {
                      if (index === 0) {
                        setCurrentEntry(entry);
                        return;
                      }
                      const childEntry = buildChildGrowthEntry(entry, item.path);
                      if (childEntry) setCurrentEntry(childEntry);
                    }}
                    className="truncate hover:text-[var(--brand-green)] transition-colors"
                    title={item.path}
                  >
                    {index === 0 ? item.label : item.label}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="grid grid-cols-3 gap-3 shrink-0">
            <div className="rounded-xl bg-[var(--bg-main)] px-3 py-2">
              <p className="text-[11px] text-[var(--text-muted)]">{moduleT('diskGrowth.previousSize')}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--text-primary)] tabular-nums">
                {formatSize(currentEntry.old_size)}
              </p>
            </div>
            <div className="rounded-xl bg-[var(--bg-main)] px-3 py-2">
              <p className="text-[11px] text-[var(--text-muted)]">{moduleT('diskGrowth.currentSize')}</p>
              <p className="mt-1 text-sm font-semibold text-[var(--text-primary)] tabular-nums">
                {formatSize(currentEntry.new_size)}
              </p>
            </div>
            <div className="rounded-xl bg-[var(--bg-main)] px-3 py-2">
              <p className="text-[11px] text-[var(--text-muted)]">{moduleT('diskGrowth.difference')}</p>
              <p className={`mt-1 text-sm font-semibold tabular-nums ${style.color}`}>
                {formatDiff(currentEntry.diff)}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-h-0">
            <div className="rounded-xl bg-[var(--bg-main)] border border-[var(--border-color)] overflow-hidden min-w-0 min-h-0 flex flex-col">
              <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-color)] text-[11px] text-[var(--text-faint)] shrink-0">
                <span className="flex-1">{moduleT('diskGrowth.subdirectories')}</span>
                <span className="w-20 text-right">{moduleT('diskGrowth.currentSize')}</span>
                <span className="w-24 text-right">{moduleT('diskGrowth.difference')}</span>
                <span className="w-16" />
              </div>
              <div ref={directoryScrollRef} className="flex-1 min-h-0 overflow-auto">
                {directoryError ? (
                  <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">{directoryError}</div>
                ) : directoryRows.length > 0 ? (
                  <div style={{ height: `${directoryVirtualizer.getTotalSize()}px`, position: 'relative' }}>
                    {directoryVirtualizer.getVirtualItems().map((virtualItem) => {
                      const detail = directoryRows[virtualItem.index];
                      if (!detail) return null;
                      const detailStyle = getGrowthStyle(detail.level);
                      return (
                        <div
                          key={detail.path}
                          className="absolute left-0 top-0 w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors"
                          style={{ transform: `translateY(${virtualItem.start}px)`, height: `${virtualItem.size}px` }}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] text-[var(--text-primary)] truncate" title={buildPathTitle(detail.path, detail.modified)}>{detail.name}</p>
                            <p className="text-[11px] text-[var(--text-faint)] truncate" title={buildPathTitle(detail.path, detail.modified)}>{detail.path}</p>
                          </div>
                          <span className="w-20 text-right text-[13px] font-medium text-[var(--text-primary)] tabular-nums">{formatSize(detail.new_size)}</span>
                          <span className={`w-24 text-right text-[13px] font-medium tabular-nums ${detailStyle.color}`}>{formatDiff(detail.diff)}</span>
                          <div className="w-16 flex justify-end gap-0.5">
                            <button onClick={() => onOpenFolder(detail.path)} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition" title={moduleT('diskGrowth.openFolder')}>
                              <FolderOpen className="w-4 h-4" />
                            </button>
                            <button onClick={() => handleEnterDirectory(detail.path)} className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition" title={moduleT('diskGrowth.enterDirectory')}>
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : directoryLoading ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-[var(--text-muted)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--brand-green)]" />
                    {moduleT('diskGrowth.loadingDirectories')}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">{moduleT('diskGrowth.noDirectories')}</div>
                )}
              </div>
              {directoryDetails && (
                <div className="flex items-center justify-between gap-3 border-t border-[var(--border-color)] px-4 py-2 text-xs text-[var(--text-faint)] shrink-0">
                  <span>{moduleT('diskGrowth.showing', { current: directoryRows.length, total: directoryDetails.total_changed_dirs })}</span>
                  {directoryDetails.has_more ? (
                    <button onClick={loadMoreDirectories} disabled={directoryLoading} className="text-[var(--brand-green)] hover:text-[var(--brand-green-hover)] disabled:opacity-60 transition-colors">
                      {directoryLoading ? moduleT('diskGrowth.loading') : moduleT('diskGrowth.loadMoreDirectories')}
                    </button>
                  ) : (
                    <span>{moduleT('diskGrowth.loadedAll')}</span>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-xl bg-[var(--bg-main)] border border-[var(--border-color)] overflow-hidden min-w-0 min-h-0 flex flex-col">
              <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-color)] text-[11px] text-[var(--text-faint)] shrink-0">
                <span className="flex-1">{moduleT('diskGrowth.files')}</span>
                <span className="w-20 text-right">{moduleT('diskGrowth.currentSize')}</span>
                <span className="w-24 text-right">{moduleT('diskGrowth.difference')}</span>
                <span className="w-10" />
              </div>
              <div ref={fileScrollRef} className="flex-1 min-h-0 overflow-auto">
                {fileError ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm text-[var(--text-muted)]">{moduleT('diskGrowth.fileDetailsUnavailable')}</p>
                    <p className="mt-1 text-xs text-[var(--text-faint)]">{fileError}</p>
                  </div>
                ) : fileRows.length > 0 ? (
                  <div style={{ height: `${fileVirtualizer.getTotalSize()}px`, position: 'relative' }}>
                    {fileVirtualizer.getVirtualItems().map((virtualItem) => {
                      const file = fileRows[virtualItem.index];
                      if (!file) return null;
                      const fileStyle = getGrowthStyle(file.level);
                      return (
                        <div
                          key={file.path}
                          className="absolute left-0 top-0 w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors"
                          style={{ transform: `translateY(${virtualItem.start}px)`, height: `${virtualItem.size}px` }}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] text-[var(--text-primary)] truncate" title={buildPathTitle(file.path, file.modified)}>{file.name}</p>
                            <p className="text-[11px] text-[var(--text-faint)] truncate" title={buildPathTitle(file.path, file.modified)}>{file.path}</p>
                          </div>
                          <span className="w-20 text-right text-[13px] font-medium text-[var(--text-primary)] tabular-nums">{formatSize(file.new_size)}</span>
                          <span className={`w-24 text-right text-[13px] font-medium tabular-nums ${fileStyle.color}`}>{formatDiff(file.diff)}</span>
                          <button onClick={() => onOpenFolder(file.path)} className="w-10 flex justify-end p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] transition" title={moduleT('diskGrowth.openLocation')}>
                            <FolderOpen className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : fileLoading ? (
                  <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-[var(--text-muted)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--brand-green)]" />
                    {moduleT('diskGrowth.loadingFiles')}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">{moduleT('diskGrowth.noFiles')}</div>
                )}
              </div>
              {fileDetails && (
                <div className="flex items-center justify-between gap-3 border-t border-[var(--border-color)] px-4 py-2 text-xs text-[var(--text-faint)] shrink-0">
                  <span>{moduleT('diskGrowth.showing', { current: fileRows.length, total: fileDetails.total_changed_files })}</span>
                  {fileDetails.has_more ? (
                    <button onClick={loadMoreFiles} disabled={fileLoading} className="text-[var(--brand-green)] hover:text-[var(--brand-green-hover)] disabled:opacity-60 transition-colors">
                      {fileLoading ? moduleT('diskGrowth.loading') : moduleT('diskGrowth.loadMoreFiles')}
                    </button>
                  ) : (
                    <span>{moduleT('diskGrowth.loadedAll')}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <p className="text-[11px] text-[var(--text-faint)] shrink-0">
            {moduleT('diskGrowth.detailNote', { count: detailPageSize })}
          </p>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

export function DiskGrowthModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger, stopScanTrigger } = useModuleDashboard('diskGrowth');
  const { settings } = useSettings();
  const { showToast } = useToast();
  const lastScanTriggerRef = useRef(0);
  const scanningRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const scanRunIdRef = useRef(0);

  const [scanSummary, setScanSummary] = useState<DiskGrowthScanResponse | null>(null);
  const [growthReport, setGrowthReport] = useState<DiskGrowthReport | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [scanElapsed, setScanElapsed] = useState(0);
  const [scanProgress, setScanProgress] = useState<DiskGrowthScanProgress | null>(null);
  const [detailEntry, setDetailEntry] = useState<DiskGrowthEntry | null>(null);
  const { drives, error: drivesError } = useLocalDrives();
  const [selectedDriveLetter, setSelectedDriveLetter] = useState('C:');

  const isExpanded = expandedModule === 'disk-growth';
  const selectedDrive = drives.find((drive) => drive.drive_letter === selectedDriveLetter) ?? null;
  const selectedDriveLabel = driveDisplayName(selectedDriveLetter);

  const resetCurrentDriveResult = useCallback(() => {
    setScanSummary(null);
    setGrowthReport(null);
    setScanProgress(null);
    setShowAll(false);
    setDetailEntry(null);
    setError(null);
    updateModuleState('diskGrowth', { status: 'idle', error: null, fileCount: 0, totalSize: 0, progress: 0 });
  }, [updateModuleState]);

  useEffect(() => {
    let cancelled = false;
    checkAdminPrivilege()
      .then((result) => {
        if (!cancelled) setIsAdmin(result);
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  useEffect(() => {
    if (moduleState.status !== 'scanning') {
      setScanElapsed(0);
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setScanElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [moduleState.status]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    listen<DiskGrowthScanProgress>('disk-growth:progress', (event) => {
      if (!cancelled) setScanProgress(event.payload);
    }).then((handler) => {
      if (cancelled) {
        handler();
      } else {
        unlisten = handler;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;
    if (isAdmin === false) {
      const message = moduleT('diskGrowth.adminScanError', { drive: selectedDriveLabel });
      setError(message);
      updateModuleState('diskGrowth', { status: 'error', error: message });
      return;
    }
    if (selectedDrive && !selectedDrive.is_ntfs) {
      const message = moduleT('diskGrowth.ntfsScanError', { drive: selectedDriveLabel, fileSystem: selectedDrive.file_system || moduleT('diskGrowth.unknownFileSystem') });
      setError(message);
      updateModuleState('diskGrowth', { status: 'error', error: message });
      return;
    }
    scanningRef.current = true;
    cancelRequestedRef.current = false;
    const scanRunId = ++scanRunIdRef.current;

    updateModuleState('diskGrowth', { status: 'scanning', error: null, fileCount: 0, totalSize: 0 });
    setError(null);
    setScanSummary(null);
    setGrowthReport(null);
    setScanProgress(null);
    setShowAll(false);
    setDetailEntry(null);

    try {
      const result = await scanDiskGrowth(settings.diskGrowthMaxEntries, selectedDriveLetter);
      if (cancelRequestedRef.current || scanRunId !== scanRunIdRef.current) {
        // 用户取消后不接收可能已经返回的旧结果，避免把被中断的扫描写成正常完成。
        return;
      }
      setScanSummary(result);
      setGrowthReport(result.growth);
      updateModuleState('diskGrowth', {
        status: 'done',
        fileCount: result.growth.entries.length,
        totalSize: Math.abs(result.growth.total_growth),
      });
    } catch (err) {
      if (cancelRequestedRef.current || scanRunId !== scanRunIdRef.current) {
        updateModuleState('diskGrowth', { status: 'idle', progress: 0 });
        return;
      }
      const message = String(err);
      setError(message);
      updateModuleState('diskGrowth', { status: 'error', error: message });
    } finally {
      if (scanRunId === scanRunIdRef.current) {
        scanningRef.current = false;
      }
    }
  }, [isAdmin, selectedDrive, selectedDriveLabel, selectedDriveLetter, settings.diskGrowthMaxEntries, updateModuleState, moduleT]);

  const handleStopScan = useCallback(async () => {
    cancelRequestedRef.current = true;
    scanRunIdRef.current += 1;
    scanningRef.current = false;
    updateModuleState('diskGrowth', { status: 'idle', progress: 0 });
    setScanProgress(null);
    try {
      await cancelDiskGrowthScan();
    } catch (err) {
      console.error('停止全盘分析失败:', err);
    }
  }, [updateModuleState]);

  const handleDriveChange = useCallback((driveLetter: string) => {
    if (scanningRef.current) return;
    setSelectedDriveLetter(normalizeDriveLetter(driveLetter));
    resetCurrentDriveResult();
  }, [resetCurrentDriveResult]);

  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  useEffect(() => {
    if (stopScanTrigger > 0 && scanningRef.current) {
      // 全局停止按钮已发后端取消信号；本地只标记取消，避免旧扫描结果回写 UI。
      cancelRequestedRef.current = true;
      scanRunIdRef.current += 1;
      scanningRef.current = false;
      setScanProgress(null);
    }
  }, [stopScanTrigger]);

  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await openInFolder(path);
    } catch (err) {
      console.error('打开目录失败:', err);
    }
  }, []);

  const handleSearchPath = useCallback(async (path: string) => {
    try {
      // 变化目录不等于可清理目录，搜索文案先确认用途，再辅助判断是否可删。
      await openSearchUrl(`${moduleT('diskGrowth.searchQueryPrefix')} ${path} ${moduleT('diskGrowth.searchQuerySuffix')}`);
    } catch (err) {
      console.error('搜索路径用途失败:', err);
    }
  }, []);

  const handleShowDetails = useCallback((entry: DiskGrowthEntry) => {
    setDetailEntry(entry);
  }, []);

  const handleCloseDetails = useCallback(() => {
    setDetailEntry(null);
  }, []);

  const handleExportHtml = useCallback(async () => {
    if (!scanSummary || !growthReport) return;

    try {
      // 只为当前结果一次性获取多级目录树，避免逐条请求造成不必要的 IPC 和快照读取。
      const exportTree = growthReport.entries.length > 0
        ? await getDiskGrowthExportTree(
            growthReport.entries
              .filter((entry) => !growthReport.entries.some((parent) => parent !== entry && isDescendantPath(entry.path, parent.path)))
              .map((entry) => entry.path),
            3,
            scanSummary.drive_letter,
          )
        : { nodes: [], total_nodes: 0, truncated: false };
      const labels = {
        title: moduleT('diskGrowth.exportHtmlTitle'),
        generatedAt: moduleT('diskGrowth.exportGeneratedAt'),
        drive: moduleT('diskGrowth.exportDrive'),
        scanMode: moduleT('diskGrowth.exportScanMode'),
        changeMode: moduleT('diskGrowth.exportChangeMode'),
        baselineMode: moduleT('diskGrowth.exportBaselineMode'),
        currentSize: moduleT('diskGrowth.currentSize'),
        netChange: moduleT('diskGrowth.netChange'),
        noHistory: moduleT('diskGrowth.noHistory'),
        previousScan: moduleT('diskGrowth.previousScan'),
        currentScan: moduleT('diskGrowth.exportCurrentScan'),
        scannedFiles: moduleT('diskGrowth.fileCount'),
        resultCount: moduleT('diskGrowth.exportResultCount'),
        truncatedNote: moduleT('diskGrowth.exportTruncatedNote'),
        path: moduleT('diskGrowth.path'),
        changeTime: moduleT('diskGrowth.changeTime'),
        level: moduleT('diskGrowth.changeLevel'),
        size: moduleT('diskGrowth.currentSizeHeader'),
        difference: moduleT('diskGrowth.differenceHeader'),
        previousSize: moduleT('diskGrowth.previousSize'),
        children: moduleT('diskGrowth.subdirectories'),
        explanation: moduleT('diskGrowth.exportExplanation'),
        suggestion: moduleT('diskGrowth.exportSuggestion'),
        noResult: moduleT('diskGrowth.noChange'),
        depthNote: moduleT('diskGrowth.exportDepthNote'),
        scopeTitle: moduleT('diskGrowth.exportScopeTitle'),
        changeScopeNote: moduleT('diskGrowth.exportChangeScopeNote'),
        baselineScopeNote: moduleT('diskGrowth.exportBaselineScopeNote'),
        levels: {
          significant: moduleT('diskGrowth.level.significant'),
          fast: moduleT('diskGrowth.level.fast'),
          minor: moduleT('diskGrowth.level.minor'),
          stable: moduleT('diskGrowth.level.stable'),
          decreased: moduleT('diskGrowth.level.decreased'),
          new: moduleT('diskGrowth.level.new'),
        },
      };
      const content = buildDiskGrowthHtml(scanSummary, growthReport, exportTree.nodes, {
        labels,
        locale: i18n.language,
        exportTotalNodes: exportTree.total_nodes,
        exportTruncated: exportTree.truncated,
      });
      const reportDate = new Date().toISOString().slice(0, 10);
      const savedPath = await saveDiskGrowthHtml(
        content,
        `LightC_disk_growth_${scanSummary.drive_letter.replace(':', '')}_${reportDate}.html`,
        labels.title,
      );
      if (savedPath) {
        showToast({
          type: 'success',
          title: moduleT('diskGrowth.exportHtmlSuccess'),
          description: savedPath,
        });
      }
    } catch (err) {
      showToast({
        type: 'error',
        title: moduleT('diskGrowth.exportHtmlFailed'),
        description: String(err),
      });
    }
  }, [growthReport, moduleT, scanSummary, showToast]);

  const growthMap = useMemo(() => {
    const map = new Map<string, DiskGrowthEntry>();
    for (const entry of growthReport?.entries ?? []) {
      map.set(entry.path.toLowerCase().replace(/\\/g, '/'), entry);
    }
    return map;
  }, [growthReport]);

  const entries = growthReport?.entries.length
    ? growthReport.entries.map(entryFromGrowth)
    : scanSummary?.analyze.entries ?? [];
  const resultMode = growthReport?.entries.length ? 'change' : 'usage';
  const displayedEntries = showAll ? entries : entries.slice(0, 20);
  const hasMore = entries.length > displayedEntries.length;
  const driveSelector = (
    <div className="flex items-center gap-2 shrink-0" onClick={(event) => event.stopPropagation()}>
      <DriveSelect
        value={selectedDriveLetter}
        drives={drives}
        onChange={handleDriveChange}
        disabled={moduleState.status === 'scanning'}
      />
    </div>
  );

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !detailEntry) {
    return null;
  }

  return (
    <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
      id="disk-growth"
        title={navT('diskGrowth')}
        description={`${navT('diskGrowthDesc')} (${selectedDriveLabel})`}
      icon={<HardDrive className="w-5 h-5 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      countLabel={moduleT('diskGrowth.countLabel')}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'disk-growth')}
      onScan={handleScan}
      scanButtonText={moduleT('diskGrowth.scan')}
      scanDisabled={isAdmin === false || Boolean(selectedDrive && !selectedDrive.is_ntfs)}
      titleExtra={driveSelector}
      error={error}
    >
      <div className="mx-4 mt-4 flex flex-col gap-2 rounded-xl bg-[var(--bg-main)] px-4 py-3 text-[12px] text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between">
        <span title={selectedDrive ? driveOptionTitle(selectedDrive) : selectedDriveLabel}>
          {moduleT('diskGrowth.analyzingDrive', { drive: selectedDriveLabel })}
          {selectedDrive?.volume_name ? ` · ${selectedDrive.volume_name}` : ''}
          {selectedDrive?.file_system ? ` · ${selectedDrive.file_system}` : ''}
        </span>
        {selectedDrive ? (
          <span className="tabular-nums">
            {moduleT('diskGrowth.driveSpace', { free: formatSize(selectedDrive.free_space), total: formatSize(selectedDrive.total_space) })}
          </span>
        ) : drivesError ? (
          <span className="text-amber-600 dark:text-amber-400">{moduleT('diskGrowth.drivesError')}</span>
        ) : (
          <span>{moduleT('diskGrowth.loadingDrives')}</span>
        )}
      </div>

      {isAdmin === false && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{moduleT('diskGrowth.adminHint')}</span>
        </div>
      )}

      {selectedDrive && !selectedDrive.is_ntfs && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-xl bg-amber-500/10 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{moduleT('diskGrowth.ntfsHint')}</span>
        </div>
      )}

      {moduleState.status === 'idle' && !scanSummary && !growthReport && (
        <div className="p-4">
          <EmptyState
            icon={HardDrive}
            title={moduleT('diskGrowth.idleTitle', { drive: selectedDriveLabel })}
            description={moduleT('diskGrowth.idleDesc', { drive: selectedDriveLabel })}
          />
        </div>
      )}

      {moduleState.status === 'scanning' && (
        <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-green)] mb-3" />
          <p className="text-sm">{scanProgress ? getPhaseLabel(scanProgress.stage) : i18n.t('scanStages.mftEnumerate', { ns: 'common', drive: selectedDriveLabel })}</p>
          <p className="text-xs text-[var(--text-muted)] mt-1 tabular-nums">
            {i18n.t('scanStages.elapsed', { ns: 'common', time: `${scanElapsed}s` })}
          </p>
          {scanProgress && (
            <p className="text-xs text-[var(--text-faint)] mt-1 tabular-nums">
              {getPhaseLabel(scanProgress.stage)} {formatProgressCount(scanProgress)}
            </p>
          )}
          <p className="text-xs text-[var(--text-faint)] mt-1">
            {moduleT('diskGrowth.firstScanHint')}
          </p>
          <button
            onClick={handleStopScan}
            className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
              bg-red-50 dark:bg-red-900/20 text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30
              border border-red-200 dark:border-red-800/30 transition-colors"
          >
            <XCircle className="w-3.5 h-3.5" />
            {moduleT('diskGrowth.stop')}
          </button>
        </div>
      )}

      {moduleState.status === 'done' && scanSummary && growthReport && (
        <div className="p-4 space-y-4">
          <SummaryCards scanSummary={scanSummary} growthReport={growthReport} driveLabel={driveDisplayName(scanSummary.drive_letter)} />
          <DiagnosticBanner report={growthReport} />

          <div className="flex items-center justify-between">
            <p className="text-[13px] text-[var(--text-muted)]">{moduleT('diskGrowth.resultCount', { count: entries.length })}</p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleExportHtml}
                className="flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                title={moduleT('diskGrowth.exportHtml')}
              >
                <Download className="h-3.5 w-3.5" />
                <span>{moduleT('diskGrowth.exportHtml')}</span>
              </button>
              <span className="text-[12px] text-[var(--text-faint)]">{isAdmin ? moduleT('diskGrowth.adminMode') : moduleT('diskGrowth.nonAdminMode')}</span>
            </div>
          </div>
          <DiskGrowthDiagnostics
            scanSummary={scanSummary}
            resultMode={resultMode}
            maxEntries={settings.diskGrowthMaxEntries}
          />

          <div className="bg-[var(--bg-main)] rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-color)] text-[11px] text-[var(--text-faint)] uppercase tracking-wider">
              <div className="w-1.5 shrink-0" />
              <div className="flex-1">{moduleT('diskGrowth.path')}</div>
              <div className="w-20 shrink-0 text-center">{moduleT('diskGrowth.changeTime')}</div>
              <div className="w-24 shrink-0 text-right">{moduleT('diskGrowth.changeLevel')}</div>
              <div className="w-20 shrink-0 text-right">{moduleT('diskGrowth.currentSizeHeader')}</div>
              <div className="w-24 shrink-0 text-right">{moduleT('diskGrowth.differenceHeader')}</div>
              <div className="w-16 shrink-0" />
            </div>

            {displayedEntries.map((entry) => {
              const normalizedPath = entry.path.toLowerCase().replace(/\\/g, '/');
              return (
                <ChangeRow
                  key={entry.path}
                  entry={entry}
                  growth={growthMap.get(normalizedPath) ?? null}
                  onOpenFolder={handleOpenFolder}
                  onSearchPath={handleSearchPath}
                  onShowDetails={handleShowDetails}
                />
              );
            })}

            {hasMore && (
              <button
                onClick={() => setShowAll(true)}
                className="w-full py-3 text-center text-[13px] text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                {moduleT('diskGrowth.showAll', { count: entries.length })}
              </button>
            )}

            {entries.length === 0 && (
              <div className="p-4">
                <EmptyState
                  icon={HardDrive}
                  title={moduleT('diskGrowth.firstSnapshot')}
                  description={moduleT('diskGrowth.firstSnapshotDesc')}
                  tone="success"
                  compact
                />
              </div>
            )}
          </div>
        </div>
      )}
      <AnimatePresence>
        {detailEntry && (
          <DiskGrowthDetailsModal
            key={`${selectedDriveLetter}-${detailEntry.path}`}
            entry={detailEntry}
            driveLetter={selectedDriveLetter}
            onClose={handleCloseDetails}
            onOpenFolder={handleOpenFolder}
          />
        )}
      </AnimatePresence>
    </ModuleCard>
  );
}

export default DiskGrowthModule;
