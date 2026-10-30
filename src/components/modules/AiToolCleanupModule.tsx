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
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, FolderOpen, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { ConfirmDialog } from '../ConfirmDialog';
import { AiCacheFileModal } from './AiCacheFileModal';
import { ModuleOperationToolbar } from '../ModuleOperationToolbar';
import { ModuleDeleteProgress } from '../ModuleDeleteProgress';
import { deleteAiToolCaches, scanAiToolCaches } from '../../api/aiToolCleanup';
import { openInFolder } from '../../api/commands';
import type { AiToolScanResult } from '../../types/aiToolCleanup';
import { formatSize } from '../../utils/format';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import { useAiModuleBridge } from '../ai/useAiModuleBridge';
import type { ModuleRenderProps } from './moduleProps';

export function AiToolCleanupModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t: moduleT } = useTranslation('modules');
  const { showToast } = useToast();
  // 展开状态放在全局上下文里：和社交专清共用同一个 "当前展开的模块"，
  // 否则各自维护一份就会同时出现两条操作条。
  const { expandedModule, setExpandedModule } = useDashboard();

  const [scanning, setScanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<AiToolScanResult | null>(null);
  /**
   * 刚把可清理项删光了。
   *
   * 和"从没扫到过"是两回事：前者是完成态，后者是"可能没装 / 结构不符"，
   * 刚清完还提示"这些工具可能没装"会让人以为扫描坏了。
   */
  const [justCleared, setJustCleared] = useState(false);
  const [error, setError] = useState('');
  /** 当前展开的工具（手风琴：同时只展开一个） */
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  /** 已勾选的缓存目录路径 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 正在查看明细的缓存目录；null 表示弹窗关闭 */
  const [viewDir, setViewDir] = useState<{ path: string; name: string } | null>(null);

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

  /**
   * 把分组摊平成「缓存目录 + 所属工具」。
   *
   * 顺序沿用界面：工具按总占用倒序、组内按体积倒序 —— 助手读到的第一条就是最占空间的那块，
   * 和用户屏幕上看到的顺序一致，回答里引用起来不会对不上。
   */
  const flattenEntries = useCallback(() => {
    if (!result) return [];
    return result.groups.flatMap((group) =>
      group.entries.map((entry) => ({
        toolId: group.toolId,
        toolName: group.toolName,
        entry,
      })),
    );
  }, [result]);

  // 接入 AI 助手：**只读**。不给 select/delete —— 删缓存必须由用户看着列表逐项确认，
  // 这条路上还牵扯「工具开着会删不掉」，不适合让模型提议后一键执行。
  useAiModuleBridge('ai-tool-cleanup', {
    // 读取缓存目录列表（一页一批，由模型决定要不要继续往下看）。
    readItems: (targetId, offset, limit) => {
      const all = flattenEntries();
      const wanted = targetId.trim();
      // targetId 可能是工具名、工具 id，也可能是某个父目录路径 —— 三种都认
      const matched = wanted
        ? all.filter(
            (row) =>
              row.toolName === wanted ||
              row.toolId === wanted ||
              row.entry.path.startsWith(wanted),
          )
        : all;
      if (matched.length === 0) {
        // 不返回 null：公共层只会回一句"没有读到内容"，模型就只能猜原因，
        // 而"还没扫描"和"没匹配到"是两条完全不同的排查方向，要让它能直接说出来
        return {
          total: 0,
          lines: [
            all.length === 0
              ? '（当前还没有扫描结果 —— 请先点一次「开始扫描」，再问这个问题）'
              : `（没有匹配「${wanted}」的缓存目录；本次扫描共 ${all.length} 个，不带参数即可读全部）`,
          ],
        };
      }
      return {
        total: matched.length,
        lines: matched
          .slice(offset, offset + limit)
          .map(
            (row) =>
              `${row.entry.path}  ${formatSize(row.entry.size)}  （${row.toolName} · ${row.entry.name} · ${row.entry.fileCount} 个文件）`,
          ),
      };
    },
    // 单条详情。itemId 是上面每行行首的完整路径；模型也可能只回一个目录名（"Cache"），
    // 那种只有在全表唯一命中时才认 —— 否则会把 Devin 的 Cache 说成 Kimi 的。
    readItemDetail: (itemId) => {
      const wanted = itemId.trim();
      if (!wanted) return null;
      const all = flattenEntries();
      const sameName = all.filter((row) => row.entry.name === wanted);
      const row =
        all.find((item) => item.entry.path === wanted) ??
        all.find((item) => item.entry.path.endsWith(`\\${wanted}`)) ??
        (sameName.length === 1 ? sameName[0] : undefined);
      if (!row) return null;

      const siblings = all.filter(
        (item) => item.toolId === row.toolId && item.entry.path !== row.entry.path,
      );
      const siblingSize = siblings.reduce((total, item) => total + item.entry.size, 0);
      return [
        `工具：${row.toolName}`,
        `目录：${row.entry.name}`,
        `路径：${row.entry.path}`,
        `占用：${formatSize(row.entry.size)}（${row.entry.fileCount} 个文件）`,
        '性质：客户端自己生成的缓存，删掉后工具下次运行会重新生成，不影响已装扩展、设置和登录状态。',
        siblings.length > 0
          ? `同一工具下还有 ${siblings.length} 个可清理目录，合计 ${formatSize(siblingSize)}。`
          : '同一工具下没有别的可清理目录。',
        '删除方式：不进回收站、不可恢复；工具正在运行时可能因文件被占用而删不掉。',
      ].join('\n');
    },
    summary: () => {
      // 没扫过返回 null，助手会如实说"还没有数据"，而不是编一段
      if (!result) return null;
      if (result.groups.length === 0) {
        return '已完成扫描：当前没有发现可清理的 AI 工具缓存（这些工具可能都没安装，或者缓存目录结构与预期不同）。';
      }
      const all = flattenEntries();
      const top = result.groups
        .slice(0, 3)
        .map((group) => `${group.toolName} ${formatSize(group.totalSize)}`)
        .join('、');
      return [
        `扫描到 ${result.groups.length} 个工具留下的 ${all.length} 个缓存目录，合计 ${formatSize(result.totalSize)}（${result.totalFiles} 个文件）。`,
        `占用最多的：${top}。`,
        `当前已勾选 ${selected.size} 个目录。`,
        '口径说明：只统计缓存类目录（Cache / GPUCache / logs / CachedData 这类）。',
        '会话历史、登录凭据、插件本体、站点数据都不在统计范围内，',
        '所以这些工具的实际总占用会明显大于这里的数字，这是设计如此，不是漏扫。',
      ].join('');
    },
  });

  /**
   * 执行扫描。
   *
   * `preserveCleared` 为真表示这是删除后的自动重扫：不清掉"刚清空"标记，
   * 否则空结果会先闪一帧"没有发现可清理的缓存"再变成完成态。
   */
  const runScan = useCallback(async (preserveCleared: boolean) => {
    if (!preserveCleared) setJustCleared(false);
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

  /** 用户主动扫描：回到常规空状态文案 */
  const handleScan = useCallback(() => runScan(false), [runScan]);

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
      const result = await deleteAiToolCaches([...selected]);
      // 三种结果分开报：工具开着时缓存文件被占用是常态，
      // 只报"已删除 N 个"会让用户以为清干净了，实际上大小一点没降。
      if (result.failed.length === 0) {
        showToast({
          type: 'success',
          title: moduleT('aiTools.deletedTitle', { count: result.deleted }),
          description: moduleT('aiTools.deletedDesc'),
        });
      } else if (result.deleted === 0) {
        showToast({
          type: 'error',
          title: moduleT('aiTools.deleteFailed'),
          description: moduleT('aiTools.deleteFailedDesc'),
        });
      } else {
        showToast({
          type: 'warning',
          title: moduleT('aiTools.deletePartialTitle', {
            success: result.deleted,
            failed: result.failed.length,
          }),
          description: moduleT('aiTools.deletePartialDesc'),
        });
      }
      // 标记要在重扫之前落下：删干净后列表为空，若等重扫回来再置位，
      // 会先渲染一帧"没有发现可清理的缓存"
      if (result.deleted > 0) setJustCleared(true);
      await runScan(result.deleted > 0);
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
  }, [moduleT, runScan, selected, showToast]);

  const busy = scanning || deleting;
  /**
   * 底部操作条是否显示。
   *
   * ⚠️ 这一段不能省：`ModuleOperationToolbar` 用 portal 渲染成 `position: fixed` 的悬浮层，
   * **不受模块容器约束** —— 不加这个开关，切到别的模块时它还会浮在人家页面上。
   * 卡片模式看模块是否展开，页面模式看本模块是否是当前页。
   */
  const isExpanded = expandedModule === 'ai-tools';
  const shouldShowOperationToolbar = layoutMode === 'pages' ? isPageActive : isExpanded;

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
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'ai-tools')}
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
            /* 刚删干净是完成态：换成对勾图标 + 完成文案，不再提示"可能没装" */
            icon={justCleared ? undefined : Bot}
            tone={justCleared ? 'success' : 'neutral'}
            title={justCleared ? moduleT('aiTools.clearedTitle') : moduleT('aiTools.emptyTitle')}
            /* 空字符串而不是 undefined：EmptyState 对 undefined 会回落到通用描述 */
            description={justCleared ? '' : moduleT('aiTools.emptyDesc')}
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

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        className="overflow-hidden border-t border-[var(--border-color)] bg-[var(--bg-main)]"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                      >
                        {/* 限高 + 内部滚动：单个工具可能有上千个目录/文件，
                            不限高会把整张卡片撑得极长，同屏看不到其它工具 */}
                        <div className="max-h-[15em] overflow-y-auto px-5 py-2">
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
                          <span className="w-20 shrink-0 text-right tabular-nums text-[var(--text-muted)]">
                            {formatSize(entry.size)}
                          </span>
                          {/* 打开所在文件夹：先用资源管理器看一眼再决定要不要删 */}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openInFolder(entry.path);
                            }}
                            title={moduleT('aiTools.openFolder')}
                            className="shrink-0 rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--brand-green)]"
                          >
                            <FolderOpen className="h-4 w-4" />
                          </button>
                          {/* 明细走弹窗：目录下可能有上万个文件，不能就地展开 */}
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setViewDir({ path: entry.path, name: entry.name });
                            }}
                            className="shrink-0 text-[var(--brand-green)] hover:underline"
                          >
                            {moduleT('aiTools.viewAll')}
                          </button>
                        </div>
                      ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

            {/* 操作条复用公共组件：和社交专清、大文件、右键菜单同一个悬浮层，
                位置、忙碌态、玻璃外观都由它统一处理，不在这里自己拼一套。 */}
            {shouldShowOperationToolbar && (
            <ModuleOperationToolbar
              moduleId="aiTools"
              busy={deleting}
              busyContent={
                <ModuleDeleteProgress
                  variant="floating"
                  phaseLabel={moduleT('aiTools.deleting')}
                  progressLabel={moduleT('aiTools.deletingDesc', { count: selected.size })}
                />
              }
            >
              {/* 样式全部用公共操作条的语义类，不在这里自己写颜色和字号 */}
              <button
                type="button"
                onClick={() =>
                  setSelected(selected.size === allPaths.length ? new Set() : new Set(allPaths))
                }
                disabled={allPaths.length === 0}
                className="module-operation-toolbar__button module-operation-toolbar__button--muted"
              >
                {selected.size === allPaths.length && allPaths.length > 0
                  ? moduleT('aiTools.deselectAll')
                  : moduleT('aiTools.selectAll')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={selected.size === 0 || deleting}
                className="module-operation-toolbar__button module-operation-toolbar__button--danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {moduleT('aiTools.delete')} ({selected.size})
              </button>
            </ModuleOperationToolbar>
            )}
          </div>
        )}
      </div>

      <AiCacheFileModal
        isOpen={viewDir !== null}
        dirPath={viewDir?.path ?? null}
        dirName={viewDir?.name ?? ''}
        onClose={() => setViewDir(null)}
      />

      <ConfirmDialog
        isOpen={confirmOpen}
        title={moduleT('aiTools.confirmTitle', { count: selected.size })}
        description={moduleT('aiTools.confirmDesc', { size: formatSize(selectedSize) })}
        warning={moduleT('aiTools.confirmWarning')}
        confirmText={moduleT('aiTools.delete')}
        /* 删目录不可逆：图标和确认按钮都要走危险色，别用默认的绿色 */
        isDanger
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </ModuleCard>
  );
}
