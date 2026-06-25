import { openUrl } from '@tauri-apps/plugin-opener';

export type SearchEngine = 'bing' | 'google' | 'baidu';

export const SEARCH_ENGINE_STORAGE_KEY = 'lightc.searchEngine';

export const SEARCH_ENGINE_CHANGED_EVENT = 'lightc:search-engine-changed';

export const SEARCH_ENGINE_OPTIONS: Array<{ value: SearchEngine; label: string }> = [
  { value: 'bing', label: 'Bing' },
  { value: 'google', label: 'Google' },
  { value: 'baidu', label: '百度' },
];

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
  const query = encodeURIComponent(searchText);
  await openUrl(`${SEARCH_ENGINE_URLS[engine]}${query}`);
}
