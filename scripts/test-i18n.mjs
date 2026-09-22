import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createInstance } from 'i18next';

const languages = ['zh', 'zh-TW', 'en', 'ja'];
const driverSource = readFileSync(new URL('../src/components/modules/DriverCleanupModule.tsx', import.meta.url), 'utf8');
// 从实际调用收集键，避免测试只验证正确模板，却漏掉页面引用了不存在的键。
const driverKeys = [...new Set([...driverSource.matchAll(/moduleT\('([^']+)'/g)].map((match) => match[1]))];

function readMessages(language, namespace) {
  return JSON.parse(readFileSync(new URL(`../src/i18n/locales/${language}/${namespace}.json`, import.meta.url), 'utf8'));
}

function assertRendered(translation, expectedParts) {
  // 未替换的占位符必须报错，不能通过空串兜底掩盖模板与调用不一致的问题。
  assert.doesNotMatch(translation, /\{\{.*?\}\}/);
  for (const part of expectedParts) assert.ok(translation.includes(part), `Missing ${part}: ${translation}`);
}

for (const language of languages) {
  const translator = createInstance();
  // 禁用跨语言回退，确保每种语言自身的资源完整，而不是被中文资源掩盖。
  await translator.init({
    lng: language,
    fallbackLng: false,
    resources: {
      [language]: { modules: readMessages(language, 'modules'), junkClean: readMessages(language, 'junkClean') },
    },
    interpolation: { escapeValue: false },
  });

  for (const count of [0, 1, 1234]) {
    test(`${language}: social confirmation renders count ${count} and size`, () => {
      const formattedCount = count.toLocaleString('en-US');
      const rendered = translator.t('social.confirmDeleteDesc', { ns: 'modules', count: formattedCount, size: '2.50 GB' });
      assertRendered(rendered, [formattedCount, '2.50 GB']);
    });

    test(`${language}: driver confirmation renders count ${count}`, () => {
      const rendered = translator.t('driverUi.confirmDeleteDesc', { ns: 'modules', count });
      assertRendered(rendered, [String(count)]);
    });
  }

  for (const suffixes of [{ blocked: '', reboot: '' }, { blocked: 'FAILED', reboot: 'REBOOT' }]) {
    test(`${language}: cleanup result renders optional notices ${JSON.stringify(suffixes)}`, () => {
      const rendered = translator.t('toast.cleanDoneDesc', { ns: 'junkClean', summary: '2.50 GB', ...suffixes });
      assertRendered(rendered, ['2.50 GB', suffixes.blocked, suffixes.reboot]);
    });
  }

  test(`${language}: all driver UI translation keys exist`, () => {
    for (const key of driverKeys) assert.ok(translator.exists(key, { ns: 'modules' }), `Missing ${language}: ${key}`);
  });

  test(`${language}: driver restore result retains the backend message`, () => {
    // 检查实际调用的键，既验证恢复结果插值，也防止误用另一个前缀下的同名键。
    const restoreKey = driverKeys.find((key) => key.endsWith('.restoreDesc'));
    assert.ok(restoreKey);
    assertRendered(translator.t(restoreKey, { ns: 'modules', message: 'RESTORE_RESULT' }), ['RESTORE_RESULT']);
  });

  test(`${language}: model deletion still renders name and size`, () => {
    // 三个模块曾共用同名末级键，保留模型场景回归，避免再次误改其他模块模板。
    assertRendered(translator.t('aiModels.confirmDeleteDesc', {
      ns: 'modules', name: 'model <test> & sample', size: '2.50 GB',
    }), ['model <test> & sample', '2.50 GB']);
  });
}
