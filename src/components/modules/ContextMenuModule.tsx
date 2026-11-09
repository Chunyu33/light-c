import { useAiModuleBridge } from '../ai/useAiModuleBridge';
// ============================================================================
// 右键菜单清理模块
// 扫描 Windows 注册表中注册的右键菜单项，
// 识别指向不存在可执行文件的无效条目并提供一键清理
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MousePointerClick,
  Loader2,
  Trash2,
  AlertTriangle,
  Shield,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Terminal,
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ModuleDeleteProgress } from '../ModuleDeleteProgress';
import { ModuleOperationToolbar } from '../ModuleOperationToolbar';
import { ModuleScanProgress } from '../ModuleScanProgress';
import { AdminRequiredHint, useAdminPrivilege } from '../AdminRequiredHint';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import {
  scanContextMenu,
  deleteContextMenuEntries,
  openContextMenuBackupDir,
  recordCleanupAction,
  type ContextMenuScanResult,
  type ContextMenuEntry,
  type ContextMenuDeleteRequest,
  type CleanupLogEntryInput,
} from '../../api/commands';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * scope id → 颜色。id 由后端给（file / folder / background / drive / library），
 * 文案一律走 i18n —— 后端不再决定界面上显示什么字。
 */
const SCOPE_STYLE: Record<string, string> = {
  file: 'status-chip text-blue-600',
  folder: 'status-chip text-yellow-600',
  background: 'status-chip text-purple-600',
  drive: 'status-chip text-orange-600',
  library: 'status-chip text-teal-600',
};

function getScopeStyle(scope: string, translate: (key: string) => string): { label: string; className: string } {
  const key = `contextMenu.scope.${scope}`;
  const label = translate(key);
  return {
    // i18n 缺键时会把 key 原样返回，这时至少显示 id，别让界面冒出 "contextMenu.scope.xxx"
    label: label === key ? scope : label,
    className: SCOPE_STYLE[scope] ?? 'bg-[var(--bg-hover)] text-[var(--text-muted)]',
  };
}

/** 与后端保持同一失效判定：只有"说了路径、文件却不在"才算失效。 */
function isInvalidContextMenuEntry(entry: Pick<ContextMenuEntry, 'exe_status'>): boolean {
  return entry.exe_status === 'missing';
}

/**
 * 提不出路径、无法判定的条目。
 *
 * 这类（COM 处理器、rundll32 代理、级联菜单）不该标红，也不该被当垃圾清掉 ——
 * 界面给它一个中性徽章，说明"程序判断不了"，而不是暗示它坏了。
 */
function isUnknownContextMenuEntry(entry: Pick<ContextMenuEntry, 'exe_status'>): boolean {
  return entry.exe_status === 'unknown';
}

// ============================================================================
// 子组件：条目行
// ============================================================================

interface EntryRowProps {
  entry: ContextMenuEntry;
  isSelected: boolean;
  onToggle: (entry: ContextMenuEntry) => void;
}

