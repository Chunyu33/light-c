import type {
  DiskGrowthAnalyzeEntry,
  DiskGrowthEntry,
  DiskGrowthExportNode,
  DiskGrowthReport,
  DiskGrowthScanResponse,
} from '../api/commands';
import { formatSize } from './format';

export interface DiskGrowthHtmlLabels {
  title: string;
  generatedAt: string;
  drive: string;
  scanMode: string;
  changeMode: string;
  baselineMode: string;
  currentSize: string;
  netChange: string;
  noHistory: string;
  previousScan: string;
  currentScan: string;
  scannedFiles: string;
  resultCount: string;
  truncatedNote: string;
  path: string;
  changeTime: string;
  level: string;
  size: string;
  difference: string;
  previousSize: string;
  children: string;
  explanation: string;
  suggestion: string;
  noResult: string;
  depthNote: string;
  scopeTitle: string;
  changeScopeNote: string;
  baselineScopeNote: string;
  levels: Record<DiskGrowthEntry['level'], string>;
}

interface DiskGrowthHtmlOptions {
  labels: DiskGrowthHtmlLabels;
  locale: string;
  exportTotalNodes?: number;
  exportTruncated?: boolean;
}

function escapeHtml(value: string): string {
  // 扫描路径和后端说明可能包含特殊字符，转义后再嵌入 HTML 才不会破坏报告结构。
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  };
  return value.replace(/[&<>'"]/g, (character) => entities[character]);
}

function formatDateTime(timestamp: number, locale: string): string {
  if (!timestamp) return '-';
  const normalizedTimestamp = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalizedTimestamp);
  return Number.isNaN(date.getTime())
    ? '-'
    : new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatSignedSize(diff: number): string {
  if (diff === 0) return '-';
  return `${diff > 0 ? '+' : '-'}${formatSize(Math.abs(diff))}`;
}

function interpolateHtmlLabel(template: string, values: Record<string, string | number>): string {
  // 报告说明需要插入实际条目数量，统一转义插值内容避免路径或外部文本破坏 HTML。
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => escapeHtml(String(values[key] ?? '')));
}

function renderNode(
  node: DiskGrowthExportNode,
  labels: DiskGrowthHtmlLabels,
  locale: string,
  parts: string[],
): void {
  const hasChildren = node.children.length > 0;
  const diffClass = node.diff >= 0 ? 'increase' : 'decrease';
  // 只有根节点默认展开：节点数量可达数千，全部展开会让浏览器首屏布局严重卡顿。
  parts.push(`<details class="node"${hasChildren ? ' open' : ''}><summary><span>`);
  parts.push(escapeHtml(node.name));
  parts.push(`</span><strong class="${diffClass}">`);
  parts.push(escapeHtml(formatSignedSize(node.diff)));
  // 详情用 dl/dt/dd 表达，比 div + span 少一层包装：每个节点可少 5 个 DOM 元素，
  // 数千节点时直接影响浏览器解析与布局成本，而信息量完全不变。
  parts.push('</strong></summary><div class="node-content"><dl class="node-details">');
  parts.push(detailRow(labels.path, `<code>${escapeHtml(node.path)}</code>`));
  parts.push(detailRow(labels.previousSize, `<strong>${escapeHtml(formatSize(node.old_size))}</strong>`));
  parts.push(detailRow(labels.currentSize, `<strong>${escapeHtml(formatSize(node.new_size))}</strong>`));
  parts.push(detailRow(labels.difference, `<strong class="${diffClass}">${escapeHtml(formatSignedSize(node.diff))}</strong>`));
  parts.push(detailRow(labels.changeTime, escapeHtml(formatDateTime(node.modified, locale))));
  parts.push(detailRow(labels.level, `<span class="badge">${escapeHtml(labels.levels[node.level] || node.level)}</span>`));
  parts.push('</dl>');

  if (hasChildren) {
    parts.push('<div class="children">');
    for (const child of node.children) {
      renderNode(child, labels, locale, parts);
    }
    parts.push('</div>');
  }

  parts.push('</div></details>');
}

