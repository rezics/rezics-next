import { foregroundCounted } from './support/query-cost-meter.ts';
import { expect, test } from 'bun:test';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { DATE_PUBLISHED_DEFINITION_NOTATION } from '../../../services/main/src/modules/statement/qualification.ts';
import { GRAPHS } from '../../../services/main/src/modules/work/activate.ts';
import {
  FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_PREDICATE, FIRST_PUBLICATION_TYPE, invertedPublicationYear,
} from '../../../services/main/src/modules/query/year-fact.ts';
import { startMediaStack } from './media-support.ts';
import type { TemplateInput } from '../../../services/main/src/modules/query/template-schema.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { realmSelectionDigest, selectRealmLocal } from '../../../services/main/src/modules/work/select-realm.ts';

const QUERY = 'https://rezics.com/query/work-publication-years';
const POPULATION = 5_000;
const PAGE = 20;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const short = (ref: string) => ref.slice(-36);

test('First-publication years: newest page, incremental posting, and a seek that stays inside the page window', async () => {
  const stack = await startMediaStack('year-fact-read');
  try {
    const member = await stack.member('year-reader');
    await ensureGlobalClassificationContext(stack.env);
    const published = await stack.publicWork(member.actor);
    const older = await stack.publicWork(member.actor);
    const middle = await stack.publicWork(member.actor);
    const undated = await stack.publicWork(member.actor);
    const hidden = await stack.privateWork(member.actor);
    await member.grant('semantic:create:root', 'semantic.change');
    await member.grant(`statement:speak:${member.actor}`, 'statement.record');
    await member.grant(`statement:speak:${member.actor}`, 'statement.withdraw');
    await member.grant('classification:decide:global', 'statement.decide');
    for (const work of [published, older, middle, undated, hidden]) {
      await member.grant(`work:read:${work.work}`, 'work.read');
    }
    const defined = await member.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: member.actor,
      state: { component: 'definition', kind: 'property', lifecycle: 'active', successor: null, roles: [],
        notation: DATE_PUBLISHED_DEFINITION_NOTATION },
    });
    const definedText = await defined.text();
    if (defined.status !== 201 && defined.status !== 200) throw new Error(`${defined.status}: ${definedText}`);
    const property = JSON.parse(definedText) as { component: string; revision: string };
    await member.grant(`semantic:read:${property.component}`, 'semantic.read');
    const publish = async (subject: string, lexical: string, datatype: string) => {
      const written = await member.send('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject,
        predicate: property.component, relationDefinition: property.revision,
        value: { kind: 'literal', lexical, datatype, language: null },
        applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: member.actor,
      });
      const writtenText = await written.text();
      if (written.status !== 201) throw new Error(`${written.status}: ${writtenText}`);
      return JSON.parse(writtenText) as { statement: string; revision: string };
    };
    const dated = await publish(published.work, '2024-06-01', `${XSD}date`);
    const early = await publish(older.work, '1999-12-31T23:00:00.000Z', `${XSD}dateTime`);
    const mid = await publish(middle.work, '2010-03-15', `${XSD}date`);
    const concealed = await publish(hidden.work, '2018-04-04', `${XSD}date`);
    const epoch = stack.env.lineage.dataEpoch;
    await stack.templateSeek.backfill(epoch, true);
    const yearCount = async () => Number((await stack.accessPool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM access.template_seek_entry WHERE epoch=$1 AND anchor=$2 AND type=$3',
      [epoch, FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_TYPE])).rows[0]!.count);
    expect(await yearCount()).toBe(0);
    const accept = async (statement: string) => {
      const decision = await member.send('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1', target: { kind: 'statement', statement },
        acceptance: { kind: 'global' }, expectedDecisionHead: null, outcome: 'accepted',
        actingSubject: member.actor,
      });
      const decisionText = await decision.text();
      if (decision.status !== 201 && decision.status !== 200) throw new Error(`${decision.status}: ${decisionText}`);
    };
    for (const statement of [dated, early, mid, concealed]) await accept(statement.statement);
    expect(await yearCount()).toBe(4);
    const posted = (await stack.accessPool.query<{ payload: { yearKey?: string[]; statement?: string[]; work?: string[] } }>(
      'SELECT payload FROM access.template_seek_entity WHERE epoch=$1 AND graph=$2 AND id=$3',
      [epoch, GRAPHS.current, published.work])).rows[0]!.payload;
    expect(posted.work).toEqual([FIRST_PUBLICATION_ANCHOR]);
    expect(posted.yearKey).toEqual([invertedPublicationYear(2024)]);
    expect(posted.statement).toEqual([dated.statement]);
    const read = async (parameters: TemplateInput['parameters'] = {}, limit = PAGE, cursor?: string, token?: string) => {
      const response = await stack.main.handle(new Request('http://main.local/v1/query', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ profile: 'template-query-v1', query: QUERY, revision: 1, parameters, limit, ...(cursor ? { cursor } : {}) }) }));
      const value = await response.json() as { result?: { items: Array<{ id: string; year: number; statement: string }>; nextCursor: string | null; complete: boolean } };
      if (response.status !== 200) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
      return value.result!;
    };
    const facts = (items: Array<{ id: string; year: number; statement: string }>) => items.map(item => ({ id: item.id, year: item.year, statement: item.statement }));
    const first = await read();
    expect(facts(first.items)).toEqual([
      { id: published.work, year: 2024, statement: dated.statement },
      { id: middle.work, year: 2010, statement: mid.statement },
      { id: older.work, year: 1999, statement: early.statement },
    ]);
    expect(first.items.map(item => item.id)).not.toContain(hidden.work);
    expect(first.items.map(item => item.id)).not.toContain(undated.work);
    expect(facts((await read({ fromYear: 2010, toYear: 2024 })).items)).toEqual([
      { id: published.work, year: 2024, statement: dated.statement },
      { id: middle.work, year: 2010, statement: mid.statement },
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
    const realmInput = { name: 'Publication year Realm', actingSubject: member.actor };
    const createdRealm = await createRealmSpace(stack.env, stack.admission(member.actor,
      'space:create:root', 'space.create', spaceCreationDigest(realmInput)), realmInput);
    if (createdRealm.outcome !== 'succeeded' || !createdRealm.realm) throw new Error('Realm creation failed');
    const realm = createdRealm.realm;
    // Leave the middle Work outside this Realm: a global year page cannot
    // stand in for a Realm page, even when its first result happens to match.
    for (const work of [published, older]) {
      const selected = { context: { kind: 'realm-local' as const, id: realm }, work: work.work,
        mainVersion: work.mainVersion, contribution: work.variants[0]!.contribution,
        publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
        selectionBasis: 'realm-manager-review' as const, actingSubject: member.actor };
      const result = await selectRealmLocal(stack.env, stack.admission(member.actor,
        `publication:adopt:${realm}`, 'publication.adopt', realmSelectionDigest(selected)), selected);
      if (result.outcome !== 'succeeded') throw new Error('Realm adoption failed');
    }
    const stranger = await stack.member('year-stranger');
    const scoped = { realm, filter: { all: [{ facet: 'publicationYear', range: { min: '1990', max: '2024' } }] } };
    for (const persona of [member, stranger]) {
      const seen: string[] = [];
      let next: string | undefined;
      for (let step = 0; step < 12; step++) {
        const page = await read(scoped, 1, next, persona.token);
        seen.push(...page.items.map(item => item.id));
        if (!page.nextCursor) { next = undefined; break; }
        next = page.nextCursor;
      }
      expect(next).toBeUndefined();
      expect(seen).toEqual([published.work, older.work]);
      expect(new Set(seen).size).toBe(seen.length);
    }
    const scopedFirst = await read(scoped, 1);
    expect((await stack.main.handle(new Request('http://main.local/v1/query', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: 'template-query-v1',
        query: QUERY, revision: 1, parameters: { realm }, limit: 1, cursor: scopedFirst.nextCursor }) }))).status).toBe(400);
    const laterYear = await publish(published.work, '2001-05-01', `${XSD}date`);
    await accept(laterYear.statement);
    expect(await yearCount()).toBe(5);
    const withSecondYear = await read();
    expect(facts(withSecondYear.items)).toEqual([
      { id: published.work, year: 2024, statement: dated.statement },
      { id: middle.work, year: 2010, statement: mid.statement },
      { id: published.work, year: 2001, statement: laterYear.statement },
      { id: older.work, year: 1999, statement: early.statement },
    ]);
    const current = await member.read(`/v1/statements/${short(early.statement)}`);
    const currentText = await current.text();
    if (current.status !== 200) throw new Error(`${current.status}: ${currentText}`);
    const resource = JSON.parse(currentText) as { revision: string };
    const withdrawn = await member.send('POST', `/v1/statements/${short(early.statement)}/withdrawals`, {
      profile: 'statement-v1', speaker: { kind: 'personal' }, expectedHead: resource.revision,
      actingSubject: member.actor,
    });
    const withdrawnText = await withdrawn.text();
    if (withdrawn.status !== 201 && withdrawn.status !== 200) throw new Error(`${withdrawn.status}: ${withdrawnText}`);
    expect(await yearCount()).toBe(4);
    const visible = await read();
    expect(facts(visible.items)).toEqual([
      { id: published.work, year: 2024, statement: dated.statement },
      { id: middle.work, year: 2010, statement: mid.statement },
      { id: published.work, year: 2001, statement: laterYear.statement },
    ]);
    const measure = async (parameters: TemplateInput['parameters'] = {}) => {
      let templateQuery = 0, basis = 0, sql = 0;
      const nativeQuery = stack.fuseki.templateQuery.bind(stack.fuseki);
      const nativeIndex = stack.fuseki.templateIndex.bind(stack.fuseki);
      const nativeSql = stack.accessPool.query.bind(stack.accessPool);
      const checkouts = stack.accessPool.checkouts;
      stack.fuseki.templateQuery = (async (...args: Parameters<typeof nativeQuery>) => { if (foregroundCounted()) templateQuery++; return nativeQuery(...args); }) as typeof stack.fuseki.templateQuery;
      stack.fuseki.templateIndex = (async (...args: Parameters<typeof nativeIndex>) => {
        if (args[0].operation === 'basis' && foregroundCounted()) basis++;
        return nativeIndex(...args);
      }) as typeof stack.fuseki.templateIndex;
      stack.accessPool.query = (async (...args: Parameters<typeof nativeSql>) => { if (foregroundCounted()) sql++; return nativeSql(...args); }) as typeof stack.accessPool.query;
      try {
        const page = await read(parameters);
        return { templateQuery, basis, sql, checkouts: stack.accessPool.checkouts - checkouts, items: facts(page.items) };
      } finally {
        stack.fuseki.templateQuery = nativeQuery;
        stack.fuseki.templateIndex = nativeIndex;
        stack.accessPool.query = nativeSql;
      }
    };
    const before = await measure();
    const growth = [];
    for (const population of [50, 500, POPULATION]) {
      await stack.accessPool.query(`INSERT INTO access.template_seek_entity(epoch,graph,id,sequence,payload)
        SELECT $1,$2,'urn:rezics:year-population:'||n,0,'{}'::jsonb FROM generate_series(1,$3) n ON CONFLICT DO NOTHING`,
      [epoch, GRAPHS.current, population]);
      await stack.accessPool.query(`INSERT INTO access.template_seek_entry(epoch,graph,predicate,anchor,type,key,id)
        SELECT $1,$2,$3,$4,$5,'9999','urn:rezics:year-population:'||n FROM generate_series(1,$6) n ON CONFLICT DO NOTHING`,
      [epoch, GRAPHS.current, FIRST_PUBLICATION_PREDICATE, FIRST_PUBLICATION_ANCHOR, FIRST_PUBLICATION_TYPE, population]);
      const measured = await measure(scoped);
      growth.push({ population, ...measured });
      expect(measured.items.map(item => item.id)).toEqual([published.work, published.work]);
      expect(measured.templateQuery).toBeLessThanOrEqual(4);
      expect(measured.basis).toBeLessThanOrEqual(4);
      expect(measured.sql).toBeLessThanOrEqual(40);
    }
    expect(growth.map(row => row.sql)).toEqual(Array(3).fill(growth[0]!.sql));
    console.log(JSON.stringify({ label: 'scoped-year-growth', growth }));
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
