// ============================================================================
// 字体大小上下文 - 支持预设档位和自定义字号
// ============================================================================

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';

/** 字体大小档位 */
export type FontSizeLevel = 'standard' | 'medium' | 'large' | 'custom';

export const CUSTOM_FONT_SIZE_MIN = 10;
export const CUSTOM_FONT_SIZE_MAX = 18;
export const DEFAULT_CUSTOM_FONT_SIZE = 14;

/** 字体大小配置 */
interface FontSizeConfig {
  label: string;
  offset: number; // px
  baseSize: number; // px
}

/** 字体大小档位配置 */
export const FONT_SIZE_CONFIGS: Record<FontSizeLevel, FontSizeConfig> = {
  standard: { label: '标准', offset: 0, baseSize: 14 },
  medium: { label: '适中', offset: 1, baseSize: 14 },
  large: { label: '较大', offset: 2, baseSize: 14 },
  custom: { label: '自定义', offset: 0, baseSize: 14 },
};

interface FontSizeContextValue {
  /** 当前字体大小档位 */
  level: FontSizeLevel;
  /** 设置字体大小档位 */
  setLevel: (level: FontSizeLevel) => void;
  /** 当前自定义字号，单位为 px */
  customFontSize: number;
  /** 设置自定义字号，内部会限制在允许范围内 */
  setCustomFontSize: (size: number) => void;
}

const FontSizeContext = createContext<FontSizeContextValue | null>(null);

const STORAGE_KEY = 'c-cleanup-font-size';
const CUSTOM_SIZE_STORAGE_KEY = 'c-cleanup-custom-font-size';

interface FontSizeProviderProps {
  children: ReactNode;
}

export function FontSizeProvider({ children }: FontSizeProviderProps) {
  // 从 localStorage 读取保存的字体大小档位
  const [level, setLevelState] = useState<FontSizeLevel>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'standard' || saved === 'medium' || saved === 'large' || saved === 'custom') {
        return saved;
      }
    }
    return 'standard'; // 默认标准字号
  });
  const [customFontSize, setCustomFontSizeState] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const savedValue = localStorage.getItem(CUSTOM_SIZE_STORAGE_KEY);
      const savedSize = Number(savedValue);
      if (savedValue !== null && Number.isFinite(savedSize)) {
        return Math.min(CUSTOM_FONT_SIZE_MAX, Math.max(CUSTOM_FONT_SIZE_MIN, Math.round(savedSize)));
      }
    }
    return DEFAULT_CUSTOM_FONT_SIZE;
  });

  // 设置字体大小档位
  const setLevel = useCallback((newLevel: FontSizeLevel) => {
    setLevelState(newLevel);
    localStorage.setItem(STORAGE_KEY, newLevel);
  }, []);

  const setCustomFontSize = useCallback((nextSize: number) => {
    const normalizedSize = Math.min(CUSTOM_FONT_SIZE_MAX, Math.max(CUSTOM_FONT_SIZE_MIN, Math.round(nextSize)));
    setCustomFontSizeState(normalizedSize);
    localStorage.setItem(CUSTOM_SIZE_STORAGE_KEY, String(normalizedSize));
  }, []);

  // 应用字体大小到 document
  useEffect(() => {
    const offset = level === 'custom'
      ? customFontSize - FONT_SIZE_CONFIGS.standard.baseSize
      : FONT_SIZE_CONFIGS[level].offset;
    // 基础字号保持 14px，只调整偏移量，避免自定义字号被计算两次。
    document.documentElement.style.setProperty('--font-size-offset', `${offset}px`);
    document.documentElement.style.setProperty('--base-font-size', `${FONT_SIZE_CONFIGS.standard.baseSize}px`);
  }, [customFontSize, level]);

  return (
    <FontSizeContext.Provider value={{ level, setLevel, customFontSize, setCustomFontSize }}>
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
