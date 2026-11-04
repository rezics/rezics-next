import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { CommandUnavailableError } from '../../src/access/unavailable.ts';
import { createPool } from '../../src/database/pool.ts';
import { accessCommandAuthorization, type AccountActor, type Actor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { adoptCandidates, decideCandidate, proposeStatement } from '../../src/semantic/candidates.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { labelOrderKey } from '../../src/semantic/link-keys.ts';
import { moderateStatement } from '../../src/semantic/moderation.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const source = subjectSource(pool);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const ACTIONS = [
  'subject:create',
  'subject:read',
  'statement:propose',
  'context:accept',
  'context:adopt',
  'moderation:hide',
];
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000071' };
const realAccess = await createRealAccess(admin, accounts, ACTIONS);
const access = realAccess.access({
  actions: new Map(ACTIONS.map((action) => [action, { anonymous: action === 'subject:read' }])),
});
const globalResource = { route: 0, id: GLOBAL_CONTEXT };
const ROUTE = 0x1710;
const deadline = () => Date.now() + 30_000;
beforeAll(async () => {
  for (const action of ACTIONS) await realAccess.grant(globalResource, 'editor', action);
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});

async function actor(): Promise<AccountActor> {
  const authenticated: Actor = await access.authenticate(realAccess.bearer('editor'), { pool, deadline: deadline() });
  if (authenticated.kind !== 'account') throw new TypeError('Visit fixture requires an account actor');
  return authenticated;
}
async function authorization(action: string) {
  return accessCommandAuthorization(
    access,
    await actor(),
    action,
    globalResource,
    { pool, deadline: deadline() },
    () => new Error(`Denied ${action}`),
  );
}
const digest = (seed: string) => createHash('sha256').update(seed).digest();
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const statement = (property: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  property: { id: property },
  value: { type: 'value', content },
  ...extra,
});
const sourced = (property: string, content: unknown) =>
  statement(property, content, {
    references: [{ parts: [statement('schema:url', `https://example.org/${content}`)] }],
  });

function statementId(subject: { statements: Record<string, { id: string }[] | undefined> }, property: string): string {
  const id = subject.statements[property]?.[0]?.id;
  if (!id) throw new Error(`${property} statement is missing`);
  return id;
}

async function created(item: unknown) {
  const target = { route: ROUTE, id: newId(ROUTE) };
  const key = randomUUID();
  const result = await createSubject(pool, {
    actor: await actor(),
    target,
    idempotencyKey: key,
    digest: digest(key),
    item,
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: await authorization('subject:create'),
  });
  return result.subject;
}

async function propose(subject: string, content: string) {
  const key = randomUUID();
  return proposeStatement(pool, {
    subject,
    statement: sourced('schema:inLanguage', content),
    actor: await actor(),
    idempotencyKey: key,
    digest: digest(key),
    release: { digest: bundledDigest, release: bundledRelease },
    authorization: await authorization('statement:propose'),
    deadline: deadline(),
  });
}

