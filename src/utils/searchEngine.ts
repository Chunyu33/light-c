import { openUrl } from '@tauri-apps/plugin-opener';

export type SearchEngine = 'bing' | 'google' | 'baidu';

export const SEARCH_ENGINE_STORAGE_KEY = 'lightc.searchEngine';

export const SEARCH_ENGINE_CHANGED_EVENT = 'lightc:search-engine-changed';

const WINDOWS_DEVICE_PREFIX = '\\\\?\\';
const WINDOWS_UNC_DEVICE_PREFIX = '\\\\?\\UNC\\';

export const SEARCH_ENGINE_OPTIONS: Array<{ value: SearchEngine; label: string }> = [
  { value: 'bing', label: 'Bing' },
  { value: 'google', label: 'Google' },
  { value: 'baidu', label: '百度' },
];

/**
 * 去掉 Windows 长路径设备前缀，避免搜索引擎把 \\?\ 当成路径内容，降低搜索结果可读性。
 * UNC 长路径需要还原为标准的 \\server 形式，不能简单留下 UNC 文本。
 */
export function stripWindowsDevicePrefix(value: string): string {
  return value
    .split(WINDOWS_UNC_DEVICE_PREFIX).join('\\\\')
    .split(WINDOWS_DEVICE_PREFIX).join('');
}

const SEARCH_ENGINE_URLS: Record<SearchEngine, string> = {
  bing: 'https://www.bing.com/search?q=',
  google: 'https://www.google.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
};

export function isSearchEngine(value: unknown): value is SearchEngine {
  return value === 'bing' || value === 'google' || value === 'baidu';
}

export function getStoredSearchEngine(): SearchEngine {
  try {
    const storedValue = localStorage.getItem(SEARCH_ENGINE_STORAGE_KEY);
    return isSearchEngine(storedValue) ? storedValue : 'bing';
  } catch {
    return 'bing';
  }
}

export function setStoredSearchEngine(engine: SearchEngine) {
  // 搜索引擎是纯前端偏好，不需要写入后端配置；广播事件让已挂载模块立即拿到新设置。
  localStorage.setItem(SEARCH_ENGINE_STORAGE_KEY, engine);
  window.dispatchEvent(new CustomEvent<SearchEngine>(SEARCH_ENGINE_CHANGED_EVENT, { detail: engine }));
}

export async function openSearchUrl(searchText: string) {
  const engine = getStoredSearchEngine();
  // 所有模块统一在搜索入口清理设备前缀，避免调用方遗漏导致搜索词带有 \\?\。
  const query = encodeURIComponent(stripWindowsDevicePrefix(searchText));
  await openUrl(`${SEARCH_ENGINE_URLS[engine]}${query}`);
}
