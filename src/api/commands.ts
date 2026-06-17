// ============================================================================
// Tauri 鍛戒护璋冪敤灏佽
// 灏佽鎵€鏈変笌Rust鍚庣鐨勯€氫俊鎺ュ彛
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
  LargeFileEntry,
} from '../types';

/**
 * 鑾峰彇C鐩樼鐩樹俊鎭? */
export async function getDiskInfo(): Promise<DiskInfo> {
  return invoke<DiskInfo>('get_disk_info');
}

/**
 * 鎵ц鍨冨溇鏂囦欢鎵弿
 * @param request 鎵弿璇锋眰鍙傛暟锛堝彲閫夛級
 */
export async function scanJunkFiles(request?: ScanRequest): Promise<ScanResult> {
  return invoke<ScanResult>('scan_junk_files', { request });
}

/**
 * 鎵弿鍗曚釜鍒嗙被
 * @param categoryName 鍒嗙被鍚嶇О
 */
export async function scanCategory(categoryName: string): Promise<CategoryScanResult> {
  return invoke<CategoryScanResult>('scan_category', { categoryName });
}

/**
 * 鍒犻櫎鎸囧畾鏂囦欢
 * @param paths 瑕佸垹闄ょ殑鏂囦欢璺緞鍒楄〃
 */
export async function deleteFiles(paths: string[]): Promise<DeleteResult> {
  const request: DeleteRequest = { paths };
  return invoke<DeleteResult>('delete_files', { request });
}

/**
 * 鑾峰彇鎵€鏈夊彲鐢ㄧ殑娓呯悊鍒嗙被
 */
export async function getCategories(): Promise<CategoryInfo[]> {
  return invoke<CategoryInfo[]>('get_categories');
}

/**
 * 鏍煎紡鍖栨枃浠跺ぇ灏忥紙璋冪敤Rust绔級
 * @param bytes 瀛楄妭鏁? */
export async function formatSizeFromRust(bytes: number): Promise<string> {
  return invoke<string>('format_size', { bytes });
}

/**
 * 鎵撳紑Windows纾佺洏娓呯悊宸ュ叿
 */
export async function openDiskCleanup(): Promise<void> {
  return invoke<void>('open_disk_cleanup');
}

/**
 * 鎵弿C鐩樺ぇ鏂囦欢
 * @param topN 杩斿洖鍓?N 涓渶澶ф枃浠?(10-200锛岄粯璁?50)
 */
export async function scanLargeFiles(topN?: number): Promise<LargeFileEntry[]> {
  return invoke<LargeFileEntry[]>('scan_large_files', { topN });
}

/**
 * 鍙栨秷澶ф枃浠舵壂鎻? */
export async function cancelLargeFileScan(): Promise<void> {
  return invoke<void>('cancel_large_file_scan');
}

/**
 * 鍦ㄦ枃浠惰祫婧愮鐞嗗櫒涓墦寮€鏂囦欢鎵€鍦ㄧ洰褰? */
export async function openInFolder(path: string): Promise<void> {
  return invoke<void>('open_in_folder', { path });
}

/**
 * 鐩存帴鎵撳紑鏂囦欢锛堜娇鐢ㄧ郴缁熼粯璁ょ▼搴忥級
 */
export async function openFile(path: string): Promise<void> {
  return invoke<void>('open_file', { path });
}

// ============================================================================
// 绯荤粺鐦﹁韩鐩稿叧
// ============================================================================

/** 绯荤粺鐦﹁韩椤圭姸鎬?*/
export interface SlimItemStatus {
  id: string;
  name: string;
  description: string;
  warning: string;
  enabled: boolean;
  size: number;
  actionable: boolean;
  action_text: string;
}

/** 绯荤粺鐦﹁韩鐘舵€佹眹鎬?*/
export interface SystemSlimStatus {
  is_admin: boolean;
  items: SlimItemStatus[];
  total_reclaimable: number;
}

/**
 * 妫€鏌ユ槸鍚︿互绠＄悊鍛樻潈闄愯繍琛? */
export async function checkAdminPrivilege(): Promise<boolean> {
  return invoke<boolean>('check_admin_privilege');
}

/**
 * 鑾峰彇绯荤粺鐦﹁韩鐘舵€? */
export async function getSystemSlimStatus(): Promise<SystemSlimStatus> {
  return invoke<SystemSlimStatus>('get_system_slim_status');
}

/**
 * 鍏抽棴浼戠湢鍔熻兘
 */
export async function disableHibernation(): Promise<string> {
  return invoke<string>('disable_hibernation');
}

/**
 * 寮€鍚紤鐪犲姛鑳? */
export async function enableHibernation(): Promise<string> {
  return invoke<string>('enable_hibernation');
}

/**
 * 娓呯悊 WinSxS 缁勪欢瀛樺偍
 */
export async function cleanupWinsxs(): Promise<string> {
  return invoke<string>('cleanup_winsxs');
}

/**
 * 鎵撳紑绯荤粺铏氭嫙鍐呭瓨璁剧疆
 */
export async function openVirtualMemorySettings(): Promise<void> {
  return invoke<void>('open_virtual_memory_settings');
}

// ============================================================================
// 鍋ュ悍璇勫垎鐩稿叧
// ============================================================================

/** 绯荤粺鍋ュ悍璇勫垎缁撴灉 */
export interface HealthScoreResult {
  score: number;
  disk_score: number;
  hibernation_score: number;
  junk_score: number;
  disk_free_percent: number;
  has_hibernation: boolean;
  hibernation_size: number;
  junk_size: number;
}

/**
 * 鑾峰彇绯荤粺鍋ュ悍璇勫垎
 */
export async function getHealthScore(): Promise<HealthScoreResult> {
  return invoke<HealthScoreResult>('get_health_score');
}

// ============================================================================
// 绀句氦杞欢鎵弿 - 甯﹂闄╁垎绾?// ============================================================================

/** 椋庨櫓绛夌骇 */
export type RiskLevel = 'critical' | 'medium' | 'low' | 'none';

/** 鏂囦欢鍒嗙被 */
export type FileCategory = 'chat_database' | 'image_video' | 'file_transfer' | 'temp_cache' | 'moments_cache';

/** 绀句氦杞欢鏂囦欢鏉＄洰 */
export interface SocialFileEntry {
  /** 鏂囦欢瀹屾暣璺緞 */
  path: string;
  /** 鏂囦欢澶у皬锛堝瓧鑺傦級 */
  size: number;
  /** 鎵€灞炲簲鐢ㄥ悕绉?*/
  app_name: string;
  /** 鏂囦欢鍒嗙被 */
  category: FileCategory;
  /** 椋庨櫓绛夌骇 */
  risk_level: RiskLevel;
  /** 鏄惁鍙垹闄わ紙Critical 绾у埆寮哄埗涓?false锛?*/
  deletable: boolean;
}

