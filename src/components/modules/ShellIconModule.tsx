// ============================================================================
// 这里的“虚拟磁盘”是 Explorer 外壳命名空间图标，不是磁盘驱动器本身。
// 后端负责重新校验 CLSID、Hive、视图和系统保护边界，前端只维护选择与交互状态。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  HardDriveDownload,
  Loader2,
  Lock,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import {
  openShellIconBackupDir,
  openShellIconLog,
  openShellIconRegistry,
  removeShellIcon,
  restartExplorer,
  scanShellIcons,
  type ShellIconInfo,
  type ShellIconTarget,
} from '../../api/commands';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

type PendingAction = { target: ShellIconTarget; mode: 'remove' | 'lock' };

function getRiskStyle(entry: ShellIconInfo): { label: string; className: string } {
  if (entry.isSystemProtected || entry.riskLevel === 'protected') {
    return { label: '系统保护', className: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]' };
  }
  if (entry.riskLevel === 'unknown') {
    return { label: '无法确认', className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]' };
  }
  if (entry.isLocked || entry.riskLevel === 'locked') {
    return { label: '已锁定', className: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' };
  }
  return { label: '第三方节点', className: 'bg-[var(--brand-green-10)] text-[var(--brand-green)]' };
}

function targetOf(entry: ShellIconInfo): ShellIconTarget {
  return { clsid: entry.clsid, hive: entry.hive, registryView: entry.registryView };
}

function ShellIconRow({
  entry,
  busy,
  onAction,
  onOpenRegistry,
}: {
  entry: ShellIconInfo;
  busy: boolean;
  onAction: (action: PendingAction) => void;
  onOpenRegistry: (target: ShellIconTarget) => void;
}) {
  const risk = getRiskStyle(entry);
  const protectedEntry = entry.isSystemProtected || entry.riskLevel === 'unknown';

  return (
    <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-green-10)]">
          {protectedEntry ? <Shield className="h-5 w-5 text-[var(--color-warning)]" /> : <HardDriveDownload className="h-5 w-5 text-[var(--brand-green)]" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]" title={entry.name}>{entry.name}</p>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${risk.className}`}>{risk.label}</span>
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] text-[var(--text-muted)]">{entry.hive} / {entry.registryView}</span>
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-[var(--text-muted)]">{entry.clsid}</p>
          <p className="mt-1 break-all text-xs font-medium text-[var(--text-secondary)]">关联应用：{entry.applicationName || '未知应用'}</p>
          <p className="mt-1 break-all text-xs text-[var(--text-faint)]">组件：{entry.sourcePath || entry.riskReason}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {!protectedEntry && (
            <>
              <button type="button" disabled={busy} onClick={() => onAction({ target: targetOf(entry), mode: 'remove' })} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-color)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50" title="备份后删除当前注册表节点，软件之后可能重新创建">
                <Trash2 className="h-3.5 w-3.5" />删除
              </button>
              <button type="button" disabled={busy} onClick={() => onAction({ target: targetOf(entry), mode: 'lock' })} className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50" title="物理删除节点并锁定父级，防止软件重新创建">
                <Lock className="h-3.5 w-3.5" />彻底删除
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--border-muted)] pt-2">
        <p className="min-w-0 break-all text-[11px] text-[var(--text-faint)]">{entry.regPath}</p>
        <button type="button" disabled={busy} onClick={() => onOpenRegistry(targetOf(entry))} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-50" title="在注册表编辑器中定位该节点">
          <FolderOpen className="h-3.5 w-3.5" />定位注册表
        </button>
      </div>
    </div>
  );
}

