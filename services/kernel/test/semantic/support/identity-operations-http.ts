import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { HttpResponse } from '../../../../../specs/semantic-driver.ts';
import { newId, routeOf } from '../../../src/route/route.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../outcome-driver.ts';

export const quotedKey = () => `"${randomUUID()}"`;

/** The shared native driver owns Auth, Access, its one kernel DB and mounted production routes. */
export async function withIdentityHttp(work: (driver: SemanticOutcomeDriver) => Promise<void>) {
  const driver = await createSemanticDriver();
  try {
    await work(driver);
  } finally {
    await driver.close();
  }
}

export async function createOriginal(d: SemanticOutcomeDriver, label = 'Duplicate book') {
  const created = await d.request(
    'editor',
    'POST',
    '/v1/subjects',
    { type: 'schema:Book', labels: { en: label } },
    { 'Idempotency-Key': quotedKey() },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const subject = created.body.subject as { id: string; revision: number };
  expect(subject.revision).toBe(1);
  return subject.id;
}

export const merge = (d: SemanticOutcomeDriver, subjects: string[], key = quotedKey()) =>
  d.request('acceptor', 'POST', '/v1/subjects:merge', { subjects }, { 'Idempotency-Key': key });

export function admitted(answer: HttpResponse) {
  // This is deliberately the first identity assertion, before any missing producer load.
  expect(answer.status, `native POST /v1/subjects:merge: ${JSON.stringify(answer.body)}`).toBe(202);
  expect(answer.body).toEqual({ operation: { id: expect.any(String) } });
  const { id } = answer.body.operation as { id: string };
  expect(id.length).toBeGreaterThan(0);
  const location = `/v1/subjectIdentityOperations/${id}`;
  expect(answer.headers.get('location')).toBe(location);
  return { id, location };
}

export function concealed(answer: HttpResponse) {
  expect(answer.status).toBe(404);
  const { request_id: _, ...problem } = answer.body;
  expect(problem).toEqual({
    type: 'https://rezics.com/problems/not_found',
    title: 'Not Found',
    status: 404,
    code: 'not_found',
    retryable: false,
    effect_status: 'not_applicable',
  });
  return problem;
}

/** Actual tables only. No invented identity schema or empty-job readiness certificate.
 * Include future native identity tables when installed; absence remains an unbound matrix cell.
 * Projection checkpoints are deliberately excluded: they are not identity publication.
 */
export async function effectSnapshot(d: SemanticOutcomeDriver) {
  // Stop only this driver's owned ordinary link relay so its unrelated commands cannot
  // race the before/after snapshot. This does not control or acknowledge identity work.
  await d.projection('paused');
  const pool = d.fixtures.pool;
  const tables = await pool.query<{ schema: string; name: string }>(`SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND (
      (n.nspname='core' AND c.relname IN ('partition','receipt','outbox')) OR
      (n.nspname='semantic' AND c.relname IN ('subject','revision','redirect','merge_member')) OR
      (n.nspname='library' AND c.relname IN ('follow','entry','collection_member')) OR
      (n.nspname IN ('semantic','search','library') AND c.relname LIKE '%identity%'))
    ORDER BY n.nspname,c.relname`);
  const snapshot: Record<string, unknown> = {};
  for (const { schema, name } of tables.rows) {
    const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
    const result =
      await pool.query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'null')) AS hash
      FROM ${quote(schema)}.${quote(name)} t`);
    snapshot[`${schema}.${name}`] = result.rows[0].hash;
  }
  return snapshot;
}

export async function personalSnapshot(d: SemanticOutcomeDriver) {
  return (
    await d.fixtures.pool.query(`SELECT * FROM (
    SELECT 'follow' AS kind,to_jsonb(f) AS row FROM library.follow f
    UNION ALL SELECT 'entry',to_jsonb(e) FROM library.entry e
    UNION ALL SELECT 'occurrence',to_jsonb(m) FROM library.collection_member m
    ) refs ORDER BY kind,row::text`)
  ).rows;
}

/** Same migrated native population as support/identity-epoch.ts, in the SHARED driver's DB.
 * This seeds historical data, never bootstrap readiness, an ACK or a successful adapter.
 */
export async function seedGroup(d: SemanticOutcomeDriver, root: string, members: number) {
  const route = routeOf(root)!;
  const ids = Array.from({ length: members }, () => newId(route)).sort();
  const tx = await d.fixtures.pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query(
      `INSERT INTO semantic.subject
      (route,subject_id,type,recorded_transaction_id,current_facts,current_release)
      SELECT $1,id,'schema:Book',$3,0,$4 FROM unnest($2::uuid[]) id`,
      [route, ids, randomUUID(), bundledDigest],
    );
    await tx.query(
      `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
      SELECT $1,id,v.revision,v.kind,$3,$4 FROM unnest($2::uuid[]) id
      CROSS JOIN (VALUES (1,'create'),(2,'merge')) v(revision,kind)`,
      [route, ids, bundledDigest, randomUUID()],
    );
    await tx.query(
      `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
      SELECT $1,id,1,$3,$4 FROM unnest($2::uuid[]) id`,
      [route, ids, root, randomUUID()],
    );
    await tx.query(
      `INSERT INTO semantic.merge_member(route,subject_id,member_id,phase,cursor)
      SELECT $1,$3,id,'done','[]'::jsonb FROM unnest($2::uuid[]) id`,
      [route, ids, root],
    );
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  return ids;
}

/** Revoke through native Accounts grant administration, using the driver's actual governor. */
export async function revokeMerge(d: SemanticOutcomeDriver) {
  const governor = await d.fixtures.person('governor');
  const acceptor = await d.fixtures.person('acceptor');
  const result = await d.fixtures.send(
    governor,
    'POST',
    '/v1/grants:revoke',
    {
      resource: { route: 0, id: d.globalContext },
      subject: { kind: 'account', id: acceptor.accountId },
      actions: ['subject:merge'],
      valid: '(,)',
    },
    { 'Idempotency-Key': quotedKey() },
  );
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

export async function savePersonalOriginal(d: SemanticOutcomeDriver, original: string) {
  const governor = await d.fixtures.person('governor');
  const opened = await d.fixtures.send(governor, 'POST', '/v1/platform/exposure/personal_library:open', undefined, {
    'Idempotency-Key': quotedKey(),
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const follow = await d.request('editor', 'PUT', `/v1/follows/${original}`, undefined, {
    'Idempotency-Key': quotedKey(),
  });
  expect(follow.status, JSON.stringify(follow.body)).toBe(200);
  const entry = await d.request(
    'editor',
    'PUT',
    `/v1/libraryEntries/${original}`,
    { state: 'planned' },
    { 'Idempotency-Key': quotedKey() },
  );
  expect(entry.status, JSON.stringify(entry.body)).toBe(201);
  const collection = await d.request(
    'editor',
    'POST',
    '/v1/collections',
    { title: 'Original occurrences', visibility: 'private' },
    { 'Idempotency-Key': quotedKey() },
  );
  expect(collection.status, JSON.stringify(collection.body)).toBe(201);
  const { id } = collection.body.collection as { id: string };
  for (const note of ['First original occurrence', 'Second original occurrence']) {
    const occurrence = await d.request(
      'editor',
      'POST',
      `/v1/collections/${id}/members`,
      { subjectId: original, note },
      { 'Idempotency-Key': quotedKey() },
    );
    expect(occurrence.status, JSON.stringify(occurrence.body)).toBe(201);
  }
  const stored = await personalSnapshot(d);
  expect(stored.filter((r) => r.kind === 'follow')).toHaveLength(1);
  expect(stored.filter((r) => r.kind === 'entry')).toHaveLength(1);
  expect(stored.filter((r) => r.kind === 'occurrence')).toHaveLength(2);
  return stored;
}