/** 绀句氦杞欢鍒嗙被缁熻 */
export interface SocialCategoryStats {
  /** 鍒嗙被ID */
  id: string;
  /** 鍒嗙被鍚嶇О */
  name: string;
  /** 鍒嗙被鎻忚堪 */
  description: string;
  /** 鏂囦欢鏁伴噺 */
  file_count: number;
  /** 鎬诲ぇ灏忥紙瀛楄妭锛?*/
  total_size: number;
  /** 鍙垹闄ょ殑鏂囦欢鏁伴噺 */
  deletable_count: number;
  /** 鍙垹闄ょ殑鏂囦欢澶у皬 */
  deletable_size: number;
  /** 鏂囦欢鍒楄〃 */
  files: SocialFileEntry[];
}

/** 绀句氦杞欢鎵弿缁撴灉 V2 */
export interface SocialScanResult {
  /** 鎸夊垎绫荤粺璁?*/
  categories: SocialCategoryStats[];
  /** 鎬绘枃浠舵暟 */
  total_files: number;
  /** 鎬诲ぇ灏?*/
  total_size: number;
  /** 鍙垹闄ょ殑鏂囦欢鏁?*/
  deletable_files: number;
  /** 鍙垹闄ょ殑鏂囦欢澶у皬 */
  deletable_size: number;
  /** 妫€娴嬪埌鐨勭ぞ浜よ蒋浠跺垪琛?*/
  detected_apps: string[];
}

/**
 * 鎵弿绀句氦杞欢缂撳瓨锛堝甫椋庨櫓鍒嗙骇锛? *
 * 鏀寔鏅鸿兘璺緞婧簮鍜屾枃浠剁被鍨嬫繁搴﹀垎绫伙細
 * - 寰俊锛氶€氳繃娉ㄥ唽琛ㄨ鍙栬嚜瀹氫箟璺緞锛岃瘑鍒亰澶╄褰曟暟鎹簱
 * - QQ/NTQQ锛氬畾浣?nt_data 鐩綍锛岃瘑鍒秷鎭暟鎹簱
 * - 閽夐拤锛氬畾浣?storage 鍜?cache 鐩綍
 * - 椋炰功锛氭壂鎻?LarkShell锛屽畾浣?sdk_storage 鍜?file_storage
 */
export async function scanSocialCache(): Promise<SocialScanResult> {
  return invoke<SocialScanResult>('scan_social_cache');
}

/** 鑾峰彇椋庨櫓绛夌骇鐨勪腑鏂囨弿杩?*/
export function getRiskLevelDescription(level: RiskLevel): string {
  switch (level) {
    case 'critical': return '鍗遍櫓锛堣亰澶╄褰曪級';
    case 'medium': return '璋ㄦ厧娓呯悊';
    case 'low': return '寤鸿娓呯悊';
    case 'none': return '瀹夊叏娓呯悊';
  }
}

/** 鑾峰彇椋庨櫓绛夌骇鐨勬彁绀轰俊鎭?*/
export function getRiskLevelTooltip(level: RiskLevel): string {
  switch (level) {
    case 'critical': return '聊天记录数据库，删除后会永久丢失，强烈建议保留';
    case 'medium': return '可能包含重要文档或附件，请确认后再删除';
    case 'low': return '图片或视频缓存，删除后通常可重新下载';
    case 'none': return '临时缓存文件，通常可以安全删除';
  }
}

// ============================================================================
// 鍗歌浇娈嬬暀鎵弿鐩稿叧
// ============================================================================

/** 鍗歌浇娈嬬暀鎵弿缁撴灉 */
export interface LeftoverScanResult {
  /** 鍙戠幇鐨勬畫鐣欐枃浠跺す鍒楄〃 */
  leftovers: LeftoverEntry[];
  /** 鎬诲ぇ灏忥紙瀛楄妭锛?*/
  total_size: number;
  /** 鎵弿鑰楁椂锛堟绉掞級 */
  scan_duration_ms: number;
}

/** 娈嬬暀绫诲瀷 */
export type LeftoverType = 'Normal' | 'Emulator' | 'VirtualDisk' | 'RegistryOrphan';

/** 妫€娴嬪垎绫伙紙缃俊搴﹀垎绾э級 */
export type DetectionCategory = 'HighConfidenceLeftover' | 'Suspicious' | 'LikelyAppData' | 'SystemShared';

/** 鍗曚釜娈嬬暀鏉＄洰 */
export interface LeftoverEntry {
  /** 鏂囦欢澶硅矾寰?*/
  path: string;
  /** 鏂囦欢澶瑰ぇ灏忥紙瀛楄妭锛?*/
  size: number;
  /** 鍙兘鐨勮蒋浠跺悕绉?*/
  app_name: string;
  /** 鏉ユ簮绫诲瀷 */
  source: 'LocalAppData' | 'RoamingAppData' | 'LocalLowAppData' | 'ProgramData' | 'VirtualDiskFile';
  /** 鏈€鍚庝慨鏀规椂闂达紙Unix鏃堕棿鎴筹級 */
  last_modified: number;
  /** 鍖呭惈鐨勬枃浠舵暟閲?*/
  file_count: number;
  /** 鏄惁涓烘ā鎷熷櫒娈嬬暀 */
  is_emulator: boolean;
  /** 鏄惁涓鸿櫄鎷熺鐩樻枃浠?*/
  is_virtual_disk: boolean;
  /** 娈嬬暀绫诲瀷 */
  leftover_type: LeftoverType;
  /** 缃俊搴﹀垎鏁?(0.0 ~ 1.0)锛岃秺楂樿秺鍙兘鏄畫鐣?*/
  confidence: number;
  /** 妫€娴嬪垎绫?*/
  detection_category: DetectionCategory;
  /** 璇勫垎鐞嗙敱鍒楄〃锛堜腑鏂囷級 */
  reasons: string[];
}

/** 鍗歌浇娈嬬暀鍒犻櫎缁撴灉 */
export interface LeftoverDeleteResult {
  /** 鎴愬姛鍒犻櫎鐨勬枃浠跺す鏁?*/
  deleted_count: number;
  /** 閲婃斁鐨勭┖闂村ぇ灏忥紙瀛楄妭锛?*/
  deleted_size: number;
  /** 鍒犻櫎澶辫触鐨勮矾寰?*/
  failed_paths: string[];
  /** 閿欒淇℃伅鍒楄〃 */
  errors: string[];
  /** 鍥犲寘鍚彲鎵ц鏂囦欢琚烦杩囩殑璺緞锛堥渶閫氳繃娣卞害娓呯悊澶勭悊锛?*/
  skipped_executables: string[];
}

