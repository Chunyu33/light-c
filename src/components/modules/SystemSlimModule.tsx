import { useAiModuleBridge } from '../ai/useAiModuleBridge';
// ============================================================================
// 系统瘦身模块组件
// 在仪表盘中展示系统瘦身功能
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { 
  Rocket, 
  Moon, 
  Package, 
  MemoryStick,
  Search,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  ShieldAlert,
  ChevronRight
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ModuleScanProgress } from '../ModuleScanProgress';
import { AdminRequiredHint } from '../AdminRequiredHint';
import { EmptyState } from '../EmptyState';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  getSystemSlimStatus,
  disableHibernation,
  enableHibernation,
  cleanupWinsxs,
  cleanupWinsxsResetbase,
  openVirtualMemorySettings,
  rebuildSearchIndex,
  SlimItemStatus,
  SlimOperationProgress,
  SystemSlimStatus
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// ============================================================================
// 配置
// ============================================================================

const itemIcons: Record<string, typeof Moon> = {
  hibernation: Moon,
  winsxs: Package,
  winsxs_resetbase: Package,
  pagefile: MemoryStick,
  search_index: Search,
};

const itemColors: Record<string, { bg: string; text: string }> = {
  hibernation: { bg: 'bg-indigo-500/10', text: 'text-indigo-500' },
  winsxs: { bg: 'bg-amber-500/10', text: 'text-amber-500' },
  winsxs_resetbase: { bg: 'bg-orange-500/10', text: 'text-orange-500' },
  pagefile: { bg: 'bg-cyan-500/10', text: 'text-cyan-500' },
  search_index: { bg: 'bg-blue-500/10', text: 'text-blue-500' },
};


/**
 * 取按钮文案。
 *
 * 中文说明：按钮文案必须反映真实状态，而不是固定文案：
 *   - 休眠项：开启时"关闭休眠"，已关闭时"开启休眠"；
 *   - 后端 action_text 是中文（无需清理 / 深度清理 / 执行清理 / 重新检测），
 *     在其它语言下需要通过它反查对应的多语言键，避免英文/日文界面出现中文按钮。
 */
function getActionLabel(
  item: SlimItemStatus,
  translate: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (item.id === 'hibernation') {
    return translate(item.enabled ? 'systemSlim.items.hibernation.disable' : 'systemSlim.items.hibernation.enable');
  }

  // action_text 与多语言键的对应关系；键顺序与后端文案一一对应。
  const actionTextToKey: Record<string, string> = {
    无需清理: 'noCleanup',
    开始清理: 'startCleanup',
    深度清理: 'deepCleanup',
    执行清理: 'runCleanup',
    重新检测: 'rescan',
    打开设置: 'openSettings',
  };
  const matchedKey = actionTextToKey[item.action_text];
  if (matchedKey) {
    return translate(`systemSlim.actions.${matchedKey}`);
  }

  // 后端新增文案而前端还没补多语言键时，至少不要退回静态旧文案（会造成状态不一致）。
  return item.action_text || translate(`systemSlim.items.${item.id}.action`);
}

/**
 * 格式化已用时间。
 *
 * 中文说明：DISM 清理的进度百分比长时间不动时，用户唯一能判断"还在跑"的依据就是已用时间，
 * 因此统一按「秒」或「分秒」显示，避免只显示毫秒造成困惑。
 */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : `${seconds}s`;
}

// ============================================================================
// 组件实现
// ============================================================================

