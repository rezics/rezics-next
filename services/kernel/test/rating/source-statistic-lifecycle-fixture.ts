import { createAuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { communityFixtureRuntime } from '../community/community-driver.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { createFigureFixture, type FigureFixture } from './support/figure-fixture.ts';

const issuer = 'https://source-statistic.auth.example.test';
const audience = 'https://api.rezics.test';
const password = 'source statistic lifecycle fixture password';
const scopes = ['rating:vote', 'source_fence:takedown', 'source_statistic:write', 'subject:read'];

export type SourceStatisticLifecycleFixture = Awaited<ReturnType<typeof createSourceStatisticLifecycleFixture>>;

/** Production Kernel, Auth and Access over a migrated isolated database. The optional native figure fixture
 * supplies real public figures and worker-produced rating controls for the composed lifecycle acceptance. */
export async function createSourceStatisticLifecycleFixture(options: { nativeFigures?: boolean } = {}) {
  let database: GrowthDatabase | undefined;
  let nativeFigures: FigureFixture | undefined;
  let closeBase: (() => Promise<void>) | undefined;
  let authPool: Pool | undefined;
  let authDatabase: string | undefined;
  let authCreated = false;
  try {
    if (options.nativeFigures) {
      nativeFigures = await createFigureFixture({ subjects: 4, partitions: 2 });
      database = nativeFigures.database;
      closeBase = () => nativeFigures!.close();
    } else {
      database = await openGrowthDatabase();
      closeBase = () => database!.close();
    }
    const routeKey =
      nativeFigures === undefined ? new Uint8Array(32).fill(121) : communityFixtureRuntime().system.routeKey;
    const databaseUrl = database.url;
    authDatabase = `source_statistic_lifecycle_${crypto.randomUUID().replaceAll('-', '')}`;
    const authUrl = new URL(databaseUrl);
    authUrl.pathname = `/${authDatabase}`;
    await database.admin.query(`CREATE DATABASE ${authDatabase}`);
    authCreated = true;
    const { migrate } = await import('../../../auth/scripts/database.ts');
    migrate(authUrl.toString());
    authPool = new Pool({ connectionString: authUrl.toString() });

    const accountId = newId(0x23a1);
    await database.admin.query(
      `INSERT INTO access.account
         (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
       VALUES ($1, $2, 'actor', 'pending', $2, false, 1, true)`,
      [routeOf(accountId), accountId],
    );
    const signing = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: `source-statistic-${crypto.randomUUID()}`,
      alg: 'ES256',
    };
    const auth = await createAuthService({
      database: authPool,
      issuer,
      audience,
      secret: 'source-statistic-lifecycle-auth-secret-at-least-32-bytes',
      signing: { activeKid: signing.kid, privateKeys: [signing] },
      trustedAccess: trustedAccessPorts({
        async readAccount(id) {
          const route = routeOf(id);
          if (route === null) return null;
          const account = await readAccount(database!.pool, route, id);
          return account
            ? {
                accountId: id,
                kind: account.kind,
                state: account.state,
                authnEpoch: Number(account.minimumAuthnEpoch),
                automated: false,
              }
            : null;
        },
        async authorizeProvisioning(reference) {
          if (reference !== accountId) throw new Error('Unexpected lifecycle fixture provisioning reference');
          return { accountId };
        },
      }),
    });
    const clientId = `source-statistic-lifecycle-${crypto.randomUUID()}`;
    await auth.internal.registerClient({ clientId, firstParty: true, scopes });
    await auth.internal.provisionPassword({
      authorization: accountId,
      email: `${accountId}@example.test`,
      password,
    });
    await database.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(accountId),
      accountId,
    ]);

    const app = createKernel({
      pool: database.pool,
      routeKey,
      tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
      writeRate: createWriteRateLimiter({
        secret: 'source-statistic-lifecycle-write-rate-secret-at-least-32-bytes',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
      }),
      ratePeer: () => '127.0.0.1',
      access: (config) =>
        createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            fetch: (input, init) => auth.handler(new Request(input, init)),
          },
        }),
    });
    const fullBearer = await issue(auth, accountId, clientId, scopes);
    const readerBearer = await issue(auth, accountId, clientId, ['subject:read']);

    await database.admin.query(
      `INSERT INTO access.resource_role_grant
         (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
       VALUES (0, $1, 'identity', $2, '', 'platform.governance',
               tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
      [GLOBAL_CONTEXT, accountId, crypto.randomUUID()],
    );
    await database.admin.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       SELECT 'personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1
       WHERE NOT EXISTS (
         SELECT 1 FROM access.exposure_opening WHERE "group"='personal_library' AND upper_inf(valid)
       )`,
      [crypto.randomUUID()],
    );

    let closed = false;
    return {
      database,
      app,
      routeKey,
      actorId: accountId,
      bearer: fullBearer,
      readerBearer,
      nativeFigures,
      async request(
        method: string,
        path: string,
        requestOptions: { body?: unknown; key?: string; bearer?: string; anonymous?: boolean } = {},
      ): Promise<Response> {
        const key = requestOptions.key ?? crypto.randomUUID();
        return app.handle(
          new Request(`http://kernel.test${path}`, {
            method,
            headers: {
              'x-request-id': 'source-statistic-lifecycle-test',
              ...(requestOptions.anonymous ? {} : { authorization: `Bearer ${requestOptions.bearer ?? fullBearer}` }),
              ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
              ...(requestOptions.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
          }),
        );
      },
      async revokeWriter(): Promise<void> {
        await database!.admin.query(
          'DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND grant_role=$3',
          [GLOBAL_CONTEXT, accountId, 'platform.governance'],
        );
      },
      async restoreWriter(): Promise<void> {
        await database!.admin.query(
          `INSERT INTO access.resource_role_grant
             (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid, transaction_id)
           VALUES (0, $1, 'identity', $2, '', 'platform.governance',
                   tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $3)`,
          [GLOBAL_CONTEXT, accountId, crypto.randomUUID()],
        );
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await authPool!.end();
        if (authCreated) await dropTestDatabase(database!.admin, authDatabase!);
        await closeBase!();
      },
    };
  } catch (error) {
    try {
      await authPool?.end();
    } finally {
      try {
        if (authCreated && database && authDatabase) await dropTestDatabase(database.admin, authDatabase);
      } finally {
        await closeBase?.();
      }
    }
    throw error;
  }
}

async function issue(
  auth: Awaited<ReturnType<typeof createAuthService>>,
  accountId: string,
  clientId: string,
  requestedScopes: readonly string[],
): Promise<string> {
  const signed = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${accountId}@example.test`,
        password,
        client_id: clientId,
        scope: requestedScopes.join(' '),
      }),
    }),
  );
  if (signed.status !== 200) throw new Error(`Lifecycle fixture sign-in failed: ${signed.status}`);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  if (issued.status !== 200) throw new Error(`Lifecycle fixture token issuance failed: ${issued.status}`);
  return ((await issued.json()) as { access_token: string }).access_token;
}
