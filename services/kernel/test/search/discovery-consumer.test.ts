import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { DiscoveryHit, DiscoveryKey, DiscoveryRegistryOptions } from '../../src/search/discovery.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { discoveryDocumentActions, discoveryDocumentId } from '../../src/search/discovery-documents.ts';
import { admitDiscoveryRequest } from '../../src/search/discovery-request.ts';
import { readDiscoveryCandidates, type DiscoveryCandidate } from '../../src/search/discovery-query.ts';
import { DiscoveryFrontier } from '../../src/search/discovery-frontier.ts';
import { decodeDiscoveryCursor, encodeDiscoveryCursor, type DiscoveryCursorState } from '../../src/search/cursor.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';

// Pure consumer/codec cases. The existing mixed-discovery native suite remains the product proof.
const noRead = async (): Promise<never> => {
  throw new Error('Pure admission must not read a producer');
};
const options: DiscoveryRegistryOptions = {
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
};
const registry = createDiscoveryRegistry(options);
const id = '018f0000-0000-7000-8000-00a000000001';
const accountKey: DiscoveryKey = { owner: 'accounts', kind: 'account', route: 160, id };
const personKey: DiscoveryKey = { owner: 'semantic', kind: 'schema:Person', route: 160, id };
const request = {
  representation: 'discovery-v1' as const,
  filter: { and: [{ kind: { in: ['account', 'schema:Person'] } }, { not: { type: { in: ['schema:Book'] } } }] },
  sort: 'id' as const,
  languages: ['en'],
  kindCountLeaf: 0,
};
const projected = discoveryDocumentActions(
  registry,
  {
    owner: 'accounts',
    snapshot: {
      partition: 10,
      position: 17n,
      accounts: [{ id, accountKind: 'actor', handle: null, displayName: 'Reader', revision: 11n }],
    },
  },
  [accountKey],
);
const action = projected[0]!;
if (action.op !== 'index') throw new Error('Expected the real document builder to project a fixture');
const complete = (hits: unknown[]) => ({
  timed_out: false,
  _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
  hits: { hits },
});
const candidate: DiscoveryCandidate = {
  key: accountKey,
  document: action.document,
  index: 'test-discovery-g1',
  sort: [id, 'account', discoveryDocumentId(registry, accountKey)],
};
const hit: DiscoveryHit = {
  key: accountKey,
  summary: {
    kind: 'account',
    value: {
      id,
      accountKind: 'actor',
      handle: null,
      displayName: 'Reader',
      automated: false,
      operatorId: null,
      avatar: null,
      verifiedAgent: null,
    },
  },
};

test('mixed admission removes only the designated direct kind child from the count population', () => {
  const admitted = admitDiscoveryRequest(request, registry, bundledRelease);
  expect(admitted.countFilter).toEqual({ not: { type: { in: ['schema:Book'] } } });
  expect(admitted.filter).toEqual(request.filter);
  expect(() => admitDiscoveryRequest({ ...request, kindCountLeaf: 1 }, registry, bundledRelease)).toThrow();
  expect(() => admitDiscoveryRequest({ ...request, sort: 'rating' }, registry, bundledRelease)).toThrow();
  expect(() => admitDiscoveryRequest({ ...request, kindPage: { limit: 9 } }, registry, bundledRelease)).toThrow();
  expect(() => admitDiscoveryRequest({ ...request, kindPage: JSON.parse('{}') }, registry, bundledRelease)).toThrow();
  expect(() =>
    admitDiscoveryRequest({ ...request, filter: { kind: { in: ['absent'] } } }, registry, bundledRelease),
  ).toThrow();
});

test('mixed native payload requires complete physical identity and the full comparator frontier', () => {
  const native = {
    _id: discoveryDocumentId(registry, accountKey),
    _index: candidate.index,
    _source: candidate.document,
    sort: candidate.sort,
  };
  const plan = { sort: 'id' as const, size: 3, filter: { match_all: {} } };
  expect(readDiscoveryCandidates(complete([native]), registry, candidate.index, plan)).toEqual([candidate]);
  for (const changed of [
    { ...native, _id: id },
    { ...native, _index: 'another-incarnation' },
    { ...native, sort: [id] },
    { ...native, sort: [id, 'schema:Person', native._id] },
    { ...native, _score: Infinity },
  ])
    expect(() => readDiscoveryCandidates(complete([changed]), registry, candidate.index, plan)).toThrow(
      SearchUnavailableError,
    );
  expect(() => readDiscoveryCandidates(complete([native, native]), registry, candidate.index, plan)).toThrow();
  expect(() =>
    readDiscoveryCandidates({ ...complete([native]), timed_out: true }, registry, candidate.index, plan),
  ).toThrow();
});

