// ============================================================================
// 功能设置页面
// ============================================================================

import { useEffect, useState } from 'react';
import { FileBox, HardDrive, Shield, Trash2 } from 'lucide-react';
import { Select, type SelectOption } from '../ui/Select';
import { Switch } from '../ui/Switch';
import { useSettings } from '../../contexts';
import { useTranslation } from 'react-i18next';

const DEPTH_OPTIONS: SelectOption<string>[] = [
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
];

const HOTSPOT_SIZE_OPTIONS = [10, 50, 100, 200, 500];
const DISK_GROWTH_MAX_ENTRY_OPTIONS = [50, 100, 200, 300, 500, 1000];
const BIG_FILES_SCAN_LIMIT_MIN = 10;
const BIG_FILES_SCAN_LIMIT_MAX = 500;

function clampBigFilesScanLimit(value: number): number {
  // 该值会直接决定后端 TopN 和前端列表长度，设置页输入时先收敛一次，命令层还会再次兜底。
  return Math.min(BIG_FILES_SCAN_LIMIT_MAX, Math.max(BIG_FILES_SCAN_LIMIT_MIN, Math.floor(value || 50)));
}

const JUNK_DEEP_SCAN_DEPTH_MIN = 4;
const JUNK_DEEP_SCAN_DEPTH_MAX = 24;
const JUNK_DEEP_SCAN_DEPTH_DEFAULT = 16;

function clampJunkDeepScanDepth(value: number): number {
  // 这个值直接决定后端遍历的目录层数 —— 每往下加一层，要走的目录数可能成倍增长，
  // 所以两端都要兜：设置页先收敛一次，命令层还会再收敛一次。
  return Math.min(
    JUNK_DEEP_SCAN_DEPTH_MAX,
    Math.max(JUNK_DEEP_SCAN_DEPTH_MIN, Math.floor(value || JUNK_DEEP_SCAN_DEPTH_DEFAULT)),
  );
}

