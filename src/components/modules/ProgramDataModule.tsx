// ============================================================================
// ProgramData 分析模块
// 深度分析系统缓存与后台数据，找出C盘异常增长来源
// 卡片入口 + 展开式详情页（一体化设计）
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { Loader2, Trash2, ShieldCheck, Shield, TrendingUp, TrendingDown, Minus, AlertTriangle, CheckCircle2, Sparkles, HardDrive } from 'lucide-react';
import { ModuleCard } from '../ModuleCard';
import { ConfirmDialog } from '../ConfirmDialog';
import { useToast } from '../Toast';
import { useDashboard } from '../../contexts/DashboardContext';
import {
  scanProgramData,
  analyzeProgramData,
  diffProgramData,
  cleanProgramData,
  openInFolder,
  type ProgramDataScanResult,
  type ProgramDataAnalyzeEntry,
  type ProgramDataAnalyzeResult,
  type ProgramDataGrowthReport,
  type ProgramDataGrowthEntry,
  type ProgramDataRiskLevel,
  type ProgramDataCleanResult,
} from '../../api/commands';
import { formatSize } from '../../utils/format';

// ============================================================================
// 工具函数
// ============================================================================

/** 简化路径显示（取最后两级） */
function simplifyPath(path: string): string {
  const sep = path.includes('/') ? '/' : '\\';
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= 2) return parts.join(sep);
  return '...' + sep + parts.slice(-2).join(sep);
}

/** 获取风险等级的颜色配置 */
function getRiskStyle(risk: ProgramDataRiskLevel): { text: string; bg: string; label: string } {
  switch (risk) {
    case 'safe':
      return { text: 'text-green-600', bg: 'bg-green-500/10', label: '安全' };
    case 'warning':
      return { text: 'text-amber-600', bg: 'bg-amber-500/10', label: '谨慎' };
    case 'dangerous':
      return { text: 'text-red-600', bg: 'bg-red-500/10', label: '危险' };
  }
}

/** 格式化增长差值 */
function formatDiff(diff: number): string {
  const absDiff = Math.abs(diff);
  const sign = diff >= 0 ? '+' : '-';
  return sign + formatSize(absDiff);
}

/** 获取增长级别的图标和颜色 */
function getGrowthStyle(level: string): { icon: typeof TrendingUp; color: string } {
  switch (level) {
    case 'significant':
      return { icon: TrendingUp, color: 'text-red-500' };
    case 'fast':
      return { icon: TrendingUp, color: 'text-orange-500' };
    case 'minor':
      return { icon: TrendingUp, color: 'text-amber-500' };
    case 'decreased':
      return { icon: TrendingDown, color: 'text-green-500' };
    case 'new':
      return { icon: Sparkles, color: 'text-blue-500' };
    default:
      return { icon: Minus, color: 'text-gray-400' };
  }
}

// ============================================================================
// 诊断提示组件
// ============================================================================

