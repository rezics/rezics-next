import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '../src');
const board = await readFile(join(root, 'routes/boards/$id.tsx'), 'utf8');
const thread = await readFile(join(root, 'routes/threads/$id_.$slug.tsx'), 'utf8');
const shell = await readFile(join(root, 'shell/shell.tsx'), 'utf8');

test('board and thread titles use the shared page heading size, not the display size', () => {
  expect(board).toContain('<PageHeading>{board.title ?? m.threads_untitled()}</PageHeading>');
  expect(thread).toContain('<PageHeading>{thread.title ?? m.threads_untitled()}</PageHeading>');
  expect(board).not.toMatch(/text-5xl|text-6xl/);
  expect(thread).not.toMatch(/text-5xl|text-6xl/);
});

test('a post shows edited only when it was revised after it was published', () => {
  expect(thread).toMatch(/post\.revisedAt\s*&&\s*new Date\(post\.revisedAt\)\.getTime\(\)\s*>\s*new Date\(post\.createdAt\)\.getTime\(\)/);
});

test('thread titles on the board render in the page heading style for rows and an untitled thread shows its first words instead of an untitled label', () => {
  expect(board).toContain('ListRow');
  expect(board).toContain('text-xl font-semibold');
  expect(board).toMatch(/firstPost\.body|firstPost\.text/);
  expect(board).not.toMatch(/thread\.title \?\? m\.threads_untitled\(\)/);
});

test('scrolling a thread at 390 shows the shell header once, at the top of the viewport', () => {
  expect(shell.match(/<header className="sticky top-0/g)).toHaveLength(1);
  expect(shell).toContain('sticky top-0');
});

test('the pages make the same kernel reads as base', () => {
  expect(board).toContain('boardPageQuery(');
  expect(thread).toContain('threadPageQuery(');
  expect(thread).toContain('threadPersonalQuery(');
  expect(board.match(/boardPageQuery\(/g)).toHaveLength(1);
  expect(thread.match(/threadPageQuery\(/g)).toHaveLength(1);
  expect(thread.match(/threadPersonalQuery\(/g)).toHaveLength(1);
});

test("the board page's thread list renders each item as a ListRow", () => {
  expect(board).toContain('<ListRow');
  expect(board).toContain('<ListRowLink');
  expect(board).toContain('<ListRowControl');
  expect(board).not.toMatch(/divide-y|border-y|rounded-(?:md|lg|xl).*bg-/);
});
