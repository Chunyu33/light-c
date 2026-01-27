// ============================================================================
// 清理功能 Hook
// 管理扫描和删除的状态逻辑
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import type { ScanResult, DeleteResult, AppStatus, FileInfo } from '../types';
import { scanJunkFiles, deleteFiles, getDiskInfo } from '../api/commands';
import type { DiskInfo } from '../types';

/** Hook 返回值类型 */
interface UseCleanupReturn {
  /** 应用状态 */
  status: AppStatus;
  /** 扫描结果 */
  scanResult: ScanResult | null;
  /** 删除结果 */
  deleteResult: DeleteResult | null;
  /** 磁盘信息 */
  diskInfo: DiskInfo | null;
  /** 选中的文件路径 */
  selectedPaths: Set<string>;
  /** 错误信息 */
  error: string | null;
  /** 执行扫描 */
  startScan: () => Promise<void>;
  /** 执行删除 */
  startDelete: () => Promise<void>;
  /** 切换文件选中状态 */
  toggleFileSelection: (path: string) => void;
  /** 切换分类全选 */
  toggleCategorySelection: (files: FileInfo[], selected: boolean) => void;
  /** 全选/取消全选 */
  toggleAllSelection: (selected: boolean) => void;
  /** 刷新磁盘信息 */
  refreshDiskInfo: () => Promise<void>;
  /** 清除错误 */
  clearError: () => void;
  /** 清除删除结果 */
  clearDeleteResult: () => void;
  /** 重置状态 */
  reset: () => void;
}

/**
 * 清理功能 Hook
 * 封装扫描和删除的所有状态管理逻辑
 */
export function useCleanup(): UseCleanupReturn {
  // 状态定义
  const [status, setStatus] = useState<AppStatus>('idle');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [deleteResult, setDeleteResult] = useState<DeleteResult | null>(null);
  const [diskInfo, setDiskInfo] = useState<DiskInfo | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // 刷新磁盘信息
  const refreshDiskInfo = useCallback(async () => {
    try {
      const info = await getDiskInfo();
      setDiskInfo(info);
    } catch (err) {
      console.error('获取磁盘信息失败:', err);
      setError(`获取磁盘信息失败: ${err}`);
    }
  }, []);

  // 应用启动时自动获取磁盘信息
  useEffect(() => {
    refreshDiskInfo();
  }, [refreshDiskInfo]);

  // 执行扫描
  const startScan = useCallback(async () => {
    setStatus('scanning');
    setError(null);
    setScanResult(null);
    setDeleteResult(null);
    setSelectedPaths(new Set());

    try {
      // 先刷新磁盘信息
      await refreshDiskInfo();
      
      // 执行扫描
      const result = await scanJunkFiles();
      setScanResult(result);
      
      // 默认选中所有风险等级 <= 2 的文件
      const defaultSelected = new Set<string>();
      result.categories.forEach((category) => {
        if (category.risk_level <= 2) {
          category.files.forEach((file) => {
            defaultSelected.add(file.path);
          });
        }
      });
      setSelectedPaths(defaultSelected);
    } catch (err) {
      console.error('扫描失败:', err);
      setError(`扫描失败: ${err}`);
    } finally {
      setStatus('idle');
    }
  }, [refreshDiskInfo]);

  // 执行删除
  const startDelete = useCallback(async () => {
    if (selectedPaths.size === 0) {
      setError('请先选择要删除的文件');
      return;
    }

    setStatus('deleting');
    setError(null);
    setDeleteResult(null);

    try {
      const paths = Array.from(selectedPaths);
      const result = await deleteFiles(paths);
      setDeleteResult(result);
      
      // 删除成功后，从扫描结果中移除已删除的文件
      if (scanResult && result.success_count > 0) {
        const deletedPaths = new Set(
          paths.filter((p) => !result.failed_files.some((f) => f.path === p))
        );
        
        const updatedCategories = scanResult.categories.map((category) => {
          const remainingFiles = category.files.filter((f) => !deletedPaths.has(f.path));
          return {
            ...category,
            files: remainingFiles,
            file_count: remainingFiles.length,
            total_size: remainingFiles.reduce((sum, f) => sum + f.size, 0),
          };
        });

        setScanResult({
          ...scanResult,
          categories: updatedCategories,
          total_file_count: updatedCategories.reduce((acc, c) => acc + c.file_count, 0),
          total_size: updatedCategories.reduce((acc, c) => acc + c.total_size, 0),
        });

        // 清除已删除文件的选中状态
        setSelectedPaths((prev) => {
          const newSet = new Set(prev);
          deletedPaths.forEach((p) => newSet.delete(p));
          return newSet;
        });
      }

      // 刷新磁盘信息（放在finally之前确保执行）
      await refreshDiskInfo();
    } catch (err) {
      console.error('删除失败:', err);
      setError(`删除失败: ${err}`);
    } finally {
      setStatus('idle');
    }
  }, [selectedPaths, scanResult, refreshDiskInfo]);

  // 切换单个文件选中状态
  const toggleFileSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  }, []);

  // 切换分类全选
  const toggleCategorySelection = useCallback((files: FileInfo[], selected: boolean) => {
    setSelectedPaths((prev) => {
      const newSet = new Set(prev);
      files.forEach((file) => {
        if (selected) {
          newSet.add(file.path);
        } else {
          newSet.delete(file.path);
        }
      });
      return newSet;
    });
  }, []);

  // 全选/取消全选
  const toggleAllSelection = useCallback(
    (selected: boolean) => {
      if (!scanResult) return;

      setSelectedPaths(() => {
        if (selected) {
          const allPaths = new Set<string>();
          scanResult.categories.forEach((category) => {
            category.files.forEach((file) => {
              allPaths.add(file.path);
            });
          });
          return allPaths;
        } else {
          return new Set();
        }
      });
    },
    [scanResult]
  );

  // 清除错误
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // 清除删除结果
  const clearDeleteResult = useCallback(() => {
    setDeleteResult(null);
  }, []);

  // 重置状态
  const reset = useCallback(() => {
    setStatus('idle');
    setScanResult(null);
    setDeleteResult(null);
    setSelectedPaths(new Set());
    setError(null);
  }, []);

  return {
    status,
    scanResult,
    deleteResult,
    diskInfo,
    selectedPaths,
    error,
    startScan,
    startDelete,
    toggleFileSelection,
    toggleCategorySelection,
    toggleAllSelection,
    refreshDiskInfo,
    clearError,
    clearDeleteResult,
    reset,
  };
}
