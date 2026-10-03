import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { searchPageCredits, searchPageSerial } from '../src/modules/search/result-cards.ts';
import { readRatingProjectionHealth, ratingProjectionHealth } from '../src/modules/rating/projection-health.ts';
import { WorkReadLimit, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { metadataComponent } from '../src/modules/work/metadata-schema.ts';
import { optionalPreview } from '../src/modules/query/optional-preview.ts';
import { readAuthorNames, fenceAuthorNames, sourceReportedCredits } from '../src/modules/source/author-name-read.ts';
import { namedDiscoveryCredits } from '../src/modules/discovery/credits.ts';
import { uuidToSid } from '@rezics/model/address';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const field = (value: string) => ({ value });
const position = { dataEpoch: 'epoch', sequence: '7400' };
const session = (own: object) => ({ options: { language: 'en' }, position, deps: {}, checkDeadline() {}, ...own }) as unknown as WorkReadSession;

test('G1012: one damaged serial header leaves its healthy neighbour rich; authoritative reads still fail', async () => {
  const state = { kind: 'header' as const, originalTitle: null, localized: [{ language: 'en',
    title: null, description: null, mainVersionLabel: null, tagline: 'Healthy metadata' }] };
  const reader = session({ query: async () => [
    { work: field(id(1)), head: field(id(11)) },
    { work: field(id(2)), head: field(id(12)), component: field(metadataComponent(id(2), state)),
      state: field(JSON.stringify(state)) },
  ] });
  const previews = await searchPageSerial(reader, [id(1), id(2)], true);
  expect(previews.has(id(1))).toBe(false);
  expect(previews.get(id(2))).toMatchObject({ tagline: { value: 'Healthy metadata' } });
  await expect(searchPageSerial(reader, [id(1), id(2)])).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G1012: a lagging serial projection withholds counts and reports unknown rather than exact zero', async () => {
  const reader = session({ query: async () => [{ work: field(id(1)) }],
    deps: { serialStats: { batch: async () => new Map() } } });
  expect((await searchPageSerial(reader, [id(1)], true)).get(id(1))).toMatchObject({
    chapterCount: null, wordCount: null, lastUpdatedAt: null, unavailablePreviews: ['serial'],
  });
});

test('G1012: damaged credit facts affect only their Work, while relation budgets remain required', async () => {
  const reader = session({ query: async () => [
    { work: field(id(1)), id: field(id(11)), key: field('/authors/OL1A'), ordinal: field('broken') },
    { work: field(id(2)), id: field(id(12)), key: field('/authors/OL2A'), ordinal: field('0') },
  ] });
  const credits = await searchPageCredits(reader, [id(1), id(2)], true);
  expect(credits.has(id(1))).toBe(false);
  expect(credits.get(id(2))).toMatchObject([{ key: '/authors/OL2A' }]);
  await expect(searchPageCredits(reader, [id(1), id(2)])).rejects.toBeInstanceOf(WorkReadUnavailable);
  const limit = new WorkReadLimit('graph rows exceeded');
  const bounded = session({ query: async () => { throw limit; } });
  await expect(optionalPreview(bounded, () => searchPageCredits(bounded, [id(1)], true))).rejects.toBe(limit);
});

test('G1012: preview source names do not install a mandatory final owner fence', async () => {
  let calls = 0;
  const reader = session({ deps: { sourceAuthorNames: { batch: async () => {
    if (++calls > 2) throw new WorkReadUnavailable('source owner unavailable');
    return new Map();
  } } } });
  await readAuthorNames(reader, ['/authors/OL1A'], true);
  await fenceAuthorNames(reader);
  expect(calls).toBe(2);
  await expect(readAuthorNames(reader, ['/authors/OL1A'])).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G1012: an ambiguous Agent name is withheld without discarding unrelated credit names', async () => {
  const credit = (agent: string) => ({ id: id(10), role: 'author' as const, participantKind: 'agent' as const,
    provider: null, key: null, ordinal: null, agent, displayName: null, handle: null });
  const reader = session({ query: async () => [
    { agent: field(id(1)), displayName: field('First'), handle: field('first') },
    { agent: field(id(1)), displayName: field('Conflicting'), handle: field('conflicting') },
    { agent: field(id(2)), displayName: field('Healthy'), handle: field('healthy') },
  ] });
  const names = await namedDiscoveryCredits(reader, [credit(id(1)), credit(id(2))], 20, true);
  expect(names.has(id(1))).toBe(false);
  expect(names.get(id(2))).toEqual({ displayName: 'Healthy', handle: null,
    address: { prefix: '/a/', key: uuidToSid(id(2).slice(-36)), slugSource: '' } });
  await expect(namedDiscoveryCredits(reader, [credit(id(1)), credit(id(2))])).rejects.toBeInstanceOf(WorkReadUnavailable);
  const handles = session({ query: async () => [
    { agent: field(id(1)), displayName: field('Affected') },
    { agent: field(id(2)), displayName: field('Healthy') },
  ], deps: { agentHandles: { current: async (agent: string) => {
    if (agent === id(1)) throw new WorkReadUnavailable('Handle owner unavailable');
    return 'healthy';
  } } } });
  const named = await namedDiscoveryCredits(handles, [credit(id(1)), credit(id(2))], 20, true);
  expect(named.has(id(1))).toBe(false);
  expect(named.get(id(2))).toEqual({ displayName: 'Healthy', handle: 'healthy',
    address: { prefix: '/@', key: 'healthy', slugSource: '' } });
});

test('G1012: optional source bindings are fenced after names, so removal affects only that Work', async () => {
  let removed = false;
  const refs = () => new Map([id(1), id(2)].filter(work => work !== id(1) || !removed)
    .map(work => [work, [{ id: work, key: '/authors/OL1A', ordinal: 0 }]]));
  const reader = session({ deps: {
    sourceAdoptions: { authorReferences: async () => refs() },
    sourceAuthorNames: { batch: async () => { removed = true; return new Map(); } },
  } });
  const credits = await sourceReportedCredits(reader, [id(1), id(2)], 3, true);
  expect(credits.has(id(1))).toBe(false);
  expect(credits.get(id(2))).toHaveLength(1);
  await fenceAuthorNames(reader);
});

test('G1012: rating health reports lag, missing generation and recovery at the same graph cut', async () => {
  let generation: { source_epoch: string; source_sequence: string; stale: boolean } | null = {
    source_epoch: position.dataEpoch, source_sequence: '7190', stale: true,
  };
  const reader = session({ query: async () => [{ context: field(id(1)) }], deps: { discovery: {
    active: async () => {
      if (!generation) throw new WorkReadUnavailable('no rating generation');
      return generation;
    },
  } } });
  const lagged = await readRatingProjectionHealth(reader);
  expect(Value.Check(ratingProjectionHealth, lagged)).toBe(true);
  expect(lagged).toMatchObject({ status: 'unavailable', sequenceLag: '210',
    projectionPosition: { dataEpoch: 'epoch', sequence: '7190' } });
  generation = null;
  expect(await readRatingProjectionHealth(reader)).toMatchObject({ status: 'unavailable', sequenceLag: null });
  generation = { source_epoch: 'epoch', source_sequence: '7400', stale: false };
  expect(await readRatingProjectionHealth(reader)).toMatchObject({ status: 'ready', sequenceLag: '0' });
  expect(await readRatingProjectionHealth(session({ query: async () => [] })))
    .toMatchObject({ status: 'not-configured', context: null });
});
