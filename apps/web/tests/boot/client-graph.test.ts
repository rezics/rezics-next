import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const src = join(import.meta.dir, '../../src');
const serverModules = new Set([
  'cloudflare:workers',
  '@tanstack/react-start/server',
  '@tanstack/react-start/server-only',
]);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveLocal(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = join(dirname(from), spec);
  if (/\.[cm]?[jt]sx?$/.test(spec)) return isFile(base) ? base : undefined;
  return [`${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx')].find(isFile);
}

function matchDelimited(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escape = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escape) escape = false;
      else if (character === '\\') escape = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function serverRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const token of ['.server(', 'createServerOnlyFn(', '.handler(', 'server: {']) {
    let from = 0;
    while (from < source.length) {
      const index = source.indexOf(token, from);
      if (index === -1) break;
      const open = token.endsWith('{') ? source.indexOf('{', index) : source.indexOf('(', index);
      const close = matchDelimited(source, open, token.endsWith('{') ? '{' : '(', token.endsWith('{') ? '}' : ')');
      ranges.push([index, close]);
      from = index + token.length;
    }
  }
  return ranges;
}

function covered(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index <= end);
}

function importedNames(clause: string): string[] {
  const names: string[] = [];
  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) names.push(namespace[1]!);
  const named = clause.match(/\{([^}]+)\}/);
  if (named)
    for (const part of named[1]!.split(',')) {
      const trimmed = part.replace(/^type\s+/, '').trim();
      if (!trimmed) continue;
      const name = trimmed.split(/\s+as\s+/).at(-1);
      if (name) names.push(name);
    }
  const defaultName = clause.match(/^([A-Za-z_$][\w$]*)/);
  if (defaultName && !clause.trim().startsWith('{') && !clause.includes('*')) names.push(defaultName[1]!);
  return names;
}

function staticImports(source: string): Array<{ spec: string; names: string[]; start: number; end: number }> {
  const imports: Array<{ spec: string; names: string[]; start: number; end: number }> = [];
  const pattern = /(?:^|\n)import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue;
    const start = match.index ?? 0;
    imports.push({
      spec: match[3]!,
      names: importedNames(match[2] ?? ''),
      start,
      end: start + match[0].length,
    });
  }
  return imports;
}

function usedOutsideServer(
  source: string,
  names: string[],
  ranges: Array<[number, number]>,
  importSpan: [number, number],
): boolean {
  if (names.length === 0) return !covered(importSpan[0], ranges);
  const body = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => ' '.repeat(block.length))
    .replace(/(?<!:)\/\/.*$/gm, (line) => ' '.repeat(line.length));
  return names.some((name) => {
    const pattern = new RegExp(`(?<![.\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g');
    for (const match of body.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index >= importSpan[0] && index < importSpan[1]) continue;
      if (!covered(index, ranges)) return true;
    }
    return false;
  });
}

test('no module reachable from the client entry imports a server-only module', () => {
  const entries = [
    join(src, 'client.tsx'),
    join(src, 'router.tsx'),
    ...[...new Bun.Glob('routes/**/*.tsx').scanSync({ cwd: src })].map((file) => join(src, file)),
  ];
  const seen = new Set<string>();
  const queue = [...entries];
  const violations: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || file.includes('node_modules') || file.includes('.storybook')) continue;
    seen.add(file);
    const path = relative(src, file);
    if (/\.server\.[cm]?[jt]sx?$/.test(file)) {
      violations.push(`${path}: server-only module`);
      continue;
    }
    const source = readFileSync(file, 'utf8');
    const ranges = serverRanges(source);
    for (const item of staticImports(source)) {
      const serverFile = /\.server(\.[cm]?[jt]sx?)?$/.test(item.spec);
      const leaked = usedOutsideServer(source, item.names, ranges, [item.start, item.end]);
      if (serverModules.has(item.spec) || serverFile) {
        if (leaked) violations.push(`${path}: ${item.spec}`);
        continue;
      }
      if (!leaked) continue;
      const resolved = resolveLocal(file, item.spec);
      if (resolved) queue.push(resolved);
    }
  }
  expect(violations).toEqual([]);
});
