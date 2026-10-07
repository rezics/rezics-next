import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MainClient } from '../features/discover/types.ts';
import { appendEditionPage, mainTrackingApi, type EditionPageQuery } from '../features/tracking/api.ts';
import { editionName } from '../features/tracking/display.ts';
import * as fixture from '../features/tracking/fixtures.ts';
import { copyOf } from '../features/tracking/messages.ts';
import { editionListed, editionOptions } from '../features/tracking/model.ts';
import { applyEditionPage, EditionContinuation, editionContinuation } from '../features/tracking/tracking-sheet.tsx';
import type { Editions, Realization, Release } from '../features/tracking/types.ts';

const t = copyOf('en');
const work = fixture.saoOne;

function releases(count: number): Release[] {
  const template = fixture.editions.releases[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: fixture.iri(`e${index + 1}`),
    title: { ...template.title, value: `Release ${index + 1}` },
  }));
}

function realizations(count: number): Realization[] {
  const template = fixture.editions.realizations[0]!;
  return Array.from({ length: count }, (_, index) => ({ ...template, id: fixture.iri(`r${index + 1}`) }));
}

function pageOf<T>(items: readonly T[], cursor?: string): { items: T[]; nextCursor: string | null } {
  const start = cursor ? Number(cursor) : 0;
  return { items: items.slice(start, start + 20), nextCursor: start + 20 < items.length ? String(start + 20) : null };
}

function pagedApi(listed: { realizations: Realization[]; releases: Release[] }, failReleaseCursor = false) {
  const calls: { list: 'realizations' | 'releases'; limit?: number; cursor?: string }[] = [];
  const main = () => ({
    v1: {
      works: () => ({
        realizations: { get: async ({ query }: { query: { limit?: number; cursor?: string } }) => {
          calls.push({ list: 'realizations', limit: query.limit, cursor: query.cursor });
          return { data: pageOf(listed.realizations, query.cursor), error: null };
        } },
        releases: { get: async ({ query }: { query: { limit?: number; cursor?: string } }) => {
          calls.push({ list: 'releases', limit: query.limit, cursor: query.cursor });
          if (failReleaseCursor && query.cursor) return { data: null, error: { status: 503, value: null } };
          return { data: pageOf(listed.releases, query.cursor), error: null };
        } },
      }),
    },
  });
  return { calls, api: mainTrackingApi('https://rezics.com/id/agent', main as unknown as () => MainClient) };
}

function control(editions: Editions | null, failed = false): string {
  return renderToStaticMarkup(createElement(EditionContinuation, { editions, failed, busy: false, t, onMore: () => {} }));
}

function names(editions: Editions, query = ''): string[] {
  return editionOptions(work, editions, null)
    .filter(option => option.kind !== 'work' && editionListed(editionName(option.resource, option.kind, editions, 'en', t), query))
    .map(option => option.resource);
}

describe('edition pages', () => {
  test('edition 21 is on the next page, in order, and the filter can find it once it is listed', async () => {
    const listed = { realizations: realizations(0), releases: releases(21) };
    const { calls, api } = pagedApi(listed);
    const first = await api.editions(work);
    if (!first.ok) throw new Error('first page failed');
    expect(first.data.releases.map(item => item.title.value)).toEqual(releases(20).map(item => item.title.value));
    expect(first.data.releasesCursor).toBe('20');
    expect(editionContinuation(first.data, false)).toBe('more');
    expect(names(first.data, 'Release 21')).toEqual([]);
    expect(calls).toEqual([
      { list: 'realizations', limit: 20 },
      { list: 'releases', limit: 20 },
    ]);

    const second = await api.editions(work, { releases: first.data.releasesCursor! });
    if (!second.ok) throw new Error('second page failed');
    const joined = appendEditionPage(first.data, second.data, { realizations: false, releases: true });
    expect(joined.releases.map(item => item.id)).toEqual(releases(21).map(item => item.id));
    expect(joined.releasesCursor).toBeNull();
    expect(joined.more).toBe(false);
    expect(new Set(joined.releases.map(item => item.id)).size).toBe(21);
    expect(names(joined, 'Release 21')).toEqual([fixture.iri('e21')]);
    expect(calls.filter(call => call.list === 'realizations')).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ list: 'releases', limit: 20, cursor: '20' });
  });

  test('a repeated edition stays where it was first listed', () => {
    const all = releases(21);
    const current: Editions = { realizations: [], releases: all.slice(0, 20), realizationsCursor: null, releasesCursor: '20', more: true };
    const overlap: Editions = { realizations: [], releases: [all[19]!, all[20]!], realizationsCursor: null, releasesCursor: null, more: false };
    const joined = appendEditionPage(current, overlap, { realizations: false, releases: true });
    expect(joined.releases.map(item => item.id)).toEqual(all.map(item => item.id));
  });

  test('a work with exactly 20 editions shows no more control', async () => {
    const { api } = pagedApi({ realizations: [], releases: releases(20) });
    const read = await api.editions(work);
    if (!read.ok) throw new Error('page failed');
    expect(read.data.releases).toHaveLength(20);
    expect(read.data.releasesCursor).toBeNull();
    expect(read.data.realizationsCursor).toBeNull();
    expect(read.data.more).toBe(false);
    expect(editionContinuation(read.data, false)).toBeNull();
    expect(control(read.data)).toBe('');
  });

  test('a failed next page keeps the loaded editions and offers a retry', async () => {
    const { api } = pagedApi({ realizations: realizations(21), releases: releases(25) }, true);
    const first = await api.editions(work);
    if (!first.ok) throw new Error('first page failed');
    const query: EditionPageQuery = { realizations: first.data.realizationsCursor!, releases: first.data.releasesCursor! };
    const second = await api.editions(work, query);
    expect(second.ok).toBe(false);
    const applied = applyEditionPage(first.data, second, { realizations: true, releases: true });
    expect(applied.retry).toBe(true);
    expect(applied.editions.releases.map(item => item.id)).toEqual(first.data.releases.map(item => item.id));
    expect(applied.editions.realizations.map(item => item.id)).toEqual(first.data.realizations.map(item => item.id));
    expect(applied.editions.releasesCursor).toBe(first.data.releasesCursor);
    const html = control(applied.editions, true);
    expect(html).toContain(t.retry);
    expect(html).toContain(t.moreEditionsFailed);
    expect(html).not.toContain(t.moreEditions);
  });

  test('continuing both lists appends each in its own order', async () => {
    const listed = { realizations: realizations(21), releases: releases(21) };
    const { calls, api } = pagedApi(listed);
    const first = await api.editions(work);
    if (!first.ok) throw new Error('first page failed');
    const second = await api.editions(work, { realizations: first.data.realizationsCursor!, releases: first.data.releasesCursor! });
    if (!second.ok) throw new Error('second page failed');
    const joined = appendEditionPage(first.data, second.data, { realizations: true, releases: true });
    expect(joined.realizations.map(item => item.id)).toEqual(listed.realizations.map(item => item.id));
    expect(joined.releases.map(item => item.id)).toEqual(listed.releases.map(item => item.id));
    expect(calls.filter(call => call.cursor === '20').map(call => call.list).sort()).toEqual(['realizations', 'releases']);
  });
});
