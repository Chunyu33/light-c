// ============================================================================
// 设置页 - 磁盘信息
//
// 磁盘信息只读展示，不参与主页面清理模块状态，也不保存检测历史。
// ============================================================================

import {
  CheckCircle2,
  CircleAlert,
  HardDrive,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldQuestion,
} from 'lucide-react';
import type { DiskHealthInfo, DiskVolumeInfo } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { useDiskInfoStore } from '../../stores/diskInfoStore';
import { useTranslation } from 'react-i18next';

const HEALTH_KEYS: Record<DiskHealthInfo['health_status'], string> = {
  Healthy: 'diskInfo.health.healthy',
  Warning: 'diskInfo.health.warning',
  Unhealthy: 'diskInfo.health.unhealthy',
  Unknown: 'diskInfo.health.unknown',
};

function getHealthPresentation(status: DiskHealthInfo['health_status']) {
  switch (status) {
    case 'Healthy':
      return {
        icon: CheckCircle2,
        className: 'border-[var(--brand-green-20)] bg-[var(--brand-green-10)] text-[var(--brand-green)]',
      };
    case 'Warning':
      return {
        icon: CircleAlert,
        className: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      };
    case 'Unhealthy':
      return {
        icon: ShieldAlert,
        className: 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger)]',
      };
    default:
      return {
        icon: ShieldQuestion,
        className: 'border-[var(--border-color)] bg-[var(--bg-hover)] text-[var(--text-muted)]',
      };
  }
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function getDiskTitle(disk: DiskHealthInfo, translate: Translate): string {
  return disk.model || (disk.number === null ? translate('diskInfo.unnamedDisk') : translate('diskInfo.diskNumber', { number: disk.number }));
}

function getVolumeLabel(volume: DiskVolumeInfo): string {
  return volume.volume_name ? `${volume.drive_letter} · ${volume.volume_name}` : volume.drive_letter;
}

function formatSerial(serialNumber: string, translate: Translate): string {
  if (!serialNumber) return translate('diskInfo.notProvided');
  const normalized = serialNumber.trim();
  if (normalized.length <= 8) return normalized;
  return `${normalized.slice(0, 4)}•••${normalized.slice(-4)}`;
}

function formatMediaType(mediaType: string, translate: Translate): string {
  switch (mediaType) {
    case 'SSD': return translate('diskInfo.media.ssd');
    case 'HDD': return translate('diskInfo.media.hdd');
    case 'SCM': return translate('diskInfo.media.scm');
    default: return mediaType || translate('diskInfo.unknownMedia');
  }
}

