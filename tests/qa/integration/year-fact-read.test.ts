import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DATASET, GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import {
  changeSemanticComponent, semanticChangeDigest, type DefinitionState,
} from '../../../services/main/src/modules/semantic/change.ts';
import {
  DATE_PUBLISHED_DEFINITION_NOTATION, DATE_PUBLISHED_PREDICATE, QUALIFICATION_DEFINITION_NOTATION,
} from '../../../services/main/src/modules/statement/qualification.ts';
import {
  setStatementDecision, statementDecisionRequest, withdrawStatement, withdrawStatementRequest,
} from '../../../services/main/src/modules/statement/graph.ts';
import { ADMISSIONS, claimDigest, createClaim, type CreateClaimInput } from '../../../services/main/src/modules/verification/graph.ts';
import { convertEligibleClaimsTurn } from '../../../services/main/src/modules/verification/claim-fold.ts';
import {
  FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_PREDICATE, FIRST_PUBLICATION_TYPE, invertedPublicationYear,
} from '../../../services/main/src/modules/query/year-fact.ts';
import { startMediaStack } from './media-support.ts';

const QUERY = 'https://rezics.com/query/work-publication-years';
const POPULATION = 5_000;
const PAGE = 20;

test('First-publication years: newest page, incremental posting, and a seek that stays inside the page window', async () => {
  const stack = await startMediaStack('year-fact-read');
  try {
    const actor = (await stack.member('year-reader')).actor;
    await ensureGlobalClassificationContext(stack.env);
    const published = await stack.publicWork(actor);
    const older = await stack.publicWork(actor);
    const middle = await stack.publicWork(actor);
    const undated = await stack.publicWork(actor);
    const hidden = await stack.privateWork(actor);
    const define = async (kind: 'property' | 'interpretation', notation: string) => {
      const state: DefinitionState = { component: 'definition', kind, roles: [], lifecycle: 'active', successor: null, notation };
      return changeSemanticComponent(stack.env, {
        expectedHead: null, state,
        admission: stack.admission(actor, 'semantic:create:root', 'semantic.change', semanticChangeDigest(undefined, null, state)),
      });
    };
    const relation = await define('property', DATE_PUBLISHED_DEFINITION_NOTATION);
    const qualification = await define('interpretation', QUALIFICATION_DEFINITION_NOTATION);
    const claim = async (referent: string, value: CreateClaimInput['value']) => {
      const input: CreateClaimInput = {
        referent, interpretationContext: 'urn:retained:publication-scope', propositionPredicate: DATE_PUBLISHED_PREDICATE,
        value, valuePrecision: 'approximate', valueQualifiers: ['disputed-attribution', 'inferred'],
        validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-01-01T00:00:00.000Z',
        editionScope: 'https://publisher.example/first-edition', actingSubject: actor,
      };
      const receipt = await createClaim(stack.env, stack.admission(actor, ADMISSIONS['claim-create'].scope,
        ADMISSIONS['claim-create'].action, claimDigest(input)), input);
      return { claim: receipt.result.claim!, claimRevision: receipt.result.claimRevision! };
    };
    const dated = await claim(published.work, { kind: 'literal', lexical: '2024-06-01', datatype: 'date' });
    const early = await claim(older.work, { kind: 'literal', lexical: '1999-12-31T23:00:00.000Z', datatype: 'dateTime' });
    const mid = await claim(middle.work, { kind: 'literal', lexical: '2010-03-15', datatype: 'date' });
    const concealed = await claim(hidden.work, { kind: 'literal', lexical: '2018-04-04', datatype: 'date' });
    const laterYear = await claim(published.work, { kind: 'literal', lexical: '2001-05-01', datatype: 'date' });
    const fold = async (job: string, claims: { claim: string; claimRevision: string }[]) => {
      // The fold holds the current sequence and requires the Statement seek to
      // already be complete at that cut. A populated epoch has no coverage until
      // an explicit rebuild; later decisions move the cut, so each fold catches up.
      while (await stack.statementSeek.projectOnce()) { /* advance a caught-up epoch */ }
      if (!(await stack.statementSeek.coverage())?.complete) await stack.statementSeek.rebuild();
      let pending = claims;
      for (let turn = 0; pending.length && turn < 4; turn++) {
        const result = await convertEligibleClaimsTurn(stack.env, stack.accessPool, {
          relationDefinition: relation.revision, qualificationDefinition: qualification.revision, job, claims: pending.slice(0, 2),
        });
        if (result.retained.length) throw new Error(`retained claims: ${JSON.stringify(result.retained)}`);
        const done = new Set(result.converted.map(item => item.claim));
        if (done.size === 0 && result.reason !== 'budget-expired') throw new Error(`fold made no progress: ${JSON.stringify(result)}`);
        pending = pending.filter(item => !done.has(item.claim));
      }
      if (pending.length) throw new Error(`fold left ${pending.length} claims`);
    };
    await fold(`year-fact-${randomUUID()}`, [dated, early, mid, concealed]);
    const release = async () => {
      await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
      await stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    };
    await release();
    const epoch = stack.env.lineage.dataEpoch;
    await stack.templateSeek.backfill(epoch, true);
    const yearCount = async () => Number((await stack.accessPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM access.template_seek_entry WHERE epoch=$1 AND anchor=$2 AND type=$3',
      [epoch, FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_TYPE])).rows[0]!.count);
    expect(await yearCount()).toBe(0);
    const accept = async (statement: string) => {
      const decision = { target: { kind: 'statement' as const, statement }, acceptance: { kind: 'global' as const },
        expectedDecisionHead: null, outcome: 'accepted' as const, actingSubject: actor };
      const request = statementDecisionRequest(decision);
      const saved = await setStatementDecision(stack.env, stack.admission(actor, request.scope, request.action, request.digest), decision);
      expect(saved.outcome).toBe('succeeded');
    };
    for (const statement of [dated, early, mid, concealed]) await accept(statement.claim);
    expect(await yearCount()).toBe(4);
    const posted = (await stack.accessPool.query<{ payload: { yearKey?: string[]; statement?: string[]; work?: string[] } }>(
      'SELECT payload FROM access.template_seek_entity WHERE epoch=$1 AND graph=$2 AND id=$3',
      [epoch, GRAPHS.current, published.work])).rows[0]!.payload;
    expect(posted.work).toEqual([FIRST_PUBLICATION_ANCHOR]);
    expect(posted.yearKey).toEqual([invertedPublicationYear(2024)]);
    expect(posted.statement).toEqual([dated.claim]);
    const read = async (parameters: { fromYear?: number; toYear?: number } = {}, limit = PAGE, cursor?: string) => {
      const response = await stack.main.handle(new Request('http://main.local/v1/query', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'template-query-v1', query: QUERY, revision: 1, parameters, limit, ...(cursor ? { cursor } : {}) }) }));
      const value = await response.json() as { result?: { items: Array<{ id: string; year: number; statement: string }>; nextCursor: string | null; complete: boolean } };
      if (response.status !== 200) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
      return value.result!;
    };
    const facts = (items: Array<{ id: string; year: number; statement: string }>) => items.map(item => ({ id: item.id, year: item.year, statement: item.statement }));
    const first = await read();
    expect(facts(first.items)).toEqual([
      { id: published.work, year: 2024, statement: dated.claim },
      { id: middle.work, year: 2010, statement: mid.claim },
      { id: older.work, year: 1999, statement: early.claim },
    ]);
    expect(first.items.map(item => item.id)).not.toContain(hidden.work);
    expect(first.items.map(item => item.id)).not.toContain(undated.work);
    expect(facts((await read({ fromYear: 2010, toYear: 2024 })).items)).toEqual([
      { id: published.work, year: 2024, statement: dated.claim },
      { id: middle.work, year: 2010, statement: mid.claim },
    ]);
    expect((await stack.main.handle(new Request('http://main.local/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'template-query-v1', query: QUERY, revision: 1, parameters: { fromYear: 2025, toYear: 2020 } }) }))).status).toBe(400);
    const walked: number[] = [];
    let cursor: string | null = null;
    for (let step = 0; step < 8; step++) {
      const page = await read({}, 1, cursor ?? undefined);
      walked.push(...page.items.map(item => item.year));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(walked).toEqual([2024, 2010, 1999]);
    expect(cursor).toBeNull();
    await fold(`year-fact-${randomUUID()}`, [laterYear]);
    await release();
    await accept(laterYear.claim);
    expect(await yearCount()).toBe(5);
    const withSecondYear = await read();
    expect(facts(withSecondYear.items)).toEqual([
      { id: published.work, year: 2024, statement: dated.claim },
      { id: middle.work, year: 2010, statement: mid.claim },
      { id: published.work, year: 2001, statement: laterYear.claim },
      { id: older.work, year: 1999, statement: early.claim },
    ]);
    const head = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(early.claim)} rv:head ?head } } LIMIT 2`)).results?.bindings[0]?.head?.value;
    if (!head) throw new Error('withdrawn statement has no head');
    const withdrawal = { statement: early.claim, speaker: { kind: 'personal' as const }, expectedHead: head, actingSubject: actor };
    const withdrawalRequest = withdrawStatementRequest(withdrawal);
    expect((await withdrawStatement(stack.env, stack.admission(actor, withdrawalRequest.scope, withdrawalRequest.action, withdrawalRequest.digest), withdrawal)).outcome).toBe('succeeded');
    expect(await yearCount()).toBe(4);
    const visible = await read();
    expect(facts(visible.items)).toEqual([
      { id: published.work, year: 2024, statement: dated.claim },
      { id: middle.work, year: 2010, statement: mid.claim },
      { id: published.work, year: 2001, statement: laterYear.claim },
    ]);
    const measure = async () => {
      let templateQuery = 0, basis = 0, sql = 0;
      const nativeQuery = stack.fuseki.templateQuery.bind(stack.fuseki);
      const nativeIndex = stack.fuseki.templateIndex.bind(stack.fuseki);
      const nativeSql = stack.accessPool.query.bind(stack.accessPool);
      const checkouts = stack.accessPool.checkouts;
      stack.fuseki.templateQuery = (async (...args: Parameters<typeof nativeQuery>) => { templateQuery++; return nativeQuery(...args); }) as typeof stack.fuseki.templateQuery;
      stack.fuseki.templateIndex = (async (...args: Parameters<typeof nativeIndex>) => {
        if (args[0].operation === 'basis') basis++;
        return nativeIndex(...args);
      }) as typeof stack.fuseki.templateIndex;
      stack.accessPool.query = (async (...args: Parameters<typeof nativeSql>) => { sql++; return nativeSql(...args); }) as typeof stack.accessPool.query;
      try {
        const page = await read();
        return { templateQuery, basis, sql, checkouts: stack.accessPool.checkouts - checkouts, items: facts(page.items) };
      } finally {
        stack.fuseki.templateQuery = nativeQuery;
        stack.fuseki.templateIndex = nativeIndex;
        stack.accessPool.query = nativeSql;
      }
    };
    const before = await measure();
    await stack.accessPool.query(`INSERT INTO access.template_seek_entity(epoch,graph,id,sequence,payload)
      SELECT $1,$2,'urn:year-population:'||n,0,'{}'::jsonb FROM generate_series(1,$3) n`,
    [epoch, GRAPHS.current, POPULATION]);
    await stack.accessPool.query(`INSERT INTO access.template_seek_entry(epoch,graph,predicate,anchor,type,key,id)
      SELECT $1,$2,$3,$4,$5,'9999','urn:year-population:'||n FROM generate_series(1,$6) n`,
    [epoch, GRAPHS.current, FIRST_PUBLICATION_PREDICATE, FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_TYPE, POPULATION]);
    await stack.accessPool.query('ANALYZE access.template_seek_entry');
    expect(await yearCount()).toBe(POPULATION + 4);
    const after = await measure();
    const planOf = async (limit: number, bounds?: { low: string; high: string }) => {
      const sql = bounds
        ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id, key FROM access.template_seek_entry
          WHERE epoch=$1 AND graph=$2 AND predicate=$3 AND anchor=$4 AND type=$5
          AND key >= $6::text COLLATE "C" AND key <= $7::text COLLATE "C"
          AND (key, id) > (''::text COLLATE "C", ''::text COLLATE "C") ORDER BY key, id LIMIT ${limit}`
        : `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id, key FROM access.template_seek_entry
          WHERE epoch=$1 AND graph=$2 AND predicate=$3 AND anchor=$4 AND type=$5
          AND (key, id) > (''::text COLLATE "C", ''::text COLLATE "C") ORDER BY key, id LIMIT ${limit}`;
      const params = [epoch, GRAPHS.current, FIRST_PUBLICATION_PREDICATE, FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_TYPE,
        ...(bounds ? [bounds.low, bounds.high] : [])];
      return (await stack.accessPool.query<{ 'QUERY PLAN': unknown }>(sql, params)).rows[0]!['QUERY PLAN'];
    };
    const unbounded = await planOf(PAGE + 1);
    const bounded = await planOf(PAGE + 1, { low: invertedPublicationYear(2024), high: invertedPublicationYear(2010) });
    const rows = (plan: unknown) => (plan as Array<{ Plan: { 'Actual Rows': number } }>)[0]!.Plan['Actual Rows'];
    const unboundedRows = rows(unbounded);
    const boundedRows = rows(bounded);
    console.log(JSON.stringify({ label: 'year-fact-page-cost', population: POPULATION, page: PAGE,
      before, after: { ...after, items: after.items.length }, unboundedRows, boundedRows, entries: await yearCount() }));
    expect(after.items).toEqual(before.items);
    expect(before.templateQuery).toBe(after.templateQuery);
    expect(before.basis).toBe(after.basis);
    expect(before.templateQuery).toBeGreaterThan(0);
    expect(before.templateQuery).toBeLessThanOrEqual(4);
    expect(before.basis).toBeLessThanOrEqual(4);
    expect(before.sql).toBe(after.sql);
    expect(before.sql).toBeLessThanOrEqual(8);
    for (const plan of [unbounded, bounded]) {
      const text = JSON.stringify(plan);
      expect(text).toContain('Index');
      expect(text).not.toContain('Seq Scan');
      expect(text).not.toContain('Sort');
    }
    expect(unboundedRows).toBe(PAGE + 1);
    expect(boundedRows).toBe(3);
  } finally { await stack.stop(); }
}, 600_000);