test('the mounted source reads current selected nonrelation heads without obsolete history', async () => {
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Current heads', ja: '現在の見出し' },
    statements: {
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
      'schema:datePublished': [
        statement('schema:datePublished', { time: '+1905-01-01T00:00:00Z', precision: 11, calendarmodel: GREGORIAN }),
      ],
    },
  });
  const compactId = statementId(book, 'schema:inLanguage');
  const dateId = statementId(book, 'schema:datePublished');
  const partition = subjectPartition(book.id);

  const preferred = await propose(book.id, 'en');
  const competing = await propose(book.id, 'fr');
  for (const candidate of [preferred.candidate, competing.candidate]) {
    const key = randomUUID();
    await decideCandidate(pool, {
      subject: book.id,
      actor: await actor(),
      idempotencyKey: key,
      digest: digest(key),
      authorization: await authorization('context:accept'),
      deadline: deadline(),
      candidate,
      context: GLOBAL_CONTEXT,
      decision: 'accept',
      expectedHead: null,
    });
  }
  const adoptKey = randomUUID();
  await adoptCandidates(pool, {
    subject: book.id,
    actor: await actor(),
    idempotencyKey: adoptKey,
    digest: digest(adoptKey),
    authorization: await authorization('context:adopt'),
    deadline: deadline(),
    context: GLOBAL_CONTEXT,
    property: 'schema:inLanguage',
    mode: 'replace',
    selection: [
      { candidate: preferred.candidate, rank: 'preferred' },
      { candidate: competing.candidate, rank: 'normal' },
    ],
    expectedHead: null,
    release: { digest: bundledDigest, release: bundledRelease },
  });

  const neighbor = await created({
    type: 'schema:Book',
    labels: { en: 'Heavily edited neighbor' },
    statements: { 'schema:inLanguage': [statement('schema:inLanguage', 'de')] },
  });
  const neighborPartition = subjectPartition(neighbor.id);
  for (const language of ['it', 'pt', 'nl']) {
    const proposed = await propose(neighbor.id, language);
    const key = randomUUID();
    await moderateStatement(pool, {
      actor: await actor(),
      subject: neighbor.id,
      candidate: proposed.candidate,
      action: 'hide',
      body: { reason: 'obsolete draft' },
      idempotencyKey: key,
      digest: digest(key),
      authorization: await authorization('moderation:hide'),
      deadline: deadline(),
    });
  }

  const snapshot = await source.read(partition, [book.id]);
  expect(snapshot.subjects[0]!.labels).toEqual(
    expect.arrayContaining([
      { language: 'en', value: 'Current heads' },
      { language: 'ja', value: '現在の見出し' },
    ]),
  );
  expect(snapshot.subjects[0]!.statements).toEqual(
    expect.arrayContaining([
      { property: 'schema:inLanguage', value: 'en', facet: { kind: 'code' } },
      { property: 'schema:inLanguage', value: 'fr', facet: { kind: 'code' } },
      {
        property: 'schema:datePublished',
        value: '+1905-01-01T00:00:00Z',
        facet: { kind: 'time', year: 1905, month: 1, day: 1 },
      },
    ]),
  );
  expect(snapshot.subjects[0]!.statements.filter((row) => row.property === 'schema:inLanguage')).toHaveLength(2);
  expect(JSON.stringify(snapshot)).not.toContain(compactId);

  if (neighborPartition === partition) {
    const mixed = await source.read(partition, [book.id, neighbor.id]);
    expect(mixed.subjects.find((row) => row.id === book.id)!.statements).toEqual(snapshot.subjects[0]!.statements);
    expect(mixed.subjects.find((row) => row.id === neighbor.id)!.statements).toEqual([
      { property: 'schema:inLanguage', value: 'de', facet: { kind: 'code' } },
    ]);
  }

  const retracted = await admin.query(
    `SELECT route, slot_id, recorded_transaction_id FROM semantic.fact
     WHERE route=$1 AND subject_id=$2 AND statement_id=$3::uuid AND operation='assert'`,
    [routeOf(book.id), book.id, dateId],
  );
  const dateFact = retracted.rows[0]!;
  await admin.query(
    `INSERT INTO semantic.fact (route, subject_id, slot_id, log_seq, operation, kind, property, statement_id, body, recorded_transaction_id, relation)
     VALUES ($1,$2,$3,3,'retract','statement',$4,$5,'{}'::jsonb,$6,false)`,
    [dateFact.route, book.id, dateFact.slot_id, 'schema:datePublished', dateId, dateFact.recorded_transaction_id],
  );
  const afterRetract = (await source.read(partition, [book.id])).subjects[0]!;
  expect(afterRetract.statements.map((row) => row.property).sort()).toEqual(['schema:inLanguage', 'schema:inLanguage']);

  await admin.query(
    `INSERT INTO semantic.fact (route, subject_id, slot_id, log_seq, operation, kind, property, statement_id, body, recorded_transaction_id, release, relation)
     VALUES ($1,$2,$3,2,'assert','statement',$4,$5,$6,$7,$8,false)`,
    [
      dateFact.route,
      book.id,
      dateFact.slot_id,
      'schema:datePublished',
      dateId,
      {
        rank: 'normal',
        value: { type: 'value', content: { time: '+1905-01-01T00:00:00Z', precision: 11, calendarmodel: GREGORIAN } },
      },
      dateFact.recorded_transaction_id,
      bundledDigest,
    ],
  );
  const afterLate = (await source.read(partition, [book.id])).subjects[0]!;
  expect(afterLate.statements.some((row) => row.property === 'schema:datePublished')).toBe(false);
});

