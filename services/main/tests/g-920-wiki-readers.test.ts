import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { readSubjectStatements, SUBJECT_STATEMENT_COST } from '../src/modules/statement/subject-read.ts';
import type { StatementSeekCandidate, StatementSeekOrder } from '../src/modules/statement/seek.ts';
import { CLASSIFICATION_INHERIT_POLICY, GLOBAL_CLASSIFICATION_CONTEXT }
  from '../src/modules/classification/context.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { RV, prepareComponent } from '../src/modules/work/activate.ts';
import { WorkReadMissing, WorkReadMoved, type ReadRow } from '../src/modules/work/read-session.ts';
import { STATEMENT_PROFILE, statementMeaningKey, type StatementMeaning }
  from '../src/modules/statement/schema.ts';
import type { StatementQualification } from '../src/modules/statement/qualification.ts';

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

const subjectId = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const statementCandidate = (n: number): StatementSeekCandidate => ({
  statementId: subjectId(n), predicate: `${RV}wikiFact`,
  meaningKey: `urn:rezics:meaning:${n.toString(16).padStart(64, '0')}`, score: 0,
});
const term = (value: string) => ({ type: 'literal', value });
const iriTerm = (value: string) => ({ type: 'uri', value });
const wikiCitation = (claim: string | null, n: number): WikiEvidenceRow => ({
  id: subjectId(n), claim, claimKind: 'statement', sourceWork: subjectId(2),
  quote: 'Published quotation', locator: { page: 3 }, representationSha256: 'a'.repeat(64),
  method: {}, modality: 'said', submitter: subjectId(3), rightsBasis: 'public_domain',
});

/** Extend the existing WorkReadSession/Wiki disclosure adapter above with the
 * bounded seek and graph rows consumed by the real subject reader. No modules
 * are mocked: both acceptance grains and Wiki disclosure use their real readers. */
