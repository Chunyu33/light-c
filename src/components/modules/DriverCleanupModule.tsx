// ============================================================================
// 旧驱动清理模块
// 正在使用的驱动包由后端锁定，其他未关联活动设备的条目交由用户确认。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, CheckCheck, CheckCircle2, Cpu, FolderOpen, Loader2, RotateCcw, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ModuleScanProgress } from '../ModuleScanProgress';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { Checkbox } from '../ui/Checkbox';
import { Switch } from '../ui/Switch';
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
import { formatSize } from '../../utils/format';
import { useAiModuleBridge } from '../ai/useAiModuleBridge';
import { AiAskButton } from '../ai/AiAskButton';

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

/**
 * 给 AI 助手的问题。
 *
 * 与 getDriverSearchQuery 的区别很关键：那个拼的是**给搜索引擎的关键字**
 * （`Microsoft oem7 10.0.26100.1882 driver`），用空格堆词；直接把这种关键字丢给 AI，
 * 它结合「旧驱动清理」的上下文会读成"处理一下这个驱动"，于是开始提删除 ——
 * 用户点快捷提问明明是想**了解这个驱动**。
 *
 * 所以这里用完整问句把意图说清楚，但字段仍然取自同一份数据，不另维护一套。
 */
function getDriverAiQuestion(packageInfo: DriverPackageInfo): string {
  const driverName = packageInfo.original_name
    .replace(/\.inf$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const version = packageInfo.driver_version.match(/\d+(?:\.\d+){1,}/)?.[0] ?? '';
  return [
    `驱动「${driverName}」`,
    packageInfo.provider_name ? `（厂商 ${packageInfo.provider_name}）` : '',
    version ? `（版本 ${version}）` : '',
    '是什么、有什么用？可以安全删除吗，删除后可能有什么影响？',
  ].join('');
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
  // 默认只展示"用户能自己拿主意"的驱动包（见 isActionableWithEvidence）。
  // 以前一股脑全列出来，有用户反馈整屏都是「信息不完整」，看了也不知道该不该删。
  // 全部驱动没被删掉，只是移到开关后面。
  const [showAllDrivers, setShowAllDrivers] = useState(false);

  // 接入 AI 助手：模块侧只写这一处（与垃圾清理写法形状一致）。
  // 旧驱动的"可操作项"就是可安全处理的驱动包，id 用 published_name（稳定，pnputil 也认它）。
  useAiModuleBridge('driver-cleanup', {
    summary: () => {
      if (!scanResult) return null;
      return [
        `共 ${scanResult.total_count} 个驱动包：可处理 ${scanResult.candidate_count} 个，`,
        `其中高置信旧驱动 ${scanResult.high_confidence_count} 个；`,
        `当前${scanResult.is_admin ? '有' : '没有'}管理员权限，用户已勾选 ${selectedNames.size} 个。`,
      ].join('');
    },
    // 只读读取：驱动包列表。**与界面同源**，但给"全部"而不是默认筛选后的那些 ——
    // 界面上有「显示全部驱动」开关，用户问到任何一行都得答得上。
    // 每条带上状态判定，模型才不可能把"正在使用"的驱动也说成能删。
    readItems: (_targetId, offset, limit) => {
      const list = scanResult?.packages ?? [];
      if (list.length === 0) {
        // 空结果的两种原因要分开说，否则排查方向完全是两回事
        return {
          total: 0,
          lines: [
            scanResult
              ? '（已经扫描过，但没有读到任何驱动包）'
              : '（当前还没有扫描结果 —— 请先点一次「开始扫描」，再问这个问题）',
          ],
        };
      }
      return {
        total: list.length,
        lines: list.slice(offset, offset + limit).map((item) => {
          const name = item.original_name || item.published_name;
          const size = item.total_size > 0 ? formatSize(item.total_size) : '占用未知';
          const judge = item.actionable ? '可安全处理' : '不建议处理';
          return `${name}  ${item.provider_name || '未知厂商'}  ${item.driver_version}  ${size}  （${getReasonLabel(item, moduleT)}，${judge}）`;
        }),
      };
    },
    // 只读：单条详情。id 用 published_name（与 targets 一致）；
    // 用户问的那句话里通常只有"原名 + 厂商 + 版本"，所以再按原名兜一次。
    readItemDetail: (itemId) => {
      const wanted = itemId.trim();
      if (!wanted) return null;
      const list = scanResult?.packages ?? [];
      const item =
        list.find((entry) => entry.published_name === wanted) ??
        list.find((entry) => (entry.original_name || '').trim() === wanted);
      if (!item) return null;
      return [
        `名称：${item.original_name || item.published_name}`,
        `发布名：${item.published_name}`,
        `厂商：${item.provider_name || '未知'}`,
        `类别：${item.class_name || '未知'}`,
        `版本：${item.driver_version}`,
        `签名者：${item.signer_name || '未知'}`,
        `所在位置：${item.driver_store_path || '未知'}`,
        `占用：${item.total_size > 0 ? formatSize(item.total_size) : '无法读取'}（${item.file_count} 个文件）`,
        `关联设备：共 ${item.device_count} 个（在用 ${item.active_device_count}、已安装 ${item.installed_device_count}、被更高版本替代 ${item.outranked_device_count}）`,
        `判定依据：${getReasonLabel(item, moduleT)} —— ${item.reason}`,
        // 结论由**本地事实**给出，不交给模型自己判断能不能删
        item.actionable
          ? '结论：按上面的判定，这个驱动包可以做安全清理（删除前程序会自动备份，可以回退）。'
          : '结论：**不建议清理这个驱动包** —— 按上面的判定理由，删除可能影响设备或无法回退。',
      ].join('\n');
    },
    targets: () =>
      (scanResult?.packages ?? [])
        .filter((item) => item.actionable)
        .map((item) => ({
          id: item.published_name,
          label: item.original_name || item.published_name,
          detail: `${item.provider_name || '未知厂商'} · ${item.reason}`,
        })),
    // 删除动作等工具调用接上后再补：它必须调用模块原有的 deleteOldDrivers，
    // 好让"校验 → 全部备份 → 删除 → 复核"整套流程继续生效。
  });

  const visiblePackages = useMemo(
    () =>
      (scanResult?.packages ?? []).filter((packageInfo) => {
        if (showAllDrivers) return true;
        // 默认视图只保留"有明确依据、用户能自己判断"的两类：
        //   old_confirmed —— 在设备匹配列表里被更高排名驱动替代（就是后端算的"高置信"）
        //   recommended   —— 未关联设备，且同一驱动族存在更新版本
        // 其余三类都放到「显示全部驱动」后面：
        //   in_use           正在使用，本来就不能删
        //   unknown          信息不完整，用户看了也无从判断（有用户反馈整屏都是这个）
        //   no_newer_version 未确认过时，删了就没有别的版本可回退
        if (!packageInfo.actionable) return false;
        return packageInfo.status === 'old_confirmed' || packageInfo.status === 'recommended';
      }),
    [scanResult, showAllDrivers],
  );
  const hiddenDriverCount = (scanResult?.packages.length ?? 0) - visiblePackages.length;
  // 操作栏里那行展示范围的文案：默认说清"只显示可安全处理的、隐藏了多少"，
  // 打开开关后说清"现在看的是全部"。文案可能偏长，操作栏里会限宽截断。
  const listScopeText = showAllDrivers
    ? moduleT('driverUi.allList', { total: scanResult?.packages.length ?? 0 })
    : moduleT('driverUi.filteredList', {
        shown: visiblePackages.length,
        hidden: hiddenDriverCount,
      });

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
      showToast({ title: moduleT('driverCleanup.failed'), description: String(error), type: 'error' });
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
        title: result.success ? moduleT('driverUi.restoreStarted') : moduleT('driverUi.restoreIncomplete'),
        description: moduleT('driverUi.restoreDesc', { message: result.message }),
        type: result.success ? 'success' : 'warning',
      });
      if (result.needs_reboot) {
        showToast({ title: moduleT('driverCleanup.restart'), description: moduleT('driverCleanup.restartDesc'), type: 'info' });
      }
      await loadDrivers();
    } catch (error) {
      showToast({ title: moduleT('driverUi.restoreFailed'), description: String(error), type: 'error' });
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

  // 删除确认弹窗需要展示本次会删除的驱动名和占用，这里直接在渲染前算出，
  // 避免弹窗内再遍历一次 packages。
  const selectedPackages = useMemo(
    () => scanResult?.packages.filter((packageInfo) => selectedNames.has(packageInfo.published_name)) ?? [],
    [scanResult, selectedNames],
  );
  const selectedDriverSize = selectedPackages.reduce((sum, packageInfo) => sum + packageInfo.total_size, 0);
  const selectedDriverSummary = useMemo(() => {
    // 单个驱动时直接显示文件名，多个时只给数量，避免文案被长文件名撑爆。
    if (selectedPackages.length === 1) {
      return selectedPackages[0].original_name || selectedPackages[0].published_name;
    }
    return moduleT('driverUi.confirmDeleteTarget', { count: selectedPackages.length });
  }, [moduleT, selectedPackages]);
  // 后端拿不到占用时传 0，前端统一显示“未知”，不展示 0 B 误导用户。
  const selectedDriverSizeText = selectedDriverSize > 0
    ? formatSize(selectedDriverSize)
    : moduleT('driverUi.unknownSize');
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
            <ModuleScanProgress
              title={moduleT('driverUi.scanning')}
              icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
            />
          )}

          {scanResult && (
            <div className="space-y-2">
              <div
                ref={toolbarRef}
                className={`driver-toolbar sticky top-2 z-20 mx-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 shadow-sm transition-[width,box-shadow,background-color] duration-200 ease-out ${isToolbarSticky ? 'w-fit shadow-md' : 'w-full'}`}
              >
                {/* 「显示全部」开关，和操作按钮共用同一行。
                    展示范围的文案不直接显示出来（占宽又没必要），挂在 title 上，hover 可见。 */}
                <span
                  className="flex items-center gap-1 px-1 text-xs text-[var(--fg-muted)]"
                  title={listScopeText}
                >
                  {moduleT('driverUi.showAllToggle')}
                  <Switch checked={showAllDrivers} onChange={setShowAllDrivers} />
                </span>
                <span className="h-4 w-px shrink-0 bg-[var(--border-default)]" aria-hidden="true" />
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

              {visiblePackages.length === 0 ? (
                scanResult.packages.length === 0 ? (
                  <EmptyState icon={CheckCircle2} title={t('noThirdPartyDrivers')} description={t('noDriversDescription')} tone="success" />
                ) : (
                  <EmptyState
                    icon={CheckCircle2}
                    title={moduleT('driverUi.noActionable')}
                    description={moduleT('driverUi.noActionableDesc')}
                    tone="success"
                  />
                )
              ) : (
                <div className="space-y-2">
                  {visiblePackages.map((packageInfo) => {
                    const selected = selectedNames.has(packageInfo.published_name);
                    const driverClassBadge = getDriverClassBadge(packageInfo.class_name || 'unknown', moduleT);
                    return (
                      <label key={packageInfo.published_name} className={`glass-item block rounded-xl border p-2.5 transition ${getPackageCardClass()} ${packageInfo.actionable ? '' : 'opacity-80'}`}>
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
          <span className="max-w-[220px] truncate font-medium text-[var(--fg-secondary)]" title={packageInfo.provider_name || moduleT('driverUi.unknownVendor')}>{packageInfo.provider_name || moduleT('driverUi.unknownVendor')}</span>
          <span className="text-[var(--fg-muted)]" title={packageInfo.driver_version || moduleT('driverUi.unknownVersion')}>{moduleT('driverUi.version')} {packageInfo.driver_version || moduleT('driverUi.unknownVersion')}</span>
                              <span className={`inline-flex items-center gap-1 rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 ${driverClassBadge.className}`}>
                                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${driverClassBadge.dotClassName}`} />
                                {driverClassBadge.label}
                              </span>
                            </div>
                            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                              <span className={`max-w-full truncate rounded-full px-1.5 py-0.5 ${getReasonClass(packageInfo)}`} title={packageInfo.reason}>{getReasonLabel(packageInfo, moduleT)}</span>
          <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverUi.devices')} {packageInfo.device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverUi.active')} {packageInfo.active_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverUi.current')} {packageInfo.installed_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverUi.replaced')} {packageInfo.outranked_device_count}</span>
                              <span className="rounded-full bg-[var(--bg-hover)] px-1.5 py-0.5 text-[var(--fg-muted)]">{moduleT('driverUi.files')} {packageInfo.file_count}</span>
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
                            {/* 快捷提问：点它是**了解这个驱动**，不是要求操作 ——
                                所以用完整问句（见 getDriverAiQuestion），
                                而不是把搜索引擎的关键字原样丢过去。 */}
                            <AiAskButton
                              question={getDriverAiQuestion(packageInfo)}
                              className="inline-flex h-7 w-7 items-center justify-center"
                            />
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
        description={moduleT('driverUi.confirmDeleteDesc', {
          name: selectedDriverSummary,
          size: selectedDriverSizeText,
        })}
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
