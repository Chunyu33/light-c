// ============================================================================
// i18n 占位符审计脚本
//
// 背景：i18next 在缺少插值参数时不会报错，而是把 {{name}} 原样显示出来。
// 本项目曾因此出现弹窗直接显示 "{{name}}" 的线上问题，所以需要一个静态检查：
//
//   1. 语言包内部：zh / zh-TW / en / ja 的 key 是否对齐，同一 key 的占位符是否一致
//   2. 调用处：t('key', {...}) 传的参数是否覆盖文案里的占位符
//   3. key 是否存在、命名空间是否匹配
//
// 用法：node scripts/i18n-audit.js
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = path.join(ROOT, 'src', 'i18n', 'locales');
const SRC_DIR = path.join(ROOT, 'src');

/** 语言包在 i18n/index.ts 里注册的命名空间 */
const NAMESPACES = ['common', 'nav', 'settings', 'junkClean', 'modules', 'ui'];
const LANGUAGES = ['zh', 'zh-TW', 'en', 'ja'];
const DEFAULT_NS = 'common';
const INTERPOLATION_NS = 'common'; // useTranslation 默认从 common 取插值格式配置

/** 与 i18n/index.ts 的 interpolation 配置保持一致 */
const PREFIX = '{{';
const SUFFIX = '}}';

const issues = [];
const stats = { filesScanned: 0, callsFound: 0, staticCalls: 0, dynamicCalls: 0 };

function report(level, file, line, message) {
  issues.push({ level, file, line, message });
}

// ---------------------------------------------------------------------------
// 语言包加载
// ---------------------------------------------------------------------------

/** 读取所有语言包并扁平化成 { ns: { lang: { 'a.b.c': 'text' } } } */
function loadLocales() {
  const byNs = {};
  for (const ns of NAMESPACES) {
    byNs[ns] = {};
    for (const lang of LANGUAGES) {
      const file = path.join(LOCALES_DIR, lang, `${ns}.json`);
      if (!fs.existsSync(file)) {
        report('error', path.relative(ROOT, file), 0, `语言包文件缺失`);
        byNs[ns][lang] = {};
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        report('error', path.relative(ROOT, file), 0, `JSON 解析失败：${error.message}`);
        byNs[ns][lang] = {};
        continue;
      }
      byNs[ns][lang] = flatten(parsed, '');
    }
  }
  return byNs;
}

/** 把嵌套对象扁平化成点号路径，非字符串叶子会被忽略并单独报告 */
function flatten(node, prefix, out = {}, fileLabel = '') {
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[fullKey] = value;
    } else if (value && typeof value === 'object') {
      flatten(value, fullKey, out, fileLabel);
    } else {
      report('warn', fileLabel, 0, `非字符串文案（${typeof value}）：${fullKey}`);
    }
  }
  return out;
}

/** 提取文案里的插值变量名，兼容 i18next 的 {{var}} / {{ var }} 写法 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_$.-]+)\s*\}\}/g;
function extractPlaceholders(text) {
  const found = new Set();
  let match;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    found.add(match[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 语言包一致性检查
// ---------------------------------------------------------------------------

function checkLocaleAlignment(byNs) {
  for (const ns of NAMESPACES) {
    const languagesPresent = Object.keys(byNs[ns]).filter((l) => Object.keys(byNs[ns][l]).length > 0);
    if (languagesPresent.length === 0) continue;

    // 以 zh 为基准；zh 缺失则退回第一个有内容的语言
    const base = byNs[ns]['zh'] && Object.keys(byNs[ns]['zh']).length > 0 ? 'zh' : languagesPresent[0];
    const baseKeys = Object.keys(byNs[ns][base]);

    // key 缺失 / 多余
    for (const lang of LANGUAGES) {
      const target = byNs[ns][lang];
      if (!target) continue;
      for (const key of baseKeys) {
        if (!(key in target)) {
          report('error', `i18n/locales/${lang}/${ns}.json`, 0, `缺少 key（${base} 有）：${key}`);
        }
      }
      for (const key of Object.keys(target)) {
        if (!(key in byNs[ns][base])) {
          report('warn', `i18n/locales/${lang}/${ns}.json`, 0, `多余 key（${base} 没有）：${key}`);
        }
      }
    }

    // 同一 key 的占位符集合必须跨语言一致，否则切语言会漏变量
    for (const key of baseKeys) {
      const baseSet = extractPlaceholders(byNs[ns][base][key]);
      for (const lang of LANGUAGES) {
        if (lang === base) continue;
        const text = byNs[ns][lang]?.[key];
        if (text === undefined) continue;
        const targetSet = extractPlaceholders(text);
        const missing = [...baseSet].filter((v) => !targetSet.has(v));
        const extra = [...targetSet].filter((v) => !baseSet.has(v));
        if (missing.length || extra.length) {
          const detail = [
            missing.length ? `缺少 ${missing.join(', ')}` : '',
            extra.length ? `多出 ${extra.join(', ')}` : '',
          ].filter(Boolean).join('；');
          report('warn', `i18n/locales/${lang}/${ns}.json`, 0, `占位符与 ${base} 不一致（${key}）：${detail}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 调用处检查
// ---------------------------------------------------------------------------

/**
 * 从 useTranslation('ns') 推断每个 t 变量对应的 namespace。
 *
 * 注意 1：不能用 isIdentifier(node.name) 做前置过滤——`const { t } = useTranslation()`
 * 的名字是解构模式（ObjectBindingPattern），不是 Identifier，那样会漏掉所有正常写法。
 *
 * 注意 2：必须按词法作用域解析。同一文件里可能有多个组件各自 `const { t } = useTranslation('x')`，
 * 例如 AboutSettings.tsx 主组件用 settings、底部子组件用 ui。若按文件级覆盖，
 * 后声明的会污染前面的调用，产出大量假报错。
 * 这里采用「按函数体建立作用域链」的做法：进入函数时压栈它内部的 t 映射，
 * 查找时沿作用域链由内向外找。
 */
