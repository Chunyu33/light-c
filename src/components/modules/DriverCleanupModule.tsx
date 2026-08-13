// ============================================================================
// 旧驱动清理模块
// 正在使用的驱动包由后端锁定，其他未关联活动设备的条目交由用户确认。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, CheckCheck, CheckCircle2, Cpu, FolderOpen, Loader2, RotateCcw, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { Checkbox } from '../ui/Checkbox';
import { useToast } from '../Toast';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  deleteOldDrivers,
  openInFolder,
  openDriverBackupDir,
  restoreAllDriverBackups,
  scanOldDrivers,
  type DriverPackageInfo,
  type DriverScanResult,
} from '../../api/commands';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';
import { openSearchUrl } from '../../utils/searchEngine';

function findScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return parent;
    parent = parent.parentElement;
  }
  return null;
}

function getStatusLabel(packageInfo: DriverPackageInfo, translate: (key: string) => string): string {
  switch (packageInfo.status) {
    case 'old_confirmed':
      return translate('driverCleanup.highConfidence');
    case 'recommended':
      return translate('driverCleanup.recommended');
    case 'in_use':
      return translate('driverCleanup.inUse');
    case 'no_newer_version':
      return translate('driverCleanup.unconfirmed');
    default:
      return translate('driverCleanup.incomplete');
  }
}

function getStatusClass(packageInfo: DriverPackageInfo): string {
  // 状态标签沿用 AI 模块的中性底色，只用品牌色和图表色表达语义，避免彩色块抢占信息层级。
  const baseClass = 'border border-[var(--border-color)] bg-[var(--bg-hover)]';
  switch (packageInfo.status) {
    case 'old_confirmed': return `${baseClass} text-[var(--brand-green)]`;
    case 'recommended': return `${baseClass} text-blue-600 dark:text-blue-400`;
    case 'in_use': return `${baseClass} text-red-600 dark:text-red-400`;
    case 'no_newer_version': return `${baseClass} text-orange-600 dark:text-orange-400`;
    default: return `${baseClass} text-[var(--text-muted)]`;
  }
}

function getPackageCardClass(): string {
  // AI 模块的列表使用统一卡片边框，驱动状态通过标签表达，避免每张卡片变成彩色面板。
  return 'border-[var(--border-default)] bg-[var(--bg-card)] hover:border-[var(--brand-green)]';
}

function getDriverClassLabel(className: string, translate?: (key: string) => string): string {
  const normalizedClassName = className.trim().toLowerCase();
  const labels: Record<string, string> = {
    bluetooth: '蓝牙设备',
    camera: '摄像头',
    cdrom: '光驱',
    computer: '计算机',
    display: '显示器',
    extension: '驱动扩展',
    'hiddclass': '外设（键鼠等）',
    hidclass: '外设（键鼠等）',
    keyboard: '键盘',
    media: '媒体设备',
    modem: '调制解调器',
    mouse: '鼠标',
    net: '网络适配器',
    ports: '串口/并口',
    printer: '打印机',
    processor: '处理器',
    system: '系统设备',
    'system devices': '系统设备',
    'softwarecomponent': '软件组件',
    'software component': '软件组件',
    usb: 'USB 设备',
  };
  const deviceKey = labels[normalizedClassName] ? normalizedClassName : 'other';
  return translate ? translate(`driverCleanup.device.${deviceKey}`) : labels[normalizedClassName] ?? className;
}

