// ============================================================================
// 旧驱动清理模块
// 正在使用的驱动包由后端锁定，其他未关联活动设备的条目交由用户确认。
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CheckCircle2, Cpu, FolderOpen, Loader2, RotateCcw, Search, ShieldAlert, Trash2 } from 'lucide-react';
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

function getStatusLabel(packageInfo: DriverPackageInfo): string {
  switch (packageInfo.status) {
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
  switch (packageInfo.status) {
    case 'recommended': return 'bg-emerald-500/10 text-emerald-600';
    case 'in_use': return 'bg-rose-500/10 text-rose-600';
    case 'no_newer_version': return 'bg-amber-500/10 text-amber-700';
    default: return 'bg-sky-500/10 text-sky-700';
  }
}

function getPackageCardClass(packageInfo: DriverPackageInfo): string {
  switch (packageInfo.status) {
    case 'in_use': return 'border-rose-500/20 bg-rose-500/[0.03]';
    case 'no_newer_version': return 'border-amber-500/20 bg-amber-500/[0.03]';
    case 'unknown': return 'border-sky-500/20 bg-sky-500/[0.03]';
    default: return 'border-[var(--border-default)] hover:border-emerald-500/40';
  }
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
    'hiddclass': '人机接口设备',
    hidclass: '人机接口设备（键鼠等外设）',
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
        doneBadgeText="已检测"
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
        headerExtra={scanResult ? (
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600">
              可处理 {scanResult.candidate_count}
            </span>
            <span className={`text-xs px-2 py-1 rounded-full ${scanResult.is_admin ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'}`}>
              {scanResult.is_admin ? '管理员' : '可检测，删除需管理员'}
            </span>
          </div>
        ) : null}
      >
        <div className="p-4 space-y-3">
          {scanResult && (
            <div className="sticky top-2 z-20 flex flex-wrap items-start gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2.5 shadow-sm">
              <div className="flex min-w-0 items-start gap-2 text-[11px] text-[var(--fg-muted)]">
                <Archive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--brand-green)]" />
                <div>
                  <p className="font-medium text-[var(--fg-secondary)]">删除前自动备份，软件不保留删除历史</p>
                  <p className="mt-0.5">除正在使用的驱动外均可选择，但未确认过时的条目请谨慎处理。</p>
                </div>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2 rounded-lg bg-[var(--bg-elevated)]/95 py-0.5 pl-1 backdrop-blur-sm">
                <button onClick={() => {
                  void openDriverBackupDir().catch((error) => {
                    showToast({ title: '打开备份目录失败', description: String(error), type: 'error' });
                  });
                }} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--brand-green)] hover:bg-emerald-500/10">
                  <FolderOpen className="h-3.5 w-3.5" />打开备份目录
                </button>
                <button disabled={!scanResult.is_admin || deleting || restoring} onClick={() => setShowRestoreConfirm(true)} className="inline-flex items-center gap-1 rounded-lg border border-sky-500/30 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-50">
                  <RotateCcw className="h-3.5 w-3.5" />恢复全部备份
                </button>
                <button disabled={selectedNames.size === 0 || !scanResult.is_admin || deleting || restoring} onClick={() => setShowConfirm(true)} className="inline-flex items-center gap-1 rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {deleting ? '删除中...' : `删除选中 (${selectedNames.size})`}
                </button>
              </div>
            </div>
          )}

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
            <>
              {!scanResult.is_admin && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
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
                    return (
                      <label key={packageInfo.published_name} className={`block rounded-xl border p-3 transition ${getPackageCardClass(packageInfo)} ${packageInfo.actionable ? '' : 'opacity-80'}`}>
                        <div className="flex items-start gap-2">
                          <div className="mt-1 shrink-0">
                            <Checkbox
                              checked={selected}
                              disabled={!packageInfo.actionable || !scanResult.is_admin || deleting || restoring}
                              onChange={() => toggleSelection(packageInfo.published_name)}
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-sm text-[var(--fg-primary)]">{packageInfo.original_name || '未知 INF 文件'}</span>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] ${getStatusClass(packageInfo)}`}>{getStatusLabel(packageInfo)}</span>
                              <span className="text-[11px] text-[var(--fg-muted)]">{packageInfo.published_name}</span>
                            </div>
                            <p className="mt-1 text-xs text-[var(--fg-secondary)]">{packageInfo.provider_name || '未知厂商'} · {packageInfo.driver_version || '版本未知'} · {getDriverClassLabel(packageInfo.class_name || '类别未知')}</p>
                            <p className="mt-1 text-[11px] text-[var(--fg-muted)]">{packageInfo.reason}</p>
                            <p className="mt-1 text-[11px] text-[var(--fg-muted)]">关联设备 {packageInfo.device_count} 个 · 活动设备 {packageInfo.active_device_count} 个 · 驱动文件 {packageInfo.file_count} 个</p>
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

            </>
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
