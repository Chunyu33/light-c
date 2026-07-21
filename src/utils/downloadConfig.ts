// ============================================================================
// 官方下载渠道配置
// 从 GitHub Release 的 download.json 动态读取网盘等渠道，避免把第三方下载链接固化进前端组件。
// ============================================================================

import { LIGHTC_DEFAULT_DOWNLOAD_CONFIG } from '../config/officialLinks';

export interface OfficialDownloadConfig {
  githubReleasesUrl: string;
  netDiskUrl: string;
  bilibiliUrl: string;
  douyinUrl: string;
}

const DOWNLOAD_CONFIG_URL = 'https://github.com/Chunyu33/light-c/releases/latest/download/download.json';

const DEFAULT_DOWNLOAD_CONFIG: OfficialDownloadConfig = {
  ...LIGHTC_DEFAULT_DOWNLOAD_CONFIG,
  // 该对象的字段由独立官方链接常量集中维护，避免设置页再次硬编码。
  githubReleasesUrl: LIGHTC_DEFAULT_DOWNLOAD_CONFIG.githubReleasesUrl ?? 'https://github.com/Chunyu33/light-c/releases',
};

let cachedConfigPromise: Promise<OfficialDownloadConfig> | null = null;

function isSafeHttpsUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://');
}

function mergeDownloadConfig(remoteConfig: unknown): OfficialDownloadConfig {
  if (!remoteConfig || typeof remoteConfig !== 'object') {
    return DEFAULT_DOWNLOAD_CONFIG;
  }

  const config = remoteConfig as Partial<Record<keyof OfficialDownloadConfig, unknown>>;

  return {
    // 远端字段必须是 https，避免被异常 JSON 注入到非官方或本地协议。
    githubReleasesUrl: isSafeHttpsUrl(config.githubReleasesUrl)
      ? config.githubReleasesUrl
      : DEFAULT_DOWNLOAD_CONFIG.githubReleasesUrl,
    bilibiliUrl: isSafeHttpsUrl(config.bilibiliUrl)
      ? config.bilibiliUrl
      : DEFAULT_DOWNLOAD_CONFIG.bilibiliUrl,
    douyinUrl: isSafeHttpsUrl(config.douyinUrl)
      ? config.douyinUrl
      : DEFAULT_DOWNLOAD_CONFIG.douyinUrl,
    // 远端字段缺失时必须回退到作者网盘，否则设置页会因为条件渲染而完全隐藏入口。
    netDiskUrl: isSafeHttpsUrl(config.netDiskUrl)
      ? config.netDiskUrl
      : DEFAULT_DOWNLOAD_CONFIG.netDiskUrl,
  };
}

export async function getOfficialDownloadConfig(): Promise<OfficialDownloadConfig> {
  if (!cachedConfigPromise) {
    cachedConfigPromise = fetch(DOWNLOAD_CONFIG_URL, { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`download.json 请求失败: ${response.status}`);
        }
        return response.json();
      })
      .then(mergeDownloadConfig)
      .catch((error) => {
        console.warn('读取官方下载配置失败，已降级到内置官方渠道:', error);
        return DEFAULT_DOWNLOAD_CONFIG;
      });
  }

  return cachedConfigPromise;
}