function getDriverClassBadge(className: string, translate?: (key: string) => string): { label: string; className: string; dotClassName: string } {
  const normalizedClassName = className.trim().toLowerCase();
  const badgeClasses: Record<string, string> = {
    bluetooth: 'text-teal-600 dark:text-teal-400',
    camera: 'text-purple-600 dark:text-purple-400',
    display: 'text-blue-600 dark:text-blue-400',
    extension: 'text-[var(--text-muted)]',
    hidclass: 'text-blue-600 dark:text-blue-400',
    keyboard: 'text-blue-600 dark:text-blue-400',
    media: 'text-orange-600 dark:text-orange-400',
    mouse: 'text-blue-600 dark:text-blue-400',
    net: 'text-blue-600 dark:text-blue-400',
    ports: 'text-orange-600 dark:text-orange-400',
    printer: 'text-teal-600 dark:text-teal-400',
    system: 'text-purple-600 dark:text-purple-400',
    'system devices': 'text-purple-600 dark:text-purple-400',
    softwarecomponent: 'text-teal-600 dark:text-teal-400',
    'software component': 'text-teal-600 dark:text-teal-400',
    usb: 'text-blue-600 dark:text-blue-400',
  };
  const dotClasses: Record<string, string> = {
    bluetooth: 'bg-teal-500',
    camera: 'bg-purple-500',
    display: 'bg-blue-500',
    extension: 'bg-gray-400',
    hidclass: 'bg-blue-500',
    keyboard: 'bg-blue-500',
    media: 'bg-orange-500',
    mouse: 'bg-blue-500',
    net: 'bg-blue-500',
    ports: 'bg-orange-500',
    printer: 'bg-teal-500',
    system: 'bg-purple-500',
    'system devices': 'bg-purple-500',
    softwarecomponent: 'bg-teal-500',
    'software component': 'bg-teal-500',
    usb: 'bg-blue-500',
  };

  // 分类使用 CHART_PALETTE 同源的颜色点，保持与 AI 模型空间图表一致。
  return {
    label: getDriverClassLabel(className, translate),
    className: badgeClasses[normalizedClassName] ?? 'text-[var(--text-muted)]',
    dotClassName: dotClasses[normalizedClassName] ?? 'bg-gray-400',
  };
}

function getReasonLabel(packageInfo: DriverPackageInfo, translate: (key: string) => string): string {
  switch (packageInfo.status) {
    case 'old_confirmed': return translate('driverCleanup.oldConfirmed');
    case 'recommended': return translate('driverCleanup.newer');
    case 'in_use': return translate('driverCleanup.currentUse');
    case 'no_newer_version': return translate('driverCleanup.noNewer');
    default: return translate('driverCleanup.incompleteReason');
  }
}

function getReasonClass(packageInfo: DriverPackageInfo): string {
  // 判定理由与状态标签共享颜色，底色保持项目统一的 hover 灰。
  const baseClass = 'border border-[var(--border-color)] bg-[var(--bg-hover)]';
  switch (packageInfo.status) {
    case 'old_confirmed': return `${baseClass} text-[var(--brand-green)]`;
    case 'recommended': return `${baseClass} text-blue-600 dark:text-blue-400`;
    case 'in_use': return `${baseClass} text-red-600 dark:text-red-400`;
    case 'no_newer_version': return `${baseClass} text-orange-600 dark:text-orange-400`;
    default: return `${baseClass} text-[var(--text-muted)]`;
  }
}

