import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import {
  discoveryDocumentActions,
  discoveryDocumentId,
  mixedDiscoveryIndexDefinition,
} from '../../src/search/discovery-documents.ts';
import { requiresAdvancedDiscoverySearch } from '../../src/search/discovery-request.ts';
import { readDiscoveryEngineResult } from '../../src/search/discovery-query.ts';
import { decodeDiscoveryCursor, encodeDiscoveryCursor, type DiscoveryCursorState } from '../../src/search/cursor.ts';
import type { DiscoveryKey } from '../../src/search/discovery.ts';

const noRead = async (): Promise<never> => {
  throw new Error('Decoder must not read a source');
};
const registry = createDiscoveryRegistry({
  release: bundledRelease,
  semantic: {
    source: { read: noRead, count: noRead },
    hydrate: noRead,
    icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
  },
  accounts: {
    source: { read: noRead, count: noRead, page: noRead },
    hydrate: noRead,
    labels: { en: 'Accounts' },
    icon: 'account',
  },
});
const id = '018f0000-0000-7000-8000-00a000000001';
const key: DiscoveryKey = { owner: 'accounts', kind: 'account', route: 160, id };
const snapshot = {
  partition: 10,
  position: 9007199254740997n,
  accounts: [{ id, revision: 9007199254740995n, accountKind: 'actor' as const, handle: null, displayName: 'Reader' }],
};
const [action] = discoveryDocumentActions(
  registry,
  { owner: 'accounts', snapshot },
  [key],
  undefined,
  'mixed-public-v1',
);
if (action?.op !== 'index') throw new Error('Expected projection');
const document = action.document;
const index = 'test-discovery-g1';
const sort = [id, 'account', discoveryDocumentId(registry, key)];
const hit = { _id: action.id, _index: index, _source: document, sort };
const complete = (values: unknown[]) => ({
  timed_out: false,
  _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
  hits: { hits: values },
});
const plan = { sort: 'id' as const, size: 3, filter: { match_all: {} } };

test('mixed decoder preserves exact native Account revision and tagged identity without a public total', () => {
  expect(document).toMatchObject({
    document_format: 2,
    identity: action.id,
    names: ['Reader'],
    descriptions: [],
    name_sort: 'Reader',
  });
  expect(readDiscoveryEngineResult(complete([hit]), registry, index, plan)).toEqual({
    hits: [
      {
        key,
        index,
        sourcePosition: snapshot.position.toString(),
        revision: snapshot.accounts[0]!.revision.toString(),
        matched: [],
        sort,
      },
    ],
  });
  expect(mixedDiscoveryIndexDefinition().mappings._meta).toMatchObject({
    discovery_document_format: 2,
    comparator: 'mixed-public-v1',
  });
  for (const source of [
    { ...document, document_format: 1 },
    { ...document, identity: id },
    { ...document, revision: '09007199254740995' },
    { ...document, descriptions: ['private biography'] },
  ])
    expect(() => readDiscoveryEngineResult(complete([{ ...hit, _source: source }]), registry, index, plan)).toThrow();
  expect(() => readDiscoveryEngineResult({ ...complete([hit]), timed_out: true }, registry, index, plan)).toThrow();
  expect(() =>
    readDiscoveryEngineResult(complete([{ ...hit, sort: ['wrong', ...sort] }]), registry, index, {
      ...plan,
      sort: 'name',
    }),
  ).toThrow();
});

test('mixed continuation retains a raw consumed prefix without an engine frontier and binds the caller', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const binding = {
    operation: 'subjects.search',
    principal: 'anonymous',
    request: { representation: 'discovery-v1', limit: 1, languages: ['en'] },
  };
  const state: DiscoveryCursorState = {
    release: 'release',
    registry: 'registry',
    after: [],
    retained: { execution: 'actual-execution-locator', consumed: 2 },
    queried: {
      consumer: {
        physicalTarget: index,
        incarnation: 'native-uuid',
        consumerGeneration: '1',
        projectionGeneration: '1',
        meaningDigest: 'release',
        readDefinition: 'native-definition',
      },
      snapshot: { kind: 'pit', observation: 'native-observation', pit: 'native-pit' },
    },
  };
  state.repair = { consumer: state.queried.consumer, job: 'native-repair-job' };
  const token = await encodeDiscoveryCursor(ring, binding, state, 1000);
  expect(await decodeDiscoveryCursor(ring, binding, token, 1001)).toEqual({ ok: true, state });
  expect(() => encodeDiscoveryCursor(ring, binding, { ...state, after: ['raw-frontier'] }, 1000)).toThrow();
  for (const changed of [
    { ...binding, principal: `account:${id}` },
    { ...binding, request: { ...binding.request, languages: ['ja'] } },
  ])
    expect(await decodeDiscoveryCursor(ring, changed, token, 1001)).toEqual({ ok: false, reason: 'invalid' });
});

test('the existing gate classifies kind.in through the mixed grammar without rejecting it as a Subject leaf', () => {
  expect(
    requiresAdvancedDiscoverySearch({ representation: 'discovery-v1', filter: { kind: { in: ['account'] } } }),
  ).toBe(false);
  expect(
    requiresAdvancedDiscoverySearch({ representation: 'discovery-v1', filter: { not: { kind: { in: ['account'] } } } }),
  ).toBe(true);
});