/**
 * 鎵弿鍗歌浇娈嬬暀
 * 鎵弿 AppData 鍜?ProgramData 涓凡鍗歌浇杞欢閬楃暀鐨勫绔嬫枃浠跺す
 * @param deepScan 鏄惁鍚敤娣卞害鎵弿妯″紡锛堟壂鎻忔ā鎷熷櫒娈嬬暀銆佽櫄鎷熺鐩樻枃浠剁瓑锛? */
export async function scanUninstallLeftovers(deepScan?: boolean): Promise<LeftoverScanResult> {
  return invoke<LeftoverScanResult>('scan_uninstall_leftovers', { deepScan });
}

/**
 * 鍒犻櫎鍗歌浇娈嬬暀鏂囦欢澶? * @param paths 瑕佸垹闄ょ殑鏂囦欢澶硅矾寰勫垪琛? */
export async function deleteLeftoverFolders(paths: string[]): Promise<LeftoverDeleteResult> {
  return invoke<LeftoverDeleteResult>('delete_leftover_folders', { paths });
}

// ============================================================================
// 娉ㄥ唽琛ㄥ啑浣欐壂鎻忕浉鍏?(v3 鈥?纭繃婊ゆ敹鏁?
// ============================================================================

/** 娉ㄥ唽琛ㄦ壂鎻忕粨鏋?*/
export interface RegistryScanResult {
  entries: RegistryEntry[];
  total_count: number;
  scan_duration_ms: number;
}

/** 鍗曚釜娉ㄥ唽琛ㄦ潯鐩?*/
export interface RegistryEntry {
  /** HKCR\Applications 涓嬬殑瀹屾暣璺緞 */
  path: string;
  /** 搴旂敤绋嬪簭鍚?*/
  name: string;
  /** 鍏宠仈鐨勪笉瀛樺湪鐨勫彲鎵ц鏂囦欢璺緞 */
  associated_path: string;
  /** 闂鎻忚堪 */
  issue: string;
}

/** 娉ㄥ唽琛ㄥ垹闄ょ粨鏋?*/
export interface RegistryDeleteResult {
  backup_path: string;
  deleted_count: number;
  failed_entries: string[];
  errors: string[];
}

/**
 * 鎵弿娉ㄥ唽琛ㄥ啑浣? * 鍙壂鎻?MUI 缂撳瓨鍜?HKCR\Applications锛岄€氳繃閾佽瘉鏉′欢杩囨护
 */
export async function scanRegistryRedundancy(): Promise<RegistryScanResult> {
  return invoke<RegistryScanResult>('scan_registry_redundancy');
}

/**
 * 澶囦唤骞跺垹闄ゆ敞鍐岃〃鏉＄洰
 * @param entries 瑕佸垹闄ょ殑娉ㄥ唽琛ㄦ潯鐩垪琛? */
export async function deleteRegistryEntries(entries: RegistryEntry[]): Promise<RegistryDeleteResult> {
  return invoke<RegistryDeleteResult>('delete_registry_entries', { entries });
}

/**
 * 鎵撳紑娉ㄥ唽琛ㄥ浠界洰褰? */
export async function openRegistryBackupDir(): Promise<void> {
  return invoke<void>('open_registry_backup_dir');
}

// ============================================================================
// 澧炲己鍒犻櫎 API - 鏀寔閿佸畾鏂囦欢澶勭悊鍜岀墿鐞嗗ぇ灏忚绠?// ============================================================================

/** 鍒犻櫎澶辫触鍘熷洜 */
export type DeleteFailureReason = 
  | 'NotFound'
  | 'PermissionDenied'
  | 'FileLocked'
  | 'SystemProtected'
  | 'OutOfScope'
  | 'MarkedForReboot'
  | { Other: string };

/** 鍗曚釜鏂囦欢鍒犻櫎缁撴灉 */
export interface FileDeleteResult {
  /** 鏂囦欢璺緞 */
  path: string;
  /** 鏄惁鎴愬姛鍒犻櫎 */
  success: boolean;
  /** 閫昏緫澶у皬锛堟枃浠跺唴瀹瑰ぇ灏忥級 */
  logical_size: number;
  /** 鐗╃悊澶у皬锛堝疄闄呯鐩樺崰鐢級 */
  physical_size: number;
  /** 澶辫触鍘熷洜 */
  failure_reason: DeleteFailureReason | null;
  /** 鏄惁鏍囪涓洪噸鍚垹闄?*/
  marked_for_reboot: boolean;
}

/** 澧炲己鍒犻櫎缁撴灉 */
export interface EnhancedDeleteResult {
  /** 鎴愬姛鍒犻櫎鐨勬枃浠舵暟 */
  success_count: number;
  /** 澶辫触鐨勬枃浠舵暟 */
  failed_count: number;
  /** 鏍囪涓洪噸鍚垹闄ょ殑鏂囦欢鏁?*/
  reboot_pending_count: number;
  /** 瀹為檯閲婃斁鐨勭墿鐞嗙┖闂达紙瀛楄妭锛?*/
  freed_physical_size: number;
  /** 閫昏緫澶у皬鎬昏 */
  freed_logical_size: number;
  /** 璺宠繃鐨勬枃浠跺ぇ灏?*/
  skipped_size: number;
  /** 璇︾粏鐨勬枃浠跺垹闄ょ粨鏋?*/
  file_results: FileDeleteResult[];
  /** 鏄惁闇€瑕侀噸鍚畬鎴愭竻鐞?*/
  needs_reboot: boolean;
  /** 姹囨€绘秷鎭紙WeChat 椋庢牸锛?*/
  summary_message: string;
}

/**
 * 澧炲己鍒犻櫎鏂囦欢
 * 鏀寔鐗╃悊澶у皬璁＄畻銆侀攣瀹氭枃浠跺鐞嗐€佽缁嗗け璐ュ師鍥犲弽棣? * @param paths 瑕佸垹闄ょ殑鏂囦欢璺緞鍒楄〃
 */
export async function enhancedDeleteFiles(paths: string[]): Promise<EnhancedDeleteResult> {
  return invoke<EnhancedDeleteResult>('enhanced_delete_files', { paths });
}

/**
 * 鑾峰彇鏂囦欢鐨勭墿鐞嗗ぇ灏忥紙鎸夌皣瀵归綈锛? * @param logicalSize 閫昏緫澶у皬锛堝瓧鑺傦級
 */
export async function getPhysicalSize(logicalSize: number): Promise<number> {
  return invoke<number>('get_physical_size', { logicalSize });
}