function collectTranslators(sourceFile) {
  const hooksByScope = new Map(); // scopeNode -> Map<tVarName, ns>

  const isUseTranslationCall = (call) => {
    const callee = call.expression;
    return (ts.isIdentifier(callee) && callee.text === 'useTranslation')
      || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'useTranslation');
  };

  /** 找出某个作用域节点（函数/箭头函数体）直接声明的 t 映射，不递归进嵌套函数 */
  const scanScopeDeclarations = (scopeNode, result) => {
    const walk = (node) => {
      // 遇到嵌套函数就停下，它属于更内层的作用域
      if (node !== scopeNode && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && node.initializer
        && ts.isObjectBindingPattern(node.name) && ts.isCallExpression(node.initializer)
        && isUseTranslationCall(node.initializer)) {
        const nsArg = node.initializer.arguments[0];
        const ns = nsArg && ts.isStringLiteralLike(nsArg) ? nsArg.text : DEFAULT_NS;
        for (const el of node.name.elements) {
          // 支持 `{ t }` 与 `{ t: moduleT }` 两种解构写法
          if (el.name && ts.isIdentifier(el.name)) result.set(el.name.text, ns);
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(scopeNode, walk);
  };

  // 先为每个作用域（SourceFile + 每个函数）预计算声明
  const visit = (node) => {
    if (ts.isSourceFile(node) || ts.isFunctionLike(node)) {
      const decls = new Map();
      scanScopeDeclarations(node, decls);
      if (decls.size > 0) hooksByScope.set(node, decls);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return hooksByScope;
}

/**
 * 沿 AST 父链由内向外查找 t 变量所属的 namespace。
 * 返回 null 表示这个 t 不是来自 useTranslation（可能是普通局部变量），应跳过。
 */
function resolveTranslatorNs(node, hooksByScope) {
  let current = node;
  while (current) {
    // 从最近的函数作用域开始，逐层向外
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) {
      const decls = hooksByScope.get(current);
      if (decls) {
        const name = node.text;
        if (decls.has(name)) return decls.get(name);
      }
    }
    current = current.parent;
  }
  return null;
}

/** 取得字符串字面量的值 */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * 解析调用参数对象里的 key 名，只认静态可判定的：
 * { size: x }、{ 'size': x }、{ ...spread }
 * 返回 { keys: Set<string>, hasSpread: boolean }
 */
function collectObjectKeys(objLiteral) {
  const keys = new Set();
  let hasSpread = false;
  for (const prop of objLiteral.properties) {
    if (ts.isSpreadAssignment(prop)) {
      hasSpread = true;
      continue;
    }
    if (!prop.name) continue;
    if (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) {
      keys.add(prop.name.text);
    } else if (ts.isComputedPropertyName(prop.name)) {
      hasSpread = true; // 计算属性名无法静态判定
    }
  }
  return { keys, hasSpread };
}

/**
 * 尝试把表达式还原成静态字符串（支持模板串里的静态片段）。
 * 返回 { values: Set<string>, hasDynamic: boolean }
 */
function collectDynamicParts(node) {
  const parts = new Set();
  let hasDynamic = false;
  const walk = (n) => {
    if (ts.isTemplateExpression(n)) {
      parts.add(n.head.text);
      for (const span of n.templateSpans) {
        parts.add(span.literal.text);
        walk(span.expression);
      }
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  if (node && ts.isTemplateExpression(node)) return { parts, hasDynamic: true };
  // 字符串拼接 'a' + x + 'b'
  if (node && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const gather = (n) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        gather(n.left); gather(n.right); return;
      }
      const lit = literalText(n);
      if (lit !== null) parts.add(lit);
      else hasDynamic = true;
    };
    gather(node);
    return { parts, hasDynamic };
  }
  return { parts, hasDynamic: true };
}

function checkCallSites(byNs) {
  const files = [];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
    }
  };
  walkDir(SRC_DIR);

  for (const file of files) {
    stats.filesScanned++;
    const content = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file, content, ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    // 解析作用域需要 parent 指针，createSourceFile 默认不挂载，这里手动补上
    attachParents(sourceFile);
    const hooksByScope = collectTranslators(sourceFile);
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');

    /** 定位到行号（1-based） */
    const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        // 只处理来自 useTranslation 的 t / 别名
        const ns = resolveTranslatorNs(node.expression, hooksByScope);
        if (ns) {
          stats.callsFound++;
          handleCall(node, ns, rel, lineOf(node), byNs);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

/** 为 AST 补 parent 指针，便于沿作用域链向上查找变量来源 */
function attachParents(node, parent = null) {
  node.parent = parent;
  ts.forEachChild(node, (child) => attachParents(child, node));
}

function handleCall(node, defaultNs, rel, line, byNs) {
  const args = node.arguments;
  if (args.length === 0) return;

  const first = args[0];
  const explicitNs = literalText(args[1]);
  const options = args[2];

  // 只处理第一个参数是字符串字面量的调用
  const rawKey = literalText(first);
  if (rawKey === null) {
    // t(`social.category.${id}.name`) 这类动态 key 无法静态校验
    const { hasDynamic } = collectDynamicParts(first);
    if (hasDynamic) {
      stats.dynamicCalls++;
      // 若是带 ns 前缀的完整路径，做一个粗粒度校验
      return;
    }
    return;
  }

  // 解析 key 中的命名空间前缀：'common:foo' / 'modules:driverUi.scan'
  let ns = defaultNs;
  let key = rawKey;
  const colonIndex = rawKey.indexOf(':');
  if (colonIndex > 0) {
    const maybeNs = rawKey.slice(0, colonIndex);
    if (NAMESPACES.includes(maybeNs)) {
      ns = maybeNs;
      key = rawKey.slice(colonIndex + 1);
    }
  }
  // t('key', { ns: 'modules' })
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const prop of options.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name && prop.name.getText() === 'ns') {
        const v = literalText(prop.initializer);
        if (v) ns = v;
      }
    }
  }
  if (explicitNs && NAMESPACES.includes(explicitNs)) ns = explicitNs;

  // 插值参数一律从第 2 个参数取（i18next: t(key, options)）
  const interpolationArg = args[1] && ts.isObjectLiteralExpression(args[1]) ? args[1] : null;

  // returnObjects 表示该 key 取的是数组/对象本身，不是文案，
  // 此时不需要校验插值参数（scanner 只展平了字符串叶子节点）
  const wantsRawObject = !!interpolationArg && interpolationArg.properties.some(
    (prop) => ts.isPropertyAssignment(prop)
      && prop.name
      && prop.name.getText() === 'returnObjects'
      && prop.initializer.kind === ts.SyntaxKind.TrueKeyword,
  );

  // returnObjects 取的是原始数组/对象，其叶子不会出现在展平表里，直接跳过校验
  if (wantsRawObject) return;

  const localeTable = byNs[ns];
  if (!localeTable) return;
  const zhTable = localeTable['zh'] || {};
  if (!(key in zhTable)) {
    // 动态拼接的 key 会被误报，先确认它在任何语言里都不存在
    const existsAnywhere = LANGUAGES.some((lang) => localeTable[lang] && key in localeTable[lang]);
    if (!existsAnywhere) {
      report('error', rel, line, `key 不存在：${ns}:${key}`);
      return;
    }
  }

  // 占位符校验以 zh 为准，并取所有语言占位符的并集（更严格）
  const required = new Set();
  for (const lang of LANGUAGES) {
    const text = localeTable[lang]?.[key];
    if (typeof text === 'string') {
      for (const v of extractPlaceholders(text)) required.add(v);
    }
  }
  if (required.size === 0) return;

  // count 是 i18next 复数/内置变量，通常由库自己注入，仍要求显式传入以便排查
  const provided = new Set();
  let hasSpread = false;
  if (interpolationArg) {
    const { keys, hasSpread: spread } = collectObjectKeys(interpolationArg);
    hasSpread = spread;
    for (const k of keys) provided.add(k);
  }

  if (hasSpread) return; // 无法静态判定，跳过

  const missing = [...required].filter((v) => !provided.has(v));
  if (missing.length > 0) {
    report('error', rel, line, `缺少插值参数 [${missing.join(', ')}] → ${ns}:${key}`);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const byNs = loadLocales();
  checkLocaleAlignment(byNs);
  checkCallSites(byNs);

  const errors = issues.filter((i) => i.level === 'error');
  const warns = issues.filter((i) => i.level === 'warn');

  console.log(`扫描文件 ${stats.filesScanned} 个，翻译调用 ${stats.callsFound} 处（动态 key ${stats.dynamicCalls} 处跳过）`);
  console.log(`问题：${errors.length} error / ${warns.length} warn\n`);

  if (errors.length) {
    console.log('=== ERROR ===');
    for (const i of errors) {
      console.log(`  [${i.file}${i.line ? ':' + i.line : ''}] ${i.message}`);
    }
    console.log('');
  }
  if (warns.length) {
    console.log('=== WARN ===');
    for (const i of warns) {
      console.log(`  [${i.file}${i.line ? ':' + i.line : ''}] ${i.message}`);
    }
    console.log('');
  }

  fs.writeFileSync(
    path.join(ROOT, '.i18n-audit.json'),
    JSON.stringify({ stats, issues }, null, 2),
    'utf8',
  );
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
