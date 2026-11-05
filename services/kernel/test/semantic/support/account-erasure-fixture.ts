import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Client } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readAccount } from '../../../src/access/account-data.ts';
import { bootstrapGovernance } from '../../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { synchronizeAccountAgent } from '../../../src/access/account-agent-effect.ts';
import { readErasureStatus } from '../../../src/access/erasure.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { routeOf } from '../../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../../src/semantic/definitions.ts';
import { nativeFixture, cookies, issuer, password } from '../../access/native-account-bindings-fixture.ts';
import { createAuthDatabase } from '../../support/auth-database.ts';
import { openGrowthDatabase } from '../../support/growth.ts';
import { testKernel } from '../../support/test-kernel.ts';
import { deletePersona } from '../../support/account-deletion.ts';

/** One kernel database and one real Auth host. No model registry or fabricated account/barrier/ACK rows. */
export async function accountErasureFixture() {
  const db = await openGrowthDatabase();
  const name = `semantic_erasure_auth_${randomUUID().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  const database = {
    url,
    async close() {
      const adminUrl = new URL(url);
      adminUrl.pathname = '/postgres';
      const admin = new Client({ connectionString: adminUrl.href });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
  const pair = await generateKeyPair('ES256', { extractable: true });
  const actions = new Map(actionCatalogue(testKernel({ pool: db.pool })));
  // The native binding invokes this existing internal action outside the HTTP route catalogue.
  actions.set('access:delegate', { anonymous: false });
  const scopes = [
    ...new Set(
      [...actions.keys()]
        .filter((action) => action !== 'media:complete')
        .concat('account:delete', 'gate:any', 'access:delegate'),
    ),
  ];
  const native = await nativeFixture(db.pool, undefined, {
    database,
    privateKey: { ...(await exportJWK(pair.privateKey)), kid: 'semantic-erasure' },
    actions,
  });
  await native.host.service.internal.registerClient({
    clientId: 'semantic-erasure',
    firstParty: true,
    scopes,
  });
  const kernel = testKernel({
    pool: db.pool,
    writeRate: createWriteRateLimiter({
      secret: 'semantic-erasure-test-write-rate-secret',
      overrides: JSON.stringify({
        'new-account': { write: { maximum: 100_000, seconds: 86_400 } },
        member: { write: { maximum: 100_000, seconds: 86_400 } },
      }),
    }),
    auth: {
      issuer,
      audience: 'https://ordinary.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => native.host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  await bootstrapRelease(db.pool, bundledRelease);
  async function person() {
    const key = `erasure_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const registered = await native.host.workflows.register({
      key,
      handle: key,
      email: `${key}@ordinary.test`,
      password,
    });
    const signed = await native.request('/signin', {
      email: `${key}@ordinary.test`,
      password,
      client_id: 'semantic-erasure',
      scope: scopes,
    });
    expect(signed.status, await signed.clone().text()).toBe(200);
    const headers = cookies(signed);
    const token = await native.request('/token', {}, headers);
    expect(token.status, await token.clone().text()).toBe(200);
    const { access_token: bearer } = (await token.json()) as { access_token: string };
    return { ...registered, handle: key, headers, bearer };
  }
  type Person = Awaited<ReturnType<typeof person>>;
  const governor = await person();
  await bootstrapGovernance(db.pool, governor.accountId);
  async function grant(id: string, subject: Person, granted: string[]) {
    const actor = await native.access.authenticate(governor.bearer, { pool: db.pool, deadline: Date.now() + 30_000 });
    await native.COMMANDS.grants.create(
      { pool: db.pool, actor, deadline: Date.now() + 30_000 },
      {
        resource: { route: routeOf(id)!, id },
        subject: { kind: 'account', id: subject.accountId },
        actions: granted,
        valid: '(,)',
        key: randomUUID(),
      },
    );
  }
  async function grantAs(grantor: Person, id: string, subject: Person, granted: string[]) {
    const result = await call(grantor, 'POST', '/v1/grants', {
      resource: { route: routeOf(id)!, id },
      subject: { kind: 'account', id: subject.accountId },
      actions: granted,
      valid: '(,)',
    });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
  }
  async function delegated(principal: Person, delegate: Person) {
    await grant(principal.accountId, principal, ['access:delegate']);
    const context = { pool: db.pool, deadline: Date.now() + 30_000 };
    const actor = await native.access.authenticate(principal.bearer, context);
    const requestId = Bun.randomUUIDv7();
    const assignment = await native.COMMANDS.delegations.create(
      { ...context, actor },
      {
        principalId: principal.accountId,
        assignedActorId: delegate.accountId,
        requestId,
        valid: '(,)',
        key: Bun.randomUUIDv7(),
      },
    );
    const requestedBy = assignment.value.requestedBy;
    const response = await native.request('/token', { requested_by: requestedBy }, delegate.headers);
    expect(response.status, await response.clone().text()).toBe(200);
    const token = (await response.json()) as { access_token: string };
    return { ...delegate, bearer: token.access_token };
  }
  async function author() {
    const result = await person();
    await grant(GLOBAL_CONTEXT, result, ['subject:create', 'statement:propose', 'context:create', 'gate:any']);
    // The existing Accounts effect is real producer work, not a second account-data registry.
    await synchronizeAccountAgent(db.pool, result.accountId);
    return result;
  }
  async function call(who: Person | undefined, method: string, path: string, body?: unknown, headers = {}) {
    const response = await kernel.handle(
      new Request(`https://kernel.test${path}`, {
        method,
        headers: {
          ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
          ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
  }
  async function tombstone(who: Person) {
    const result = await deletePersona({ version: 1, pool: db.pool, auth: native }, who);
    expect((await readAccount(db.pool, routeOf(who.accountId)!, who.accountId))?.state).toBe('deleted');
    const status = await readErasureStatus(db.pool, who.accountId);
    expect(status?.version).toBe(1);
    expect(status?.participants.semantic).toEqual({ outcome: 'pending', retained: [] });
    expect(status?.completedAt).toBeNull();
    const events = await db.admin.query(
      `SELECT o.data,b.transaction_id FROM core.outbox o JOIN editorial.write_basis b USING(partition_no,position) WHERE o.subject=$1 AND type='com.rezics.access.account-tombstoned.v1'`,
      [who.accountId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].data).toMatchObject({ accountId: who.accountId });
    const barrier = await db.admin.query(
      `SELECT e.xmin::text AS erasure_tx,a.xmin::text AS account_tx FROM access.erasure e
       JOIN access.account a USING(route,account_id) WHERE e.route=$1 AND e.account_id=$2`,
      [routeOf(who.accountId), who.accountId],
    );
    expect(barrier.rows[0].erasure_tx).toBe(barrier.rows[0].account_tx);
    return { result, eventTransaction: events.rows[0].transaction_id, status };
  }
  return {
    db,
    native,
    person,
    author,
    grant,
    grantAs,
    delegated,
    call,
    tombstone,
    status: (accountId: string) => readErasureStatus(db.pool, accountId),
    async close() {
      try {
        await native.close();
      } finally {
        await db.close();
      }
    },
  };
}
export type AccountErasureFixture = Awaited<ReturnType<typeof accountErasureFixture>>;