function subjectReader(candidates: StatementSeekCandidate[], evidence: WikiEvidenceRow[] = []) {
  const graph = new FusekiClient('http://graph.invalid');
  const resource = subjectId(1);
  const hydration: string[][] = [];
  const wikiBatches: string[][] = [];
  const seekAfter: Array<StatementSeekOrder | null> = [];
  const events: string[] = [];
  const acceptances = new Map<string, 'accepted' | 'unavailable' | 'rejected'>();
  const currentSources = new Map(evidence.filter(row => row.claim)
    .map(row => [row.claim!, evidence.filter(other => other.claim === row.claim).map(other => other.id)]));
  const privateMeanings = new Set<string>();
  const hydrationChanges = new Map<string, ReadRow>();
  const missingHeads = new Set<string>();
  const hiddenReferences = new Set<string>();
  let hasAcceptanceScope = false;
  let sourcePublic = true;
  let sourceBound = true;
  let claimVisible = true;
  let privateGrant = false;
  let grantReads = 0;
  let sequence = '1';
  let afterHydration: (() => void) | undefined;
  let wikiReads = 0;
  let withdrawWikiAt = 0;
  const values = (query: string, variable: string) => {
    const selected = new RegExp(`VALUES \\?${variable} \\{([^}]+)\\}`, 'u').exec(query)?.[1] ?? '';
    return [...selected.matchAll(/<([^>]+)>/gu)].map(match => match[1]!);
  };
  graph.query = async query => {
    if (query.includes('SELECT ?policy ?realm')) return { results: { bindings: hasAcceptanceScope
      ? [{ policy: iriTerm(CLASSIFICATION_INHERIT_POLICY) }] : [] } };
    if (query.includes('SELECT ?epoch ?sequence ?context ?policy')) return { results: { bindings: [{
      epoch: term('epoch'), sequence: term(sequence), context: iriTerm(GLOBAL_CLASSIFICATION_CONTEXT),
      policy: iriTerm(CLASSIFICATION_INHERIT_POLICY),
    }] } };
    if (query.includes('SELECT ?epoch ?sequence ?statement ?localSlot')) {
      const targets = [...new Set([...query.matchAll(/\(<([^>]+)>\s+rv:(?:StatementTarget|QualifiedFactTarget)\s+<[^>]+>\s+<[^>]+>\)/gu)]
        .map(match => match[1]!))];
      return { results: { bindings: targets.map(target => ({
        epoch: term('epoch'), sequence: term(sequence), statement: iriTerm(target),
        ...(acceptances.has(target) ? { globalSlot: iriTerm(subjectId(90)),
          ...(acceptances.get(target) === 'unavailable' ? {} : {
            globalDecision: iriTerm(subjectId(91)),
            globalOutcome: iriTerm(`${RV}${acceptances.get(target) === 'accepted' ? 'Accepted' : 'Rejected'}`),
          }) } : {}),
      })) } };
    }
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?head ?manifest')) return { results: { bindings: [] } };
    if (query.includes('SELECT ?work ?head ?owningWork ?owningHead')) return { results: { bindings: values(query, 'work')
      .map(work => ({ work: iriTerm(work),
        ...(work === subjectId(2) && !sourceBound ? {} : {
          head: iriTerm(subjectId(80)), owningWork: iriTerm(work), owningHead: iriTerm(subjectId(80)),
        }) })) } };
    if (query.includes('SELECT ?statement ?predicate ?object')) {
      const ids = values(query, 'statement');
      hydration.push(ids);
      events.push(`hydrate:${ids.join(',')}`);
      const rows = ids.map(statement => {
        const candidate = candidates.find(row => row.statementId === statement)!;
        const row: ReadRow = { statement: iriTerm(statement), predicate: iriTerm(candidate.predicate),
          object: term('Retained fact'), relation: iriTerm(subjectId(4)), speaker: iriTerm(subjectId(3)),
          key: iriTerm(candidate.meaningKey), head: iriTerm(subjectId(80)),
          definitions: term(''), qualifiers: term(''), valueQualifiers: term(''),
          sources: term((currentSources.get(statement) ?? []).join('|')),
          ...(privateMeanings.has(statement) ? { pin: iriTerm(subjectId(70)), ctx: iriTerm(subjectId(71)),
            disclosure: iriTerm(`${RV}Private`) } : {}),
          ...hydrationChanges.get(statement),
        };
        if (missingHeads.has(statement)) delete row.head;
        return row;
      });
      afterHydration?.();
      return { results: { bindings: rows } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) {
      const rows = values(query, 'r').filter(ref => ref !== subjectId(2) || sourceBound).map(ref => ({
        epoch: term('epoch'), sequence: term(sequence), r: iriTerm(ref), type: term('work'),
        work: iriTerm(ref), head: iriTerm(subjectId(80)), label: { ...term('Readable Work'), 'xml:lang': 'en' },
        public: term(ref === subjectId(2) && !sourcePublic ? 'false' : 'true'), erased: term('false'),
      }));
      return { results: { bindings: rows.length ? rows : [{ epoch: term('epoch'), sequence: term(sequence) }] } };
    }
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) return { results: { bindings: values(query, 'r').map(ref => ({
      epoch: term('epoch'), sequence: term(sequence), r: iriTerm(ref), revision: iriTerm(subjectId(80)),
      type: iriTerm('https://schema.org/CreativeWork'),
    })) } };
    throw new Error(`Unexpected subject Statement read: ${query}`);
  };
  const environment = { fuseki: graph, objectDirectory: '.temp/g-920',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, { read: async targets => targets.map(target => {
    const boundWork = target.work !== subjectId(2) || sourceBound;
    if (target.work) expect(target.workRevision).toBe(boundWork ? subjectId(80) : undefined);
    if (target.owner === 'graph' && ['name', 'title'].includes(target.component))
      expect(target.revision).toBe(target.resource === subjectId(2) && !sourceBound ? undefined : subjectId(80));
    return !boundWork || target.component === 'record' && !claimVisible || hiddenReferences.has(target.resource)
      ? 'hidden' : 'visible';
  }) });
  const deps = {
    environment,
    access: { canReadWork: async () => privateGrant },
    account: { verify: async () => ({ issuer: 'https://account.test', subject: 'reader' }) },
    contextSelections: { canReadPrivate: async () => { grantReads++; return privateGrant; } },
    wikiEvidence: {
      forClaims: async (claims: readonly string[], kind: string) => {
        expect(kind).toBe('statement');
        wikiReads++;
        wikiBatches.push([...claims]);
        events.push(`wiki:${claims.join(',')}`);
        if (withdrawWikiAt && wikiReads >= withdrawWikiAt) return [];
        return evidence.filter(row => !row.claim || claims.includes(row.claim));
      },
      withheld: async () => new Set<string>(),
    },
    statementSeek: {
      coverage: async () => ({ complete: true, through_sequence: '1' }),
      seek: async (_position: unknown, subject: string, after: StatementSeekOrder | null) => {
        expect(subject).toBe(resource);
        seekAfter.push(after);
        const index = after ? candidates.findIndex(row => row.statementId === after.statementId) + 1 : 0;
        return { candidates: candidates.slice(index, index + SUBJECT_STATEMENT_COST.candidates) };
      },
    },
  } as unknown as MainWorkDependencies;
  const session = (cursor?: string, signed = false) => {
    const result = new WorkReadSession(deps, new Request('http://main.local/v1/resources/statements'),
      { limit: 1, actingSubject: subjectId(3), ...(cursor ? { cursor } : {}) },
      { dataEpoch: 'epoch', sequence: '1' });
    result.principal = signed ? { issuer: 'https://account.test', subject: 'reader' } : null;
    return result;
  };
  return { resource, hydration, wikiBatches, seekAfter, events, acceptances, currentSources,
    privateMeanings, hydrationChanges, missingHeads, hiddenReferences, session,
    scope() { hasAcceptanceScope = true; },
    privateSource() { sourcePublic = false; },
    unboundSource() { sourceBound = false; },
    grant(value: boolean) { privateGrant = value; },
    get grantReads() { return grantReads; },
    withdrawWiki(at: number) { withdrawWikiAt = at; },
    afterHydration(action: () => void) { afterHydration = action; },
    hideClaim() { claimVisible = false; },
    moveGraph() { sequence = '2'; },
  };
}

