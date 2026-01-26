// ============================================================================
// 主题切换组件
// ============================================================================

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemeMode } from '../contexts';

const themes: { mode: ThemeMode; icon: typeof Sun; label: string }[] = [
  { mode: 'light', icon: Sun, label: '浅色' },
  { mode: 'dark', icon: Moon, label: '深色' },
  { mode: 'system', icon: Monitor, label: '系统' },
];

export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-gray-200 dark:bg-white/10">
      {themes.map(({ mode: m, icon: Icon, label }) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          title={label}
          className={`p-1.5 rounded transition-all ${
            mode === m
              ? 'bg-white dark:bg-white/20 text-emerald-600 dark:text-emerald-400 shadow-sm'
              : 'text-gray-600 dark:text-white/40 hover:text-gray-800 dark:hover:text-white/60'
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  );
}