export function ShellIconModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useModuleDashboard('shellIcons');
  const { showToast } = useToast();
  const [entries, setEntries] = useState<ShellIconInfo[] | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [isOpeningBackup, setIsOpeningBackup] = useState(false);
  const lastScanTrigger = useRef(0);

  const scan = useCallback(async () => {
    updateModuleState('shellIcons', { status: 'scanning', error: null });
    try {
      const result = await scanShellIcons();
      setEntries(result);
      updateModuleState('shellIcons', { status: 'done', fileCount: result.length, totalSize: 0 });
      setExpandedModule('shellIcons');
    } catch (error) {
      updateModuleState('shellIcons', { status: 'error', error: String(error) });
    }
  }, [setExpandedModule, updateModuleState]);

  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTrigger.current) {
      lastScanTrigger.current = oneClickScanTrigger;
      void scan();
    }
  }, [oneClickScanTrigger, scan]);

  // 旧版本遗留的空锁定节点仍保留操作入口，重新执行时会物理删除并校验结果。
  const actionableCount = useMemo(() => entries?.filter(entry => !entry.isSystemProtected && entry.riskLevel !== 'unknown').length ?? 0, [entries]);

  const executeAction = useCallback(async (action: PendingAction) => {
    const key = `${action.target.hive}:${action.target.registryView}:${action.target.clsid}`;
    setBusyTarget(key);
    try {
      const result = action.mode === 'remove'
        ? await removeShellIcon(action.target, 1)
        : await removeShellIcon(action.target, 2);
      showToast({ type: 'success', title: '操作完成', description: result.message });
      await scan();
    } catch (error) {
      showToast({ type: 'error', title: '虚拟磁盘操作失败', description: String(error) });
    } finally {
      setBusyTarget(null);
      setPendingAction(null);
    }
  }, [scan, showToast]);

  const isExpanded = expandedModule === 'shellIcons';
  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !pendingAction) return null;

  return (
    <>
      <ModuleCard
        id="shellIcons"
        title="外壳图标清理"
        description="清理此电脑中的第三方外壳图标（如某网盘、某PS等），支持备份、清理和防复活"
        icon={<HardDriveDownload className="h-6 w-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={0}
        countLabel="个节点"
        hideTotalSize
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'shellIcons')}
        onScan={() => void scan()}
        scanDisabled={Boolean(busyTarget)}
        scanButtonText={moduleState.status === 'scanning' ? '扫描中...' : entries ? '重新扫描' : '扫描外壳挂载'}
        error={moduleState.error}
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        titleExtra={<span className="rounded-full bg-orange-500/10 px-2 py-1 text-[10px] font-medium text-orange-600 dark:text-orange-400">需谨慎操作</span>}
      >
        <div className="space-y-4 p-5">
          {!entries && moduleState.status === 'idle' && <EmptyState icon={HardDriveDownload} title="尚未扫描外壳挂载" description="扫描后会列出此电脑中的第三方外壳图标，并显示 CLSID、关联组件和安全状态。" />}
          {moduleState.status === 'scanning' && !entries && <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 text-sm text-[var(--text-muted)]"><Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" /><span>正在读取 Explorer 外壳节点...</span></div>}

          {entries && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-[var(--bg-main)] p-3 text-center"><p className="text-xl font-bold text-[var(--text-primary)]">{entries.length}</p><p className="text-xs text-[var(--text-muted)]">扫描节点</p></div>
                <div className="rounded-xl bg-[var(--brand-green-10)] p-3 text-center"><p className="text-xl font-bold text-[var(--brand-green)]">{actionableCount}</p><p className="text-xs text-[var(--text-muted)]">可操作节点</p></div>
                <div className="rounded-xl bg-blue-500/10 p-3 text-center"><p className="text-xl font-bold text-blue-600 dark:text-blue-400">{entries.filter(entry => entry.isLocked).length}</p><p className="text-xs text-[var(--text-muted)]">已锁定</p></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
                <div className="flex flex-wrap gap-2 text-xs text-[var(--text-muted)]"><span className="inline-flex items-center gap-1"><Shield className="h-3.5 w-3.5 text-[var(--color-warning)]" />系统保护节点不会被操作</span><span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-[var(--brand-green)]" />操作前自动备份</span></div>
                <div className="flex gap-2">
                  <button type="button" disabled={isOpeningBackup} onClick={() => { setIsOpeningBackup(true); void openShellIconBackupDir().catch(error => showToast({ type: 'error', title: '打开备份目录失败', description: String(error) })).finally(() => setIsOpeningBackup(false)); }} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-color)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-50"><FolderOpen className="h-3.5 w-3.5" />备份目录</button>
                  <button type="button" onClick={() => void openShellIconLog().catch(error => showToast({ type: 'error', title: '打开操作记录失败', description: String(error) }))} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-color)] px-2.5 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"><FileText className="h-3.5 w-3.5" />操作记录</button>
                  <button type="button" onClick={() => void restartExplorer().then(() => showToast({ type: 'success', title: '外壳已刷新', description: '已通知 Explorer 重新读取外壳节点，不会重启任务栏进程。' })).catch(error => showToast({ type: 'error', title: '刷新外壳失败', description: String(error) }))} className="inline-flex items-center gap-1 rounded-lg border border-[var(--brand-green-20)] px-2.5 py-1.5 text-xs text-[var(--brand-green)] hover:bg-[var(--brand-green-10)]"><RefreshCw className="h-3.5 w-3.5" />刷新外壳</button>
                </div>
              </div>
              {entries.length === 0 ? <EmptyState icon={CheckCircle2} title="未发现第三方外壳图标" description="当前此电脑中没有扫描到可展示的第三方 Namespace 节点。" tone="success" compact /> : <div className="space-y-2">{entries.map(entry => <ShellIconRow key={`${entry.hive}-${entry.registryView}-${entry.clsid}`} entry={entry} busy={busyTarget !== null} onAction={setPendingAction} onOpenRegistry={(target) => { void openShellIconRegistry(target).catch(error => showToast({ type: 'error', title: '定位注册表失败', description: String(error) })); }} />)}</div>}
            </>
          )}
        </div>
      </ModuleCard>

      <ConfirmDialog
        isOpen={pendingAction !== null}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => { if (pendingAction) void executeAction(pendingAction); }}
        title={pendingAction?.mode === 'lock' ? '确认彻底删除' : '确认删除'}
        description={pendingAction?.mode === 'lock' ? '将先保存一份备份，物理删除外壳节点，并锁定父级注册表目录，阻止普通权限的软件重新创建该节点。' : '将先保存一份备份，再物理删除当前外壳节点；相关软件之后可能重新创建图标。'}
        warning="请确认应用名称和 CLSID。防复活规则不是系统级绝对锁死，管理员、SYSTEM 或 TrustedInstaller 仍可能绕过。"
        confirmText={pendingAction?.mode === 'lock' ? '彻底删除' : '删除'}
        isDanger
      />
    </>
  );
}

export default ShellIconModule;
