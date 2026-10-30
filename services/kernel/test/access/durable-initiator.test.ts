import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthService } from '@rezics/auth';
import { createInternalConsentHandler } from '../../../auth/src/internal-consent.ts';
import { migrate } from '../../../auth/scripts/database.ts';
import { createAccess, captureDurableInitiator, durableInitiatorCommitment } from '../../src/access/index.ts';
import { createAuthConsentReader } from '../../src/access/auth-consent.ts';
import { ApprovalIdentityDeniedError, verifiedBearerExpiry } from '../../src/access/approved-identity.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { commandAccessContext } from '../../src/access/command-admission.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import {
  createInitiatorRestorer,
  type DurableInitiatorReader,
  type DurableInitiatorRecord,
} from '../../src/access/durable-initiator.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import {
  authoritativeTimeValue,
  runCommand,
  type CommandAttempt,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, capture } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const action = 'subject:write';
const extra = 'subject:publish';
/** Test-owned SQL module. Only create() writes positive operation evidence, in an
 * authorized native command with an immutable source and an exact core receipt.
 * Both Access and the private Auth listener use instrumented pools for growth.
 */
export async function nativeModule(requestedAction = action) {
  const action = requestedAction;
  const catalogue = new Map([
    [action, { anonymous: false }],
    [extra, { anonymous: false }],
    ['account:delegate', { anonymous: false }],
  ]);
  const db = await openGrowthDatabase();
  db.pool.options.max = 1;
  migrate(db.url);
  const authPool = db.openPool({ max: 1 });
  await db.admin.query(`CREATE SCHEMA durable_test;
    CREATE TABLE durable_test.source(route integer,id uuid,operation_id uuid NOT NULL,digest text NOT NULL,transaction_id uuid NOT NULL,PRIMARY KEY(route,id));
    CREATE TABLE durable_test.authority(route integer,id uuid,active boolean NOT NULL DEFAULT true,PRIMARY KEY(route,id));
    CREATE TABLE durable_test.effect(route integer,id uuid,value integer NOT NULL,PRIMARY KEY(route,id));
    CREATE TABLE durable_test.operation(route integer,id uuid,record jsonb NOT NULL,PRIMARY KEY(route,id));
    CREATE FUNCTION durable_test.immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
    CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON durable_test.operation FOR EACH ROW EXECUTE FUNCTION durable_test.immutable();
    CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON durable_test.source FOR EACH ROW EXECUTE FUNCTION durable_test.immutable();`);
  const key = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(key.privateKey)), kid: 'durable-test', alg: 'ES256' };
  const issuer = 'https://durable-auth.test';
  const audience = 'https://durable-api.test';
  const approvals = new Set<string>();
  const service = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'durable-test-secret-at-least-thirty-two-bytes',
    signing: { activeKid: jwk.kid, privateKeys: [jwk] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const a = await readAccount(db.pool, routeOf(id)!, id);
        return (
          a && {
            accountId: id,
            kind: a.kind,
            state: a.state,
            authnEpoch: Number(a.minimumAuthnEpoch),
            automated: a.operatorAccountId !== null,
          }
        );
      },
      // A real Auth reduction must publish its durable pending ceiling even if
      // its Access acknowledgement is unavailable; no fake epoch is returned.
      async invalidateAccount() {
        throw new Error('Access acknowledgement unavailable');
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('Denied');
        return { accountId: reference };
      },
    }),
  });
  const edgeKey = await generateKeyPair('RS256', { extractable: true });
  const edgeJwk = { ...(await exportJWK(edgeKey.publicKey)), kid: 'edge-test' };
  const edge = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [edgeJwk] }) });
  const edgeIssuer = edge.url.origin;
  const handler = createInternalConsentHandler({
    database: authPool,
    issuer: edgeIssuer,
    jwksUrl: `${edgeIssuer}/certs`,
    audience: 'durable-worker',
    allowedServiceTokenIds: ['worker.access'],
  });
  const readConsent = createAuthConsentReader({
    url: 'https://durable-private.test/internal/v1/consents:read',
    serviceTokenId: 'worker.access',
    serviceTokenSecret: 'test-secret',
    async fetch(url, init) {
      expect(new Headers(init.headers).get('CF-Access-Client-Id')).toBe('worker.access');
      expect(new Headers(init.headers).get('CF-Access-Client-Secret')).toBe('test-secret');
      const assertion = await new SignJWT({ type: 'app', sub: '', common_name: 'worker.access' })
        .setIssuer(edgeIssuer)
        .setAudience(['durable-worker'])
        .setIssuedAt()
        .setExpirationTime('1m')
        .setProtectedHeader({ alg: 'RS256', kid: 'edge-test' })
        .sign(edgeKey.privateKey);
      const headers = new Headers(init.headers);
      headers.set('Cf-Access-Jwt-Assertion', assertion);
      return handler(new Request(url, { ...init, headers }));
    },
  });
  const nativeAccess = (mounted = catalogue) =>
    createAccess({
      actions: mounted,
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: (url, init) => service.handler(new Request(url, init)),
      },
    });
  const context = () => ({ pool: db.pool, deadline: Date.now() + 10000 });
  async function request(path: string, body: unknown, cookie = '') {
    return service.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  }
  async function person(route = 0x1234) {
    const id = newId(route);
    const clientId = `client-${id}`;
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES ($1,$2,'actor','pending',$2,true)`,
      [routeOf(id), id],
    );
    approvals.add(id);
    await service.internal.provisionPassword({
      authorization: id,
      email: `${id}@test.example`,
      password: 'correct horse battery staple',
    });
    await db.admin.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [
      routeOf(id),
      id,
    ]);
    await service.internal.registerClient({
      clientId: `${clientId}-first`,
      firstParty: true,
      scopes: [action, extra, 'account:delegate'],
    });
    await service.internal.registerClient({ clientId, firstParty: false, scopes: [action, extra, 'account:delegate'] });
    const signedIn = await request('/signin', {
      email: `${id}@test.example`,
      password: 'correct horse battery staple',
      client_id: `${clientId}-first`,
      scope: [action, 'account:delegate'],
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    expect(
      (await request('/consent', { client_id: clientId, scope: [action, 'account:delegate'] }, cookie)).status,
    ).toBe(200);
    const external = await request('/signin', {
      email: `${id}@test.example`,
      password: 'correct horse battery staple',
      client_id: clientId,
      scope: [action, 'account:delegate'],
    });
    expect(external.status).toBe(200);
    const externalCookie = external.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    const issued = await request('/token', {}, externalCookie);
    expect(issued.status).toBe(200);
    const bearer = ((await issued.json()) as { access_token: string }).access_token;
    return { id, clientId, bearer, cookie };
  }
  const readOperation: DurableInitiatorReader = async (client, operation, time) => {
    authoritativeTimeValue(time);
    const result = await client.query<{ record: DurableInitiatorRecord }>(
      'SELECT record FROM durable_test.operation WHERE route=$1 AND id=$2',
      [operation.route, operation.id],
    );
    const record = result.rows[0]?.record;
    if (!record || canonicalize(record.operation) !== canonicalize(operation)) return null;
    const source = await client.query(
      'SELECT operation_id,digest,transaction_id FROM durable_test.source WHERE route=$1 AND id=$2',
      [operation.route, operation.sourceId],
    );
    const row = source.rows[0];
    if (
      !row ||
      row.operation_id !== operation.id ||
      row.transaction_id !== record.recordedTransactionId ||
      row.digest !== record.sourceDigest
    )
      return null;
    if (
      record.sourceDigest !== hash({ operation, target: record.creation.target, payload: 'immutable original source' })
    )
      return null;
    const receipt = (
      await client.query(
        `SELECT request_digest,transaction_id,response FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
        [
          partitionOf(operation.route),
          record.initiatorAccountId,
          record.creation.commandKind,
          record.creation.idempotencyKey,
        ],
      )
    ).rows[0];
    if (
      !receipt ||
      receipt.transaction_id !== record.recordedTransactionId ||
      Buffer.from(receipt.request_digest).toString('hex') !== record.creation.requestDigest ||
      receipt.response?.durableInitiator !== hash(record)
    )
      return null;
    return record;
  };
  async function fixture(delegated = false, scopeSnapshot = [action, 'account:delegate']) {
    const p = await person();
    if (scopeSnapshot.length > 2) {
      await authPool.query('UPDATE auth_client SET scopes=$2 WHERE client_id=$1', [p.clientId, scopeSnapshot]);
      await authPool.query('UPDATE auth_consent SET scopes=$3 WHERE account_id=$1 AND client_id=$2', [
        p.id,
        p.clientId,
        scopeSnapshot,
      ]);
    }
    const principal = delegated ? await person(0x2345) : null;
    const target = { route: 0x5678, id: newId(0x5678) };
    await db.admin.query('INSERT INTO durable_test.authority(route,id) VALUES ($1,$2)', [target.route, target.id]);
    const operation = { route: 0x9abc, id: newId(0x9abc), kind: 'durable-test.erase', sourceId: newId(0x9abc) };
    for (const id of [p.id, principal?.id].filter((id): id is string => !!id)) {
      await db.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$3),($5,$3,$3,'account:delegate','(,)',$3)`,
        [target.route, target.id, id, action, routeOf(id)],
      );
    }
    let requestedBy: string | null = null;
    const native = nativeAccess();
    if (principal) {
      const actor = await native.authenticate(principal.bearer, context());
      requestedBy = (
        await createDelegationCommands({ pool: db.pool, access: native, action: 'account:delegate' }).create(
          { ...context(), actor },
          {
            principalId: principal.id,
            assignedActorId: p.id,
            requestId: newId(routeOf(principal.id)!),
            valid: '(,)',
            key: Bun.randomUUIDv7(),
          },
        )
      ).value.requestedBy;
    }
    // Short-lived real signed bearer is only a regression fixture. Production
    // restoration neither sees a bearer nor signs anything.
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3;
    const bearer = await new SignJWT({
      sub: p.id,
      client_id: p.clientId,
      scope: scopeSnapshot.join(' '),
      authn_epoch: 10,
      iat: now,
      exp,
      auth_time: now,
      amr: ['pwd'],
      ...(requestedBy ? { requested_by: requestedBy } : {}),
    })
      .setIssuer(issuer)
      .setAudience(audience)
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .sign(key.privateKey);
    const creator = await native.authenticate(bearer, context());
    const sourceDigest = hash({ operation, target, payload: 'immutable original source' });
    const creation = {
      commandKind: 'durable-test.create',
      idempotencyKey: operation.id,
      requestDigest: hash({ operation, target, creator, sourceDigest }),
      target,
    };
    const anchor = {
      resource: target,
      async validate(client: Parameters<DurableInitiatorReader>[0]) {
        return (
          (
            await client.query('SELECT active FROM durable_test.authority WHERE route=$1 AND id=$2', [
              target.route,
              target.id,
            ])
          ).rows[0]?.active === true
        );
      },
    };
    const authorization = resourceAuthorization({
      access: native,
      actor: creator,
      action,
      anchor,
      context: { ...context(), partition: partitionOf(operation.route) },
    });
    let original: Awaited<ReturnType<typeof captureDurableInitiator>>;
    const created = await runCommand(
      db.pool,
      {
        partition: partitionOf(operation.route),
        deadline: context().deadline,
        basis: { actorAccountId: creator.accountId, clientId: creator.clientId, requestedBy: creator.requestedBy },
        receipt: {
          actorAccountId: creator.accountId,
          kind: creation.commandKind,
          key: creation.idempotencyKey,
          digest: Buffer.from(creation.requestDigest, 'hex'),
        },
        authorization: {
          ...authorization,
          async prepare(attempt) {
            const proof = await authorization.prepare!(attempt);
            original = await captureDurableInitiator(commandAccessContext(context(), attempt), creator);
            return proof;
          },
        },
      },
      async (tx, { transactionId }) => {
        const record = {
          operation,
          initiatorAccountId: creator.accountId,
          actor: creator,
          recordedTransactionId: transactionId,
          ...original,
          sourceDigest,
          creation,
        };
        await tx.query('INSERT INTO durable_test.source VALUES ($1,$2,$3,$4,$5)', [
          operation.route,
          operation.sourceId,
          operation.id,
          sourceDigest,
          transactionId,
        ]);
        await tx.query('INSERT INTO durable_test.operation VALUES ($1,$2,$3)', [operation.route, operation.id, record]);
        return {
          value: { durableInitiator: durableInitiatorCommitment(record) },
          events: [{ type: 'durable-test.created', data: operation }],
        };
      },
    );
    expect(created.replayed).toBe(false);
    return { ...p, principal, target, operation, anchor, exp, creator, created };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function step(
    f: Fixture,
    options: {
      access?: ReturnType<typeof nativeAccess>;
      reader?: DurableInitiatorReader;
      key?: string;
      retry?: boolean;
      onActor?: (actor: AccountActor, attempt: CommandAttempt) => Promise<void>;
    } = {},
  ) {
    const access = options.access ?? nativeAccess();
    const ctx = context();
    const restorer = createInitiatorRestorer({
      pool: db.pool,
      access,
      readOperation: options.reader ?? readOperation,
      readConsent,
    });
    const input = { operation: f.operation, action, anchor: f.anchor, context: ctx };
    let current: { attempt: CommandAttempt; actor: AccountActor; evidence: unknown } | undefined;
    let attempts = 0;
    let effects = 0;
    const authorization: CommandAuthorization = {
      action,
      resource: f.target,
      denied: () => new Error('Step denied'),
      async prepare(attempt) {
        current = undefined;
        const actor = await restorer.restoreInitiator(input, attempt.time);
        attempts++;
        await options.onActor?.(actor, attempt);
        const evidence = await access.prepare!(actor, action, f.target, commandAccessContext(ctx, attempt));
        current = { attempt, actor, evidence };
        return current;
      },
      async authorize(tx, attempt, evidence) {
        if (
          !current ||
          evidence !== current ||
          current.attempt !== attempt ||
          attempt.basis?.actorAccountId !== current.actor.accountId ||
          attempt.basis.clientId !== current.actor.clientId ||
          attempt.basis.requestedBy !== current.actor.requestedBy ||
          !(await access.authorize(tx, current.actor, action, f.target, current.evidence, attempt.time))
        )
          throw new Error('Stale step');
        return 'execute';
      },
    };
    const outcome = await runCommand(
      db.pool,
      {
        partition: partitionOf(f.target.route),
        deadline: ctx.deadline,
        basis: { actorAccountId: f.id, clientId: f.clientId, requestedBy: f.creator.requestedBy },
        receipt: {
          actorAccountId: f.id,
          kind: 'durable-test.step',
          key: options.key ?? Bun.randomUUIDv7(),
          digest: Buffer.alloc(32, 7),
        },
        authorization,
      },
      async (tx, { time }) => {
        expect(time).toBe(current!.attempt.time);
        expect(await access.authorize(tx, current!.actor, action, f.target, current!.evidence, time)).toBe(true);
        if (options.retry && attempts === 1) throw Object.assign(new Error('Serialization retry'), { code: '40001' });
        await tx.query(
          'INSERT INTO durable_test.effect VALUES ($1,$2,1) ON CONFLICT(route,id) DO UPDATE SET value=durable_test.effect.value+1',
          [f.target.route, f.target.id],
        );
        effects++;
        return { value: { effect: 'published' }, events: [{ type: 'durable-test.step', data: f.operation }] };
      },
    );
    return { outcome, attempts, effects };
  }
  return {
    db,
    authPool,
    readConsent,
    nativeAccess,
    context,
    fixture,
    readOperation,
    step,
    request,
    person,
    close: async () => {
      edge.stop(true);
      await db.close();
    },
  };
}

// The focused checker runs each file in its own migrated database. Exporting the
// harness lets the growth file exercise exactly the same native module writer.
if (Bun.main === import.meta.path) {
  let h: Awaited<ReturnType<typeof nativeModule>>;
  beforeAll(async () => {
    h = await nativeModule();
  }, 60000);
  afterAll(async () => h?.close());
  test('actual committed operation restores native identity after the original bearer expires, across restart', async () => {
    const f = await h.fixture();
    await Bun.sleep(Math.max(0, f.exp * 1000 - Date.now() + 10));
    const access = h.nativeAccess();
    const result = await h.step(f, {
      access,
      async onActor(actor, attempt) {
        expect(actor).toEqual(f.creator);
        expect(actor).not.toBe(f.creator);
        const ctx = commandAccessContext(h.context(), attempt);
        expect(() => verifiedBearerExpiry(access, actor, ctx)).toThrow(ApprovalIdentityDeniedError);
        const copy = await accessCheck(access, { ...actor }, action, f.target, ctx);
        expect(await copy(h.db.pool, attempt.time)).toBe(false);
      },
    });
    expect(result.effects).toBe(1);
    expect(result.outcome.replayed).toBe(false);
  });
  test('current Auth pending consent ceiling denies independently of an unchanged Access floor', async () => {
    const f = await h.fixture();
    expect((await h.step(f)).effects).toBe(1);
    const response = await h.request('/consent', { client_id: f.clientId, scope: [] }, f.cookie);
    expect(response.status).toBe(503);
    expect((await readAccount(h.db.pool, routeOf(f.id)!, f.id))!.minimumAuthnEpoch).toBe(1n);
    expect(
      (await h.readConsent({ actorAccountId: f.id, clientId: f.clientId, deadline: h.context().deadline }))!.scopes,
    ).toEqual([]);
    await expect(h.step(f)).rejects.toThrow();
  });
  for (const fact of [
    'consent deleted',
    'consent reduced',
    'client deleted',
    'client unready',
    'client reducing',
    'floor increased below original epoch',
    'stale epoch',
    'suspended',
    'deleted',
    'fenced',
    'operator changed',
    'actor grant',
    'explicit denial',
  ] as const) {
    test(`${fact} denies before target checkout, receipt replay or effect`, async () => {
      const f = await h.fixture();
      const key = Bun.randomUUIDv7();
      expect((await h.step(f, { key })).effects).toBe(1);
      if (fact === 'consent deleted')
        await h.authPool.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [f.id, f.clientId]);
      else if (fact === 'consent reduced')
        await h.authPool.query(
          "UPDATE auth_consent SET scopes=ARRAY['account:delegate'] WHERE account_id=$1 AND client_id=$2",
          [f.id, f.clientId],
        );
      else if (fact === 'client deleted') {
        await h.authPool.query('DELETE FROM session WHERE \"clientId\"=$1', [f.clientId]);
        await h.authPool.query('DELETE FROM auth_client_coverage WHERE client_id=$1', [f.clientId]);
        await h.authPool.query('DELETE FROM auth_client WHERE client_id=$1', [f.clientId]);
      } else if (fact === 'client unready')
        await h.authPool.query('UPDATE auth_client_coverage SET ready=false WHERE client_id=$1', [f.clientId]);
      else if (fact === 'client reducing')
        await h.authPool.query('INSERT INTO auth_client_reduction VALUES ($1,$2,ARRAY[]::text[],false)', [
          f.clientId,
          'pending',
        ]);
      else if (fact === 'actor grant')
        await h.db.admin.query(
          'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
          [f.target.route, f.target.id, f.id],
        );
      else if (fact === 'explicit denial')
        await h.db.admin.query(
          `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,$4,'resource','(,)',$3)`,
          [f.target.route, f.target.id, f.id, action],
        );
      else if (fact === 'operator changed') {
        const operator = await h.person();
        await h.db.admin.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
          routeOf(f.id),
          f.id,
          operator.id,
        ]);
      } else {
        const update = fact.startsWith('floor')
          ? 'minimum_authn_epoch=2'
          : fact === 'stale epoch'
            ? 'minimum_authn_epoch=11'
            : fact === 'fenced'
              ? 'authn_fenced=true'
              : `state='${fact}'`;
        await h.db.admin.query(`UPDATE access.account SET ${update} WHERE route=$1 AND account_id=$2`, [
          routeOf(f.id),
          f.id,
        ]);
      }
      const observed = await capture(h.db, async () => {
        await expect(h.step(f, { key })).rejects.toThrow();
      });
      expect(observed.capture.statements.some((sql) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(sql))).toBe(false);
      expect(observed.capture.statements.filter((sql) => /FROM core\.receipt/.test(sql))).toHaveLength(2);
      expect(
        (
          await h.db.admin.query('SELECT value FROM durable_test.effect WHERE route=$1 AND id=$2', [
            f.target.route,
            f.target.id,
          ])
        ).rows[0].value,
      ).toBe(1);
    });
  }
  test('more recent consent cannot broaden the original scope ceiling, and scopes are never grants', async () => {
    const f = await h.fixture();
    expect(
      (await h.request('/consent', { client_id: f.clientId, scope: [action, extra, 'account:delegate'] }, f.cookie))
        .status,
    ).toBe(200);
    await h.step(f, {
      async onActor(actor) {
        expect(actor.scopes).toEqual([action, 'account:delegate']);
      },
    });
    await h.db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
      f.target.route,
      f.target.id,
    ]);
    await expect(h.step(f)).rejects.toThrow();
  });
  for (const fact of [
    'assignment revoked',
    'principal suspended',
    'principal fenced',
    'principal grant',
    'actor grant',
    'principal denial',
  ] as const) {
    test(`exact delegated restoration checks ${fact} independently at step T`, async () => {
      const f = await h.fixture(true);
      expect((await h.step(f)).effects).toBe(1);
      const principal = f.principal!;
      if (fact === 'assignment revoked') {
        await h.db.admin.query(
          `UPDATE access.principal_assignment SET revoked_at=transaction_timestamp(),valid=valid*tstzrange(NULL,transaction_timestamp(),'[)') WHERE route=$1 AND principal_id=$2 AND request_id=$3`,
          [routeOf(principal.id), principal.id, f.creator.requestedBy!.split(':').at(-1)],
        );
      } else if (fact === 'principal suspended') await suspendAccount(h.db.admin, principal.id);
      else if (fact === 'principal fenced')
        await h.db.admin.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
          routeOf(principal.id),
          principal.id,
        ]);
      else if (fact.endsWith('grant'))
        await h.db.admin.query(
          'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3',
          [f.target.route, f.target.id, fact === 'actor grant' ? f.id : principal.id],
        );
      else
        await h.db.admin.query(
          `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,$4,'resource','(,)',$3)`,
          [f.target.route, f.target.id, principal.id, action],
        );
      await expect(h.step(f)).rejects.toThrow();
    });
  }
  test('forged/substituted operation, source, transaction, actor, floor and exact receipt cannot register an actor', async () => {
    const f = await h.fixture();
    const access = h.nativeAccess();
    const changes: ((row: DurableInitiatorRecord) => DurableInitiatorRecord)[] = [
      (r) => ({ ...r, operation: { ...r.operation, id: newId(r.operation.route) } }),
      (r) => ({ ...r, operation: { ...r.operation, sourceId: newId(r.operation.route) } }),
      (r) => ({ ...r, operation: { ...r.operation, kind: 'copied-source' } }),
      (r) => ({ ...r, initiatorAccountId: newId(0x1234) }),
      (r) => ({ ...r, actor: { ...r.actor, scopes: [action, extra] } }),
      (r) => ({ ...r, recordedTransactionId: Bun.randomUUIDv7() }),
      (r) => ({ ...r, sourceDigest: '0'.repeat(64) }),
      (r) => ({ ...r, originalAccount: { ...r.originalAccount, minimumAuthnEpoch: '2' } }),
      (r) => ({ ...r, creation: { ...r.creation, commandKind: 'copied-command' } }),
      (r) => ({ ...r, creation: { ...r.creation, idempotencyKey: 'copied-receipt' } }),
      (r) => ({ ...r, creation: { ...r.creation, requestDigest: '0'.repeat(64) } }),
      (r) => ({ ...r, creation: { ...r.creation, target: { ...r.creation.target, id: newId(0x5678) } } }),
    ];
    for (const change of changes) {
      let forged: DurableInitiatorRecord | undefined;
      await expect(
        h.step(f, {
          access,
          reader: async (client, operation, time) => {
            forged = change((await h.readOperation(client, operation, time))!);
            return forged;
          },
        }),
      ).rejects.toThrow();
      expect(await access.prepare!(forged!.actor, action, f.target, h.context())).toBeNull();
    }
    const copied = await h.fixture();
    await expect(
      h.step(copied, { reader: (client, _operation, time) => h.readOperation(client, f.operation, time) }),
    ).rejects.toThrow();
    const copiedOperation = { ...f.operation, id: newId(f.operation.route), sourceId: newId(f.operation.route) };
    await h.db.admin.query(
      'INSERT INTO durable_test.operation SELECT route,$1,record FROM durable_test.operation WHERE route=$2 AND id=$3',
      [copiedOperation.id, f.operation.route, f.operation.id],
    );
    await h.db.admin.query(
      'INSERT INTO durable_test.source SELECT route,$1,$2,digest,transaction_id FROM durable_test.source WHERE route=$3 AND id=$4',
      [copiedOperation.sourceId, copiedOperation.id, f.operation.route, f.operation.sourceId],
    );
    await expect(h.step({ ...f, operation: copiedOperation })).rejects.toThrow();
    await h.db.admin.query(
      "DELETE FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND command_kind='durable-test.create' AND idempotency_key=$3",
      [partitionOf(f.operation.route), f.id, f.operation.id],
    );
    await expect(h.step(f)).rejects.toThrow();
  });
  test('restored identity is instance/pool/time/action bound, and every serialization retry restores afresh', async () => {
    const f = await h.fixture();
    const access = h.nativeAccess();
    const other = h.nativeAccess();
    let captured: AccountActor | undefined;
    const times = new Set<unknown>();
    const actors = new Set<unknown>();
    const result = await h.step(f, {
      access,
      retry: true,
      async onActor(actor, attempt) {
        const ctx = commandAccessContext(h.context(), attempt);
        expect(await other.prepare!(actor, action, f.target, ctx)).toBeNull();
        expect(await access.prepare!(actor, extra, f.target, ctx)).toBeNull();
        expect(
          await access.prepare!(
            actor,
            action,
            f.target,
            commandAccessContext({ ...h.context(), pool: h.db.admin }, attempt),
          ),
        ).toBeNull();
        const wrongPool = createInitiatorRestorer({
          pool: h.db.pool,
          access,
          readOperation: h.readOperation,
          readConsent: h.readConsent,
        });
        await expect(
          wrongPool.restoreInitiator(
            { operation: f.operation, action, anchor: f.anchor, context: { ...h.context(), pool: h.db.admin } },
            attempt.time,
          ),
        ).rejects.toThrow();
        times.add(attempt.time);
        actors.add(actor);
        captured = actor;
      },
    });
    expect(result.attempts).toBe(2);
    expect(result.effects).toBe(1);
    expect(times.size).toBe(2);
    expect(actors.size).toBe(2);
    await h.step(f, {
      access,
      async onActor(_actor, attempt) {
        expect(
          await access.prepare!(captured!, action, f.target, commandAccessContext(h.context(), attempt)),
        ).toBeNull();
      },
    });
    expect(await access.prepare!(captured!, action, f.target, h.context())).toBeNull();
  });
  test('native public floor still honors named denials and cannot become a new protected-action exception', async () => {
    const f = await h.fixture();
    await h.authPool.query('UPDATE auth_consent SET scopes=ARRAY[]::text[] WHERE account_id=$1 AND client_id=$2', [
      f.id,
      f.clientId,
    ]);
    await h.db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
      f.target.route,
      f.target.id,
    ]);
    await expect(h.step(f)).rejects.toThrow();
    const access = h.nativeAccess(new Map([[action, { anonymous: true }]]));
    const eligibility = createResourcePublicEligibility({
      resource: f.target,
      action,
      async prepare() {
        return {};
      },
      async verify({ client }) {
        return (await client.query('SELECT 1')).rowCount === 1;
      },
    });
    const publicFixture = {
      ...f,
      target: { ...f.target, eligibility },
      anchor: { ...f.anchor, resource: { ...f.target, eligibility } },
    };
    expect((await h.step(publicFixture, { access })).effects).toBe(1);
    await h.db.admin.query(
      `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,$4,'resource','(,)',$3)`,
      [f.target.route, f.target.id, f.id, action],
    );
    await expect(h.step(publicFixture, { access })).rejects.toThrow();
  });
  test('pending current consent can narrow retained scopes while preserving a still-authorized action', async () => {
    const f = await h.fixture();
    expect(f.creator.scopes).toEqual([action, 'account:delegate']);
    expect((await h.request('/consent', { client_id: f.clientId, scope: [action] }, f.cookie)).status).toBe(503);
    await h.step(f, {
      async onActor(actor) {
        expect(actor.scopes).toEqual([action]);
      },
    });
  });
  test('missing or replaced exact delegation never inherits the original creation', async () => {
    const f = await h.fixture(true);
    const locator = [routeOf(f.principal!.id), f.principal!.id, f.creator.requestedBy!.split(':').at(-1)];
    const row = (
      await h.db.admin.query(
        'DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3 RETURNING *',
        locator,
      )
    ).rows[0];
    await expect(h.step(f)).rejects.toThrow();
    await h.db.admin.query(
      `INSERT INTO access.principal_assignment(route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id) VALUES ($1,$2,$2,$3,$4,$5,$6)`,
      [...locator, row.assigned_actor_id, '(,)', Bun.randomUUIDv7()],
    );
    await expect(h.step(f)).rejects.toThrow();
  });
  test('current creation/authority changes and copied native evidence fail closed', async () => {
    const f = await h.fixture();
    const access = h.nativeAccess();
    await h.step(f, {
      access,
      async onActor(actor, attempt) {
        const evidence = await access.prepare!(actor, action, f.target, commandAccessContext(h.context(), attempt));
        expect(
          await access.authorize(h.db.pool, actor, action, f.target, { ...(evidence as object) }, attempt.time),
        ).toBe(false);
        expect(
          await access.authorize(
            h.db.pool,
            actor,
            action,
            { ...f.target, id: newId(f.target.route) },
            evidence,
            attempt.time,
          ),
        ).toBe(false);
      },
    });
    await h.db.admin.query('UPDATE durable_test.authority SET active=false WHERE route=$1 AND id=$2', [
      f.target.route,
      f.target.id,
    ]);
    await expect(h.step(f)).rejects.toThrow();
    await h.db.admin.query('UPDATE durable_test.authority SET active=true WHERE route=$1 AND id=$2', [
      f.target.route,
      f.target.id,
    ]);
    await h.db.admin.query(
      "UPDATE core.receipt SET response='{}' WHERE partition_no=$1 AND principal_id=$2 AND command_kind='durable-test.create' AND idempotency_key=$3",
      [partitionOf(f.operation.route), f.id, f.operation.id],
    );
    await expect(h.step(f)).rejects.toThrow();
  });
  test('a serialization retry re-reads revoked Auth consent and produces no receipt or effect', async () => {
    const f = await h.fixture();
    let observedActors = 0;
    const observed = await capture(h.db, async () => {
      await expect(
        h.step(f, {
          retry: true,
          async onActor() {
            observedActors++;
            await h.authPool.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [f.id, f.clientId]);
          },
        }),
      ).rejects.toThrow();
    });
    expect(observedActors).toBe(1);
    expect(
      observed.capture.statements.filter((sql) => /^SELECT[\s\S]*FROM auth_consent/.test(sql.trim())),
    ).toHaveLength(2);
    expect(
      (
        await h.db.admin.query('SELECT value FROM durable_test.effect WHERE route=$1 AND id=$2', [
          f.target.route,
          f.target.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await h.db.admin.query(
          "SELECT response FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND command_kind='durable-test.step'",
          [partitionOf(f.target.route), f.id],
        )
      ).rowCount,
    ).toBe(0);
  });
}
