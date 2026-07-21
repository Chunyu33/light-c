// ============================================================================
// 作者官方渠道链接
// 远端 download.json 只用于更新这些入口；远端不可用时始终使用这里的安全兜底。
// ============================================================================

export interface OfficialProjectLinks {
  /** 项目展示名称。 */
  name: string;
  /** 作者网盘下载入口。 */
  quarkUrl: string;
  /** GitHub Releases 入口，部分项目可能暂未提供。 */
  githubReleasesUrl?: string;
}

/** 作者维护的项目下载入口，后续新增项目只需在这里补充。 */
export const OFFICIAL_PROJECT_LINKS: Record<string, OfficialProjectLinks> = {
  lightc: {
    name: 'LightC',
    quarkUrl: 'https://pan.quark.cn/s/bce8f722bf33',
    githubReleasesUrl: 'https://github.com/Chunyu33/light-c/releases',
  },
  viap: {
    name: 'Viap',
    quarkUrl: 'https://pan.quark.cn/s/4761ee4ba698',
    githubReleasesUrl: 'https://github.com/chunyu33/viap/releases',
  },
  binlockx: {
    name: 'BinlockX',
    quarkUrl: 'https://pan.quark.cn/s/4243a5142b29',
    githubReleasesUrl: 'https://github.com/chunyu33/binlockx/releases',
  },
  duoduomao: {
    name: '躲躲猫',
    quarkUrl: 'https://pan.quark.cn/s/3bdd5d36b71b',
  },
};

/** 作者本人平台入口，作为远端渠道配置缺失时的固定兜底。 */
export const OFFICIAL_PLATFORM_LINKS = {
  bilibili: 'https://space.bilibili.com/387797235',
  douyin: 'https://www.douyin.com/search/Evan%E7%9A%84%E5%83%8F%E7%B4%A0%E7%A9%BA%E9%97%B4',
} as const;

/** SecuritySettings 与更新提示共用的 LightC 默认下载配置。 */
export const LIGHTC_DEFAULT_DOWNLOAD_CONFIG = {
  githubReleasesUrl: OFFICIAL_PROJECT_LINKS.lightc.githubReleasesUrl,
  netDiskUrl: OFFICIAL_PROJECT_LINKS.lightc.quarkUrl,
  bilibiliUrl: OFFICIAL_PLATFORM_LINKS.bilibili,
  douyinUrl: OFFICIAL_PLATFORM_LINKS.douyin,
} as const;
