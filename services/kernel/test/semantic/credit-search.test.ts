import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { accessCommandAuthorization } from '../../src/request/access.ts';
import { createKernelCreditSearchSource } from '../../src/composition/runtime-defaults.ts';
import { CREDIT_SEARCH_LIMITS } from '../../src/search/credit-search.ts';
import { createRatedSubjectSource } from '../../src/search/rated-source.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  createCreditSearchSource,
  receiveCreditSearch,
  receiveCreditSearchMatch,
} from '../../src/semantic/credit-search.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { createRealAccess } from './real-access.ts';
import { newId } from '../../src/route/route.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

// Each test drives the real HTTP command path and several native projections against the migrated database.
setDefaultTimeout(120_000);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const routeKey = new Uint8Array(32).fill(91);
const adapter = createCreditSearchSource(pool, routeKey);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const ACTIONS = [
  'subject:create',
  'subject:read',
  'subject:merge',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
  'moderation:takedown',
  'gate:subject_identity',
];
const accounts = { editor: newId(44000) };
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
beforeAll(async () => {
  for (const action of ACTIONS) await realAccess.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
const kernel = createKernel({
  pool,
  access: realAccess.access,
  tokens,
  routeKey,
  writeRate: createWriteRateLimiter({
    secret: 'semantic-credit-search-write-rate-secret-32b',
    overrides: JSON.stringify(
      Object.fromEntries(
        ['new-account', 'member', 'trusted', 'service'].map((kind) => [
          kind,
          { write: { maximum: 100000, seconds: 60 } },
        ]),
      ),
    ),
  }),
  receiptKeys: testReceiptKeys(),
});

async function call(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${realAccess.bearer('editor')}`,
        ...(body === undefined
          ? {}
          : { 'idempotency-key': `"${randomUUID()}"`, 'content-type': 'application/json', ...extra }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}
async function ok(path: string, body: unknown, status = 200, extra?: Record<string, string>) {
  const answer = await call('POST', path, body, extra);
  expect(answer.response.status, JSON.stringify(answer.body)).toBe(status);
  return answer.body;
}
const value = (content: unknown) => ({ type: 'value', content });
const statement = (property: string, content: unknown, qualifiers?: unknown[]) => ({
  property: { id: property },
  value: value(content),
  ...(qualifiers ? { qualifiers } : {}),
});
async function person(name: string, aliases?: Record<string, string[]>) {
  return (
    await ok('/v1/subjects', { type: 'schema:Person', labels: { en: name }, ...(aliases ? { aliases } : {}) }, 201)
  ).subject as Record<string, any>;
}
async function ready(subject: string) {
  const row = await admin.query<{ ready: boolean }>(
    'SELECT ready FROM semantic.search_selection_state WHERE subject_id = $1',
    [subject],
  );
  return row.rows[0]?.ready === true;
}
const authorOf = (work: Record<string, any>, target: string) =>
  (work.statements['schema:author'] as { id: string; value: { content: string } }[]).find(
    (entry) => entry.value.content === target,
  )!;

async function renamePerson(id: string, name: string) {
  await admin.query(
    `INSERT INTO semantic.fact (
       route, subject_id, slot_id, log_seq, operation, kind, language, property, statement_id, body,
       recorded_transaction_id, release, relation
     )
     SELECT route, subject_id, slot_id, log_seq + 1, 'assert', kind, language, property, statement_id,
            to_jsonb($2::text), $3::uuid, release, relation
     FROM semantic.current_term_fact
     WHERE subject_id = $1 AND kind = 'label' AND language = 'en'
     ORDER BY log_seq DESC
     LIMIT 1`,
    [id, name, randomUUID()],
  );
  await admin.query('UPDATE semantic.subject SET current_facts = current_facts WHERE subject_id = $1', [id]);
}

test('installed adapter and Search receiver match VN aliases and anime homonyms', async () => {
  expect(createRatedSubjectSource(pool, routeKey).source.creditSearch).toBeDefined();
  const composed = createKernelCreditSearchSource(pool, routeKey);
  expect(composed.page).toBeDefined();
  expect(composed.current).toBeDefined();
  expect(composed.unchanged).toBeDefined();
  const writer = await person('Urobuchi Gen', { en: ['Nitroplus'], ja: ['虚淵玄'] });
  const satoA = await person('Sato');
  const satoB = await person('Sato');
  const vn = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Fate Extra CCC' },
        statements: {
          'schema:author': [
            statement('schema:author', writer.id, [
              { property: { id: 'schema:position' }, value: value('1') },
              { property: { id: 'wdt:P1932' }, value: value('Urobuchi') },
            ]),
          ],
        },
      },
      201,
    )
  ).subject as Record<string, any>;
  const character = (await ok('/v1/subjects', { type: 'wd:Q95074', labels: { en: 'Heroine' } }, 201)).subject as Record<
    string,
    any
  >;
  const anime = (
    await ok(
      '/v1/subjects',
      {
        type: 'schema:TVSeries',
        labels: { en: 'Homonym Cast' },
        statements: {
          'wdt:P725': [
            statement('wdt:P725', satoA.id, [{ property: { id: 'wdt:P453' }, value: value(character.id) }]),
            statement('wdt:P725', satoB.id),
          ],
        },
      },
      201,
    )
  ).subject as Record<string, any>;

  const vnProjection = await receiveCreditSearch(composed, vn.id);
  expect(vnProjection.state).toBe('complete');
  if (vnProjection.state !== 'complete') throw new Error('complete VN projection');
  const writerNames = vnProjection.names.filter((name) => name.targetId === writer.id).map((name) => name.name.value);
  expect(writerNames).toEqual(expect.arrayContaining(['Urobuchi Gen', 'Nitroplus', '虚淵玄']));
  expect(vnProjection.names[0]!.qualifiers).toEqual(
    expect.arrayContaining([
      { property: 'schema:position', value: '1' },
      { property: 'wdt:P1932', value: 'Urobuchi' },
    ]),
  );
  expect(await receiveCreditSearchMatch(composed, vnProjection, vnProjection.names[0]!)).toBe('current');

  const animeProjection = await receiveCreditSearch(composed, anime.id);
  expect(animeProjection.state).toBe('complete');
  if (animeProjection.state !== 'complete') throw new Error('complete anime projection');
  const satos = [...new Set(animeProjection.names.map((name) => name.targetId))].sort();
  expect(satos).toEqual([satoA.id, satoB.id].sort());
  expect(animeProjection.names.every((name) => name.name.value === 'Sato')).toBe(true);
  expect(await receiveCreditSearchMatch(composed, animeProjection, animeProjection.names[1]!)).toBe('current');
});

test('an unready native selection reports preparing, resumes and then returns complete names', async () => {
  const author = await person('Resumed Author', { en: ['Resume Pen Name'] });
  const work = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Selection continuation' },
        statements: { 'schema:author': [statement('schema:author', author.id)] },
      },
      201,
    )
  ).subject as Record<string, any>;
  await admin.query('UPDATE semantic.search_selection_state SET ready = false WHERE subject_id = $1', [work.id]);

  const preparing = await receiveCreditSearch(adapter, work.id);
  expect(preparing.state).toBe('preparing');
  expect(await ready(work.id)).toBe(true);

  const complete = await receiveCreditSearch(adapter, work.id);
  expect(complete.state).toBe('complete');
  if (complete.state !== 'complete') throw new Error('complete after selection resumes');
  expect(complete.names.map((name) => name.name.value)).toEqual(
    expect.arrayContaining(['Resumed Author', 'Resume Pen Name']),
  );
});

test('credit, name, concealment, merge and release changes invalidate the original observation', async () => {
  const author = await person('Original Author');
  const extra = await person('Added Author');
  const duplicate = await person('Duplicate Author');
  const work = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Mutable credits' },
        statements: {
          'schema:author': [statement('schema:author', author.id), statement('schema:author', extra.id)],
        },
      },
      201,
    )
  ).subject as Record<string, any>;
  const first = await receiveCreditSearch(adapter, work.id);
  expect(first.state).toBe('complete');
  if (first.state !== 'complete') throw new Error('complete first projection');
  const original = first.names.find((name) => name.targetId === author.id)!;
  expect(await receiveCreditSearchMatch(adapter, first, original)).toBe('current');
  expect(first.names.some((name) => name.targetId === extra.id)).toBe(true);

  const extraStatement = authorOf(work, extra.id);
  await ok(`/v1/subjects/${work.id}/candidates/${extraStatement.id}:hide`, { reason: 'retired credit' });
  expect(await adapter.unchanged(work.id, first.observation)).toBe(false);
  expect(await receiveCreditSearchMatch(adapter, first, original)).toBe('changed');

  const afterHide = await receiveCreditSearch(adapter, work.id);
  expect(afterHide.state).toBe('complete');
  if (afterHide.state !== 'complete') throw new Error('complete after hide');
  expect(afterHide.names.every((name) => name.targetId !== extra.id)).toBe(true);
  await ok(`/v1/subjects/${work.id}/candidates/${extraStatement.id}:restore`, { reason: 'restored credit' });
  expect(await adapter.unchanged(work.id, afterHide.observation)).toBe(false);

  const afterAdd = await receiveCreditSearch(adapter, work.id);
  expect(afterAdd.state).toBe('complete');
  if (afterAdd.state !== 'complete') throw new Error('complete after restore');
  expect(afterAdd.names.some((name) => name.targetId === extra.id)).toBe(true);

  await renamePerson(author.id, 'Renamed Author');
  expect(await adapter.unchanged(work.id, afterAdd.observation)).toBe(false);
  const afterRename = await receiveCreditSearch(adapter, work.id);
  expect(afterRename.state).toBe('complete');
  if (afterRename.state !== 'complete') throw new Error('complete after rename');
  expect(afterRename.names.some((name) => name.name.value === 'Renamed Author')).toBe(true);
  expect(
    await receiveCreditSearchMatch(
      adapter,
      afterAdd,
      afterAdd.names.find((name) => name.targetId === author.id)!,
    ),
  ).toBe('changed');

  await ok(`/v1/subjects/${author.id}:hide`, { reason: 'concealed creator' });
  const concealed = await receiveCreditSearch(adapter, work.id);
  expect(concealed.state).toBe('complete');
  if (concealed.state !== 'complete') throw new Error('complete after creator concealment');
  expect(concealed.names.every((name) => name.targetId !== author.id)).toBe(true);

  const survivor = extra.id < duplicate.id ? extra.id : duplicate.id;
  const redirected = extra.id < duplicate.id ? duplicate.id : extra.id;
  const access = realAccess.access({
    actions: new Map(ACTIONS.map((action) => [action, { anonymous: false }])),
  });
  const deadline = Date.now() + 30_000;
  const actor = await access.authenticate(realAccess.bearer('editor'), { pool, deadline });
  if (actor.kind !== 'account') throw new Error('editor');
  const mergeKey = randomUUID();
  await mergeSubjects(pool, {
    actor,
    subjects: [survivor, redirected],
    idempotencyKey: mergeKey,
    digest: createHash('sha256').update(mergeKey).digest(),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: await accessCommandAuthorization(
      access,
      actor,
      'subject:merge',
      { route: 0, id: GLOBAL_CONTEXT },
      { pool, deadline },
      () => new Error('Denied merge'),
    ),
    deadline,
  });
  expect(await adapter.unchanged(work.id, afterRename.observation)).toBe(false);

  const current = await adapter.current(
    { ...original, release: 'sha256:not-the-statement-release' },
    first.observation,
  );
  expect(current === false || current === 'unavailable').toBe(true);
});

test('fourth-page and name-coverage cases stay incomplete without dropping readiness', async () => {
  const crowded = await person('Crowded Names', {
    en: Array.from({ length: 16 }, (_, index) => `Alias ${index}`),
  });
  const named = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Name overflow' },
        statements: { 'schema:author': [statement('schema:author', crowded.id)] },
      },
      201,
    )
  ).subject as Record<string, any>;
  const names = await receiveCreditSearch(adapter, named.id);
  expect(names.state).toBe('incomplete');
  expect(await ready(named.id)).toBe(true);

  const writer = await person('Page author');
  const paged = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Four page credits' },
        statements: { 'schema:author': [statement('schema:author', writer.id)] },
      },
      201,
    )
  ).subject as Record<string, any>;
  const needed = CREDIT_SEARCH_LIMITS.pages * CREDIT_SEARCH_LIMITS.creditsPerPage + 1;
  const template = await admin.query(
    `SELECT property FROM semantic.search_selected WHERE subject_id = $1 AND active LIMIT 1`,
    [paged.id],
  );
  expect(template.rows).toHaveLength(1);
  expect(template.rows[0]!.property).toBe('schema:author');
  const inserted = await admin.query(
    `INSERT INTO semantic.search_selected (
       route, subject_id, slot_id, candidate_id, property, rank, ordinal, body, release, revision,
       source, relation, compact, active, log_seq
     )
     SELECT t.route, t.subject_id, gen_random_uuid(), gen_random_uuid(), t.property, t.rank, t.ordinal,
            t.body, t.release, t.revision, t.source, t.relation, true, true, t.log_seq
     FROM semantic.search_selected t
     CROSS JOIN generate_series(1, $2::integer)
     WHERE t.subject_id = $1::uuid AND t.active`,
    [paged.id, needed - 1],
  );
  expect(inserted.rowCount).toBe(needed - 1);
  const counted = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM semantic.search_selected WHERE subject_id = $1 AND active AND property = $2',
    [paged.id, 'schema:author'],
  );
  expect(counted.rows[0]!.n).toBe(needed);
  const home = await pool.query<{ route: number }>('SELECT route FROM semantic.subject WHERE subject_id = $1', [
    paged.id,
  ]);
  const mimic = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM semantic.search_selected
     WHERE route = $1 AND subject_id = $2 AND property = ANY($3::text[]) AND active
       AND route >= ($4::integer) * 16 AND route < ($4::integer + 1) * 16`,
    [home.rows[0]!.route, paged.id, ['schema:author'], home.rows[0]!.route >> 4],
  );
  expect(mimic.rows[0]!.n).toBe(needed);
  const page = await adapter.page({
    workId: paged.id,
    after: null,
    observation: null,
    limits: CREDIT_SEARCH_LIMITS,
  });
  expect(page.state, JSON.stringify(page)).toBe('current');
  if (page.state !== 'current') throw new Error('current first page');
  expect(page.next, `entries=${page.entries.length} mimic=${mimic.rows[0]!.n}`).toBeString();
  expect(page.entries).toHaveLength(CREDIT_SEARCH_LIMITS.creditsPerPage);
  // Each cursor resumes strictly after the last credit returned, so no credit is skipped at a page boundary.
  let cursor = page.next;
  for (let index = 1; index < CREDIT_SEARCH_LIMITS.pages; index++) {
    const later = await adapter.page({
      workId: paged.id,
      after: cursor,
      observation: page.observation,
      limits: CREDIT_SEARCH_LIMITS,
    });
    expect(later.state, JSON.stringify(later)).toBe('current');
    if (later.state !== 'current') throw new Error('current later page');
    expect(later.entries).toHaveLength(CREDIT_SEARCH_LIMITS.creditsPerPage);
    cursor = later.next;
  }
  expect(cursor, 'the fourth page leaves one credit unread').toBeString();
  const projection = await receiveCreditSearch(adapter, paged.id);
  expect(projection.state).toBe('incomplete');
  expect(await ready(paged.id)).toBe(true);
  // Exactly four full pages end the traversal: removing one selected credit lets the same subject complete.
  await admin.query(
    `DELETE FROM semantic.search_selected
     WHERE ctid = (SELECT ctid FROM semantic.search_selected
                   WHERE subject_id = $1 AND active AND property = 'schema:author' LIMIT 1)`,
    [paged.id],
  );
  const whole = await receiveCreditSearch(adapter, paged.id);
  expect(whole.state).toBe('complete');
  if (whole.state !== 'complete') throw new Error('complete fourth page');
  expect(whole.names).toHaveLength(CREDIT_SEARCH_LIMITS.pages * CREDIT_SEARCH_LIMITS.creditsPerPage);
}, 180_000);

