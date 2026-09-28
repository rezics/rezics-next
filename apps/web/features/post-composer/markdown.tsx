'use client';

import { useState, type ReactNode } from 'react';

/** Only plain text is stored. React escapes HTML; links accept HTTP(S) only. */
function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function Spoiler({ children, label }: { children: ReactNode; label: string }) {
  const [revealed, setRevealed] = useState(false);
  return <button type="button" aria-expanded={revealed} className="rounded bg-muted px-1 text-start
    outline-none focus-visible:ring-2 focus-visible:ring-ring"
    onClick={() => setRevealed(value => !value)}>{revealed ? children : label}</button>;
}

/** A deliberately small Markdown subset with bounded nesting and no HTML parser. */
export function markdownInline(source: string, showSpoiler: string, depth = 0): ReactNode[] {
  if (depth >= 4) return [source];
  const pattern = />![^\n]*?!<|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_/g;
  const nodes: ReactNode[] = [];
  let offset = 0, match = pattern.exec(source);
  while (match) {
    if (match.index > offset) nodes.push(source.slice(offset, match.index));
    const token = match[0], key = match.index;
    if (token.startsWith('>!')) nodes.push(<Spoiler key={key} label={showSpoiler}>
      {markdownInline(token.slice(2, -2), showSpoiler, depth + 1)}</Spoiler>);
    else if (token.startsWith('`')) nodes.push(<code key={key} className="rounded bg-muted px-1 font-mono text-[0.9em]">
      {token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) {
      const split = token.indexOf(']('), href = safeLink(token.slice(split + 2, -1));
      nodes.push(href ? <a key={key} href={href} target="_blank" rel="ugc nofollow noopener noreferrer"
        className="text-primary underline underline-offset-2">{token.slice(1, split)}</a> : token);
    } else if (token.startsWith('**')) nodes.push(<strong key={key}>
      {markdownInline(token.slice(2, -2), showSpoiler, depth + 1)}</strong>);
    else nodes.push(<em key={key}>{markdownInline(token.slice(1, -1), showSpoiler, depth + 1)}</em>);
    offset = pattern.lastIndex;
    match = pattern.exec(source);
  }
  if (offset < source.length) nodes.push(source.slice(offset));
  return nodes;
}

type BlockLine = { start: number; text: string };
type Block = { kind: 'paragraph' | 'quote' | 'unordered' | 'ordered'; start: number; lines: BlockLine[] };
function blocks(source: string): Block[] {
  const result: Block[] = [];
  let separated = false;
  let offset = 0;
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (!line.trim()) { separated = true; continue; }
    const quote = /^>\s+(.*)$/.exec(line);
    const unordered = /^[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    const kind = quote ? 'quote' : unordered ? 'unordered' : ordered ? 'ordered' : 'paragraph';
    const value = quote?.[1] ?? unordered?.[1] ?? ordered?.[1] ?? line;
    const last = result.at(-1);
    if (!separated && last?.kind === kind) last.lines.push({ start, text: value });
    else result.push({ kind, start, lines: [{ start, text: value }] });
    separated = false;
  }
  return result;
}

export function MarkdownBody({ text, showSpoiler, className }: { text: string;
  showSpoiler: string; className?: string }) {
  return <div className={className}>{blocks(text).map(block => {
    if (block.kind === 'quote') return <blockquote key={block.start} className="border-s-2 border-border ps-3
      text-muted-foreground">{block.lines.map(line => <div key={line.start}>
      {markdownInline(line.text, showSpoiler)}</div>)}</blockquote>;
    if (block.kind === 'unordered') return <ul key={block.start} className="list-outside list-disc ps-5">
      {block.lines.map(line => <li key={line.start}>{markdownInline(line.text, showSpoiler)}</li>)}</ul>;
    if (block.kind === 'ordered') return <ol key={block.start} className="list-outside list-decimal ps-5">
      {block.lines.map(line => <li key={line.start}>{markdownInline(line.text, showSpoiler)}</li>)}</ol>;
    return <p key={block.start} className="whitespace-pre-line">{block.lines.map((line, at) =>
      <span key={line.start}>{at ? <br /> : null}{markdownInline(line.text, showSpoiler)}</span>)}</p>;
  })}</div>;
}
