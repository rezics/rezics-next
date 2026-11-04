import { expect, test } from 'bun:test';
import {
  createContentShelfTitleSource,
  type ContentShelfTitleInputs,
} from '../../src/library/shelf-title-content-source.ts';
import { shelfTitleKey } from '../../src/library/shelf-title-key.ts';
import { newId } from '../../src/route/route.ts';

const owner = { route: 0x6a10, accountId: newId(0x6a10) };
const viewer = {
  kind: 'account' as const,
  accountId: owner.accountId,
  clientId: newId(owner.route),
  requestedBy: null,
  authnEpoch: 1,
  scopes: ['library_entry:list'],
};
const subjectId = newId(0x7b20);
const disclosed = {
  state: 'disclosed' as const,
  subjectId,
  sourceId: subjectId,
  sourceBasis: 'source-owner:1',
  labels: { en: 'Road', fr: 'Route' },
  originalLanguage: 'en',
};
type Observation = Awaited<ReturnType<ContentShelfTitleInputs['observe']>>;

test('one complete-source observation batches exact originals and retains missing labels separately from identity', async () => {
  const missingId = newId(0x7b20);
  const calls: string[][] = [];
  const source = createContentShelfTitleSource({
    async observe(input) {
      calls.push([...input.subjects]);
      expect(input.languages).toEqual(['fr', 'en']);
      expect(input.owner).toEqual(owner);
      expect(input.viewer).toBe(viewer);
      return {
        status: 'current',
        version: 'whole-source:1',
        entries: input.subjects.length ? [{ ...disclosed, subjectId: missingId, labels: {} }, disclosed] : [],
      };
    },
  });
  const basis = await source.basis(owner, ['FR', 'en'], viewer);
  if (basis.status !== 'current') throw new Error('Expected basis');
  const labels = await source.labels(owner, ['fr', 'en'], basis.version, [subjectId, missingId], viewer);
  if (labels.status !== 'current') throw new Error('Expected complete batch');
  expect(calls).toEqual([[], [subjectId, missingId]]);
  expect(labels.entries.map((row) => shelfTitleKey(row.labels, ['fr', 'en'], row.originalLanguage).coverage)).toEqual([
    'missing',
    'labelled',
  ]);
  expect(labels.entries[1]?.sourceId).toBe(subjectId);
});

test('rename, redirect, source-owner and disclosure basis changes retire the captured title input', async () => {
  let version = 'whole-source:1';
  const source = createContentShelfTitleSource({
    observe: async (input) => ({ status: 'current', version, entries: input.subjects.length ? [disclosed] : [] }),
  });
  const basis = await source.basis(owner, ['en'], viewer);
  if (basis.status !== 'current') throw new Error('Expected basis');
  for (const change of ['rename', 'redirect', 'source-owner', 'disclosure']) {
    version = `whole-source:${change}`;
    expect(await source.labels(owner, ['en'], basis.version, [subjectId], viewer)).toEqual({ status: 'unavailable' });
  }
  version = 'whole-source:1';
  for (const [languages, actor] of [
    [['fr'], viewer],
    [['en'], { ...viewer, authnEpoch: 2 }],
    [['en'], { ...viewer, clientId: newId(owner.route) }],
    [['en'], { ...viewer, scopes: [] }],
  ] as const)
    expect(await source.labels(owner, languages, basis.version, [subjectId], actor)).toEqual({ status: 'unavailable' });
});

test('partial, duplicate, unknown and hidden identities fail closed instead of manufacturing missing titles', async () => {
  let observed: Observation = { status: 'current', version: 'whole-source:1', entries: [] };
  const source = createContentShelfTitleSource({ observe: async () => observed });
  const basis = await source.basis(owner, [], viewer);
  if (basis.status !== 'current') throw new Error('Expected basis');
  for (const entries of [
    [],
    [disclosed, disclosed],
    [{ ...disclosed, subjectId: newId(0x7b20) }],
    [{ state: 'unavailable' as const, subjectId }],
    [{ ...disclosed, sourceBasis: '' }],
    [{ ...disclosed, sourceId: 'unknown' }],
  ]) {
    observed = { status: 'current', version: 'whole-source:1', entries };
    expect(await source.labels(owner, [], basis.version, [subjectId], viewer)).toEqual({ status: 'unavailable' });
  }
  observed = { status: 'unavailable' };
  expect(await source.basis(owner, [], viewer)).toEqual({ status: 'unavailable' });
});

test('oversized and inexact batches never reach Content, while 100 subjects use one batch', async () => {
  let calls = 0;
  const source = createContentShelfTitleSource({
    observe: async () => {
      calls++;
      return { status: 'unavailable' };
    },
  });
  for (const ids of [Array.from({ length: 101 }, () => newId(0x7b20)), [subjectId, subjectId], ['unknown']])
    await expect(source.labels(owner, [], 'basis', ids, viewer)).rejects.toBeInstanceOf(RangeError);
  expect(calls).toBe(0);
  expect(
    await source.labels(
      owner,
      [],
      'basis',
      Array.from({ length: 100 }, () => newId(0x7b20)),
      viewer,
    ),
  ).toEqual({
    status: 'unavailable',
  });
  expect(calls).toBe(1);
});
