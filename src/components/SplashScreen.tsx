// ============================================================================
// 单窗口启动屏
// 只保留品牌 Logo、轻量渐变背景和作者平台信息，避免启动阶段创建第二个 WebView。
// ============================================================================

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../contexts';

const SPLASH_DURATION = 1400;
const SPLASH_EXIT_DURATION = 220;

interface SplashScreenProps {
  onComplete?: () => void;
}

/**
 * 读取启动屏当前主题。
 *
 * 中文说明：index.html 的静态启动屏会在 React 接管前先按用户主题写好
 * `splash-screen--light|dark`，这里优先读取 DOM 上的既有值，保证首帧渲染与静态节点完全一致，
 * 否则 hydrateRoot 会报 "Hydration failed"。只有拿不到 DOM 信息时才回退到主题上下文。
 */
function readPrerenderedSplashTheme(fallback: string): string {
  const classList = document.getElementById('initial-splash')?.classList;
  if (!classList) return fallback;
  if (classList.contains('splash-screen--light')) return 'light';
  if (classList.contains('splash-screen--dark')) return 'dark';
  return fallback;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const { theme } = useTheme();
  const { t } = useTranslation('ui');
  const [isExiting, setIsExiting] = useState(false);
  const [splashTheme] = useState(() => readPrerenderedSplashTheme(theme));

  useEffect(() => {
    const startedAt = Number(document.documentElement.dataset.splashStartedAt);
    const elapsed = Number.isFinite(startedAt) ? Math.max(0, performance.now() - startedAt) : 0;
    const exitDelay = Math.max(0, SPLASH_DURATION - elapsed);
    const completeDelay = Math.max(0, SPLASH_DURATION + SPLASH_EXIT_DURATION - elapsed);
    const exitTimer = window.setTimeout(() => setIsExiting(true), exitDelay);
    const completeTimer = window.setTimeout(() => {
      onComplete?.();
    }, completeDelay);

    // 同时清理两个计时器，避免组件卸载后仍触发页面切换。
    return () => {
      window.clearTimeout(exitTimer);
      window.clearTimeout(completeTimer);
    };
  }, [onComplete]);

  return (
    <div
      id="initial-splash"
      className={`splash-screen splash-screen--${splashTheme}${isExiting ? ' splash-screen--exiting' : ''}`}
      role="status"
      aria-label="LightC"
    >
      <div className="splash-screen__aurora splash-screen__aurora--one" aria-hidden="true" />
      <div className="splash-screen__aurora splash-screen__aurora--two" aria-hidden="true" />

      <div className="splash-screen__content">
        <img className="splash-screen__logo" src="/logo.svg" alt="LightC" />
        <p id="splash-slogan" className="splash-screen__slogan">{t('splashSlogan')}</p>
        <div className="splash-screen__platform" aria-label="Evan的像素空间">
          {/* <span className="splash-screen__author">Evan的像素空间</span> */}
          <span className="splash-screen__channel">Bilibili · @Evan的像素空间</span>
        </div>
      </div>
    </div>
  );
}

export default SplashScreen;
