import { describe, expect, test } from 'bun:test';
import { type ImportRequestOptions, type ImportRow } from './import-api.ts';
import { goodreadsRows } from './import-fixtures.ts';
import { loadAllRows, reloadRow, replaceRow } from './import-rows.ts';

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

  test('reloading row 4999 of 5000 reads only its retained page even when every other page fails', async () => {
    const pages = new Map<string | -1, Page>();
    for (let start = 0; start < 5000; start += 8) {
      pages.set(start === 0 ? -1 : `owner/page-${start}`, {
        rows: Array.from({ length: 8 }, (_, offset) => row(start + offset)),
        nextCursor: start + 8 < 5000 ? `owner/page-${start + 8}` : null,
      });
    }
    const { api, calls } = opaqueRows(pages);
    const loaded = await loadAllRows(api, 'upload', 5000);
    const fresh = row(4999, 3);
    pages.clear();
    pages.set('owner/page-4992', { rows: [row(4992), fresh], nextCursor: 'unneeded-page' });
    calls.length = 0;
    const signal = new AbortController().signal;
    expect(await reloadRow(api, 'upload', loaded[4999]!, signal)).toEqual(fresh);
    expect(calls).toEqual([{ id: 'upload', cursor: 'owner/page-4992', signal }]);
    calls.length = 0;
    expect(await reloadRow(api, 'upload', fresh)).toEqual(fresh);
    expect(calls.map(call => call.cursor)).toEqual(['owner/page-4992']);
  });

  test('first-page positions survive a local replacement and reload uses the start sentinel once', async () => {
    const pages = new Map<string | -1, Page>([[-1, { rows: [row(10)], nextCursor: null }]]);
    const { api, calls } = opaqueRows(pages);
    const loaded = await loadAllRows(api, 'upload', 1);
    const kept = { ...loaded[0]!, resolution: { choice: 'private' as const } };
    const replaced = replaceRow(loaded, kept);
    const fresh = row(10, 2);
    pages.set(-1, { rows: [fresh], nextCursor: 'unneeded-page' });
    calls.length = 0;
    expect(await reloadRow(api, 'upload', replaced[0]!)).toEqual(fresh);
    expect(calls.map(call => call.cursor)).toEqual([-1]);
  });

  test('reload returns undefined when its retained page omits the identity without following next', async () => {
    const pages = new Map<string | -1, Page>([
      [-1, { rows: [], nextCursor: 'end' }], ['end', { rows: [row(10)], nextCursor: null }],
    ]);
    const { api, calls } = opaqueRows(pages);
    const loaded = await loadAllRows(api, 'upload', 1);
    pages.clear(); pages.set('end', { rows: [row(20)], nextCursor: 'unneeded-page' });
    calls.length = 0;
    expect(await reloadRow(api, 'upload', loaded[0]!)).toBeUndefined();
    expect(calls.map(call => call.cursor)).toEqual(['end']);
  });

  test('a row without a position from this API and upload fails without guessing a page', async () => {
    const { api, calls } = opaqueRows(new Map([[-1, { rows: [row(10)], nextCursor: null }]]));
    const loaded = await loadAllRows(api, 'upload', 1);
    const other = opaqueRows(new Map());
    calls.length = 0;
    await expect(reloadRow(api, 'other-upload', loaded[0]!)).rejects.toMatchObject({ failure: 'invalid' });
    await expect(reloadRow(other.api, 'upload', loaded[0]!)).rejects.toMatchObject({ failure: 'invalid' });
    await expect(reloadRow(api, 'upload', row(10))).rejects.toMatchObject({ failure: 'invalid' });
    expect(calls).toEqual([]);
    expect(other.calls).toEqual([]);
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

  test('load refuses a repeated continuation instead of looping', async () => {
    const { api, calls } = opaqueRows(new Map<string | -1, Page>([
      [-1, { rows: [], nextCursor: 'repeat' }], ['repeat', { rows: [], nextCursor: 'repeat' }],
    ]));
    await expect(loadAllRows(api, 'upload', 1)).rejects.toMatchObject({ failure: 'invalid' });
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

  test.each(['load', 'reload'] as const)('%s stops when the signal aborts during a read', async operation => {
    const controller = new AbortController();
    let calls = 0;
    let abortOnRead = false;
    const api = { rows: async () => {
      calls += 1;
      if (abortOnRead) controller.abort();
      return { rows: [row(10)], nextCursor: null };
    } };
    const loaded = await loadAllRows(api, 'upload', 1);
    calls = 0; abortOnRead = true;
    await expect(operation === 'load' ? loadAllRows(api, 'upload', 1, undefined, undefined, controller.signal)
      : reloadRow(api, 'upload', loaded[0]!, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });
});
