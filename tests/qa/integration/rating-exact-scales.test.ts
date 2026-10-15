import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { personaSessions, type PersonaSessions, type PersonaSession } from '../support/personas.ts';
import { pollLibraryImportApply } from './library-import-apply-support.ts';

interface Opinion { observation: string; observationRevision: string; value: number | null }
let people: PersonaSessions, pool: Pool, realmContext: string, globalContext: string;
const stars = { min: 0.25, max: 5, step: 0.25 };
const votes = { min: 1, max: 10, step: 0.1 };
const uuid = (value: string) => value.slice(-36);
async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const own = () => ({ actingSubject: people.owner.actingSubject! });
async function grant(person: PersonaSession, scope: string, action: string) {
  const principals = await pool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject=$1 AND active', [person.accountId]);
  expect(principals.rows).toHaveLength(1);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await grantFixtureAuthority(client, { scope, requireDispatch: true,
      representations: [{ principalId: principals.rows[0]!.id, actor: person.actingSubject!, action, lifetime: '8 hours' }],
      grant: { actor: person.actingSubject!, action, lifetime: '8 hours' } });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const makeWork = async () => { const made = await json<{ work: string; mainVersion: string }>(people.owner.main('POST', '/v1/works', {
  profile: 'metadata-only-v1', authoring: 'own-work', title: `Exact score ${randomUUID()}`,
  language: 'en', semanticTypes: ['https://schema.org/Book'], ...own() }), 201);
  return { work: made.work, mainVersion: made.mainVersion };
};
function set(context: string, target: { work: string; mainVersion: string }, value: number,
  head: string | null = null) {
  const global = context === globalContext;
  return json<Opinion>(people.owner.main('POST', global ? '/v1/global-rating-observations' : '/v1/rating-observations', {
    profile: global ? 'global-rating-standing-observation-v1' : 'realm-standing-rating-observation-v1',
    context, ...target, value, expectedRevisionHead: head, ...own() }), 201);
}
function revision(person: PersonaSession, context: string, mainVersion: string, opinion: Opinion) {
  const query = new URLSearchParams({ context, mainVersion, actingSubject: person.actingSubject!,
    ...(context === globalContext ? { profile: 'global-rating-standing-observation-v1' } : {}) });
  return person.main('GET', `/v1/rating-observations/${uuid(opinion.observation)}/revisions/${uuid(opinion.observationRevision)}?${query}`);
}

beforeAll(async () => {
  const started = Date.now();
  people = await personaSessions('public');
  if (!Bun.env.ACCESS_DATABASE_URL) throw new Error('Run through goalctl test on a QA stack');
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 2 });
  await grant(people.owner, `rating:context:${people.realm}`, 'rating.context.create');
  await grant(people.owner, GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
  realmContext = (await json<{ context: string; scale: object }>(people.owner.main('POST', '/v1/rating-contexts', {
    profile: 'realm-standing-rating-context-v1', realm: people.realm, question: 'Quarter-star judgment', scale: stars, ...own() }), 201)).context;
  globalContext = (await json<{ context: string }>(people.owner.main('POST', '/v1/global-rating-contexts', {
    profile: 'global-rating-standing-context-v1', question: 'Source judgment', scale: votes, ...own() }), 201)).context;
  for (const context of [realmContext, globalContext]) {
    await grant(people.owner, `rating:observe:${context}`, 'rating.observation.set');
    await grant(people.owner, `rating:read:${context}`, 'rating.observation.read');
    // Even a context read grant cannot disclose another principal's slot.
    await grant(people.stranger, `rating:read:${context}`, 'rating.observation.read');
  }
  expect(Date.now() - started).toBeLessThan(600_000);
}, 600_000);
afterAll(async () => { await pool?.end(); await people?.close(); });

test('a scorer edits a quarter-star judgment and reads the exact native value', async () => {
  const target = await makeWork();
  const first = await set(realmContext, target, 4.25);
  const edited = await set(realmContext, target, 4.75, first.observationRevision);
  expect(await json(revision(people.owner, realmContext, target.mainVersion, edited)))
    .toMatchObject({ value: 4.75, exactValue: { kind: 'decimal', lexical: '4.75' }, scale: stars });
  expect(await json(people.owner.main('GET', `/v1/rating-contexts/${uuid(realmContext)}`))).toMatchObject({ scale: stars });
  expect((await people.owner.main('POST', '/v1/rating-observations', {
    profile: 'realm-standing-rating-observation-v1', context: realmContext, ...target,
    value: 4.6, expectedRevisionHead: edited.observationRevision, ...own() })).status).toBe(400);
}, 120_000);

