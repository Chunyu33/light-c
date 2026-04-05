// ============================================================================
// 右键菜单清理模块
// 扫描 Windows 注册表中注册的右键菜单项，
// 识别指向不存在可执行文件的无效条目并提供一键清理
// ============================================================================

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  MousePointerClick,
  Loader2,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Shield,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Terminal,
} from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useDashboard } from '../../contexts/DashboardContext';
import {
  scanContextMenu,
  deleteContextMenuEntries,
  recordCleanupAction,
  type ContextMenuScanResult,
  type ContextMenuEntry,
  type ContextMenuDeleteRequest,
  type CleanupLogEntryInput,
} from '../../api/commands';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 根据 scope 字段返回对应的中文描述和颜色样式
 */
function getScopeStyle(scope: string): { label: string; className: string } {
  switch (scope) {
    case '任意文件':
      return { label: '任意文件', className: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400' };
    case '文件夹':
      return { label: '文件夹', className: 'bg-yellow-50 text-yellow-600 dark:bg-yellow-900/20 dark:text-yellow-500' };
    case '桌面背景':
      return { label: '桌面背景', className: 'bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400' };
    case '磁盘驱动器':
      return { label: '磁盘', className: 'bg-orange-50 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400' };
    case '库文件夹':
      return { label: '库文件夹', className: 'bg-teal-50 text-teal-600 dark:bg-teal-900/20 dark:text-teal-400' };
    default:
      return { label: scope, className: 'bg-[var(--bg-hover)] text-[var(--text-muted)]' };
  }
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
  const [expanded, setExpanded] = useState(false);
  const scope = getScopeStyle(entry.scope);
  const isInvalid = !entry.exe_exists && entry.exe_path !== null;

  return (
    <div
      className={`
        rounded-xl border transition-colors cursor-pointer
        ${isSelected
          ? 'bg-[var(--brand-green-10)] border-[var(--brand-green-20)]'
          : 'bg-[var(--bg-main)] border-transparent hover:bg-[var(--bg-hover)]'
        }
      `}
      onClick={() => onToggle(entry)}
    >
      {/* 主行 */}
      <div className="flex items-center gap-3 p-3">
        {/* 复选框 */}
        <div
          className={`
            w-5 h-5 rounded border-2 flex items-center justify-center shrink-0
            ${isSelected
              ? 'bg-[var(--brand-green)] border-[var(--brand-green)]'
              : 'border-[var(--text-faint)]'
            }
          `}
        >
          {isSelected && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>

        {/* 图标区 */}
        <div
          className={`
            w-9 h-9 rounded-lg flex items-center justify-center shrink-0
            ${isInvalid
              ? 'bg-[var(--color-danger)]/10'
              : 'bg-[var(--brand-green-10)]'
            }
          `}
        >
          {isInvalid
            ? <AlertTriangle className="w-4 h-4 text-[var(--color-danger)]" />
            : <MousePointerClick className="w-4 h-4 text-[var(--brand-green)]" />
          }
        </div>

        {/* 文字信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-[var(--text-primary)] truncate max-w-[240px]">
              {entry.display_name || entry.key_name}
            </p>

            {/* 作用范围标签 */}
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${scope.className}`}>
              {scope.label}
            </span>

            {/* 注册表根 */}
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">
              {entry.reg_root}
            </span>

            {/* 无效标记 */}
            {isInvalid && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-danger)]/10 text-[var(--color-danger)] shrink-0">
                文件不存在
              </span>
            )}

            {/* 需要管理员 */}
            {entry.needs_admin && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] shrink-0">
                需管理员
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
        </div>

        {/* 展开/折叠按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="shrink-0 p-1 rounded text-[var(--text-faint)] hover:text-[var(--text-muted)]"
          title="查看详情"
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
            <span className="text-[11px] text-[var(--text-faint)] shrink-0 w-20">注册表路径</span>
            <span className="text-[11px] text-[var(--text-muted)] break-all font-mono">
              {entry.registry_path}
            </span>
          </div>

          {/* 原始命令 */}
          {entry.command && (
            <div className="flex items-start gap-2">
              <span className="text-[11px] text-[var(--text-faint)] shrink-0 w-20">命令</span>
              <span
                className="text-[11px] text-[var(--text-muted)] break-all font-mono"
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
              <span className="text-[11px] text-[var(--text-faint)] shrink-0 w-20">图标</span>
              <span className="text-[11px] text-[var(--text-muted)] break-all font-mono">
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

export function ContextMenuModule() {
  const {
    modules,
    expandedModule,
    setExpandedModule,
    updateModuleState,
    oneClickScanTrigger,
  } = useDashboard();

  const moduleState = modules.contextMenu;
  const lastScanTriggerRef = useRef(0);

  // ── 本地状态 ──────────────────────────────────────────────────────────────
  const [scanResult, setScanResult] = useState<ContextMenuScanResult | null>(null);
  /** 用 id 作为 key 维护选中集合 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteErrors, setDeleteErrors] = useState<string[]>([]);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  /** 按 scope 分组折叠状态 */
  const [collapsedScopes, setCollapsedScopes] = useState<Set<string>>(new Set());
  /** 筛选：仅显示无效条目 */
  const [showInvalidOnly, setShowInvalidOnly] = useState(false);

  // ── 派生数据 ──────────────────────────────────────────────────────────────

  /** 当前筛选后显示的条目 */
  const filteredEntries = useMemo(() => {
    if (!scanResult) return [];
    if (showInvalidOnly) {
      return scanResult.entries.filter((e) => !e.exe_exists && e.exe_path !== null);
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

      // 默认仅自动勾选 exe 不存在的无效条目
      const defaultSelected = new Set(
        result.entries
          .filter((e) => !e.exe_exists && e.exe_path !== null)
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

  /** 全选/取消全选（仅操作当前过滤后的条目） */
  const toggleSelectAll = useCallback(() => {
    if (!scanResult) return;
    const currentIds = filteredEntries.map((e) => e.id);
    const allSelected = currentIds.every((id) => selectedIds.has(id));

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        currentIds.forEach((id) => next.delete(id));
      } else {
        currentIds.forEach((id) => next.add(id));
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
        setDeleteError(`${errorMessages.length} 个条目删除失败`);
        setDeleteErrors(errorMessages);
      }

      // 从结果中移除已成功删除的条目
      const successIds = new Set(
        result.details.filter((d) => d.success).map((d) => d.id)
      );
      const remainingEntries = scanResult.entries.filter((e) => !successIds.has(e.id));
      const newInvalidCount = remainingEntries.filter(
        (e) => !e.exe_exists && e.exe_path !== null
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
  const allFilteredSelected =
    filteredEntries.length > 0 &&
    filteredEntries.every((e) => selectedIds.has(e.id));

  return (
    <>
      {/* 删除进度遮罩 - Portal 渲染到 body 确保覆盖全屏 */}
      {isDeleting && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[var(--bg-card)] rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4">
            <div className="w-16 h-16 rounded-full bg-[var(--color-danger)]/10 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-[var(--color-danger)] animate-spin" />
            </div>
            <div className="text-center">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">正在清理右键菜单</h3>
              <p className="text-sm text-[var(--text-muted)] mt-1">
                正在删除 {selectedCount} 个注册表条目，请稍候...
              </p>
            </div>
            <div className="w-full h-2 bg-[var(--bg-hover)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--color-danger)] rounded-full animate-pulse"
                style={{ width: '100%' }}
              />
            </div>
            <p className="text-xs text-[var(--text-faint)]">请勿关闭窗口</p>
          </div>
        </div>,
        document.body
      )}

      <ModuleCard
        id="contextMenu"
        title="右键菜单清理"
        description="扫描并清理注册表中失效的右键菜单项"
        icon={<MousePointerClick className="w-6 h-6 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={0}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'contextMenu')}
        onScan={handleScan}
        error={moduleState.error}
        headerExtra={
          <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--color-warning)]/10 text-[var(--color-warning)] border border-[var(--color-warning)]/20">
            中风险
          </span>
        }
      >
        {/* ── 扫描结果内容 ── */}
        {scanResult && (
          <div className="p-5 space-y-4">

            {/* 安全提示横幅 */}
            <div className="flex items-start gap-3 p-4 bg-[var(--brand-green-10)] rounded-xl border border-[var(--brand-green-20)]">
              <Shield className="w-5 h-5 text-[var(--brand-green)] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">操作安全提示</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  默认仅勾选"文件不存在"的无效菜单项。HKLM 条目删除需要管理员权限，
                  删除后右键菜单中对应项目将不再出现。
                </p>
              </div>
            </div>

            {/* 扫描统计 */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-[var(--bg-main)] rounded-xl text-center">
                <p className="text-xl font-bold text-[var(--text-primary)] tabular-nums">
                  {scanResult.entries.length}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">扫描到的条目</p>
              </div>
              <div className="p-3 bg-[var(--color-danger)]/5 rounded-xl text-center">
                <p className="text-xl font-bold text-[var(--color-danger)] tabular-nums">
                  {scanResult.invalid_count}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">无效条目</p>
              </div>
              <div className="p-3 bg-[var(--brand-green-10)] rounded-xl text-center">
                <p className="text-xl font-bold text-[var(--brand-green)] tabular-nums">
                  {scanResult.scan_duration_ms}ms
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">扫描耗时</p>
              </div>
            </div>

            {/* 操作栏 */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                {/* 全选/取消全选 */}
                <button
                  onClick={toggleSelectAll}
                  className="text-sm text-[var(--brand-green)] hover:underline"
                >
                  {allFilteredSelected ? '取消全选' : '全选'}
                </button>

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
                  仅显示无效
                </button>

                <span className="text-sm text-[var(--text-muted)]">
                  已选 {selectedCount} 项
                </span>
              </div>

              {/* 删除按钮 */}
              <button
                onClick={() => setShowDeleteConfirm(true)}
                disabled={selectedCount === 0 || isDeleting}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors
                  ${selectedCount === 0 || isDeleting
                    ? 'bg-[var(--bg-hover)] text-[var(--text-faint)] cursor-not-allowed'
                    : 'bg-[var(--color-danger)] text-white hover:opacity-90'
                  }
                `}
              >
                {isDeleting
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Trash2 className="w-4 h-4" />
                }
                删除选中
              </button>
            </div>

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
                      {showErrorDetails ? '收起详情' : '查看详情'}
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
              <div className="space-y-3 max-h-[520px] overflow-auto">
                {Array.from(groupedEntries.entries()).map(([scope, entries]) => {
                  const isCollapsed = collapsedScopes.has(scope);
                  const scopeStyle = getScopeStyle(scope);

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
                        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${scopeStyle.className}`}>
                          {scope}
                        </span>
                        <span className="text-xs text-[var(--text-faint)]">
                          {entries.length} 项
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
              <div className="py-6 text-center">
                <p className="text-sm text-[var(--text-muted)]">
                  {showInvalidOnly
                    ? '当前没有无效的右键菜单项'
                    : '没有扫描到右键菜单条目'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* 空状态：扫描完成但无任何条目 */}
        {scanResult && scanResult.entries.length === 0 && (
          <div className="p-8 text-center">
            <CheckCircle2 className="w-12 h-12 text-[var(--brand-green)] mx-auto mb-3" />
            <p className="text-sm font-medium text-[var(--text-primary)]">
              未发现右键菜单问题
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              所有右键菜单项均指向有效的可执行文件
            </p>
          </div>
        )}
      </ModuleCard>

      {/* 删除确认对话框 */}
      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="确认删除右键菜单条目"
        description={`确定要从注册表中删除选中的 ${selectedCount} 个右键菜单条目吗？`}
        warning="此操作将从注册表中永久移除对应键值，已删除的菜单项不会再出现在右键菜单中。如有 HKLM 条目，请确保以管理员身份运行。"
        confirmText="删除"
        cancelText="取消"
        isDanger={true}
      />
    </>
  );
}

export default ContextMenuModule;