export function SystemSlimModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, triggerHealthRefresh, oneClickScanTrigger } = useModuleDashboard('system');
  const { showToast } = useToast();

  // 用于跟踪是否已处理过当前的一键扫描触发
  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [status, setStatus] = useState<SystemSlimStatus | null>(null);
  // DISM 分析进度：只在 WinSxS 两项"分析中"时展示，避免几十秒里只有一个转圈
  const [winsxsProgress, setWinsxsProgress] = useState<{ percent: number; elapsed_ms: number } | null>(null);
  // 刚执行过组件清理时记下清理前的可回收量：分析结果回来才能说"到底有没有释放"，
  // 命令返回那一刻是不知道的（DISM 要重新分析才知道）。
  const pendingCleanupRef = useRef<{ before: number; resetBase: boolean } | null>(null);
  // showToast 每次渲染都可能是新函数；丢进 ref，事件订阅就不用把它写进依赖数组
  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);
  // 后台事件到达时要读最新状态做合并，不能靠闭包抓渲染那一刻的快照
  const statusRef = useRef<SystemSlimStatus | null>(null);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 后台 DISM 分析还在跑时，界面会把"重新检测"禁用（点了也只会拿回同样"分析中"的结果）。
  // 但后端的僵死自愈（超时后强制重启分析）只有收到新请求才会跑 —— 按钮锁死就永远等不到
  // 那次请求，互相等死。所以分析持续超过兜底时间（后端 600 秒 + 余量）就放开按钮，
  // 让用户能点一次把僵死的分析重新拉起来。
  const isAnalyzingWinsxs = status?.items.some((item) => item.analyzing) ?? false;
  const [analyzeTimedOut, setAnalyzeTimedOut] = useState(false);
  useEffect(() => {
    if (!isAnalyzingWinsxs) {
      setAnalyzeTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setAnalyzeTimedOut(true), 11 * 60 * 1000);
    return () => window.clearTimeout(timer);
  }, [isAnalyzingWinsxs]);
  // 接入 AI 助手（只读）：只给摘要，不提供操作动作。
  useAiModuleBridge('system-slim', {
    summary: () => {
      if (!status) return null;
      return [
        `系统瘦身可处理 ${status.items.length} 项，合计可释放约 ${formatSize(status.total_reclaimable)}。`,
        status.is_admin
          ? '当前已取得管理员权限，可以处理需要权限的项目。'
          : '当前没有管理员权限，需要权限的项目只能给出说明、无法直接处理。',
      ].join('');
    },
    // 只读读取：瘦身项列表（就是界面上那一列）。
    // 每条带上后端给的 status_text 与"能不能处理"，模型才不可能凭名字猜。
    readItems: (_targetId, offset, limit) => {
      const items = status?.items ?? [];
      if (items.length === 0) {
        // 空结果的两种原因分开说：排查方向完全不同
        return {
          total: 0,
          lines: [
            status
              ? '（已经检查过，但没有读到任何可处理的项目）'
              : '（当前还没有检查结果 —— 请先在模块里点一次扫描，再问这个问题）',
          ],
        };
      }
      return {
        total: items.length,
        lines: items.slice(offset, offset + limit).map((item) => {
          const size = item.size > 0 ? formatSize(item.size) : '未统计';
          return `${item.name}  ${size}  （${item.status_text}${item.actionable ? '，可处理' : '，当前不可处理'}）`;
        }),
      };
    },
    // 只读：单条详情。itemId 先用 items 里的 id，找不到再按名称兜一次。
    readItemDetail: (itemId) => {
      const wanted = itemId.trim();
      if (!wanted) return null;
      const items = status?.items ?? [];
      const item =
        items.find((entry) => entry.id === wanted) ??
        items.find((entry) => entry.name.trim() === wanted);
      if (!item) return null;
      return [
        `名称：${item.name}`,
        `说明：${item.description}`,
        `可释放：${item.size > 0 ? formatSize(item.size) : '未统计'}`,
        `当前状态：${item.status_text}`,
        item.warning ? `⚠️ 风险提示：${item.warning}` : '',
        item.actionable
          ? `可执行的操作：${item.action_text}`
          : '当前状态下不能直接处理（通常是缺管理员权限，或该状态不允许操作）',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // 正在执行的瘦身操作进度：DISM 清理可能持续数分钟，必须有阶段与百分比反馈。
  const [operationProgress, setOperationProgress] = useState<SlimOperationProgress | null>(null);
  const [showAdminWarning, setShowAdminWarning] = useState(true);
  // 基线压缩不可撤销，点击后先二次确认再执行。
  const [pendingConfirmItem, setPendingConfirmItem] = useState<SlimItemStatus | null>(null);
  // 确认弹窗回调需要拿到最新的处理函数，用 ref 避免为了它重建所有按钮回调。
  const handleActionRef = useRef<(item: SlimItemStatus) => void>(() => {});

  // 订阅后端进度事件；操作结束后保留最终状态，由操作流程负责清理。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<SlimOperationProgress>('system-slim:progress', (event) => {
      if (!disposed) setOperationProgress(event.payload);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        // 订阅失败只影响进度展示，操作本身仍可执行，因此仅记录日志。
        console.error('订阅系统瘦身进度失败:', error);
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  /**
   * WinSxS 的 DISM 分析在后台跑，结果通过事件补推。
   *
   * 中文说明：DISM 分析要几十秒到几分钟，以前整条检测接口都等它（30 秒超时才放行），
   * 用户看到的就是"检查中"转半分钟。现在后端先返回其余四项并把这两项标成 analyzing，
   * 分析结束后由这里替换掉。
   */
  useEffect(() => {
    let disposed = false;
    const disposers: Array<() => void> = [];

    const register = (promise: Promise<() => void>) => {
      promise
        .then((dispose) => {
          if (disposed) dispose();
          else disposers.push(dispose);
        })
        .catch((error) => {
          // 订阅失败只影响这一项的自动更新，用户仍可手动重新检测
          console.error('订阅 WinSxS 分析事件失败:', error);
        });
    };

    // DISM 分析的百分比：几十秒的等待里只有这个能让用户确认"在推进"
    register(
      listen<{ percent: number; elapsed_ms: number }>('system-slim:winsxs-progress', (event) => {
        if (!disposed) setWinsxsProgress(event.payload ?? null);
      }),
    );

    register(
      listen<{ items: SlimItemStatus[] }>('system-slim:winsxs-ready', (event) => {
        if (disposed) return;
        setWinsxsProgress(null);

        const incoming = event.payload?.items ?? [];
        if (incoming.length === 0) return;

        const current = statusRef.current;
        if (!current) return;

        const byId = new Map(incoming.map((item) => [item.id, item]));
        const items = current.items.map((item) => byId.get(item.id) ?? item);
        const total = items
          .filter((item) => item.enabled)
          .reduce((sum, item) => sum + item.size, 0);

        const next = { ...current, items, total_reclaimable: total };
        statusRef.current = next;
        setStatus(next);
        updateModuleState('system', {
          fileCount: items.filter((item) => item.actionable).length,
          totalSize: total,
        });

        // 刚执行过组件清理：现在分析结果回来了，才有资格说"到底有没有释放空间"。
        // 命令返回那一刻是不知道的 —— 以前在那一刻编了个数字，是假的。
        const pending = pendingCleanupRef.current;
        if (!pending) return;

        const winsxsItem = items.find((item) => item.id === 'winsxs');
        if (!winsxsItem || winsxsItem.analyzing) return;
        pendingCleanupRef.current = null;

        const title = pending.resetBase
          ? moduleT('systemSlim.resetBaseCompletedTitle')
          : moduleT('systemSlim.componentCleanup');

        if (winsxsItem.size <= 0) {
          // size 为 0 有两种可能：真的清空了，或者这次分析根本没读到结果。
          // 后者（分析失败时 actionable 为 true）不能说成"清干净了"——那就是撒谎。
          showToastRef.current({
            title,
            description: winsxsItem.actionable
              ? moduleT('systemSlim.cleanupReprobeFailed')
              : moduleT('systemSlim.cleanupNoRemaining'),
            type: winsxsItem.actionable ? 'warning' : 'success',
          });
        } else if (winsxsItem.size < pending.before) {
          showToastRef.current({
            title,
            description: moduleT('systemSlim.actualReclaim', {
              size: formatSize(pending.before - winsxsItem.size),
            }),
            type: 'success',
          });
        } else {
          showToastRef.current({
            title,
            description: moduleT('systemSlim.cleanupNoSpaceFreed', {
              size: formatSize(winsxsItem.size),
            }),
            type: 'info',
          });
        }
      }),
    );

    return () => {
      disposed = true;
      disposers.forEach((dispose) => dispose());
    };
  }, [updateModuleState, moduleT]);

  const markItemsNeedRescan = useCallback((itemIds: string[]) => {
    setStatus((current) => {
      if (!current) return current;
      const idSet = new Set(itemIds);
      const items = current.items.map((item) => {
        if (!idSet.has(item.id)) return item;
        return {
          ...item,
          enabled: false,
          size: 0,
          actionable: false,
          action_text: moduleT('systemSlim.rescan'),
          status_text: moduleT('systemSlim.done'),
        };
      });
      updateModuleState('system', {
        fileCount: items.filter((item) => item.actionable).length,
        totalSize: items.filter((item) => item.enabled).reduce((sum, item) => sum + item.size, 0),
      });
      return { ...current, items, total_reclaimable: items.filter((item) => item.enabled).reduce((sum, item) => sum + item.size, 0) };
    });
  }, [updateModuleState]);

  /**
   * 操作结束后立即重新读取后端状态。
   *
   * 中文说明：状态必须以后端为准。此前操作完成只做本地"标记需重新检测"，导致按钮文案和
   * 体积停留在操作前的快照（关掉休眠后仍显示"关闭休眠"、清理完仍显示旧的估算体积）。
   * 这里不复用 loadStatus，因为它带有"忙碌时拦截"的保护，而本函数正是在操作收尾阶段调用。
   */
  const refreshStatusAfterAction = useCallback(async () => {
    try {
      const result = await getSystemSlimStatus();
      setStatus(result);
      updateModuleState('system', {
        status: 'done',
        fileCount: result.items.filter((current) => current.actionable).length,
        totalSize: result.total_reclaimable,
      });
    } catch (error) {
      // 刷新失败不影响操作结果本身，退化为提示用户手动重新检测。
      console.warn('操作后刷新系统瘦身状态失败:', error);
      markItemsNeedRescan(['hibernation', 'winsxs', 'winsxs_resetbase']);
    }
  }, [markItemsNeedRescan, updateModuleState]);

  // 加载系统瘦身状态
  //
  // forceRefresh：用户点"重新检测"时传 true —— 组件存储分析的结论有 10 分钟缓存，
  // 不强制刷新的话点了之后接口秒回旧数据，界面像"刷新了一下"而不是真的重测。
  const loadStatus = useCallback(async (forceRefresh = false) => {
    // 系统操作执行期间禁止重新检测：DISM 分析与清理并发会互相干扰，也会让状态显示错乱。
    if (actionLoading) {
      showToast({ title: moduleT('systemSlim.busyTitle'), description: moduleT('systemSlim.busyDesc'), type: 'info' });
      return;
    }

    setLoading(true);
    updateModuleState('system', { status: 'scanning' });
    
    try {
      const result = await getSystemSlimStatus(forceRefresh);
      setStatus(result);
      
      updateModuleState('system', {
        status: 'done',
        fileCount: result.items.filter(i => i.actionable).length,
        totalSize: result.total_reclaimable,
      });

      setExpandedModule('system');
    } catch (error) {
      console.error('加载系统瘦身状态失败:', error);
      updateModuleState('system', { status: 'error', error: String(error) });
    } finally {
      setLoading(false);
    }
  }, [actionLoading, moduleT, showToast, updateModuleState, setExpandedModule]);

  // 监听一键扫描触发器
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      loadStatus(true);
    }
  }, [oneClickScanTrigger, loadStatus]);

  // 执行瘦身操作
  const runAction = useCallback(async (item: SlimItemStatus) => {
    if (!status?.is_admin) {
      showToast({ title: moduleT('systemSlim.adminRequired'), description: moduleT('systemSlim.adminHint'), type: 'error' });
      return;
    }

    // 同一时间只允许一个系统级操作：DISM 与 powercfg 并发会互相干扰且更难排查。
    if (actionLoading) {
      showToast({ title: moduleT('systemSlim.busyTitle'), description: moduleT('systemSlim.busyDesc'), type: 'info' });
      return;
    }

    setActionLoading(item.id);
    // 记录操作前的体积，操作完成后用真实差值告诉用户"实际释放了多少"，而不是只报估算值。
    const sizeBefore = status?.items.find((current) => current.id === item.id)?.size ?? 0;
    // 先用本地状态兜底，避免后端首条进度到达前出现"点了没反应"的空窗。
    setOperationProgress({
      item_id: item.id,
      phase: 'preparing',
      message: moduleT('systemSlim.progressPreparing'),
      percent: 0,
      status: 'running',
      elapsed_ms: 0,
    });

    try {
      switch (item.id) {
        case 'hibernation':
          if (item.enabled) {
            await disableHibernation();
            showToast({ title: moduleT('systemSlim.operationCompleted'), description: moduleT('systemSlim.operationCompletedDesc'), type: 'success' });
          } else {
            await enableHibernation();
            showToast({ title: moduleT('systemSlim.operationCompleted'), description: moduleT('systemSlim.operationCompletedDesc'), type: 'success' });
          }
          break;
        case 'winsxs':
          await cleanupWinsxs();
          // 命令成功 ≠ 真的释放了空间。DISM 要重新分析（约 1 分钟）才知道结果，
          // 所以这里只说"命令完成、正在重新分析"，等分析结果推回来再报实际数字。
          pendingCleanupRef.current = { before: sizeBefore, resetBase: false };
          showToast({ title: moduleT('systemSlim.componentCleanup'), description: moduleT('systemSlim.cleanupStartedReprobe'), type: 'success' });
          break;
        case 'winsxs_resetbase':
          await cleanupWinsxsResetbase();
          pendingCleanupRef.current = { before: sizeBefore, resetBase: true };
          showToast({ title: moduleT('systemSlim.resetBaseCompletedTitle'), description: moduleT('systemSlim.cleanupStartedReprobe'), type: 'success' });
          break;
        case 'pagefile':
          await openVirtualMemorySettings();
          showToast({ title: moduleT('systemSlim.settingsOpened'), description: moduleT('systemSlim.pagefileOpened'), type: 'info' });
          break;
        case 'search_index':
          await rebuildSearchIndex();
          showToast({ title: moduleT('systemSlim.searchIndexRebuildStartedTitle'), description: moduleT('systemSlim.searchIndexRebuildStarted'), type: 'success' });
          break;
      }

      // 操作完成后重新读取真实状态：休眠是否关闭、组件是否还有可回收内容都必须以后端为准，
      // 否则按钮文案会停留在操作前的状态（例如关掉休眠后仍显示"关闭休眠"）。
      if (item.id !== 'pagefile' && item.id !== 'search_index') {
        await refreshStatusAfterAction();
      }

      if (item.id === 'hibernation' || item.id === 'winsxs' || item.id === 'winsxs_resetbase') {
        triggerHealthRefresh();
      }
    } catch (error) {
      showToast({ title: moduleT('systemSlim.operationFailed'), description: String(error), type: 'error' });
    } finally {
      setActionLoading(null);
      // 操作结束即撤下进度视图：成功由 toast 反馈，失败由错误 toast 反馈。
      setOperationProgress(null);
    }
  }, [actionLoading, moduleT, refreshStatusAfterAction, showToast, status, triggerHealthRefresh, markItemsNeedRescan]);

  // 让确认弹窗始终调用到最新的处理函数。
  useEffect(() => {
    handleActionRef.current = runAction;
  }, [runAction]);

  /**
   * 按钮入口：基线压缩会移除更新回滚基线、不可撤销，因此先弹二次确认；
   * 其余操作可逆，直接执行。
   */
  const handleAction = useCallback((item: SlimItemStatus) => {
    if (item.id === 'winsxs_resetbase') {
      setPendingConfirmItem(item);
      return;
    }
    void runAction(item);
  }, [runAction]);

  const isExpanded = expandedModule === 'system';
  // 任一系统操作执行中即视为忙碌：所有操作入口（按钮、重新检测）统一用它拦截。
  const isActionBusy = actionLoading !== null;
  // 分析刚开始 -> 禁用；分析已经拖过兜底时间 -> 放开，避免按钮和僵死进程互相等死。
  const isAnalyzingLocked = isAnalyzingWinsxs && !analyzeTimedOut;

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !actionLoading) {
    return null;
  }

  return (
    <>
      {/* 基线压缩不可撤销，必须二次确认后才执行 */}
      <ConfirmDialog
        isOpen={pendingConfirmItem !== null}
        title={moduleT('systemSlim.confirmResetBaseTitle')}
        description={moduleT('systemSlim.confirmResetBaseDesc')}
        warning={moduleT('systemSlim.items.winsxs_resetbase.warning')}
        confirmText={moduleT('systemSlim.confirmResetBaseConfirm')}
        cancelText={t('cancel')}
        onConfirm={() => {
          const item = pendingConfirmItem;
          setPendingConfirmItem(null);
          if (item) void handleActionRef.current(item);
        }}
        onCancel={() => setPendingConfirmItem(null)}
        isDanger
      />

      <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
      id="system"
        title={navT('systemSlim')}
        description={navT('systemSlimDesc')}
      icon={<Rocket className="w-6 h-6 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'system')}
      onScan={() => loadStatus(true)}
      scanButtonText={loading ? moduleT('systemSlim.checking') : status ? moduleT('systemSlim.rescan') : moduleT('systemSlim.check')}
      // 检测中 / 后台分析中 / 系统操作执行中都不允许重新检测：
      // 前两者点了也拿不到新结论，后者与 DISM 并发会互相干扰。
      scanDisabled={loading || isAnalyzingLocked || isActionBusy}
      error={moduleState.error}
      headerExtra={
        status && (
          <div className="flex items-center gap-2 text-xs">
            {status.is_admin ? (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600">
                <CheckCircle2 className="w-3 h-3" />
                {moduleT('systemSlim.administrator')}
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600">
                <ShieldAlert className="w-3 h-3" />
                {moduleT('systemSlim.permissionRequired')}
              </span>
            )}
          </div>
        )
      }
    >
      {/* 展开内容 */}
      <div className="p-4 space-y-3">
        {/* 管理员权限警告：是否已提权由公共组件自己判断，本模块只管"要不要显示"。
            ⚠️ 不要加 `status &&` —— 那要等扫描返回，用户在扫描前完全看不到这条提示，
            而这恰恰是他最该知道"我现在没有权限"的时候。 */}
        {showAdminWarning && (
          <AdminRequiredHint
            description={moduleT('systemSlim.adminHint')}
            dismissible
            onDismiss={() => setShowAdminWarning(false)}
          />
        )}

        {/* 加载状态 */}
        {loading && !status && (
          <ModuleScanProgress
            title={`${moduleT('systemSlim.checking')}...`}
            icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
          />
        )}

        {/* 空状态 */}
        {moduleState.status === 'idle' && !status && (
          <EmptyState
            icon={Rocket}
              title={t('notScannedSystemState')}
            description={moduleT('systemSlim.emptyDesc')}
          />
        )}

        {/* 瘦身项列表 */}
        {status && (
          <div className="space-y-2">
            {status.items.map((item) => {
              const Icon = itemIcons[item.id] || Package;
              const colors = itemColors[item.id] || itemColors.winsxs;
              const isLoading = actionLoading === item.id;
              // 禁用条件与按钮样式共用同一个判定，避免"看着能点、点了没反应"。
              const isItemButtonDisabled = !item.actionable || !status.is_admin || isActionBusy;

              return (
                <div
                  key={item.id}
                  className={`glass-list bg-[var(--bg-base)] rounded-xl border border-[var(--border-default)] overflow-hidden transition-all ${
                    item.actionable
                      ? 'hover:border-emerald-500/30'
                      : item.analyzing
                        ? ''
                        : 'opacity-60'
                  }`}
                >
                  <div className="p-4">
                    <div className="flex items-start gap-3">
                      {/* 图标 */}
                      <div className={`w-10 h-10 rounded-lg ${colors.bg} flex items-center justify-center shrink-0`}>
                        <Icon className={`w-5 h-5 ${colors.text}`} />
                      </div>

                      {/* 内容 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-semibold text-[var(--fg-primary)]">
                            {moduleT(`systemSlim.items.${item.id}.name`, { defaultValue: item.name })}
                            {/* 搜索索引重建依赖本机 SearchAPI.dll，尚未在真实环境充分验证，临时标注 Beta */}
                            {item.id === 'search_index' && <span className="ml-1">（Beta）</span>}
                          </h4>
                          {/* 后台还在分析这一项：不是"不可用"，是"结论还没回来"，所以不打灰 */}
                          {item.analyzing && (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--brand-green)]" />
                          )}
                          {item.enabled && item.size > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full text-[0.71rem] font-medium bg-emerald-500/10 text-emerald-600">
                              {formatSize(item.size)}
                            </span>
                          )}
                          {!item.enabled && item.id === 'hibernation' && (
                            <span className="px-1.5 py-0.5 rounded-full text-[0.71rem] font-medium bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                              {moduleT('systemSlim.disabled')}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-[var(--fg-secondary)] mt-0.5">{moduleT(`systemSlim.items.${item.id}.description`, { defaultValue: item.description })}</p>
                        {item.status_text && (
                          <p className="text-[0.79rem] text-[var(--fg-muted)] mt-1">
                            {item.id === 'search_index' ? (
                              // 搜索索引的 itemStatus 键是固定文案；可操作时展示动态状态（服务 + 数据库大小），
                              // 不可操作时直接展示后端细分的置灰原因（服务停止/已禁用/未安装）
                              item.actionable ? (
                                <>
                                  {moduleT('systemSlim.searchIndexServiceRunning')}
                                  {item.size > 0 && (
                                    <> · {moduleT('systemSlim.searchIndexDbSize', { size: formatSize(item.size) })}</>
                                  )}
                                </>
                              ) : (
                                item.status_text
                              )
                            ) : (
                              // 直接用后端文案。这里曾经套了一层带 defaultValue 的翻译调用，
                              // 但那个键真实存在，defaultValue 永远不生效 —— 于是五项全被替换成
                              // 同一句"操作已完成，请重新检测刷新当前状态"，后端给出的
                              // "DISM 未发现可回收组件"这类真实结论一律看不到。
                              item.status_text
                            )}
                          </p>
                        )}

                        {/* 风险提示 */}
                        <div className="mt-2 flex items-start gap-1.5 bg-amber-500/5 rounded-lg px-2 py-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-0.5" />
                          <p className="text-[0.71rem] text-amber-600 leading-relaxed">{moduleT(`systemSlim.items.${item.id}.warning`, { defaultValue: item.warning })}</p>
                        </div>

                        {/* 分析进度：DISM 正在跑、还没有结论时，用百分比证明它在推进。
                            只挂在 winsxs 那一项上 —— 两项共用同一个分析结果，重复画两遍反而吵。 */}
                        {item.id === 'winsxs' && item.analyzing && winsxsProgress && (
                          <div className="mt-2 rounded-lg bg-[var(--brand-green-10)] px-3 py-2">
                            <div className="flex items-center justify-between gap-2 text-[0.79rem] text-[var(--brand-green)]">
                              <span className="truncate">{moduleT('systemSlim.analyzingComponents')}</span>
                              <span className="shrink-0 tabular-nums">
                                {winsxsProgress.percent > 0
                                  ? `${winsxsProgress.percent}%`
                                  : formatElapsed(winsxsProgress.elapsed_ms)}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                              <div
                                className="h-full rounded-full bg-[var(--brand-green)] transition-all duration-500"
                                // DISM 一开始只报 0%，给一条很短的起始段，否则进度条看着是空的
                                style={{ width: `${Math.max(winsxsProgress.percent, 2)}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {/* 执行进度：让用户看到阶段、百分比和已用时间 */}
                        {isLoading && operationProgress && operationProgress.item_id === item.id && (
                          <div className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2">
                            <div className="flex items-center justify-between gap-2 text-[0.79rem] text-emerald-700 dark:text-emerald-400">
                              <span className="truncate">{operationProgress.message}</span>
                              <span className="shrink-0 tabular-nums">
                                {operationProgress.percent > 0 ? `${operationProgress.percent}%` : formatElapsed(operationProgress.elapsed_ms)}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                              <div
                                className={`h-full rounded-full bg-emerald-500 transition-all duration-300 ${operationProgress.percent > 0 ? '' : 'w-1/3 animate-pulse'}`}
                                style={operationProgress.percent > 0 ? { width: `${operationProgress.percent}%` } : undefined}
                              />
                            </div>
                            <p className="mt-1.5 flex items-center gap-1 text-[0.71rem] text-[var(--fg-muted)]">
                              <ShieldAlert className="h-3 w-3 shrink-0 text-amber-500" />
                              {moduleT('systemSlim.progressElapsed', { time: formatElapsed(operationProgress.elapsed_ms) })} · {moduleT('systemSlim.progressDoNotClose')}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* 操作按钮 */}
                      <div className="shrink-0">
                        <button
                          onClick={() => handleAction(item)}
                          /*
                            只要有任何操作在跑就禁用全部按钮：DISM 与 powercfg 并发会互相干扰。
                            禁用条件必须和下方样式使用同一个判定，否则会出现"看得出能点、点了没反应"。
                          */
                          disabled={isItemButtonDisabled}
                          title={isActionBusy ? moduleT('systemSlim.waitForCurrent') : undefined}
                          className={`
                            px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                            ${isItemButtonDisabled
                              ? 'cursor-not-allowed bg-[var(--bg-hover)] text-[var(--fg-muted)]'
                              : item.id === 'winsxs_resetbase'
                                // 基线压缩不可撤销、且会让已装更新无法卸载 —— 用危险色而不是品牌绿，
                                // 让"这一项和别的项不是同一个风险级别"在按下去之前就看得出来。
                                ? 'bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger)]/90 active:scale-95'
                                : 'bg-emerald-500 text-white hover:bg-emerald-600 active:scale-95'
                            }
                          `}
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin" />
                              <span>{moduleT('systemSlim.executing')}</span>
                            </>
                          ) : (
                            <>
                              <span>
                                {/*
                                  按钮文案必须随真实状态变化，因此按状态取多语言文案：
                                  休眠开启时显示"关闭休眠"，已关闭时显示"开启休眠"（此前一直静态显示"关闭休眠"）。
                                  其余按后端 action_text 反查对应多语言键，查不到才退化为后端原文。
                                */}
                                {getActionLabel(item, moduleT)}
                              </span>
                              <ChevronRight className="w-3 h-3" />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 底部说明 */}
        {status && (
          <div className="glass-block bg-[var(--bg-elevated)] rounded-lg px-3 py-2 text-[0.71rem] text-[var(--fg-muted)] leading-relaxed">
            <strong className="text-[var(--fg-secondary)]">{moduleT('systemSlim.tip')}</strong>
            {moduleT('systemSlim.tipDesc')}
          </div>
        )}
      </div>
      </ModuleCard>
    </>
  );
}

export default SystemSlimModule;
