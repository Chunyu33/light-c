/**
 * AI 工具清理模块。
 *
 * 交互和社交专清一致：按工具折叠（手风琴），展开后是缓存目录列表，
 * 勾选后走二次确认再删。
 *
 * 为什么不做"一键全清"：这些缓存目录旁边就是登录凭据、会话历史和运行时，
 * 用户必须看到"删的是哪个工具的哪个目录"再确认。后端还会再校验一次路径归属。
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { ConfirmDialog } from '../ConfirmDialog';
import { deleteAiToolCaches, scanAiToolCaches } from '../../api/aiToolCleanup';
import type { AiToolScanResult } from '../../types/aiToolCleanup';
import { formatSize } from '../../utils/format';
import { useToast } from '../Toast';
import type { ModuleRenderProps } from './moduleProps';

export function AiToolCleanupModule({ layoutMode = 'cards' }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t: moduleT } = useTranslation('modules');
  const { showToast } = useToast();

  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<AiToolScanResult | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  /** 当前展开的工具（手风琴：同时只展开一个） */
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  /** 已勾选的缓存目录路径 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const allPaths = useMemo(
    () => (result ? result.groups.flatMap((group) => group.entries.map((entry) => entry.path)) : []),
    [result],
  );
  const selectedSize = useMemo(() => {
    if (!result) return 0;
    return result.groups
      .flatMap((group) => group.entries)
      .filter((entry) => selected.has(entry.path))
      .reduce((total, entry) => total + entry.size, 0);
  }, [result, selected]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setError('');
    try {
      const next = await scanAiToolCaches();
      setResult(next);
      // 重新扫描后旧的勾选可能指向已不存在的目录，全部清掉最安全
      setSelected(new Set());
      setExpandedTool(null);
    } catch (scanError) {
      console.error('扫描 AI 工具缓存失败:', scanError);
      setError(String(scanError));
    } finally {
      setScanning(false);
    }
  }, []);

  const toggleEntry = useCallback((path: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const toggleGroup = useCallback((paths: string[]) => {
    setSelected((previous) => {
      const next = new Set(previous);
      const allSelected = paths.every((path) => next.has(path));
      paths.forEach((path) => (allSelected ? next.delete(path) : next.add(path)));
      return next;
    });
  }, []);

  const handleDelete = useCallback(async () => {
    setConfirmOpen(false);
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      const count = await deleteAiToolCaches([...selected]);
      showToast({
        type: 'success',
        title: moduleT('aiTools.deletedTitle', { count }),
        description: moduleT('aiTools.deletedDesc'),
      });
      await handleScan();
    } catch (deleteError) {
      console.error('删除 AI 工具缓存失败:', deleteError);
      showToast({
        type: 'error',
        title: moduleT('aiTools.deleteFailed'),
        description: String(deleteError),
      });
    } finally {
      setDeleting(false);
    }
  }, [handleScan, moduleT, selected, showToast]);

  const busy = scanning || deleting;

  return (
    <ModuleCard
      variant={layoutMode === 'pages' ? 'page' : 'card'}
      forceExpanded={layoutMode === 'pages'}
      id="ai-tools"
      title={navT('aiToolCleanup')}
      description={navT('aiToolCleanupDesc')}
      icon={<Bot className="w-6 h-6 text-[var(--brand-green)]" />}
      status={busy ? 'scanning' : result ? 'done' : 'idle'}
      fileCount={result?.totalFiles ?? 0}
      totalSize={result?.totalSize ?? 0}
      onScan={handleScan}
      error={error}
      expanded={expanded}
      onToggleExpand={() => setExpanded((value) => !value)}
    >
      <div className="p-4">
        {!result ? (
          <EmptyState
            icon={Bot}
            title={moduleT('aiTools.idleTitle')}
            description={moduleT('aiTools.idleDesc')}
            action={
              <button
                type="button"
                onClick={handleScan}
                disabled={scanning}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-green)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
                {moduleT('aiTools.scan')}
              </button>
            }
          />
        ) : result.groups.length === 0 ? (
          <EmptyState
            icon={Bot}
            title={moduleT('aiTools.emptyTitle')}
            description={moduleT('aiTools.emptyDesc')}
            action={
              <button
                type="button"
                onClick={handleScan}
                className="text-sm text-[var(--brand-green)] hover:underline"
              >
                {moduleT('aiTools.rescan')}
              </button>
            }
          />
        ) : (
          <div className="space-y-2">
            {result.groups.map((group) => {
              const paths = group.entries.map((entry) => entry.path);
              const selectedInGroup = paths.filter((path) => selected.has(path)).length;
              const allSelected = paths.length > 0 && selectedInGroup === paths.length;
              const partiallySelected = selectedInGroup > 0 && !allSelected;
              const isOpen = expandedTool === group.toolId;

              return (
                <div
                  key={group.toolId}
                  className="overflow-hidden rounded-2xl bg-[var(--bg-card)] shadow-sm"
                >
                  <div
                    className="flex cursor-pointer items-center gap-4 px-5 py-4 transition-colors hover:bg-[var(--bg-hover)]"
                    onClick={() => setExpandedTool(isOpen ? null : group.toolId)}
                  >
                    <ChevronRight
                      className={`h-5 w-5 shrink-0 text-[var(--text-faint)] transition-transform ${isOpen ? 'rotate-90' : ''}`}
                    />
                    {/* 工具级勾选：一键全选当前工具下的缓存目录 */}
                    <div
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleGroup(paths);
                      }}
                      className={`flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-2 transition-colors ${
                        allSelected
                          ? 'border-[var(--brand-green)] bg-[var(--brand-green)]'
                          : partiallySelected
                            ? 'border-[var(--brand-green)] bg-[var(--brand-green)]/50'
                            : 'border-[var(--text-faint)] hover:border-[var(--text-muted)]'
                      }`}
                    >
                      {(allSelected || partiallySelected) && (
                        <svg
                          className="h-3 w-3 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={3}
                        >
                          {allSelected ? (
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          ) : (
                            <path strokeLinecap="round" d="M5 12h14" />
                          )}
                        </svg>
                      )}
                    </div>
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-green-10)] text-[var(--brand-green)]">
                      <HardDrive className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[1rem] font-bold text-[var(--text-primary)]">
                        {group.toolName}
                      </p>
                      <p className="mt-1 truncate text-[0.93rem] text-[var(--text-muted)]">
                        {moduleT('aiTools.summary', {
                          dirs: group.entries.length,
                          files: group.fileCount.toLocaleString(),
                        })}
                      </p>
                    </div>
                    <p className="shrink-0 text-[1.07rem] font-bold tabular-nums text-[var(--text-primary)]">
                      {formatSize(group.totalSize)}
                    </p>
                  </div>

                  {isOpen && (
                    <div className="border-t border-[var(--border-color)] bg-[var(--bg-main)] px-5 py-2">
                      {group.entries.map((entry) => (
                        <div
                          key={entry.path}
                          className="flex cursor-pointer items-center gap-3 py-2 text-[0.86rem]"
                          onClick={() => toggleEntry(entry.path)}
                        >
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                              selected.has(entry.path)
                                ? 'border-[var(--brand-green)] bg-[var(--brand-green)]'
                                : 'border-[var(--text-faint)]'
                            }`}
                          >
                            {selected.has(entry.path) && (
                              <svg
                                className="h-2.5 w-2.5 text-white"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            )}
                          </div>
                          <span className="w-40 shrink-0 truncate font-medium text-[var(--text-secondary)]">
                            {entry.name}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate text-[var(--text-muted)]"
                            title={entry.path}
                          >
                            {entry.path}
                          </span>
                          <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                            {formatSize(entry.size)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* 操作条：选中项统一在底部确认，位置和社交专清一致 */}
            <div className="flex items-center justify-between rounded-2xl bg-[var(--bg-card)] px-5 py-3 shadow-sm">
              <button
                type="button"
                onClick={() =>
                  setSelected(selected.size === allPaths.length ? new Set() : new Set(allPaths))
                }
                disabled={allPaths.length === 0}
                className="text-[0.93rem] text-[var(--brand-green)] hover:underline disabled:opacity-40 disabled:no-underline"
              >
                {selected.size === allPaths.length && allPaths.length > 0
                  ? moduleT('aiTools.deselectAll')
                  : moduleT('aiTools.selectAll')}
              </button>
              <div className="flex items-center gap-3">
                <span className="text-[0.93rem] tabular-nums text-[var(--text-muted)]">
                  {moduleT('aiTools.selected', {
                    count: selected.size,
                    size: formatSize(selectedSize),
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmOpen(true)}
                  disabled={selected.size === 0 || deleting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-green)] px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                  {moduleT('aiTools.delete')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        title={moduleT('aiTools.confirmTitle', { count: selected.size })}
        description={moduleT('aiTools.confirmDesc', { size: formatSize(selectedSize) })}
        warning={moduleT('aiTools.confirmWarning')}
        confirmText={moduleT('aiTools.delete')}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </ModuleCard>
  );
}
