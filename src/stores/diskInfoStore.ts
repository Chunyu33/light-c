// ============================================================================
// 磁盘信息运行期缓存
//
// 只在当前应用生命周期内保留一份最新快照，不使用 persist，避免把硬件信息
// 写入本地存储；菜单切换时直接复用这份内存数据。
// ============================================================================

import { create } from 'zustand';
import { getDiskHealth, type DiskHealthInfo, type DiskVolumeInfo } from '../api/commands';

const MAX_DISK_COUNT = 128;
const MAX_VOLUME_COUNT_PER_DISK = 512;
const MAX_DRIVE_LETTER_COUNT = 64;
const MAX_TEXT_LENGTH = 4096;

export type DiskInfoLoadStatus = 'idle' | 'loading' | 'success' | 'error';

interface DiskInfoStoreState {
  disks: DiskHealthInfo[] | null;
  status: DiskInfoLoadStatus;
  error: string | null;
  fetchDiskInfo: (force?: boolean) => Promise<void>;
}

let inFlightRequest: Promise<void> | null = null;

function isHealthStatus(value: unknown): value is DiskHealthInfo['health_status'] {
  return value === 'Healthy' || value === 'Warning' || value === 'Unhealthy' || value === 'Unknown';
}

function isDiskVolumeInfo(value: unknown): value is DiskVolumeInfo {
  if (!value || typeof value !== 'object') return false;
  const volume = value as Partial<DiskVolumeInfo>;
  return (
    typeof volume.drive_letter === 'string'
    && typeof volume.volume_name === 'string'
    && typeof volume.file_system === 'string'
    && typeof volume.total_space === 'number' && Number.isFinite(volume.total_space) && volume.total_space >= 0
    && typeof volume.used_space === 'number' && Number.isFinite(volume.used_space) && volume.used_space >= 0
    && typeof volume.free_space === 'number' && Number.isFinite(volume.free_space) && volume.free_space >= 0
    && typeof volume.usage_percent === 'number' && Number.isFinite(volume.usage_percent)
  );
}

function isDiskHealthInfo(value: unknown): value is DiskHealthInfo {
  if (!value || typeof value !== 'object') return false;
  const disk = value as Partial<DiskHealthInfo>;
  return (
    typeof disk.model === 'string'
    && typeof disk.serial_number === 'string'
    && typeof disk.firmware_version === 'string'
    && typeof disk.media_type === 'string'
    && typeof disk.bus_type === 'string'
    && typeof disk.operational_status === 'string'
    && isHealthStatus(disk.health_status)
    && (disk.number === null || (typeof disk.number === 'number' && Number.isFinite(disk.number)))
    && typeof disk.size === 'number' && Number.isFinite(disk.size) && disk.size >= 0
    && Array.isArray(disk.drive_letters) && disk.drive_letters.every(value => typeof value === 'string')
    && Array.isArray(disk.volumes) && disk.volumes.every(isDiskVolumeInfo)
  );
}

function limitText(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
}

function normalizeDiskSnapshot(value: unknown): DiskHealthInfo[] {
  if (!Array.isArray(value)) {
    throw new Error('磁盘信息返回格式无效');
  }

  const validDisks = value.filter(isDiskHealthInfo).slice(0, MAX_DISK_COUNT);
  if (value.length > 0 && validDisks.length === 0) {
    throw new Error('磁盘信息中没有可识别的磁盘条目');
  }

  // 只保留当前快照，并限制异常设备返回的数组规模，避免无界数据长期占用内存。
  return validDisks.map(disk => ({
    ...disk,
    model: limitText(disk.model),
    serial_number: limitText(disk.serial_number),
    firmware_version: limitText(disk.firmware_version),
    media_type: limitText(disk.media_type),
    bus_type: limitText(disk.bus_type),
    operational_status: limitText(disk.operational_status),
    drive_letters: disk.drive_letters.slice(0, MAX_DRIVE_LETTER_COUNT).map(limitText),
    volumes: disk.volumes.slice(0, MAX_VOLUME_COUNT_PER_DISK).map(volume => ({
      ...volume,
      drive_letter: limitText(volume.drive_letter),
      volume_name: limitText(volume.volume_name),
      file_system: limitText(volume.file_system),
    })),
  }));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useDiskInfoStore = create<DiskInfoStoreState>((set, get) => ({
  disks: null,
  status: 'idle',
  error: null,
  fetchDiskInfo: async (force = false) => {
    // 正在请求时复用同一个 Promise，避免重复点击或组件重建并发启动多个 CIM 查询。
    if (inFlightRequest) return inFlightRequest;
    if (!force && get().status === 'success') return;

    const request = (async () => {
      set({ status: 'loading', error: null });
      try {
        const result = normalizeDiskSnapshot(await getDiskHealth());
        set({ disks: result, status: 'success', error: null });
      } catch (error) {
        set({ status: 'error', error: getErrorMessage(error) });
      } finally {
        inFlightRequest = null;
      }
    })();

    inFlightRequest = request;
    return request;
  },
}));
