import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BrainCircuit,
  FolderOpen,
  Gauge,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { DonutChart, ColumnChart, CHART_PALETTE, type ChartItem } from '../ui/charts';
import { Select, type SelectOption } from '../ui/Select';
import { useModuleDashboard } from '../../contexts/DashboardContext';
import { shouldSkipInactivePageRender, type ModuleRenderProps } from './moduleProps';
import {
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
type AiModelSortMode = 'size-desc' | 'name-asc' | 'platform-asc';

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
  const [scanProgress, setScanProgress] = useState<AiModelScanProgress | null>(null);

  const allModels = useMemo(() => flattenModels(scanResult), [scanResult]);
  const largestModel = allModels[0] ?? null;
  const largestSource = scanResult?.sources[0] ?? null;
  const largeModelCount = useMemo(
    () => allModels.filter(model => model.size >= LARGE_MODEL_THRESHOLD).length,
    [allModels]
  );
  const modelTypeOptions = useMemo(() => getModelTypeOptions(allModels), [allModels]);
  const filteredModels = useMemo(
    () => filterAndSortModels(allModels, platformFilter, typeFilter, sortMode),
    [allModels, platformFilter, typeFilter, sortMode]
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
      await openSearchUrl(`${displayName.title} AI model`);
    } catch (error) {
      showToast({ type: 'error', title: '打开搜索失败', description: String(error) });
    }
  }, [showToast]);

  const isExpanded = expandedModule === 'aiModels';
  const isScanning = moduleState.status === 'scanning';

  if (shouldSkipInactivePageRender(layoutMode, isPageActive)) {
    return null;
  }

  return (
    <ModuleCard
      variant={layoutMode === 'pages' ? 'page' : 'card'}
      forceExpanded={layoutMode === 'pages'}
      id="aiModels"
      title="AI 模型空间"
      description="快速分析本机 AI 模型、LoRA、Embedding 和缓存占用"
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
                  sortMode={sortMode}
                  onPlatformChange={setPlatformFilter}
                  onTypeChange={setTypeFilter}
                  onSortChange={setSortMode}
                />
                <ModelTable
                  title="模型列表"
                  models={filteredModels}
                  totalCount={allModels.length}
                  onOpenPath={openInFolder}
                  onSearchModel={handleSearchModel}
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
              {displayName?.typeLabel && (
                <span className="shrink-0 rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                  {displayName.typeLabel}
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
  const visibleStats = stats.slice(0, 8);
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
        {/* 柱状图只展示前 8 类，避免模型类型过多时标签拥挤；完整明细仍由模型列表筛选承载。 */}
        <ColumnChart items={chartItems} emptyText="暂无类型分布数据" />
      </div>
    </div>
  );
}

function ModelListFilters({
  sources,
  typeOptions,
  platformFilter,
  typeFilter,
  sortMode,
  onPlatformChange,
  onTypeChange,
  onSortChange,
}: {
  sources: AiAssetSource[];
  typeOptions: string[];
  platformFilter: string;
  typeFilter: string;
  sortMode: AiModelSortMode;
  onPlatformChange: (value: string) => void;
  onTypeChange: (value: string) => void;
  onSortChange: (value: AiModelSortMode) => void;
}) {
  const platformOptions: SelectOption[] = [
    { value: 'all', label: '全部平台' },
    ...sources.map(source => ({ value: source.name, label: source.name })),
  ];
  const typeSelectOptions: SelectOption[] = [
    { value: 'all', label: '全部类型' },
    ...typeOptions.map(type => ({ value: type, label: type })),
  ];
  const sortOptions: SelectOption<AiModelSortMode>[] = [
    { value: 'size-desc', label: '按大小降序' },
    { value: 'name-asc', label: '按名称升序' },
    { value: 'platform-asc', label: '按平台升序' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
      <FilterField label="平台">
        <Select value={platformFilter} options={platformOptions} onChange={onPlatformChange} widthClass="w-36" size="sm" />
      </FilterField>

      <FilterField label="类型">
        <Select value={typeFilter} options={typeSelectOptions} onChange={onTypeChange} widthClass="w-36" size="sm" />
      </FilterField>

      <FilterField label="排序">
        <Select value={sortMode} options={sortOptions} onChange={onSortChange} widthClass="w-32" size="sm" />
      </FilterField>
    </div>
  );
}

function FilterField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <span>{label}</span>
      {children}
    </div>
  );
}

function ModelTable({
  title,
  models,
  totalCount,
  compact = false,
  onOpenPath,
  onSearchModel,
}: {
  title: string;
  models: FlattenedModel[];
  totalCount?: number;
  compact?: boolean;
  onOpenPath: (path: string) => Promise<void>;
  onSearchModel: (modelName: string) => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
        <p className="text-xs text-[var(--text-muted)]">
          {models.length.toLocaleString()} / {(totalCount ?? models.length).toLocaleString()} 项
        </p>
      </div>
      <div className="divide-y divide-[var(--border-color)]">
        {models.map(model => {
          const displayName = splitDisplayModelName(model.name);

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
                    {displayName.typeLabel && <TypeTag label={displayName.typeLabel} />}
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
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

function IconButton({ title, icon, onClick }: { title: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="rounded-lg p-2 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--brand-green)] transition"
    >
      {icon}
    </button>
  );
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
  sortMode: AiModelSortMode
): FlattenedModel[] {
  const filteredModels = models.filter(model => {
    const modelType = getModelType(model);
    return (platformFilter === 'all' || model.sourceName === platformFilter)
      && (typeFilter === 'all' || modelType === typeFilter);
  });

  return [...filteredModels].sort((left, right) => {
    if (sortMode === 'name-asc') {
      return splitDisplayModelName(left.name).title.localeCompare(splitDisplayModelName(right.name).title);
    }
    if (sortMode === 'platform-asc') {
      return left.sourceName.localeCompare(right.sourceName) || right.size - left.size;
    }
    return right.size - left.size;
  });
}

function getModelTypeOptions(models: FlattenedModel[]): string[] {
  return Array.from(new Set(models.map(getModelType))).sort((left, right) => left.localeCompare(right));
}

function getModelTypeStats(models: FlattenedModel[]): Array<{ type: string; count: number; size: number }> {
  const stats = new Map<string, { type: string; count: number; size: number }>();

  for (const model of models) {
    const type = getModelType(model);
    const current = stats.get(type) ?? { type, count: 0, size: 0 };
    current.count += 1;
    current.size += model.size;
    stats.set(type, current);
  }

  return Array.from(stats.values()).sort((left, right) => right.size - left.size);
}

function getModelType(model: AiModelItem): string {
  const typeLabel = splitDisplayModelName(model.name).typeLabel;
  if (typeLabel) return typeLabel;

  const extension = model.path.split('.').pop()?.trim().toLowerCase();
  // MFT 兜底可能没有平台类型标签，此时扩展名比“未知”更利于筛选和统计。
  return extension ? `.${extension}` : '未知类型';
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
