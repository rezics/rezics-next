import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  admittedTypes,
  installRegisteredTypes,
  resourceTypeAdmitted,
} from '../src/modules/types/registry.ts';
import { wikiTypes } from '../src/modules/wiki/candidates.ts';
import { wikiSegment } from '../src/modules/wiki/apply-snapshot.ts';
import {
  WikiEvidenceStore,
  WIKI_EVIDENCE_COST,
  type WikiEvidenceRow,
} from '../src/modules/wiki/evidence.ts';
import { projectWikiEvidence, readWikiClaimEvidence } from '../src/modules/wiki/evidence-read.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';
import { FusekiClient, fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { boundedReadingPositionRead } from '../src/modules/reading-position/read.ts';
import { WORK_READ_COST } from '../src/modules/work/read-contract.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import { pageRegistry } from '../src/modules/entity-page/read.ts';

test('G-920: wiki entity types follow live registry admission and retirement, preserving structural owners', () => {
  expect(wikiTypes.has('https://schema.org/Place')).toBe(true);
  expect(wikiTypes.has('https://schema.org/Event')).toBe(true);
  expect(wikiTypes.has('https://rezics.com/vocab/Event')).toBe(false);
  expect(wikiSegment('https://rezics.com/vocab/Role')).toBe('characters');
  for (const type of [
    'https://rezics.com/vocab/Character',
    'https://rezics.com/vocab/Role',
    'https://schema.org/Place',
    'https://schema.org/Event',
  ]) {
    expect(
      pageRegistry({
        base: 'resource',
        types: ['http://www.w3.org/2000/01/rdf-schema#Resource', type],
      }).type,
    ).toBe(type);
  }
  const definition = {
    ...admittedTypes.find((entry) => entry.type === 'https://rezics.com/vocab/Character')!,
    type: 'https://example.test/WikiEntity',
  };
  try {
    installRegisteredTypes([{ definition, revision: '1', lifecycle: 'active' }]);
    expect(resourceTypeAdmitted(definition.type)).toBe(true);
    expect(wikiTypes.has(definition.type)).toBe(true);
    expect(wikiSegment(definition.type)).toBe('characters');
    installRegisteredTypes([
      { definition: { ...definition, wikiSegment: 'places' }, revision: '2', lifecycle: 'active' },
    ]);
    expect(wikiSegment(definition.type)).toBe('places');
    installRegisteredTypes([
      { definition: { ...definition, wikiSegment: undefined }, revision: '3', lifecycle: 'active' },
    ]);
    expect(wikiTypes.has(definition.type)).toBe(false);
    installRegisteredTypes([{ definition, revision: '2', lifecycle: 'retired' }]);
    expect(resourceTypeAdmitted(definition.type)).toBe(false);
    expect(wikiTypes.has(definition.type)).toBe(false);
  } finally {
    installRegisteredTypes([]);
  }
});

test('G-920: moving reading-position reads exhaust one shared retry budget and report unavailable', async () => {
  let sequence = 1,
    attempts = 0;
  const deps = {
    environment: {
      fuseki: {
        query: async () => ({
          results: {
            bindings: [
              {
                epoch: { type: 'literal', value: 'epoch' },
                sequence: { type: 'literal', value: String(sequence) },
              },
            ],
          },
        }),
      },
    },
  } as unknown as MainWorkDependencies;
  const budgets: number[] = [];
  await expect(
    boundedReadingPositionRead(
      deps,
      new Request('http://main.local/v1/resources/summaries'),
      null,
      undefined,
      async () => {
        attempts++;
        const budget = fusekiReadBudget.getStore()!;
        budgets.push(budget.callsLeft);
        budget.callsLeft--;
        sequence++;
        return 'moved';
      },
    ),
  ).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(attempts).toBe(WORK_READ_COST.attempts);
  expect(budgets).toEqual(
    Array.from(
      { length: WORK_READ_COST.attempts },
      (_, index) => WORK_READ_COST.graphCalls - index,
    ),
  );
});

test('G-920: evidence uses one indexed claim batch and rejects overflow instead of truncating citations', async () => {
  let calls = 0,
    overflow = false;
  const store = new WikiEvidenceStore({
    query: async (sql: string, parameters: unknown[]) => {
      calls++;
      expect(sql).toContain('claim = ANY($1::text[]) AND claim_kind = $2');
      expect(parameters).toEqual([
        ['claim-a', 'claim-b'],
        'statement',
        WIKI_EVIDENCE_COST.rows + 1,
      ]);
      return { rows: overflow ? Array(WIKI_EVIDENCE_COST.rows + 1).fill({}) : [] };
    },
  } as unknown as Pool);
  expect(await store.forClaims(['claim-a', 'claim-b'], 'statement')).toEqual([]);
  expect(calls).toBe(1);
  overflow = true;
  await expect(store.forClaims(['claim-a', 'claim-b'], 'statement')).rejects.toThrow(
    'exceeds its bound',
  );
  await expect(store.forClaims(Array(101).fill('claim'), 'relation')).rejects.toThrow(
    'batch exceeds its bound',
  );
});

test('G-920: one rights batch projects quotes, and denied quotes redact every embedded passage', async () => {
  const rows = ['permitted', 'denied'].map(
    (id) =>
      ({
        id,
        quote: 'A short quotation',
        claim: 'claim',
        claimKind: 'statement',
        locator: {
          selector: { exact: 'Exact passage', prefix: 'Before', suffix: 'After', start: 4 },
          page: 2,
        },
        sourceWork: 'work',
        representationSha256: 'a'.repeat(64),
        method: {},
        modality: 'said',
        submitter: 'holder',
        rightsBasis: 'public_domain',
      }) as WikiEvidenceRow,
  );
  let calls = 0;
  const session = {
    deps: {
      wikiEvidence: {
        withheld: async (ids: string[]) => {
          calls++;
          expect(ids).toEqual(['permitted', 'denied']);
          return new Set(['denied']);
        },
      },
    },
  } as unknown as WorkReadSession;
  const projected = await projectWikiEvidence(session, rows);
  expect(calls).toBe(1);
  expect(projected[0]!.quote).toBe(rows[0]!.quote);
  expect(projected[1]).toMatchObject({
    quote: null,
    quoteWithheld: true,
    locator: { selector: { exact: null, prefix: null, suffix: null, start: 4 }, page: 2 },
  });
});

test('G-920: claim disclosure batches source Works, preserves private grants and withholds later claims', async () => {
  const id = (n: number) =>
    `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const graph = new FusekiClient('http://graph.invalid');
  let granted = false;
  let graphBatches = 0,
    claimBatches = 0;
  graph.query = async (query) => {
    graphBatches++;
    expect(query).toContain(`<${id(1)}>`);
    expect(query).toContain(`<${id(2)}>`);
    return {
      results: {
        bindings: [1, 2].map((n) => ({
          epoch: { type: 'literal' as const, value: 'epoch' },
          sequence: { type: 'literal' as const, value: '1' },
          r: { type: 'uri' as const, value: id(n) },
          type: { type: 'literal' as const, value: 'work' },
          work: { type: 'uri' as const, value: id(n) },
          head: { type: 'uri' as const, value: id(8) },
          public: { type: 'literal' as const, value: n === 1 ? 'true' : 'false' },
          erased: { type: 'literal' as const, value: 'false' },
          label: { type: 'literal' as const, value: 'Source Work', 'xml:lang': 'en' },
        })),
      },
    };
  };
  const evidence = [3, 4, 5].map(
    (n) =>
      ({
        id: id(n + 10),
        claim: id(n),
        claimKind: 'statement',
        sourceWork: id(n === 4 ? 2 : 1),
      }) as WikiEvidenceRow,
  );
  const deps = {
    environment: {
      fuseki: graph,
      objectDirectory: '.temp/g-920',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    },
    wikiEvidence: {
      forClaims: async () => {
        claimBatches++;
        return evidence;
      },
    },
    access: { canReadWork: async () => granted },
    account: {},
  } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(
    deps,
    new Request('http://main.local/v1/test'),
    { actingSubject: id(9) },
    { dataEpoch: 'epoch', sequence: '1' },
  );
  const boundary = {
    visible: async (records: readonly string[]) =>
      new Set(records.filter((record) => record !== id(5))),
  } as ReadingBoundary;
  for (const [signed, hasGrant] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    granted = hasGrant!;
    session.principal = signed ? { issuer: 'https://account.test', subject: 'reader' } : null;
    expect([
      ...(
        await readWikiClaimEvidence(session, [id(3), id(4), id(5)], 'statement', boundary)
      ).keys(),
    ]).toEqual(hasGrant ? [id(3), id(4)] : [id(3)]);
  }
  expect(claimBatches).toBe(3);
  expect(graphBatches).toBe(3);
});
