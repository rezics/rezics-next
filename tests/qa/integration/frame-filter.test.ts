import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { subjectStatementPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { framePattern } from '../../../services/main/src/modules/projection/frame-read.ts';
import { GRAPHS, iri, lit } from '../../../services/main/src/modules/work/activate.ts';
import { READ_PREFIX } from '../../../services/main/src/modules/work/read-session.ts';

/** A subject with many Statements, read through a frame: the specificity ordering evaluates coverage for each of the
 * subject's active accepted Statements on every page, so the cost follows that subject and nothing else. The default
 * size keeps the file inside the routine budget; FRAME_PROFILE_STATEMENTS profiles a larger subject. */
const STATEMENTS = Number(process.env.FRAME_PROFILE_STATEMENTS ?? 240);
const RV = 'https://rezics.com/vocab/';
const short = (ref: string) => ref.slice(-36);
type Page = Static<typeof subjectStatementPage>;
type Member = Awaited<ReturnType<MediaStack['member']>>;
let stack: MediaStack, owner: Member, work: string, subject: string, canon: string, legends: string;

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}
const semantic = async (name: string, type: string) => (await json<{ component: string }>(await owner.send(
  'POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
    state: { component: 'resource', types: [type], properties: [
      { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: name, language: 'en' } },
      { predicate: `${RV}semanticWork`, value: { kind: 'resource', ref: work } },
    ] } }), 201)).component;
/** A write that reached reconciliation answers 202 and is repeated with its key until it settles. */
async function settled(path: string, body: object, key: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await owner.send('POST', path, body, key);
    if (response.status !== 202) return json<{ statement: string }>(response, 201);
    await response.text();
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${path} did not settle`);
}
async function accepted(applicability: string[], index: number) {
  const key = randomUUID();
  const saved = await settled('/v1/statements', { profile: 'statement-v1',
    speaker: { kind: 'personal' }, subject, predicate: `https://example.org/fact-${index % 7}`,
    relationDefinition: 'https://example.org/meaning', value: { kind: 'literal', lexical: key,
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
  subject = await semantic('A subject with many Statements', `${RV}Character`);
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
      return [await accepted(scope, index), index % scopes.length] as const;
    }));
    for (const [statement, kind] of batch) if (kind < 4) covered.set(statement, [0, 17, 17, 34][kind]!);
  }
  const query = (cursor: string | null, frames: string[]) => `/v1/resources/${short(subject)}/statements?limit=20`
    + frames.map(frame => `&frame=${encodeURIComponent(frame)}`).join('') + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
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
}, 900_000);

/** The candidate query of a framed Statement page (subject-read.ts), without the acceptance join, so it measures the
 * ordering alone: coverage is evaluated for every active Statement of the subject, the keyset bound prunes after it,
 * and the sort keeps a page. The graph holds many other subjects' Statements that the query must never touch. */
test('the specificity ordering costs what its subject has, however much else the graph holds', async () => {
  const sizes = (process.env.FRAME_PROFILE_SYNTHETIC ?? '1000,4000,16000').split(',').map(Number);
  const frames = [{ iri: work, dimension: 'work' as const, work }, { iri: canon, dimension: 'continuity' as const }];
  const scopes = [[], [canon], [work], [canon, work], [legends], [legends, work]];
  const coverage = framePattern(frames, '?statement', GRAPHS.current);
  const load = async (on: string, count: number, prefix: string) => {
    for (let start = 0; start < count; start += 1000) {
      const rows = Array.from({ length: Math.min(1000, count - start) }, (_, offset) => {
        const index = start + offset;
        return `<urn:rezics:profile:${prefix}-${index}> a rdf:Statement ; rdf:subject ${iri(on)} ;
          rdf:predicate <https://example.org/fact-${index % 7}> ; rv:statementState rv:Active ;
          rv:meaningKey <urn:rezics:profile-meaning:${prefix}-${index}> ;
          ${scopes[index % scopes.length]!.map(scope => `rv:applicability ${iri(scope)} ;`).join(' ')} rv:head <urn:rezics:profile:head> .`;
      });
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${rows.join('\n')} } }`);
    }
  };
  const page = async (on: string, after: { score: number; predicate: string; statement: string } | null) => {
    const started = performance.now();
    const rows = (await stack.fuseki.query(`${READ_PREFIX} SELECT ?predicate ?statement ?specificity WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:subject ${iri(on)} ; rdf:predicate ?predicate ;
        rv:statementState rv:Active ; rv:meaningKey ?key . }
      ${coverage.filter} BIND((${coverage.score}) AS ?specificity)
      ${after ? `FILTER(?specificity < ${after.score} || ?specificity = ${after.score} && (STR(?predicate) > ${lit(after.predicate)}
        || STR(?predicate) = ${lit(after.predicate)} && STR(?statement) > ${lit(after.statement)}))` : ''}
    } GROUP BY ?predicate ?statement ?specificity ORDER BY DESC(?specificity) STR(?predicate) STR(?statement) LIMIT 21`)).results?.bindings ?? [];
    return { rows, ms: performance.now() - started };
  };
  const report: string[] = [];
  let loaded = 0;
  const big = await semantic('Profiled subject', `${RV}Character`);
  const small = await semantic('Small subject', `${RV}Character`);
  await load(small, 40, 'small');
  const alone = await page(small, null);
  for (const size of sizes) {
    await load(big, size - loaded, 'big'); loaded = size;
    const first = await page(big, null);
    const last = await page(big, { score: 0, predicate: 'https://example.org/fact-6', statement: 'urn:rezics:profile:big-zzz' });
    const neighbour = await page(small, null);
    // The first page is the most specific covered Statements: [canon, work] scopes, then one-dimension scopes.
    expect(first.rows).toHaveLength(21);
    expect(first.rows.slice(0, 5).every(row => row.specificity!.value === '34')).toBe(true);
    expect(neighbour.rows).toHaveLength(21);
    report.push(`${size} Statements: first page ${first.ms.toFixed(0)} ms, last page ${last.ms.toFixed(0)} ms, `
      + `a 40-Statement subject beside it ${neighbour.ms.toFixed(0)} ms (alone ${alone.ms.toFixed(0)} ms)`);
  }
  console.log(`framed candidate query: ${report.join('; ')}`);
}, 600_000);