test('an imported VNDB vote becomes an editable native score at source precision', async () => {
  const target = await makeWork();
  const uploaded = await json<{ id: string }>(people.owner.main('POST', '/v1/me/library-imports', {
    format: 'vndb', file: '<vndb-export version="1.0"><vns><vn id="v17"><title>Source judgment</title><vote>8.5</vote></vn></vns></vndb-export>', ...own() }), 201);
  const path = `/v1/me/library-imports/${uploaded.id}`;
  const q = new URLSearchParams(own());
  const reviewed = await json<{ rows: Array<{ index: number; version: number; source: { score: object | null } }> }>(
    people.owner.main('GET', `${path}/rows?${q}`, undefined, randomUUID()));
  expect(reviewed.rows[0]!.source.score).toEqual({ value: 8.5, ...votes });
  await json(people.owner.main('PUT', `${path}/rows/0`, {
    ...own(), choice: 'apply', expectedVersion: reviewed.rows[0]!.version, work: target.work, conflictChoice: 'replace' }));
  const progress = await pollLibraryImportApply(() => people.owner.main('GET', `${path}/apply?${q}`, undefined, randomUUID()), {
    started: people.owner.main('POST', `${path}/apply`, { ...own(), context: globalContext, language: 'en' }), deadlineMs: 60_000 });
  expect(progress).toMatchObject({ state: 'completed', pending: false, issues: 0 });
  const state = await json<{ rating: { global: { value: number; revision: string; scale: object } } }>(people.owner.main('GET',
    `/v1/works/${uuid(target.work)}/reader-state?${q}&ratingContext=${encodeURIComponent(globalContext)}`));
  expect(state.rating.global).toMatchObject({ value: 8.5, scale: votes });
  const edited = await set(globalContext, target, 8.7, state.rating.global.revision);
  expect(await json(revision(people.owner, globalContext, target.mainVersion, edited)))
    .toMatchObject({ value: 8.7, exactValue: { kind: 'decimal', lexical: '8.7' }, scale: votes });
}, 120_000);

test('cross-scale synthesis normalizes exact means and leaves source scores unchanged', async () => {
  const target = await makeWork();
  const quarter = await set(realmContext, target, 4.75);
  const vote = await set(globalContext, target, 8.7);
  expect(await json(people.owner.main('POST', '/v1/rating-syntheses', {
    profile: 'realm-global-standing-synthesis-v1', realmContext, globalContext, ...target })))
    .toMatchObject({ value: { numerator: '3083', denominator: '3420' }, components: {
      realm: { scale: stars, precision: { kind: 'exact-rational', numerator: '19', denominator: '4' } },
      global: { scale: votes, precision: { kind: 'exact-rational', numerator: '87', denominator: '10' } } } });
  expect(await json(revision(people.owner, realmContext, target.mainVersion, quarter))).toMatchObject({ value: 4.75 });
  expect(await json(revision(people.owner, globalContext, target.mainVersion, vote))).toMatchObject({ value: 8.7 });
}, 120_000);

test('a stranger cannot read either private native judgment even with a context read grant', async () => {
  const target = await makeWork();
  for (const [context, score] of [[realmContext, 4.75], [globalContext, 8.7]] as const) {
    const opinion = await set(context, target, score);
    const response = await revision(people.stranger, context, target.mainVersion, opinion);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(String(score));
  }
}, 120_000);

test('the same native owner accepts a declared 10–100 scale without a source-specific operation', async () => {
  const scale = { min: 10, max: 100, step: 1 };
  const context = (await json<{ context: string }>(people.owner.main('POST', '/v1/rating-contexts', {
    profile: 'realm-standing-rating-context-v1', realm: people.realm, question: 'Fine-grained judgment', scale, ...own() }), 201)).context;
  await grant(people.owner, `rating:observe:${context}`, 'rating.observation.set');
  await grant(people.owner, `rating:read:${context}`, 'rating.observation.read');
  const target = await makeWork();
  const first = await set(context, target, 87);
  const edited = await set(context, target, 88, first.observationRevision);
  expect(await json(revision(people.owner, context, target.mainVersion, edited)))
    .toMatchObject({ value: 88, exactValue: { kind: 'integer', lexical: '88' }, scale });
}, 120_000);