/**
 * 妫€鏌ヨ矾寰勬槸鍚﹂渶瑕佺鐞嗗憳鏉冮檺
 * @param path 鏂囦欢璺緞
 */
export async function checkAdminForPath(path: string): Promise<boolean> {
  return invoke<boolean>('check_admin_for_path', { path });
}

/**
 * 鑾峰彇澶辫触鍘熷洜鐨勭敤鎴峰弸濂芥弿杩? */
export function getFailureReasonMessage(reason: DeleteFailureReason | null): string {
  if (!reason) return '';
  switch (reason) {
    case 'NotFound': return '文件不存在';
    case 'PermissionDenied': return '权限不足';
    case 'FileLocked': return '文件被系统占用';
    case 'SystemProtected': return '系统保护文件';
    case 'OutOfScope': return '不在清理范围内';
    case 'MarkedForReboot': return '已标记重启后删除';
    default: return typeof reason === 'object' && 'Other' in reason ? reason.Other : '删除失败';
  }
}

/**
 * 鑾峰彇澶辫触鍘熷洜鐨勮缁嗘彁绀猴紙鐢ㄤ簬 tooltip锛? */
export function getFailureReasonTooltip(reason: DeleteFailureReason | null): string {
  if (!reason) return '';
  switch (reason) {
    case 'NotFound': return '该文件可能已被其他程序删除';
    case 'PermissionDenied': return '需要管理员权限才能删除此文件';
    case 'FileLocked': return '文件正在被系统或其他程序使用，将在重启后删除';
    case 'SystemProtected': return '这是系统关键文件，删除可能导致系统不稳定';
    case 'OutOfScope': return '该文件不在安全清理范围内';
    case 'MarkedForReboot': return '文件已标记，将在下次重启时自动删除';
    default: return typeof reason === 'object' && 'Other' in reason ? reason.Other : '未知错误';
  }
}

// ============================================================================
// 姘镐箙鍒犻櫎 API - 鍗歌浇娈嬬暀娣卞害娓呯悊
// ============================================================================

/** 瀹夊叏妫€鏌ョ粨鏋滅被鍨?*/
export type SafetyCheckResult = 
  | 'Safe'  // 閫氳繃鎵€鏈夋鏌ワ紝鍙互瀹夊叏鍒犻櫎
  | { FoundInRegistry: { matched_field: string; matched_value: string } }
  | { ContainsExecutables: { files: string[] } }
  | { InProtectedPath: { reason: string } };

/** 鍗曚釜娈嬬暀鐨勬案涔呭垹闄ょ粨鏋?*/
export interface LeftoverPermanentDeleteDetail {
  /** 鏂囦欢澶硅矾寰?*/
  path: string;
  /** 鏄惁鎴愬姛鍒犻櫎 */
  success: boolean;
  /** 鍒犻櫎鐨勬枃浠舵暟閲?*/
  deleted_files: number;
  /** 閲婃斁鐨勭┖闂达紙瀛楄妭锛?*/
  freed_size: number;
  /** 澶辫触鍘熷洜 */
  failure_reason: string | null;
  /** 鏄惁鏍囪涓洪噸鍚垹闄?*/
  marked_for_reboot: boolean;
  /** 鏄惁闇€瑕佷汉宸ュ鏍?*/
  needs_manual_review: boolean;
  /** 瀹夊叏妫€鏌ョ粨鏋?*/
  safety_check: SafetyCheckResult;
}

/** 姘镐箙鍒犻櫎鐨勬€讳綋缁撴灉 */
export interface PermanentDeleteResult {
  /** 鎴愬姛鍒犻櫎鐨勬枃浠跺す鏁?*/
  success_count: number;
  /** 澶辫触鐨勬枃浠跺す鏁?*/
  failed_count: number;
  /** 闇€瑕佷汉宸ュ鏍哥殑鏁伴噺 */
  manual_review_count: number;
  /** 鏍囪涓洪噸鍚垹闄ょ殑鏁伴噺 */
  reboot_pending_count: number;
  /** 瀹為檯閲婃斁鐨勭┖闂达紙瀛楄妭锛?*/
  freed_size: number;
  /** 鍚勬枃浠跺す鐨勮缁嗙粨鏋?*/
  details: LeftoverPermanentDeleteDetail[];
  /** 鍒犻櫎鑰楁椂锛堟绉掞級 */
  duration_ms: number;
}

/**
 * 姘镐箙鍒犻櫎鍗歌浇娈嬬暀锛堟繁搴︽竻鐞嗭級
 * 
 * 鈿狅笍 璀﹀憡锛氭鎿嶄綔灏嗙洿鎺ヤ粠纾佺洏姘镐箙鍒犻櫎鏂囦欢锛屼笉鍙仮澶嶏紒
 * 
 * 鎵ц鍒犻櫎鍓嶄細杩涜涓夐噸瀹夊叏妫€鏌ワ細
 * 1. 娉ㄥ唽琛ㄦ鏌?- 纭鐩綍涓嶅湪浠讳綍宸插畨瑁呯▼搴忎腑
 * 2. 鍙墽琛屾枃浠舵鏌?- 鎵弿 .exe/.dll/.sys 鏂囦欢锛屽彂鐜板垯璺宠繃
 * 3. 鏍稿績鐧藉悕鍗曟鏌?- 纭繚璺緞涓嶅湪绯荤粺鍏抽敭鐩綍鍐? * 
 * @param paths 瑕佹案涔呭垹闄ょ殑鏂囦欢澶硅矾寰勫垪琛? */
export async function deleteLeftoversPermanent(paths: string[]): Promise<PermanentDeleteResult> {
  return invoke<PermanentDeleteResult>('delete_leftovers_permanent', { paths });
}

/**
 * 鎵ц鍗曚釜璺緞鐨勫畨鍏ㄦ鏌? * 鍦ㄧ敤鎴风‘璁ゅ垹闄ゅ墠锛屽彲浠ュ厛璋冪敤姝ゆ帴鍙ｆ鏌ヨ矾寰勬槸鍚﹀畨鍏? * @param path 瑕佹鏌ョ殑鏂囦欢澶硅矾寰? */
export async function checkLeftoverSafety(path: string): Promise<SafetyCheckResult> {
  return invoke<SafetyCheckResult>('check_leftover_safety', { path });
}

/**
 * 鑾峰彇瀹夊叏妫€鏌ョ粨鏋滅殑鐢ㄦ埛鍙嬪ソ鎻忚堪
 */
