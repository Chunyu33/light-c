import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLocalDrives, type LocalDriveInfo } from '../../api/commands';
import { formatSize } from '../../utils/format';
import { Select, type SelectOption } from './Select';
import i18n from '../../i18n';

export function normalizeDriveLetter(value?: string | null): string {
  const letter = value?.match(/[a-z]/i)?.[0]?.toUpperCase() ?? 'C';
  return `${letter}:`;
}

export function driveDisplayName(driveLetter: string): string {
  return i18n.t('driveLabel', { ns: 'common', drive: normalizeDriveLetter(driveLetter).replace(':', '') });
}

export function useLocalDrives() {
  const [drives, setDrives] = useState<LocalDriveInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 组件卸载后不再 setState，避免刷新请求回来时报警告。 */
  const mountedRef = useRef(true);

  /**
   * 读取磁盘列表（含各盘剩余空间）。
   * 返回是否成功 —— 调用方要用它决定弹"已更新"还是"更新失败"。
   */
  const loadDrives = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    try {
      const result = await getLocalDrives();
      if (!mountedRef.current) return true;
      setDrives(result);
      setError(null);
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      setError(String(err));
      return false;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // ⚠️「置 true」必须和「置 false」写在同一个 effect 里。
    // 之前只在 cleanup 里置 false，React 严格模式下 effect 会 mount → unmount → mount，
    // 第二次挂载时 mountedRef 已经是 false，loadDrives 一进门就提前返回，
    // setLoading(false) 永远执行不到 —— 表现就是顶栏一直 loading、控件 disabled 点不动。
    mountedRef.current = true;
    void loadDrives();
    return () => {
      mountedRef.current = false;
    };
  }, [loadDrives]);

  return { drives, error, loading, refresh: loadDrives };
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
  parts.push(i18n.t('driveAvailable', { ns: 'common', size: formatSize(drive.free_space) }));
  parts.push(i18n.t('driveTotal', { ns: 'common', size: formatSize(drive.total_space) }));
  if (drive.is_system) parts.push(i18n.t('systemDrive', { ns: 'common' }));
  if (!drive.is_ntfs) parts.push(i18n.t('nonNtfs', { ns: 'common' }));
  return parts.join(' · ');
}

/**
 * 盘符下拉项的短标签。
 * ⚠️ 必须 export 给顶栏复用 —— 之前顶栏自己拼了一份 `${letter} ${volume}`，
 * 少了中间的 ` · `，同一个下拉在设置页和顶栏里长得不一样。
 */
export function driveOptionLabel(drive: LocalDriveInfo): string {
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
        : [{ value: 'C:', label: 'C:', title: `C: · ${i18n.t('defaultSystemDrive', { ns: 'common' })}` }];
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
