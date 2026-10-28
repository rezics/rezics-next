import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../../src/access/index.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createKernel } from '../../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import * as semantic from '../../../src/semantic/index.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { linkProjection } from '../../../src/semantic/links.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { createRealAccess } from '../real-access.ts';

// Shared native fixtures; each test file creates and closes its own instance.
export async function createDeletionFixture() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(url);
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  const accounts = { owner: newId(21000), editor: newId(21001), stranger: newId(21002), platform: newId(21003) };
  let now = new Date();
  const clock = () => new Date(now);
  // Refresh JWTs at the domain clock when moving beyond the restoration window.
  // Shared real-Access fixtures create accounts/grants; the native Access below validates these tokens.
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'semantic-deletion', alg: 'ES256' };
  const auth = {
    issuer: 'https://auth.example.test',
    audience: 'https://api.rezics.test',
    jwksUrl: 'https://auth.example.test/jwks',
    fetch: async () => Response.json({ keys: [jwk] }),
  };
  async function bearer(account: string, scopes: string[]) {
    const at = Math.floor(clock().getTime() / 1000);
    return new SignJWT({ client_id: 'web', scope: scopes.join(' '), authn_epoch: 1, auth_time: at, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(auth.issuer)
      .setAudience(auth.audience)
      .setSubject(account)
      .setIssuedAt(at)
      .setExpirationTime(at + 300)
      .sign(signing.privateKey);
  }

  const actions = [
    'definitions:publish',
    'definitions:activate',
    'subject:create',
    'subject:read',
    'statement:propose',
    'context:create',
    'context:read',
    'context:accept',
    'context:adopt',
    'statement:delete',
    'statement:restore',
    'account:delete',
    'access:grant',
    'context:delete',
    'context:restore',
    'semantic:purge',
    'semantic:hold',
    'moderation:takedown',
  ];
  const real = await createRealAccess(admin, accounts, actions);
  const routeKey = new Uint8Array(32).fill(71);
  const kernel = createKernel({
    pool,
    access: (config) => createAccess({ ...config, auth }),
    clock,
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) },
    writeRate: createWriteRateLimiter({
      secret: 'semantic-deletion-native-test-rate-secret',
      overrides: '{"new-account":{"write":{"maximum":10000,"seconds":60}}}',
    }),
  });
  type Persona = keyof typeof accounts;
  async function call(method: string, path: string, persona?: Persona, body?: unknown, key = `"${randomUUID()}"`) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          ...(persona ? { authorization: `Bearer ${await bearer(accounts[persona], actions)}` } : {}),
          'idempotency-key': key,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  function status(answer: { status: number; body: unknown }, expected: number) {
    expect(answer.status, JSON.stringify(answer.body)).toBe(expected);
  }
  const snak = (property: string, content: unknown) => ({
    property: { id: property },
    value: { type: 'value', content },
  });
  const cited = (property: string, content: unknown) => ({
    ...snak(property, content),
    references: [{ parts: [snak('schema:url', 'https://example.test/evidence')] }],
  });
  async function person(label = 'Communal catalogue person') {
    const result = await call('POST', '/v1/subjects', 'owner', { type: 'schema:Person', labels: { en: label } });
    status(result, 201);
    return result.body.subject.id as string;
  }
  async function proposal(subject: string, payload = `https://example.test/personal/${randomUUID()}`) {
    const result = await call('POST', `/v1/subjects/${subject}/candidates`, 'owner', {
      statement: cited('schema:url', payload),
    });
    status(result, 201);
    return { subject, candidate: result.body.candidate as string, payload };
  }
  const path = (record: { subject: string; candidate: string }) =>
    `/v1/subjects/${record.subject}/candidates/${record.candidate}`;
  async function accept(record: { subject: string; candidate: string }) {
    status(
      await call('POST', `${path(record)}:accept`, 'editor', { context: GLOBAL_CONTEXT, expected_head: null }),
      200,
    );
  }
  async function adopt(record: { subject: string; candidate: string }, expected: number | null) {
    const result = await call('POST', `/v1/subjects/${record.subject}:adopt`, 'editor', {
      context: GLOBAL_CONTEXT,
      property: 'schema:url',
      mode: 'replace',
      selection: [{ candidate: record.candidate, rank: 'normal' }],
      expected_head: expected,
    });
    status(result, 200);
    return result.body.adoption.head as number;
  }
  async function current(subject: string) {
    const result = await call('GET', `/v1/subjects/${subject}`, 'owner');
    status(result, 200);
    return result.body.subject;
  }
  async function revisions(subject: string) {
    return (
      await admin.query(
        'SELECT revision, kind FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision',
        [routeOf(subject), subject],
      )
    ).rows;
  }
  async function caughtUp(subject: string) {
    const projection = linkProjection(pool);
    for (let i = 0; i < 200; i++) {
      const result = await projection.run(partitionOf(routeOf(subject)!));
      if (result.status !== 'busy' && result.envelopes === 0) return;
      await Bun.sleep(5);
    }
    throw new Error('Link projection did not drain');
  }
  // Required native retention adapter, not an HTTP purge permission or a simulated worker.
  // The import above exists on the base. Route outcomes fail before this unimplemented adapter is reached.
  type RetentionPage = { examined: number; purged: number; checkpoint: string | null; done: boolean };
  function retention() {
    const factory = Reflect.get(semantic, 'semanticRetention');
    expect(typeof factory, 'Semantic must expose its native durable retention adapter').toBe('function');
    return (
      factory as (
        pool: ReturnType<typeof createPool>,
        options: { clock: () => Date },
      ) => {
        step(input: { partition: number; limit: number; key: string }): Promise<RetentionPage>;
      }
    )(pool, { clock });
  }
  async function drain(subject: string) {
    const job = retention();
    for (let page = 0; page < 100; page++) {
      const result = await job.step({ partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() });
      expect(result.examined).toBeLessThanOrEqual(2);
      if (result.done) return;
    }
    throw new Error('Retention did not exhaust this small fixture');
  }
  async function absentPayload(payload: string) {
    // Evidence reads only; no SQL fixture writes or invented purge progress.
    const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='semantic'")).rows;
    for (const { tablename } of tables) {
      const result = await admin.query(
        `SELECT count(*)::int AS n FROM semantic."${tablename}" AS r WHERE strpos(to_jsonb(r)::text,$1)>0`,
        [payload],
      );
      expect(result.rows, tablename).toEqual([{ n: 0 }]);
    }
    for (const table of ['core.outbox', 'core.receipt']) {
      const result = await admin.query(
        `SELECT count(*)::int AS n FROM ${table} AS r WHERE strpos(to_jsonb(r)::text,$1)>0`,
        [payload],
      );
      expect(result.rows, table).toEqual([{ n: 0 }]);
    }
  }
  async function setup() {
    await bootstrapRelease(pool, bundledRelease);
    for (const action of ['subject:create', 'statement:propose', 'context:create'])
      await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', action);
    for (const action of ['context:accept', 'context:adopt'])
      await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    for (const action of ['moderation:takedown', 'semantic:purge', 'semantic:hold'])
      await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'platform', action);
  }
  async function close() {
    await Promise.all([pool.end(), admin.end()]);
  }

  return {
    pool,
    admin,
    accounts,
    clock,
    auth,
    bearer,
    actions,
    real,
    routeKey,
    call,
    status,
    snak,
    cited,
    person,
    proposal,
    path,
    accept,
    adopt,
    current,
    revisions,
    caughtUp,
    retention,
    drain,
    absentPayload,
    setup,
    close,
    setNow(value: Date) {
      now = value;
    },
  };
}