test('absent Global acceptance hydrates no ordinary proposals and advances a full raw batch', async () => {
  const candidates = Array.from({ length: 320 }, (_, index) => statementCandidate(100 + index));
  const run = subjectReader(candidates);
  const page = await readSubjectStatements(run.session(), run.resource);
  expect(page.groups).toEqual([]);
  expect(page.nextCursor).toBeNull();
  expect(run.hydration).toEqual([]);
  expect(run.seekAfter).toEqual([null, ...Array.from({ length: 16 }, (_, index) =>
    candidates[(index + 1) * SUBJECT_STATEMENT_COST.candidates - 1])]);
  expect(run.wikiBatches[0]).toEqual(candidates.slice(0, SUBJECT_STATEMENT_COST.candidates)
    .map(row => row.statementId));
});

test('a full ineligible raw batch still fills a published Wiki page and its disclosed cursor', async () => {
  const candidates = Array.from({ length: SUBJECT_STATEMENT_COST.candidates + 2 }, (_, index) => statementCandidate(100 + index));
  const published = candidates.slice(-2);
  const evidence = published.map((row, index) => wikiCitation(row.statementId, 300 + index));
  const run = subjectReader(candidates, evidence);
  const page = await readSubjectStatements(run.session(), run.resource);
  expect(run.seekAfter).toEqual([null, candidates[SUBJECT_STATEMENT_COST.candidates - 1]]);
  expect(run.hydration).toEqual([published.map(row => row.statementId)]);
  expect(run.events.findIndex(event => event.startsWith('wiki:')))
    .toBeLessThan(run.events.findIndex(event => event.startsWith('hydrate:')));
  expect(run.wikiBatches).toHaveLength(3);
  expect(page.groups[0]?.items).toMatchObject([{ kind: 'statement', statement: published[0]!.statementId,
    acceptance: null, publication: { kind: 'wiki-bundle', works: [subjectId(2)] },
    evidence: [{ id: evidence[0]!.id, quoteWithheld: false }] }]);
  expect(page.nextCursor).not.toBeNull();
  const next = await readSubjectStatements(run.session(page.nextCursor!), run.resource);
  expect(run.seekAfter.at(-1)?.statementId).toBe(published[0]!.statementId);
  expect(next.groups[0]?.items).toMatchObject([{ statement: published[1]!.statementId, acceptance: null }]);
  expect(next.nextCursor).toBeNull();
});

test('readable Wiki candidates separated by full raw batches share one bounded hydration', async () => {
  const candidates = Array.from({ length: 42 }, (_, index) => statementCandidate(100 + index));
  const published = [candidates[1]!, candidates[21]!];
  const run = subjectReader(candidates, published.map((row, index) => wikiCitation(row.statementId, 300 + index)));
  const page = await readSubjectStatements(run.session(), run.resource);
  expect(run.hydration).toEqual([published.map(row => row.statementId)]);
  expect(run.seekAfter[1]).toEqual(candidates[SUBJECT_STATEMENT_COST.candidates - 1]);
  expect(page.groups[0]?.items).toMatchObject([{ statement: published[0]!.statementId, acceptance: null }]);
  expect(page.nextCursor).not.toBeNull();
});

