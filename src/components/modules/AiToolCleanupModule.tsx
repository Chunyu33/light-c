/**
 * AI 工具清理模块。
 *
 * 展示形态和社交专清一致：每个工具一张卡片，展开看它下面的缓存目录。
 * 这一版只做「扫描 + 查看」，删除还没接 —— 缓存目录里有凭据和会话，
 * 删除入口要单独设计确认流程，不能顺手加个按钮。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, HardDrive, RefreshCw } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { scanAiToolCaches } from '../../api/aiToolCleanup';
import type { AiToolScanResult } from '../../types/aiToolCleanup';
import { formatSize } from '../../utils/format';
import type { ModuleRenderProps } from './moduleProps';

export function AiToolCleanupModule({ layoutMode = 'cards' }: ModuleRenderProps) {
  const { t: navT } = useTranslation('nav');
  const { t: moduleT } = useTranslation('modules');

  // 卡片模式下默认展开：这页只有一层工具列表，折叠起来反而要多点一次
  const [expanded, setExpanded] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<AiToolScanResult | null>(null);
  const [error, setError] = useState('');

  const handleScan = useCallback(async () => {
    setScanning(true);
    setError('');
    try {
      setResult(await scanAiToolCaches());
    } catch (scanError) {
      console.error('扫描 AI 工具缓存失败:', scanError);
      setError(String(scanError));
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <ModuleCard
      variant={layoutMode === 'pages' ? 'page' : 'card'}
      forceExpanded={layoutMode === 'pages'}
      id="ai-tools"
      title={navT('aiToolCleanup')}
      description={navT('aiToolCleanupDesc')}
      icon={<Bot className="w-6 h-6 text-[var(--brand-green)]" />}
      status={scanning ? 'scanning' : result ? 'done' : 'idle'}
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
            {result.groups.map((group) => (
              <div
                key={group.toolId}
                className="rounded-2xl bg-[var(--bg-card)] shadow-sm overflow-hidden"
              >
                <div className="flex items-center gap-4 px-5 py-4">
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

                {/* 展开每个缓存目录的明细：路径要让用户能看懂删的是什么 */}
                <div className="border-t border-[var(--border-color)] bg-[var(--bg-main)] px-5 py-2">
                  {group.entries.map((entry) => (
                    <div
                      key={entry.path}
                      className="flex items-center gap-3 py-1.5 text-[0.86rem]"
                    >
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
              </div>
            ))}
          </div>
        )}
      </div>
    </ModuleCard>
  );
}