/// 生成一行“标签 + 取值”的详情；valueHtml 必须是已经转义过的 HTML 片段。
function detailRow(label: string, valueHtml: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>`;
}

function renderBaselineEntry(entry: DiskGrowthAnalyzeEntry, labels: DiskGrowthHtmlLabels, locale: string): string {
  return `<details class="node" open>
    <summary><span>${escapeHtml(entry.path)}</span><strong>${escapeHtml(formatSize(entry.size))}</strong></summary>
    <div class="node-content"><dl class="node-details">
      <dt>${escapeHtml(labels.path)}</dt><dd><code>${escapeHtml(entry.path)}</code></dd>
      <dt>${escapeHtml(labels.currentSize)}</dt><dd><strong>${escapeHtml(formatSize(entry.size))}</strong></dd>
      <dt>${escapeHtml(labels.changeTime)}</dt><dd>${escapeHtml(formatDateTime(entry.modified, locale))}</dd>
      <dt>${escapeHtml(labels.explanation)}</dt><dd>${escapeHtml(entry.reason)}</dd>
      <dt>${escapeHtml(labels.suggestion)}</dt><dd>${escapeHtml(entry.suggestion)}</dd>
    </dl></div>
  </details>`;
}

export function buildDiskGrowthHtml(
  scanSummary: DiskGrowthScanResponse,
  growthReport: DiskGrowthReport,
  exportNodes: DiskGrowthExportNode[],
  options: DiskGrowthHtmlOptions,
): string {
  const { labels, locale, exportTotalNodes, exportTruncated = false } = options;
  // 是否有历史快照决定报告模式；二次扫描即使没有变化，也不能退回首次扫描基线。
  const isBaselineReport = !scanSummary.previous_scan_time;
  // 用数组累积再一次性拼接：递归 template string 会让每层子树都重复复制一次下层结果，
  // 上千节点时会产生明显的中间字符串开销。
  const parts: string[] = [];
  if (!isBaselineReport) {
    for (const node of exportNodes) {
      renderNode(node, labels, locale, parts);
    }
  } else {
    for (const entry of scanSummary.analyze.entries) {
      parts.push(renderBaselineEntry(entry, labels, locale));
    }
  }
  const content = parts.length > 0 ? parts.join('') : `<p class="empty">${escapeHtml(labels.noResult)}</p>`;
  const previousScan = scanSummary.previous_scan_time || labels.noHistory;
  // 变化报告使用后端实际生成的节点总数，避免把去重后的根目录数量当成导出数量。
  const resultCount = !isBaselineReport
    ? (exportTotalNodes ?? exportNodes.length)
    : scanSummary.analyze.entries.length;
  const footerNote = exportTruncated
    ? `${labels.depthNote} ${labels.truncatedNote}`
    : labels.depthNote;
  const scopeNote = interpolateHtmlLabel(
    isBaselineReport ? labels.baselineScopeNote : labels.changeScopeNote,
    {
      pageCount: isBaselineReport ? scanSummary.analyze.entries.length : growthReport.entries.length,
      exportCount: resultCount,
    },
  );

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(labels.title)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4faf7; --card: #fff; --text: #1f2937; --muted: #5f7168; --border: #cfe6d9; --accent: #07c160; --accent-hover: #06ad56; --soft: rgba(7, 193, 96, .10); --increase: #ef4444; --decrease: #07c160; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111a15; --card: #1b2820; --text: #edf5f1; --muted: #a7b8ae; --border: #365443; --soft: rgba(7, 193, 96, .18); } }
    * { box-sizing: border-box; } ::selection { background: var(--accent); color: #fff; } body { margin: 0; padding: 32px 20px 48px; background: var(--bg); color: var(--text); font: 14px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
    main { max-width: 1160px; margin: 0 auto; } h1 { margin: 0 0 20px; color: var(--accent-hover); font-size: 26px; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 24px; }
    .meta-item { padding: 13px 15px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; min-width: 0; }
    .meta-item span { display: block; color: var(--muted); font-size: 12px; } .meta-item strong { display: block; margin-top: 3px; overflow-wrap: anywhere; }
    .node { margin: 8px 0; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .node summary { display: flex; justify-content: space-between; gap: 16px; padding: 13px 16px; cursor: pointer; list-style-position: inside; } .node summary::marker { color: var(--accent); } .node summary:hover { background: var(--soft); } .node summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .node summary span { overflow-wrap: anywhere; } .node summary strong { flex: 0 0 auto; }
    /* 折叠动画完全由 CSS 驱动：interpolate-size 让 height:auto 与 0 之间可插值，
       不再需要给每个节点绑定 toggle 监听（数千节点时那会让浏览器主线程长时间卡死）。
       不支持该属性的旧浏览器只是没有过渡效果，展开/折叠本身仍然正常。 */
    .node-content { height: auto; overflow: hidden; opacity: 1; interpolate-size: allow-keywords; transition: height 220ms ease, opacity 180ms ease; }
    .node:not([open]) > .node-content { height: 0; opacity: 0; }
    .node-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 16px; margin: 0; padding: 0 16px 14px 34px; }
    /* dl 用两列网格：dt 固定在左列、dd 在右列并自动换行，成对占一行，不需要 field 包装层。 */
    .node-details { display: grid; grid-template-columns: minmax(96px, max-content) minmax(0, 1fr); column-gap: 14px; row-gap: 6px; margin: 0; padding: 0 16px 14px 34px; }
    .node-details dt { grid-column: 1; color: var(--muted); font-size: 12px; min-width: 0; }
    .node-details dd { grid-column: 2; margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .node-details dd code { font: 12px/1.45 Consolas, monospace; }
    .children { margin: 0 12px 12px 28px; padding-left: 12px; border-left: 2px solid var(--border); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; color: var(--accent); background: var(--soft); }
    .increase { color: var(--increase); } .decrease { color: var(--decrease); } .empty { padding: 24px; color: var(--muted); background: var(--card); border: 1px solid var(--border); border-radius: 10px; } footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
    .scope-note { margin: 0 0 24px; padding: 14px 16px; background: var(--soft); border: 1px solid var(--border); border-radius: 10px; } .scope-note h2 { margin: 0 0 5px; font-size: 14px; } .scope-note p { margin: 0; color: var(--muted); }
  </style>
</head>
<body><main>
  <h1>${escapeHtml(labels.title)}</h1>
  <section class="meta">
    <div class="meta-item"><span>${escapeHtml(labels.drive)}</span><strong>${escapeHtml(scanSummary.drive_letter)}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.scanMode)}</span><strong>${escapeHtml(isBaselineReport ? labels.baselineMode : labels.changeMode)}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.generatedAt)}</span><strong>${escapeHtml(formatDateTime(Date.now(), locale))}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.currentSize)}</span><strong>${escapeHtml(formatSize(scanSummary.total_size))}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.netChange)}</span><strong class="${growthReport.total_growth >= 0 ? 'increase' : 'decrease'}">${escapeHtml(formatSignedSize(growthReport.total_growth))}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.previousScan)}</span><strong>${escapeHtml(previousScan)}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.currentScan)}</span><strong>${escapeHtml(scanSummary.current_scan_time)}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.scannedFiles)}</span><strong>${scanSummary.total_files_scanned.toLocaleString(locale)}</strong></div>
    <div class="meta-item"><span>${escapeHtml(labels.resultCount)}</span><strong>${resultCount.toLocaleString(locale)}</strong></div>
  </section>
  <section class="scope-note"><h2>${escapeHtml(labels.scopeTitle)}</h2><p>${scopeNote}</p></section>
  <section>${content}</section>
  <footer>${escapeHtml(footerNote)}</footer>
</main>
</body></html>`;
}
