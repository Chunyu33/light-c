// ============================================================================
// 社交软件清理：扫描后的默认勾选规则
//
// Issue #108 的回归用例：微信 4.x 只留在 temp/RWTemp 里的一份文档，会被归到
// 「传输文件 / 谨慎清理」。它必须**可以手动勾选**，但**不能默认勾选** ——
// 否则用户一路点确认，唯一副本就没了。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { isSelectedByDefault } from './socialScanResult';
import type { SocialFileEntry } from '../api/commands';

/** 只填判定用得到的字段，其余给一个中性默认值 */
function entry(riskLevel: SocialFileEntry['risk_level'], deletable: boolean): SocialFileEntry {
  return {
    path: `C:\\data\\${riskLevel}.bin`,
    size: 1024,
    app_name: '微信',
    category: 'file_transfer',
    risk_level: riskLevel,
    deletable,
  };
}

describe('isSelectedByDefault', () => {
  it('传输文件（谨慎清理）可勾选，但默认不勾选', () => {
    const document = entry('medium', true);
    expect(document.deletable).toBe(true);
    expect(isSelectedByDefault(document)).toBe(false);
  });

  it('聊天记录既不可勾选，也不默认勾选', () => {
    expect(isSelectedByDefault(entry('critical', false))).toBe(false);
  });

  it('图片视频与临时缓存按既有策略默认勾选', () => {
    expect(isSelectedByDefault(entry('low', true))).toBe(true);
    expect(isSelectedByDefault(entry('none', true))).toBe(true);
  });

  it('后端标成不可删除的文件，无论什么等级都不默认勾选', () => {
    expect(isSelectedByDefault(entry('low', false))).toBe(false);
  });
});