function HealthBadge({ status, translate }: { status: DiskHealthInfo['health_status']; translate: Translate }) {
  const presentation = getHealthPresentation(status);
  const Icon = presentation.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${presentation.className}`}>
      <Icon className="h-3 w-3" />
      {translate(HEALTH_KEYS[status])}
    </span>
  );
}

function InfoItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
      <p className="text-[11px] font-medium text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 truncate text-xs font-semibold text-[var(--text-primary)]" title={title ?? value}>
        {value}
      </p>
    </div>
  );
}

function VolumeItem({ volume, translate }: { volume: DiskVolumeInfo; translate: Translate }) {
  const usagePercent = Math.min(Math.max(volume.usage_percent, 0), 100);
  return (
    <div className="min-w-0 rounded-xl bg-[var(--bg-card)] px-3 py-2.5">
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
        <span className="min-w-0 truncate text-xs font-semibold text-[var(--text-primary)]" title={getVolumeLabel(volume)}>
          {getVolumeLabel(volume)}
        </span>
        <span className="whitespace-nowrap text-right text-[11px] tabular-nums text-[var(--text-muted)]" title={`${formatSize(volume.free_space)} ${translate('diskInfo.available')}`}>
          {formatSize(volume.free_space)} {translate('diskInfo.available')}
        </span>
        <div className="col-span-2 mt-2 flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-hover)]">
            <div className="h-1.5 rounded-full bg-[var(--brand-green)]" style={{ width: `${usagePercent}%` }} />
          </div>
          <span className="w-11 shrink-0 whitespace-nowrap text-right text-[11px] font-semibold tabular-nums text-[var(--text-primary)]">
            {usagePercent.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

function DiskInfoCard({ disk, translate }: { disk: DiskHealthInfo; translate: Translate }) {
  const totalVolumeSize = disk.volumes.reduce((sum, volume) => sum + volume.total_space, 0);
  const title = getDiskTitle(disk, translate);
  const subtitle = `${disk.drive_letters.length > 0 ? disk.drive_letters.join(' / ') : translate('diskInfo.unassignedDrive')} · ${formatMediaType(disk.media_type, translate)} · ${disk.bus_type || translate('diskInfo.unknownBus')}`;

  return (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--bg-main)] p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-green-10)] text-[var(--brand-green)]">
          <HardDrive className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h5 className="min-w-0 flex-1 truncate text-sm font-bold text-[var(--text-primary)]" title={title}>
              {title}
            </h5>
            <HealthBadge status={disk.health_status} translate={translate} />
          </div>
          <p className="mt-1 truncate text-xs text-[var(--text-muted)]" title={subtitle}>{subtitle}</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
        <InfoItem label={translate('diskInfo.capacity')} value={formatSize(disk.size || totalVolumeSize)} />
        <InfoItem label={translate('diskInfo.media')} value={formatMediaType(disk.media_type, translate)} />
        <InfoItem label={translate('diskInfo.bus')} value={disk.bus_type || translate('diskInfo.unknown')} />
        <InfoItem label={translate('diskInfo.operationalStatus')} value={disk.operational_status || translate('diskInfo.unknown')} title={disk.operational_status} />
        <InfoItem label={translate('diskInfo.firmware')} value={disk.firmware_version || translate('diskInfo.notProvided')} />
        <InfoItem label={translate('diskInfo.serial')} value={formatSerial(disk.serial_number, translate)} title={disk.serial_number || translate('diskInfo.notProvided')} />
        <InfoItem label={translate('diskInfo.diskNumberLabel')} value={disk.number === null ? translate('diskInfo.unknown') : translate('diskInfo.diskNumber', { number: disk.number })} />
        <InfoItem label={translate('diskInfo.volumeCount')} value={`${disk.drive_letters.length} ${translate('diskInfo.unit')}`} />
      </div>

      {disk.volumes.length > 0 && (
        <div className="mt-3 border-t border-[var(--border-color)] pt-3">
          <p className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">{translate('diskInfo.volumes')}</p>
          <div className="grid min-w-0 gap-2">
            {disk.volumes.map(volume => <VolumeItem key={`${disk.number}-${volume.drive_letter}`} volume={volume} translate={translate} />)}
          </div>
        </div>
      )}
    </article>
  );
}

export function DiskInfoSettings() {
  const { t } = useTranslation('settings');
  const disks = useDiskInfoStore(state => state.disks);
  const loadStatus = useDiskInfoStore(state => state.status);
  const error = useDiskInfoStore(state => state.error);
  const fetchDiskInfo = useDiskInfoStore(state => state.fetchDiskInfo);
  const isLoading = loadStatus === 'loading';

  return (
    <div className="min-w-0 space-y-4 pb-2">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
            <HardDrive className="h-4 w-4 shrink-0 text-[var(--brand-green)]" />
            {t('diskInfo.title')}
          </h4>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
            {t('diskInfo.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchDiskInfo(true)}
          disabled={isLoading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--brand-green-20)] bg-[var(--brand-green-10)] px-3 py-2 text-xs font-semibold text-[var(--brand-green)] transition hover:bg-[var(--brand-green)] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          {isLoading ? t('diskInfo.loading') : disks ? t('diskInfo.reload') : t('diskInfo.read')}
        </button>
      </div>

      <div className="flex min-w-0 items-start gap-2 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2.5 text-xs leading-relaxed text-blue-700 dark:text-blue-300">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t('diskInfo.healthNotice')}</p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center rounded-2xl border border-[var(--border-color)] bg-[var(--bg-main)] py-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="mr-2 h-4 w-4 animate-spin text-[var(--brand-green)]" /> {t('diskInfo.reading')}
        </div>
      )}

      {!isLoading && error && (
        <div className="rounded-2xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/10 p-4">
          <p className="text-sm font-semibold text-[var(--color-danger)]">{t('diskInfo.readFailed')}</p>
          <p className="mt-1 break-words text-xs leading-relaxed text-[var(--color-danger)]">{error}</p>
          <button type="button" onClick={() => void fetchDiskInfo(true)} className="mt-3 rounded-lg border border-[var(--color-danger)]/30 px-3 py-1.5 text-xs font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10">
            {t('diskInfo.retry')}
          </button>
        </div>
      )}

      {!isLoading && !error && disks === null && (
        <div className="rounded-2xl border border-dashed border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-12 text-center">
          <HardDrive className="mx-auto h-8 w-8 text-[var(--brand-green)]" />
          <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">{t('diskInfo.notRead')}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t('diskInfo.notReadDesc')}</p>
        </div>
      )}

      {!isLoading && !error && disks !== null && disks.length === 0 && (
        <div className="rounded-2xl border border-dashed border-[var(--border-color)] bg-[var(--bg-main)] px-4 py-12 text-center">
          <HardDrive className="mx-auto h-8 w-8 text-[var(--brand-green)]" />
          <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">{t('diskInfo.none')}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">{t('diskInfo.noneDesc')}</p>
        </div>
      )}

      {!isLoading && !error && disks !== null && disks.length > 0 && (
        <div className="grid min-w-0 gap-3">
          {disks.map((disk, index) => <DiskInfoCard key={`${disk.number ?? 'unknown'}-${disk.model}-${index}`} disk={disk} translate={t} />)}
        </div>
      )}
    </div>
  );
}
