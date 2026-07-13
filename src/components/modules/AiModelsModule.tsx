import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  BrainCircuit,
  FolderOpen,
  Gauge,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { DonutChart, ColumnChart, CHART_PALETTE, type ChartItem } from '../ui/charts';
import { Select, type SelectOption } from '../ui/Select';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';
import {
  deleteAiModel,
  getFailureReasonMessage,
  openInFolder,
  scanAiModelAssets,
  type AiAssetSource,
  type AiModelItem,
  type AiModelScanProgress,
  type AiModelScanResult,
} from '../../api/commands';
import { formatSize } from '../../utils/format';
import { openSearchUrl } from '../../utils/searchEngine';

const DEEP_DISCOVERY_STORAGE_KEY = 'lightc.aiModels.deepDiscovery';
const LARGE_MODEL_THRESHOLD = 20 * 1024 * 1024 * 1024;

type AiModelViewMode = 'overview' | 'models';
type AiModelSortMode = 'size-desc' | 'size-asc' | 'name-asc' | 'name-desc';

interface FlattenedModel extends AiModelItem {
  sourceName: string;
}

interface DisplayModelName {
  title: string;
  typeLabel: string | null;
}

export function AiModelsModule({ layoutMode = 'cards', isPageActive = true }: ModuleRenderProps) {
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useModuleDashboard('aiModels');
  const { showToast } = useToast();

  const scanningRef = useRef(false);
  const lastScanTriggerRef = useRef(0);

  const [scanResult, setScanResult] = useState<AiModelScanResult | null>(null);
  const [enableDeepDiscovery, setEnableDeepDiscovery] = useState(() => loadDeepDiscovery());
  const [viewMode, setViewMode] = useState<AiModelViewMode>('overview');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortMode, setSortMode] = useState<AiModelSortMode>('size-desc');
  const [modelKeyword, setModelKeyword] = useState('');
  const [scanProgress, setScanProgress] = useState<AiModelScanProgress | null>(null);
  const [modelPendingDeletion, setModelPendingDeletion] = useState<FlattenedModel | null>(null);
  const [deletingModelPath, setDeletingModelPath] = useState<string | null>(null);

  const allModels = useMemo(() => flattenModels(scanResult), [scanResult]);
  const largestModel = allModels[0] ?? null;
  const largestSource = scanResult?.sources[0] ?? null;
  const largeModelCount = useMemo(
    () => allModels.filter(model => model.size >= LARGE_MODEL_THRESHOLD).length,
    [allModels]
  );
  const modelTypeOptions = useMemo(() => getModelTypeOptions(allModels), [allModels]);
  const filteredModels = useMemo(
    () => filterAndSortModels(allModels, platformFilter, typeFilter, sortMode, modelKeyword),
    [allModels, platformFilter, typeFilter, sortMode, modelKeyword]
  );

  useEffect(() => {
    // 深度发现会触发全盘 MFT 兜底，记住用户选择可以避免每次进入模块都反复确认。
    localStorage.setItem(DEEP_DISCOVERY_STORAGE_KEY, JSON.stringify(enableDeepDiscovery));
  }, [enableDeepDiscovery]);

  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;

    scanningRef.current = true;
    setScanProgress(null);
    updateModuleState('aiModels', { status: 'scanning', error: null });
    setExpandedModule('aiModels');

    try {
      const result = await scanAiModelAssets(enableDeepDiscovery);
      setScanResult(result);
      setPlatformFilter('all');
      setTypeFilter('all');
      setSortMode('size-desc');
      setModelKeyword('');
      updateModuleState('aiModels', {
        status: 'done',
        fileCount: result.total_model_count,
        totalSize: result.total_size,
      });

      if (result.total_model_count === 0) {
        showToast({
          type: 'info',
          title: '未发现 AI 资产',
          description: '可开启深度发现，扫描本地 NTFS 盘中的大模型特征文件。',
        });
      }
    } catch (error) {
      updateModuleState('aiModels', { status: 'error', error: String(error) });
      showToast({ type: 'error', title: 'AI资产分析失败', description: String(error) });
    } finally {
      scanningRef.current = false;
    }
  }, [enableDeepDiscovery, setExpandedModule, showToast, updateModuleState]);

  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [handleScan, oneClickScanTrigger]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen<AiModelScanProgress>('ai-models:progress', (event) => {
      if (!cancelled) {
        setScanProgress(event.payload);
      }
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const handleSearchModel = useCallback(async (modelName: string) => {
    try {
      const displayName = splitDisplayModelName(modelName);
      // 搜索使用用户能理解的模型文件名，避免把 ComfyUI 内部类型目录带进查询词降低结果相关性。
      await openSearchUrl(`${displayName.title} AI 模型`);
    } catch (error) {
      showToast({ type: 'error', title: '打开搜索失败', description: String(error) });
    }
  }, [showToast]);

  const handleDeleteModel = useCallback(async () => {
    if (!modelPendingDeletion) return;

    const model = modelPendingDeletion;
    setModelPendingDeletion(null);
    setDeletingModelPath(model.path);
    try {
      const result = await deleteAiModel(model.path);
      const detail = result.file_results[0];
      if (!detail?.success) {
        const reason = detail ? getFailureReasonMessage(detail.failure_reason) : result.summary_message;
        showToast({
          type: 'warning',
          title: '模型删除未完成',
          description: reason || result.summary_message || '文件未被删除，请检查文件占用情况。',
        });
        return;
      }

      const nextScanResult = removeDeletedModel(scanResult, model.path);
      setScanResult(nextScanResult);
      updateModuleState('aiModels', {
        status: 'done',
        fileCount: nextScanResult?.total_model_count ?? 0,
        totalSize: nextScanResult?.total_size ?? 0,
      });
      showToast({
        type: 'success',
        title: '模型文件已删除',
        description: `${model.name} · 已释放 ${formatSize(detail.logical_size)}`,
      });
    } catch (error) {
      showToast({ type: 'error', title: '删除模型失败', description: String(error) });
    } finally {
      setDeletingModelPath(null);
    }
  }, [modelPendingDeletion, scanResult, showToast, updateModuleState]);

  const isExpanded = expandedModule === 'aiModels';
  const isScanning = moduleState.status === 'scanning';

  if (shouldSkipInactivePageRender(layoutMode, isPageActive)) {
    return null;
  }

  return (
    <>
      <ModuleCard
      variant={layoutMode === 'pages' ? 'page' : 'card'}
      forceExpanded={layoutMode === 'pages'}
      id="aiModels"
      title="AI 模型空间"
      description="快速分析本机 AI 模型占用"
      icon={<BrainCircuit className="w-6 h-6 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      doneBadgeText="已发现"
      emptyDoneBadgeText="未发现"
      countLabel="个资产"
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'aiModels')}
      onScan={handleScan}
      scanButtonText={isScanning ? '分析中...' : scanResult ? '重新分析' : '开始分析'}
      error={moduleState.error}
      headerExtra={
        <div className="flex shrink-0 items-center gap-2">
          <DeepDiscoveryToggle
            enabled={enableDeepDiscovery}
            disabled={isScanning}
            onChange={setEnableDeepDiscovery}
          />
        </div>
      }
    >
      <div className="p-5 space-y-5">
        {moduleState.status === 'idle' && !scanResult && (
          <EmptyState
            icon={BrainCircuit}
            title="尚未分析 AI 资产"
            description="点击开始分析，快速检测 Ollama、LM Studio、ComfyUI、HuggingFace；找不到模型时再开启深度发现。"
            action={
              <button
                onClick={handleScan}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--brand-green)] text-white text-sm font-semibold hover:bg-[var(--brand-green-hover)] transition"
              >
                <Search className="w-4 h-4" />
                开始分析
              </button>
            }
          />
        )}

        {isScanning && (
          <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--brand-green)]/10">
              <Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />
            </div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {scanProgress?.message ?? (enableDeepDiscovery ? '正在深度发现 AI 模型...' : '正在快速检测 AI 模型...')}
            </p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {scanProgress
                ? `当前阶段 ${formatDuration(scanProgress.stage_elapsed_ms)} · 总耗时 ${formatDuration(scanProgress.elapsed_ms)}`
                : enableDeepDiscovery
                ? '正在用 MFT 扫描本地 NTFS 盘的大模型特征文件，并跳过已识别平台路径。'
                : '只扫描已知平台目录和你添加的目录，不会启动全盘扫描。'}
            </p>
          </div>
        )}

        {scanResult && !isScanning && (
          <>
            <HeroOverview
              scanResult={scanResult}
              largestModel={largestModel}
              onOpenPath={openInFolder}
              onSearchModel={handleSearchModel}
            />

            <InsightsRow
              scanResult={scanResult}
              largestSource={largestSource}
              largeModelCount={largeModelCount}
            />

            <ViewModeTabs value={viewMode} onChange={setViewMode} />

            {viewMode === 'overview' && (
              <OverviewDashboard
                scanResult={scanResult}
                models={allModels}
              />
            )}

            {viewMode === 'models' && (
              <>
                <ModelListFilters
                  sources={scanResult.sources}
                  typeOptions={modelTypeOptions}
                  platformFilter={platformFilter}
                  typeFilter={typeFilter}
                  modelKeyword={modelKeyword}
                  onPlatformChange={setPlatformFilter}
                  onTypeChange={setTypeFilter}
                  onKeywordChange={setModelKeyword}
                  onKeywordClear={() => setModelKeyword('')}
                />
                <ModelTable
                  title="模型列表"
                  models={filteredModels}
                  totalCount={allModels.length}
                  sortMode={sortMode}
                  onSortChange={setSortMode}
                  onOpenPath={openInFolder}
                  onSearchModel={handleSearchModel}
                  onDeleteModel={setModelPendingDeletion}
                  deletingModelPath={deletingModelPath}
                />
              </>
            )}

            {scanResult.warnings.length > 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                <p className="text-xs font-semibold text-amber-600">部分目录读取失败</p>
                <div className="mt-1 space-y-1">
                  {scanResult.warnings.slice(0, 3).map(warning => (
                    <p key={warning} className="text-[11px] leading-relaxed text-amber-700">{warning}</p>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      </ModuleCard>

      <ConfirmDialog
        isOpen={modelPendingDeletion !== null}
        onCancel={() => setModelPendingDeletion(null)}
        onConfirm={() => void handleDeleteModel()}
        title="确认删除模型文件"
        description={modelPendingDeletion
          ? `将永久删除“${modelPendingDeletion.name}”，文件大小约 ${formatSize(modelPendingDeletion.size)}。`
          : ''}
        warning={modelPendingDeletion
          ? `路径：${modelPendingDeletion.path}。删除后无法通过 LightC 恢复，请确认该文件不是正在使用的模型。`
          : undefined}
        confirmText="确认删除"
        cancelText="取消"
        isDanger
      />
    </>
  );
}

function DeepDiscoveryToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-[var(--bg-hover)] px-3 py-1.5"
      title="开启后深度扫描全盘模型特征文件；管理员权限下速度和覆盖率更好。"
    >
      <span className="text-xs font-medium text-[var(--fg-secondary)]">深度发现</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${
          enabled ? 'bg-[var(--brand-green)]' : 'bg-[var(--bg-hover)]'
        } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
        aria-pressed={enabled}
        aria-label="切换深度发现"
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition ${
            enabled ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function HeroOverview({
  scanResult,
  largestModel,
  onOpenPath,
  onSearchModel,
}: {
  scanResult: AiModelScanResult;
  largestModel: FlattenedModel | null;
  onOpenPath: (path: string) => Promise<void>;
  onSearchModel: (modelName: string) => Promise<void>;
}) {
  const displayName = largestModel ? splitDisplayModelName(largestModel.name) : null;
  const largestModelType = largestModel ? getModelType(largestModel) : null;

  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="grid grid-cols-[190px_minmax(0,1fr)] items-center gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-[var(--text-muted)]">AI资产总占用</p>
            <ScanDurationPopover scanResult={scanResult} />
          </div>
          <p className="mt-1 text-3xl font-bold tabular-nums text-[var(--brand-green)]">
            {formatSize(scanResult.total_size)}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            发现 {scanResult.total_model_count.toLocaleString()} 个资产 · {scanResult.source_count} 个来源 · {scanResult.discovery_mode === 'deep' ? '深度发现' : '快速扫描'}
          </p>
        </div>

        <div className="flex min-w-0 items-start justify-between gap-4 border-l border-[var(--border-color)] pl-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--text-muted)]">最大模型</p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate text-xl font-bold text-[var(--text-primary)]" title={largestModel?.path ?? largestModel?.name}>
                {displayName?.title ?? '未发现模型'}
              </p>
              {largestModelType && (
                <span className="shrink-0 rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                  {largestModelType}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold text-[var(--brand-green)]">
              {largestModel ? `${formatSize(largestModel.size)} · ${largestModel.sourceName}` : '开启深度发现后重新分析'}
            </p>
            {largestModel && (
              <p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={largestModel.path}>
                {largestModel.path}
              </p>
            )}
          </div>
          {largestModel && (
            <div className="flex shrink-0 items-center gap-1">
              <IconButton title="打开目录" onClick={() => onOpenPath(largestModel.path)} icon={<FolderOpen className="w-4 h-4" />} />
              <IconButton title="搜索模型" onClick={() => onSearchModel(largestModel.name)} icon={<Search className="w-4 h-4" />} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScanDurationPopover({ scanResult }: { scanResult: AiModelScanResult }) {
  if (scanResult.phase_durations.length === 0) return null;

  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)] hover:text-[var(--brand-green)] transition"
      >
        耗时 {formatDuration(scanResult.scan_duration_ms)}
      </button>
      <div className="pointer-events-none absolute left-0 top-full z-20 w-[420px] pt-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3 shadow-lg">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-[var(--text-primary)]">扫描耗时</p>
            <p className="text-xs text-[var(--text-muted)]">总计 {formatDuration(scanResult.scan_duration_ms)}</p>
          </div>
          <div className="mt-2 grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto pr-1">
            {scanResult.phase_durations.map((phase, index) => (
              <div key={`${phase.stage}-${index}`} className="grid grid-cols-[minmax(0,1fr)_52px] items-center gap-2 rounded-lg bg-[var(--bg-main)] px-2.5 py-1.5">
                <span className="min-w-0 truncate text-xs text-[var(--text-muted)]" title={phase.label}>{phase.label}</span>
                <span className="text-right text-xs font-semibold tabular-nums text-[var(--text-primary)]">
                  {formatDuration(phase.duration_ms)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function InsightsRow({
  scanResult,
  largestSource,
  largeModelCount,
}: {
  scanResult: AiModelScanResult;
  largestSource: AiAssetSource | null;
  largeModelCount: number;
}) {
  const insights = [
    { label: '发现模型', value: `${scanResult.total_model_count.toLocaleString()} 个`, icon: Sparkles },
    { label: '最大平台', value: largestSource ? `${largestSource.name} · ${formatSize(largestSource.total_size)}` : '暂无', icon: BarChart3 },
    { label: '超过 20GB', value: `${largeModelCount} 个`, icon: Gauge },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {insights.map(insight => {
        const Icon = insight.icon;
        return (
          <div key={insight.label} className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-green)]/10 text-[var(--brand-green)]">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] text-[var(--text-muted)]">{insight.label}</p>
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{insight.value}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ViewModeTabs({ value, onChange }: { value: AiModelViewMode; onChange: (value: AiModelViewMode) => void }) {
  const tabs: Array<{ value: AiModelViewMode; label: string }> = [
    { value: 'overview', label: '概览' },
    { value: 'models', label: '模型列表' },
  ];

  return (
    <div className="inline-flex rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-1">
      {tabs.map(tab => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
            value === tab.value
              ? 'bg-[var(--brand-green)] text-white shadow-sm'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function OverviewDashboard({
  scanResult,
  models,
}: {
  scanResult: AiModelScanResult;
  models: FlattenedModel[];
}) {
  const modelTypeStats = getModelTypeStats(models);
  const uncategorizedSource = scanResult.sources.find(source => source.name === '未归类');

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
      <PlatformUsageChart sources={scanResult.sources} />
      <ModelTypeChart stats={modelTypeStats} />

      {uncategorizedSource && (
        <div className="xl:col-span-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
          <p className="text-xs font-semibold text-amber-700">发现未归类模型</p>
          <p className="mt-1 text-xs text-amber-700">
            {uncategorizedSource.model_count.toLocaleString()} 个模型 · {formatSize(uncategorizedSource.total_size)}。这些文件未匹配到已知平台目录，建议在模型列表中筛选“未归类”确认归属。
          </p>
        </div>
      )}
    </div>
  );
}

function PlatformUsageChart({ sources }: { sources: AiAssetSource[] }) {
  const totalSize = sources.reduce((sum, source) => sum + source.total_size, 0);
  const chartItems: ChartItem[] = sources.map((source, index) => {
    const percent = totalSize > 0 ? (source.total_size / totalSize) * 100 : 0;
    return {
      id: source.name,
      label: source.name,
      value: source.total_size,
      valueLabel: formatSize(source.total_size),
      percentLabel: `${percent.toFixed(1)}%`,
      secondaryLabel: `${source.model_count.toLocaleString()} 个模型`,
      color: CHART_PALETTE[index % CHART_PALETTE.length],
    };
  });

  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">平台占用</p>
        <p className="text-xs text-[var(--text-muted)]">{sources.length.toLocaleString()} 个来源</p>
      </div>

      <div className="mt-4">
        <DonutChart
          items={chartItems}
          totalLabel="总占用"
          totalValueLabel={formatSize(totalSize)}
          emptyText="暂无平台占用数据"
        />
      </div>
    </div>
  );
}

function ModelTypeChart({ stats }: { stats: Array<{ type: string; count: number; size: number }> }) {
  const visibleStats = getVisibleModelTypeStats(stats);
  const chartItems: ChartItem[] = visibleStats.map((item, index) => ({
    id: item.type,
    label: item.type,
    value: item.size,
    valueLabel: formatSize(item.size),
    secondaryLabel: `${item.count.toLocaleString()} 个模型`,
    color: CHART_PALETTE[index % CHART_PALETTE.length],
  }));

  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">类型分布</p>
        <p className="text-xs text-[var(--text-muted)]">{stats.length.toLocaleString()} 类</p>
      </div>

      <div className="mt-4">
        {/* 柱状图保留 8 个展示位，超出的类别汇总到“其他类型”，避免图表拥挤同时不丢总量。 */}
        <ColumnChart items={chartItems} emptyText="暂无类型分布数据" />
      </div>
    </div>
  );
}

function getVisibleModelTypeStats(
  stats: Array<{ type: string; count: number; size: number }>
): Array<{ type: string; count: number; size: number }> {
  const visibleLimit = 8;
  if (stats.length <= visibleLimit) return stats;

  const primaryStats = stats.slice(0, visibleLimit - 1);
  const otherStats = stats.slice(visibleLimit - 1);
  const otherSummary = otherStats.reduce(
    (summary, item) => ({
      type: summary.type,
      count: summary.count + item.count,
      size: summary.size + item.size,
    }),
    { type: '其他类型', count: 0, size: 0 }
  );

  // 概览统计关注空间结构，长尾类别汇总展示比直接截断更符合“空间分析”的总量认知。
  return [...primaryStats, otherSummary];
}

function ModelListFilters({
  sources,
  typeOptions,
  platformFilter,
  typeFilter,
  modelKeyword,
  onPlatformChange,
  onTypeChange,
  onKeywordChange,
  onKeywordClear,
}: {
  sources: AiAssetSource[];
  typeOptions: string[];
  platformFilter: string;
  typeFilter: string;
  modelKeyword: string;
  onPlatformChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onKeywordChange: (value: string) => void;
  onKeywordClear: () => void;
}) {
  const platformOptions: SelectOption[] = [
    { value: 'all', label: '全部平台' },
    ...sources.map(source => ({ value: source.name, label: source.name })),
  ];
  const typeSelectOptions: SelectOption[] = [
    { value: 'all', label: '全部类型' },
    ...typeOptions.map(type => ({ value: type, label: type })),
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
      <FilterField label="平台">
        <Select value={platformFilter} options={platformOptions} onChange={onPlatformChange} widthClass="w-36" size="sm" />
      </FilterField>

      <FilterField label="类型">
        <Select value={typeFilter} options={typeSelectOptions} onChange={onTypeChange} widthClass="w-36" size="sm" />
      </FilterField>

      <FilterField label="搜索" className="min-w-[280px] flex-1">
        <div className="relative w-full min-w-[180px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={modelKeyword}
            onChange={event => onKeywordChange(event.target.value)}
            placeholder="搜索模型、路径或来源"
            className="h-8 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] pl-8 pr-8 text-xs text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--brand-green)] focus:ring-2 focus:ring-[var(--brand-green)]/20"
          />
          {modelKeyword.trim().length > 0 && (
            <button
              type="button"
              onClick={onKeywordClear}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              aria-label="清空模型搜索关键词"
              title="清空搜索"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </FilterField>
    </div>
  );
}

function FilterField({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 text-xs text-[var(--text-muted)] ${className}`}>
      <span className="shrink-0">{label}</span>
      {children}
    </div>
  );
}

function ModelTable({
  title,
  models,
  totalCount,
  sortMode,
  compact = false,
  onSortChange,
  onOpenPath,
  onSearchModel,
  onDeleteModel,
  deletingModelPath,
}: {
  title: string;
  models: FlattenedModel[];
  totalCount?: number;
  sortMode: AiModelSortMode;
  compact?: boolean;
  onSortChange: (value: AiModelSortMode) => void;
  onOpenPath: (path: string) => Promise<void>;
  onSearchModel: (modelName: string) => Promise<void>;
  onDeleteModel: (model: FlattenedModel) => void;
  deletingModelPath: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
          <p className="text-xs text-[var(--text-muted)]">
            {models.length.toLocaleString()} / {(totalCount ?? models.length).toLocaleString()} 项
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <SortHeaderButton
            label="名称"
            activeAscMode="name-asc"
            activeDescMode="name-desc"
            sortMode={sortMode}
            onSortChange={onSortChange}
          />
          <SortHeaderButton
            label="大小"
            activeAscMode="size-asc"
            activeDescMode="size-desc"
            sortMode={sortMode}
            onSortChange={onSortChange}
          />
        </div>
      </div>
      <div className="divide-y divide-[var(--border-color)]">
        {models.map(model => {
          const displayName = splitDisplayModelName(model.name);
          const modelType = getModelType(model);
          const canDeleteModel = !model.path.toLowerCase().endsWith('.mlpackage');

          return (
            <div key={`${model.sourceName}-${model.path}-${model.name}`} className={`flex items-center gap-3 px-4 hover:bg-[var(--bg-hover)] transition ${compact ? 'py-2.5' : 'py-3'}`}>
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-green)]/10">
                  <BrainCircuit className="h-4 w-4 text-[var(--brand-green)]" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]" title={model.name}>{displayName.title}</p>
                    <SourceTag sourceName={model.sourceName} />
                    <TypeTag label={modelType} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]" title={model.path}>
                    {formatMiddleEllipsisPath(model.path)}
                  </p>
                </div>
              </div>
              <p className="w-24 shrink-0 text-right text-sm font-bold tabular-nums text-[var(--brand-green)]">
                {formatSize(model.size)}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <IconButton title="打开目录" onClick={() => onOpenPath(model.path)} icon={<FolderOpen className="w-4 h-4" />} />
                <IconButton title="搜索模型" onClick={() => onSearchModel(model.name)} icon={<Search className="w-4 h-4" />} />
                {canDeleteModel && (
                  <IconButton
                    title="删除模型文件"
                    onClick={() => onDeleteModel(model)}
                    disabled={deletingModelPath !== null}
                    icon={deletingModelPath === model.path
                      ? <Loader2 className="h-4 w-4 animate-spin text-[var(--color-danger)]" />
                      : <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortHeaderButton({
  label,
  activeAscMode,
  activeDescMode,
  sortMode,
  onSortChange,
}: {
  label: string;
  activeAscMode: AiModelSortMode;
  activeDescMode: AiModelSortMode;
  sortMode: AiModelSortMode;
  onSortChange: (value: AiModelSortMode) => void;
}) {
  const isActive = sortMode === activeAscMode || sortMode === activeDescMode;
  const nextSortMode = sortMode === activeDescMode ? activeAscMode : activeDescMode;
  const DirectionIcon = sortMode === activeAscMode ? ArrowUp : ArrowDown;

  return (
    <button
      type="button"
      onClick={() => onSortChange(nextSortMode)}
      className={`flex h-7 items-center gap-1 rounded-lg border px-2 text-xs transition ${
        isActive
          ? 'border-[var(--brand-green)] bg-[var(--brand-green)]/10 text-[var(--brand-green)]'
          : 'border-[var(--border-color)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
      title={`按${label}${sortMode === activeDescMode ? '升序' : '降序'}排列`}
    >
      <span>按{label}</span>
      {/* 只在当前排序列展示方向，避免两个按钮同时出现箭头造成误读。 */}
      {isActive && <DirectionIcon className="h-3 w-3" />}
    </button>
  );
}

function SourceTag({ sourceName }: { sourceName: string }) {
  const isUncategorized = sourceName === '未归类';

  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        isUncategorized
          ? 'border border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-[var(--color-warning)]'
          : 'bg-[var(--brand-green)] text-white'
      }`}
    >
      {sourceName}
    </span>
  );
}

function TypeTag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full border border-[var(--border-color)] bg-transparent px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
      {label}
    </span>
  );
}

function IconButton({ title, icon, onClick, disabled = false }: { title: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        if (disabled) return;
        onClick();
      }}
      disabled={disabled}
      className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--brand-green)] transition disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
    </button>
  );
}

function removeDeletedModel(scanResult: AiModelScanResult | null, deletedPath: string): AiModelScanResult | null {
  if (!scanResult) return scanResult;

  const sources = scanResult.sources
    .map((source) => {
      const models = source.models.filter((model) => model.path !== deletedPath);
      return {
        ...source,
        models,
        model_count: models.length,
        total_size: models.reduce((total, model) => total + model.size, 0),
      };
    })
    .filter((source) => source.models.length > 0);

  return {
    ...scanResult,
    sources,
    source_count: sources.length,
    total_model_count: sources.reduce((total, source) => total + source.model_count, 0),
    total_size: sources.reduce((total, source) => total + source.total_size, 0),
  };
}

function flattenModels(scanResult: AiModelScanResult | null): FlattenedModel[] {
  if (!scanResult) return [];

  return scanResult.sources
    .flatMap(source => source.models.map(model => ({ ...model, sourceName: source.name })))
    .sort((left, right) => right.size - left.size);
}

function filterAndSortModels(
  models: FlattenedModel[],
  platformFilter: string,
  typeFilter: string,
  sortMode: AiModelSortMode,
  modelKeyword: string
): FlattenedModel[] {
  const normalizedKeyword = modelKeyword.trim().toLowerCase();
  const filteredModels = models.filter(model => {
    const modelType = getModelType(model);
    return (platformFilter === 'all' || model.sourceName === platformFilter)
      && (typeFilter === 'all' || modelType === typeFilter)
      && matchesModelKeyword(model, modelType, normalizedKeyword);
  });

  return [...filteredModels].sort((left, right) => {
    if (sortMode === 'name-asc') {
      return splitDisplayModelName(left.name).title.localeCompare(splitDisplayModelName(right.name).title);
    }
    if (sortMode === 'name-desc') {
      return splitDisplayModelName(right.name).title.localeCompare(splitDisplayModelName(left.name).title);
    }
    if (sortMode === 'size-asc') {
      return left.size - right.size;
    }
    return right.size - left.size;
  });
}

function matchesModelKeyword(
  model: FlattenedModel,
  modelType: string,
  normalizedKeyword: string
): boolean {
  if (!normalizedKeyword) return true;

  const displayName = splitDisplayModelName(model.name);
  // 搜索覆盖“可见模型名 + 原始名称 + 路径 + 来源 + 类型”，因为用户可能只记得模型片段，也可能按存储目录定位。
  return [
    displayName.title,
    model.name,
    model.path,
    model.sourceName,
    modelType,
  ].some(searchText => searchText.toLowerCase().includes(normalizedKeyword));
}

function getModelTypeOptions(models: FlattenedModel[]): string[] {
  return Array.from(new Set(models.map(getModelType))).sort((left, right) => left.localeCompare(right));
}

function getModelTypeStats(models: FlattenedModel[]): Array<{ type: string; count: number; size: number }> {
  const stats = new Map<string, { type: string; count: number; size: number }>();

  for (const model of models) {
    const type = getModelChartType(model);
    const current = stats.get(type) ?? { type, count: 0, size: 0 };
    current.count += 1;
    current.size += model.size;
    stats.set(type, current);
  }

  return Array.from(stats.values()).sort((left, right) => right.size - left.size);
}

function getModelChartType(model: AiModelItem): string {
  const categoryLabel = splitDisplayModelName(model.name).typeLabel;
  // 概览图服务于空间结构理解：ComfyUI 等平台有明确模型类别时保留类别，否则用扩展名兜底。
  return categoryLabel || getModelType(model);
}

function getModelType(model: AiModelItem): string {
  const extension = model.path.split('.').pop()?.trim().toLowerCase();
  // 类型统一使用文件扩展名，避免 ComfyUI 子目录名和其他平台扩展名混用导致语义不一致。
  return extension ? `${extension}` : '未知类型';
}

function formatMiddleEllipsisPath(path: string): string {
  const normalizedPath = path.trim();
  if (normalizedPath.length <= 86) {
    return normalizedPath;
  }

  const separatorIndex = Math.max(normalizedPath.lastIndexOf('\\'), normalizedPath.lastIndexOf('/'));
  if (separatorIndex <= 0) {
    return `${normalizedPath.slice(0, 36)}...${normalizedPath.slice(-38)}`;
  }

  const fileName = normalizedPath.slice(separatorIndex + 1);
  const parentPath = normalizedPath.slice(0, separatorIndex);
  if (fileName.length >= 48) {
    // 长模型文件名通常包含量化、精度和版本信息，保留结尾比单纯右截断更利于用户辨认。
    return `${parentPath.slice(0, 34)}...\\${fileName.slice(0, 24)}...${fileName.slice(-22)}`;
  }

  return `${parentPath.slice(0, 48)}...\\${fileName}`;
}

function splitDisplayModelName(name: string): DisplayModelName {
  const separator = ' / ';
  const separatorIndex = name.indexOf(separator);
  if (separatorIndex <= 0) {
    return { title: name, typeLabel: null };
  }

  const typeLabel = name.slice(0, separatorIndex).trim();
  const title = name.slice(separatorIndex + separator.length).trim();
  // ComfyUI Detector 会把模型类型拼进名称；展示时拆开，避免内部目录结构压过用户真正关心的文件名。
  return {
    title: title || name,
    typeLabel: typeLabel || null,
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

function loadDeepDiscovery(): boolean {
  try {
    // 本地存储可能被用户或旧版本写入异常内容，读取时只接受明确的 true。
    return JSON.parse(localStorage.getItem(DEEP_DISCOVERY_STORAGE_KEY) ?? 'false') === true;
  } catch {
    return false;
  }
}

export default AiModelsModule;
