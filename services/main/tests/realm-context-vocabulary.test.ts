import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { classificationContextDigest, GLOBAL_CLASSIFICATION_CONTEXT,
  InvalidClassificationContextInput, type CreateClassificationContextInput } from '../src/modules/classification/context.ts';
import { readContextVocabulary } from '../src/modules/realm-directory/vocabulary.ts';
import { encodeReadCursor, WorkReadInvalid, WorkReadUnavailable,
  type ReadRow, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { classificationContextV2Profile } from '../../../model/definitions/classification-context-v2.ts';
import { buildCommandRegistry, selectCommandProfile } from '../../../model/compiler/registry.ts';
import { classificationContextProfile } from '../../../model/definitions/classification-context-v1.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const uri = (value: string) => ({ type: 'uri', value });

test('Classification Context v2 intent binds selection and both compare-and-replace heads', () => {
  const input: CreateClassificationContextInput = { profile: 'classification-context-v2',
    realm: native(), actingSubject: native(), expectedHead: null,
    scheme: { id: native(), expectedHead: native() } };
  const digest = classificationContextDigest(input);
  for (const change of [{ expectedHead: native() }, { scheme: null },
    { scheme: { ...input.scheme!, id: native() } },
    { scheme: { ...input.scheme!, expectedHead: native() } }])
    expect(classificationContextDigest({ ...input, ...change })).not.toBe(digest);
  expect(classificationContextDigest({ realm: input.realm, actingSubject: input.actingSubject }))
    .toBe(classificationContextDigest({ profile: 'classification-context-v1',
      realm: input.realm, actingSubject: input.actingSubject }));
  for (const change of [{ expectedHead: undefined }, { scheme: undefined },
    { scheme: { id: 'urn:wrong', expectedHead: native() } }, { expectedHead: 'stale' }])
    expect(() => classificationContextDigest({ ...input, ...change } as CreateClassificationContextInput))
      .toThrow(InvalidClassificationContextInput);
});

test('Classification Context v2 selects its canonical shape while retaining v1 binding demands', () => {
  const registry = buildCommandRegistry([classificationContextProfile, classificationContextV2Profile],
    { canonicalOrder: [], demandOrder: [] });
  const rv = 'https://rezics.com/vocab/';
  const values = (path: string) => path === `${rv}contextRole` ? [`${rv}RealmClassification`]
    : path === `${rv}definitionProfile` ? ['https://rezics.com/definition/classification-context-v2'] : [];
  expect(selectCommandProfile(registry, [`${rv}ClassificationContext`], values)?.profile)
    .toBe('classification-context-v2');
  expect(registry.bindingDemands.find(entry => entry.type === `${rv}ClassificationContext`)?.profile)
    .toBe('classification-context-v1');
});

function fixture(options: { selectedScheme?: string; private?: boolean; hidden?: boolean;
  incompleteDisclosure?: boolean; head?: string; activeScheme?: boolean } = {}) {
  const context = native(), realm = native(), head = options.head ?? native();
  const queries: string[] = [];
  const env = { lineage: { dataEpoch: 'context-vocabulary', routingEpoch: 'routing' },
    fuseki: { query: async (query: string) => {
    queries.push(query);
    expect(query).toContain('LIMIT 2');
    return { results: { bindings: [{ space: uri(native()), realmRevision: uri(native()),
      disclosure: uri(`https://rezics.com/vocab/${options.private ? 'Private' : 'Public'}`),
      visibility: { type: 'literal', value: options.private ? 'private' : 'public' } }] } };
  } } };
  const session = { deps: { environment: env }, viewer: ANONYMOUS_VIEWER,
    position: { dataEpoch: 'context-vocabulary', sequence: '1' }, options: {}, displayLanguages: ['en'],
    observeDependency: () => '',
    query: async (query: string, limit: number): Promise<ReadRow[]> => {
      queries.push(query);
      if (query.includes('SELECT ?scope')) {
        expect(limit).toBe(2);
        expect(query).toContain(`<${context}> a rv:ClassificationContext`);
        return [{ scope: uri(GLOBAL_CLASSIFICATION_CONTEXT), head: uri(head), realm: uri(realm),
          ...(options.selectedScheme ? { selectedScheme: uri(options.selectedScheme) } : {}) }];
      }
      if (query.includes('SELECT ?scheme')) {
        expect(limit).toBe(1);
        expect(query).toContain('FILTER NOT EXISTS');
        return options.activeScheme ? [{ scheme: uri(options.selectedScheme!) }] : [];
      }
      throw new Error(`Unexpected hydration: ${query}`);
    },
    disclosure: async (targets: unknown[]) => options.incompleteDisclosure ? []
      : targets.map(() => options.hidden ? 'hidden' : 'visible'),
  } as unknown as WorkReadSession;
  return { session, context, head, queries };
}

test('A v1 Realm context with no selection returns empty without walking global Concepts', async () => {
  const f = fixture();
  expect(await readContextVocabulary(f.session, { context: f.context, limit: 1 }))
    .toMatchObject({ scheme: null, items: [], nextCursor: null, hasMore: false,
      count: { value: 0, total: null, kind: 'exact-page' } });
  expect(f.queries).toHaveLength(2);
});

test('A retired selected scheme returns empty while retaining its identity', async () => {
  const scheme = native(), f = fixture({ selectedScheme: scheme });
  expect(await readContextVocabulary(f.session, { context: f.context }))
    .toMatchObject({ scheme, items: [], nextCursor: null, hasMore: false });
  expect(f.queries).toHaveLength(3);
});

test('A private or withheld Context never discloses its selected scheme', async () => {
  for (const options of [{ private: true }, { hidden: true }]) {
    const f = fixture({ selectedScheme: native(), ...options });
    expect(await readContextVocabulary(f.session, { context: f.context }))
      .toMatchObject({ scheme: null, items: [], nextCursor: null });
    expect(f.queries).toHaveLength(2);
  }
  const f = fixture({ selectedScheme: native(), incompleteDisclosure: true });
  await expect(readContextVocabulary(f.session, { context: f.context })).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('Context-head replacement refuses a cursor even with unchanged scheme and graph position', async () => {
  const scheme = native(), f = fixture({ selectedScheme: scheme });
  const binding = ['context-vocabulary-v2', f.context, native(), null, scheme, null,
    1, null, ['en'], null, ANONYMOUS_VIEWER];
  const cursor = encodeReadCursor(binding, f.session.position, '',
    JSON.stringify({ id: native(), score: '0', commit: '1' }));
  await expect(readContextVocabulary(f.session, { context: f.context, limit: 1, cursor }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
});

test('Owner vocabulary reads reject invalid page bounds and empty searches', async () => {
  const f = fixture();
  for (const limit of [0, 21, 1.5, Number.NaN])
    await expect(readContextVocabulary(f.session, { context: f.context, limit })).rejects.toBeInstanceOf(WorkReadInvalid);
  await expect(readContextVocabulary(f.session, { context: f.context, q: ' ' })).rejects.toBeInstanceOf(WorkReadInvalid);
  expect(f.queries).toHaveLength(0);
});
