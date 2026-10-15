import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { continuationInventory, webSources } from './web-continuations.ts';
import { pageSelections } from './web-page-filtering.ts';
import { isWebDataModule, webChildren, webProgram } from './web-source-scan.ts';

test('only literal data modules bypass flow analysis, retaining continuation properties and executable values', () => {
  const data = (source: string) => isWebDataModule(webProgram({ path: 'dictionary.ts', source }));
  expect(data('export const messages = {title: "Books", nested: ["A", {count: 2}]} as const;')).toBe(true);
  for (const source of [
    'export const page = {nextCursor: "invented"};',
    'export const page = {next\\u0043ursor: "invented"};',
    'export const page = {limit: 20};',
    'export const read = x => x.items;',
    'export const messages = {title: translate("Books")};',
    'export const messages = {...other};',
    'export const messages = {[key]: "Books"};',
  ]) expect(data(source)).toBe(false);
});

test('shared production parses refresh after a planted page violation, addition and deletion', async () => {
  const root = mkdtempSync(join(import.meta.dir, '../../.temp/web-source-scan-'));
  const directory = join(root, 'apps/web');
  mkdirSync(directory, { recursive: true });
  const path = 'apps/web/read.ts';
  const correct = 'export async function read(api) { const page = await api.v1.works.get({query:{limit:20}}); return page; }';
  const planted = correct.replace('return page;', 'return page.items.filter(item => item.eligible);');
  try {
    writeFileSync(join(root, path), correct);
    const before = await webSources(root);
    const program = webProgram(before[0]!);
    expect(webProgram({ ...before[0]! })).toBe(program);
    expect(webChildren(program)).toBe(webChildren(program));
    expect(pageSelections(before)).toEqual([]);
    expect(continuationInventory(before)).toEqual([]);

    writeFileSync(join(root, path), planted);
    const changed = await webSources(root);
    expect(webProgram(changed[0]!)).not.toBe(program);
    expect(pageSelections(changed)).toEqual([expect.objectContaining({ path, operation: 'GET /v1/works' })]);
    expect(continuationInventory(changed)).toEqual([expect.objectContaining({ path, rule: 'dropped-continuation' })]);

    writeFileSync(join(directory, 'added.ts'), planted);
    expect(pageSelections(await webSources(root))).toHaveLength(2);
    rmSync(join(directory, 'added.ts'));
    writeFileSync(join(root, path), correct);
    expect(pageSelections(await webSources(root))).toEqual([]);
    expect(continuationInventory(await webSources(root))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