export async function createGrowthDeletionFixture() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const account = newId(22000);
  let now = new Date();
  const clock = () => new Date(now);
  // Refresh JWTs at the domain clock when moving beyond the restoration window.
  // Shared real-Access fixtures create accounts/grants; the native Access below validates these tokens.
  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'semantic-deletion', alg: 'ES256' };
  const auth = {
    issuer: 'https://auth.example.test',
    audience: 'https://api.rezics.test',
    jwksUrl: 'https://auth.example.test/jwks',
    fetch: async () => Response.json({ keys: [jwk] }),
  };
  async function bearer(account: string, scopes: string[]) {
    const at = Math.floor(clock().getTime() / 1000);
    return new SignJWT({ client_id: 'web', scope: scopes.join(' '), authn_epoch: 1, auth_time: at, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(auth.issuer)
      .setAudience(auth.audience)
      .setSubject(account)
      .setIssuedAt(at)
      .setExpirationTime(at + 300)
      .sign(signing.privateKey);
  }

  const snak = (content: string) => ({
    property: { id: 'schema:url' },
    value: { type: 'value', content },
    references: [
      {
        parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } }],
      },
    ],
  });
  async function call(method: string, path: string, body?: unknown) {
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await bearer(account, ['subject:create', 'subject:read', 'statement:propose', 'statement:delete', 'statement:restore', 'context:accept', 'context:adopt'])}`,
          'idempotency-key': `"${randomUUID()}"`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  function status(result: { status: number; body: unknown }, expected: number) {
    expect(result.status, JSON.stringify(result.body)).toBe(expected);
  }
  async function person() {
    const result = await call('POST', '/v1/subjects', { type: 'schema:Person', labels: { en: 'Growth catalogue' } });
    status(result, 201);
    return result.body.subject.id as string;
  }
  async function proposal(subject: string) {
    const payload = `https://example.test/private/${randomUUID()}`;
    const result = await call('POST', `/v1/subjects/${subject}/candidates`, { statement: snak(payload) });
    status(result, 201);
    return { subject, candidate: result.body.candidate as string, payload };
  }
  const path = (record: { subject: string; candidate: string }) =>
    `/v1/subjects/${record.subject}/candidates/${record.candidate}`;
  const db = await openGrowthDatabase(url);
  await bootstrapRelease(db.pool, bundledRelease);
  const real = await createRealAccess(db.admin, { owner: account }, [
    'subject:create',
    'subject:read',
    'statement:propose',
    'statement:delete',
    'statement:restore',
    'context:accept',
    'context:adopt',
  ]);
  for (const action of ['subject:create', 'statement:propose', 'context:accept', 'context:adopt'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'owner', action);
  const kernel = createKernel({
    pool: db.pool,
    access: (config) => createAccess({ ...config, auth }),
    clock,
    routeKey: new Uint8Array(32).fill(81),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) },
    writeRate: createWriteRateLimiter({
      secret: 'semantic-deletion-growth-test-rate-secret',
      overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60}}}',
    }),
  });
  return {
    db,
    account,
    clock,
    person,
    proposal,
    call,
    status,
    path,
    setNow(value: Date) {
      now = value;
    },
    close: () => db.close(),
  };
}
