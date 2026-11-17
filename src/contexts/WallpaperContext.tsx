// ============================================================================
// 背景壁纸上下文
// 壁纸只管「背景」，与明暗/玻璃正交：深浅主题共用一张图，各自一套遮罩强度。
// 图片文件由后端复制到数据目录，这里只持久化展示配置 + 通过 asset 协议加载。
// ============================================================================

import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { clearWallpaper, getWallpaperPath, installWallpaper, pickWallpaperDialog } from '../api/commands';

/** 图片适配方式：等比填充裁切 / 等比完整留边 / 原始尺寸居中 */
export type WallpaperFit = 'cover' | 'contain' | 'center';

/** 展示配置（图片本身不在 localStorage，避免几 MB 的 base64 卡住设置读取） */
interface WallpaperSettings {
  fit: WallpaperFit;
  /** 浅色主题遮罩强度 0-100，越大越白、文字越清楚 */
  dimLight: number;
  /** 深色主题遮罩强度 0-100，越大越黑 */
  dimDark: number;
}

interface WallpaperContextValue extends WallpaperSettings {
  /** 当前壁纸的 asset URL；空串表示没有壁纸 */
  url: string;
  /** 是否已安装壁纸 */
  active: boolean;
  /** 选图并安装；取消或失败不改动现有配置 */
  choose: () => Promise<void>;
  /** 清除壁纸，回到纯色背景 */
  remove: () => Promise<void>;
  setFit: (fit: WallpaperFit) => void;
  setDimLight: (value: number) => void;
  setDimDark: (value: number) => void;
}

const WallpaperContext = createContext<WallpaperContextValue | null>(null);

const SETTINGS_KEY = 'c-cleanup-wallpaper';
const DEFAULT_SETTINGS: WallpaperSettings = {
  fit: 'cover',
  dimLight: 55,
  dimDark: 50,
};

function readSettings(): WallpaperSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(saved) as Partial<WallpaperSettings>;
    const clamp = (value: unknown, fallback: number) =>
      Number.isFinite(value) ? Math.min(100, Math.max(0, Math.floor(Number(value)))) : fallback;
    return {
      fit: parsed.fit === 'contain' || parsed.fit === 'center' ? parsed.fit : 'cover',
      dimLight: clamp(parsed.dimLight, DEFAULT_SETTINGS.dimLight),
      dimDark: clamp(parsed.dimDark, DEFAULT_SETTINGS.dimDark),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function WallpaperProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<WallpaperSettings>(readSettings);
  const [url, setUrl] = useState('');
  /**
   * 换图版本号。壁纸文件名固定（wallpaper.png），换图后 convertFileSrc 返回的还是同一个
   * URL，浏览器会直接命中缓存继续显示旧图 —— 必须靠递增的查询参数强制重新请求。
   * asset 协议只取 URL 的 path（query 被忽略），所以加参数不影响后端取文件。
   */
  // 初值用时间戳而不是 0：WebView 的磁盘缓存在重启后仍然存在，
  // 如果每次启动都是同一个 `?v=0`，换了图重启后可能又显示缓存里的旧图。
  const [revision, setRevision] = useState(() => Date.now());

  // 启动时向后端要壁纸路径：文件在数据目录里，便携版换机器也能跟着走。
  // 后端返回空串说明没装过，保持纯色背景。
  useEffect(() => {
    let cancelled = false;
    getWallpaperPath()
      .then((path) => {
        if (!cancelled && path) setUrl(convertFileSrc(path));
      })
      .catch((error) => console.error('读取壁纸失败:', error));
    return () => {
      cancelled = true;
    };
  }, []);

  // 把配置同步到根节点：壁纸层是纯 CSS 画的，React 只负责改变量和 class。
  // 这样切换主题/适配方式不会重挂载主界面，扫描中的模块状态不掉。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('has-wallpaper', Boolean(url));
    const versionedUrl = url ? `${url}?v=${revision}` : '';
    root.style.setProperty('--wallpaper-image', versionedUrl ? `url("${versionedUrl}")` : 'none');
    root.style.setProperty('--wallpaper-size', settings.fit === 'center' ? 'auto' : settings.fit);
    // 遮罩必须注入成完整的 linear-gradient 字符串，不能塞裸 rgba 变量。
    // ⚠️ 实测：background-image 里用 var(--x) 展开 rgba(...) 会让整条声明失效
    // （遮罩和图片一起消失、只剩纯色底）；gradient 属于 image 类型，能正常展开。
    const lightScrim = `rgba(255, 255, 255, ${settings.dimLight / 100})`;
    const darkScrim = `rgba(0, 0, 0, ${settings.dimDark / 100})`;
    root.style.setProperty('--wallpaper-scrim-light', `linear-gradient(${lightScrim}, ${lightScrim})`);
    root.style.setProperty('--wallpaper-scrim-dark', `linear-gradient(${darkScrim}, ${darkScrim})`);
    // ⚠️ revision 必须进依赖：换图时文件名不变 → url 字符串不变，
    // 只靠 url 不会重跑这个 effect，新版本号永远注入不进去（换图不刷新的直接原因）。
  }, [url, revision, settings]);

  // 配置变更统一持久化；图片 URL 是运行时状态，不写盘。
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.error('保存壁纸设置失败:', error);
    }
  }, [settings]);

  const update = useCallback(<K extends keyof WallpaperSettings>(key: K, value: WallpaperSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const choose = useCallback(async () => {
    const picked = await pickWallpaperDialog();
    if (!picked) return;
    const savedPath = await installWallpaper(picked);
    setUrl(convertFileSrc(savedPath));
    // 同上：递增版本号，让新图绕过旧 URL 的缓存。
    setRevision((current) => current + 1);
  }, []);

  const remove = useCallback(async () => {
    await clearWallpaper();
    setUrl('');
  }, []);

  const value = useMemo<WallpaperContextValue>(() => ({
    ...settings,
    url,
    active: Boolean(url),
    choose,
    remove,
    setFit: (fit) => update('fit', fit),
    setDimLight: (dimLight) => update('dimLight', dimLight),
    setDimDark: (dimDark) => update('dimDark', dimDark),
  }), [settings, url, choose, remove, update]);

  return <WallpaperContext.Provider value={value}>{children}</WallpaperContext.Provider>;
}

export function useWallpaper(): WallpaperContextValue {
  const context = useContext(WallpaperContext);
  if (!context) throw new Error('useWallpaper 必须在 WallpaperProvider 内部使用');
  return context;
}