test('lifecycle, disclosure, qualifier change and unreadied coverage stay distinct', async () => {
  const book = await created({
    type: 'schema:Book',
    labels: { en: 'Coverage book' },
    statements: {
      'schema:inLanguage': [statement('schema:inLanguage', 'ja')],
      'schema:datePublished': [
        statement('schema:datePublished', { time: '+1905-01-01T00:00:00Z', precision: 11, calendarmodel: GREGORIAN }),
      ],
    },
  });
  const languageId = statementId(book, 'schema:inLanguage');
  const dateId = statementId(book, 'schema:datePublished');
  const partition = subjectPartition(book.id);
  const route = routeOf(book.id)!;
  const empty = await created({ type: 'schema:Book', labels: { en: 'Ready empty' } });

  const languageFact = (
    await admin.query(
      `SELECT slot_id, recorded_transaction_id, log_seq FROM semantic.fact
       WHERE route=$1 AND subject_id=$2 AND statement_id=$3::uuid AND operation='assert' ORDER BY log_seq DESC LIMIT 1`,
      [route, book.id, languageId],
    )
  ).rows[0]!;
  await admin.query(
    `INSERT INTO semantic.fact (route, subject_id, slot_id, log_seq, operation, kind, property, statement_id, body, recorded_transaction_id, release, relation)
     VALUES ($1,$2,$3,$4,'assert','statement','schema:inLanguage',$5,$6,$7,$8,false)`,
    [
      route,
      book.id,
      languageFact.slot_id,
      languageFact.log_seq + 1,
      languageId,
      {
        rank: 'normal',
        value: { type: 'value', content: 'ja' },
        qualifiers: [{ property: 'wdt:P1932', value: { type: 'value', content: '日本語' } }],
      },
      languageFact.recorded_transaction_id,
      bundledDigest,
    ],
  );
  const qualified = (await source.read(partition, [book.id])).subjects[0]!;
  expect(qualified.statements.find((row) => row.property === 'schema:inLanguage')).toEqual({
    property: 'schema:inLanguage',
    value: 'ja',
    facet: { kind: 'code' },
    qualifiers: [{ property: 'wdt:P1932', value: '日本語' }],
  });

  const changedFact = (
    await admin.query(
      `SELECT slot_id, recorded_transaction_id, log_seq FROM semantic.fact
       WHERE route=$1 AND subject_id=$2 AND statement_id=$3::uuid AND operation='assert' ORDER BY log_seq DESC LIMIT 1`,
      [route, book.id, languageId],
    )
  ).rows[0]!;
  await admin.query(
    `INSERT INTO semantic.fact (route, subject_id, slot_id, log_seq, operation, kind, property, statement_id, body, recorded_transaction_id, release, relation)
     VALUES ($1,$2,$3,$4,'assert','statement','schema:inLanguage',$5,$6,$7,$8,false)`,
    [
      route,
      book.id,
      changedFact.slot_id,
      changedFact.log_seq + 1,
      languageId,
      {
        rank: 'normal',
        value: { type: 'value', content: 'ja' },
        qualifiers: [{ property: 'wdt:P1932', value: { type: 'value', content: '改訂' } }],
      },
      changedFact.recorded_transaction_id,
      bundledDigest,
    ],
  );
  const changed = (await source.read(partition, [book.id])).subjects[0]!;
  expect(changed.statements.find((row) => row.property === 'schema:inLanguage')?.qualifiers).toEqual([
    { property: 'wdt:P1932', value: '改訂' },
  ]);

  await admin.query(
    `INSERT INTO semantic.record_lifecycle
       (route, subject_id, candidate_id, revision, state, deletion_generation, deletion_transaction_id, deleted_at, purge_after)
     SELECT $1,$2,$3,1,'deleted',$4,$5, now(), now() + interval '720 hours'`,
    [route, book.id, dateId, randomUUID(), randomUUID()],
  );
  const afterDelete = (await source.read(partition, [book.id])).subjects[0]!;
  expect(afterDelete.statements.some((row) => row.property === 'schema:datePublished')).toBe(false);
  expect(afterDelete.statements.some((row) => row.property === 'schema:inLanguage')).toBe(true);

  const contextId = newId(route);
  const revision = (
    await admin.query(
      `SELECT revision FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1`,
      [route, book.id],
    )
  ).rows[0]!.revision as number;
  await admin.query(
    `INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
     VALUES ($1,$2,$3,$4,1,'suppress','[]'::jsonb,$5)`,
    [route, book.id, changedFact.slot_id, contextId, revision],
  );
  expect(
    (await source.read(partition, [book.id])).subjects[0]!.statements.some(
      (row) => row.property === 'schema:inLanguage',
    ),
  ).toBe(true);

  await admin.query(
    `INSERT INTO semantic.statement_disclosure
       (route, subject_id, candidate_id, target_id, property, disclosed, source_order_key, target_order_key)
     VALUES ($1,$2,$3,$2,'schema:inLanguage', false, $4, $4)`,
    [route, book.id, languageId, labelOrderKey({ en: 'Coverage book' })],
  );
  const withheld = (await source.read(partition, [book.id])).subjects[0]!;
  expect(withheld.statements.some((row) => row.property === 'schema:inLanguage')).toBe(false);

  const readyEmpty = await source.read(subjectPartition(empty.id), [empty.id]);
  expect(readyEmpty.subjects[0]!.statements).toEqual([]);
  expect(readyEmpty.subjects[0]!.labels).toEqual([{ language: 'en', value: 'Ready empty' }]);

  await admin.query(
    `UPDATE semantic.search_selection_state
        SET ready=false, phase='adoptions',
            after_slot='ffffffff-ffff-4fff-8000-ffffffffffff', after_seq=2147483647
      WHERE route=$1 AND subject_id=$2`,
    [route, book.id],
  );
  await expect(source.read(partition, [book.id])).rejects.toBeInstanceOf(CommandUnavailableError);
  const state = await admin.query(
    `SELECT ready FROM semantic.search_selection_state WHERE route=$1 AND subject_id=$2`,
    [route, book.id],
  );
  expect(state.rows[0]!.ready).toBe(true);
});
