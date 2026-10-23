import { useAiModuleBridge } from '../ai/useAiModuleBridge';
import { AiAskButton } from '../ai/AiAskButton';
import { buildItemQuestion } from '../ai/aiQuestions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
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
import { ModuleScanProgress } from '../ModuleScanProgress';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { useToast } from '../Toast';
import { DonutChart, ColumnChart, CHART_PALETTE, type ChartItem } from '../ui/charts';
import { Select, type SelectOption } from '../ui/Select';
import { Switch } from '../ui/Switch';
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

/**
 * 取当前扫描阶段的标题。
 *
 * 阶段文案统一放在 i18n 的 scanStages 下，MFT 阶段需要盘符插值；
 * 后端同时下发盘符和中文兜底文案，i18n 缺键时回退到后端文案，避免出现 {{drive}} 这类未替换占位符。
 */
function getScanStageLabel(progress: AiModelScanProgress | null, enableDeepDiscovery: boolean): string {
  if (!progress) {
    return i18n.t(enableDeepDiscovery ? 'scanStages.aiDeep' : 'scanStages.aiQuick', { ns: 'common' });
  }

  return i18n.t(`scanStages.${progress.stage}`, {
    ns: 'common',
    drive: progress.drive_label ?? '',
    defaultValue: progress.message || i18n.t('scanStages.scanning', { ns: 'common' }),
  });
}

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
  const { t: navT } = useTranslation('nav');
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const { moduleState, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useModuleDashboard('aiModels');
  const { showToast } = useToast();

  const scanningRef = useRef(false);
  const lastScanTriggerRef = useRef(0);

  const [scanResult, setScanResult] = useState<AiModelScanResult | null>(null);
  // 接入 AI 助手（**只读**：这里只统计占用，不提供删除动作）。
  useAiModuleBridge('ai-models', {
    // 只读读取：**模型文件列表**（与界面上那一列一致），不是"来源"列表。
    //
    // ⚠️ 这里踩过一次：原来返回的是 `scanResult.sources`（目录级），于是用户问
    // "某个 .safetensors 是干什么的、占这么大正常吗"，模型只拿到
    // 「D:\…\models 58.75 GB（8 个模型）」这种目录级信息，**只能凭文件名猜** ✗
    // 而界面上本来就是"一列模型文件" —— 接口和界面对不上，模型当然答不准。
    readItems: (targetId, offset, limit) => {
      const all = flattenModels(scanResult);
      // targetId 可以是来源名，也可以是来源路径：模型看到的摘要里写的是路径，
      // 它据此写回来的大概率也是路径。
      const wanted = targetId.trim();
      const models = wanted
        ? all.filter((model) => model.sourceName === wanted || model.path.startsWith(wanted))
        : all;
      if (models.length === 0) {
        // ⚠️ 这里**不要**返回 null：公共层只会说一句"没有读到内容"，
        // 而"还没扫描"和"没匹配到"是两件完全不同的排查方向。
        // 返回一条说明，模型就能把原因直接讲给用户，而不是自己猜一个理由。
        return {
          total: 0,
          lines: [
            all.length === 0
              ? '（当前还没有扫描结果 —— 请先点一次「开始扫描」，再问这个问题）'
              : `（没有匹配「${wanted}」的模型；本次扫描共 ${all.length} 个模型，不带参数即可读全部）`,
          ],
        };
      }
      return {
        total: models.length,
        lines: models
          .slice(offset, offset + limit)
          .map((model) => `${model.path}  ${formatSize(model.size)}  （来源：${model.sourceName}）`),
      };
    },
    // 只读：单条详情。itemId 通常是上面每行行首那段完整路径，
    // 但模型手上也可能只有**文件名**（用户问句里就是文件名，甚至被界面截断过）——
    // 所以匹配要宽容，否则它会拿到一句"没读到"然后只能靠名字猜（实测踩过）。
    readItemDetail: (itemId) => {
      const wanted = itemId.trim();
      if (!wanted) return null;
      // `\\?\` 这类前缀在不同来源里有的带有的不带，比对前先抹掉
      const normalize = (value: string) => value.trim().replace(/^\\\\\?\\/, '');
      // 只取文件名再去掉扩展名：界面上的标题是**截短过的**（没有 .safetensors），
      // 快捷提问带过来的就是那个短名字，只按完整路径/文件名比会全部落空。
      const stem = (value: string) => {
        const base = normalize(value).split(/[\\/]/).pop() ?? '';
        return base.replace(/\.[^.]+$/, '');
      };
      const target = normalize(wanted);
      const models = flattenModels(scanResult);
      const index = models.findIndex((model) => {
        const modelPath = normalize(model.path);
        return (
          modelPath === target ||
          model.name === wanted ||
          modelPath.endsWith(`\\${wanted}`) ||
          modelPath.endsWith(`/${wanted}`) ||
          (target.length > 3 && stem(model.path) === stem(target))
        );
      });
      if (index < 0) return null;
      const model = models[index];
      const source = scanResult?.sources.find((item) => item.name === model.sourceName);
      return [
        `名称：${model.name}`,
        `路径：${model.path}`,
        `大小：${formatSize(model.size)}`,
        `来源：${model.sourceName}` +
          (source ? `（该来源共 ${source.model_count} 个模型、合计 ${formatSize(source.total_size)}）` : ''),
        `类型判断：${getModelType(model)}`,
        `在本次扫描的 ${models.length} 个模型里，按大小排第 ${index + 1} 位`,
      ].join('\n');
    },
    summary: () => {
      if (!scanResult) return null;
      return [
        `共 ${scanResult.total_model_count} 个模型文件，合计 ${formatSize(scanResult.total_size)}，`,
        `来自 ${scanResult.source_count} 个位置。`,
        scanResult.warnings.length > 0 ? `注意：${scanResult.warnings.slice(0, 3).join('；')}` : '',
      ].filter(Boolean).join('');
    },
  });

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
          title: moduleT('aiModels.notFound'),
          description: moduleT('aiModels.notFoundDesc'),
        });
      }
    } catch (error) {
      updateModuleState('aiModels', { status: 'error', error: String(error) });
      showToast({ type: 'error', title: moduleT('aiModels.analysisFailed'), description: String(error) });
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
      showToast({ type: 'error', title: moduleT('aiModels.openSearchFailed'), description: String(error) });
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
          title: moduleT('aiModels.deleteIncomplete'),
          description: reason || result.summary_message || moduleT('aiModels.notDeleted'),
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
        title: moduleT('aiModels.deleted'),
        description: `${model.name} · ${moduleT('aiModels.released', { size: formatSize(detail.logical_size) })}`,
      });
    } catch (error) {
      showToast({ type: 'error', title: moduleT('aiModels.deleteFailed'), description: String(error) });
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
        title={navT('aiModels')}
        description={navT('aiModelsDesc')}
      icon={<BrainCircuit className="w-6 h-6 text-[var(--brand-green)]" />}
      status={moduleState.status}
      fileCount={moduleState.fileCount}
      totalSize={moduleState.totalSize}
      doneBadgeText={moduleT('aiModels.found')}
      emptyDoneBadgeText={moduleT('aiModels.notFoundBadge')}
      countLabel={moduleT('aiModels.assetCount')}
      expanded={isExpanded}
      onToggleExpand={() => setExpandedModule(isExpanded ? null : 'aiModels')}
      onScan={handleScan}
      scanButtonText={isScanning ? moduleT('aiModels.analyzing') : scanResult ? moduleT('aiModels.reanalyze') : moduleT('aiModels.start')}
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
            title={moduleT('aiModels.idle')}
            description={moduleT('aiModels.idleDesc')}
            action={
              <button
                onClick={handleScan}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--brand-green)] text-white text-sm font-semibold hover:bg-[var(--brand-green-hover)] transition"
              >
                <Search className="w-4 h-4" />
                {moduleT('aiModels.start')}
              </button>
            }
          />
        )}

        {isScanning && (
          <ModuleScanProgress
            title={getScanStageLabel(scanProgress, enableDeepDiscovery)}
            description={scanProgress
              ? i18n.t('scanStages.elapsedSummary', {
                ns: 'common',
                stage: formatDuration(scanProgress.stage_elapsed_ms),
                total: formatDuration(scanProgress.elapsed_ms),
              })
              : enableDeepDiscovery
              ? i18n.t('scanStages.aiDeepDesc', { ns: 'common' })
              : i18n.t('scanStages.aiQuickDesc', { ns: 'common' })}
            icon={<Loader2 className="h-7 w-7 animate-spin text-[var(--brand-green)]" />}
          />
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
                  title={moduleT('aiModels.modelList')}
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
                <p className="text-xs font-semibold text-amber-600">{moduleT('aiModels.partialFailure')}</p>
                <div className="mt-1 space-y-1">
                  {scanResult.warnings.slice(0, 3).map(warning => (
                    <p key={warning} className="text-[0.79rem] leading-relaxed text-amber-700">{warning}</p>
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
        title={moduleT('aiModels.confirmDelete')}
        description={modelPendingDeletion
          ? moduleT('aiModels.confirmDeleteDesc', { name: modelPendingDeletion.name, size: formatSize(modelPendingDeletion.size) })
          : ''}
        warning={modelPendingDeletion
          ? moduleT('aiModels.confirmDeletePath', { path: modelPendingDeletion.path })
          : undefined}
        confirmText={moduleT('aiModels.confirmDeleteButton')}
        cancelText={t('cancel')}
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
  const { t: moduleT } = useTranslation('modules');
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-[var(--bg-hover)] px-3 py-1.5"
      title={moduleT('aiModels.deepDiscoveryTip')}
    >
      <span className="text-xs font-medium text-[var(--fg-secondary)]">{moduleT('aiModels.deepDiscovery')}</span>
      {/* 改用共享的 ui/Switch：全项目开关只保留一份实现，
          否则散落在各模块里的自绘开关会漏掉主题适配（玻璃态就踩过这个坑） */}
      <Switch
        checked={enabled}
        disabled={disabled}
        onChange={onChange}
        aria-label={moduleT('aiModels.deepDiscovery')}
      />
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
  const { t } = useTranslation('common');
  const { t: moduleT } = useTranslation('modules');
  const displayName = largestModel ? splitDisplayModelName(largestModel.name) : null;
  const largestModelType = largestModel ? getModelType(largestModel) : null;

  return (
    <div className="glass-block rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="grid grid-cols-[190px_minmax(0,1fr)] items-center gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold text-[var(--text-muted)]">{moduleT('aiModels.totalUsage')}</p>
            <ScanDurationPopover scanResult={scanResult} />
          </div>
          <p className="mt-1 text-3xl font-bold tabular-nums text-[var(--brand-green)]">
            {formatSize(scanResult.total_size)}
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {moduleT('aiModels.discoverySummary', { models: scanResult.total_model_count.toLocaleString(), sources: scanResult.source_count, mode: scanResult.discovery_mode === 'deep' ? moduleT('aiModels.deepDiscovery') : t('scan') })}
          </p>
        </div>

        <div className="flex min-w-0 items-start justify-between gap-4 border-l border-[var(--border-color)] pl-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--text-muted)]">{moduleT('aiModels.largestModel')}</p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate text-xl font-bold text-[var(--text-primary)]" title={largestModel?.path ?? largestModel?.name}>
                {displayName?.title ?? moduleT('aiModels.notFoundModel')}
              </p>
              {largestModelType && (
                <span className="shrink-0 rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[0.71rem] font-medium text-[var(--text-muted)]">
                  {largestModelType === '__unknown__' ? moduleT('aiModels.unknownType') : largestModelType}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm font-semibold text-[var(--brand-green)]">
              {largestModel ? `${formatSize(largestModel.size)} · ${largestModel.sourceName}` : moduleT('aiModels.reanalyzeDeep')}
            </p>
            {largestModel && (
              <p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={largestModel.path}>
                {largestModel.path}
              </p>
            )}
          </div>
          {largestModel && (
            <div className="flex shrink-0 items-center gap-1">
              <IconButton title={t('openInFolder')} onClick={() => onOpenPath(largestModel.path)} icon={<FolderOpen className="w-4 h-4" />} />
              <IconButton title={moduleT('aiModels.search')} onClick={() => onSearchModel(largestModel.name)} icon={<Search className="w-4 h-4" />} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScanDurationPopover({ scanResult }: { scanResult: AiModelScanResult }) {
  const { t: moduleT } = useTranslation('modules');
  if (scanResult.phase_durations.length === 0) return null;

  return (
    <div className="group relative inline-flex">
      <button
        type="button"
        className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[0.71rem] font-medium text-[var(--text-muted)] hover:text-[var(--brand-green)] transition"
      >
        {moduleT('aiModels.scanDuration')} {formatDuration(scanResult.scan_duration_ms)}
      </button>
      <div className="pointer-events-none absolute left-0 top-full z-20 w-[30.0rem] pt-1 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
        <div className="glass-overlay rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-3 shadow-lg">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-[var(--text-primary)]">{moduleT('aiModels.scanDuration')}</p>
            <p className="text-xs text-[var(--text-muted)]">{moduleT('aiModels.total')} {formatDuration(scanResult.scan_duration_ms)}</p>
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
  const { t: moduleT } = useTranslation('modules');
  const insights = [
    { label: moduleT('aiModels.foundModels'), value: `${scanResult.total_model_count.toLocaleString()}`, icon: Sparkles },
    { label: moduleT('aiModels.largestPlatform'), value: largestSource ? `${largestSource.name} · ${formatSize(largestSource.total_size)}` : moduleT('aiModels.noData'), icon: BarChart3 },
    { label: moduleT('aiModels.over20GB'), value: `${largeModelCount}`, icon: Gauge },
  ];

  return (
    // glass-metrics / glass-metric / glass-metric-icon 是给液态玻璃外观预留的语义钩子：
    // 这三个类在关闭玻璃时没有任何样式，原始布局与配色完全不变（见 App.css 的 .glass 分区）。
    <div className="glass-metrics grid gap-3 md:grid-cols-3">
      {insights.map(insight => {
        const Icon = insight.icon;
        return (
          <div key={insight.label} className="glass-metric rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-4">
            <div className="flex items-center gap-3">
              <span className="glass-metric-icon flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-green)]/10 text-[var(--brand-green)]">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[0.79rem] text-[var(--text-muted)]">{insight.label}</p>
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
  const { t: moduleT } = useTranslation('modules');
  const tabs: Array<{ value: AiModelViewMode; label: string }> = [
    { value: 'overview', label: moduleT('aiModels.overview') },
    { value: 'models', label: moduleT('aiModels.models') },
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
  const { t: moduleT } = useTranslation('modules');
  const modelTypeStats = getModelTypeStats(models);
  const uncategorizedSource = scanResult.sources.find(source => source.name === '未归类' || source.name === '__uncategorized__');

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
      <PlatformUsageChart sources={scanResult.sources} />
      <ModelTypeChart stats={modelTypeStats} />

      {uncategorizedSource && (
        <div className="xl:col-span-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
          <p className="text-xs font-semibold text-amber-700">{moduleT('aiModels.uncategorizedTitle')}</p>
          <p className="mt-1 text-xs text-amber-700">
            {moduleT('aiModels.uncategorizedDesc', { count: uncategorizedSource.model_count.toLocaleString(), size: formatSize(uncategorizedSource.total_size) })}
          </p>
        </div>
      )}
    </div>
  );
}

function PlatformUsageChart({ sources }: { sources: AiAssetSource[] }) {
  const { t: moduleT } = useTranslation('modules');
  const totalSize = sources.reduce((sum, source) => sum + source.total_size, 0);
  const chartItems: ChartItem[] = sources.map((source, index) => {
    const percent = totalSize > 0 ? (source.total_size / totalSize) * 100 : 0;
    return {
      id: source.name,
      label: source.name,
      value: source.total_size,
      valueLabel: formatSize(source.total_size),
      percentLabel: `${percent.toFixed(1)}%`,
      secondaryLabel: moduleT('aiModels.modelCount', { count: source.model_count.toLocaleString() }),
      color: CHART_PALETTE[index % CHART_PALETTE.length],
    };
  });

  return (
    <div className="glass-block rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{moduleT('aiModels.platformUsage')}</p>
        <p className="text-xs text-[var(--text-muted)]">{moduleT('aiModels.sourceCount', { count: sources.length.toLocaleString() })}</p>
      </div>

      <div className="mt-4">
        <DonutChart
          items={chartItems}
          totalLabel={moduleT('aiModels.totalUsage')}
          totalValueLabel={formatSize(totalSize)}
          emptyText={moduleT('aiModels.noData')}
        />
      </div>
    </div>
  );
}

function ModelTypeChart({ stats }: { stats: Array<{ type: string; count: number; size: number }> }) {
  const { t: moduleT } = useTranslation('modules');
  const visibleStats = getVisibleModelTypeStats(stats);
  const chartItems: ChartItem[] = visibleStats.map((item, index) => ({
    id: item.type,
    label: item.type,
    value: item.size,
    valueLabel: formatSize(item.size),
    secondaryLabel: moduleT('aiModels.modelCount', { count: item.count.toLocaleString() }),
    color: CHART_PALETTE[index % CHART_PALETTE.length],
  }));

  return (
    <div className="glass-block rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{moduleT('aiModels.typeDistribution')}</p>
        <p className="text-xs text-[var(--text-muted)]">{moduleT('aiModels.typeCount', { count: stats.length.toLocaleString() })}</p>
      </div>

      <div className="mt-4">
        {/* 柱状图保留 8 个展示位，超出的类别汇总到“其他类型”，避免图表拥挤同时不丢总量。 */}
        <ColumnChart items={chartItems} emptyText={moduleT('aiModels.noData')} />
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
    { type: '__other__', count: 0, size: 0 }
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
  const { t: moduleT } = useTranslation('modules');
  const platformOptions: SelectOption[] = [
    { value: 'all', label: moduleT('aiModels.allPlatforms') },
    ...sources.map(source => ({ value: source.name, label: source.name })),
  ];
  const typeSelectOptions: SelectOption[] = [
    { value: 'all', label: moduleT('aiModels.allTypes') },
    ...typeOptions.map(type => ({ value: type, label: type === '__unknown__' ? moduleT('aiModels.unknownType') : type })),
  ];
  return (
    <div className="glass-block flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] p-3">
      <FilterField label={moduleT('aiModels.platform') }>
        <Select value={platformFilter} options={platformOptions} onChange={onPlatformChange} widthClass="w-36" size="sm" />
      </FilterField>

      <FilterField label={moduleT('aiModels.type')}>
        <Select value={typeFilter} options={typeSelectOptions} onChange={onTypeChange} widthClass="w-36" size="sm" />
      </FilterField>

      <FilterField label={moduleT('aiModels.search')} className="min-w-[20.0rem] flex-1">
        <div className="relative w-full min-w-[12.86rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={modelKeyword}
            onChange={event => onKeywordChange(event.target.value)}
            placeholder={moduleT('aiModels.searchPlaceholder')}
            className="h-8 w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-card)] pl-8 pr-8 text-xs text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--brand-green)] focus:ring-2 focus:ring-[var(--brand-green)]/20"
          />
          {modelKeyword.trim().length > 0 && (
            <button
              type="button"
              onClick={onKeywordClear}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              aria-label={moduleT('aiModels.clearSearch')}
              title={moduleT('aiModels.clearSearch')}
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
  const { t: moduleT } = useTranslation('modules');
  return (
    <div className="glass-list overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-color)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
          <p className="text-xs text-[var(--text-muted)]">
            {moduleT('aiModels.itemCount', { current: models.length.toLocaleString(), total: (totalCount ?? models.length).toLocaleString() })}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <SortHeaderButton
            label={moduleT('aiModels.name')}
            activeAscMode="name-asc"
            activeDescMode="name-desc"
            sortMode={sortMode}
            onSortChange={onSortChange}
          />
          <SortHeaderButton
            label={moduleT('aiModels.size')}
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
                <IconButton title={moduleT('aiModels.openFolder')} onClick={() => onOpenPath(model.path)} icon={<FolderOpen className="w-4 h-4" />} />
                <IconButton title={moduleT('aiModels.searchModel')} onClick={() => onSearchModel(model.name)} icon={<Search className="w-4 h-4" />} />
                {/* 快捷提问：模型文件单独一套问法，用户真正关心的是"占这么大正常吗"。
                    ⚠️ 传**路径**而不是界面上那个被截短的显示名 —— 问句里的目标要能被
                    `read_items` / `read_item_detail` 逐字对上，否则模型照抄回来只会得到"没读到"。
                    其余三个带快捷提问的模块（大文件 / 磁盘变化 / 大目录）传的都是路径，这里对齐。 */}
                <AiAskButton
                  question={buildItemQuestion(model.path, 'model')}
                  className="inline-flex h-7 w-7 items-center justify-center"
                />
                <IconButton
                  title={moduleT('aiModels.deleteModel')}
                  onClick={() => onDeleteModel(model)}
                  disabled={deletingModelPath !== null}
                  icon={deletingModelPath === model.path
                    ? <Loader2 className="h-4 w-4 animate-spin text-[var(--color-danger)]" />
                    : <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />}
                />
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
  const { t: moduleT } = useTranslation('modules');
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
      title={moduleT('aiModels.sort', { label, direction: sortMode === activeDescMode ? moduleT('aiModels.ascending') : moduleT('aiModels.descending') })}
    >
      <span>{moduleT('aiModels.sortBy', { label })}</span>
      {/* 只在当前排序列展示方向，避免两个按钮同时出现箭头造成误读。 */}
      {isActive && <DirectionIcon className="h-3 w-3" />}
    </button>
  );
}

function SourceTag({ sourceName }: { sourceName: string }) {
  const { t: moduleT } = useTranslation('modules');
  const isUncategorized = sourceName === '未归类' || sourceName === '__uncategorized__';

  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[0.71rem] font-semibold ${
        isUncategorized
          ? 'border border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] text-[var(--color-warning)]'
          : 'bg-[var(--brand-green)] text-white'
      }`}
    >
      {isUncategorized ? moduleT('aiModels.uncategorized') : sourceName}
    </span>
  );
}

function TypeTag({ label }: { label: string }) {
  const { t: moduleT } = useTranslation('modules');
  return (
    <span className="shrink-0 rounded-full border border-[var(--border-color)] bg-transparent px-2 py-0.5 text-[0.71rem] font-medium text-[var(--text-muted)]">
      {label === '__unknown__' ? moduleT('aiModels.unknownType') : label}
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

  // 先记录被删模型原来的体积：来源总量按原有值递减，而不是用剩余模型重新累加。
  // Ollama 这类来源的多个模型会共享同一份权重，重新累加会得到偏小的数值。
  const deletedSize = scanResult.sources
    .flatMap(source => source.models)
    .find(model => model.path === deletedPath)?.size ?? 0;

  const sources = scanResult.sources
    .map((source) => {
      const models = source.models.filter((model) => model.path !== deletedPath);
      if (models.length === source.models.length) {
        // 该来源不含被删模型，保持原值不变
        return source;
      }

      return {
        ...source,
        models,
        model_count: models.length,
        total_size: Math.max(0, source.total_size - deletedSize),
      };
    })
    .filter((source) => source.models.length > 0);

  return {
    ...scanResult,
    sources,
    source_count: sources.length,
    total_model_count: sources.reduce((total, source) => total + source.model_count, 0),
    total_size: Math.max(0, scanResult.total_size - deletedSize),
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
  return extension ? `${extension}` : '__unknown__';
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
