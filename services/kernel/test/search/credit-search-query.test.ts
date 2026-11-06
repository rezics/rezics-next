import { expect, test } from 'bun:test';
import {
  compileCreditedText,
  parseCreditedNameEvidence,
  selectCreditEvidence,
} from '../../src/search/credit-search-query.ts';
import { creditMatchView, verifyCreditedHit } from '../../src/search/credit-hit.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createDiscoveryRegistry } from '../../src/search/discovery-registry.ts';
import { currentDiscoveryCandidates } from '../../src/search/discovery-current.ts';
import { routeOf } from '../../src/route/route.ts';
import { SearchUnavailableError } from '../../src/search/opensearch.ts';
import type {
  CreditSearchEntry,
  CreditSearchProjection,
  CreditSearchSource,
  CreditSearchWitness,
} from '../../src/search/credit-search.ts';
import type { DiscoveryEngineHit, DiscoveryReadContext } from '../../src/search/discovery.ts';
import type { SubjectSource, IndexedSubject } from '../../src/search/source.ts';
import type { SubjectSummary } from '../../src/semantic/index.ts';
import { compileText, parseText } from '../../src/search/text.ts';

const role = '0196a000-0000-7000-8000-000000000001';
const witness: CreditSearchWitness = {
  workId: '018f0000-0000-7000-8000-00a000000001',
  statementId: 'statement-1',
  revision: 2,
  release: 'release-1',
  property: 'wdt:P725',
  targetId: '018f0000-0000-7000-8000-00a000000002',
  direction: 'outgoing',
  qualifiers: [{ property: 'wdt:P3831', value: role }],
  nameRevision: 'name-1',
  name: { language: 'ja', value: 'アダ' },
};

test('qualifiers and the matched name are clauses of one nested credit document', () => {
  const { query, leaves } = compileCreditedText(parseText('ada'), [{ property: 'wdt:P3831', value: role }]);
  const root = query.bool as { filter: unknown[]; must: [{ nested: Record<string, unknown> }] };
  expect(root.filter).toEqual([{ term: { credit_search_complete: true } }]);
  const credit = root.must[0].nested as {
    path: string;
    query: { bool: { must: Record<string, unknown>[] } };
    inner_hits: { size: number };
  };
  expect(credit.path).toBe('credited_names');
  expect(credit.inner_hits.size).toBe(3);
  expect(credit.query.bool.must[0]).toEqual(
    compileText(parseText('ada'), { field: 'credited_names.name.value', prefix: 'c' }).query,
  );
  expect(credit.query.bool.must[1]).toEqual({
    nested: {
      path: 'credited_names.qualifiers',
      score_mode: 'none',
      query: {
        bool: {
          filter: [
            { term: { 'credited_names.qualifiers.property': 'wdt:P3831' } },
            { term: { 'credited_names.qualifiers.value': role } },
          ],
        },
      },
    },
  });
  expect(leaves.map((leaf) => leaf.name)).toEqual(['c0']);
  expect(() =>
    compileCreditedText(
      parseText('ada'),
      Array.from({ length: 5 }, () => ({ property: 'p', value: 'v' })),
    ),
  ).toThrow(RangeError);
});

test('evidence is accepted only when it is an exact member of the complete projection', () => {
  const complete: CreditSearchProjection = {
    state: 'complete',
    workId: witness.workId,
    observation: 'cut',
    names: [witness],
  };
  expect(parseCreditedNameEvidence({ ...witness, qualifiers: [...witness.qualifiers] })).toEqual(witness);
  expect(parseCreditedNameEvidence({ ...witness, direction: 'incoming' })).toBeUndefined();
  expect(parseCreditedNameEvidence({ ...witness, revision: 0 })).toBeUndefined();
  expect(selectCreditEvidence([witness, { ...witness, statementId: 'other' }], complete)).toEqual([witness]);
  expect(selectCreditEvidence([witness], { state: 'incomplete' })).toEqual([]);
});

test('a credited hit is shown only with a producer-confirmed witness of its complete projection', async () => {
  const { name, ...identity } = witness;
  const entry: CreditSearchEntry = { witness: identity, names: [name], namesComplete: true };
  const source = (confirmed: boolean): CreditSearchSource => ({
    page: async () => ({ state: 'current', workId: witness.workId, observation: 'cut', entries: [entry], next: null }),
    current: async () => confirmed,
    unchanged: async () => true,
  });
  expect(await verifyCreditedHit(source(true), witness.workId, [witness])).toEqual({ state: 'current', witness });
  expect(await verifyCreditedHit(source(false), witness.workId, [witness])).toEqual({ state: 'changed' });
  expect(await verifyCreditedHit(source(true), witness.workId, [])).toEqual({ state: 'absent' });
  expect(creditMatchView(witness)).toEqual({
    statementId: witness.statementId,
    property: witness.property,
    targetId: witness.targetId,
    name: witness.name,
    qualifiers: witness.qualifiers,
  });
});

test('an incomplete current credited-name source is readiness, not an empty result', async () => {
  const subject: IndexedSubject = {
    id: witness.workId,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Book' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const source: SubjectSource = {
    async read(home, ids) {
      return { partition: home, position: 10n, subjects: ids.includes(subject.id) ? [subject] : [] };
    },
    async count() {
      return { position: 10n, count: 1 };
    },
  };
  const registry = createDiscoveryRegistry({
    release: bundledRelease,
    semantic: {
      source,
      hydrate: async (): Promise<ReadonlyMap<string, SubjectSummary>> => new Map(),
      icons: Object.fromEntries(Object.keys(bundledRelease.types).map((kind) => [kind, 'catalogue'])),
    },
    accounts: {
      source: {
        async read(home) {
          return { partition: home, position: 0n, accounts: [] };
        },
        async count(home) {
          return { partition: home, position: 0n, count: 0 };
        },
        async page(home) {
          return { partition: home, position: 0n, accounts: [], next: null };
        },
      },
      hydrate: async () => new Map(),
      labels: { en: 'Account' },
      icon: 'account',
    },
  });
  const candidate: DiscoveryEngineHit = {
    key: { owner: 'semantic', kind: 'schema:Book', route: routeOf(subject.id)!, id: subject.id },
    index: 'test-subjects-g1',
    sourcePosition: '10',
    revision: '1',
    matched: [],
    creditEvidence: [witness],
    sort: [1, subject.id, 'schema:Book', `subject:${subject.id}`],
  };
  await expect(
    currentDiscoveryCandidates(registry, [candidate], undefined, bundledRelease, {
      actor: { kind: 'anonymous' },
      access: {},
      deadline: Date.now() + 5_000,
      textField: 'credited_creator',
      textQuery: parseText('ada'),
    } as DiscoveryReadContext),
  ).rejects.toBeInstanceOf(SearchUnavailableError);
});
