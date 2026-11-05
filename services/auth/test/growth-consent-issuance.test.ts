import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { migrate as migrateKernel } from '../../kernel/scripts/database.ts';
import { routeOf } from '../../kernel/src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';
import {
  createAuthService,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
  type AuthServiceOptions,
  type TrustedAccessPorts,
  type SessionProof,
} from '../src/index.ts';

const retained = 'account:read';
const removed = 'account:update';
const scopes = [retained, removed];
const issuer = 'https://consent-growth.auth.test';
const password = 'native consent growth password';
type Invalidate = NonNullable<TrustedAccessPorts['invalidateAccount']>;
const cookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function loadKernel(url: string) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    await import(createRequire(new URL('../../kernel/package.json', import.meta.url)).resolve('reylo/register'));
    return {
      ...(await import('../../kernel/src/access/account-data.ts')),
      ...(await import('../../kernel/src/access/auth-bindings.ts')),
      ...(await import('../../kernel/src/access/auth-barriers.ts')),
      ...(await import('../../kernel/src/access/lifecycle.ts')),
      ...(await import('../../kernel/src/access/registration-proof.ts')),
      ...(await import('../../kernel/src/access/index.ts')),
      ...(await import('../../kernel/src/request/access.ts')),
    };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

// Selected identities, floors and receipts come only from native lifecycle
// commands. SQL below grows unrelated history, never a replacement authority.
async function fixture() {
  const postgres = testDatabase();
  const db = await openGrowthDatabase(postgres.url);
  try {
    migrateKernel(postgres.url);
    const native = await loadKernel(postgres.url);
    const authPool = db.openPool({ max: 1, connectionTimeoutMillis: 5000, application_name: 'consent-growth-auth' });
    const proofs = createBarrierProofVerifier({ database: authPool });
    const lifecycle = native.createLifecycleInternals({
      pool: db.pool,
      routeKey: new Uint8Array(32).fill(62),
      provisioningEvidence: createProvisioningEvidenceVerifier({ database: authPool }).resolve,
      recoveryEvidence: async () => null,
    });
    const registration = native.createRegistrationProofBindings({
      pool: db.pool,
      referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(68)]]) },
    });
    const bindings = native.createAuthBindings({ pool: db.pool, ...registration });
    const barriers = native.createAuthBarrierCapabilities({ lifecycle, proofs });
    const advance = barriers.trustedAccess.invalidateAccount!;
    let onInvalidate: ((input: Parameters<Invalidate>[0], advance: Invalidate) => ReturnType<Invalidate>) | undefined;
    let onConsume: ((proof: SessionProof) => Promise<void>) | undefined;
    const ports: TrustedAccessPorts = trustedAccessPorts({
      ...bindings,
      // Auth confirms each barrier receipt with Access and completes the barrier it fenced.
      ...barriers.trustedAccess,
      async authorizeProvisioning(reference) {
        const approval = await bindings.authorizeProvisioning(reference);
        const receipt = await registration.verifyProvisioningReceipt(reference);
        const account = await native.readAccount(db.pool, routeOf(approval.accountId)!, approval.accountId);
        if (!receipt || !account) throw new Error('Missing native registration');
        return {
          ...approval,
          receipt: {
            registrationId: receipt.registrationId,
            reservationId: receipt.registrationId,
            expiresAt: receipt.expiresAt,
            authnEpoch: Number(account.minimumAuthnEpoch),
          },
        };
      },
      async invalidateAccount(input) {
        // Access's real verifier uses this same max=1 pool. Both the slot and
        // shared client lock must be gone before entering the external call.
        expect(authPool.totalCount - authPool.idleCount).toBe(0);
        expect(authPool.waitingCount).toBe(0);
        const locks = await db.admin.query(`SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a USING(pid)
          WHERE a.application_name='consent-growth-auth' AND l.locktype='advisory' AND l.granted`);
        expect(locks.rows).toEqual([]);
        return onInvalidate ? onInvalidate(input, advance) : advance(input);
      },
      async consumeAuthorization(input) {
        await onConsume?.(input.human);
        // No fabricated approval: an absent native effect coordinator denies.
        return bindings.consumeAuthorization!(input);
      },
      async revalidateCredentialEffect() {
        throw new Error('Credential revalidation is unavailable');
      },
    });
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'native',
    };
    const options: AuthServiceOptions = {
      database: authPool,
      issuer,
      audience: 'https://consent-growth.api.test',
      secret: 'native-consent-growth-secret-with-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: ports,
    };
    let auth = await createAuthService(options);
    const request = (path: string, body?: unknown, session = '') =>
      auth.handler(
        new Request(`${issuer}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie: session },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const signin = (accountId: string, clientId = 'web', selected = scopes) =>
      request('/signin', { account_id: accountId, password, client_id: clientId, scope: selected });
    const grant = (session: string, selected = scopes) =>
      request('/consent', { client_id: 'external', scope: selected }, session);
    for (const [clientId, firstParty] of [
      ['web', true],
      ['external', false],
      ['unrelated', false],
    ] as const)
      await auth.internal.registerClient({ clientId, firstParty, scopes });
    async function person(label: string) {
      const name = `growth-${label}`;
      const accountId = lifecycle.registrationTarget(name);
      const handle = `growth_${label}`;
      const reservation = await lifecycle.reserveHandle({ accountId, handle, key: name });
      const input = { accountId, handle, key: name, reservationId: reservation.value.reservationId };
      const outcome = await lifecycle.createPending(input);
      const authorization = await registration.createProvisioningReference({ input, outcome });
      if (!authorization) throw new Error('Missing provisioning reference');
      const result = await auth.internal.provisionPassword({
        authorization,
        email: `${handle}@example.test`,
        password,
      });
      const evidence = result.provisioningEvidence;
      if (!evidence) throw new Error('Missing native provisioning evidence');
      await lifecycle.claimHandle({ ...input, key: `${name}-claim`, evidence });
      await lifecycle.activate({ accountId, key: `${name}-activate`, evidence });
      const login = await signin(accountId);
      expect(login.status).toBe(200);
      const session = cookie(login);
      expect((await grant(session)).status).toBe(200);
      expect((await request('/consent', { client_id: 'unrelated', scope: scopes }, session)).status).toBe(200);
      return { accountId, session };
    }
    const target = await person('target');
    const other = await person('other');
    expect((await request('/token', {}, target.session)).status).toBe(200);
    const access = native.createAccess({
      actions: new Map(scopes.map((scope) => [scope, { anonymous: false }])),
      auth: {
        issuer,
        audience: options.audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async (url, init) => auth.handler(new Request(url, init)),
      },
    });
    async function use(jwt: string, scope: string) {
      const context = { pool: db.pool, deadline: Date.now() + 5000 };
      const actor = await access.authenticate(jwt, context);
      if (actor.kind !== 'account') throw new Error('Expected native account actor');
      return (
        await native.accessCheck(
          access,
          actor,
          scope,
          { route: routeOf(actor.accountId)!, id: actor.accountId },
          context,
        )
      )(db.pool);
    }
    const pending = async () =>
      (
        await db.admin.query(
          'SELECT scopes,revision::text,pending_scopes,pending_reference FROM auth_consent WHERE account_id=$1 AND client_id=$2',
          [target.accountId, 'external'],
        )
      ).rows[0];
    return {
      db,
      authPool,
      ports,
      barriers,
      proofs,
      lifecycle,
      target,
      other,
      request,
      signin,
      grant,
      use,
      pending,
      get auth() {
        return auth;
      },
      set invalidate(value: typeof onInvalidate) {
        onInvalidate = value;
      },
      set consume(value: typeof onConsume) {
        onConsume = value;
      },
      async restart() {
        auth = await createAuthService(options);
      },
      async close() {
        await db.close();
        postgres.close();
      },
    };
  } catch (error) {
    await db.close();
    postgres.close();
    throw error;
  }
}

test('pending ceiling survives native restart, expired proof collection and absent Access callback', async () => {
  const f = await fixture();
  try {
    const before = await f.pending();
    // A short-lived real source makes the native proof expire without altering
    // its immutable evidence or using elapsed time as a concurrency assertion.
    await f.db.admin.query(
      `UPDATE session SET "expiresAt"=statement_timestamp()+interval '5 seconds'
      WHERE "userId"=$1 AND "clientId"='web'`,
      [f.target.accountId],
    );
    let input!: Parameters<Invalidate>[0];
    let receipt!: Awaited<ReturnType<Invalidate>>;
    f.invalidate = async (actual, advance) => {
      input = actual;
      receipt = await advance(actual);
      const row = await f.pending();
      expect(row).toEqual({ ...before, pending_scopes: [retained], pending_reference: actual.proofReference });
      throw new Error('Lost native acknowledgement');
    };
    expect((await f.grant(f.target.session, [retained])).status).toBe(503);
    await f.restart();
    expect((await f.grant(f.target.session, [])).status).toBe(401);
    expect((await f.pending()).pending_reference).toBe(input.proofReference);
    expect((await f.signin(f.target.accountId, 'external')).headers.getSetCookie()).toEqual([]);
    // Access fenced the account at the barrier and Auth never completed it, so no sign-in succeeds yet.
    expect((await f.signin(f.target.accountId, 'external', [retained])).status).toBe(401);
    // Expiry and the bounded collector cannot restore the removed scope.
    while (
      !(
        await f.db.admin.query(
          'SELECT expires_at<=statement_timestamp() AS expired FROM auth_barrier_proof WHERE reference=$1',
          [input.proofReference],
        )
      ).rows[0]?.expired
    )
      await setImmediate();
    await f.proofs.sweep({ limit: 1000 });
    expect((await f.pending()).pending_reference).toBe(input.proofReference);
    expect((await f.grant(f.target.session, [retained])).status).toBe(401);
    expect((await f.signin(f.target.accountId, 'external', [removed])).status).toBe(401);
    expect((await f.lifecycle.readFenceState(f.target.accountId))?.minimumAuthnEpoch).toBe(
      String(receipt.minimumAuthnEpoch),
    );
    // Auth completes the barrier with that receipt: the fence clears at the new floor and sign-in succeeds.
    await f.barriers.trustedAccess.completeBarrier({
      accountId: f.target.accountId,
      purpose: 'consent-reduction',
      operationKey: input.operationKey!,
      receiptId: receipt.receiptId,
      minimumAuthnEpoch: receipt.minimumAuthnEpoch,
    });
    expect(await f.lifecycle.readFenceState(f.target.accountId)).toMatchObject({
      fenced: false,
      minimumAuthnEpoch: String(receipt.minimumAuthnEpoch),
    });
    expect((await f.signin(f.target.accountId, 'external', [retained])).status).toBe(200);
    // A later actual current human consent can supersede the abandoned request.
    const fresh = await f.signin(f.target.accountId);
    expect(fresh.status).toBe(200);
    expect((await f.grant(cookie(fresh))).status).toBe(200);
    expect((await f.pending()).pending_reference).toBeNull();
    f.ports.invalidateAccount = undefined;
    expect((await f.grant(cookie(fresh), [retained])).status).toBe(401);
    expect((await f.pending()).pending_reference).toBeNull();
    expect((await f.pending()).scopes).toEqual(scopes);
  } finally {
    await f.close();
  }
}, 90000);

test('all current native issuance paths deny removed scope before cookie, JWT or effect publication', async () => {
  const f = await fixture();
  const entered = signal();
  const release = signal();
  let reduction: Promise<Response> | undefined;
  try {
    const full = await f.signin(f.target.accountId, 'external');
    expect(full.status).toBe(200);
    const fullCookie = cookie(full);
    const before = await f.pending();
    f.invalidate = async (input, advance) => {
      entered.resolve();
      await release.promise;
      return advance(input);
    };
    // Hold an actual immutable human proof live before publishing the ceiling.
    // The source epoch remains current: pending consent itself must deny signing.
    f.consume = async (proof) => {
      reduction = f.grant(f.target.session, [retained]);
      await entered.promise;
      expect((await f.pending()).revision).toBe(before.revision);
      await expect(f.auth.internal.accessTokenForProof(proof)).rejects.toThrow();
      const session = await f.request('/session', undefined, fullCookie);
      expect(session.status).toBe(401);
      const token = await f.request('/token', {}, fullCookie);
      expect(token.status).toBe(401);
      expect(await token.json()).not.toHaveProperty('access_token');
      const denied = await f.signin(f.target.accountId, 'external');
      expect(denied.status).toBe(401);
      expect(denied.headers.getSetCookie()).toEqual([]);
      const retainedLogin = await f.signin(f.target.accountId, 'external', [retained]);
      expect(retainedLogin.status).toBe(200);
      const retainedToken = await f.request('/token', {}, cookie(retainedLogin));
      expect(retainedToken.status).toBe(200);
      const retainedJwt = (await retainedToken.json()).access_token;
      expect(await f.use(retainedJwt, retained)).toBe(true);
      expect(await f.use(retainedJwt, removed)).toBe(false);
    };
    const unavailable = await f.auth.internal.stageCredentialEffect({
      key: 'unavailable-native-coordinator',
      subjectAccountId: f.target.accountId,
      credential: { kind: 'password', password: null },
      headers: new Headers({ cookie: fullCookie }),
    });
    await expect(
      f.auth.internal.applyCredentialEffect({
        authorization: 'unavailable-native-coordinator',
        effectRef: unavailable.effectRef,
        key: unavailable.key,
        subjectAccountId: f.target.accountId,
        headers: new Headers({ cookie: fullCookie }),
      }),
    ).rejects.toThrow();
    expect((await f.pending()).pending_scopes).toEqual([retained]);
    release.resolve();
    expect((await reduction!).status).toBe(200);
    expect((await f.pending()).pending_reference).toBeNull();
  } finally {
    release.resolve();
    await reduction;
    await f.close();
  }
}, 90000);

for (const change of ['client-reduction', 'first-party'] as const) {
  test(`client ${change} progresses in the Access gap and preserves a failed consent ceiling`, async () => {
    const f = await fixture();
    try {
      const before = await f.pending();
      let reference: string | undefined;
      let barrier: { operationKey: string; receiptId: string; minimumAuthnEpoch: number } | undefined;
      f.invalidate = async (input, advance) => {
        const receipt = await advance(input);
        reference = input.proofReference;
        barrier = { operationKey: input.operationKey!, ...receipt };
        if (change === 'client-reduction')
          await f.auth.internal.beginClientReduction({
            clientId: 'external',
            operationId: 'native-reduction',
            scopes: [retained],
            firstParty: false,
          });
        else {
          await f.auth.internal.registerClient({ clientId: 'external', firstParty: true, scopes });
          const denied = await f.signin(f.target.accountId, 'external');
          expect(denied.status).toBe(401);
          expect(denied.headers.getSetCookie()).toEqual([]);
          // The barrier fenced the account, so even the retained scope is refused until Auth completes it.
          const login = await f.signin(f.target.accountId, 'external', [retained]);
          expect(login.status).toBe(401);
          expect(login.headers.getSetCookie()).toEqual([]);
          expect(await f.pending()).toEqual({ ...before, pending_reference: reference, pending_scopes: [retained] });
        }
        expect((await f.signin(f.target.accountId, 'unrelated')).status).toBe(401);
        expect((await f.signin(f.other.accountId, 'unrelated')).status).toBe(200);
        return receipt;
      };
      expect((await f.grant(f.target.session, [retained])).status).toBe(401);
      expect(await f.pending()).toEqual({ ...before, pending_reference: reference, pending_scopes: [retained] });
      await f.restart();
      expect((await f.grant(f.target.session, [retained])).status).not.toBe(200);
      expect((await f.pending()).pending_reference).toBe(reference);
      // Once Auth completes the barrier the fence clears and a fresh sign-in succeeds at the new floor.
      await f.barriers.trustedAccess.completeBarrier({
        accountId: f.target.accountId,
        purpose: 'consent-reduction',
        ...barrier!,
      });
      expect((await f.signin(f.target.accountId, 'unrelated')).status).toBe(200);
      if (change === 'first-party') {
        const login = await f.signin(f.target.accountId, 'external', [retained]);
        expect(login.status).toBe(200);
        expect((await f.request('/token', {}, cookie(login))).status).toBe(200);
      }
    } finally {
      await f.close();
    }
  }, 90000);
}

const axes = ['owners', 'clients', 'same-owner-clients', 'pending', 'proof-history'] as const;
async function grow(db: GrowthDatabase, axis: (typeof axes)[number], scale: number, previous: number, owner: string) {
  const range = [previous * 500 + 1, scale * 500];
  if (axis === 'owners' || axis === 'pending') {
    await db.admin.query(
      `INSERT INTO "user" (id,name,"emailVerified") SELECT $1||i,'',false FROM generate_series($2::int,$3::int) i`,
      [axis, ...range],
    );
    await db.admin.query(
      `INSERT INTO auth_consent(account_id,client_id,scopes,pending_scopes,pending_reference)
      SELECT $1||i,'external',$4::text[],CASE WHEN $1='pending' THEN $4::text[] ELSE NULL END,
      CASE WHEN $1='pending' THEN md5(i::text) ELSE NULL END FROM generate_series($2::int,$3::int) i`,
      [axis, ...range, scopes],
    );
  } else if (axis === 'clients' || axis === 'same-owner-clients') {
    await db.admin.query(
      `INSERT INTO auth_client(client_id,first_party,scopes) SELECT $1||i,false,$4 FROM generate_series($2::int,$3::int) i`,
      [axis, ...range, scopes],
    );
    await db.admin.query(
      `INSERT INTO auth_client_coverage(client_id,ready,ready_after) SELECT $1||i,true,now() FROM generate_series($2::int,$3::int) i`,
      [axis, ...range],
    );
    if (axis === 'same-owner-clients')
      await db.admin.query(
        `INSERT INTO auth_consent(account_id,client_id,scopes,pending_scopes,pending_reference)
      SELECT $1,$2||i,$5::text[],$5::text[],md5(i::text) FROM generate_series($3::int,$4::int) i`,
        [owner, axis, ...range, scopes],
      );
  } else {
    await db.admin.query(
      `INSERT INTO auth_barrier_proof(reference,account_id,purpose,previous_epoch,operation_key,digest,evidence,created_at,expires_at,applied_at)
      SELECT md5(i::text)||md5(i::text),$1,'consent-reduction',1,'history-'||i,repeat('0',64),'[]',
      now()-interval '10 minutes',now()-interval '9 minutes',CASE WHEN i%2=0 THEN now()-interval '9 minutes' ELSE NULL END
      FROM generate_series($2::int,$3::int) i`,
      [owner, ...range],
    );
    await db.admin.query(
      `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch)
      SELECT 'history-'||i,$1,'consent-reduction',2 FROM generate_series($2::int,$3::int) i`,
      [owner, ...range],
    );
  }
  for (const table of [
    '"user"',
    'auth_consent',
    'auth_client',
    'auth_client_coverage',
    'auth_barrier_proof',
    'auth_effect_receipt',
  ])
    await db.admin.query(`VACUUM ANALYZE ${table}`);
}

test('checkGrowth captures complete native consent transactions, pending issuance, live proof and Access barriers at 1x/8x/64x500', async () => {
  const f = await fixture();
  try {
    // The one-shot adapter schema introspection shares the max=1 auth pool.
    // Finish it before checkGrowth so a late catalog read cannot enter one sample.
    expect((await f.signin(f.target.accountId)).status).toBe(200);
    expect((await f.grant(cookie(await f.signin(f.target.accountId)))).status).toBe(200);
    for (let attempt = 0; attempt < 5; attempt++) {
      await setImmediate();
      const idleDeadline = Date.now() + 1_000;
      while (Date.now() < idleDeadline) {
        if (f.authPool.totalCount === f.authPool.idleCount && f.authPool.waitingCount === 0) break;
        await Bun.sleep(20);
      }
    }
    // Prepared session, account, fence and receipt seeks go generic after a few
    // executions. Proof-history growth analyzes other tables, so those plans
    // survive and a small relation is then scanned. A few thousand untouched
    // rows keep the generic plan on the primary key.
    await f.db.admin.query(
      `INSERT INTO "user" (id,name,"emailVerified") SELECT 'planner-session-'||i,'',false FROM generate_series(1,2000) i`,
    );
    await f.db.admin.query(
      `INSERT INTO session(id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
      SELECT 'planner-session-'||i,'planner-token-'||i,'planner-session-'||i,'web','2099-01-01',now(),'account:read',1,1,'pwd'
      FROM generate_series(1,2000) i`,
    );
    await f.db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,'actor','active',gen_random_uuid()
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,2000)) seeded`,
    );
    await f.db.admin.query(
      `INSERT INTO access.lifecycle_fence_receipt(route,account_id,receipt_id,minimum_authn_epoch,kind,transaction_id)
      SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,gen_random_uuid(),1,'fence',gen_random_uuid()
      FROM (SELECT gen_random_uuid() AS id FROM generate_series(1,2000)) seeded`,
    );
    await f.db.admin.query(
      `INSERT INTO core.receipt(partition_no,principal_id,principal_kind,command_kind,idempotency_key,request_digest,epoch,"position",transaction_id,response)
      SELECT partition.partition_no,gen_random_uuid(),'account','planner-consent','planner-'||i,decode(repeat('00',32),'hex'),1,i,gen_random_uuid(),'{}'
      FROM core.partition partition
      CROSS JOIN generate_series(1,2000) i
      ORDER BY partition.partition_no
      LIMIT 2000`,
    );
    for (const table of ['session', 'access.account', 'access.lifecycle_fence_receipt', 'core.receipt'])
      await f.db.admin.query(`ANALYZE ${table}`);
    for (const axis of axes) await grow(f.db, axis, 1, 0, f.target.accountId);
    for (const axis of axes) {
      let session = '';
      const report = await checkGrowth(f.db, {
        name: `native consent issuance against ${axis}`,
        warmups: 1,
        repetitions: 3,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(db, scale, previous) {
          if (previous) await grow(db, axis, scale, previous, f.target.accountId);
        },
        async operation(db) {
          session = cookie(await f.signin(f.target.accountId));
          expect((await f.grant(session)).status).toBe(200);
          // Same native owner neighborhood at every scale; expired rows count
          // toward the production cap and cleanup must visit at most 64.
          await db.admin.query(
            `INSERT INTO session(id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods","createdAt")
            SELECT 'fixed-'||i,'fixed-'||i,$1,'web','2000-01-01',now(),'account:read',1,1,'pwd','2000-01-01'
            FROM generate_series(1,63) i`,
            [f.target.accountId],
          );
          let barrier!: Awaited<ReturnType<Invalidate>>;
          f.invalidate = async (input, advance) => {
            const receipt = await advance(input);
            barrier = receipt;
            const before = await f.pending();
            expect(before.pending_reference).toBe(input.proofReference);
            expect(before.scopes).toEqual(scopes);
            // The barrier fenced the account: nothing signs in until Auth completes it.
            const wrong = await f.signin(f.target.accountId, 'external');
            expect(wrong.status).toBe(401);
            expect(wrong.headers.getSetCookie()).toEqual([]);
            const fenced = await f.signin(f.target.accountId, 'external', [retained]);
            expect(fenced.status).toBe(401);
            expect(fenced.headers.getSetCookie()).toEqual([]);
            return receipt;
          };
          expect((await f.grant(session, [retained])).status).toBe(200);
          expect((await f.pending()).pending_reference).toBeNull();
          // Auth completed the barrier, so the fresh sign-in succeeds at the new floor.
          const login = await f.signin(f.target.accountId, 'external', [retained]);
          expect(login.status).toBe(200);
          const selected = cookie(login);
          expect((await f.request('/session', undefined, selected)).status).toBe(200);
          const token = await f.request('/token', {}, selected);
          expect(token.status).toBe(200);
          const jwt = (await token.json()).access_token;
          expect(decodeJwt(jwt).scope).toBe(retained);
          expect(decodeJwt(jwt).authn_epoch).toBe(barrier.minimumAuthnEpoch);
          f.consume = async (proof) => {
            const live = await f.auth.internal.accessTokenForProof(proof);
            expect(decodeJwt(live).scope).toBe(retained);
            expect(decodeJwt(live).authn_epoch).toBe(barrier.minimumAuthnEpoch);
          };
          const absent = await f.auth.internal.stageCredentialEffect({
            key: 'absent-native-coordinator',
            subjectAccountId: f.target.accountId,
            credential: { kind: 'password', password: null },
            headers: new Headers({ cookie: selected }),
          });
          await expect(
            f.auth.internal.applyCredentialEffect({
              authorization: 'absent-native-coordinator',
              effectRef: absent.effectRef,
              key: absent.key,
              subjectAccountId: f.target.accountId,
              headers: new Headers({ cookie: selected }),
            }),
          ).rejects.toThrow();
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.statements).toBeGreaterThan(100);
        expect(cost.statements).toBeLessThan(400);
        expect(cost.rows).toBeLessThan(2000);
        expect(cost.relations?.['public.auth_consent']?.rows).toBeGreaterThan(10);
        expect(cost.relations?.['public.auth_barrier_proof']?.rows).toBeGreaterThan(5);
        expect(cost.relations?.['access.account']?.rows).toBeGreaterThan(5);
      }
      console.info(
        'Native consent growth',
        axis,
        JSON.stringify(
          report.samples.map(({ scale, cost }) => ({
            scale,
            rows: cost.rows,
            blocks: cost.blocks,
            statements: cost.statements,
          })),
        ),
      );
    }
  } finally {
    await f.close();
  }
}, 240000);
