import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { editions as fixture, equivalentDefinition, indexSummary, iri, saoOne, spiderRelations } from './fixtures.ts';
import { createMemoryMain, memoryTracking } from './memory.ts';
import { copyOf } from './messages.ts';
import { equivalentCounterparts, mergeSeriesSetup, PreferenceForm } from './series-progress-panel.tsx';
import { applyEditionPage, editionRequest } from './tracking-sheet.tsx';
import type { EditionPreference, Editions } from './types.ts';

const preference: EditionPreference = { work: saoOne, language: 'pl', version: 7,
  edition: { kind: 'release', resource: iri('41'), revision: iri('419') } };
const releases = Array.from({ length: 45 }, (_, index) => ({
  ...fixture.releases[0]!, id: iri(String(index + 1)), revision: iri(String(index + 101)),
  contentLanguages: [index === 40 ? 'pl' : 'en'],
}));
const firstPage: Editions = { realizations: [], releases: releases.slice(0, 20), releasesCursor: '20', more: true };

test('equivalent batch actions require a complete incidence answer and leave its opaque frontier intact', () => {
  const webRelations = spiderRelations();
  const expected = equivalentCounterparts(webRelations, equivalentDefinition);
  expect(expected).not.toHaveLength(0);
  const next = 'opaque:+/%?=&雪';
  const partial = { ...webRelations, next };
  expect(equivalentCounterparts(partial, equivalentDefinition)).toEqual([]);
  expect(partial.items).toBe(webRelations.items);
  expect(partial.next).toBe(next);
  expect(equivalentCounterparts(webRelations, equivalentDefinition)).toEqual(expected);
});

function render(editions: Editions | null) {
  return renderToStaticMarkup(<PreferenceForm work={saoOne} preference={preference} language="pl"
    editions={editions} api={memoryTracking(createMemoryMain())} locale="en" t={copyOf('en')}
    onSaved={() => {}} onLanguage={() => {}} />);
}

test('a saved edition outside the first page remains visible beside its content language', () => {
  const html = render(firstPage);
  expect(html).toContain('Polish');
  expect(html).toContain('Selected edition');
  expect(html).toContain('Show more editions');
});

test('an unavailable edition list keeps the saved edition visible and offers recovery', () => {
  const html = render(null);
  expect(html).toContain('Polish');
  expect(html).toContain('Selected edition');
  expect(html).toContain('Try again');
});

test('moved and unknown edition cursors must restart instead of retrying the rejected cursor', () => {
  for (const failure of ['moved', 'invalid'] as const) {
    const applied = applyEditionPage(firstPage, { ok: false, failure }, { realizations: false, releases: true });
    expect(applied.editions).toBe(firstPage);
    expect(applied.retry).toBe(true);
    expect(applied.restart).toBe(true);
  }
  const unavailable = applyEditionPage(firstPage, { ok: false, failure: 'unavailable' },
    { realizations: false, releases: true });
  expect(unavailable.restart).toBe(false);
});

test('edition traversal continues through a third page until all 45 editions and Polish are listed', () => {
  let listed = firstPage;
  const requests: unknown[] = [];
  for (let next = editionRequest(listed); next; next = editionRequest(listed)) {
    requests.push(next.query);
    const start = Number(next.query.releases);
    const cursor = start + 20 < releases.length ? String(start + 20) : null;
    const page: Editions = { realizations: [], releases: releases.slice(start, start + 20),
      releasesCursor: cursor, more: cursor !== null };
    listed = applyEditionPage(listed, { ok: true, data: page }, next.requested).editions;
  }
  expect(requests).toEqual([{ releases: '20' }, { releases: '40' }]);
  expect(listed.releases).toHaveLength(45);
  expect(listed.releases[40]?.contentLanguages).toEqual(['pl']);
  expect(editionRequest(listed)).toBeNull();
});

test('the memory read never substitutes a different Work for a missing progress summary', async () => {
  const api = memoryTracking(createMemoryMain({ summaries: { en: indexSummary } }));
  expect(await api.series(saoOne, 'en')).toEqual({ ok: false, failure: 'missing' });
  expect(await api.series(indexSummary.resource, 'en')).toEqual({ ok: true, data: indexSummary });
});

test('independent edition details belong to the requested Work in the memory API', async () => {
  const api = memoryTracking(createMemoryMain({ editions: fixture }));
  for (const kind of ['realization', 'release'] as const) {
    const item = kind === 'realization' ? fixture.realizations[0]! : fixture.releases[0]!;
    const choice = { kind, resource: item.id, revision: item.revision };
    expect(await api.edition(iri('other-work'), choice)).toEqual({ ok: false, failure: 'missing' });
    expect(await api.edition(saoOne, choice)).toEqual({ ok: true, data: item });
  }
});

test('an initial setup read supplies relations and editions without overwriting an intervening saved or cleared choice', () => {
  const api = memoryTracking(createMemoryMain());
  const loaded = { work: saoOne, api, generation: 2, preference: { ...preference, language: 'en', version: 1 },
    editions: firstPage, counterparts: [{ work: iri('counterpart'), title: 'Equivalent book' }] };
  for (const saved of [preference, null]) {
    const event = { work: saoOne, api, generation: 2, preference: saved, editions: null, counterparts: [] };
    const merged = mergeSeriesSetup(event, loaded);
    expect(merged.preference).toBe(saved);
    expect(merged.editions).toBe(firstPage);
    expect(merged.counterparts).toEqual(loaded.counterparts);
  }
  expect(mergeSeriesSetup(null, loaded)).toBe(loaded);
  expect(mergeSeriesSetup({ ...loaded, work: iri('other-work') }, loaded)).toBe(loaded);
  expect(mergeSeriesSetup({ ...loaded, api: memoryTracking(createMemoryMain()) }, loaded)).toBe(loaded);
  expect(mergeSeriesSetup({ ...loaded, generation: 1, preference }, loaded)).toBe(loaded);
});
