import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { CREDIT_SEARCH_LIMITS } from '../../src/search/credit-search.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import {
  createCreditSearchSource,
  receiveCreditSearch,
  receiveCreditSearchMatch,
} from '../../src/semantic/credit-search.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createRealAccess } from './real-access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const routeKey = new Uint8Array(32).fill(91);
const source = subjectSource(pool, routeKey);
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

async function seedPeople(count: number, prefix: string) {
  const ids = Array.from({ length: count }, () => newId(44100));
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const subjects: unknown[] = [];
    const revisions: unknown[] = [];
    const facts: unknown[] = [];
    for (const [index, id] of ids.entries()) {
      const transaction = randomUUID();
      const rows = itemFacts(id, { labels: { en: `${prefix} ${index}` } });
      subjects.push({
        route: routeOf(id),
        subject_id: id,
        type: 'schema:Person',
        recorded_transaction_id: transaction,
        current_facts: rows.length,
        current_release: bundledDigest,
      });
      revisions.push({
        route: routeOf(id),
        subject_id: id,
        recorded_transaction_id: transaction,
        release: bundledDigest,
      });
      for (const fact of rows)
        facts.push({
          route: routeOf(id),
          subject_id: id,
          recorded_transaction_id: transaction,
          ...fact,
        });
    }
    await client.query(
      `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
       SELECT route,subject_id,type,recorded_transaction_id,current_facts,current_release
       FROM jsonb_to_recordset($1::jsonb) AS s(route integer, subject_id uuid, type text, recorded_transaction_id uuid, current_facts integer, current_release text)`,
      [JSON.stringify(subjects)],
    );
    await client.query(
      `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
       SELECT route,subject_id,1,'create',release,recorded_transaction_id
       FROM jsonb_to_recordset($1::jsonb) AS r(route integer, subject_id uuid, recorded_transaction_id uuid, release text)`,
      [JSON.stringify(revisions)],
    );
    await client.query(
      `INSERT INTO semantic.fact(route,subject_id,slot_id,log_seq,operation,kind,language,property,statement_id,body,recorded_transaction_id,release,relation)
       SELECT route,subject_id,slot_id,log_seq,operation,kind,language,property,statement_id,body,recorded_transaction_id,NULL,false
       FROM jsonb_to_recordset($1::jsonb) AS f(
         route integer, subject_id uuid, slot_id uuid, log_seq integer, operation text, kind text, language text,
         property text, statement_id uuid, body jsonb, recorded_transaction_id uuid
       )`,
      [JSON.stringify(facts)],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return ids;
}

test('installed adapter and Search receiver match VN aliases and anime homonyms', async () => {
  expect(source.creditSearch).toBeDefined();
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

  const adapter = source.creditSearch!;
  const vnProjection = await receiveCreditSearch(adapter, vn.id);
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
  expect(await receiveCreditSearchMatch(adapter, vnProjection, vnProjection.names[0]!)).toBe('current');

  const animeProjection = await receiveCreditSearch(adapter, anime.id);
  expect(animeProjection.state).toBe('complete');
  if (animeProjection.state !== 'complete') throw new Error('complete anime projection');
  const satos = [...new Set(animeProjection.names.map((name) => name.targetId))].sort();
  expect(satos).toEqual([satoA.id, satoB.id].sort());
  expect(animeProjection.names.every((name) => name.name.value === 'Sato')).toBe(true);
  expect(await receiveCreditSearchMatch(adapter, animeProjection, animeProjection.names[1]!)).toBe('current');
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
  const adapter = createCreditSearchSource(pool, routeKey);
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

  await admin.query(
    `UPDATE semantic.fact SET body = to_jsonb($2::text)
     WHERE subject_id = $1 AND kind = 'label' AND language = 'en' AND operation = 'assert'`,
    [author.id, 'Renamed Author'],
  );
  await admin.query('UPDATE semantic.subject SET current_facts = current_facts WHERE subject_id = $1', [author.id]);
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
  expect(concealed.state === 'complete' ? concealed.names.every((name) => name.targetId !== author.id) : true).toBe(
    true,
  );

  const survivor = extra.id < duplicate.id ? extra.id : duplicate.id;
  const redirected = extra.id < duplicate.id ? duplicate.id : extra.id;
  await ok('/v1/subjects:merge', { subjects: [survivor, redirected] }, 202);
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
  const names = await receiveCreditSearch(source.creditSearch!, named.id);
  expect(names.state).toBe('incomplete');
  expect(await ready(named.id)).toBe(true);

  const authors = await seedPeople(CREDIT_SEARCH_LIMITS.pages * CREDIT_SEARCH_LIMITS.creditsPerPage + 1, 'Page author');
  const paged = (
    await ok(
      '/v1/subjects',
      {
        type: 'wd:Q689445',
        labels: { en: 'Four page credits' },
        statements: { 'schema:author': authors.map((id) => statement('schema:author', id)) },
      },
      201,
    )
  ).subject as Record<string, any>;
  const projection = await receiveCreditSearch(source.creditSearch!, paged.id);
  expect(projection.state).toBe('incomplete');
  expect(await ready(paged.id)).toBe(true);
  const page = await source.creditSearch!.page({
    workId: paged.id,
    after: null,
    observation: null,
    limits: CREDIT_SEARCH_LIMITS,
  });
  expect(page.state).toBe('current');
  if (page.state !== 'current') throw new Error('current first page');
  expect(page.entries).toHaveLength(CREDIT_SEARCH_LIMITS.creditsPerPage);
  expect(page.next).toBeString();
}, 180_000);
