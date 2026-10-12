import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MainClient } from '../features/discover/types.ts';
import { appendEditionPage, mainTrackingApi, type EditionPageQuery } from '../features/tracking/api.ts';
import { editionName } from '../features/tracking/display.ts';
import * as fixture from '../features/tracking/fixtures.ts';
import { copyOf } from '../features/tracking/messages.ts';
import { editionListed, editionOptions } from '../features/tracking/model.ts';
import { AttemptCard } from '../features/tracking/attempt-card.tsx';
import { applyEditionPage, EditionContinuation, editionContinuation } from '../features/tracking/tracking-sheet.tsx';
import type { Editions, Realization, Release, Session } from '../features/tracking/types.ts';

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

  /** The card of one attempt, with the sheet's filter text and the editions loaded so far. */
  const cardOf = (session: Session, editions: Editions, editionQuery: string) => renderToStaticMarkup(createElement(AttemptCard,
    { session, title: 'Read', work, editions, editionQuery, api: pagedApi({ realizations: [], releases: [] }).api, locale: 'en', t,
      onChange: () => {} }));
  const holdingOf = (release: Release, overrides: Partial<Session> = {}) => fixture.session({ selections: [
    ...fixture.session().selections,
    { target: { ...fixture.session().target, resource: release.id, base: 'release' }, language: 'en', format: null, progress: 'locator' }],
  ...overrides });

  test('a filter with no loaded match says more may exist and offers the next page; the match is reachable from it', async () => {
    const { api } = pagedApi({ realizations: [], releases: releases(21) });
    const first = await api.editions(work);
    if (!first.ok) throw new Error('first page failed');
    expect(names(first.data, 'Release 21')).toEqual([]);
    expect(cardOf(fixture.session(), first.data, 'Release 21')).toContain(t.noMatchingEditionsYet);
    expect(control(first.data)).toContain(t.moreEditions);

    const second = await api.editions(work, { releases: first.data.releasesCursor! });
    if (!second.ok) throw new Error('second page failed');
    const joined = appendEditionPage(first.data, second.data, { realizations: false, releases: true });
    expect(names(joined, 'Release 21')).toEqual([fixture.iri('e21')]);
    const card = cardOf(fixture.session(), joined, 'Release 21');
    expect(card).not.toContain(t.noMatchingEditionsYet);
    expect(card).toContain('Release 21 ');
  });

  test("each attempt's note follows its own matches: one that holds the only loaded match says so while another still lists it", async () => {
    const all = releases(21);
    all[0] = { ...all[0]!, title: { ...all[0]!.title, value: 'Balance' } };
    all[20] = { ...all[20]!, title: { ...all[20]!.title, value: 'Balance patch' } };
    const { api } = pagedApi({ realizations: [], releases: all });
    const first = await api.editions(work);
    if (!first.ok) throw new Error('first page failed');
    const active = holdingOf(all[0]!);
    const older = fixture.session({ id: fixture.iri('a02'), state: 'finished', finishedOn: '2026-08' });
    // The active attempt holds "Balance", so nothing loaded is left for it; the older one still lists it.
    expect(cardOf(active, first.data, 'Balance')).toContain(t.noMatchingEditionsYet);
    const other = cardOf(older, first.data, 'Balance');
    expect(other).not.toContain(t.noMatchingEditionsYet);
    expect(other).toContain('Balance ');
    expect(control(first.data)).toContain(t.moreEditions);

    const second = await api.editions(work, { releases: first.data.releasesCursor! });
    if (!second.ok) throw new Error('second page failed');
    const joined = appendEditionPage(first.data, second.data, { realizations: false, releases: true });
    const after = cardOf(active, joined, 'Balance');
    expect(after).not.toContain(t.noMatchingEditionsYet);
    expect(after).toContain('Balance patch');
  });

  test('an existing attempt lists only the filtered editions, and the one on the next page once it is loaded', async () => {
    const { api } = pagedApi({ realizations: [], releases: releases(21) });
    const first = await api.editions(work);
    if (!first.ok) throw new Error('first page failed');
    const second = await api.editions(work, { releases: first.data.releasesCursor! });
    if (!second.ok) throw new Error('second page failed');
    const joined = appendEditionPage(first.data, second.data, { realizations: false, releases: true });
    const card = (editions: Editions, editionQuery: string) => cardOf(fixture.session(), editions, editionQuery);
    expect(card(first.data, '')).toContain('Release 1 ');
    expect(card(first.data, 'Release 21')).not.toContain('Release 1 ');
    expect(card(joined, 'Release 21')).toContain('Release 21 ');
    expect(card(joined, 'Release 21')).not.toContain('Release 1 ');
  });

  test('a filter with no match on the last page says none exists', async () => {
    const { api } = pagedApi({ realizations: [], releases: releases(3) });
    const read = await api.editions(work);
    if (!read.ok) throw new Error('page failed');
    const markup = cardOf(fixture.session(), read.data, 'nothing like this');
    expect(markup).toContain(t.noMatchingEditions);
    expect(markup).not.toContain(t.noMatchingEditionsYet);
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
