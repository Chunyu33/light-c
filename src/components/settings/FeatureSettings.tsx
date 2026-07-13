// ============================================================================
// 功能设置页面
// ============================================================================

import { useEffect, useState } from 'react';
import { FileBox, HardDrive, Shield } from 'lucide-react';
import { Select, type SelectOption } from '../ui/Select';
import { useSettings } from '../../contexts';

const DEPTH_OPTIONS: SelectOption<string>[] = [
  { value: '2', label: '2 层' },
  { value: '3', label: '3 层' },
  { value: '4', label: '4 层' },
];

const HOTSPOT_SIZE_OPTIONS = [10, 50, 100, 200, 500];
const DISK_GROWTH_MAX_ENTRY_OPTIONS = [50, 100, 200, 300, 500, 1000];
const BIG_FILES_SCAN_LIMIT_MIN = 10;
const BIG_FILES_SCAN_LIMIT_MAX = 500;

function clampBigFilesScanLimit(value: number): number {
  // 该值会直接决定后端 TopN 和前端列表长度，设置页输入时先收敛一次，命令层还会再次兜底。
  return Math.min(BIG_FILES_SCAN_LIMIT_MAX, Math.max(BIG_FILES_SCAN_LIMIT_MIN, Math.floor(value || 50)));
}

export function FeatureSettings() {
  const { settings, updateSettings } = useSettings();
  const [bigFilesScanLimitDraft, setBigFilesScanLimitDraft] = useState(String(settings.bigFilesScanLimit));

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
      {/* 大文件清理 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <FileBox className="w-3.5 h-3.5" />
          大文件清理
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">扫描文件数</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                控制每次扫描返回的最大文件数量。数量越大越容易发现更多候选文件，但列表渲染和确认成本也会增加。
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
              <span className="text-xs text-[var(--text-muted)]">个</span>
            </div>
          </div>
          <p className="text-[11px] text-[var(--text-faint)]">
            边界范围：{BIG_FILES_SCAN_LIMIT_MIN} - {BIG_FILES_SCAN_LIMIT_MAX} 个。切换磁盘后会清空旧结果，避免不同磁盘的文件混在同一份清理列表里。
          </p>
        </div>
      </div>

      {/* 大目录分析 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5" />
          大目录分析
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-6">
          {/* 展示深度 — 下拉选择，最大 4 层（实际扫描固定 6 层） */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">展示深度</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                结果列表中展示的目录层数
              </p>
            </div>
            <Select
              value={String(settings.hotspotDepth)}
              options={DEPTH_OPTIONS}
              onChange={(v) => updateSettings({ hotspotDepth: Number(v) })}
              widthClass="w-24"
            />
          </div>

          {/* 大小阈值 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">最低展示大小</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  低于此大小的目录不参与扫描（减少噪音）
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
                <p className="text-sm font-medium text-[var(--text-primary)]">深度扫描忽略系统目录</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  关闭后可发现藏在系统保护目录下的异常大文件（如日志爆满），但扫描时间将增加数倍
                </p>
              </div>
              <button
                onClick={() => updateSettings({ hotspotIgnoreSystemDirs: !settings.hotspotIgnoreSystemDirs })}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ml-3 ${
                  settings.hotspotIgnoreSystemDirs ? 'bg-[var(--brand-green)]' : 'bg-[var(--bg-switch)]'
                }`}
              >
                <span
                  className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-300 ${
                    settings.hotspotIgnoreSystemDirs ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* 自动忽略的目录说明 */}
          <div className="pt-4 border-t border-[var(--border-color)]">
            <p className="text-sm font-medium text-[var(--text-primary)] mb-3 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5" />
              自动忽略的目录
            </p>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed mb-2">
              以下目录扫描时自动跳过或标记为保护，不会出现在清理候选列表中：
            </p>
            <div className="space-y-1 text-[11px] text-[var(--text-muted)]">
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                C:\Windows — 系统核心目录，删除会导致系统崩溃
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                Program Files / Program Files (x86) — 软件安装目录，仅查看不清理
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                WinSxS / System32 / SysWOW64 — Windows 组件存储，由系统管理
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                $Recycle.Bin / System Volume Information — 系统保留目录
              </p>
              <p className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />
                DriverStore / WindowsApps / assembly — 驱动和应用商店缓存
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 磁盘变化分析 */}
      <div className="space-y-3">
        <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-2">
          <HardDrive className="w-3.5 h-3.5" />
          磁盘变化分析
        </h4>
        <div className="bg-[var(--bg-main)] rounded-2xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">最多展示变化目录</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                限制与上次快照对比后返回的变化目录数量。数值越大，软件界面渲染和排序压力越高，建议保持 300 以内。
              </p>
            </div>
            <span className="text-sm font-semibold text-[var(--brand-green)] shrink-0">
              {settings.diskGrowthMaxEntries} 项
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
            边界范围：50 - 1000 项。首次扫描或无变化时仍显示占用基线列表，不受此项影响。
          </p>
          <div className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-color)] p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">变化明细</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                点击变化量可打开明细弹窗，左侧展示当前目录的下一级变化目录，右侧展示当前目录内变化文件。明细通过后端接口按需分页加载，每次最多 200 条，并使用虚拟列表渲染，避免大目录一次性渲染造成卡顿。
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                快照按磁盘盘符独立保存：C 盘沿用旧的 disk_growth_* 文件名，其他盘使用 d_disk_growth_* 这类盘符前缀。每个磁盘最多保留 3 组；最近两组用于变化对比，额外一组用于异常排查和兜底，超过后会自动清理该磁盘的旧快照及对应文件分片。
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">扫描速度</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                磁盘变化分析主要受文件数量、硬盘类型和系统负载影响。M.2 SSD 通常最快，SATA SSD 次之，机械硬盘会明显变慢；磁盘容量越大不一定越慢，真正决定耗时的是文件记录数量、$MFT 体积、metadata 回退数量和安全软件实时扫描。
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">首次 MFT 预热</p>
              <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                应用启动后第一次 MFT 扫描可能比后续扫描慢十几秒，这是 Windows 文件系统缓存、$MFT 数据和安全软件检查尚未预热导致的正常现象。完成一次 MFT 扫描后，大目录、大文件和全盘分析等模块通常都会明显变快。
              </p>
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">颜色指标</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 mt-2 text-xs text-[var(--text-muted)]">
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                  蓝色：新增，上次快照不存在、本次出现
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  红色：显著增长，增加 1GB 及以上
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-orange-500 shrink-0" />
                  橙色：快速增长，增加 300MB 及以上
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                  黄色：轻微增长，增加 1B 及以上
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                  绿色：相比上次快照减少
                </p>
                <p className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-gray-400 shrink-0" />
                  灰色：基本稳定，无明显变化
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