export function getSafetyCheckMessage(result: SafetyCheckResult): string {
  if (result === 'Safe') return '瀹夊叏';
  if (typeof result === 'object') {
    if ('FoundInRegistry' in result) {
      return `娉ㄥ唽琛ㄤ腑瀛樺湪鍖归厤: ${result.FoundInRegistry.matched_field} = ${result.FoundInRegistry.matched_value}`;
    }
    if ('ContainsExecutables' in result) {
      const files = result.ContainsExecutables.files;
      const count = files.length;
      const preview = files.slice(0, 3).join(', ');
      return count > 3 
        ? `包含 ${count} 个可执行文件: ${preview} 等`
        : `鍖呭惈鍙墽琛屾枃浠? ${preview}`;
    }
    if ('InProtectedPath' in result) {
      return `绯荤粺淇濇姢璺緞: ${result.InProtectedPath.reason}`;
    }
  }
  return '未知状态';
}

/**
 * 妫€鏌ュ畨鍏ㄦ鏌ョ粨鏋滄槸鍚﹀畨鍏? */
export function isSafetyCheckPassed(result: SafetyCheckResult): boolean {
  return result === 'Safe';
}

// ============================================================================
// 绯荤粺淇℃伅 API
// ============================================================================

/** 绯荤粺淇℃伅 */
export interface SystemInfo {
  /** 鎿嶄綔绯荤粺鍚嶇О */
  os_name: string;
  /** 鎿嶄綔绯荤粺鐗堟湰 */
  os_version: string;
  /** 绯荤粺鏋舵瀯 */
  os_arch: string;
  /** 璁＄畻鏈哄悕绉?*/
  computer_name: string;
  /** 鐢ㄦ埛鍚?*/
  user_name: string;
  /** CPU 淇℃伅 */
  cpu_info: string;
  /** CPU 鏍稿績鏁?*/
  cpu_cores: number;
  /** 鎬诲唴瀛橈紙瀛楄妭锛?*/
  total_memory: number;
  /** 鍙敤鍐呭瓨锛堝瓧鑺傦級 */
  available_memory: number;
  /** 绯荤粺鍚姩鏃堕棿锛堢锛?*/
  uptime_seconds: number;
}

/**
 * 鑾峰彇绯荤粺淇℃伅
 */
export async function getSystemInfo(): Promise<SystemInfo> {
  return invoke<SystemInfo>('get_system_info');
}

// ============================================================================
// 娓呯悊鏃ュ織鐩稿叧 API
// ============================================================================

/**
 * 娓呯悊鏃ュ織鏉＄洰杈撳叆
 */
export interface CleanupLogEntryInput {
  /** 娓呯悊妯″潡鍒嗙被 */
  category: string;
  /** 鏂囦欢璺緞 */
  path: string;
  /** 鏂囦欢澶у皬锛堝瓧鑺傦級 */
  size: number;
  /** 鏄惁鎴愬姛 */
  success: boolean;
  /** 閿欒淇℃伅锛堝彲閫夛級 */
  error_message?: string;
}

/**
 * 娓呯悊鍘嗗彶鎽樿
 */
export interface CleanupHistorySummary {
  /** 鏃ュ織鏂囦欢鍚?*/
  filename: string;
  /** 浼氳瘽寮€濮嬫椂闂?*/
  session_start: string;
  /** 浼氳瘽缁撴潫鏃堕棿 */
  session_end: string;
  /** 鎬绘枃浠舵暟 */
  total_files: number;
  /** 鎴愬姛鏁?*/
  success_count: number;
  /** 澶辫触鏁?*/
  failed_count: number;
  /** 鎬婚噴鏀剧┖闂达紙瀛楄妭锛?*/
  total_freed_bytes: number;
}

/**
 * 璁板綍娓呯悊鎿嶄綔鍒版棩蹇楁枃浠? * @param entries 娓呯悊璁板綍鏁扮粍
 */
export async function recordCleanupAction(entries: CleanupLogEntryInput[]): Promise<string> {
  return invoke<string>('record_cleanup_action', { entries });
}

/**
 * 鎵撳紑鏃ュ織鏂囦欢澶? */
export async function openLogsFolder(): Promise<void> {
  return invoke<void>('open_logs_folder');
}

/**
 * 鑾峰彇娓呯悊鍘嗗彶璁板綍鍒楄〃
 */
export async function getCleanupHistory(): Promise<CleanupHistorySummary[]> {
  return invoke<CleanupHistorySummary[]>('get_cleanup_history');
}

// ============================================================================
// 澶х洰褰曞垎鏋愮浉鍏?API
// ============================================================================

/**
 * 澶х洰褰曟潯鐩俊鎭? */
export interface HotspotEntry {
  /** 鏂囦欢澶瑰畬鏁磋矾寰?*/
  path: string;
  /** 鏂囦欢澶瑰悕绉?*/
  name: string;
  /** 鎬诲ぇ灏忥紙瀛楄妭锛?*/
  total_size: number;
  /** 鏂囦欢鏁伴噺 */
  file_count: number;
  /** 鏈€鍚庝慨鏀规椂闂达紙Unix 鏃堕棿鎴筹紝姣锛?*/
  last_modified: number;
  /** 鐖剁洰褰曠被鍨嬶紙Local/Roaming/LocalLow/System/Program 绛夛級 */
  parent_type: string;
  /** 鏄惁涓虹紦瀛樼洰褰?*/
  is_cache: boolean;
  /** 鏄惁涓虹▼搴忕洰褰?*/
  is_program: boolean;
  /** 鏄惁鍙畨鍏ㄦ竻鐞嗭紙娣卞害鎵弿妯″紡涓嬪己鍒朵负 false锛?*/
  is_safe_to_clean: boolean;
  /** 鏄惁涓虹郴缁熶繚鎶ょ洰褰曪紙榛戝悕鍗曠洰褰曪級 */
  is_protected: boolean;
  /** 瀛愮洰褰曞垪琛紙鏅鸿兘涓嬮捇锛氬綋鐩綍 >5GB 涓?>1000 鏂囦欢鏃讹紝灞曠ず鍓?3 涓渶澶у瓙鐩綍锛?*/
  children: HotspotEntry[];
  /** 褰撳墠鐩綍鐨勪笅閽绘繁搴︼紙0 = 椤剁骇鐩綍锛?*/
  depth: number;
}

/**
 * 澶х洰褰曟壂鎻忕粨鏋? */
export interface HotspotScanResult {
  /** 澶х洰褰曞垪琛紙宸叉寜澶у皬闄嶅簭鎺掑垪锛?*/
  entries: HotspotEntry[];
  /** 鎵弿鐨勬€绘枃浠跺す鏁?*/
  total_folders_scanned: number;
  /** 鎵弿鑰楁椂锛堟绉掞級 */
  scan_duration_ms: number;
  /** 鎵弿鑼冨洿鎬诲ぇ灏忥紙AppData 鎴?C 鐩樻€昏锛?*/
  scanned_total_size: number;
  /** 鏄惁涓烘繁搴︽壂鎻忔ā寮?*/
  is_full_scan: boolean;
}