test('qualifier and release changes after a page read invalidate the selected witness', async () => {
  const writer = await person('Revised writer');
  const work = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Revised credit' },
        statements: {
          'schema:author': [
            statement('schema:author', writer.id, [
              { property: { id: 'wdt:P1932' }, value: value('Old romanisation') },
            ]),
          ],
        },
      },
      201,
    )
  ).subject as Record<string, any>;
  const first = await receiveCreditSearch(adapter, work.id);
  expect(first.state).toBe('complete');
  if (first.state !== 'complete') throw new Error('complete first projection');
  const matched = first.names[0]!;
  expect(matched.qualifiers).toEqual([{ property: 'wdt:P1932', value: 'Old romanisation' }]);
  expect(await receiveCreditSearchMatch(adapter, first, matched)).toBe('current');

  // A native revision rewrites the selected qualifier and re-stamps the statement under another release digest.
  const revisedRelease = `sha256:${'1'.repeat(64)}`;
  await admin.query(
    `UPDATE semantic.search_selected
     SET release = $2,
         body = jsonb_set(body, '{qualifiers}', (
           SELECT jsonb_agg(CASE WHEN q->>'property' = 'wdt:P1932'
                                 THEN jsonb_set(q, '{value,content}', to_jsonb('New romanisation'::text))
                                 ELSE q END)
           FROM jsonb_array_elements(body->'qualifiers') q))
     WHERE subject_id = $1 AND active AND property = 'schema:author'`,
    [work.id, revisedRelease],
  );
  expect(await receiveCreditSearchMatch(adapter, first, matched)).toBe('changed');

  const fresh = await receiveCreditSearch(adapter, work.id);
  expect(fresh.state).toBe('complete');
  if (fresh.state !== 'complete') throw new Error('complete fresh projection');
  const revised = fresh.names.find((name) => name.targetId === writer.id)!;
  expect(revised.release).toBe(revisedRelease);
  expect(revised.qualifiers).toEqual([{ property: 'wdt:P1932', value: 'New romanisation' }]);
  expect(await adapter.current(matched, fresh.observation)).toBe(false);
  expect(await adapter.current({ ...revised, qualifiers: matched.qualifiers }, fresh.observation)).toBe(false);
  expect(await adapter.current({ ...revised, release: matched.release }, fresh.observation)).toBe(false);
  expect(await adapter.current(revised, fresh.observation)).toBe(true);
});
