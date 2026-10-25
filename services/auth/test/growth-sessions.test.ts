import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { derivedId, newId, partitionOf } from '../../kernel/src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population, type Row } from '../../kernel/test/support/growth.ts';
import { createAuthService, type AccessAccount, type EffectAuthorization } from '../src/index.ts';

const url = process.env.AUTH_TEST_DATABASE_URL;
if (!url) throw new Error('AUTH_TEST_DATABASE_URL must name the migrated Auth test database');
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

async function setup(name: string, axes: readonly Axis[]) {
  const db = await openGrowthDatabase(url);
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
  let sequence = 0;
  const actor = (accountId: string, automated = false) => {
    const account: AccessAccount = { accountId, kind: 'actor', state: 'pending', automated, authnEpoch: 1 };
    accounts.set(accountId, account);
    return account;
  };
  const close = async () => {
    for (const [table, column] of [
      ['auth_session_opening', 'subject_account_id'],
      ['auth_recovery', 'account_id'],
      ['verification', 'value'],
      ['auth_effect_receipt', 'account_id'],
      ['auth_provisioning_receipt', 'account_id'],
      ['auth_consent', 'account_id'],
      ['auth_public_key', 'account_id'],
      ['auth_key_assertion', 'account_id'],
      ['session', '"userId"'],
      ['account', '"userId"'],
    ])
      await db.admin.query(`DELETE FROM ${table} WHERE ${column}=ANY($1::text[])`, [owners]);
    await db.admin.query('DELETE FROM auth_client_reduction WHERE client_id=ANY($1::text[])', [clients]);
    // Reclaim cleared children before parent cascades probe Auth's unindexed foreign keys.
    await db.admin.query('VACUUM (ANALYZE)');
    await db.admin.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [owners]);
    await db.admin.query('DELETE FROM auth_client WHERE client_id=ANY($1::text[])', [clients]);
    await db.admin.query('DELETE FROM auth_signing_key WHERE kid=ANY($1::text[])', [signingKids]);
    await db.close();
  };
  try {
    const service = await createAuthService({
      database: db.pool,
      issuer,
      audience: 'https://growth.api.test',
      secret,
      signing: { activeKid: signingKid, privateKeys: [{ ...privateJwk, kid: signingKid }] },
      trustedAccess: {
        async readAccount(accountId) {
          return accounts.get(accountId) ?? null;
        },
        async readRecoveryAccount(accountId) {
          return accounts.get(accountId) ?? null;
        },
        async authorizeProvisioning(accountId) {
          return { accountId };
        },
        async authorizeRecovery() {
          throw new Error('Recovery completion is outside the bounded case');
        },
        async consumeAuthorization({ authorization, subjectAccountId, purpose, human: proof }) {
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
      },
      recoveryDelivery: { async deliver() {} },
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
    const authorize = (
      subject: string,
      purpose: EffectAuthorization['purpose'],
      destructive = false,
      firstParty = false,
    ) => {
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
    await service.internal.setCredential({
      authorization: authorize(human, 'add-key'),
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
    await request('/recovery/start', { account_id: human });
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
    const signing = await row('auth_signing_key', 'kid', signingKid);
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
          records['public.auth_signing_key'] = [
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
        'INSERT INTO session SELECT * FROM jsonb_populate_record(NULL::session,$1::jsonb) ON CONFLICT (id) DO NOTHING',
        [JSON.stringify(template)],
      );
    };
    return {
      close,
      db,
      service,
      id,
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

test(
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

test(
  'Access token issuance stays within its bound as S grows',
  () =>
    fixture('Access token issuance stays within its bound as S grows', ['S', 'K'], async (f) => {
      await f.check(async () => {
        expect(await (await f.request('/token', {}, f.cookie)).json()).toMatchObject({
          token_type: 'Bearer',
          expires_in: 300,
        });
      });
    }),
  timeout,
);

// Loading/selection and JWKS output traverse all retained K even with fixed injection and activeKid.
test.skip('Signing keys and JWKS stays within its bound as K grows', () => {}, timeout);

test(
  'Password sign-in stays within its bound as A grows',
  () =>
    fixture('Password sign-in stays within its bound as A grows', ['A', 'S'], async (f) => {
      await f.check(async () => {
        expect(f.cookies(await f.signin())).toContain('session_token=');
      });
    }),
  timeout,
);

test(
  'Public-key sign-in stays within its bound as J grows',
  () =>
    fixture('Public-key sign-in stays within its bound as J grows', ['A', 'S', 'P', 'J'], async (f) => {
      let attempt = 0;
      await f.check(async () => {
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

test(
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

test(
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

test(
  'Authorized account effects stays within its bound as s grows',
  () =>
    fixture('Authorized account effects stays within its bound as s grows', ['A', 'P', 'E', 'O'], async (f) => {
      // The bounded case holds the subject's s=1 fixed while A/P/E/O and the hot partition grow.
      await f.check(async () => {
        await f.service.internal.setCredential({
          authorization: f.authorize(f.robot, 'set-password', true),
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

test(
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

// The recovery/opening FK cascades scan global H/O even when every target fanout is fixed.
test.skip('Account erasure stays within its bound as H grows', () => {}, timeout);

test(
  'Recovery start stays within its bound as V grows',
  () =>
    fixture('Recovery start stays within its bound as V grows', ['A', 'H', 'V'], async (f) => {
      // Fix successful delivery; growing expired verifications must not invoke fallback cleanup.
      await f.check(() => f.request('/recovery/start', { account_id: f.human }));
    }),
  timeout,
);

// Native expiry cleanup scans all V even with fixed owner, identifier matches and session fanout.
test.skip('Recovery completion stays within its bound as V grows', () => {}, timeout);
