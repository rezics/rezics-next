import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../src/database/pool.ts';
import { createAccess } from '../src/access/index.ts';
import { accessCheck, AuthenticationError, type AccountActor, type ActionCatalogue } from '../src/request/access.ts';
import { createSubject, SubjectAccessDeniedError } from '../src/semantic/subject.ts';
import { IdempotencyConflictError } from '../src/command/command.ts';
import { requestDigest } from '../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = createPool(url);
const issuer = 'https://auth.example.test';
const audience = 'https://api.example.test';
const keys = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'replay', alg: 'ES256' };
const actions: ActionCatalogue = new Map([
  ['subject:create', { anonymous: false }],
  ['account:read', { anonymous: false }],
]);
const access = createAccess({
  actions,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks`,
    fetch: async () => Response.json({ keys: [jwk] }),
  },
});
const actorId = newId(0xc100);
const principalId = newId(0xc110);
const assignmentId = newId(0xc110);
const item = { labels: { en: 'receipt secret' }, descriptions: {}, aliases: {}, statements: {} };
let trace: string[] = [];
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<typeof query>) => {
    const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string }).text ?? '');
    if (sql.includes('AS allowed')) trace.push('authorize');
    if (sql.includes('FROM core.receipt')) trace.push('receipt');
    if (sql.includes('FROM access.account') && sql.includes('content_preferences')) trace.push('actor');
    return query(...args);
  }) as typeof client.query;
});
beforeAll(async () => {
  for (const id of [actorId, principalId])
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$3)`,
      [routeOf(id), id, Bun.randomUUIDv7()],
    );
  await admin.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [routeOf(principalId), principalId, assignmentId, actorId, Bun.randomUUIDv7()],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function identity(scope = 'subject:create', clientId = 'web', requestedBy: string | null = null) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    client_id: clientId,
    scope,
    authn_epoch: 1,
    auth_time: now,
    amr: ['pwd'],
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'replay', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(actorId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
  return access.authenticate(token, { pool, deadline: Date.now() + 2000 });
}
async function fixture(route: number, delegated = false) {
  const target = { route, id: newId(route) };
  const key = Bun.randomUUIDv7();
  const requestedBy = delegated ? `urn:rezics:request:${principalId}:${assignmentId}` : null;
  for (const subject of delegated ? [actorId, principalId] : [actorId])
    await admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,'subject:create','(,)',$4)`,
      [route, target.id, subject, Bun.randomUUIDv7()],
    );
  const run = async (actor: AccountActor, action = 'subject:create') => {
    const authorize = await accessCheck(access, actor, action, target, { pool, deadline: Date.now() + 2000 });
    return createSubject(pool, {
      actor,
      target,
      idempotencyKey: key,
      digest: requestDigest('subject.create', actor, item),
      item,
      authorize,
    });
  };
  const snapshot = async () =>
    (
      await admin.query(
        `SELECT position::text,
      (SELECT jsonb_agg(r ORDER BY idempotency_key) FROM core.receipt r WHERE partition_no=$1) AS receipts,
      (SELECT jsonb_agg(o ORDER BY position,event_seq) FROM core.outbox o WHERE partition_no=$1) AS events,
      (SELECT count(*)::int FROM semantic.subject WHERE route=$2) AS effects
     FROM core.partition WHERE partition_no=$1`,
        [partitionOf(route), route],
      )
    ).rows[0];
  return { target, run, snapshot, requestedBy };
}

test('positive matching replay authorizes before receipt SQL, authenticates once and keeps one effect', async () => {
  const f = await fixture(0xc200);
  const first = await f.run(await identity());
  const before = await f.snapshot();
  trace = [];
  const second = await f.run(await identity());
  expect(second).toEqual({ ...first, replayed: true });
  expect(trace.filter((step) => step === 'actor')).toHaveLength(1);
  expect(trace.filter((step) => step === 'authorize')).toHaveLength(1);
  expect(trace.indexOf('authorize')).toBeLessThan(trace.indexOf('receipt'));
  expect(await f.snapshot()).toEqual(before);
  expect(before.effects).toBe(1);
});

for (const revocation of ['actor grant', 'token scope', 'principal grant', 'unknown action'])
  test(`matching replay denies after ${revocation} revocation without reading cached response`, async () => {
    const delegated = revocation === 'principal grant';
    const f = await fixture(
      0xc210 + ['actor grant', 'token scope', 'principal grant', 'unknown action'].indexOf(revocation) * 16,
      delegated,
    );
    await f.run(await identity('subject:create', 'web', f.requestedBy));
    const before = await f.snapshot();
    if (revocation.endsWith('grant'))
      await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        f.target.route,
        f.target.id,
        delegated ? principalId : actorId,
      ]);
    const actor = await identity(
      revocation === 'token scope' ? 'account:read' : 'subject:create',
      'web',
      f.requestedBy,
    );
    trace = [];
    await expect(
      f.run(actor, revocation === 'unknown action' ? 'unknown:create' : 'subject:create'),
    ).rejects.toBeInstanceOf(SubjectAccessDeniedError);
    expect(trace).not.toContain('receipt');
    expect(await f.snapshot()).toEqual(before);
  });

test('verified client or principal change conflicts with the original receipt digest; forged identity denies', async () => {
  const f = await fixture(0xc260, true);
  const actor = await identity('subject:create', 'web', f.requestedBy);
  await f.run(actor);
  const before = await f.snapshot();
  await expect(f.run(await identity('subject:create', 'other', f.requestedBy))).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  await expect(f.run(await identity())).rejects.toBeInstanceOf(IdempotencyConflictError);
  await expect(f.run({ ...actor, clientId: 'other' })).rejects.toBeInstanceOf(SubjectAccessDeniedError);
  await expect(f.run({ ...actor, requestedBy: null })).rejects.toBeInstanceOf(SubjectAccessDeniedError);
  expect(await f.snapshot()).toEqual(before);
});

test('state and epoch authentication remain mandatory on a replay', async () => {
  const f = await fixture(0xc270);
  await f.run(await identity());
  const before = await f.snapshot();
  await admin.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    routeOf(actorId),
    actorId,
  ]);
  await expect(identity()).rejects.toBeInstanceOf(AuthenticationError);
  expect(await f.snapshot()).toEqual(before);
});
