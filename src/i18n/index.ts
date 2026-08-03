// ============================================================================
// i18n 初始化
// 静态加载语言包，保证桌面端切换语言时无需等待网络或异步模块加载。
// ============================================================================

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCommon from './locales/zh/common.json';
import zhNav from './locales/zh/nav.json';
import zhSettings from './locales/zh/settings.json';
import zhJunkClean from './locales/zh/junkClean.json';
import zhModules from './locales/zh/modules.json';
import zhUi from './locales/zh/ui.json';
import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enSettings from './locales/en/settings.json';
import enJunkClean from './locales/en/junkClean.json';
import enModules from './locales/en/modules.json';
import enUi from './locales/en/ui.json';
import jaCommon from './locales/ja/common.json';
import jaNav from './locales/ja/nav.json';
import jaSettings from './locales/ja/settings.json';
import jaJunkClean from './locales/ja/junkClean.json';
import jaModules from './locales/ja/modules.json';
import jaUi from './locales/ja/ui.json';
import zhTWCommon from './locales/zh-TW/common.json';
import zhTWNav from './locales/zh-TW/nav.json';
import zhTWSettings from './locales/zh-TW/settings.json';
import zhTWJunkClean from './locales/zh-TW/junkClean.json';
import zhTWModules from './locales/zh-TW/modules.json';
import zhTWUi from './locales/zh-TW/ui.json';

export type Language = 'zh' | 'zh-TW' | 'en' | 'ja';

function getInitialLanguage(): Language {
  if (typeof window === 'undefined') return 'zh';
  try {
    const savedSettings = JSON.parse(localStorage.getItem('c-cleanup-settings') ?? '{}') as { language?: unknown };
    return savedSettings.language === 'en' || savedSettings.language === 'ja' || savedSettings.language === 'zh-TW'
      ? savedSettings.language
      : 'zh';
  } catch {
    // 本地设置损坏时回落中文，避免阻断应用启动。
    return 'zh';
  }
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      zh: { common: zhCommon, nav: zhNav, settings: zhSettings, junkClean: zhJunkClean, modules: zhModules, ui: zhUi },
      'zh-TW': { common: zhTWCommon, nav: zhTWNav, settings: zhTWSettings, junkClean: zhTWJunkClean, modules: zhTWModules, ui: zhTWUi },
      en: { common: enCommon, nav: enNav, settings: enSettings, junkClean: enJunkClean, modules: enModules, ui: enUi },
      ja: { common: jaCommon, nav: jaNav, settings: jaSettings, junkClean: jaJunkClean, modules: jaModules, ui: jaUi },
    },
    lng: getInitialLanguage(),
    fallbackLng: 'zh',
    supportedLngs: ['zh', 'zh-TW', 'en', 'ja'],
    ns: ['common', 'nav', 'settings', 'junkClean', 'modules', 'ui'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export default i18n;
