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

function renderNode(node: DiskGrowthExportNode, labels: DiskGrowthHtmlLabels, locale: string): string {
  const childContent = node.children.map((child) => renderNode(child, labels, locale)).join('');
  const status = labels.levels[node.level] || node.level;
  const details = `
    <div class="node-details">
      <div class="field path"><span>${escapeHtml(labels.path)}</span><code>${escapeHtml(node.path)}</code></div>
      <div class="field"><span>${escapeHtml(labels.previousSize)}</span><strong>${escapeHtml(formatSize(node.old_size))}</strong></div>
      <div class="field"><span>${escapeHtml(labels.currentSize)}</span><strong>${escapeHtml(formatSize(node.new_size))}</strong></div>
      <div class="field"><span>${escapeHtml(labels.difference)}</span><strong class="${node.diff >= 0 ? 'increase' : 'decrease'}">${escapeHtml(formatSignedSize(node.diff))}</strong></div>
      <div class="field"><span>${escapeHtml(labels.changeTime)}</span><span>${escapeHtml(formatDateTime(node.modified, locale))}</span></div>
      <div class="field"><span>${escapeHtml(labels.level)}</span><span class="badge">${escapeHtml(status)}</span></div>
    </div>
    ${childContent ? `<div class="children">${childContent}</div>` : ''}
  `;

  // details/summary 保留原生语义，外层内容容器再配合脚本实现离线报告中的平滑折叠。
  return `<details class="node"${node.children.length > 0 ? '' : ' open'}>
    <summary><span>${escapeHtml(node.name)}</span><strong class="${node.diff >= 0 ? 'increase' : 'decrease'}">${escapeHtml(formatSignedSize(node.diff))}</strong></summary>
    <div class="node-content"><div class="node-content-inner">${details}</div></div>
  </details>`;
}

function renderBaselineEntry(entry: DiskGrowthAnalyzeEntry, labels: DiskGrowthHtmlLabels, locale: string): string {
  return `<details class="node" open>
    <summary><span>${escapeHtml(entry.path)}</span><strong>${escapeHtml(formatSize(entry.size))}</strong></summary>
    <div class="node-details">
      <div class="field path"><span>${escapeHtml(labels.path)}</span><code>${escapeHtml(entry.path)}</code></div>
      <div class="field"><span>${escapeHtml(labels.currentSize)}</span><strong>${escapeHtml(formatSize(entry.size))}</strong></div>
      <div class="field"><span>${escapeHtml(labels.changeTime)}</span><span>${escapeHtml(formatDateTime(entry.modified, locale))}</span></div>
      <div class="field"><span>${escapeHtml(labels.explanation)}</span><span>${escapeHtml(entry.reason)}</span></div>
      <div class="field path"><span>${escapeHtml(labels.suggestion)}</span><span>${escapeHtml(entry.suggestion)}</span></div>
    </div>
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
  const resultContent = !isBaselineReport
    ? exportNodes.map((node) => renderNode(node, labels, locale)).join('')
    : scanSummary.analyze.entries.map((entry) => renderBaselineEntry(entry, labels, locale)).join('');
  const content = resultContent || `<p class="empty">${escapeHtml(labels.noResult)}</p>`;
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
    .meta-item span, .field > span:first-child { display: block; color: var(--muted); font-size: 12px; } .meta-item strong { display: block; margin-top: 3px; overflow-wrap: anywhere; }
    .node { margin: 8px 0; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .node summary { display: flex; justify-content: space-between; gap: 16px; padding: 13px 16px; cursor: pointer; list-style-position: inside; } .node summary::marker { color: var(--accent); } .node summary:hover { background: var(--soft); } .node summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .node summary span { overflow-wrap: anywhere; } .node summary strong { flex: 0 0 auto; } .node-content { height: auto; overflow: hidden; opacity: 1; transition: height 220ms ease, opacity 180ms ease; } .node:not([open]) > .node-content { display: block; height: 0; opacity: 0; } .node-content-inner { min-height: 0; } .node-details { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 16px; padding: 0 16px 14px 34px; }
    .field { min-width: 0; } .field strong { display: block; margin-top: 2px; } .field span:last-child, .field code { display: block; overflow-wrap: anywhere; } .field code { margin-top: 2px; font: 12px/1.45 Consolas, monospace; }
    .path { grid-column: 1 / -1; } .children { margin: 0 12px 12px 28px; padding-left: 12px; border-left: 2px solid var(--border); } .badge { display: inline-block; margin-top: 2px; padding: 2px 8px; border-radius: 999px; color: var(--accent); background: var(--soft); }
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
<script>
  // 使用固定时长的高度动画，兼顾离线文件环境与不支持新 details 动画伪元素的浏览器。
  (() => {
    const transitionDuration = 220;
    document.querySelectorAll('details.node').forEach((detail) => {
      const content = detail.querySelector(':scope > .node-content');
      if (!content) return;
      detail.addEventListener('toggle', () => {
        if (detail.open) {
          content.style.height = '0px';
          content.style.opacity = '0';
          requestAnimationFrame(() => {
            content.style.height = content.scrollHeight + 'px';
            content.style.opacity = '1';
          });
          window.setTimeout(() => {
            if (detail.open) content.style.height = 'auto';
          }, transitionDuration);
          return;
        }
        content.style.height = content.scrollHeight + 'px';
        content.style.opacity = '1';
        requestAnimationFrame(() => {
          content.style.height = '0px';
          content.style.opacity = '0';
        });
      });
    });
  })();
</script>
</body></html>`;
}
