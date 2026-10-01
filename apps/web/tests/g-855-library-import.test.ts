import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MainClient } from '../features/discover/types.ts';
import { ImportError, mainImportApi } from '../features/library/import-api.ts';
import { fakeImportApi, goodreadsRows, halfApplied } from '../features/library/import-fixtures.ts';
import { applyFinished, applyStarted, countGroups, groupOf, loadAllRows, needsChoice } from '../features/library/import-rows.ts';
import { browserImportShelf, memoryImportShelf, UPLOAD_RETENTION_MS, type PendingImport } from '../features/library/import-store.ts';

const throttled = (retryAfter: string, code = 'rate_limited') => ({ status: 429, data: null, error: { value: { code } },
  response: new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }) });

/** The Eden chain `main().v1.me['library-imports']`, with each call recorded. */
function library(handlers: { post?: (...args: unknown[]) => unknown; get?: (...args: unknown[]) => unknown;
  put?: (...args: unknown[]) => unknown; apply?: (...args: unknown[]) => unknown; del?: (...args: unknown[]) => unknown;
  adopt?: (...args: unknown[]) => unknown }) {
  const resource = Object.assign((_params: { id: string }) => ({
    rows: Object.assign((_row: { row: number }) => ({ put: handlers.put, adoptions: { post: handlers.adopt } }), { get: handlers.get }),
    apply: { post: handlers.apply }, delete: handlers.del }), { post: handlers.post });
  return (() => ({ v1: { me: { 'library-imports': resource } } })) as unknown as () => MainClient;
}
const keyOf = (options: unknown) => (options as { headers: { 'idempotency-key': string } }).headers['idempotency-key'];

describe('G-855: the browser forwards to Main and waits out its admission', () => {
  test('every call carries its own Idempotency-Key, and Retry-After retries the same intent with the same key', async () => {
    const keys: string[] = [], times: number[] = [];
    const page = { rows: [], nextCursor: null };
    const api = mainImportApi('agent', library({ get: async (options: unknown) => {
      keys.push(keyOf(options)); times.push(Date.now());
      return keys.length === 1 ? throttled('1') : { status: 200, data: page };
    } }));
    expect(await api.rows('file', -1)).toEqual(page);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(950);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await api.rows('file', -1);
    expect(keys[2]).not.toBe(keys[0]);
  });

  test('a daily budget is a refusal to show, not an admission to wait for', async () => {
    let calls = 0;
    const api = mainImportApi('agent', library({ adopt: async () => { calls += 1; return throttled('1', 'reader_import_adoption_budget'); } }));
    await expect(api.adopt('file', 3, 'OL1W', 'en')).rejects.toMatchObject({ failure: 'budget' });
    expect(calls).toBe(1);
  });

  test('adopting an Open Library candidate polls its pending answer under one key', async () => {
    const keys: string[] = [];
    const api = mainImportApi('agent', library({ adopt: async (_body: unknown, options: unknown) => {
      keys.push(keyOf(options));
      return keys.length === 1 ? { status: 202, data: {} } : { status: 200, data: { work: 'https://rezics.com/id/adopted' } };
    } }));
    expect(await api.adopt('file', 3, 'OL1W', 'en')).toBe('https://rezics.com/id/adopted');
    expect(keys[1]).toBe(keys[0]);
  });

  test.each([[404, 'missing'], [409, 'conflict'], [400, 'invalid'], [403, 'denied'], [503, 'unavailable']])('status %i is %s', async (status, failure) => {
    const api = mainImportApi('agent', library({ apply: async () => ({ status, data: null }) }));
    await expect(api.apply('file', { context: null, language: 'und' })).rejects.toMatchObject({ failure });
  });

  test('a CSV is inspected with no mapping, then created with one; apply repeats the sealed intent', async () => {
    const bodies: unknown[] = [];
    const api = mainImportApi('agent', library({ post: async (body: unknown) => {
      bodies.push(body);
      return (body as { mapping?: unknown }).mapping ? { status: 201, data: { id: 'file', total: 2 } }
        : { status: 200, data: { headers: ['Title'], distinctValues: { Title: [] } } };
    }, apply: async (body: unknown) => { bodies.push(body); return { status: 202, data: { total: 2, completed: 1, issues: 0, pending: true } }; } }));
    expect(await api.inspect('Title\nA\n')).toEqual({ headers: ['Title'], distinctValues: { Title: [] } });
    const mapping = { title: 'Title', statuses: {} };
    expect(await api.create({ format: 'generic-csv', file: 'Title\nA\n', mapping })).toEqual({ id: 'file', total: 2 });
    expect((await api.apply('file', { context: 'ctx', language: 'ko' })).pending).toBe(true);
    expect(bodies).toEqual([{ actingSubject: 'agent', format: 'generic-csv', file: 'Title\nA\n' },
      { actingSubject: 'agent', format: 'generic-csv', file: 'Title\nA\n', mapping },
      { actingSubject: 'agent', context: 'ctx', language: 'ko' }]);
  });
});

