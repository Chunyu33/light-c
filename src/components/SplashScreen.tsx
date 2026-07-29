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

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const { theme } = useTheme();
  const { t } = useTranslation('ui');
  const [isExiting, setIsExiting] = useState(false);

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
      className={`splash-screen splash-screen--${theme}${isExiting ? ' splash-screen--exiting' : ''}`}
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
