import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { derivedId, newId, partitionOf } from '../../kernel/src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population, type Row } from '../../kernel/test/support/growth.ts';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  type AccessAccount,
  type AuthService,
  type CredentialEffectAuthorization,
  type CredentialEffectBinding,
  type EffectAuthorization,
} from '../src/index.ts';

// One database. Each case used to leave its growth seed behind, and the next
// case then filled the fixture until Postgres restarted.
const owned = testDatabase();
afterAll(() => {
  owned.close();
});
const issuer = 'https://growth.auth.test';
const secret = 'growth-only-persistent-secret-with-at-least-32-bytes';
const password = 'correct horse battery staple';
const route = 37 * 16;
const timeout = 90_000;
const perScale = 500;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const key = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(key.publicKey)), alg: 'ES256', use: 'sig' };
const privateJwk = await exportJWK(key.privateKey);
type Axis = 'A' | 'S' | 'C' | 'D' | 'K' | 'P' | 'J' | 'E' | 'O' | 'H' | 'V' | 'T';

async function applyCredentialEffect(
  service: AuthService,
  input: {
    key: string;
    subjectAccountId: string;
    headers: Headers;
    credential: Parameters<AuthService['internal']['stageCredentialEffect']>[0]['credential'];
  },
) {
  const stage = await service.internal.stageCredentialEffect(input);
  const approval = await service.internal.approveCredentialEffect({
    effectRef: stage.effectRef,
    key: input.key,
    subjectAccountId: input.subjectAccountId,
    headers: input.headers,
  });
  return service.internal.applyCredentialEffect({
    authorization: approval.reference,
    effectRef: stage.effectRef,
    key: input.key,
    subjectAccountId: input.subjectAccountId,
    headers: input.headers,
  });
}

