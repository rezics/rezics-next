import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { createStatementProperty, type StatementProperty } from './statement-property.ts';
import { subjectStatementPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { STATEMENT_SEEK_COST, type StatementSeekOrder } from '../../../services/main/src/modules/statement/seek.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';


/** Real framed read pagination and PostgreSQL visited-row evidence for the reference seek. */
const STATEMENTS = Number(process.env.FRAME_PROFILE_STATEMENTS ?? 240);
const RV = 'https://rezics.com/vocab/';
const short = (ref: string) => ref.slice(-36);
type Page = Static<typeof subjectStatementPage>;
type Member = Awaited<ReturnType<MediaStack['member']>>;
let stack: MediaStack, owner: Member, work: string, subject: string, canon: string, legends: string;
let fact: StatementProperty;

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}
const semantic = async (name: string, type: string, rich = false) => (await json<{ component: string }>(await owner.send(
  'POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [type], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
      { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: work } },
      ...rich ? Array.from({length: 25},(_,index) => ({predicate: `https://example.org/property-${index}`,
        value: {kind: 'language-string',lexical: String(index),language: 'en'}})) : [],
    ] } }), 201)).component;
/** A write that reached reconciliation answers 202 and is repeated with its key until it settles. */
async function settled(path: string, body: object, key: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await owner.send('POST', path, body, key);
    if (response.status !== 202) return json<{ statement: string }>(response, response.status === 200 ? 200 : 201);
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${path} did not settle`);
}
async function accepted(applicability: string[]) {
  const key = randomUUID();
  const saved = await settled('/v1/statements', { profile: 'statement-v1',
    speaker: { kind: 'personal' }, subject, predicate: fact.predicate,
    relationDefinition: fact.relationDefinition, value: { kind: 'literal', lexical: key,
      datatype: 'http://www.w3.org/2001/XMLSchema#string', language: null },
    applicability, interpretation: { kind: 'selected' }, evidence: [], actingSubject: owner.actor }, key);
  await settled('/v1/statement-decisions', { profile: 'statement-decision-v1',
    target: { kind: 'statement', statement: saved.statement }, acceptance: { kind: 'global' },
    expectedDecisionHead: null, outcome: 'accepted', actingSubject: owner.actor }, randomUUID());
  return saved.statement;
}

beforeAll(async () => {
  stack = await startMediaStack('frame-filter');
  owner = await stack.member('frame-profile');
  await ensureGlobalClassificationContext(stack.env);
  work = (await stack.publicWork(owner.actor)).work;
  for (const [scope, action] of [['semantic:create:root', 'semantic.change'], [`statement:speak:${owner.actor}`, 'statement.record'],
    ['classification:decide:global', 'statement.decide'], [`work:read:${work}`, 'work.read']] as const) await owner.grant(scope, action);
  fact = await createStatementProperty(owner.send.bind(owner), owner.actor);
  await owner.grant(`semantic:read:${fact.predicate}`, 'semantic.read');
  subject = await semantic('A subject with many Statements', `${RV}Character`,true);
  canon = await semantic('Canon', `${RV}NarrativeContinuity`);
  legends = await semantic('Legends', `${RV}NarrativeContinuity`);
}, 240_000);
afterAll(async () => { await stack?.stop(); });

test('a framed page of a subject with many Statements is ordered by specificity at a constant number of graph reads per page', async () => {
  // Scopes the frame [Work, Canon] covers (the first four) and scopes it does not (the last two).
  const scopes = [[], [canon], [work], [canon, work], [legends], [legends, work]];
  const covered = new Map<string, number>();
  for (let start = 0; start < STATEMENTS; start += 4) {
    const batch = await Promise.all(Array.from({ length: Math.min(4, STATEMENTS - start) }, async (_, offset) => {
      const index = start + offset, scope = scopes[index % scopes.length]!;
      return [await accepted(scope), index % scopes.length] as const;
    }));
    for (const [statement, kind] of batch) if (kind < 4) covered.set(statement, [0, 17, 17, 34][kind]!);
  }
  const query = (cursor: string | null, frames: string[]) => `/v1/resources/${short(subject)}/statements?limit=20`
    + frames.map(frame => `&frame=${encodeURIComponent(frame)}`).join('') + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  await stack.accessPool.query('DELETE FROM access.statement_seek_coverage WHERE data_epoch=$1',[stack.env.lineage.dataEpoch]);
  expect((await owner.read(query(null,[work,canon]))).status).toBe(503);
  // A full page of component properties still requires Statement coverage.
  expect((await owner.read(query(null,[]))).status).toBe(503);
  expect(await stack.statementSeek.projectOnce()).toBe(false);
  expect(await stack.statementSeek.coverage()).toBeNull();
  await stack.statementSeek.rebuild();
  const seen: { statement: string; score: number }[] = [];
  const timings: number[] = [];
  const queries: number[] = [];
  let cursor: string | null = null;
  do {
    const before = stack.fuseki.queries;
    const started = performance.now();
    const page: Page = await json<Page>(await owner.read(query(cursor, [work, canon])));
    timings.push(performance.now() - started);
    queries.push(stack.fuseki.queries - before);
    for (const group of page.groups) for (const item of group.items) {
      if (item.kind === 'statement') seen.push({ statement: item.statement, score: item.frameMatch!.score });
    }
    cursor = page.nextCursor;
  } while (cursor);
  // Every covered Statement exactly once, none that is not covered, most specific first.
  expect(seen.map(item => item.statement).sort()).toEqual([...covered.keys()].sort());
  expect(seen.map(item => item.score)).toEqual(seen.map(item => item.score).sort((a, b) => b - a));
  for (const item of seen) expect(item.score).toBe(covered.get(item.statement)!);
  // The reads per page do not depend on how many Statements the subject has or which page it is.
  expect(Math.max(...queries)).toBeLessThanOrEqual(queries[0]!);
  const sorted = [...timings].sort((a, b) => a - b);
  console.log(`framed pages of ${STATEMENTS} Statements: ${timings.length} pages, first ${timings[0]!.toFixed(0)} ms, `
    + `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, max ${sorted.at(-1)!.toFixed(0)} ms, `
    + `${Math.min(...queries)}-${Math.max(...queries)} graph reads per page`);
  const statement = covered.keys().next().value!;
  const current = await json<{revision: string}>(await owner.read(`/v1/statements/${short(statement)}`));
  await owner.grant(`statement:speak:${owner.actor}`,'statement.withdraw');
  const withdrawn = await json<{sourcePosition: {sequence: string}}>(await owner.send('POST',
    `/v1/statements/${short(statement)}/withdrawals`,{profile: 'statement-v1',speaker: {kind: 'personal'},
      expectedHead: current.revision,actingSubject: owner.actor}),201);
  expect((await owner.read(query(null,[work,canon]))).status).toBe(503);
  while (await stack.statementSeek.projectOnce()) { /* advance only retained bounded batches */ }
  expect((await stack.statementSeek.coverage())?.through_sequence).toBe(withdrawn.sourcePosition.sequence);
  expect((await stack.accessPool.query('SELECT 1 FROM access.statement_seek WHERE data_epoch=$1 AND statement_id=$2',
    [stack.env.lineage.dataEpoch,statement])).rows).toHaveLength(0);
}, 900_000);

test('Statement seek visits a fixed page on high-degree subjects and after unrelated population growth', async () => {
  const epoch = stack.env.lineage.dataEpoch;
  const source = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:sequence ?sequence } }`)).results!.bindings[0]!.sequence!.value;
  const big = 'https://rezics.com/id/'+randomUUID(),other = 'https://rezics.com/id/'+randomUUID();
  await stack.statementSeek.rebuild();
  const load = (on: string,size: number) => stack.accessPool.query(`INSERT INTO access.statement_seek
    (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs)
    SELECT $1,$2,'https://example.org/fact','urn:rezics:meaning:'||repeat('a',64),
      'https://rezics.com/id/00000000-0000-0000-0000-'||lpad(to_hex(n),12,'0'),key,'[]'::jsonb
    FROM generate_series(1,$3::int) n CROSS JOIN (VALUES ('*'),('[]')) channels(key)`,[epoch,on,size]);
  await load(big,16000);
  const plan = async (after?: string) => {
    const result = await stack.accessPool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT predicate,meaning_key,statement_id,frame_refs FROM access.statement_seek
      WHERE data_epoch=$1 AND subject=$2 AND frame_key='*'
      ${after ? "AND (predicate,meaning_key,statement_id)>('https://example.org/fact','urn:rezics:meaning:'||repeat('a',64),$3)" : ''}
      ORDER BY predicate,meaning_key,statement_id LIMIT 20`,[epoch,big,...after ? [after] : []]);
    const root = result.rows[0]['QUERY PLAN'][0].Plan;
    const nodes: Record<string,any>[] = [];
    const walk = (node: Record<string,any>) => {nodes.push(node);for (const child of node.Plans ?? []) walk(child);};
    walk(root);
    expect(nodes.some(node => node['Node Type'] === 'Sort' || node['Node Type'] === 'Seq Scan')).toBe(false);
    const index = nodes.find(node => String(node['Node Type']).includes('Index'))!;
    expect(index['Index Cond']).toContain('subject');
    expect(index['Actual Rows']+Number(index['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(20);
    return root;
  };
  await stack.accessPool.query('ANALYZE access.statement_seek');
  const late = 'https://rezics.com/id/00000000-0000-0000-0000-000000001f40';
  const before = {first: await plan(),late: await plan(late)};
  let cursor: StatementSeekOrder|null = null;
  const seen = new Set<string>();
  for (;;) {
    const page = await stack.statementSeek.seek({dataEpoch: epoch,sequence: source},big,cursor);
    expect(page.visitedRows).toBeLessThanOrEqual(STATEMENT_SEEK_COST.candidates);
    for (const item of page.candidates) {expect(seen.has(item.statementId)).toBe(false);seen.add(item.statementId);}
    if (page.candidates.length < STATEMENT_SEEK_COST.candidates) break;
    cursor = page.candidates.at(-1)!;
  }
  expect(seen.size).toBe(16000);
  await load(other,32000);
  await stack.accessPool.query('ANALYZE access.statement_seek');
  const after = {first: await plan(),late: await plan(late)};
  const framed = await stack.statementSeek.seek({dataEpoch: epoch,sequence: source},big,null,
    [{iri: work,dimension: 'work',work},{iri: canon,dimension: 'continuity'}]);
  expect(framed.candidates).toHaveLength(20);
  expect(framed.visitedRows).toBe(20);
  const unicode = 'https://rezics.com/id/'+randomUUID();
  await stack.accessPool.query(`INSERT INTO access.statement_seek
    (data_epoch,subject,predicate,meaning_key,statement_id,frame_key,frame_refs)
    SELECT $1,$2,$3,'urn:rezics:meaning:'||repeat('a',64),
      'https://rezics.com/id/00000000-0000-0000-0000-'||lpad(to_hex(n),12,'0'),'*','[]'::jsonb
    FROM generate_series(1,21) n`,[epoch,unicode,'https://example.org/\uE000']);
  await stack.accessPool.query(`INSERT INTO access.statement_seek VALUES
    ($1,$2,$3,$4,$5,'*','[]'::jsonb)`,[epoch,unicode,'https://example.org/😀',
    'urn:rezics:meaning:'+'a'.repeat(64),'https://rezics.com/id/'+randomUUID()]);
  const unicodeFirst = await stack.statementSeek.seek({dataEpoch: epoch,sequence: source},unicode,null);
  expect(unicodeFirst.candidates).toHaveLength(20);
  const unicodeLast = await stack.statementSeek.seek({dataEpoch: epoch,sequence: source},unicode,unicodeFirst.candidates.at(-1)!);
  expect(unicodeLast.candidates.map(row => row.predicate)).toEqual(['https://example.org/\uE000','https://example.org/😀']);
  console.log(JSON.stringify({statementSeekPlans: {before,after},subjectRows: seen.size,unrelatedRows: 32000}));
},180_000);