test('only exact acceptance, qualified acceptance or readable Wiki candidates hydrate', async () => {
  const candidates = [100, 101, 102, 103].map(statementCandidate);
  const run = subjectReader(candidates, [wikiCitation(candidates[2]!.statementId, 300)]);
  run.scope();
  run.acceptances.set(candidates[0]!.statementId, 'accepted');
  run.acceptances.set(candidates[1]!.meaningKey, 'accepted');
  const session = run.session();
  session.options.limit = 3;
  const page = await readSubjectStatements(session, run.resource);
  expect(run.hydration).toEqual([candidates.slice(0, 3).map(row => row.statementId)]);
  expect(page.groups[0]?.items).toMatchObject([
    { statement: candidates[0]!.statementId, acceptance: { decision: subjectId(91), source: 'global' } },
    { statement: candidates[1]!.statementId, acceptance: { decision: subjectId(91), source: 'global' } },
    { statement: candidates[2]!.statementId, acceptance: null, publication: { kind: 'wiki-bundle' } },
  ]);
});

for (const unavailable of ['exact', 'qualified'] as const) {
  test(`unavailable ${unavailable} acceptance refuses even with the other grain and Wiki publication`, async () => {
    const candidate = statementCandidate(100);
    const run = subjectReader([candidate], [wikiCitation(candidate.statementId, 300)]);
    run.scope();
    run.acceptances.set(candidate.statementId, unavailable === 'exact' ? 'unavailable' : 'accepted');
    run.acceptances.set(candidate.meaningKey, unavailable === 'qualified' ? 'unavailable' : 'accepted');
    await expect(readSubjectStatements(run.session(), run.resource))
      .rejects.toThrow('Statement acceptance is unavailable');
    expect(run.hydration).toEqual([]);
  });
}

for (const hidden of ['private-source', 'unbound-source', 'unbound-claim', 'stale-reference'] as const) {
  test(`${hidden} Wiki evidence does not disclose an otherwise unaccepted Statement`, async () => {
    const candidate = statementCandidate(100);
    const run = subjectReader([candidate], [wikiCitation(hidden === 'unbound-claim' ? null : candidate.statementId, 300)]);
    if (hidden === 'private-source') run.privateSource();
    if (hidden === 'unbound-source') run.unboundSource();
    if (hidden === 'stale-reference') run.currentSources.set(candidate.statementId, []);
    const page = await readSubjectStatements(run.session(), run.resource);
    expect(page.groups).toEqual([]);
    expect(run.hydration).toEqual(hidden === 'stale-reference' ? [[candidate.statementId]] : []);
  });
}

test('published Wiki provenance never grants a private meaning Context', async () => {
  const candidate = statementCandidate(100);
  const run = subjectReader([candidate], [wikiCitation(candidate.statementId, 300)]);
  run.privateMeanings.add(candidate.statementId);
  expect((await readSubjectStatements(run.session(), run.resource)).groups).toEqual([]);
  run.grant(true);
  expect((await readSubjectStatements(run.session(undefined, true), run.resource)).groups[0]?.items)
    .toMatchObject([{ statement: candidate.statementId, acceptance: null }]);
  expect(run.grantReads).toBe(2);
});

for (const race of ['evidence-withdrawal', 'claim-permission', 'private-context-grant', 'graph-position'] as const) {
  test(`${race} during eligible hydration refuses the final Wiki page`, async () => {
    const candidate = statementCandidate(100);
    const run = subjectReader([candidate], [wikiCitation(candidate.statementId, 300)]);
    if (race === 'evidence-withdrawal') run.withdrawWiki(2);
    if (race === 'claim-permission') run.afterHydration(() => run.hideClaim());
    if (race === 'graph-position') run.afterHydration(() => run.moveGraph());
    if (race === 'private-context-grant') {
      run.privateMeanings.add(candidate.statementId);
      run.grant(true);
      const session = run.session(undefined, true);
      const check = session.deps.contextSelections!.canReadPrivate.bind(session.deps.contextSelections);
      session.deps.contextSelections!.canReadPrivate = async (...args) => {
        const allowed = await check(...args);
        run.grant(false);
        return allowed;
      };
      await expect(readSubjectStatements(session, run.resource)).rejects.toBeInstanceOf(WorkReadMissing);
    } else {
      await expect(readSubjectStatements(run.session(), run.resource))
        .rejects.toBeInstanceOf(race === 'graph-position' ? WorkReadMoved : WorkReadMissing);
    }
  });
}

