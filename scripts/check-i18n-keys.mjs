// i18n 键校验：按「文件用的命名空间 + 代码里引用的键路径」去查四语言 JSON。
//
// 为什么需要它：i18next 找不到键时**不会报错**，而是把键名原样显示在界面上
// （例如按钮上出现 "aiAssistant.removeKey"）。tsc 和构建都看不到这类问题。
//
// 用法：node scripts/check-i18n-keys.mjs（或 npm run check:i18n）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const langs = ['zh', 'en', 'ja', 'zh-TW'];
const nsDir = path.join(root, 'src/i18n/locales');

// 数组当叶子：guide.notes 这类是数组，展开成 .0/.1 会让路径判据失效
const flat = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flat(v, key) : [key];
  });

const nsKeys = {};
for (const file of fs.readdirSync(path.join(nsDir, 'zh')).filter((f) => f.endsWith('.json'))) {
  const name = file.replace('.json', '');
  nsKeys[name] = Object.fromEntries(
    langs.map((lang) => [
      lang,
      new Set(flat(JSON.parse(fs.readFileSync(path.join(nsDir, lang, file), 'utf8')))),
    ]),
  );
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(path.join(dir, entry.name))
      : entry.name.endsWith('.tsx')
        ? [path.join(dir, entry.name)]
        : [],
  );

const problems = [];
for (const file of walk(path.join(root, 'src'))) {
  const text = fs.readFileSync(file, 'utf8');
  // common 是全局加载的，任何文件都可能用它；其余按 useTranslation 收集。
  // 还要认 prop 注入的翻译函数：`t: TFunction<'modules'>` 的泛型参数就是它的命名空间
  // （LeftoverWhitelistModal 这类子组件就是靠这个拿 t 的）。
  const namespaces = [
    'common',
    ...new Set([
      ...[...text.matchAll(/useTranslation\(\s*['"](\w+)['"]\s*\)/g)].map((match) => match[1]),
      ...[...text.matchAll(/:\s*TFunction<\s*['"](\w+)['"]/g)].map((match) => match[1]),
    ]),
  ];

  for (const match of text.matchAll(/\b(?:t|moduleT|commonT)\(\s*['"`]([A-Za-z][\w.]*)['"`]/g)) {
    const key = match[1];
    if (!key.includes('.')) continue;
    // 键在这个文件用到的**所有**命名空间里都缺失，才算问题
    const missingEverywhere = namespaces.every((ns) =>
      langs.some((lang) => !nsKeys[ns]?.[lang]?.has(key)),
    );
    if (!missingEverywhere) continue;
    const elsewhere = Object.keys(nsKeys).filter(
      (ns) => !namespaces.includes(ns) && nsKeys[ns].zh.has(key),
    );
    problems.push(
      elsewhere.length
        ? `${path.relative(root, file)}  ${key}  ✗ 放错命名空间（在 ${elsewhere.join('/')} 里，文件用的是 ${namespaces.join('/')}）`
        : `${path.relative(root, file)}  ${key}  ✗ 四语言都找不到`,
    );
  }
}

// 语言之间键不一致（漏翻 / 多出来的键）
for (const [namespace, byLang] of Object.entries(nsKeys)) {
  const base = byLang.zh;
  for (const lang of langs.slice(1)) {
    const missing = [...base].filter((key) => !byLang[lang].has(key));
    const extra = [...byLang[lang]].filter((key) => !base.has(key));
    if (missing.length || extra.length) {
      problems.push(`${namespace}.json  ${lang}: 缺[${missing}] 多[${extra}]`);
    }
  }
}

if (problems.length === 0) {
  console.log('✓ i18n 键全部有效，四语言一致');
} else {
  console.log(problems.join('\n'));
  console.log(`\n共 ${problems.length} 个问题`);
}
process.exitCode = problems.length ? 1 : 0;