/**
 * 鎵弿杩涘害浜嬩欢锛堜粎娣辨壂鎻忔椂鎺ㄩ€侊級
 */
export interface HotspotScanProgress {
  /** 褰撳墠姝ｅ湪鎵弿鐨勭洰褰?*/
  current_dir: string;
  /** 宸叉壂鎻忕殑鏂囦欢澶规暟 */
  scanned_dirs: number;
  /** 鍙戠幇鐨勫ぇ鐩綍鏁帮紙鈮?00MB锛?*/
  found_entries: number;
  /** 宸叉壂鎻忚寖鍥寸殑鎬诲ぇ灏忥紙瀛楄妭锛?*/
  total_size: number;
  /** 涓€绾х洰褰曟€绘暟锛堢敤浜庤繘搴︾櫨鍒嗘瘮锛?*/
  total_first_level_dirs: number;
  /** 宸插畬鎴愮殑涓€绾х洰褰曟暟锛堢敤浜庣簿纭繘搴︾櫨鍒嗘瘮锛?*/
  completed_roots: number;
  /** 当前扫描后端：mft / walkdir */
  backend?: string;
  /** 当前阶段：mft / index / metadata / aggregate / result / walkdir */
  stage?: string;
  /** 当前阶段说明，用于前端展示瓶颈 */
  message?: string;
  /** 扫描总耗时，单位毫秒 */
  elapsed_ms?: number;
  /** 当前阶段耗时，单位毫秒 */
  stage_elapsed_ms?: number;
}

/**
 * 鎵弿澶х洰褰? * @param topN 杩斿洖 Top N 缁撴灉锛岄粯璁?20
 * @param fullScan 鏄惁鍚敤鍏ㄧ洏娣卞害鎵弿锛岄粯璁?false锛堜粎鎵弿 AppData锛? *
 * 銆愬畨鍏ㄦ帾鏂姐€戞繁搴︽壂鎻忔ā寮忎笅锛屾墍鏈夌粨鏋滅殑 is_safe_to_clean 涓?false锛? * 鍓嶇搴旂鐢ㄦ竻鐞嗘寜閽紝浠呭厑璁?鎵撳紑浣嶇疆"鍜?鎼滅储"鎿嶄綔
 *
 * 銆愯繘搴︿簨浠躲€戞繁搴︽壂鎻忔椂鐩戝惉 `hotspot-scan:progress` 鑾峰彇瀹炴椂杩涘害锛? * `hotspot-scan:cancelled` 琛ㄧず鎵弿琚彇娑? */
export async function scanHotspot(
  topN?: number,
  fullScan?: boolean,
  maxDepth?: number,
  sizeThresholdMb?: number,
  ignoreSystemDirs?: boolean,
): Promise<HotspotScanResult> {
  console.log('[scanHotspot] JS 璋冪敤鍙傛暟:', { topN, fullScan, maxDepth, sizeThresholdMb, ignoreSystemDirs });
  return invoke<HotspotScanResult>('scan_hotspot', { topN, fullScan, maxDepth, sizeThresholdMb, ignoreSystemDirs });
}

/**
 * 鍙栨秷姝ｅ湪鎵ц鐨勫ぇ鐩綍鎵弿
 */
export async function cancelHotspotScan(): Promise<void> {
  return invoke<void>('cancel_hotspot_scan');
}

/**
 * 鍗曞眰璺緞閽诲彇鎵弿锛堝姩鎬佷笅閽诲姛鑳斤級
 * 鎵弿鎸囧畾璺緞鐨勭洿鎺ュ瓙鏂囦欢澶癸紝鐢ㄤ簬閫愬眰灞曞紑娣卞眰鐩綍缁撴瀯
 * @param path 瑕佹壂鎻忕殑鐩爣鐩綍缁濆璺緞
 */
export async function scanPathDirect(path: string): Promise<HotspotScanResult> {
  return invoke<HotspotScanResult>('scan_path_direct', { path });
}

/**
 * 鐩綍娓呯悊缁撴灉
 */
export interface CleanupDirectoryResult {
  /** 鎴愬姛鍒犻櫎鐨勬枃浠?鐩綍鏁?*/
  deleted_count: number;
  /** 鍒犻櫎澶辫触鐨勬暟閲?*/
  failed_count: number;
  /** 閲婃斁鐨勭┖闂村ぇ灏忥紙瀛楄妭锛?*/
  freed_size: number;
  /** 閿欒淇℃伅鍒楄〃 */
  errors: string[];
}

/**
 * 娓呯悊鐩綍鍐呭锛堜繚鐣欐牴鐩綍锛? * @param path 鐩綍璺緞
 */
export async function cleanupDirectoryContents(path: string): Promise<CleanupDirectoryResult> {
  return invoke<CleanupDirectoryResult>('cleanup_directory_contents', { path });
}

// ============================================================================
// 鍙抽敭鑿滃崟娓呯悊鐩稿叧 API
// ============================================================================

/** 鍗曚釜鍙抽敭鑿滃崟鏉＄洰 */
export interface ContextMenuEntry {
  /** 鍞竴 ID锛坮eg_root + "||" + reg_subpath锛?*/
  id: string;
  /** 鑿滃崟鏄剧ず鍚嶇О锛堝凡瑙ｆ瀽 MUIVerb 闂存帴瀛楃涓诧級 */
  display_name: string;
  /** 娉ㄥ唽琛ㄥ瓙閿悕 */
  key_name: string;
  /** 瀹屾暣娉ㄥ唽琛ㄨ矾寰勶紙鐢ㄤ簬 UI 灞曠ず锛?*/
  registry_path: string;
  /** 娉ㄥ唽琛ㄦ牴 ("HKCU" | "HKLM") */
  reg_root: 'HKCU' | 'HKLM';
  /** 鐩稿浜庢牴鐨勫瓙璺緞 */
  reg_subpath: string;
  /** 浣滅敤鑼冨洿锛?浠绘剰鏂囦欢", "鏂囦欢澶?, "妗岄潰鑳屾櫙", "纾佺洏椹卞姩鍣?, "搴撴枃浠跺す"锛?*/
  scope: string;
  /** 鍥炬爣璺緞锛堝師濮嬪€硷紝鍙兘鍚?index 鍚庣紑锛?*/
  icon_path: string | null;
  /** 鍘熷鍛戒护瀛楃涓?*/
  command: string | null;
  /** 浠庡懡浠や腑鎻愬彇鐨?exe 璺緞 */
  exe_path: string | null;
  /** exe 鏂囦欢鏄惁瀛樺湪浜庣鐩?*/
  exe_exists: boolean;
  /** 鏄惁闇€瑕佺鐞嗗憳鏉冮檺鎵嶈兘鍒犻櫎 */
  needs_admin: boolean;
  /** 鏄惁涓虹郴缁熶繚鎶ゆ潯鐩紙涓嶅彲閫変腑鍒犻櫎锛?*/
  is_system_protected: boolean;
  /** 椋庨櫓绛夌骇锛?safe" | "caution" | "danger"锛?*/
  risk_level: string;
}

