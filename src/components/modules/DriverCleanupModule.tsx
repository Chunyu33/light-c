// ============================================================================
// 旧驱动清理模块
// 正在使用的驱动包由后端锁定，其他未关联活动设备的条目交由用户确认。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function getStatusLabel(packageInfo: DriverPackageInfo): string {
  switch (packageInfo.status) {
    case 'old_confirmed':
      return '高置信旧驱动';
    case 'recommended':
      return '可优先清理';
    case 'in_use':
      return '正在使用';
    case 'no_newer_version':
      return '未确认过时';
    default:
      return '信息不完整';
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

function getDriverClassLabel(className: string): string {
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
  return labels[normalizedClassName] ?? className;
}

function getDriverClassBadge(className: string): { label: string; className: string; dotClassName: string } {
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
    label: getDriverClassLabel(className),
    className: badgeClasses[normalizedClassName] ?? 'text-[var(--text-muted)]',
    dotClassName: dotClasses[normalizedClassName] ?? 'bg-gray-400',
  };
}

function getReasonLabel(packageInfo: DriverPackageInfo): string {
  switch (packageInfo.status) {
    case 'old_confirmed': return '已被更高排名驱动替代';
    case 'recommended': return '同一驱动族存在更新版本';
    case 'in_use': return '当前有设备正在使用';
    case 'no_newer_version': return '暂未确认存在更新版本';
    default: return '版本或驱动族信息不完整';
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
      showToast({ title: '打开搜索失败', description: String(error), type: 'error' });
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
        title: result.failed_count === 0 ? '驱动清理完成' : '驱动清理部分完成',
        description: [
          `成功 ${result.success_count} 个，失败 ${result.failed_count} 个。`,
          failureMessages ? `失败原因：${failureMessages}` : '',
          `备份位置：${result.backup_directory}。可重新检测确认结果。`,
        ].filter(Boolean).join(' '),
        type: result.failed_count === 0 ? 'success' : 'warning',
      });
      if (result.needs_reboot) {
        showToast({ title: '需要重启', description: '部分驱动变更可能需要重启 Windows 后完成。', type: 'info' });
      }
      setSelectedNames(new Set());
      await loadDrivers();
    } catch (error) {
      showToast({ title: '驱动清理失败', description: String(error), type: 'error' });
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
        title: result.success ? '驱动恢复命令已执行' : '驱动恢复未完全成功',
        description: `${result.message}。已重新检测驱动状态。`,
        type: result.success ? 'success' : 'warning',
      });
      if (result.needs_reboot) {
        showToast({ title: '恢复可能需要重启', description: '部分驱动安装需要重启 Windows 后完成。', type: 'info' });
      }
      await loadDrivers();
    } catch (error) {
      showToast({ title: '驱动恢复失败', description: String(error), type: 'error' });
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
        title="旧驱动清理"
        description="检测第三方驱动包，正在使用的驱动不可删除"
        icon={<Cpu className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        countLabel="个驱动包"
        hideTotalSize
        hideDoneBadge
        emptyDoneBadgeText="未发现可处理项"
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'driver-cleanup')}
        onScan={() => void loadDrivers()}
        scanDisabled={deleting || restoring}
        scanButtonText={loading ? '检测中...' : scanResult ? '重新检测' : '检测驱动'}
        error={moduleState.error}
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        allowStickyContent
        titleExtra={scanResult ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-1 text-xs font-medium text-[var(--brand-green)]">
              高置信 {scanResult.high_confidence_count}
            </span>
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400">
              可处理 {scanResult.candidate_count}
            </span>
            <span className={`rounded-full bg-[var(--bg-hover)] px-2 py-1 text-xs ${scanResult.is_admin ? 'text-[var(--brand-green)]' : 'text-orange-600 dark:text-orange-400'}`}>
              {scanResult.is_admin ? '管理员' : '可检测，删除需管理员'}
            </span>
          </div>
        ) : null}
      >
        <div className="p-4 space-y-3">
          {!scanResult && !loading && (
            <EmptyState icon={Cpu} title="尚未检测驱动包" description="LightC 只会通过 Windows pnputil 检查第三方驱动包，不直接删除驱动文件。" />
          )}

          {loading && !scanResult && (
            <div className="py-8 flex flex-col items-center justify-center text-[var(--fg-muted)]">
              <Loader2 className="w-7 h-7 text-emerald-500 animate-spin mb-2" />
              <p className="text-sm">正在读取 Windows 驱动包信息...</p>
            </div>
          )}

          {scanResult && (
            <div className="space-y-2">
              <div
                ref={toolbarRef}
                className={`sticky top-2 z-20 mx-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 shadow-sm transition-[width,box-shadow,background-color] duration-200 ease-out ${isToolbarSticky ? 'w-fit shadow-md' : 'w-full'}`}
              >
                <span className="inline-flex items-center gap-1 px-1 text-xs text-[var(--fg-muted)]" title="删除前自动备份，软件不保留删除历史。">
                  <Archive className="h-3.5 w-3.5 text-[var(--brand-green)]" />备份
                </span>
                <span className={`px-1 text-xs ${scanResult.device_match_data_available ? 'text-[var(--brand-green)]' : 'text-orange-600 dark:text-orange-400'}`} title={scanResult.device_match_data_available ? '高置信旧驱动来自设备匹配排名，其他候选仍需人工确认。' : '未取得设备驱动排名数据，当前结果仅供参考。'}>
                  {scanResult.device_match_data_available ? '排名已核验' : '排名未取得'}
                </span>
                <button
                  type="button"
                  disabled={scanResult.high_confidence_count === 0 || deleting || restoring}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectHighConfidenceDrivers();
                  }}
                  title={allHighConfidenceSelected ? '取消选中全部高置信旧驱动' : '选中全部高置信旧驱动'}
                  className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${allHighConfidenceSelected
                    ? 'border-[var(--brand-green)] bg-[var(--brand-green)] text-white hover:bg-[var(--brand-green-hover)]'
                    : 'border-[var(--brand-green)] bg-[var(--brand-green)]/10 text-[var(--brand-green)] hover:bg-[var(--brand-green)]/20'
                  }`}
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                  高置信 {selectedHighConfidenceCount}/{highConfidenceNames.length}
                </button>
                <button title="打开驱动备份目录" onClick={() => {
                    void openDriverBackupDir().catch((error) => {
                      showToast({ title: '打开备份目录失败', description: String(error), type: 'error' });
                    });
                  }} className="inline-flex items-center justify-center gap-1 rounded-lg border border-[var(--brand-green-20)] px-2 py-1 text-xs font-medium text-[var(--brand-green)] hover:bg-[var(--brand-green-10)]">
                  <FolderOpen className="h-3.5 w-3.5" />备份
                </button>
                <button title="恢复全部驱动备份" disabled={!scanResult.is_admin || deleting || restoring} onClick={() => setShowRestoreConfirm(true)} className="inline-flex items-center justify-center gap-1 rounded-lg border border-blue-400 bg-[var(--bg-card)] px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-500 dark:text-blue-400 dark:hover:bg-blue-950">
                  <RotateCcw className="h-3.5 w-3.5" />恢复
                </button>
                <button title={deleting ? '正在删除驱动' : `删除选中的 ${selectedNames.size} 个驱动`} disabled={selectedNames.size === 0 || !scanResult.is_admin || deleting || restoring} onClick={() => setShowConfirm(true)} className="inline-flex items-center justify-center gap-1 rounded-lg bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {deleting ? '删除中' : `删除 ${selectedNames.size}`}
                </button>
              </div>

              <div className="min-w-0">
              {!scanResult.is_admin && (
                <div className="flex items-start gap-2 rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-300">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <span>当前可以检测，但删除驱动包需要以管理员身份运行 LightC。</span>
                </div>
              )}

              {scanResult.packages.length === 0 ? (
                <EmptyState icon={CheckCircle2} title="未发现第三方驱动包" description="pnputil 没有返回可分析的第三方驱动包。" tone="success" />
              ) : (
                <div className="space-y-2">
                  {scanResult.packages.map((packageInfo) => {
                    const selected = selectedNames.has(packageInfo.published_name);
                    const driverClassBadge = getDriverClassBadge(packageInfo.class_name || '类别未知');
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
                              <span className="min-w-0 truncate font-semibold text-sm text-[var(--fg-primary)]" title={packageInfo.original_name || '未知 INF 文件'}>{packageInfo.original_name || '未知 INF 文件'}</span>
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${getStatusClass(packageInfo)}`}>{getStatusLabel(packageInfo)}</span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                              <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 font-mono text-[var(--fg-secondary)]" title={packageInfo.published_name}>{packageInfo.published_name}</span>
                              <span className="max-w-[220px] truncate font-medium text-[var(--fg-secondary)]" title={packageInfo.provider_name || '未知厂商'}>{packageInfo.provider_name || '未知厂商'}</span>
                              <span className="text-[var(--fg-muted)]" title={packageInfo.driver_version || '版本未知'}>版本 {packageInfo.driver_version || '未知'}</span>
                              <span className={`inline-flex items-center gap-1 rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 ${driverClassBadge.className}`}>
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${driverClassBadge.dotClassName}`} />
                                {driverClassBadge.label}
                              </span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                              <span className={`max-w-full truncate rounded-full px-1.5 py-0.5 ${getReasonClass(packageInfo)}`} title={packageInfo.reason}>{getReasonLabel(packageInfo)}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">设备 {packageInfo.device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">活动 {packageInfo.active_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">当前 {packageInfo.installed_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">替代 {packageInfo.outranked_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">文件 {packageInfo.file_count}</span>
                            </div>
                          </div>
                          <div className="flex shrink-0 self-center items-center gap-1">
                            <button
                              type="button"
                              title="搜索该驱动信息"
                              aria-label={`搜索 ${packageInfo.provider_name} ${packageInfo.original_name}`}
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
                              title={packageInfo.driver_store_path ? '打开驱动所在目录' : '驱动目录信息不可用'}
                              aria-label={`打开 ${packageInfo.provider_name} 驱动所在目录`}
                              disabled={!packageInfo.driver_store_path || deleting || restoring}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (!packageInfo.driver_store_path) return;
                                void openInFolder(packageInfo.driver_store_path).catch((error) => {
                                  showToast({ title: '打开驱动目录失败', description: String(error), type: 'error' });
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
        title="确认删除旧驱动包"
        description={`将备份并删除选中的 ${selectedNames.size} 个驱动包。删除前后后端都会重新校验设备绑定状态。`}
        warning="正在使用的驱动不可选；其他未关联设备的驱动包均可删除，但‘未确认过时’或‘信息不完整’的条目并不代表一定无用。删除前会完整备份，备份失败会阻止删除；不会使用 /force，也不会直接删除 .sys 文件。"
        confirmText="备份并删除"
        cancelText="取消"
        isDanger
      />

      <ConfirmDialog
        isOpen={showRestoreConfirm}
        onCancel={() => setShowRestoreConfirm(false)}
        onConfirm={() => void handleRestore()}
        title="确认恢复全部驱动备份"
        description="将读取当前数据目录 driver_backups 下的全部 INF 备份，并交由 Windows pnputil 递归安装。"
        warning="该操作需要管理员权限，可能重新安装多个历史驱动版本；执行后建议重新检测，必要时重启 Windows。"
        confirmText="确认恢复"
        cancelText="取消"
      />
    </>
  );
}

export default DriverCleanupModule;