function getDriverSearchQuery(packageInfo: DriverPackageInfo): string {
  const driverName = packageInfo.original_name
    .replace(/\.inf$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  // pnputil 版本字段通常带日期；只保留版本号，避免日期干扰搜索结果。
  const version = packageInfo.driver_version.match(/\d+(?:\.\d+){1,}/)?.[0] ?? '';
  return [packageInfo.provider_name, driverName, version, 'driver'].filter(Boolean).join(' ');
}

export function DriverCleanupModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useModuleDashboard('driverCleanup');
  const { showToast } = useToast();
  const lastScanTriggerRef = useRef(0);
  const [scanResult, setScanResult] = useState<DriverScanResult | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [isToolbarSticky, setIsToolbarSticky] = useState(false);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const scrollParent = findScrollParent(toolbar);
    const updateStickyState = () => {
      const parentTop = scrollParent?.getBoundingClientRect().top ?? 0;
      setIsToolbarSticky(toolbar.getBoundingClientRect().top <= parentTop + 8);
    };
    const eventTarget = scrollParent ?? window;

    updateStickyState();
    eventTarget.addEventListener('scroll', updateStickyState, { passive: true });
    window.addEventListener('resize', updateStickyState);
    return () => {
      eventTarget.removeEventListener('scroll', updateStickyState);
      window.removeEventListener('resize', updateStickyState);
    };
  }, [scanResult]);

  const loadDrivers = useCallback(async () => {
    setLoading(true);
    updateModuleState('driverCleanup', { status: 'scanning', error: null });
    try {
      const result = await scanOldDrivers();
      setScanResult(result);
      setSelectedNames(new Set());
      updateModuleState('driverCleanup', {
        status: 'done',
        fileCount: result.total_count,
        totalSize: 0,
      });
      setExpandedModule('driver-cleanup');
    } catch (error) {
      updateModuleState('driverCleanup', { status: 'error', error: String(error) });
    } finally {
      setLoading(false);
    }
  }, [setExpandedModule, updateModuleState]);

  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      void loadDrivers();
    }
  }, [loadDrivers, oneClickScanTrigger]);

  const toggleSelection = useCallback((publishedName: string) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(publishedName)) next.delete(publishedName);
      else next.add(publishedName);
      return next;
    });
  }, []);

  const selectHighConfidenceDrivers = useCallback(() => {
    if (!scanResult) return;
    const highConfidenceNames = scanResult.packages
      .filter((packageInfo) => packageInfo.status === 'old_confirmed' && packageInfo.actionable)
      .map((packageInfo) => packageInfo.published_name);

    setSelectedNames((current) => {
      const allSelected = highConfidenceNames.length > 0
        && highConfidenceNames.every((publishedName) => current.has(publishedName));
      const next = new Set(current);

      // 只切换高置信集合，保留用户手动选中的其他候选驱动。
      highConfidenceNames.forEach((publishedName) => {
        if (allSelected) next.delete(publishedName);
        else next.add(publishedName);
      });
      return next;
    });
  }, [scanResult]);

  const handleSearchDriver = useCallback(async (packageInfo: DriverPackageInfo) => {
    try {
      // 只使用精简后的厂商、驱动名和版本，避免日期字段干扰搜索结果。
      await openSearchUrl(getDriverSearchQuery(packageInfo));
    } catch (error) {
      showToast({ title: t('openSearchFailed'), description: String(error), type: 'error' });
    }
  }, [showToast]);

  const handleDelete = useCallback(async () => {
    setShowConfirm(false);
    setDeleting(true);
    try {
      const names = Array.from(selectedNames);
      const result = await deleteOldDrivers(names);
      const failureMessages = result.details
        .filter((detail) => !detail.success && detail.error_message)
        .map((detail) => `${detail.published_name}: ${detail.error_message}`)
        .join('；');
      showToast({
        title: result.failed_count === 0 ? moduleT('driverCleanup.completed') : moduleT('driverCleanup.partial'),
        description: [
          moduleT('driverUi.resultSummary', { success: result.success_count, failed: result.failed_count }),
          failureMessages ? moduleT('driverUi.failureReason', { reason: failureMessages }) : '',
          moduleT('driverUi.backupSummary', { path: result.backup_directory }),
        ].filter(Boolean).join(' '),
        type: result.failed_count === 0 ? 'success' : 'warning',
      });
      if (result.needs_reboot) {
        showToast({ title: moduleT('driverCleanup.restart'), description: moduleT('driverCleanup.restartDesc'), type: 'info' });
      }
      setSelectedNames(new Set());
      await loadDrivers();
    } catch (error) {
      showToast({ title: t('deleteFailed'), description: String(error), type: 'error' });
    } finally {
      setDeleting(false);
    }
  }, [loadDrivers, selectedNames, showToast]);

  const handleRestore = useCallback(async () => {
    setShowRestoreConfirm(false);
    setRestoring(true);
    try {
      const result = await restoreAllDriverBackups();
      showToast({
        title: result.success ? moduleT('driverCleanup.restoreStarted') : moduleT('driverCleanup.restoreIncomplete'),
        description: moduleT('driverCleanup.restoreDesc', { message: result.message }),
        type: result.success ? 'success' : 'warning',
      });
      if (result.needs_reboot) {
        showToast({ title: moduleT('driverCleanup.restart'), description: moduleT('driverCleanup.restartDesc'), type: 'info' });
      }
      await loadDrivers();
    } catch (error) {
      showToast({ title: moduleT('driverCleanup.restoreFailed'), description: String(error), type: 'error' });
    } finally {
      setRestoring(false);
    }
  }, [loadDrivers, showToast]);

  const isExpanded = expandedModule === 'driver-cleanup';
  const highConfidenceNames = useMemo(
    () => scanResult?.packages
      .filter((packageInfo) => packageInfo.status === 'old_confirmed' && packageInfo.actionable)
      .map((packageInfo) => packageInfo.published_name) ?? [],
    [scanResult],
  );
  const selectedHighConfidenceCount = highConfidenceNames.filter((publishedName) => selectedNames.has(publishedName)).length;
  const allHighConfidenceSelected = highConfidenceNames.length > 0
    && selectedHighConfidenceCount === highConfidenceNames.length;
  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !deleting && !restoring) return null;

  return (
    <>
      <ModuleCard
        id="driver-cleanup"
        title={navT('driverCleanup')}
        description={navT('driverCleanupDesc')}
        icon={<Cpu className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        countLabel={moduleT('driverUi.packageCount')}
        hideTotalSize
        hideDoneBadge
        emptyDoneBadgeText={moduleT('driverUi.noActionable')}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'driver-cleanup')}
        onScan={() => void loadDrivers()}
        scanDisabled={deleting || restoring}
        scanButtonText={loading ? moduleT('driverUi.checking') : scanResult ? moduleT('driverUi.rescan') : moduleT('driverUi.scan')}
        error={moduleState.error}
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        allowStickyContent
        titleExtra={scanResult ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-1 text-xs font-medium text-[var(--brand-green)]">
              {moduleT('driverCleanup.highConfidence')} {scanResult.high_confidence_count}
            </span>
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400">
              {moduleT('driverUi.actionable')} {scanResult.candidate_count}
            </span>
            <span className={`rounded-full bg-[var(--bg-hover)] px-2 py-1 text-xs ${scanResult.is_admin ? 'text-[var(--brand-green)]' : 'text-orange-600 dark:text-orange-400'}`}>
              {scanResult.is_admin ? moduleT('driverUi.administrator') : moduleT('driverUi.deleteAdminRequired')}
            </span>
          </div>
        ) : null}
      >
        <div className="p-4 space-y-3">
          {!scanResult && !loading && (
          <EmptyState icon={Cpu} title={t('notScannedDrivers')} description={t('driverScanDescription')} />
          )}

          {loading && !scanResult && (
            <div className="py-8 flex flex-col items-center justify-center text-[var(--fg-muted)]">
              <Loader2 className="w-7 h-7 text-emerald-500 animate-spin mb-2" />
              <p className="text-sm">{moduleT('driverUi.scanning')}</p>
            </div>
          )}

          {scanResult && (
            <div className="space-y-2">
              <div
                ref={toolbarRef}
                className={`sticky top-2 z-20 mx-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 shadow-sm transition-[width,box-shadow,background-color] duration-200 ease-out ${isToolbarSticky ? 'w-fit shadow-md' : 'w-full'}`}
              >
                <span className="inline-flex items-center gap-1 px-1 text-xs text-[var(--fg-muted)]" title={moduleT('driverUi.backupHint')}>
                  <Archive className="h-3.5 w-3.5 text-[var(--brand-green)]" />{moduleT('driverUi.backup')}
                </span>
                <span className={`px-1 text-xs ${scanResult.device_match_data_available ? 'text-[var(--brand-green)]' : 'text-orange-600 dark:text-orange-400'}`} title={scanResult.device_match_data_available ? moduleT('driverUi.rankHint') : moduleT('driverUi.rankMissingHint')}>
                  {scanResult.device_match_data_available ? moduleT('driverUi.rankVerified') : moduleT('driverUi.rankUnavailable')}
                </span>
                <button
                  type="button"
                  disabled={scanResult.high_confidence_count === 0 || deleting || restoring}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectHighConfidenceDrivers();
                  }}
                  title={allHighConfidenceSelected ? moduleT('driverUi.deselectHigh') : moduleT('driverUi.selectHigh')}
                  className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${allHighConfidenceSelected
                    ? 'border-[var(--brand-green)] bg-[var(--brand-green)] text-white hover:bg-[var(--brand-green-hover)]'
                    : 'border-[var(--brand-green)] bg-[var(--brand-green)]/10 text-[var(--brand-green)] hover:bg-[var(--brand-green)]/20'
                  }`}
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  {moduleT('driverUi.oldDriverCount')} {selectedHighConfidenceCount}/{highConfidenceNames.length}
                </button>
                <button title={moduleT('driverUi.openBackup')} onClick={() => {
                    void openDriverBackupDir().catch((error) => {
                      showToast({ title: moduleT('driverUi.openBackupFailed'), description: String(error), type: 'error' });
                    });
                  }} className="inline-flex items-center justify-center gap-1 rounded-lg border border-[var(--brand-green-20)] px-2 py-1 text-xs font-medium text-[var(--brand-green)] hover:bg-[var(--brand-green-10)]">
                  <FolderOpen className="h-3.5 w-3.5" />{moduleT('driverUi.backup')}
                </button>
                <button title={moduleT('driverUi.restoreAll')} disabled={!scanResult.is_admin || deleting || restoring} onClick={() => setShowRestoreConfirm(true)} className="inline-flex items-center justify-center gap-1 rounded-lg border border-blue-400 bg-[var(--bg-card)] px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-500 dark:text-blue-400 dark:hover:bg-blue-950">
                  <RotateCcw className="h-3.5 w-3.5" />{t('restore')}
                </button>
                <button title={deleting ? moduleT('driverUi.deleting') : moduleT('driverUi.deleteSelected', { count: selectedNames.size })} disabled={selectedNames.size === 0 || !scanResult.is_admin || deleting || restoring} onClick={() => setShowConfirm(true)} className="inline-flex items-center justify-center gap-1 rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {deleting ? moduleT('driverUi.deleting') : t('delete') + ` ${selectedNames.size}`}
                </button>
              </div>

              <div className="min-w-0">
              {!scanResult.is_admin && (
                <div className="flex items-start gap-2 rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>{moduleT('driverUi.adminHint')}</span>
                </div>
              )}

              {scanResult.packages.length === 0 ? (
        <EmptyState icon={CheckCircle2} title={t('noThirdPartyDrivers')} description={t('noDriversDescription')} tone="success" />
              ) : (
                <div className="space-y-2">
                  {scanResult.packages.map((packageInfo) => {
                    const selected = selectedNames.has(packageInfo.published_name);
                    const driverClassBadge = getDriverClassBadge(packageInfo.class_name || 'unknown', moduleT);
                    return (
                      <label key={packageInfo.published_name} className={`block rounded-xl border p-2.5 transition ${getPackageCardClass()} ${packageInfo.actionable ? '' : 'opacity-80'}`}>
                        <div className="flex items-start gap-2.5">
                          <div className="mt-0.5 shrink-0">
                            <Checkbox
                              checked={selected}
                              disabled={!packageInfo.actionable || !scanResult.is_admin || deleting || restoring}
                              onChange={() => toggleSelection(packageInfo.published_name)}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="min-w-0 truncate font-semibold text-sm text-[var(--fg-primary)]" title={packageInfo.original_name || moduleT('driverUi.unknownInf')}>{packageInfo.original_name || moduleT('driverUi.unknownInf')}</span>
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${getStatusClass(packageInfo)}`}>{getStatusLabel(packageInfo, moduleT)}</span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                              <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 font-mono text-[var(--fg-secondary)]" title={packageInfo.published_name}>{packageInfo.published_name}</span>
                              <span className="max-w-[220px] truncate font-medium text-[var(--fg-secondary)]" title={packageInfo.provider_name || moduleT('driverCleanup.unknownVendor')}>{packageInfo.provider_name || moduleT('driverCleanup.unknownVendor')}</span>
                              <span className="text-[var(--fg-muted)]" title={packageInfo.driver_version || moduleT('driverCleanup.unknownVersion')}>{moduleT('driverCleanup.version')} {packageInfo.driver_version || moduleT('driverCleanup.unknownVersion')}</span>
                              <span className={`inline-flex items-center gap-1 rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 ${driverClassBadge.className}`}>
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${driverClassBadge.dotClassName}`} />
                                {driverClassBadge.label}
                              </span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                              <span className={`max-w-full truncate rounded-full px-1.5 py-0.5 ${getReasonClass(packageInfo)}`} title={packageInfo.reason}>{getReasonLabel(packageInfo, moduleT)}</span>
          <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverUi.devices')} {packageInfo.device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverCleanup.active')} {packageInfo.active_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverCleanup.current')} {packageInfo.installed_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverCleanup.replaced')} {packageInfo.outranked_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverCleanup.files')} {packageInfo.file_count}</span>
                            </div>
                          </div>
                          <div className="flex shrink-0 self-center items-center gap-1">
                            <button
                              type="button"
        title={t('searchDriver')}
                              aria-label={moduleT('driverUi.searchAria', { provider: packageInfo.provider_name, name: packageInfo.original_name })}
                              disabled={deleting || restoring}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void handleSearchDriver(packageInfo);
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Search className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              title={packageInfo.driver_store_path ? moduleT('driverUi.driverDirectory') : moduleT('driverUi.driverDirectoryUnavailable')}
                              aria-label={moduleT('driverUi.openDriverAria', { provider: packageInfo.provider_name })}
                              disabled={!packageInfo.driver_store_path || deleting || restoring}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (!packageInfo.driver_store_path) return;
                                void openInFolder(packageInfo.driver_store_path).catch((error) => {
                                  showToast({ title: moduleT('driverUi.openFolderFailed'), description: String(error), type: 'error' });
                                });
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--brand-green-10)] hover:text-[var(--brand-green)] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              </div>
            </div>
          )}
        </div>
      </ModuleCard>

      <ConfirmDialog
        isOpen={showConfirm}
        onCancel={() => setShowConfirm(false)}
        onConfirm={() => void handleDelete()}
        title={t('confirmDeleteDriver')}
        description={moduleT('driverUi.confirmDeleteDesc', { count: selectedNames.size })}
        warning={t('driverDeleteWarning')}
        confirmText={t('backupAndDelete')}
        cancelText={t('cancel')}
        isDanger
      />

      <ConfirmDialog
        isOpen={showRestoreConfirm}
        onCancel={() => setShowRestoreConfirm(false)}
        onConfirm={() => void handleRestore()}
        title={t('confirmRestoreDrivers')}
        description={moduleT('driverUi.confirmRestoreDesc')}
        warning={t('driverRestoreWarning')}
        confirmText={t('confirmRestore')}
        cancelText={t('cancel')}
      />
    </>
  );
}

export default DriverCleanupModule;
