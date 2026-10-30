import { afterAll, beforeAll, expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { createHash, randomUUID } from 'node:crypto';
import { IdempotencyConflictError } from '../src/command/command.ts';
import { createPool } from '../src/database/pool.ts';
import { ProblemError, problemResponse } from '../src/http/problem.ts';
import { idempotencyKeyOf, IDEMPOTENCY_HEADER, requestDigest } from '../src/http/request.ts';
import type { AccountActor } from '../src/request/access.ts';
import { anchorRoute, routeOf } from '../src/route/route.ts';
import { createSubject, readSubject, subjectTarget } from '../src/semantic/subject.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../src/semantic/definitions.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());
beforeAll(() => bootstrapRelease(pool, bundledRelease));

const routeKey = new Uint8Array(32).fill(11);
const actor: AccountActor = {
  kind: 'account',
  accountId: randomUUID(),
  clientId: 'web',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
const book = { type: 'schema:Book', labels: { en: 'Botchan' } };
const allow = async () => true;

test('a create lands where its account and idempotency key anchor it, under a new id each attempt', async () => {
  const key = randomUUID();
  const first = subjectTarget(routeKey, actor.accountId, key);
  const second = subjectTarget(routeKey, actor.accountId, key);
  expect(first.route).toBe(anchorRoute(routeKey, `${actor.accountId}\nsubject.create\n${key}`));
  expect(second.route).toBe(first.route);
  expect(routeOf(first.id)).toBe(first.route);
  expect(second.id).not.toBe(first.id);
  expect(subjectTarget(routeKey, randomUUID(), key).route).not.toBe(first.route);

  const options = {
    actor,
    idempotencyKey: key,
    digest: new Uint8Array(32).fill(1),
    item: book,
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: allow,
  };
  const created = await createSubject(pool, { ...options, target: first });
  expect(created.subject.id).toBe(first.id);
  const replayed = await createSubject(pool, { ...options, target: second });
  expect(replayed).toMatchObject({ replayed: true, subject: { id: first.id } });

  const elsewhere = { route: first.route ^ 1, id: first.id };
  await expect(createSubject(pool, { ...options, idempotencyKey: randomUUID(), target: elsewhere })).rejects.toThrow(
    RangeError,
  );
});

test('a read checks access inside its transaction, and a refused read is no subject', async () => {
  const key = randomUUID();
  const target = subjectTarget(routeKey, actor.accountId, key);
  const digest = new Uint8Array(32).fill(2);
  await createSubject(pool, {
    actor,
    target,
    idempotencyKey: key,
    digest,
    item: book,
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: allow,
  });

  const seen: string[] = [];
  const found = await readSubject(
    pool,
    target.id,
    async (client) => {
      const { rows } = await client.query<{ isolation: string }>(
        "SELECT current_setting('transaction_isolation') AS isolation",
      );
      seen.push(rows[0]!.isolation);
      return true;
    },
    undefined,
    routeKey,
  );
  expect(found?.subject.labels).toEqual(book.labels);
  expect(seen).toEqual(['repeatable read']);

  expect(await readSubject(pool, target.id, async () => false, undefined, routeKey)).toBeNull();
  let asked = 0;
  const count = async () => {
    asked++;
    return true;
  };
  expect(
    await readSubject(pool, subjectTarget(routeKey, actor.accountId, randomUUID()).id, count, undefined, routeKey),
  ).toBeNull();
  expect(await readSubject(pool, 'not-an-id', count, undefined, routeKey)).toBeNull();
  expect(asked).toBe(0);
});

test('an idempotency key is one structured field string of 1 to 255 characters', () => {
  expect(IDEMPOTENCY_HEADER).toBe('idempotency-key');
  expect(idempotencyKeyOf('"8e03978e-40d5-43e8-bc93-6894a57f9324"')).toBe('8e03978e-40d5-43e8-bc93-6894a57f9324');
  expect(idempotencyKeyOf(' "a \\"quoted\\" key" ')).toBe('a "quoted" key');
  expect(idempotencyKeyOf('"key";scope=1')).toBe('key');
  expect(idempotencyKeyOf(`"${'k'.repeat(255)}"`)).toHaveLength(255);
  for (const header of [
    null,
    undefined,
    '',
    'key',
    '""',
    `"${'k'.repeat(256)}"`,
    '"kéy"',
    '"a", "b"',
    '?1',
    ':aGk=:',
  ]) {
    let refusal: unknown;
    try {
      idempotencyKeyOf(header);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProblemError);
    expect(refusal).toMatchObject({ code: 'invalid_request' });
  }
});

test('the request digest covers the operation, the client, the delegate and the canonical body', () => {
  const digest = requestDigest('subject.create', actor, { labels: { en: 'A', ja: 'B' }, aliases: {} });
  const expected = createHash('sha256')
    .update(
      canonicalize({
        operation: 'subject.create',
        client_id: 'web',
        requested_by: null,
        body: { aliases: {}, labels: { ja: 'B', en: 'A' } },
      })!,
    )
    .digest();
  expect(Buffer.from(digest).equals(expected)).toBe(true);
  expect(digest).toHaveLength(32);
  const same = requestDigest('subject.create', actor, { aliases: {}, labels: { ja: 'B', en: 'A' } });
  expect(Buffer.from(same).equals(expected)).toBe(true);
  const differs = [
    requestDigest('subject.update', actor, { labels: { en: 'A', ja: 'B' }, aliases: {} }),
    requestDigest('subject.create', { ...actor, clientId: 'cli' }, { labels: { en: 'A', ja: 'B' }, aliases: {} }),
    requestDigest('subject.create', { ...actor, requestedBy: 'agent' }, { labels: { en: 'A', ja: 'B' }, aliases: {} }),
    requestDigest('subject.create', actor, { labels: { en: 'A' }, aliases: {} }),
  ];
  for (const other of differs) expect(Buffer.from(other).equals(expected)).toBe(false);
});

test('a key reused with another request is a 422 problem that applied nothing', async () => {
  const response = problemResponse(new IdempotencyConflictError(3), { method: 'POST', id: 'request-1' });
  expect(response.status).toBe(422);
  expect(response.headers.get('content-type')).toStartWith('application/problem+json');
  expect(await response.json()).toEqual({
    type: 'https://rezics.com/problems/idempotency_conflict',
    title: 'Idempotency Key Reused',
    status: 422,
    code: 'idempotency_conflict',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'request-1',
  });
});