async function setup(name: string, axes: readonly Axis[]) {
  const db = await openGrowthDatabase(owned.url);
  const namespace = newId(route);
  const id = (name: string, placement = route) => derivedId(namespace, name, placement);
  const human = id('human');
  const robot = id('robot');
  const web = id('web');
  const external = id('external');
  const signingKid = id('signing');
  const owners = [human, robot];
  const clients = [web, external];
  const signingKids = [signingKid];
  const accounts = new Map<string, AccessAccount>();
  const authorizations = new Map<string, EffectAuthorization>();
  const invalidates = new Set<string>();
  const credentialApprovals = new Map<
    string,
    { stage: CredentialEffectBinding; expiresAt: string; consumed: boolean }
  >();
  let recoveryToken = '';
  let sequence = 0;
  const nextCredentialKey = () => id(`credential-operation-${sequence++}`);
  const actor = (accountId: string, automated = false) => {
    const account: AccessAccount = { accountId, kind: 'actor', state: 'pending', automated, authnEpoch: 1 };
    accounts.set(accountId, account);
    return account;
  };
  const close = async () => {
    await db.close();
  };
  try {
    // Drop the previous case's seed. DELETE leaves the tmpfs full; TRUNCATE
    // returns those files. WAL stays until a checkpoint, so recycle it before
    // the next case writes.
    await db.admin.query(
      `UPDATE auth_signing_generation
       SET current_kid=NULL, next_kid=NULL, retiring_kid=NULL, generation=generation+1
       WHERE current_kid IS NOT NULL OR next_kid IS NOT NULL OR retiring_kid IS NOT NULL`,
    );
    await db.admin.query(`TRUNCATE TABLE
      auth_session_opening, auth_recovery_establishment, auth_recovery, verification,
      auth_effect_receipt, auth_provisioning_receipt, auth_consent, auth_public_key,
      auth_key_assertion, session, account, auth_barrier_proof, auth_attempt_counter,
      auth_client_reduction, auth_client_coverage, auth_client, auth_signing_key,
      auth_signing_key_archive, "user"
      RESTART IDENTITY CASCADE`);
    await db.admin.query('CHECKPOINT');
    // Sign-in resolves the client, its coverage and its reduction by primary key.
    // A handful of live rows makes the planner scan those relations. Thousands of
    // untouched rows at the start keep the seeks.
    await db.admin.query(
      `INSERT INTO auth_client (client_id,first_party,scopes)
      SELECT 'planner-client-'||i,false,ARRAY['read'] FROM generate_series(1,2000) i`,
    );
    await db.admin.query(
      `INSERT INTO auth_client_coverage (client_id,ready,ready_after)
      SELECT 'planner-client-'||i,true,CURRENT_TIMESTAMP FROM generate_series(1,2000) i`,
    );
    await db.admin.query(
      `INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party)
      SELECT 'planner-client-'||i,'planner-reduction-'||i,ARRAY['read'],false FROM generate_series(1,2000) i`,
    );
    await db.admin.query('VACUUM (ANALYZE) auth_client, auth_client_coverage, auth_client_reduction');
    const service = await createAuthService({
      database: db.pool,
      issuer,
      audience: 'https://growth.api.test',
      secret,
      signing: { activeKid: signingKid, privateKeys: [{ ...privateJwk, kid: signingKid }] },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
        },
        async readAccount(accountId) {
          const account = accounts.get(accountId);
          // Auth compares the epoch it read before the floor hook with the receipt.
          // The hook advances the stored account, so the read must be a snapshot.
          return account ? { ...account } : null;
        },
        async readRecoveryAccount(accountId) {
          return accounts.get(accountId) ?? null;
        },
        async authorizeProvisioning(accountId) {
          return { accountId };
        },
        async authorizeRecovery({ accountId, proofEpoch }) {
          const account = accounts.get(accountId)!;
          expect(proofEpoch).toBe(account.authnEpoch);
          return {
            receiptId: id(`recovery-${sequence++}`),
            accountId,
            minimumAuthnEpoch: ++account.authnEpoch,
          };
        },
        async completeRecovery(reference) {
          const witness = await service.internal.resolveRecoveryEstablishment(reference);
          const account = accounts.get(human);
          if (
            !witness ||
            !account ||
            witness.accountId !== account.accountId ||
            witness.minimumAuthnEpoch !== String(account.authnEpoch)
          )
            throw new Error('Completion denied');
        },
        async approveCredentialEffect({ stage }) {
          const reference = id(`credential-opening-${sequence++}`);
          const expiresAt = new Date(Date.now() + 60_000).toISOString();
          credentialApprovals.set(reference, { stage, expiresAt, consumed: false });
          return { reference, expiresAt };
        },
        async consumeAuthorization(input) {
          const { authorization, subjectAccountId, purpose, human: proof } = input;
          if (purpose !== 'session') {
            const opening = credentialApprovals.get(authorization);
            const stage = opening?.stage;
            const subject = accounts.get(subjectAccountId);
            if (
              !opening ||
              opening.consumed ||
              !stage ||
              !subject ||
              stage.subjectAccountId !== subjectAccountId ||
              stage.purpose !== purpose ||
              stage.operationKey !== input.operationKey ||
              stage.effectReference !== input.effectReference ||
              stage.actingHumanId !== proof.account_id ||
              stage.clientId !== proof.client_id ||
              JSON.stringify(stage.scopes) !== JSON.stringify(proof.scope)
            )
              throw new Error('Invalid test credential approval');
            opening.consumed = true;
            return {
              ...stage,
              receiptId: authorization,
              subjectAccountId,
              actingHumanId: proof.account_id,
              operatorAccountId: subject.automated ? human : null,
              purpose: stage.purpose,
              clientId: proof.client_id,
              scopes: proof.scope,
              humanEpoch: proof.authn_epoch,
              subjectEpoch: subject.authnEpoch,
              expiresAt: opening.expiresAt,
            } satisfies CredentialEffectAuthorization;
          }
          const receipt = authorizations.get(authorization);
          if (
            !receipt ||
            receipt.subjectAccountId !== subjectAccountId ||
            receipt.purpose !== purpose ||
            receipt.actingHumanId !== proof.account_id
          )
            throw new Error('Invalid test authorization');
          authorizations.delete(authorization);
          if (invalidates.delete(authorization)) {
            const subject = accounts.get(subjectAccountId)!;
            receipt.subjectEpoch = ++subject.authnEpoch;
            receipt.invalidation = {
              receiptId: receipt.receiptId,
              accountId: subjectAccountId,
              minimumAuthnEpoch: subject.authnEpoch,
            };
          }
          return receipt;
        },
        async revalidateCredentialEffect({ stage, authorization }) {
          const opening = credentialApprovals.get(authorization);
          if (!opening || JSON.stringify(opening.stage) !== JSON.stringify(stage))
            throw new Error('Invalid test credential opening');
        },
        async advanceCredentialFloor({ stage, consumedOpening, expectedPreviousFloor }) {
          const subject = accounts.get(stage.subjectAccountId)!;
          if (subject.authnEpoch !== expectedPreviousFloor) throw new Error('Invalid test floor');
          subject.authnEpoch++;
          return {
            receiptId: id(`credential-floor-${sequence++}`),
            accountId: subject.accountId,
            minimumAuthnEpoch: subject.authnEpoch,
            operationKey: stage.operationKey,
            effectReference: stage.effectReference,
            effectDigest: stage.effectDigest,
            purpose: stage.purpose,
            openingReceiptId: consumedOpening.receiptId,
            previousFloor: expectedPreviousFloor,
            fenced: !!subject.fenced,
          };
        },
      }),
      recoveryDelivery: {
        async deliver({ token }) {
          recoveryToken = token;
        },
      },
    });
    const request = async (path: string, body?: unknown, cookie = '') => {
      const response = await service.handler(
        new Request(`${issuer}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      expect(response.status).toBe(200);
      return response;
    };
    const cookies = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    const signin = () =>
      request('/signin', { email: `${human}@example.test`, password, client_id: external, scope: ['read'] });
    const provision = () =>
      service.internal.provisionPassword({
        authorization: human,
        email: `${human}@example.test`,
        password,
        idempotencyKey: id('provision'),
      });
    const person = actor(human);
    await provision();
    person.state = 'active';
    const automated = actor(robot, true);
    await service.internal.provisionCredentialless({ authorization: robot });
    automated.state = 'active';
    await service.internal.registerClient({ clientId: web, firstParty: true, scopes: ['read'] });
    await service.internal.registerClient({ clientId: external, firstParty: false, scopes: ['read'] });
    const firstParty = cookies(
      await request('/signin', { account_id: human, password, client_id: web, scope: ['read'] }),
    );
    await request('/consent', { client_id: external, scope: ['read'] }, firstParty);
    const cookie = cookies(await signin());
    const headers = new Headers({ cookie });
    const authorize = (subject: string, purpose: 'session', destructive = false, firstParty = false) => {
      const account = accounts.get(subject)!;
      const receiptId = id(`effect-${sequence++}`);
      const receipt: EffectAuthorization = {
        receiptId,
        subjectAccountId: subject,
        actingHumanId: human,
        operatorAccountId: account.automated ? human : null,
        purpose,
        clientId: firstParty ? web : external,
        scopes: ['read'],
        humanEpoch: person.authnEpoch,
        subjectEpoch: account.authnEpoch,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      if (destructive) invalidates.add(receiptId);
      authorizations.set(receiptId, receipt);
      return receiptId;
    };
    const credential = {
      kind: 'key',
      kid: id('credential'),
      publicJwk: { ...publicJwk, kid: id('credential') },
    } as const;
    await applyCredentialEffect(service, {
      key: nextCredentialKey(),
      subjectAccountId: human,
      headers,
      credential,
    });
    const operatorHeaders = new Headers({ cookie: firstParty });
    const robotCookie = cookies(
      await service.internal.openAutomatedSession({
        authorization: authorize(robot, 'session', false, true),
        subjectAccountId: robot,
        headers: operatorHeaders,
      }),
    );
    const mailKey = createHmac('sha256', secret)
      .update(JSON.stringify(['auth-recovery-mail-v1', human]))
      .digest('hex');
    await request('/recovery/start', { email: `${human}@example.test` });
    const deliveryDeadline = Date.now() + 5_000;
    while (!recoveryToken && Date.now() < deliveryDeadline) await Bun.sleep(10);
    expect(recoveryToken).not.toBe('');
    const row = async (table: string, predicate: string, value: string): Promise<Row> =>
      (await db.admin.query(`SELECT * FROM ${table} WHERE ${predicate}=$1 LIMIT 1`, [value])).rows[0];
    const user = await row('"user"', 'id', human);
    const account = await row('account', '"userId"', human);
    const session: Row = (
      await db.admin.query('SELECT * FROM session WHERE "userId"=$1 AND "clientId"=$2', [human, external])
    ).rows[0];
    const robotSession = await row('session', '"userId"', robot);
    const robotUser = await row('"user"', 'id', robot);
    const robotAccount = await row('account', '"userId"', robot);
    const verification = await row('verification', 'value', human);
    const signing = await row('auth_signing_key_archive', 'kid', signingKid);
    const now = new Date();
    const expires = new Date(now.getTime() + 300_000);
    const has = (axis: Axis) => axes.includes(axis);
    const population: Population = {
      name: `${name}-${namespace}`,
      hotPartition: partitionOf(route),
      // Copy native owner/credential/session/verification/key rows; other rows match Auth's INSERTs, with no derived counters.
      rows: ({ ordinal, route: placedRoute, hot }) => {
        const entry = (kind: string) => id(`${kind}-${ordinal}`, placedRoute);
        const owner = has('A') ? entry('owner') : human;
        const client = has('C') ? entry('client') : external;
        const token = createHash('sha256').update(entry('token')).digest('hex').slice(0, String(session.token).length);
        const records: Record<string, Row[]> = {};
        if (has('A')) {
          owners.push(owner);
          records['public.user'] = [
            { ...(has('O') ? robotUser : user), id: owner, email: has('O') ? null : `${owner}@example.test` },
          ];
          records['public.account'] = [
            { ...(has('O') ? robotAccount : account), id: entry('account'), accountId: owner, userId: owner },
          ];
        }
        if (has('C')) {
          clients.push(client);
          records['public.auth_client'] = [{ client_id: client, first_party: false, scopes: ['read'] }];
          records['public.auth_client_reduction'] = [
            { client_id: client, operation_id: entry('reduction'), scopes: ['read'], first_party: false },
          ];
        }
        if (has('D'))
          records['public.auth_consent'] = [{ account_id: hot ? human : owner, client_id: client, scopes: ['read'] }];
        if (has('A') && (has('S') || has('O')))
          (records['public.auth_consent'] ??= []).push({ account_id: owner, client_id: external, scopes: ['read'] });
        if (has('S') || has('O')) {
          const age = ordinal % 2 ? 8 * 86_400_000 : 0;
          records['public.session'] = [
            {
              ...session,
              id: entry('session'),
              token,
              userId: owner,
              clientId: external,
              createdAt: new Date(new Date(session.createdAt as string).getTime() - age),
              updatedAt: new Date(new Date(session.updatedAt as string).getTime() - age),
              expiresAt: new Date(new Date(session.expiresAt as string).getTime() - age),
            },
          ];
        }
        if (has('P'))
          records['public.auth_public_key'] = [
            { account_id: hot ? human : owner, kid: entry('key'), public_jwk: { ...publicJwk, kid: entry('key') } },
          ];
        if (has('J'))
          records['public.auth_key_assertion'] = [
            { account_id: hot ? human : owner, jti: entry('jti'), expires_at: expires },
          ];
        if (has('K')) {
          const kid = entry('signing');
          signingKids.push(kid);
          records['public.auth_signing_key_archive'] = [
            { ...signing, kid, private_jwk: { ...(signing.private_jwk as object), kid } },
          ];
        }
        if (has('E'))
          records['public.auth_effect_receipt'] = [
            { receipt_id: entry('receipt'), account_id: owner, purpose: 'session', minimum_authn_epoch: 1 },
          ];
        if (has('O')) {
          records['public.session']![0] = { ...records['public.session']![0], authMethods: 'operator' };
          records['public.auth_session_opening'] = [
            {
              session_id: entry('session'),
              subject_account_id: owner,
              acting_human_id: human,
              operator_account_id: human,
              receipt_id: entry('receipt'),
            },
          ];
        }
        if (has('H'))
          records['public.auth_recovery'] = [
            {
              proof_hash: createHash('sha256').update(token).digest('hex'),
              account_id: owner,
              authn_epoch: 1,
              expires_at: new Date(new Date(verification.expiresAt as string).getTime() - (ordinal % 2 ? 600_000 : 0)),
            },
          ];
        if (has('V')) {
          const age = ordinal % 2 ? 600_000 : 0;
          records['public.verification'] = [
            {
              ...verification,
              id: entry('verification'),
              identifier: `reset-password:${token}`,
              value: owner,
              createdAt: new Date(new Date(verification.createdAt as string).getTime() - age),
              updatedAt: new Date(new Date(verification.updatedAt as string).getTime() - age),
              expiresAt: new Date(new Date(verification.expiresAt as string).getTime() - age),
            },
          ];
        }
        if (has('T'))
          records['public.auth_provisioning_receipt'] = [
            {
              idempotency_key: entry('provision'),
              account_id: owner,
              digest: createHmac('sha256', secret)
                .update(JSON.stringify(['auth-provisioning-v1', owner, `${owner}@example.test`, password]))
                .digest(),
            },
          ];
        return records;
      },
    };
    const check = (operation: () => Promise<unknown>) =>
      checkGrowth(db, {
        name,
        bounds,
        grow: (database, scale, previous) =>
          seed(database, population, { from: previous * perScale, to: scale * perScale }),
        operation,
      });
    // Reinstall the same production-created neighbourhood through the unmeasured seed connection between destructive runs.
    const restoreSession = async (template = session) => {
      await db.admin.query(
        `INSERT INTO session SELECT * FROM jsonb_populate_record(NULL::session,$1::jsonb)
         WHERE NOT EXISTS (SELECT 1 FROM session WHERE id=$2)`,
        [JSON.stringify(template), template.id],
      );
    };
    return {
      close,
      db,
      service,
      id,
      nextCredentialKey,
      human,
      robot,
      external,
      headers,
      operatorHeaders,
      cookie,
      robotCookie,
      request,
      cookies,
      signin,
      provision,
      person,
      authorize,
      credential,
      check,
      restoreSession,
      robotSession,
      recoveryToken,
      mailKey,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
async function fixture(
  name: string,
  axes: readonly Axis[],
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const f = await setup(name, axes);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}

// One database. Concurrent cases grow it together and Postgres restarts.
test.serial(
  'Session verification stays within its bound as S grows',
  () =>
    fixture('Session verification stays within its bound as S grows', ['A', 'S', 'C', 'D'], async (f) => {
      await f.check(async () => {
        expect(await (await f.request('/session', undefined, f.cookie)).json()).toMatchObject({
          account_id: f.human,
          client_id: f.external,
        });
      });
    }),
  timeout,
);

test.serial(
  'Access token issuance stays within its bound as S grows',
  () =>
    fixture('Access token issuance stays within its bound as S grows', ['A', 'S', 'K'], async (f) => {
      await f.check(async () => {
        expect(await (await f.request('/token', {}, f.cookie)).json()).toMatchObject({
          token_type: 'Bearer',
          expires_in: 300,
        });
      });
    }),
  timeout,
);

test.serial(
  'Password sign-in stays within its bound as A grows',
  () =>
    fixture('Password sign-in stays within its bound as A grows', ['A', 'S'], async (f) => {
      await f.check(async () => {
        // Each sign-in inserts a session. The capacity trigger reads that owner's
        // neighborhood, so the measured runs keep it empty through the uncaptured
        // admin connection. Unrelated A and S stay in place.
        await f.db.admin.query('DELETE FROM session WHERE "userId"=$1', [f.human]);
        expect(f.cookies(await f.signin())).toContain('session_token=');
      });
    }),
  timeout,
);

test.serial(
  'Public-key sign-in stays within its bound as J grows',
  () =>
    fixture('Public-key sign-in stays within its bound as J grows', ['A', 'S', 'P', 'J'], async (f) => {
      let attempt = 0;
      await f.check(async () => {
        await f.db.admin.query('DELETE FROM session WHERE "userId"=$1', [f.human]);
        const now = Math.floor(Date.now() / 1000);
        const assertion = await new SignJWT({ jti: f.id(`assertion-${attempt++}`) })
          .setProtectedHeader({ alg: 'ES256', kid: f.credential.kid })
          .setIssuer(f.human)
          .setSubject(f.human)
          .setAudience(`${issuer}/token`)
          .setIssuedAt(now)
          .setExpirationTime(now + 60)
          .sign(key.privateKey);
        expect(
          f.cookies(
            await f.request('/signin/key', { account_id: f.human, assertion, client_id: f.external, scope: ['read'] }),
          ),
        ).toContain('session_token=');
      });
    }),
  timeout,
);

test.serial(
  'Clients and consent stays within its bound as A grows',
  () =>
    fixture('Clients and consent stays within its bound as A grows', ['A', 'S', 'C', 'D'], async (f) => {
      await f.check(async () => {
        await f.service.internal.registerClient({ clientId: f.external, firstParty: false, scopes: ['read'] });
        await f.request('/consent', { client_id: f.external, scope: ['read'] }, f.cookie);
      });
    }),
  timeout,
);

test.serial(
  'Provisioning and owner creation stays within its bound as A grows',
  () =>
    fixture('Provisioning and owner creation stays within its bound as A grows', ['A', 'T'], async (f) => {
      // Fix the idempotent retry branch, account and credential; grow unrelated owners and receipts.
      f.person.state = 'pending';
      await f.check(async () => {
        expect(await f.provision()).toEqual({ accountId: f.human });
      });
    }),
  timeout,
);

test.serial(
  'Authorized account effects stays within its bound as s grows',
  () =>
    fixture('Authorized account effects stays within its bound as s grows', ['A', 'P', 'E', 'O'], async (f) => {
      // The bounded case holds the subject's s=1 fixed while A/P/E/O and the hot partition grow.
      await applyCredentialEffect(f.service, {
        key: f.nextCredentialKey(),
        subjectAccountId: f.robot,
        headers: f.headers,
        credential: { kind: 'password', password },
      });
      await f.check(async () => {
        await applyCredentialEffect(f.service, {
          key: f.nextCredentialKey(),
          subjectAccountId: f.robot,
          headers: f.headers,
          credential: { kind: 'password', password },
        });
        expect((await f.db.admin.query('SELECT id FROM session WHERE "userId"=$1', [f.robot])).rows).toHaveLength(0);
        const opened = await f.service.internal.openAutomatedSession({
          authorization: f.authorize(f.robot, 'session', false, true),
          subjectAccountId: f.robot,
          headers: f.operatorHeaders,
        });
        expect(opened.status).toBe(200);
        expect(f.cookies(opened)).toContain('session_token=');
      });
    }),
  timeout,
);

test.serial(
  'Session erasure stays within its bound as s grows',
  () =>
    fixture('Session erasure stays within its bound as s grows', ['A', 'S'], async (f) => {
      // Hold the target's s=1 fixed; both total sessions and routed neighbours grow.
      await f.check(async () => {
        await f.restoreSession(f.robotSession);
        await f.request('/signout', {}, f.robotCookie);
        await f.restoreSession(f.robotSession);
        await f.service.internal.revokeSessions(f.robot);
        expect((await f.db.admin.query('SELECT id FROM session WHERE "userId"=$1', [f.robot])).rows).toHaveLength(0);
      });
    }),
  timeout,
);

test.serial(
  'Recovery start stays within its bound as V grows',
  () =>
    fixture('Recovery start stays within its bound as V grows', ['A', 'H', 'V'], async (f) => {
      // Fix successful delivery; growing expired verifications must not invoke fallback cleanup.
      await f.check(async () => {
        await f.db.admin.query('DELETE FROM auth_attempt_counter WHERE key=$1', [f.mailKey]);
        await f.db.admin.query('DELETE FROM auth_recovery WHERE account_id=$1', [f.human]);
        await f.db.admin.query('DELETE FROM verification WHERE value=$1', [f.human]);
        await f.request('/recovery/start', { email: `${f.human}@example.test` });
        const deadline = Date.now() + 5_000;
        for (;;) {
          const stored = (await f.db.admin.query('SELECT 1 FROM auth_recovery WHERE account_id=$1 LIMIT 1', [f.human]))
            .rows[0];
          if (stored) return;
          if (Date.now() >= deadline) throw new Error('recovery delivery did not commit');
          await Bun.sleep(10);
        }
      });
    }),
  timeout,
);

test.serial(
  'Recovery completion stays within its bound as V grows',
  () =>
    fixture('Recovery completion stays within its bound as V grows', ['A', 'V'], async (f) => {
      const proofHash = createHash('sha256').update(f.recoveryToken).digest('hex');
      const verification = (await f.db.admin.query('SELECT * FROM verification WHERE value=$1', [f.human])).rows[0];
      const recovery = (await f.db.admin.query('SELECT * FROM auth_recovery WHERE proof_hash=$1', [proofHash])).rows[0];
      const sessions = (await f.db.admin.query('SELECT * FROM session WHERE "userId"=$1', [f.human])).rows;
      const credential = (await f.db.admin.query('SELECT * FROM account WHERE "userId"=$1', [f.human])).rows[0];
      const epoch = f.person.authnEpoch;
      await f.check(async () => {
        // Restore the production-created proof, credential and fixed sessions through the unmeasured connection.
        f.person.authnEpoch = epoch;
        await f.db.admin.query('DELETE FROM auth_barrier_proof WHERE account_id=$1', [f.human]);
        await f.db.admin.query('DELETE FROM auth_effect_receipt WHERE account_id=$1', [f.human]);
        await f.db.admin.query('DELETE FROM auth_recovery WHERE proof_hash=$1', [proofHash]);
        for (const [table, row] of [
          ['verification', verification],
          ['auth_recovery', recovery],
        ] as const)
          await f.db.admin.query(
            `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
            [JSON.stringify(row)],
          );
        await f.db.admin.query('UPDATE account SET password=$2,"updatedAt"=$3 WHERE id=$1', [
          credential.id,
          credential.password,
          credential.updatedAt,
        ]);
        for (const session of sessions) await f.restoreSession(session);
        expect(
          await (
            await f.request('/recovery/complete', {
              account_id: f.human,
              token: f.recoveryToken,
              new_password: password,
            })
          ).json(),
        ).toEqual({ success: true });
        expect(f.person.authnEpoch).toBe(epoch + 1);
        expect(
          (await f.db.admin.query('SELECT id FROM verification WHERE id=$1', [verification.id])).rows,
        ).toHaveLength(0);
        expect((await f.db.admin.query('SELECT id FROM session WHERE "userId"=$1', [f.human])).rows).toHaveLength(0);
        expect(
          (await f.db.admin.query('SELECT password FROM account WHERE id=$1', [credential.id])).rows[0].password,
        ).not.toBe(credential.password);
      });
    }),
  timeout,
);
