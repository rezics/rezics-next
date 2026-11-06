import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { routeOf } from '../../src/route/route.ts';
import { currentDiscoveryCandidates } from '../../src/search/discovery-current.ts';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { proveKindCount } from '../../src/search/kind-count-proof.ts';
import { selectCurrentPredicatePage } from '../../src/search/current-predicate.ts';
import type { DiscoveryEngineHit, DiscoveryReadContext, DiscoveryRegistryOptions } from '../../src/search/discovery.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import { subjectPartition, type IndexedSubject, type SubjectSnapshot } from '../../src/search/source.ts';

const unused = async (): Promise<never> => {
  throw new Error('Current disclosure must not read an unrelated producer');
};
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const access: Access = new Proxy({} as Access, {
  get() {
    throw new Error('Current disclosure must not consult Access for catalogue visibility');
  },
});
const context: DiscoveryReadContext = {
  actor: { kind: 'anonymous' },
  deadline: 1,
  access,
  languages: ['en'],
};
const editor: DiscoveryReadContext = {
  ...context,
  actor: {
    kind: 'account',
    accountId: id(9),
    clientId: 'editor',
    scopes: [],
    requestedBy: null,
    authnEpoch: 1,
  } satisfies AccountActor,
};
const suspended: DiscoveryReadContext = {
  ...context,
  actor: {
    kind: 'account',
    accountId: id(8),
    clientId: 'suspended',
    scopes: [],
    requestedBy: null,
    authnEpoch: 1,
  } satisfies AccountActor,
};
const book = (n: number, patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [{ property: 'schema:keywords', value: 'harem', facet: { kind: 'item' } }],
  ...patch,
});
const hit = (n: number, revision = '1'): DiscoveryEngineHit => ({
  key: { owner: 'semantic', kind: 'schema:Book', route: routeOf(id(n))!, id: id(n) },
  index: 'privacy-g1',
  sourcePosition: '3',
  revision,
  matched: [],
  sort: [id(n)],
});

function registry(subjects: readonly IndexedSubject[], extra: Partial<DiscoveryRegistryOptions> = {}) {
  const rows = new Map(subjects.map((subject) => [subject.id, subject]));
  return createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source: {
        async read(partition, ids): Promise<SubjectSnapshot> {
          return {
            partition,
            position: 3n,
            subjects: ids.flatMap((value) => {
              const subject = rows.get(value);
              return subject && subjectPartition(subject.id) === partition ? [subject] : [];
            }),
          };
        },
        count: unused,
      },
      async hydrate(ids) {
        return new Map(
          ids.flatMap((value) => {
            const subject = rows.get(value);
            return subject
              ? [
                  [
                    value,
                    {
                      id: value,
                      type: subject.type,
                      types: [subject.type],
                      label: subject.labels[0] ? { value: subject.labels[0].value, language: 'en' } : null,
                      creativeWork: true,
                      cover: null,
                    },
                  ],
                ]
              : [];
          }),
        );
      },
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: { read: unused, count: unused, page: unused },
      hydrate: unused,
      labels: { en: 'Accounts' },
      icon: 'account',
    },
    ...extra,
  });
}

function disclose(
  subjects: readonly IndexedSubject[],
  candidates: readonly DiscoveryEngineHit[],
  readContext: DiscoveryReadContext = context,
) {
  return currentDiscoveryCandidates(registry(subjects), candidates, undefined, bundledRelease, readContext);
}

test('anonymous, editor and suspended readers share current public hits while hidden and taken-down engine rows are dropped', async () => {
  const subjects = [
    book(1),
    book(2, { visibility: 'hidden', securityRevision: 2 }),
    book(3, { visibility: 'taken_down', securityRevision: 3 }),
  ];
  const candidates = [hit(1), hit(2, '2'), hit(3, '3')];
  for (const readContext of [context, editor, suspended]) {
    const current = await disclose(subjects, candidates, readContext);
    const page = selectCurrentPredicatePage(candidates, current, { limit: 3, exhausted: true });
    expect(page.hits.map((row) => row.key.id)).toEqual([id(1)]);
    expect(page.dropped).toBe(2);
    expect(
      proveKindCount('schema:Book', {
        continuation: false,
        exhausted: true,
        aggregateProof: false,
        witnesses: new Map([['schema:Book', 1]]),
      }),
    ).toEqual({ kind: 'schema:Book', value: 1, exact: false });
  }
});

test('taken-down and withheld facts stay out of the disclosed page and cannot certify a kind total', async () => {
  const subjects = [book(1, { visibility: 'taken_down', securityRevision: 4 }), book(2, { statements: [] })];
  const current = await disclose(subjects, [hit(1, '4'), hit(2)]);
  const page = selectCurrentPredicatePage([hit(1, '4'), hit(2)], current, { limit: 2, exhausted: false });
  expect(page.hits.map((row) => row.key.id)).toEqual([id(2)]);
  expect(page.hits[0]).not.toHaveProperty('facts');
  expect(
    proveKindCount('schema:Book', {
      continuation: false,
      exhausted: false,
      aggregateProof: false,
      witnesses: new Map([['schema:Book', 1]]),
    }),
  ).toEqual({ kind: 'schema:Book', value: 1, exact: false });
});

test('a changed reader scope cannot reuse another principal’s kind witnesses', () => {
  expect(
    proveKindCount('schema:Book', {
      continuation: true,
      exhausted: true,
      aggregateProof: true,
      witnesses: new Map([['schema:Book', 4]]),
    }),
  ).toEqual({ kind: 'schema:Book', unavailable: true });
});

test('a withheld property is absent from the current subject even when the engine still carries it', async () => {
  const current = await disclose([book(1, { statements: [] })], [hit(1)]);
  expect([...current.values()]).toHaveLength(1);
  expect([...current.values()][0]).not.toHaveProperty('facts');
});

test('a public-to-private change during paused indexing drops the stale engine hit without reordering survivors', async () => {
  const subjects = [book(1), book(2), book(3)];
  const candidates = [hit(1), hit(2), hit(3)];
  const before = await disclose(subjects, candidates);
  expect(
    selectCurrentPredicatePage(candidates, before, { limit: 3, exhausted: true }).hits.map((row) => row.key.id),
  ).toEqual([id(1), id(2), id(3)]);
  subjects[1] = book(2, { visibility: 'hidden', securityRevision: 8 });
  const after = await disclose(subjects, [hit(1), hit(2, '8'), hit(3)]);
  const page = selectCurrentPredicatePage(candidates, after, { limit: 3, exhausted: true });
  expect(page.hits.map((row) => row.key.id)).toEqual([id(1), id(3)]);
  expect(page.dropped).toBe(1);
});

test('an unready owner producer is readiness, not an empty successful collection page', async () => {
  const collectionId = id(4);
  await expect(
    currentDiscoveryCandidates(
      registry([], {
        ownerAdapters: {
          collection: { readiness: 'unavailable' },
          review: { readiness: 'unavailable' },
          space: { readiness: 'unavailable' },
        },
      }),
      [
        {
          key: { owner: 'commerce', kind: 'collection', route: routeOf(collectionId)!, id: collectionId },
          index: 'privacy-g1',
          sourcePosition: '3',
          revision: '1',
          matched: [],
          sort: [collectionId],
        },
      ],
      undefined,
      bundledRelease,
      context,
    ),
  ).rejects.toBeInstanceOf(SearchUnavailableError);
});