function DiagnosticBanner({ report }: { report: ProgramDataGrowthReport | null }) {
  if (!report || !report.summary) return null;
  
  const isWarning = report.significant_count > 0;

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl text-[13px] ${
      isWarning
        ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : 'bg-[var(--brand-green-10)] text-[var(--brand-green)]'
    }`}>
      {isWarning ? (
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      ) : (
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
      )}
      <span>{report.summary}</span>
    </div>
  );
}

// ============================================================================
// Summary 统计卡片
// ============================================================================

function SummaryCards({
  totalSize,
  cleanableSize,
  growthReport,
}: {
  totalSize: number;
  cleanableSize: number;
  growthReport: ProgramDataGrowthReport | null;
}) {
  const todayGrowth = growthReport?.total_growth ?? 0;

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* ProgramData 总占用 */}
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">ProgramData 总占用</p>
        <p className="text-lg font-bold text-[var(--text-primary)] tabular-nums">{formatSize(totalSize)}</p>
      </div>
      {/* 可清理空间 */}
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">可清理空间</p>
        <p className="text-lg font-bold text-[var(--brand-green)] tabular-nums">{formatSize(cleanableSize)}</p>
      </div>
      {/* 今日增长 */}
      <div className="bg-[var(--bg-main)] rounded-xl px-4 py-3">
        <p className="text-[11px] text-[var(--text-muted)] mb-1">与上次对比</p>
        <p className={`text-lg font-bold tabular-nums ${
          todayGrowth > 0 ? 'text-red-500' : todayGrowth < 0 ? 'text-green-500' : 'text-[var(--text-muted)]'
        }`}>
          {todayGrowth !== 0 ? formatDiff(todayGrowth) : '暂无数据'}
        </p>
      </div>
    </div>
  );
}

// ============================================================================
// 数据列表行组件
// ============================================================================

function AnalyzeRow({
  entry,
  growth,
  isCleaning,
  onClean,
  onOpenFolder,
}: {
  entry: ProgramDataAnalyzeEntry;
  growth: ProgramDataGrowthEntry | null;
  isCleaning: boolean;
  onClean: (entry: ProgramDataAnalyzeEntry) => void;
  onOpenFolder: (path: string) => void;
}) {
  const riskStyle = getRiskStyle(entry.risk);
  const canClean = entry.risk === 'safe' && (entry.action === 'delete' || entry.action === 'suggest');
  const growthStyle = growth ? getGrowthStyle(growth.level) : null;
  const GrowthIcon = growthStyle?.icon ?? Minus;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-[var(--bg-hover)] transition-colors group">
      {/* 风险指示 */}
      <div className={`w-1.5 h-8 rounded-full shrink-0 ${
        entry.risk === 'safe' ? 'bg-green-400' : entry.risk === 'warning' ? 'bg-amber-400' : 'bg-red-400'
      }`} />

      {/* 路径 */}
      <div className="flex-1 min-w-0">
        <p
          className="text-[13px] text-[var(--text-primary)] truncate cursor-pointer hover:text-[var(--brand-green)] transition-colors"
          title={entry.path}
          onClick={() => onOpenFolder(entry.path)}
        >
          {simplifyPath(entry.path)}
        </p>
        <p className="text-[11px] text-[var(--text-faint)] mt-0.5 truncate">{entry.reason}</p>
      </div>

      {/* 分类标签 */}
      <span className="px-2 py-0.5 rounded text-[11px] bg-[var(--bg-hover)] text-[var(--text-muted)] shrink-0">
        {entry.category}
      </span>

      {/* 风险标签 */}
      <span className={`px-2 py-0.5 rounded text-[11px] font-medium shrink-0 ${riskStyle.bg} ${riskStyle.text}`}>
        {riskStyle.label}
      </span>

      {/* 大小 */}
      <span className="text-[13px] font-medium text-[var(--text-primary)] tabular-nums w-20 text-right shrink-0">
        {formatSize(entry.size)}
      </span>

      {/* 增长值 */}
      <span className={`text-[12px] tabular-nums w-20 text-right shrink-0 flex items-center justify-end gap-1 ${growthStyle?.color ?? 'text-gray-400'}`}>
        {growth && growth.diff !== 0 ? (
          <>
            <GrowthIcon className="w-3 h-3" />
            {formatDiff(growth.diff)}
          </>
        ) : (
          <span className="text-[var(--text-faint)]">-</span>
        )}
      </span>

      {/* 操作按钮 */}
      <div className="w-16 shrink-0 flex justify-end">
        {canClean ? (
          <button
            onClick={() => onClean(entry)}
            disabled={isCleaning}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium
              text-[var(--brand-green)] hover:bg-[var(--brand-green-10)] transition-all
              opacity-0 group-hover:opacity-100
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3 h-3" />
            清理
          </button>
        ) : entry.action === 'protect' ? (
          <span className="flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
            <Shield className="w-3 h-3" />
            保护
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function ProgramDataModule() {
  const { modules, expandedModule, setExpandedModule, updateModuleState, oneClickScanTrigger } = useDashboard();
  const moduleState = modules.programdata;
  const { showToast } = useToast();

  const lastScanTriggerRef = useRef(0);

  // 本地状态
  const [scanResult, setScanResult] = useState<ProgramDataScanResult | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<ProgramDataAnalyzeResult | null>(null);
  const [growthReport, setGrowthReport] = useState<ProgramDataGrowthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCleaning, setIsCleaning] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // 单项清理确认
  const [cleanTarget, setCleanTarget] = useState<ProgramDataAnalyzeEntry | null>(null);
  // 一键清理确认
  const [showBatchCleanConfirm, setShowBatchCleanConfirm] = useState(false);
  // 防重复请求
  const scanningRef = useRef(false);

  const isExpanded = expandedModule === 'programdata';

  // 执行完整扫描流程：scan → analyze → diff
  const handleScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;

    updateModuleState('programdata', { status: 'scanning' });
    setError(null);
    setScanResult(null);
    setAnalyzeResult(null);
    setGrowthReport(null);
    setShowAll(false);

    try {
      // 1. 扫描
      const scan = await scanProgramData();
      setScanResult(scan);

      // 2. 分析
      const analyze = await analyzeProgramData(scan.entries);
      setAnalyzeResult(analyze);

      // 3. 增长对比（可能没有历史数据，不报错）
      try {
        const diff = await diffProgramData();
        setGrowthReport(diff);
      } catch {
        // 没有历史快照，忽略
      }

      updateModuleState('programdata', {
        status: 'done',
        fileCount: analyze.entries.length,
        totalSize: analyze.cleanable_size,
      });
    } catch (err) {
      console.error('ProgramData 扫描失败:', err);
      setError(String(err));
      updateModuleState('programdata', { status: 'error' });
    } finally {
      scanningRef.current = false;
    }
  }, [updateModuleState]);

  // 响应一键扫描
  useEffect(() => {
    if (oneClickScanTrigger > 0 && oneClickScanTrigger !== lastScanTriggerRef.current) {
      lastScanTriggerRef.current = oneClickScanTrigger;
      handleScan();
    }
  }, [oneClickScanTrigger, handleScan]);

  // 打开文件夹
  const handleOpenFolder = useCallback(async (path: string) => {
    try {
      await openInFolder(path);
    } catch (err) {
      console.error('打开文件夹失败:', err);
    }
  }, []);

  // 单项清理确认
  const handleSingleClean = useCallback((entry: ProgramDataAnalyzeEntry) => {
    setCleanTarget(entry);
  }, []);

  // 执行单项清理
  const handleSingleCleanConfirm = useCallback(async () => {
    if (!cleanTarget) return;
    setIsCleaning(true);
    try {
      const result: ProgramDataCleanResult = await cleanProgramData([cleanTarget], false);
      if (result.success_count > 0) {
        showToast({
          type: 'success',
          title: '清理完成',
          description: `已释放 ${formatSize(result.freed_size)}`,
        });
        // 重新扫描更新数据
        handleScan();
      } else if (result.skipped_count > 0) {
        showToast({
          type: 'warning',
          title: '已跳过',
          description: result.results[0]?.skip_reason ?? '目录被跳过',
        });
      } else {
        showToast({
          type: 'error',
          title: '清理失败',
          description: result.results[0]?.error ?? '未知错误',
        });
      }
    } catch (err) {
      showToast({ type: 'error', title: '清理失败', description: String(err) });
    } finally {
      setIsCleaning(false);
      setCleanTarget(null);
    }
  }, [cleanTarget, handleScan, showToast]);

  // 一键清理（只清理 Safe 级别）
  const handleBatchClean = useCallback(async () => {
    if (!analyzeResult) return;
    const safeEntries = analyzeResult.entries.filter(
      e => e.risk === 'safe' && (e.action === 'delete' || e.action === 'suggest')
    );
    if (safeEntries.length === 0) {
      showToast({ type: 'info', title: '无可清理项', description: '没有安全级别的可清理目录' });
      setShowBatchCleanConfirm(false);
      return;
    }

    setIsCleaning(true);
    try {
      const result = await cleanProgramData(safeEntries, false);
      if (result.success_count > 0) {
        const extra = result.failed_count > 0 ? `（${result.failed_count} 项因占用跳过）` : '';
        showToast({
          type: 'success',
          title: '一键清理完成',
          description: `成功清理 ${result.success_count} 项，释放 ${formatSize(result.freed_size)}${extra}`,
        });
        handleScan();
      } else if (result.skipped_count > 0) {
        const reason = result.results.find(r => r.skip_reason)?.skip_reason ?? '条目被跳过';
        showToast({ type: 'warning', title: '清理受阻', description: reason });
      } else {
        const reason = result.results.find(r => r.error)?.error ?? '目录被占用或权限不足';
        showToast({ type: 'warning', title: '清理受阻', description: reason });
      }
    } catch (err) {
      showToast({ type: 'error', title: '清理失败', description: String(err) });
    } finally {
      setIsCleaning(false);
      setShowBatchCleanConfirm(false);
    }
  }, [analyzeResult, handleScan, showToast]);

  // 显示的条目
  const entries = analyzeResult?.entries ?? [];
  const displayedEntries = showAll ? entries : entries.slice(0, 15);
  const hasMore = entries.length > 15 && !showAll;

  // 构建增长映射（path → growth）
  const growthMap = new Map<string, ProgramDataGrowthEntry>();
  if (growthReport) {
    for (const g of growthReport.entries) {
      growthMap.set(g.path.toLowerCase(), g);
    }
  }

  // 可清理条目数
  const cleanableCount = entries.filter(
    e => e.risk === 'safe' && (e.action === 'delete' || e.action === 'suggest')
  ).length;

  return (
    <>
      <ModuleCard
        id="programdata"
        title="ProgramData 分析"
        description="深度分析系统缓存与后台数据，找出C盘异常增长来源"
        icon={<HardDrive className="w-5 h-5 text-[var(--brand-green)]" />}
        status={moduleState.status}
        fileCount={moduleState.fileCount}
        totalSize={moduleState.totalSize}
        expanded={isExpanded}
        onToggleExpand={() => setExpandedModule(isExpanded ? null : 'programdata')}
        onScan={handleScan}
        scanButtonText="开始扫描"
        error={error}
      >
        {/* ============================================================ */}
        {/* 扫描中 */}
        {/* ============================================================ */}
        {moduleState.status === 'scanning' && (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--brand-green)] mb-3" />
            <p className="text-sm">正在扫描 ProgramData 目录...</p>
            <p className="text-xs text-[var(--text-faint)] mt-1">首次扫描可能需要较长时间</p>
          </div>
        )}

        {/* ============================================================ */}
        {/* 扫描完成 - 详情页 */}
        {/* ============================================================ */}
        {moduleState.status === 'done' && analyzeResult && (
          <div className="p-4 space-y-4">
            {/* Summary 卡片 */}
            <SummaryCards
              totalSize={scanResult?.total_size ?? 0}
              cleanableSize={analyzeResult.cleanable_size}
              growthReport={growthReport}
            />

            {/* 诊断提示 */}
            <DiagnosticBanner report={growthReport} />

            {/* 操作栏 */}
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-[var(--text-muted)]">
                共 {entries.length} 个目录，{cleanableCount} 个可清理
              </p>
              {cleanableCount > 0 && (
                <button
                  onClick={() => setShowBatchCleanConfirm(true)}
                  disabled={isCleaning}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-medium
                    bg-[var(--brand-green)] text-white hover:bg-[var(--brand-green-hover)]
                    transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isCleaning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-3.5 h-3.5" />
                  )}
                  一键清理安全项
                </button>
              )}
            </div>

            {/* 数据列表 */}
            <div className="bg-[var(--bg-main)] rounded-xl overflow-hidden">
              {/* 表头 */}
              <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--border-color)] text-[11px] text-[var(--text-faint)] uppercase tracking-wider">
                <div className="w-1.5 shrink-0" />
                <div className="flex-1">路径</div>
                <div className="w-16 shrink-0 text-center">分类</div>
                <div className="w-12 shrink-0 text-center">风险</div>
                <div className="w-20 shrink-0 text-right">大小</div>
                <div className="w-20 shrink-0 text-right">增长</div>
                <div className="w-16 shrink-0" />
              </div>

              {/* 数据行 */}
              {displayedEntries.map((entry) => (
                <AnalyzeRow
                  key={entry.path}
                  entry={entry}
                  growth={growthMap.get(entry.path.toLowerCase()) ?? null}
                  isCleaning={isCleaning}
                  onClean={handleSingleClean}
                  onOpenFolder={handleOpenFolder}
                />
              ))}

              {/* 加载更多 */}
              {hasMore && (
                <button
                  onClick={() => setShowAll(true)}
                  className="w-full py-3 text-center text-[13px] text-[var(--brand-green)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  显示全部 {entries.length} 项
                </button>
              )}

              {/* 空状态 */}
              {entries.length === 0 && (
                <div className="py-12 text-center text-[var(--text-muted)] text-sm">
                  未发现可分析的目录
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/* 扫描完成但无结果 */}
        {/* ============================================================ */}
        {moduleState.status === 'done' && !analyzeResult && (
          <div className="py-12 text-center text-[var(--text-muted)] text-sm">
            扫描完成，暂无数据
          </div>
        )}
      </ModuleCard>

      {/* 单项清理确认对话框 */}
      <ConfirmDialog
        isOpen={!!cleanTarget}
        title="确认清理"
        description={
          cleanTarget
            ? `确定要将 ${simplifyPath(cleanTarget.path)}（${formatSize(cleanTarget.size)}）移动到回收站吗？`
            : ''
        }
        confirmText={isCleaning ? '清理中...' : '确认清理'}
        cancelText="取消"
        onConfirm={handleSingleCleanConfirm}
        onCancel={() => setCleanTarget(null)}
      />

      {/* 一键清理确认对话框 */}
      <ConfirmDialog
        isOpen={showBatchCleanConfirm}
        title="一键清理确认"
        description={`将清理 ${cleanableCount} 个安全级别目录（共 ${formatSize(analyzeResult?.cleanable_size ?? 0)}），所有文件移至回收站。`}
        confirmText={isCleaning ? '清理中...' : '开始清理'}
        cancelText="取消"
        onConfirm={handleBatchClean}
        onCancel={() => setShowBatchCleanConfirm(false)}
      />
    </>
  );
}

export default ProgramDataModule;