/** 鍙抽敭鑿滃崟鎵弿缁撴灉 */
export interface ContextMenuScanResult {
  /** 鎵€鏈夋壂鎻忓埌鐨勬潯鐩?*/
  entries: ContextMenuEntry[];
  /** 鍏朵腑鏃犳晥锛坋xe 涓嶅瓨鍦級鐨勬潯鐩暟 */
  invalid_count: number;
  /** 鎵弿鑰楁椂锛堟绉掞級 */
  scan_duration_ms: number;
}

/** 鍙抽敭鑿滃崟鏉＄洰鍒犻櫎璇锋眰 */
export interface ContextMenuDeleteRequest {
  /** 鏉＄洰鍞竴 ID */
  id: string;
  /** 娉ㄥ唽琛ㄦ牴 */
  reg_root: 'HKCU' | 'HKLM';
  /** 鐩稿浜庢牴鐨勫瓙璺緞 */
  reg_subpath: string;
}

/** 鍗曚釜鏉＄洰鐨勫垹闄よ鎯?*/
export interface ContextMenuDeleteDetail {
  /** 鏉＄洰 ID */
  id: string;
  /** 鏄惁鎴愬姛 */
  success: boolean;
  /** 澶辫触鍘熷洜 */
  error: string | null;
}

/** 鍙抽敭鑿滃崟鍒犻櫎缁撴灉 */
export interface ContextMenuDeleteResult {
  /** 鎴愬姛鍒犻櫎鐨勬潯鐩暟 */
  deleted_count: number;
  /** 鍒犻櫎澶辫触鐨勬潯鐩暟 */
  failed_count: number;
  /** 姣忎釜鏉＄洰鐨勮缁嗙粨鏋?*/
  details: ContextMenuDeleteDetail[];
}

/**
 * 鎵弿 Windows 娉ㄥ唽琛ㄤ腑鐨勫彸閿彍鍗曟潯鐩? *
 * 瑕嗙洊 HKCU 鍜?HKLM 涓嬬殑 *\shell, Directory\shell,
 * Directory\Background\shell, Drive\shell 绛夋牳蹇冭矾寰? */
export async function scanContextMenu(): Promise<ContextMenuScanResult> {
  return invoke<ContextMenuScanResult>('scan_context_menu');
}

/**
 * 鍒犻櫎閫変腑鐨勫彸閿彍鍗曟敞鍐岃〃鏉＄洰
 * @param entries 瑕佸垹闄ょ殑鏉＄洰鍒楄〃
 */
export async function deleteContextMenuEntries(
  entries: ContextMenuDeleteRequest[]
): Promise<ContextMenuDeleteResult> {
  return invoke<ContextMenuDeleteResult>('delete_context_menu_entries', { entries });
}

// ============================================================================
// 绯荤粺蹇嵎宸ュ叿
// ============================================================================

/**
 * 鎵撳紑浠诲姟绠＄悊鍣ㄧ殑鍚姩椤圭鐞嗛〉闈? */
export async function openStartupManager(): Promise<void> {
  return invoke<void>('open_startup_manager');
}

/**
 * 鎵撳紑 Windows 瀛樺偍鎰熺煡璁剧疆椤甸潰
 */
export async function openStorageSettings(): Promise<void> {
  return invoke<void>('open_storage_settings');
}

// ============================================================================
// C 盘全盘变化分析 API
// ============================================================================

/** 全盘变化条目 */
export interface DiskGrowthDetailEntry {
  /** 发生变化的直接子目录路径 */
  path: string;
  /** 子目录名称，用于弹窗列表展示 */
  name: string;
  /** 上次快照大小 */
  old_size: number;
  /** 本次快照大小 */
  new_size: number;
  /** 与上次快照相比的变化量，正数为新增，负数为减少 */
  diff: number;
  /** 明细变化级别 */
  level: 'significant' | 'fast' | 'minor' | 'stable' | 'decreased' | 'new';
}

export interface DiskGrowthFileDetailEntry {
  /** 发生变化的文件路径 */
  path: string;
  /** 文件名，用于弹窗列表展示 */
  name: string;
  /** 上次快照大小 */
  old_size: number;
  /** 本次快照大小 */
  new_size: number;
  /** 与上次快照相比的变化量，正数为新增，负数为减少 */
  diff: number;
  /** 文件变化级别 */
  level: 'significant' | 'fast' | 'minor' | 'stable' | 'decreased' | 'new';
}

export interface DiskGrowthFileDetailsResponse {
  /** 查询目录 */
  path: string;
  /** 上次扫描时间 */
  previous_scan_time: string;
  /** 本次扫描时间 */
  current_scan_time: string;
  /** 文件级变化明细 */
  entries: DiskGrowthFileDetailEntry[];
  /** 实际变化文件数量 */
  total_changed_files: number;
  /** 本次返回文件数量 */
  returned_files: number;
  /** 分页偏移 */
  offset: number;
  /** 是否还有更多文件 */
  has_more: boolean;
}

export interface DiskGrowthDirectoryDetailsResponse {
  /** 查询目录 */
  path: string;
  /** 上次扫描时间 */
  previous_scan_time: string;
  /** 本次扫描时间 */
  current_scan_time: string;
  /** 目录级变化明细 */
  entries: DiskGrowthDetailEntry[];
  /** 实际变化目录数量 */
  total_changed_dirs: number;
  /** 本次返回目录数量 */
  returned_dirs: number;
  /** 分页偏移 */
  offset: number;
  /** 是否还有更多目录 */
  has_more: boolean;
}

export interface DiskGrowthEntry {
  /** 目录路径 */
  path: string;
  /** 上次快照大小，首次出现时为 0 */
  old_size: number;
  /** 本次快照大小 */
  new_size: number;
  /** 与上次快照相比的变化量，正数为新增，负数为减少 */
  diff: number;
  /** 相对上次快照的变化百分比 */
  diff_percent: number;
  /** 用于前端提示强弱，避免把小波动渲染成高风险 */
  level: 'significant' | 'fast' | 'minor' | 'stable' | 'decreased' | 'new';
  /** 后端根据路径和变化方向生成的说明 */
  explanation: string;
  /** 排查建议，不代表该目录可以直接清理 */
  suggestion: string;
  /** 该目录下一级子目录的变化明细，后端默认最多返回 50 条 */
  details: DiskGrowthDetailEntry[];
}

