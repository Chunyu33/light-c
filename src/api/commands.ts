// ============================================================================
// Tauri 命令调用封装
// 封装所有与Rust后端的通信接口
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import type {
  DiskInfo,
  ScanResult,
  CategoryScanResult,
  DeleteResult,
  CategoryInfo,
  ScanRequest,
  DeleteRequest,
} from '../types';

/**
 * 获取C盘磁盘信息
 */
export async function getDiskInfo(): Promise<DiskInfo> {
  return invoke<DiskInfo>('get_disk_info');
}

/**
 * 执行垃圾文件扫描
 * @param request 扫描请求参数（可选）
 */
export async function scanJunkFiles(request?: ScanRequest): Promise<ScanResult> {
  return invoke<ScanResult>('scan_junk_files', { request });
}

/**
 * 扫描单个分类
 * @param categoryName 分类名称
 */
export async function scanCategory(categoryName: string): Promise<CategoryScanResult> {
  return invoke<CategoryScanResult>('scan_category', { categoryName });
}

/**
 * 删除指定文件
 * @param paths 要删除的文件路径列表
 */
export async function deleteFiles(paths: string[]): Promise<DeleteResult> {
  const request: DeleteRequest = { paths };
  return invoke<DeleteResult>('delete_files', { request });
}

/**
 * 获取所有可用的清理分类
 */
export async function getCategories(): Promise<CategoryInfo[]> {
  return invoke<CategoryInfo[]>('get_categories');
}

/**
 * 格式化文件大小（调用Rust端）
 * @param bytes 字节数
 */
export async function formatSizeFromRust(bytes: number): Promise<string> {
  return invoke<string>('format_size', { bytes });
}

/**
 * 打开Windows磁盘清理工具
 */
export async function openDiskCleanup(): Promise<void> {
  return invoke<void>('open_disk_cleanup');
}