describe('G-855: rows by outcome', () => {
  test('a row is matched, in need of a choice, or private, whichever Main or the reader said last', () => {
    const [matched, , , , , , ambiguous, , notFound] = goodreadsRows();
    expect(groupOf(matched!)).toBe('matched');
    expect(groupOf(ambiguous!)).toBe('ambiguous');
    expect(groupOf(notFound!)).toBe('not-found');
    expect([ambiguous, notFound].map(row => needsChoice(row!))).toEqual([true, true]);
    expect(groupOf({ ...notFound!, resolution: { choice: 'private' } })).toBe('private');
    expect(groupOf({ ...ambiguous!, resolution: { choice: 'apply', work: 'https://rezics.com/id/x' } })).toBe('matched');
    expect(countGroups(goodreadsRows())).toEqual({ matched: 6, ambiguous: 2, 'not-found': 1, private: 0 });
  });

  test('a started apply seals the review; every row with an outcome means it is finished', () => {
    expect(applyStarted(goodreadsRows())).toBe(false);
    expect(applyStarted(halfApplied())).toBe(true);
    expect(applyFinished(halfApplied())).toBe(false);
    expect(applyFinished(halfApplied().map(row => ({ ...row, outcome: { applied: [], issues: [] } })))).toBe(true);
  });

  test('every row of a long upload is read, a few pages at a time, in order', async () => {
    const rows = Array.from({ length: 45 }, (_, index) => ({ ...goodreadsRows()[0]!, index }));
    const api = fakeImportApi(rows);
    const cursors: number[] = [];
    const counted = { ...api, rows: async (id: string, cursor: number) => { cursors.push(cursor); return api.rows(id, cursor); } };
    const seen: number[] = [];
    const all = await loadAllRows(counted, 'file', 45, loaded => seen.push(loaded.length));
    expect(all.map(row => row.index)).toEqual(rows.map(row => row.index));
    expect(cursors.sort((a, b) => a - b)).toEqual([-1, 7, 15, 23, 31, 39]);
    expect(seen.at(-1)).toBe(45);
  });

  test('fewer rows than the upload has is a failure to retry, not a shorter import', async () => {
    const api = fakeImportApi(goodreadsRows());
    await expect(loadAllRows(api, 'file', 12)).rejects.toBeInstanceOf(ImportError);
  });
});

describe('G-855: unfinished imports are remembered for as long as Main keeps them', () => {
  const held = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => held.get(key) ?? null, setItem: (key: string, value: string) => { held.set(key, value); } } });
  afterEach(() => held.clear());
  const entry = (over: Partial<PendingImport> = {}): PendingImport => ({ id: 'file-1', format: 'goodreads', name: 'a.csv', total: 9,
    createdAt: Date.now(), intent: null, ...over });

  test('saved per Person, replaced by id, removed on discard', () => {
    browserImportShelf.save('one', entry()); browserImportShelf.save('one', entry({ intent: { context: null, language: 'ko' } }));
    browserImportShelf.save('two', entry({ id: 'file-2' }));
    expect(browserImportShelf.list('one').map(item => [item.id, item.intent?.language])).toEqual([['file-1', 'ko']]);
    browserImportShelf.remove('one', 'file-1');
    expect(browserImportShelf.list('one')).toEqual([]);
    expect(browserImportShelf.list('two')).toHaveLength(1);
  });

  test('an upload older than seven days is forgotten, and unreadable storage is an empty list', () => {
    browserImportShelf.save('one', entry({ createdAt: Date.now() - UPLOAD_RETENTION_MS - 1000 }));
    expect(browserImportShelf.list('one')).toEqual([]);
    held.set('rezics:library-imports:one', '{not json');
    expect(browserImportShelf.list('one')).toEqual([]);
    expect(memoryImportShelf([entry()]).list('one')).toHaveLength(1);
  });
  afterEach(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); });
});

// The class guard: Main parses and matches. Nothing in the Library may bring a file parser or a title
// comparison back into the browser, whatever form it takes.
const features = resolve(import.meta.dir, '..', 'features');
const sources = ['library', 'library-backup'].flatMap(directory => readdirSync(join(features, directory), { recursive: true, encoding: 'utf8' })
  .filter(name => /\.tsx?$/.test(name) && !/\.stories\.|fixtures\.ts$/.test(name)).map(name => join(directory, name)));
const parsers: Array<[string, RegExp]> = [
  ['a CSV or XML parser package', /from\s+['"](?:papaparse|csv-[\w-]+|d3-dsv|fast-xml-parser|xml2js|sax|@xmldom\/[\w-]+|htmlparser2|xmlbuilder2?)['"]/],
  ['DOMParser', /\bDOMParser\b/],
  ['a title compared as text', /\btitles?\b\)?\s*(?:===|!==)|\.(?:toLowerCase|toLocaleLowerCase)\(\)\s*(?:===|!==|\.includes)|localeCompare\(/],
  ['text folded for matching', /normalize\(\s*['"]NFK?[CD]['"]\s*\)/],
];

describe('class guard: the browser parses and matches nothing', () => {
  test('the Library has sources to check', () => { expect(sources.length).toBeGreaterThan(10); });
  for (const file of sources) {
    test(file, () => {
      const text = readFileSync(join(features, file), 'utf8');
      for (const [what, pattern] of parsers) expect(text.match(pattern)?.[0] ?? null, `${file} brings back ${what}`).toBeNull();
    });
  }
  test('the old browser parser and matcher are gone', () => {
    const names = readdirSync(join(features, 'library'));
    expect(names).not.toContain('import-csv.ts');
    expect(names).not.toContain('import-match.ts');
  });
});
