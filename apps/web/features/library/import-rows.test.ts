import { describe, expect, test } from 'bun:test';
import { type ImportRequestOptions, type ImportRow } from './import-api.ts';
import { goodreadsRows } from './import-fixtures.ts';
import { loadAllRows, reloadRow } from './import-rows.ts';

const row = (index: number, version = 0): ImportRow => ({ ...goodreadsRows()[0]!, index, version });
type Page = { rows: ImportRow[]; nextCursor: string | null };

function opaqueRows(pages: ReadonlyMap<string | -1, Page>) {
  const calls: Array<{ id: string; cursor: string | -1; signal?: AbortSignal }> = [];
  const api = { rows: async (id: string, cursor: string | -1, options?: ImportRequestOptions) => {
    calls.push({ id, cursor, signal: options?.signal });
    const page = pages.get(cursor);
    if (!page) throw new Error(`Unknown continuation: ${cursor}`);
    return page;
  } };
  return { api, calls };
}

describe('import row continuations', () => {
  test('irregular opaque pages, including an empty continued page, load every row in order', async () => {
    const fresh = row(20, 2);
    const { api, calls } = opaqueRows(new Map<string | -1, Page>([
      [-1, { rows: [row(20), row(10)], nextCursor: 'review/b+?' }],
      ['review/b+?', { rows: [], nextCursor: 'cut:empty' }],
      ['cut:empty', { rows: [row(40), fresh, row(30)], nextCursor: 'last/token' }],
      ['last/token', { rows: [row(50)], nextCursor: null }],
    ]));
    const progress: number[][] = [];
    const signal = new AbortController().signal;
    const result = await loadAllRows(api, 'upload', 5, rows => progress.push(rows.map(row => row.index)), () => true, signal);
    expect(result).toEqual([row(10), fresh, row(30), row(40), row(50)]);
    expect(progress).toEqual([[10, 20], [10, 20], [10, 20, 30, 40], [10, 20, 30, 40, 50]]);
    expect(calls).toEqual(([-1, 'review/b+?', 'cut:empty', 'last/token'] as const).map(cursor => ({ id: 'upload', cursor, signal })));
  });

  test('reload follows continuations and finds the requested identity, without reading later pages', async () => {
    const fresh = row(40, 3);
    const { api, calls } = opaqueRows(new Map<string | -1, Page>([
      [-1, { rows: [row(10)], nextCursor: 'empty-page' }],
      ['empty-page', { rows: [], nextCursor: 'chosen-row-page' }],
      ['chosen-row-page', { rows: [row(30), fresh], nextCursor: 'unneeded-page' }],
    ]));
    const signal = new AbortController().signal;
    expect(await reloadRow(api, 'upload', 40, signal)).toEqual(fresh);
    expect(calls).toEqual(([-1, 'empty-page', 'chosen-row-page'] as const).map(cursor => ({ id: 'upload', cursor, signal })));
  });

  test('reload returns undefined only after the terminal page omits the requested identity', async () => {
    const { api, calls } = opaqueRows(new Map<string | -1, Page>([
      [-1, { rows: [], nextCursor: 'end' }], ['end', { rows: [row(10)], nextCursor: null }],
    ]));
    expect(await reloadRow(api, 'upload', 40)).toBeUndefined();
    expect(calls.map(call => call.cursor)).toEqual([-1, 'end']);
  });

  test('total is checked at the terminal page, even when the expected count was already reached', async () => {
    const { api, calls } = opaqueRows(new Map<string | -1, Page>([
      [-1, { rows: [row(10)], nextCursor: 'more' }], ['more', { rows: [row(20)], nextCursor: null }],
    ]));
    await expect(loadAllRows(api, 'upload', 1)).rejects.toMatchObject({ failure: 'invalid' });
    expect(calls.map(call => call.cursor)).toEqual([-1, 'more']);
  });

  test('an incomplete terminal page fails rather than presenting a shorter import', async () => {
    const { api } = opaqueRows(new Map([[-1, { rows: [row(10)], nextCursor: null }]]));
    await expect(loadAllRows(api, 'upload', 2)).rejects.toMatchObject({ failure: 'invalid' });
  });

  test('an empty terminal page completes an empty upload', async () => {
    const { api } = opaqueRows(new Map([[-1, { rows: [], nextCursor: null }]]));
    expect(await loadAllRows(api, 'upload', 0)).toEqual([]);
  });

  test.each(['load', 'reload'] as const)('%s refuses a repeated continuation instead of looping', async operation => {
    const { api, calls } = opaqueRows(new Map<string | -1, Page>([
      [-1, { rows: [], nextCursor: 'repeat' }], ['repeat', { rows: [], nextCursor: 'repeat' }],
    ]));
    await expect(operation === 'load' ? loadAllRows(api, 'upload', 1) : reloadRow(api, 'upload', 10))
      .rejects.toMatchObject({ failure: 'invalid' });
    expect(calls.map(call => call.cursor)).toEqual([-1, 'repeat']);
  });

  test('losing the active review stops paging without treating partial progress as an error', async () => {
    const { api, calls } = opaqueRows(new Map([[-1, { rows: [row(10)], nextCursor: 'more' }]]));
    let active = true;
    expect(await loadAllRows(api, 'upload', 2, () => { active = false; }, () => active)).toEqual([row(10)]);
    expect(calls).toHaveLength(1);
  });

  test('a page that arrives after the review becomes inactive cannot publish stale rows', async () => {
    let active = true;
    const progress: ImportRow[][] = [];
    const api = { rows: async () => { active = false; return { rows: [row(10)], nextCursor: null }; } };
    expect(await loadAllRows(api, 'upload', 2, rows => progress.push(rows), () => active)).toEqual([]);
    expect(progress).toEqual([]);
  });

  test.each(['load', 'reload'] as const)('%s stops when the signal aborts between pages', async operation => {
    const controller = new AbortController();
    let calls = 0;
    const api = { rows: async () => {
      calls += 1; controller.abort(); return { rows: [], nextCursor: 'more' };
    } };
    await expect(operation === 'load' ? loadAllRows(api, 'upload', 1, undefined, undefined, controller.signal)
      : reloadRow(api, 'upload', 10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});