test('an eligible Statement whose current meaning changed still refuses hydration', async () => {
  const candidate = statementCandidate(100);
  const run = subjectReader([candidate], [wikiCitation(candidate.statementId, 300)]);
  run.hydrationChanges.set(candidate.statementId, { key: iriTerm(statementCandidate(101).meaningKey) });
  await expect(readSubjectStatements(run.session(), run.resource))
    .rejects.toThrow('Statement hydration differs from its candidate');
});

test('readable Wiki evidence cannot make an eligible Statement with an unbound current head available', async () => {
  const candidate = statementCandidate(100);
  const run = subjectReader([candidate], [wikiCitation(candidate.statementId, 300)]);
  run.missingHeads.add(candidate.statementId);
  await expect(readSubjectStatements(run.session(), run.resource))
    .rejects.toThrow('Statement hydration differs from its candidate');
  expect(run.hydration).toEqual([[candidate.statementId]]);
});

test('an eligible Statement with a partial qualification bundle refuses before disclosure', async () => {
  const candidate = statementCandidate(100);
  const run = subjectReader([candidate], [wikiCitation(candidate.statementId, 300)]);
  run.hydrationChanges.set(candidate.statementId, { qualificationDefinition: iriTerm(subjectId(4)) });
  await expect(readSubjectStatements(run.session(), run.resource))
    .rejects.toThrow('Statement qualification is unavailable');
  expect(run.hydration).toEqual([[candidate.statementId]]);
});

test('exact qualified Wiki facts require every native scope and preserve their sealed bundle', async () => {
  const qualification: StatementQualification = { definition: subjectId(4),
    interpretationContext: subjectId(20), valuePrecision: 'exact', valueQualifiers: ['inferred'],
    validFrom: null, validUntil: null, editionScope: subjectId(21) };
  const meaning: StatementMeaning = { subject: subjectId(1), predicate: `${RV}wikiFact`,
    relationDefinition: subjectId(4), interpretationDefinitions: [qualification.definition],
    applicability: [], qualification,
    value: { kind: 'literal', lexical: 'Retained fact', datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null } };
  const candidate = { ...statementCandidate(100), meaningKey: statementMeaningKey(meaning) };
  const citation = wikiCitation(candidate.statementId, 300);
  const run = subjectReader([candidate], [citation]);
  const scratch = join(resolve(import.meta.dir, '../../..'), '.temp');
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, 'wiki-subject-qualification-'));
  try {
    const manifest = prepareComponent(directory, candidate.statementId, {
      meaning, meaningKey: candidate.meaningKey, revision: subjectId(80), state: 'active',
      speaker: subjectId(3), recordedBy: subjectId(3), evidence: [citation.id], semanticContextRevision: null,
    }, STATEMENT_PROFILE);
    run.session().deps.environment.objectDirectory = directory;
    const bindings: ReadRow = { manifest: iriTerm(`urn:rezics:sha256:${manifest}`),
      definitions: term(qualification.definition), qualificationDefinition: iriTerm(qualification.definition),
      qualificationContext: iriTerm(qualification.interpretationContext), precision: iriTerm(`${RV}ExactValue`),
      valueQualifiers: term(`${RV}InferredValue`), edition: iriTerm(qualification.editionScope!) };
    run.hydrationChanges.set(candidate.statementId, bindings);
    const visible = await readSubjectStatements(run.session(), run.resource);
    expect(visible.groups[0]?.items).toMatchObject([{ statement: candidate.statementId, acceptance: null,
      qualifiers: { interpretationDefinitions: [qualification.definition], qualification },
      value: meaning.value, publication: { kind: 'wiki-bundle', works: [citation.sourceWork] } }]);
    for (const denied of [[qualification.interpretationContext], [qualification.editionScope!],
      [qualification.interpretationContext, qualification.editionScope!]]) {
      run.hiddenReferences.clear();
      denied.forEach(ref => run.hiddenReferences.add(ref));
      expect((await readSubjectStatements(run.session(), run.resource)).groups).toEqual([]);
    }
    run.hiddenReferences.clear();
    // The current graph still names the original exact meaning key and bytes;
    // a syntactically valid qualification change cannot replace that custody.
    run.hydrationChanges.set(candidate.statementId, { ...bindings, precision: iriTerm(`${RV}ApproximateValue`) });
    await expect(readSubjectStatements(run.session(), run.resource))
      .rejects.toThrow('Statement literal is unavailable');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