/** 全盘变化报告 */
export interface DiskGrowthReport {
  /** 变化目录按绝对变化量排序，后端最多返回 300 项 */
  entries: DiskGrowthEntry[];
  /** C 盘净变化量，正数为新增，负数为减少 */
  total_growth: number;
  /** 显著增长目录数量 */
  significant_count: number;
  /** 快速增长目录数量 */
  fast_count: number;
  /** 新增目录数量 */
  new_count: number;
  /** 减少目录数量 */
  decreased_count: number;
  /** 两次快照的时间跨度 */
  time_span: string;
  /** 用户可读的变化摘要 */
  summary: string;
}

/** 全盘目录分析条目 */
export interface DiskGrowthAnalyzeEntry {
  /** 目录路径 */
  path: string;
  /** 当前目录聚合大小 */
  size: number;
  /** 全盘扫描聚合深度 */
  depth?: number;
  /** 目录分类，仅用于帮助用户定位来源 */
  category: string;
  /** 变化或占用原因说明 */
  reason: string;
  /** 排查建议，不承诺可删除 */
  suggestion: string;
  /** 兼容 ModuleCard 行组件的展示字段，全盘分析不做风险判定 */
  risk?: 'safe' | 'warning' | 'dangerous';
  /** 兼容旧行数据结构，全盘分析不提供清理动作 */
  action?: 'delete' | 'suggest' | 'ignore' | 'protect';
  /** 全盘分析不匹配清理规则，保留空值便于旧展示逻辑复用 */
  matched_rule_id?: string | null;
  /** 全盘分析暂无规则标签 */
  tags?: string[];
}

/** 全盘目录分析结果 */
export interface DiskGrowthAnalyzeResult {
  /** 变化目录；首次扫描时回退为当前占用较大的目录 */
  entries: DiskGrowthAnalyzeEntry[];
  /** 本次变化绝对值 */
  changed_size: number;
  /** 本次新增空间 */
  increased_size: number;
  /** 本次减少空间 */
  decreased_size: number;
}

/** C 盘全盘变化扫描响应 */
export interface DiskGrowthScanResponse {
  /** 本次通过 MFT 聚合到的 C 盘文件总大小 */
  total_size: number;
  /** 本次成功读取大小的文件数量 */
  total_files_scanned: number;
  /** 扫描耗时，单位毫秒 */
  scan_duration_ms: number;
  /** 扫描根路径 */
  root_path: string;
  /** 上一次快照时间，首次扫描时为空 */
  previous_scan_time?: string | null;
  /** 本次快照时间 */
  current_scan_time: string;
  /** 扫描后端，当前应为 mft */
  backend: string;
  /** 后端各阶段耗时，用于判断性能瓶颈 */
  phase_durations: DiskGrowthPhaseDuration[];
  /** 直接从 MFT FILE record 解析到大小的文件数量 */
  mft_size_count: number;
  /** MFT 大小解析失败后回退 metadata 的文件数量 */
  metadata_fallback_count: number;
  /** 分析结果 */
  analyze: DiskGrowthAnalyzeResult;
  /** 与上次快照相比的变化报告 */
  growth: DiskGrowthReport;
}

/** 后端扫描阶段耗时 */
export interface DiskGrowthPhaseDuration {
  /** 阶段标识：mft/path/metadata/aggregate */
  stage: string;
  /** 阶段耗时，单位毫秒 */
  duration_ms: number;
}

/** 后端扫描阶段进度事件 */
export interface DiskGrowthScanProgress {
  /** 阶段标识：mft/path/metadata/aggregate */
  stage: string;
  /** 当前阶段说明 */
  message: string;
  /** 已处理数量 */
  processed: number;
  /** 总数量，无法预估时为空 */
  total?: number | null;
  /** 扫描总已用时，单位毫秒 */
  elapsed_ms: number;
}

/**
 * 扫描 C 盘并与上次快照对比。
 * 这里只保留全盘变化分析入口，避免前端继续误用旧 ProgramData 清理命令。
 */
export async function scanDiskGrowth(maxChangeEntries?: number): Promise<DiskGrowthScanResponse> {
  return invoke<DiskGrowthScanResponse>('scan_disk_growth', { maxChangeEntries });
}

export async function cancelDiskGrowthScan(): Promise<void> {
  return invoke<void>('cancel_disk_growth_scan');
}

export async function getDiskGrowthFileDetails(
  path: string,
  offset?: number,
  limit?: number
): Promise<DiskGrowthFileDetailsResponse> {
  return invoke<DiskGrowthFileDetailsResponse>('get_disk_growth_file_details', { path, offset, limit });
}

export async function getDiskGrowthDirectoryDetails(
  path: string,
  offset?: number,
  limit?: number
): Promise<DiskGrowthDirectoryDetailsResponse> {
  return invoke<DiskGrowthDirectoryDetailsResponse>('get_disk_growth_directory_details', { path, offset, limit });
}

// ============================================================================
// 鏁版嵁鐩綍绠＄悊 API
// ============================================================================

/**
 * 鑾峰彇褰撳墠鏁版嵁鐩綍璺緞
 */
export async function getDataDirectory(): Promise<string> {
  return invoke<string>('get_data_directory');
}

/**
 * 璁剧疆鏁版嵁鐩綍骞惰縼绉诲凡鏈夋暟鎹? * @param path 鏂扮殑鏁版嵁鐩綍璺緞
 */
export async function setDataDirectory(path: string): Promise<string> {
  return invoke<string>('set_data_directory', { path });
}

/**
 * 娓呯┖鏈湴鏁版嵁锛堝畨瑁呭巻鍙茬紦瀛?+ 娓呯悊鏃ュ織锛? * @returns [鍒犻櫎鏂囦欢鏁? 閲婃斁瀛楄妭鏁癩
 */
export async function clearLocalData(): Promise<[number, number]> {
  return invoke<[number, number]>('clear_local_data');
}

/**
 * 鎵撳紑绯荤粺鏂囦欢澶归€夋嫨瀵硅瘽妗? * @returns 鐢ㄦ埛閫夋嫨鐨勬枃浠跺す璺緞锛屽彇娑堝垯杩斿洖 null
 */
export async function pickFolderDialog(): Promise<string | null> {
  return invoke<string | null>('pick_folder_dialog');
}
