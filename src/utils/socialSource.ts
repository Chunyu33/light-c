// ============================================================================
// 社交软件来源名归一化
//
// 后端各适配器上报的 app_name 对「同一个应用」存在多种写法：
//   - 微信：微信 3.x 上报 "微信"，微信 4.x 上报 "WeChat"
//   - 钉钉：上报 "钉钉" 或 "DingTalk"
// 若直接按 app_name 分组，筛选器会出现两个指向同一应用的标签，用户无从选择。
// 这里把原始 app_name 映射为稳定的来源 key，再由 i18n 决定展示文案。
//
// 注意：QQ 与 NTQQ 是两个可共存的独立客户端，不是同一应用的两种写法，
// 因此保持为两个独立来源，不做合并。
// ============================================================================

/** 原始 app_name（小写）→ 稳定来源 key */
const SOURCE_KEY_MAP: Record<string, string> = {
  // 微信 3.x / 4.x
  微信: 'wechat',
  wechat: 'wechat',
  // 钉钉中英文名
  钉钉: 'dingtalk',
  dingtalk: 'dingtalk',
  企业微信: 'wxwork',
  wxwork: 'wxwork',
  飞书: 'feishu',
  feishu: 'feishu',
  // 以下应用后端已使用稳定英文名，映射为自身以复用同一套 key 校验
  qq: 'qq',
  ntqq: 'ntqq',
  telegram: 'telegram',
  line: 'line',
  whatsapp: 'whatsapp',
};

/** 已收录的稳定来源 key，用于判断是否需要走 i18n 翻译 */
const KNOWN_SOURCE_KEYS = new Set(Object.values(SOURCE_KEY_MAP));

/**
 * 把后端上报的 app_name 归一化为稳定来源 key。
 *
 * 未收录的应用（例如后续新增的适配器）原样返回，
 * 这样筛选器仍然能按它分组，不会因为漏配映射而丢数据。
 */
export function getSourceKey(appName: string): string {
  const trimmed = appName.trim();
  if (trimmed.length === 0) {
    return appName;
  }
  return SOURCE_KEY_MAP[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * 把来源 key 转换为当前语言下的展示名。
 *
 * 未收录的 key 原样返回，保证新增应用在补齐文案前也能正常展示。
 */
export function getSourceLabel(
  sourceKey: string,
  translate: (key: string) => string,
): string {
  if (!KNOWN_SOURCE_KEYS.has(sourceKey)) {
    return sourceKey;
  }
  return translate(`social.app.${sourceKey}`);
}
