import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, test } from 'bun:test';

const sourceRoot = resolve(import.meta.dir, '../../src');
const requestPaths = ['content', 'community'];

// These budgets belong to jobs or a nested workflow step, so they start their
// own budget. Keep this list in terms of the containing function, not line numbers.
const independentBudgets = new Set([
  'content/collection-job.ts#options',
  'content/image-job.ts#processImage',
  'content/media-import-job.ts#processImportedMedia',
  'content/report-effect.ts#applyReportEffect',
  'content/work.ts#registerWork',
  'content/erasure-workflow.ts#runAuthorErasure',
  'community/membership.ts#terminalize',
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function containingFunction(source: string, offset: number): string | undefined {
  let containing: { name: string; start: number } | undefined;
  for (const match of source.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    let depth = 0;
    let cursor = match.index! + match[0].lastIndexOf('(');
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === '(') depth++;
      else if (source[cursor] === ')' && --depth === 0) break;
    }
    const open = source.indexOf('{', cursor + 1);
    if (open < 0) continue;
    let braces = 0;
    let quote: string | undefined;
    let lineComment = false;
    let blockComment = false;
    for (cursor = open; cursor < source.length; cursor++) {
      const character = source[cursor]!;
      const next = source[cursor + 1];
      if (lineComment) {
        if (character === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === '*' && next === '/') {
          blockComment = false;
          cursor++;
        }
        continue;
      }
      if (quote) {
        if (character === '\\') cursor++;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '/' && next === '/') {
        lineComment = true;
        cursor++;
      } else if (character === '/' && next === '*') {
        blockComment = true;
        cursor++;
      } else if (character === "'" || character === '"' || character === '`') quote = character;
      else if (character === '{') braces++;
      else if (character === '}' && --braces === 0) break;
    }
    const start = match.index!;
    if (start < offset && offset < cursor + 1 && (!containing || start > containing.start))
      containing = { name: match[1]!, start };
  }
  return containing?.name;
}

test('request paths use deadlineFor for their budgets', () => {
  const findings: string[] = [];
  for (const directory of requestPaths) {
    for (const path of sourceFiles(resolve(sourceRoot, directory))) {
      const source = readFileSync(path, 'utf8');
      const relativePath = relative(sourceRoot, path).replaceAll('\\', '/');
      for (const match of source.matchAll(/Date\.now\(\)\s*\+/g)) {
        const owner = containingFunction(source, match.index!);
        const site = `${relativePath}#${owner ?? '<unknown>'}`;
        if (!independentBudgets.has(site)) findings.push(site);
      }
    }
  }
  expect(findings).toEqual([]);
});