export function FeatureSettings() {
  const { settings, updateSettings } = useSettings();
  const { t } = useTranslation('settings');
  const [bigFilesScanLimitDraft, setBigFilesScanLimitDraft] = useState(String(settings.bigFilesScanLimit));
  const [junkDeepScanDepthDraft, setJunkDeepScanDepthDraft] = useState(String(settings.junkDeepScanDepth));

  useEffect(() => {
    setJunkDeepScanDepthDraft(String(settings.junkDeepScanDepth));
  }, [settings.junkDeepScanDepth]);

  const commitJunkDeepScanDepth = () => {
    const nextDepth = clampJunkDeepScanDepth(Number(junkDeepScanDepthDraft));
    updateSettings({ junkDeepScanDepth: nextDepth });
    setJunkDeepScanDepthDraft(String(nextDepth));
  };

  useEffect(() => {
    setBigFilesScanLimitDraft(String(settings.bigFilesScanLimit));
  }, [settings.bigFilesScanLimit]);

  const commitBigFilesScanLimit = () => {
    // 数字输入允许用户临时清空内容，提交时再归一化，避免输入 300 这类值时被中途强制改写。
    const nextLimit = clampBigFilesScanLimit(Number(bigFilesScanLimitDraft));
    updateSettings({ bigFilesScanLimit: nextLimit });
    setBigFilesScanLimitDraft(String(nextLimit));
  };

  return (
    <div className="flex flex-col w-0 min-w-full space-y-4 pb-2">
      {/* 垃圾清理：深度发现的扫描深度（Evan 要求放在本页最顶部） */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <Trash2 className="w-3.5 h-3.5" />
          {t('features.junkDeepScan.title')}
        </h4>
        <div className="glass-block bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.junkDeepScan.depth')}</p>
              {/* 必须写清代价：深度是成倍影响扫描时间的，用户得知道自己在换什么 */}
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.junkDeepScan.depthDesc')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={JUNK_DEEP_SCAN_DEPTH_MIN}
                max={JUNK_DEEP_SCAN_DEPTH_MAX}
                value={junkDeepScanDepthDraft}
                onBlur={commitJunkDeepScanDepth}
                onChange={(event) => setJunkDeepScanDepthDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
                className="h-9 w-24 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 text-right text-sm font-semibold text-[var(--brand-green)] outline-none transition focus:border-[var(--brand-green)]"
              />
              <span className="text-xs text-[var(--text-muted)]">{t('features.junkDeepScan.unit')}</span>
            </div>
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            {t('features.junkDeepScan.range', { min: JUNK_DEEP_SCAN_DEPTH_MIN, max: JUNK_DEEP_SCAN_DEPTH_MAX })}
          </p>
        </div>
      </div>

      {/* 大文件清理 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <FileBox className="w-3.5 h-3.5" />
          {t('features.bigFiles.title')}
        </h4>
        <div className="glass-block bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.bigFiles.scanLimit')}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.bigFiles.scanLimitDesc')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input
                type="number"
                min={BIG_FILES_SCAN_LIMIT_MIN}
                max={BIG_FILES_SCAN_LIMIT_MAX}
                step={10}
                value={bigFilesScanLimitDraft}
                onBlur={commitBigFilesScanLimit}
                onChange={(event) => setBigFilesScanLimitDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  }
                }}
                className="h-9 w-24 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] px-3 text-right text-sm font-semibold text-[var(--brand-green)] outline-none transition focus:border-[var(--brand-green)]"
              />
              <span className="text-xs text-[var(--text-muted)]">{t('units.items')}</span>
            </div>
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            {t('features.bigFiles.range', { min: BIG_FILES_SCAN_LIMIT_MIN, max: BIG_FILES_SCAN_LIMIT_MAX })}
          </p>
        </div>
      </div>

      {/* 大目录分析 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5" />
          {t('features.hotspot.title')}
        </h4>
        <div className="glass-block bg-[var(--bg-main)] rounded-2xl p-5 space-y-6">
          {/* 展示深度 — 下拉选择，最大 4 层（实际扫描固定 6 层） */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.hotspot.depth')}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                {t('features.hotspot.depthDesc')}
              </p>
            </div>
            <Select
              value={String(settings.hotspotDepth)}
              options={DEPTH_OPTIONS.map(option => ({ ...option, label: t('units.layers', { count: option.value }) }))}
              onChange={(v) => updateSettings({ hotspotDepth: Number(v) })}
              widthClass="w-24"
            />
          </div>

          {/* 大小阈值 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.hotspot.minSize')}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {t('features.hotspot.minSizeDesc')}
                </p>
              </div>
              <span className="text-sm font-semibold text-[var(--brand-green)] min-w-[3rem] text-right">
                {settings.hotspotSizeThreshold} MB
              </span>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {HOTSPOT_SIZE_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => updateSettings({ hotspotSizeThreshold: n })}
                  className={`h-8 rounded-lg text-xs font-medium border transition-colors ${
                    settings.hotspotSizeThreshold === n
                      ? 'bg-[var(--brand-green)] text-white border-[var(--brand-green)]'
                      : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  {n}MB
                </button>
              ))}
            </div>
          </div>

          {/* 深度扫描忽略系统目录 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.hotspot.ignoreSystem')}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {t('features.hotspot.ignoreSystemDesc')}
                </p>
              </div>
              {/* 改用共享的 ui/Switch：原先这一处也是自绘的，尺寸与设置页其它开关不一致 */}
              <Switch
                checked={settings.hotspotIgnoreSystemDirs}
                onChange={(checked) => updateSettings({ hotspotIgnoreSystemDirs: checked })}
                aria-label={t('features.hotspot.ignoreSystem')}
              />
            </div>
          </div>

          {/* 自动忽略的目录说明 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <p className="text-sm font-medium text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              {t('features.hotspot.autoIgnored')}
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-2">
              {t('features.hotspot.autoIgnoredDesc')}
            </p>
            <div className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                {t('features.hotspot.systemCore')}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                {t('features.hotspot.programFiles')}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                {t('features.hotspot.windowsComponents')}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                {t('features.hotspot.systemReserved')}
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                {t('features.hotspot.appCache')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 磁盘变化分析 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5" />
          {t('features.diskGrowth.title')}
        </h4>
        <div className="glass-block bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.diskGrowth.maxEntries')}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.diskGrowth.maxEntriesDesc')}
              </p>
            </div>
            <span className="text-sm font-semibold text-[var(--brand-green)] shrink-0">
              {settings.diskGrowthMaxEntries} {t('units.items')}
            </span>
          </div>
          <div className="grid grid-cols-6 gap-2">
            {DISK_GROWTH_MAX_ENTRY_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => updateSettings({ diskGrowthMaxEntries: n })}
                className={`h-8 rounded-lg text-xs font-medium border transition-colors ${
                  settings.diskGrowthMaxEntries === n
                    ? 'bg-[var(--brand-green)] text-white border-[var(--brand-green)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-color)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            {t('features.diskGrowth.range')}
          </p>
          <div className="glass-block rounded-xl bg-[var(--bg-card)] border border-[var(--border-color)] p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.diskGrowth.details')}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.diskGrowth.detailDesc')}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.diskGrowth.snapshotDesc')}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.diskGrowth.speed')}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.diskGrowth.speedDesc')}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.diskGrowth.mftWarmup')}</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                {t('features.diskGrowth.mftWarmupDesc')}
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">{t('features.diskGrowth.colors')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 mt-2 text-xs text-[var(--text-muted)]">
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                  {t('features.diskGrowth.newColor')}
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  {t('features.diskGrowth.growthColor')}
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                  {t('features.diskGrowth.fastColor')}
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                  {t('features.diskGrowth.minorColor')}
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  {t('features.diskGrowth.reducedColor')}
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
                  {t('features.diskGrowth.stableColor')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
