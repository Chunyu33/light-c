import { useEffect, useMemo, useState } from 'react';
import { getLocalDrives, type LocalDriveInfo } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { Select, type SelectOption } from './Select';

export function normalizeDriveLetter(value?: string | null): string {
  const letter = value?.match(/[a-z]/i)?.[0]?.toUpperCase() ?? 'C';
  return `${letter}:`;
}

export function driveDisplayName(driveLetter: string): string {
  return `${normalizeDriveLetter(driveLetter).replace(':', '')} 盘`;
}

export function useLocalDrives() {
  const [drives, setDrives] = useState<LocalDriveInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getLocalDrives()
      .then((result) => {
        if (cancelled) return;
        setDrives(result);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { drives, error, loading };
}

export function defaultDriveLetter(drives: LocalDriveInfo[]): string {
  const drive =
    drives.find((item) => item.is_system) ??
    drives.find((item) => item.drive_letter === 'C:') ??
    drives[0];
  return drive?.drive_letter ?? 'C:';
}

export function driveOptionTitle(drive: LocalDriveInfo): string {
  const parts = [drive.drive_letter];
  if (drive.volume_name) parts.push(drive.volume_name);
  if (drive.file_system) parts.push(drive.file_system);
  parts.push(`可用 ${formatSize(drive.free_space)}`);
  parts.push(`总计 ${formatSize(drive.total_space)}`);
  if (drive.is_system) parts.push('系统盘');
  if (!drive.is_ntfs) parts.push('非 NTFS');
  return parts.join(' · ');
}

function driveOptionLabel(drive: LocalDriveInfo): string {
  // 下拉触发器空间有限，只显示盘符和卷标；容量、文件系统等完整信息放进 title。
  return drive.volume_name ? `${drive.drive_letter} · ${drive.volume_name}` : drive.drive_letter;
}

interface DriveSelectProps {
  value: string;
  drives: LocalDriveInfo[];
  onChange: (driveLetter: string) => void;
  disabled?: boolean;
  widthClass?: string;
}

export function DriveSelect({
  value,
  drives,
  onChange,
  disabled = false,
  // 统一盘符选择器宽度，避免卡片模式下不同模块标题区域出现视觉跳变。
  widthClass = 'w-28',
}: DriveSelectProps) {
  const options = useMemo<SelectOption[]>(
    () => {
      const driveOptions = drives.map((drive) => ({
        value: drive.drive_letter,
        label: driveOptionLabel(drive),
        title: driveOptionTitle(drive),
      }));
      return driveOptions.length > 0
        ? driveOptions
        : [{ value: 'C:', label: 'C:', title: 'C: · 默认系统盘' }];
    },
    [drives],
  );

  return (
    <Select
      value={normalizeDriveLetter(value)}
      options={options}
      onChange={(driveLetter) => onChange(normalizeDriveLetter(driveLetter))}
      widthClass={widthClass}
      size="sm"
      disabled={disabled}
    />
  );
}
