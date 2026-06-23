import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BrainCircuit,
  Clipboard,
  FolderOpen,
  Gauge,
  Loader2,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ModuleCard } from '../ModuleCard';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import {
  openInFolder,
  pickFolderDialog,
  scanAiModelAssets,
  type AiAssetSource,
  type AiModelItem,
  type AiModelScanResult,
} from '../../api/commands';
import { formatSize } from '../../utils/format';

const CUSTOM_PATHS_STORAGE_KEY = 'lightc.aiModels.customPaths';
const LARGE_MODEL_THRESHOLD = 20 * 1024 * 1024 * 1024;
const TOP_MODEL_LIMIT = 8;

type AiModelViewMode = 'overview' | 'models' | 'platforms';

interface FlattenedModel extends AiModelItem {
  sourceName: string;
}

export function AiModelsModule({ layoutMode = 'cards' }: { layoutMode?: 'cards' | 'pages' }) {
  const { modules, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.aiModels;
  const { showToast } = useToast();

  const scanningRef = useRef(false);
  const lastScanTriggerRef = useRef(0);

  const [scanResult, setScanResult] = useState<AiModelScanResult | null>(null);
  const [customPaths, setCustomPaths] = useState<string[]>(() => loadCustomPaths());
  const [viewMode, setViewMode] = useState<AiModelViewMode>('overview');
  const [selectedSourceName, setSelectedSourceName] = useState<string | null>(null);

  const allModels = useMemo(() => flattenModels(scanResult), [scanResult]);
  const largestModel = allModels[0] ?? null;
  const largestSource = scanResult?.sources[0] ?? null;
  const largeModelCount = useMemo(
    () => allModels.filter(model => model.size >= LARGE_MODEL_THRESHOLD).length,
    [allModels]
  );
  const selectedSource = useMemo(
    () => scanResult?.sources.find(source => source.name === selectedSourceName) ?? scanResult?.sources[0] ?? null,
    [scanResult, selectedSourceName]
  );

  useEffect(() => {
    localStorage.setItem(CUSTOM_PATHS_STORAGE_KEY, JSON.stringify(customPaths));
  }, [customPaths]);

  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;

    scanningRef.current = true;
    updateModuleState('aiModels', { status: 'scanning', error: null });
    setExpandedModule('aiModels');

    try {
      const result = await scanAiModelAssets(customPaths);
      setScanResult(result);
      setSelectedSourceName(result.sources[0]?.name ?? null);
      updateModuleState('aiModels', {
        status: 'done',
        fileCount: result.total_model_count,
        totalSize: result.total_size,
      });

      if (result.total_model_count === 0) {
        showToast({
          type: 'info',
          title: '未发现 AI 资产',
          description: '可添加 Ollama、LM Studio、ComfyUI 或模型目录后重新分析。',
        });
      }
    } catch (error) {
      updateModuleState('aiModels', { status: 'error', error: String(error) });
      showToast({ type: 'error', title: 'AI资产分析失败', description: String(error) });
    } finally {
      scanningRef.current = false;
    }
  }, [customPaths, setExpandedModule, showToast, updateModuleState]);

  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [handleScan, oneClickScanTrigger]);

  const handleAddCustomPath = useCallback(async () => {
    try {
      const selectedPath = await pickFolderDialog();
      if (!selectedPath) return;

      setCustomPaths(prev => {
        if (prev.some(path => path.toLowerCase() === selectedPath.toLowerCase())) {
          return prev;
        }
        return [...prev, selectedPath];
      });
    } catch (error) {
      showToast({ type: 'error', title: '添加目录失败', description: String(error) });
    }
  }, [showToast]);

  const handleRemoveCustomPath = useCallback((pathToRemove: string) => {
    setCustomPaths(prev => prev.filter(path => path !== pathToRemove));
  }, []);

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      showToast({ type: 'success', title: '路径已复制' });
    } catch (error) {
      showToast({ type: 'error', title: '复制失败', description: String(error) });
    }
  }, [showToast]);

  const isExpanded = expandedModule === 'aiModels';
  const isScanning = moduleState.status === 'scanning';

  return (
    <ModuleCard
      variant={layoutMode === 'pages' ? 'page' : 'card'}
      forceExpanded={layoutMode === 'pages'}
      id="aiModels"
      title="AI资产分析"
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
        <button
          onClick={(event) => {
            event.stopPropagation();
            handleAddCustomPath();
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-hover)] text-[var(--fg-secondary)] hover:text-[var(--brand-green)] transition"
        >
          <Plus className="w-3.5 h-3.5" />
          添加目录
        </button>
      }
    >
      <div className="p-5 space-y-5">
        {customPaths.length > 0 && (
          <CustomPathList paths={customPaths} onRemove={handleRemoveCustomPath} />
        )}

        {moduleState.status === 'idle' && !scanResult && (
          <EmptyState
            icon={BrainCircuit}
            title="尚未分析 AI 资产"
            description="点击开始分析，快速检测 Ollama、LM Studio、ComfyUI、HuggingFace 和自定义模型目录。"
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
            <p className="text-sm font-semibold text-[var(--text-primary)]">正在快速检测 AI 资产...</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              只扫描已知平台目录和你添加的目录，不会启动全盘扫描。
            </p>
          </div>
        )}

        {scanResult && !isScanning && (
          <>
            <HeroOverview
              scanResult={scanResult}
              largestModel={largestModel}
              onOpenPath={openInFolder}
              onCopyPath={handleCopyPath}
            />

            <InsightsRow
              scanResult={scanResult}
              largestSource={largestSource}
              largeModelCount={largeModelCount}
            />

            <ViewModeTabs value={viewMode} onChange={setViewMode} />

            {viewMode === 'overview' && (
              <>
                <ModelTable
                  title="最大模型"
                  models={allModels.slice(0, TOP_MODEL_LIMIT)}
                  onOpenPath={openInFolder}
                  onCopyPath={handleCopyPath}
                />
                <PlatformRanking sources={scanResult.sources} onSelectSource={setSelectedSourceName} />
              </>
            )}

            {viewMode === 'models' && (
              <ModelTable
                title="全部模型"
                models={allModels}
                onOpenPath={openInFolder}
                onCopyPath={handleCopyPath}
              />
            )}

            {viewMode === 'platforms' && (
              <PlatformDetail
                sources={scanResult.sources}
                selectedSource={selectedSource}
                onSelectSource={setSelectedSourceName}
                onOpenPath={openInFolder}
                onCopyPath={handleCopyPath}
              />
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

function HeroOverview({
  scanResult,
  largestModel,
  onOpenPath,
  onCopyPath,
}: {
  scanResult: AiModelScanResult;
  largestModel: FlattenedModel | null;
  onOpenPath: (path: string) => Promise<void>;
  onCopyPath: (path: string) => Promise<void>;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-5">
        <p className="text-xs font-semibold text-[var(--text-muted)]">AI资产总占用</p>
        <p className="mt-2 text-4xl font-bold tabular-nums text-[var(--brand-green)]">
          {formatSize(scanResult.total_size)}
        </p>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          发现 {scanResult.total_model_count.toLocaleString()} 个资产 · {scanResult.source_count} 个来源 · {scanResult.scan_duration_ms}ms
        </p>
      </div>

      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--text-muted)]">最大模型</p>
            <p className="mt-2 truncate text-2xl font-bold text-[var(--text-primary)]" title={largestModel?.name}>
              {largestModel?.name ?? '未发现模型'}
            </p>
            <p className="mt-1 text-sm font-semibold text-[var(--brand-green)]">
              {largestModel ? `${formatSize(largestModel.size)} · ${largestModel.sourceName}` : '添加目录后重新分析'}
            </p>
            {largestModel && (
              <p className="mt-2 truncate text-xs text-[var(--text-muted)]" title={largestModel.path}>
                {largestModel.path}
              </p>
            )}
          </div>
          {largestModel && (
            <div className="flex shrink-0 items-center gap-1">
              <IconButton title="打开目录" onClick={() => onOpenPath(largestModel.path)} icon={<FolderOpen className="w-4 h-4" />} />
              <IconButton title="复制路径" onClick={() => onCopyPath(largestModel.path)} icon={<Clipboard className="w-4 h-4" />} />
            </div>
          )}
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
    { value: 'models', label: '模型视图' },
    { value: 'platforms', label: '平台视图' },
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

function ModelTable({
  title,
  models,
  onOpenPath,
  onCopyPath,
}: {
  title: string;
  models: FlattenedModel[];
  onOpenPath: (path: string) => Promise<void>;
  onCopyPath: (path: string) => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
        <p className="text-xs text-[var(--text-muted)]">{models.length.toLocaleString()} 项</p>
      </div>
      <div className="divide-y divide-[var(--border-color)]">
        {models.map(model => (
          <div key={`${model.sourceName}-${model.path}-${model.name}`} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--bg-hover)] transition">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--brand-green)]/10">
                <BrainCircuit className="h-4 w-4 text-[var(--brand-green)]" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-[var(--text-primary)]" title={model.name}>{model.name}</p>
                  <span className="shrink-0 rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
                    {model.sourceName}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]" title={model.path}>{model.path}</p>
              </div>
            </div>
            <p className="w-24 shrink-0 text-right text-sm font-bold tabular-nums text-[var(--brand-green)]">
              {formatSize(model.size)}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton title="打开目录" onClick={() => onOpenPath(model.path)} icon={<FolderOpen className="w-4 h-4" />} />
              <IconButton title="复制路径" onClick={() => onCopyPath(model.path)} icon={<Clipboard className="w-4 h-4" />} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformRanking({ sources, onSelectSource }: { sources: AiAssetSource[]; onSelectSource: (name: string) => void }) {
  const maxSize = Math.max(...sources.map(source => source.total_size), 1);

  return (
    <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <p className="mb-3 text-sm font-semibold text-[var(--text-primary)]">平台占用</p>
      <div className="space-y-3">
        {sources.map(source => (
          <button
            key={source.name}
            onClick={() => onSelectSource(source.name)}
            className="block w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-3 text-left hover:border-[var(--brand-green)]/30 transition"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--text-primary)]">{source.name}</p>
                <p className="text-xs text-[var(--text-muted)]">{source.model_count.toLocaleString()} 个资产</p>
              </div>
              <p className="text-sm font-bold text-[var(--brand-green)]">{formatSize(source.total_size)}</p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
              <div
                className="h-full rounded-full bg-[var(--brand-green)]"
                style={{ width: `${Math.max(4, (source.total_size / maxSize) * 100)}%` }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlatformDetail({
  sources,
  selectedSource,
  onSelectSource,
  onOpenPath,
  onCopyPath,
}: {
  sources: AiAssetSource[];
  selectedSource: AiAssetSource | null;
  onSelectSource: (name: string) => void;
  onOpenPath: (path: string) => Promise<void>;
  onCopyPath: (path: string) => Promise<void>;
}) {
  if (!selectedSource) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="space-y-2">
        {sources.map(source => (
          <button
            key={source.name}
            onClick={() => onSelectSource(source.name)}
            className={`w-full rounded-xl border p-3 text-left transition ${
              selectedSource.name === source.name
                ? 'border-[var(--brand-green)] bg-[var(--brand-green)]/10'
                : 'border-[var(--border-color)] bg-[var(--bg-main)] hover:border-[var(--brand-green)]/30'
            }`}
          >
            <p className="text-sm font-semibold text-[var(--text-primary)]">{source.name}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{formatSize(source.total_size)} · {source.model_count} 项</p>
          </button>
        ))}
      </div>
      <div className="space-y-3">
        <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-lg font-bold text-[var(--text-primary)]">{selectedSource.name}</p>
              <p className="mt-1 text-sm text-[var(--brand-green)]">{formatSize(selectedSource.total_size)} · {selectedSource.model_count} 项</p>
              <p className="mt-2 truncate text-xs text-[var(--text-muted)]" title={selectedSource.path}>{selectedSource.path}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton title="打开平台目录" onClick={() => onOpenPath(selectedSource.path)} icon={<FolderOpen className="w-4 h-4" />} />
              <IconButton title="复制平台路径" onClick={() => onCopyPath(selectedSource.path)} icon={<Clipboard className="w-4 h-4" />} />
            </div>
          </div>
        </div>
        <ModelTable
          title={`${selectedSource.name} 模型`}
          models={selectedSource.models.map(model => ({ ...model, sourceName: selectedSource.name }))}
          onOpenPath={onOpenPath}
          onCopyPath={onCopyPath}
        />
      </div>
    </div>
  );
}

function CustomPathList({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {paths.map(path => (
        <span key={path} className="inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
          <span className="truncate">{path}</span>
          <button onClick={() => onRemove(path)} className="shrink-0 hover:text-rose-500 transition" title="移除目录">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
    </div>
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

function loadCustomPaths(): string[] {
  try {
    const rawValue = localStorage.getItem(CUSTOM_PATHS_STORAGE_KEY);
    if (!rawValue) return [];
    const parsedValue = JSON.parse(rawValue);

    // 本地存储属于外部输入，读取时校验数组元素，避免脏数据让模块初始化失败。
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue.filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
  } catch {
    return [];
  }
}

export default AiModelsModule;
