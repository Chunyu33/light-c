// ============================================================================
// 字体大小上下文 - 支持标准/适中/较大三档
// ============================================================================

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

/** 字体大小档位 */
export type FontSizeLevel = 'standard' | 'medium' | 'large';

/** 字体大小配置 */
interface FontSizeConfig {
  label: string;
  offset: number; // px
}

/** 字体大小档位配置 */
export const FONT_SIZE_CONFIGS: Record<FontSizeLevel, FontSizeConfig> = {
  standard: { label: '标准', offset: 0 },
  medium: { label: '适中', offset: 1 },
  large: { label: '较大', offset: 2 },
};

interface FontSizeContextValue {
  /** 当前字体大小档位 */
  level: FontSizeLevel;
  /** 设置字体大小档位 */
  setLevel: (level: FontSizeLevel) => void;
}

const FontSizeContext = createContext<FontSizeContextValue | null>(null);

const STORAGE_KEY = 'c-cleanup-font-size';

interface FontSizeProviderProps {
  children: ReactNode;
}

export function FontSizeProvider({ children }: FontSizeProviderProps) {
  // 从 localStorage 读取保存的字体大小档位
  const [level, setLevelState] = useState<FontSizeLevel>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'standard' || saved === 'medium' || saved === 'large') {
        return saved;
      }
    }
    return 'standard'; // 默认标准字号
  });

  // 设置字体大小档位
  const setLevel = useCallback((newLevel: FontSizeLevel) => {
    setLevelState(newLevel);
    localStorage.setItem(STORAGE_KEY, newLevel);
  }, []);

  // 应用字体大小到 document
  useEffect(() => {
    const offset = FONT_SIZE_CONFIGS[level].offset;
    document.documentElement.style.setProperty('--font-size-offset', `${offset}px`);
  }, [level]);

  return (
    <FontSizeContext.Provider value={{ level, setLevel }}>
      {children}
    </FontSizeContext.Provider>
  );
}

/** 使用字体大小 Hook */
export function useFontSize() {
  const context = useContext(FontSizeContext);
  if (!context) {
    throw new Error('useFontSize must be used within a FontSizeProvider');
  }
  return context;
}
