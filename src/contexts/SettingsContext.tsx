// ============================================================================
// 应用设置上下文 - 管理各种开关设置
// ============================================================================

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

/** 应用设置 */
interface AppSettings {
  /** 是否显示锚点导航 */
  showAnchorNav: boolean;
}

interface SettingsContextValue {
  /** 当前设置 */
  settings: AppSettings;
  /** 更新设置 */
  updateSettings: (updates: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const STORAGE_KEY = 'c-cleanup-settings';

/** 默认设置 */
const defaultSettings: AppSettings = {
  showAnchorNav: false, // 默认关闭
};

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
          return { ...defaultSettings, ...JSON.parse(saved) };
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
      const newSettings = { ...prev, ...updates };
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