test('the shared frontier preserves unconsumed lookahead, refills stale heads and refuses a partial chain', () => {
  const later = { ...candidate, key: personKey, sort: [id, 'schema:Person', discoveryDocumentId(registry, personKey)] };
  const person: DiscoveryHit = {
    key: personKey,
    summary: {
      kind: 'subject',
      value: {
        id,
        type: 'schema:Person',
        types: ['schema:Person'],
        label: { value: 'Reader', language: 'en' },
        creativeWork: false,
        cover: null,
      },
    },
  };
  const first = new DiscoveryFrontier(1);
  expect(first.nextSize()).toBe(3);
  first.consume(
    [candidate, later],
    new Map([
      [candidate, hit],
      [later, person],
    ]),
  );
  first.requireUsefulPage();
  expect(first.hits).toEqual([hit]);
  expect(first.after).toEqual(candidate.sort);
  expect(first.exhausted).toBe(false);
  const second = new DiscoveryFrontier(1, first.after);
  second.nextSize();
  second.consume([later], new Map([[later, person]]));
  second.requireUsefulPage();
  expect(second.hits).toEqual([person]);
  expect(second.exhausted).toBe(true);
  const sparse = new DiscoveryFrontier(1);
  for (let round = 0; round < 3; round++) {
    expect(sparse.nextSize()).toBe(3);
    sparse.consume([candidate, candidate, candidate], new Map());
  }
  expect(sparse.nextSize()).toBe(0);
  expect(() => sparse.requireUsefulPage()).toThrow(SearchUnavailableError);
});

test('mixed confidential cursors retain the actual observation and bind request, principal and language order', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const binding = {
    operation: 'subjects.search',
    principal: 'anonymous',
    request: admitDiscoveryRequest(request, registry, bundledRelease).bindingRequest,
  };
  const state: DiscoveryCursorState = {
    release: 'release-fixture',
    registry: 'registry-fixture',
    after: candidate.sort,
    queried: {
      consumer: {
        physicalTarget: candidate.index,
        incarnation: 'native-uuid-fixture',
        consumerGeneration: '1',
        projectionGeneration: '1',
        meaningDigest: 'release-fixture',
        readDefinition: 'native-read-fixture',
      },
      snapshot: {
        kind: 'prepared',
        observation: 'retained-observation-fixture',
        build: 'build-fixture',
        generation: 9007199254740997n,
      },
    },
  };
  const token = await encodeDiscoveryCursor(ring, binding, state, 1000);
  expect(await decodeDiscoveryCursor(ring, binding, token, 1001)).toEqual({ ok: true, state });
  expect(token).not.toContain(id);
  for (const changed of [
    { ...binding, principal: `account:${id}` },
    { ...binding, request: { ...binding.request, languages: ['ja', 'en'] } },
  ])
    expect(await decodeDiscoveryCursor(ring, changed, token, 1001)).toEqual({ ok: false, reason: 'invalid' });
  expect(await decodeDiscoveryCursor(ring, binding, token, 1_000_000)).toEqual({ ok: false, reason: 'expired' });
});

test('rejected text has a bounded operation diagnostic and deliberate repair preserves the full request', () => {
  const original = { ...request, text: '😀 心 "こころ', languages: ['zh-Hant', 'ja'] };
  try {
    admitDiscoveryRequest(original, registry, bundledRelease);
    throw new Error('Expected rejected text');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'unsupported_query',
      errors: [{ pointer: '/text', code: 'unsupported' }],
      extensions: { textDiagnostic: { reason: 'unclosed_phrase', start: 5, end: 6, byteOffset: 9 } },
    });
    expect(JSON.stringify(error)).not.toContain('こころ');
    expect(JSON.stringify(error)).not.toContain('schema:Person');
  }
  const repaired = admitDiscoveryRequest({ ...original, text: `${original.text}"` }, registry, bundledRelease);
  expect(repaired.text).toMatchObject({ kind: 'and' });
  expect(repaired.filter).toEqual(request.filter);
  expect(repaired.languages).toEqual(['zh-Hant', 'ja']);
});
