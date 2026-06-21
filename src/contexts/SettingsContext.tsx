// ============================================================================
// 应用设置上下文 - 管理各种开关设置
// ============================================================================

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { APP_MODULE_META, DEFAULT_ACTIVE_MODULE_ID, type AppModuleId, type LayoutMode } from '../config/moduleMeta';

/** 应用设置 */
interface AppSettings {
  /** 首页布局模式：卡片式适合快速总览，页面式适合传统 PC 软件用户。 */
  layoutMode: LayoutMode;
  /** 页面式布局下当前激活的功能模块，保存在全局设置里用于切换后保持位置。 */
  activeModuleId: AppModuleId;
  /** 大目录分析深度 (2-4，默认 3) */
  hotspotDepth: number;
  /** 大目录大小阈值 MB (10-500，默认 50) */
  hotspotSizeThreshold: number;
  /** 深度扫描时是否忽略系统目录（默认 true，保持现有行为） */
  hotspotIgnoreSystemDirs: boolean;
  /** C 盘全盘分析最多展示变化目录数量（默认 300） */
  diskGrowthMaxEntries: number;
}

interface SettingsContextValue {
  /** 当前设置 */
  settings: AppSettings;
  /** 更新设置 */
  updateSettings: (updates: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const STORAGE_KEY = 'c-cleanup-settings';
const moduleIds = APP_MODULE_META.map(module => module.id);

/** 默认设置 */
const defaultSettings: AppSettings = {
  layoutMode: 'cards',
  activeModuleId: DEFAULT_ACTIVE_MODULE_ID,
  hotspotDepth: 3,     // 默认分析深度 3 层
  hotspotSizeThreshold: 50, // 默认 50MB
  hotspotIgnoreSystemDirs: true, // 默认忽略系统目录
  diskGrowthMaxEntries: 300, // 默认最多展示 300 个变化目录
};

function normalizeSettings(settings: AppSettings): AppSettings {
  const layoutMode: LayoutMode = settings.layoutMode === 'pages' ? 'pages' : 'cards';
  const activeModuleId = moduleIds.includes(settings.activeModuleId)
    ? settings.activeModuleId
    : DEFAULT_ACTIVE_MODULE_ID;

  return {
    ...settings,
    // 布局设置来自本地缓存，读取时收敛到已注册模块，避免旧缓存或手动篡改导致空页面。
    layoutMode,
    activeModuleId,
    // 这些设置会直接影响扫描结果数量，读取本地缓存时做边界收敛，避免手动篡改导致 UI 或后端压力异常。
    hotspotDepth: Math.min(4, Math.max(2, Number(settings.hotspotDepth) || defaultSettings.hotspotDepth)),
    hotspotSizeThreshold: Math.min(500, Math.max(10, Number(settings.hotspotSizeThreshold) || defaultSettings.hotspotSizeThreshold)),
    diskGrowthMaxEntries: Math.min(1000, Math.max(50, Number(settings.diskGrowthMaxEntries) || defaultSettings.diskGrowthMaxEntries)),
  };
}

interface SettingsProviderProps {
  children: ReactNode;
}

export function SettingsProvider({ children }: SettingsProviderProps) {
  // 从 localStorage 读取保存的设置
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          return normalizeSettings({ ...defaultSettings, ...JSON.parse(saved) });
        }
      } catch (e) {
        console.error('读取设置失败:', e);
      }
    }
    return defaultSettings;
  });

  // 更新设置
  const updateSettings = useCallback((updates: Partial<AppSettings>) => {
    setSettings(prev => {
      const newSettings = normalizeSettings({ ...prev, ...updates });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
      return newSettings;
    });
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings 必须在 SettingsProvider 内部使用');
  }
  return context;
}
