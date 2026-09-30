// ============================================================================
// 主题上下文 - 支持浅色/深色/跟随系统
// ============================================================================

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

/** 主题类型 */
export type ThemeMode = 'light' | 'dark' | 'system';

/** 实际应用的主题 */
export type AppliedTheme = 'light' | 'dark';

interface ThemeContextValue {
  /** 用户选择的主题模式 */
  mode: ThemeMode;
  /** 实际应用的主题 */
  theme: AppliedTheme;
  /** 设置主题模式 */
  setMode: (mode: ThemeMode) => void;
  /** 液态玻璃外观是否开启（与明暗模式正交，默认关闭） */
  glass: boolean;
  /** 开关液态玻璃 */
  setGlass: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'c-cleanup-theme';
/** 液态玻璃单独持久化：它与明暗模式是两个正交的轴，切换明暗不该影响这个开关 */
const GLASS_STORAGE_KEY = 'c-cleanup-glass';

/** 获取系统主题 */
function getSystemTheme(): AppliedTheme {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

/** 根据模式获取实际主题 */
function resolveTheme(mode: ThemeMode): AppliedTheme {
  if (mode === 'system') {
    return getSystemTheme();
  }
  return mode;
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  // 从localStorage读取保存的主题模式
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        return saved;
      }
    }
    return 'dark'; // 默认深色主题
  });

  const [theme, setTheme] = useState<AppliedTheme>(() => resolveTheme(mode));

  // 液态玻璃默认关闭：backdrop-filter 需要合成器持续重新采样背景，
  // 在低配设备上会明显掉帧，所以必须是用户主动开启，不能默认打开。
  const [glass, setGlassState] = useState<boolean>(
    () => localStorage.getItem(GLASS_STORAGE_KEY) === 'enabled',
  );

  // 切换玻璃并持久化，写法与上面的 setMode 保持一致
  const setGlass = useCallback((enabled: boolean) => {
    setGlassState(enabled);
    localStorage.setItem(GLASS_STORAGE_KEY, enabled ? 'enabled' : 'disabled');
  }, []);

  // 设置主题模式
  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    localStorage.setItem(STORAGE_KEY, newMode);
  }, []);

  // 监听系统主题变化
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = () => {
      if (mode === 'system') {
        setTheme(getSystemTheme());
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [mode]);

  // 当模式改变时更新实际主题
  useEffect(() => {
    setTheme(resolveTheme(mode));
  }, [mode]);

  // 应用主题到document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
  }, [theme]);

  // 玻璃开关只切换 html 上的标记类，具体配色、模糊半径和背景层都由 App.css 的 .glass 规则统一负责，
  // 这样新增表面时不需要再写任何 JS 逻辑。
  useEffect(() => {
    document.documentElement.classList.toggle('glass', glass);
  }, [glass]);

  return (
    <ThemeContext.Provider value={{ mode, theme, setMode, glass, setGlass }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** 使用主题Hook */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
