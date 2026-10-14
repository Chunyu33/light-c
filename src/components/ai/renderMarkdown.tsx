// ============================================================================
// 极简 Markdown 渲染
//
// 两个刻意的选择：
//
// 1. **不用现成的库**：项目约定「能用原生能力就不加依赖」，而模型输出实际用到的语法
//    就这几种（标题、列表、粗体、行内代码、代码块、引用），自己写反而更可控。
//
// 2. **产出 React 节点，而不是 HTML 字符串**：如果用 dangerouslySetInnerHTML，
//    模型输出里的内容会被当成 HTML 执行，存在注入风险。这里全部走 React 元素，
//    也就**从结构上不可能执行脚本** —— 不需要再叠一层净化。
// ============================================================================

import type { ReactNode } from 'react';

/** 行内语法：粗体与行内代码。只认这两种，够用且不会误伤正常文本。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-medium">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded bg-[var(--bg-hover)] px-1 py-0.5 font-mono text-[0.95em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/**
 * 把模型返回的 Markdown 渲染成 React 节点。
 * 解析到不认识的写法就按普通段落处理 —— 宁可少认，也不要渲染错。
 */
export function renderMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 代码块：``` 开头到下一个 ``` 结束，内部原样保留（不做行内解析）
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过结束的 ```
      blocks.push(
        <pre
          key={`code-${key++}`}
          className="overflow-x-auto rounded-lg bg-[var(--bg-hover)] p-2 font-mono whitespace-pre"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // 标题：# 的个数决定层级，对话里够用
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <p
          key={`h-${key++}`}
          className={`font-medium text-[var(--text-primary)]${level <= 2 ? ' text-[1.05em]' : ''}`}
        >
          {renderInline(heading[2], `h-${key}`)}
        </p>,
      );
      index += 1;
      continue;
    }

    // 无序列表：连续多行合并成一个列表块
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="list-disc space-y-0.5 pl-4">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `ul-${key}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="list-decimal space-y-0.5 pl-4">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `ol-${key}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      blocks.push(
        <blockquote
          key={`q-${key++}`}
          className="border-l-2 border-[var(--border-color)] pl-2 text-[var(--text-muted)]"
        >
          {renderInline(line.replace(/^\s*>\s?/, ''), `q-${key}`)}
        </blockquote>,
      );
      index += 1;
      continue;
    }

    // 空行跳过
    if (!line.trim()) {
      index += 1;
      continue;
    }

    // 普通段落（相邻非空行合并，避免每行都被切成一段）
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*([-*]\s+|\d+[.)]\s+|>\s?|#{1,4}\s+)/.test(lines[index]) &&
      !lines[index].trimStart().startsWith('```')
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`p-${key++}`} className="whitespace-pre-wrap break-words">
        {renderInline(paragraph.join('\n'), `p-${key}`)}
      </p>,
    );
  }

  return <>{blocks}</>;
}