function EntryRow({ entry, isSelected, onToggle }: EntryRowProps) {
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const [expanded, setExpanded] = useState(false);
  const scope = getScopeStyle(entry.scope, moduleT);
  const isInvalid = isInvalidContextMenuEntry(entry);
  const isUnknown = isUnknownContextMenuEntry(entry);
  const isProtected = entry.is_system_protected;

  return (
    <div
      className={`
        rounded-xl border transition-colors
        ${isProtected
          ? 'bg-[var(--color-danger)]/5 border-[var(--color-danger)]/15 cursor-not-allowed'
          : isSelected
            ? 'bg-[var(--brand-green-10)] border-[var(--brand-green-20)] cursor-pointer'
            : 'bg-[var(--bg-main)] border-transparent hover:bg-[var(--bg-hover)] cursor-pointer'
        }
      `}
      onClick={() => !isProtected && onToggle(entry)}
    >
      {/* 主行 */}
      <div className="flex items-center gap-3 p-3">
        {/* 复选框 */}
        <div
          className={`
            w-5 h-5 rounded border-2 flex items-center justify-center shrink-0
            ${isProtected
              ? 'border-[var(--text-faint)] bg-[var(--bg-hover)] opacity-40'
              : isSelected
                ? 'bg-[var(--brand-green)] border-[var(--brand-green)]'
                : 'border-[var(--text-faint)]'
            }
          `}
        >
          {isSelected && !isProtected && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
          {isProtected && (
            <Shield className="w-3 h-3 text-[var(--text-faint)]" />
          )}
        </div>

        {/* 图标区 */}
        <div
          className={`
            w-9 h-9 rounded-lg flex items-center justify-center shrink-0
            ${isProtected
              ? 'bg-[var(--color-danger)]/15'
              : isInvalid
                ? 'bg-[var(--color-danger)]/10'
                : isUnknown
                  ? 'bg-[var(--bg-hover)]'
                  : 'bg-[var(--brand-green-10)]'
            }
          `}
        >
          {isProtected
            ? <Shield className="w-4 h-4 text-[var(--color-danger)]" />
            : isInvalid
              ? <AlertTriangle className="w-4 h-4 text-[var(--color-danger)]" />
              : isUnknown
                // 判不了就用中性图标：给问号/警告会让人以为它坏了
                ? <MousePointerClick className="w-4 h-4 text-[var(--text-muted)]" />
                : <MousePointerClick className="w-4 h-4 text-[var(--brand-green)]" />
          }
        </div>

        {/* 文字信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-[var(--text-primary)] truncate max-w-[17.14rem]">
              {entry.display_name || entry.key_name}
            </p>

            {/* 风险等级标签 */}
            {entry.risk_level === 'danger' && (
              <span className="px-1.5 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--color-danger)]/15 text-[var(--color-danger)] shrink-0">
                {moduleT('contextMenu.systemProtected')}
              </span>
            )}
            {entry.risk_level === 'caution' && (
              <span className="px-1.5 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] shrink-0">
                {moduleT('contextMenu.caution')}
              </span>
            )}

            {/* 作用范围标签 */}
            <span className={`px-1.5 py-0.5 rounded text-[0.71rem] font-medium shrink-0 ${scope.className}`}>
              {scope.label}
            </span>

            {/* 注册表根 */}
            <span className="px-1.5 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">
              {entry.reg_root}
            </span>

            {/* 无效标记 */}
            {isInvalid && (
              <span className="px-1.5 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--color-danger)]/10 text-[var(--color-danger)] shrink-0">
                {moduleT('contextMenu.missing')}
              </span>
            )}

            {/* 无法判定：中性色，别让用户以为这条也坏了 */}
            {isUnknown && (
              <span className="px-1.5 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">
                {moduleT('contextMenu.unknown')}
              </span>
            )}

            {/* 需要管理员 */}
            {entry.needs_admin && (
              <span className="px-1.5 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] shrink-0">
                {moduleT('contextMenu.admin')}
              </span>
            )}
          </div>

          {/* exe 路径预览 */}
          {entry.exe_path && (
            <p
              className={`text-xs mt-0.5 truncate ${
                isInvalid ? 'text-[var(--color-danger)]/70' : 'text-[var(--text-muted)]'
              }`}
              title={entry.exe_path}
            >
              <FolderOpen className="inline w-3 h-3 mr-1 opacity-60" />
              {entry.exe_path}
            </p>
          )}

          {/* 系统保护提示 */}
          {isProtected && (
            <p className="text-xs mt-0.5 text-[var(--color-danger)]/70">
              {moduleT('contextMenu.comWarning')}
            </p>
          )}
        </div>

        {/* 展开/折叠按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="shrink-0 p-1 rounded text-[var(--text-faint)] hover:text-[var(--text-muted)]"
          title={t('viewDetails')}
        >
          {expanded
            ? <ChevronDown className="w-4 h-4" />
            : <ChevronRight className="w-4 h-4" />
          }
        </button>
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div
          className="px-4 pb-3 space-y-1.5 border-t border-[var(--border-muted)]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 注册表完整路径 */}
          <div className="flex items-start gap-2 pt-2">
            <span className="text-[0.79rem] text-[var(--text-faint)] shrink-0 w-20">{moduleT('contextMenu.registryPath')}</span>
            <span className="text-[0.79rem] text-[var(--text-muted)] break-all font-mono">
              {entry.registry_path}
            </span>
          </div>

          {/* 原始命令 */}
          {entry.command && (
            <div className="flex items-start gap-2">
              <span className="text-[0.79rem] text-[var(--text-faint)] shrink-0 w-20">{moduleT('contextMenu.command')}</span>
              <span
                className="text-[0.79rem] text-[var(--text-muted)] break-all font-mono"
                title={entry.command}
              >
                <Terminal className="inline w-3 h-3 mr-1 opacity-60" />
                {entry.command.length > 120
                  ? entry.command.slice(0, 120) + '…'
                  : entry.command}
              </span>
            </div>
          )}

          {/* 图标路径 */}
          {entry.icon_path && (
            <div className="flex items-start gap-2">
              <span className="text-[0.79rem] text-[var(--text-faint)] shrink-0 w-20">{moduleT('contextMenu.icon')}</span>
              <span className="text-[0.79rem] text-[var(--text-muted)] break-all font-mono">
                {entry.icon_path}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function ContextMenuModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const {
    moduleState,
    expandedModule,
    setExpandedModule,
    updateModuleState,
    oneClickScanTrigger,
  } = useModuleDashboard('contextMenu');
  const lastScanTriggerRef = useRef(0);

  // ── 本地状态 ──────────────────────────────────────────────────────────────
  const [scanResult, setScanResult] = useState<ContextMenuScanResult | null>(null);
  // 接入 AI 助手（只读）：只给摘要，不提供操作动作。
  useAiModuleBridge('context-menu', {
    // 只读读取：让助手能"往下看"到底有哪些条目（一次一页，由模型决定要不要继续）。
    readItems: (_targetId, offset, limit) => {
      const list = scanResult?.entries ?? [];
      if (list.length === 0) return null;
      return {
        total: list.length,
        lines: list.slice(offset, offset + limit).map(
          (item) => `${item.display_name}  ${item.reg_root}\\${item.reg_subpath}  （键名 ${item.key_name}）`,
        ),
      };
    },
    // 只读：单条详情。itemId 用 read_items 行首那个显示名 —— 该模块每行开头就是它，
    // 模型照着抄回来的自然也是它。显示名会重复（同一软件在"文件夹"和"任意文件"各有一条），
    // 所以先按 id / 注册表路径精确匹配，再退回显示名、键名。
    readItemDetail: (itemId) => {
      const wanted = itemId.trim();
      if (!wanted) return null;
      const list = scanResult?.entries ?? [];
      const item =
        list.find((entry) => entry.id === wanted) ??
        list.find((entry) => entry.registry_path === wanted) ??
        list.find((entry) => entry.display_name.trim() === wanted) ??
        list.find((entry) => entry.key_name.trim() === wanted);
      if (!item) return null;
      // 只给事实："能不能删"由模块自己的判定（系统保护 / 目标程序是否存在）说话，
      // 不让模型凭菜单名字猜。
      const target = item.exe_path
        ? `${item.exe_path}（${
            item.exe_status === 'missing'
              ? '**文件已不存在** —— 这个入口很可能已经失效'
              : '文件存在'
          }）`
        : '（命令里没有绝对路径，无法判断）';
      return [
        `名称：${item.display_name}`,
        `注册表位置：${item.registry_path}`,
        // scope 现在是英文 id，给模型看的是翻译后的中文标签
        `作用范围：${item.scope ? getScopeStyle(item.scope, moduleT).label : '未标注'}`,
        `命令：${item.command || '（未读取到）'}`,
        `目标程序：${target}`,
        `图标来源：${item.icon_path || '（未设置）'}`,
        item.is_system_protected
          ? '结论：这是**系统保护项**，界面上不允许选中删除。'
          : `结论：可以清理${item.needs_admin ? '，但需要管理员权限' : ''}（删除前程序会自动备份注册表）。`,
      ].join('\n');
    },
    summary: () => {
      if (!scanResult) return null;
      return `扫描到 ${scanResult.entries.length} 项右键菜单入口，其中 ${scanResult.invalid_count} 项指向已失效的程序。`;
    },
  });

  /** 用 id 作为 key 维护选中集合 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  /** 按 scope 分组折叠状态 */
  const [collapsedScopes, setCollapsedScopes] = useState<Set<string>>(new Set());
  /** 筛选：仅显示无效条目（默认关闭 —— 后端刻意返回全部条目，用户也可能想关掉某条不用的菜单） */
  const [showInvalidOnly, setShowInvalidOnly] = useState(false);

  // ── 派生数据 ──────────────────────────────────────────────────────────────

  /** 当前筛选后显示的条目 */
  const filteredEntries = useMemo(() => {
    if (!scanResult) return [];
    if (showInvalidOnly) {
      return scanResult.entries.filter(isInvalidContextMenuEntry);
    }
    return scanResult.entries;
  }, [scanResult, showInvalidOnly]);

  /** 按 scope 分组 */
  const groupedEntries = useMemo(() => {
    const groups = new Map<string, ContextMenuEntry[]>();
    for (const entry of filteredEntries) {
      if (!groups.has(entry.scope)) groups.set(entry.scope, []);
      groups.get(entry.scope)!.push(entry);
    }
    return groups;
  }, [filteredEntries]);

  /** 当前选中的数量 */
  const selectedCount = selectedIds.size;

  /**
   * 是否以管理员身份运行。
   *
   * HKLM 下的条目要写注册表，非管理员下 `KEY_WRITE` 直接拒绝访问 —— 实测一台普通
   * 机器上 34 条里 30 条在 HKLM，不提权等于整个模块删不动。所以这里提前把话说清楚，
   * 而不是等用户点完删除看一屏"拒绝访问"。
   */
  const isAdmin = useAdminPrivilege();

  /** 选中项里有多少条在 HKLM（非管理员下会全部失败） */
  const selectedAdminCount = useMemo(() => {
    if (!scanResult || isAdmin !== false) return 0;
    return scanResult.entries.filter(
      (entry) => selectedIds.has(entry.id) && entry.needs_admin,
    ).length;
  }, [scanResult, selectedIds, isAdmin]);

  // ── 事件处理 ─────────────────────────────────────────────────────────────

  /** 开始扫描 */
  const handleScan = useCallback(async () => {
    updateModuleState('contextMenu', { status: 'scanning', error: null });
    setScanResult(null);
    setSelectedIds(new Set());
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);

    try {
      const result = await scanContextMenu();
      setScanResult(result);

      // 默认只勾选"确实失效"的条目（排除系统保护项）。
      // 三态判定之后这里不用再判 exe_path：能进 missing 的一定提得出路径。
      const defaultSelected = new Set(
        result.entries
          .filter((e) => isInvalidContextMenuEntry(e) && !e.is_system_protected)
          .map((e) => e.id)
      );
      setSelectedIds(defaultSelected);

      updateModuleState('contextMenu', {
        status: 'done',
        fileCount: result.invalid_count,
        totalSize: 0, // 注册表项没有文件大小概念
      });

      setExpandedModule('contextMenu');
    } catch (err) {
      console.error('右键菜单扫描失败:', err);
      updateModuleState('contextMenu', { status: 'error', error: String(err) });
    }
  }, [updateModuleState, setExpandedModule]);

  /** 监听一键扫描触发器 */
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  /** 切换单个条目选中状态 */
  const toggleSelect = useCallback((entry: ContextMenuEntry) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entry.id)) {
        next.delete(entry.id);
      } else {
        next.add(entry.id);
      }
      return next;
    });
  }, []);

  /** 全选/取消全选（仅操作当前过滤后且非系统保护的条目） */
  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    // 排除系统保护条目的可选中 ID
    const selectableIds = filteredEntries
      .filter((e) => !e.is_system_protected)
      .map((e) => e.id);
    const allSelected =
      selectableIds.length > 0 &&
      selectableIds.every((id) => selectedIds.has(id));

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        selectableIds.forEach((id) => next.delete(id));
      } else {
        selectableIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [scanResult, filteredEntries, selectedIds]);

  /** 切换 scope 分组折叠状态 */
  const toggleScope = useCallback((scope: string) => {
    setCollapsedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  }, []);

  /** 打开注册表备份目录（误删后手动双击 .reg 恢复） */
  const handleOpenBackupDir = useCallback(async () => {
    try {
      await openContextMenuBackupDir();
    } catch (error) {
      console.error('打开备份目录失败:', error);
    }
  }, []);

  /** 执行删除 */
  const handleDelete = useCallback(async () => {
    if (selectedIds.size === 0 || !scanResult) return;

    setIsDeleting(true);
    setDeleteError(null);
    setDeleteErrors([]);
    setShowErrorDetails(false);

    try {
      // 构建删除请求列表
      const requests: ContextMenuDeleteRequest[] = scanResult.entries
        .filter((e) => selectedIds.has(e.id))
        .map((e) => ({
          id: e.id,
          reg_root: e.reg_root,
          reg_subpath: e.reg_subpath,
        }));

      const result = await deleteContextMenuEntries(requests);

      // 记录清理日志
      const failedIds = new Set(
        result.details.filter((d) => !d.success).map((d) => d.id)
      );
      const logEntries: CleanupLogEntryInput[] = requests.map((req) => {
        const detail = result.details.find((d) => d.id === req.id);
        return {
          category: '右键菜单清理',
          path: `${req.reg_root}\\${req.reg_subpath}`,
          size: 0,
          success: !failedIds.has(req.id),
          error_message: detail?.error ?? undefined,
        };
      });
      recordCleanupAction(logEntries).catch((err) =>
        console.warn('记录清理日志失败:', err)
      );

      // 收集失败信息
      const errorMessages = result.details
        .filter((d) => !d.success && d.error)
        .map((d) => d.error as string);

      if (errorMessages.length > 0) {
        setDeleteError(t('failedCount', { count: errorMessages.length }));
        setDeleteErrors(errorMessages);
      }

      // 从结果中移除已成功删除的条目
      const successIds = new Set(
        result.details.filter((d) => d.success).map((d) => d.id)
      );
      const remainingEntries = scanResult.entries.filter((e) => !successIds.has(e.id));
      const newInvalidCount = remainingEntries.filter(
        isInvalidContextMenuEntry
      ).length;

      setScanResult({
        ...scanResult,
        entries: remainingEntries,
        invalid_count: newInvalidCount,
      });

      // 更新选中状态（仅保留失败的）
      setSelectedIds((prev) => {
        const next = new Set(prev);
        successIds.forEach((id) => next.delete(id));
        return next;
      });

      updateModuleState('contextMenu', {
        fileCount: newInvalidCount,
      });
    } catch (err) {
      console.error('删除右键菜单条目失败:', err);
      setDeleteError(String(err));
      setDeleteErrors([String(err)]);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [selectedIds, scanResult, updateModuleState]);

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  const isExpanded = expandedModule === 'contextMenu';
  /** 可选中条目（排除系统保护） */
  const selectableEntries = useMemo(
    () => filteredEntries.filter((e) => !e.is_system_protected),
    [filteredEntries]
  );
  const allFilteredSelected =
    selectableEntries.length > 0 &&
    selectableEntries.every((e) => selectedIds.has(e.id));

  if (shouldSkipInactivePageRender(layoutMode, isPageActive) && !isDeleting && !showDeleteConfirm) {
    return null;
  }

  return (
    <>
      <ModuleCard
        variant={layoutMode === 'pages' ? 'page' : 'card'}
        forceExpanded={layoutMode === 'pages'}
        id="contextMenu"
        title={navT('contextMenu')}
        description={navT('contextMenuDesc')}
        icon={<MousePointerClick className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={0}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'contextMenu')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <span className="px-2 py-0.5 rounded text-[0.71rem] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] border border-[var(--color-warning)]/20">
            {moduleT('contextMenu.highRisk')}
          </span>
        }
      >
        {/* 删除进度改挂在悬浮操作区上（见上面 busyContent）：
            那是 position: fixed 的层，不占文档流，所以结果区既不被撑开也没有位移 ——
            右键菜单需要保留"我在删哪几条"的参照。 */}
        {moduleState.status === 'idle' && !scanResult && (
          <div className="p-5">
            <EmptyState
              icon={MousePointerClick}
              title={t('notScannedContextMenu')}
              description={moduleT('contextMenu.idleDesc')}
            />
          </div>
        )}

        {moduleState.status === 'scanning' && !scanResult && (
          <div className="p-5">
            <ModuleScanProgress
              title={t('scanningShort')}
              description={moduleT('contextMenu.idleDesc')}
              icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
            />
          </div>
        )}

        {/* ── 扫描结果内容 ── */}
        {scanResult && (
          // pb-20：底部操作条是 fixed 悬浮层，末端留白免得最后一行被它压住
          <div className="p-5 space-y-4 pb-20">

            {/* 未提权时先说清楚：HKLM 条目删不动，别等点完删除再看一屏拒绝访问 */}
            <AdminRequiredHint description={moduleT('contextMenu.adminHint')} />

            {/* 安全提示横幅 */}
            <div className="flex items-start gap-3 p-4 bg-[var(--brand-green-10)] rounded-xl border border-[var(--brand-green-20)]">
              <Shield className="w-5 h-5 text-[var(--brand-green)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{moduleT('contextMenu.safetyTitle')}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {moduleT('contextMenu.safetyDesc')}
                </p>
              </div>
            </div>

            {/* 扫描统计 */}
            <div className="grid grid-cols-3 gap-3">
              <div className="glass-block p-3 bg-[var(--bg-main)] rounded-xl text-center">
                <p className="text-xl font-bold text-[var(--text-primary)] tabular-nums">
                  {scanResult.entries.length}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{moduleT('contextMenu.scanned')}</p>
              </div>
              <div className="p-3 bg-[var(--color-danger)]/5 rounded-xl text-center">
                <p className="text-xl font-bold text-[var(--color-danger)] tabular-nums">
                  {scanResult.invalid_count}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{moduleT('contextMenu.invalid')}</p>
              </div>
              <div className="p-3 bg-[var(--brand-green-10)] rounded-xl text-center">
                <p className="text-xl font-bold text-[var(--brand-green)] tabular-nums">
                  {scanResult.scan_duration_ms}ms
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">{moduleT('contextMenu.duration')}</p>
              </div>
            </div>

            {/* 操作栏：筛选与计数留在这里；全选与删除按钮移到悬浮操作区，
                与垃圾清理等模块共用同一套组件 —— 列表往下滚动时按钮始终可见 */}
            <div className="flex items-center gap-3">
              {/* 仅显示无效条目开关 */}
              <button
                onClick={() => setShowInvalidOnly((v) => !v)}
                className={`
                  text-xs px-2.5 py-1 rounded-lg border transition-colors
                  ${showInvalidOnly
                    ? 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/20'
                    : 'bg-[var(--bg-hover)] text-[var(--text-muted)] border-transparent'
                  }
                `}
              >
                {moduleT('contextMenu.invalidOnly')}
              </button>

              <span className="text-sm text-[var(--text-muted)]">
                {moduleT('contextMenu.selected', { count: selectedCount })}
              </span>

              {/* 误删后唯一的恢复手段是备份目录里的 .reg，入口放在这里而不是藏进设置页 */}
              <button
                type="button"
                onClick={handleOpenBackupDir}
                className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {moduleT('contextMenu.openBackupDir')}
              </button>
            </div>

            {/* 操作按钮区：固定在视口底部，下拉列表再长也不用滚回去找删除按钮 */}
            <ModuleOperationToolbar
              moduleId="context"
              busy={isDeleting}
              busyContent={
                <ModuleDeleteProgress
                  variant="floating"
                  phaseLabel={moduleT('contextMenu.cleaning')}
                  progressLabel={moduleT('contextMenu.cleaningDesc', { count: selectedCount })}
                  hint={t('doNotCloseWindow')}
                />
              }
            >
              <button
                onClick={toggleSelectAll}
                className="module-operation-toolbar__button module-operation-toolbar__button--muted"
              >
                {allFilteredSelected ? t('deselectAll') : t('selectAll')}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedCount === 0 || isDeleting}
                className="module-operation-toolbar__button module-operation-toolbar__button--danger"
              >
                {isDeleting
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Trash2 className="w-4 h-4" />
                }
                {moduleT('contextMenu.deleteSelected')}
              </button>
            </ModuleOperationToolbar>

            {/* 错误提示 */}
            {deleteError && (
              <div className="p-3 bg-[var(--color-danger)]/10 rounded-xl border border-[var(--color-danger)]/20">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-[var(--color-danger)]">{deleteError}</span>
                  {deleteErrors.length > 0 && (
                    <button
                      onClick={() => setShowErrorDetails(!showErrorDetails)}
                      className="text-xs text-[var(--color-danger)] hover:underline"
                    >
                      {showErrorDetails ? t('close') : t('viewDetails')}
                    </button>
                  )}
                </div>
                {showErrorDetails && (
                  <div className="mt-2 pt-2 border-t border-[var(--color-danger)]/20 space-y-1 max-h-32 overflow-auto">
                    {deleteErrors.map((err, idx) => (
                      <p key={idx} className="text-xs text-[var(--color-danger)]/80 break-all">
                        • {err}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 条目列表（按 scope 分组） */}
            {filteredEntries.length > 0 ? (
              <div className="space-y-3">
                {Array.from(groupedEntries.entries()).map(([scope, entries]) => {
                  const isCollapsed = collapsedScopes.has(scope);
                  const scopeStyle = getScopeStyle(scope, moduleT);

                  return (
                    <div key={scope} className="space-y-1.5">
                      {/* 分组标题 */}
                      <button
                        onClick={() => toggleScope(scope)}
                        className="flex items-center gap-2 w-full text-left px-1 py-0.5 hover:opacity-80 transition-opacity"
                      >
                        {isCollapsed
                          ? <ChevronRight className="w-3.5 h-3.5 text-[var(--text-faint)]" />
                          : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-faint)]" />
                        }
                        <span className={`px-2 py-0.5 rounded text-[0.79rem] font-semibold ${scopeStyle.className}`}>
                          {scopeStyle.label}
                        </span>
                        <span className="text-xs text-[var(--text-faint)]">
                          {t('fileCount', { count: entries.length })}
                        </span>
                      </button>

                      {/* 条目列表 */}
                      {!isCollapsed && (
                        <div className="space-y-1.5 pl-4">
                          {entries.map((entry) => (
                            <EntryRow
                              key={entry.id}
                              entry={entry}
                              isSelected={selectedIds.has(entry.id)}
                              onToggle={toggleSelect}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* 过滤后无条目 */
              <EmptyState
                icon={MousePointerClick}
                title={showInvalidOnly ? moduleT('contextMenu.noInvalid') : moduleT('contextMenu.noEntries')}
                description={showInvalidOnly ? moduleT('contextMenu.validOnly') : moduleT('contextMenu.empty')}
                tone={showInvalidOnly ? 'success' : 'neutral'}
                compact
              />
            )}
          </div>
        )}

        {/* 空状态：扫描完成但无任何条目 */}
        {scanResult && scanResult.entries.length === 0 && (
          <div className="p-5">
            <EmptyState
              icon={MousePointerClick}
                title={t('noContextMenuIssues')}
              description={moduleT('contextMenu.allValid')}
              tone="success"
            />
          </div>
        )}
      </ModuleCard>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title={t('confirmDeleteContextMenu')}
        description={moduleT('contextMenu.confirmDesc', { count: selectedCount })}
        // 选中有 HKLM 条目又没提权时，把"会失败"提前写进警告；这比删完再报错有用
        warning={
          selectedAdminCount > 0
            ? moduleT('contextMenu.adminBlockedWarning', { count: selectedAdminCount })
            : t('contextMenuDeleteWarning')
        }
        confirmText={t('delete')}
        cancelText={t('cancel')}
        isDanger={true}
      />
    </>
  );
}

export default ContextMenuModule;
