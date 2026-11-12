import { Pool } from 'pg';
import { actionCatalogue } from '../../src/http/request.ts';
import { exportJWK, generateKeyPair, importJWK, SignJWT, decodeJwt } from 'jose';
import { createAuthService } from '@rezics/auth';
import { createInternalConsentHandler } from '@rezics/auth/internal-consent';
import { createAuthConsentReader, type CurrentConsentReader } from '../../src/access/auth-consent.ts';
import { createPool } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { accessCheck, type Resource, type AccessClient } from '../../src/request/access.ts';
import { registerTestClient, testAccess, testKernel, traceTestPool } from '../support/test-kernel.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

export type StandingFixtureLifecycle = Readonly<{
  pendingOperation: string;
  run: <T>(operation: string, action: () => Promise<T>) => Promise<T>;
  ready: () => void;
  close: () => Promise<void>;
}>;

/** Real Auth issuance and production Access; SQL below is privileged fixture setup. */
export async function standingFixture(
  extraActions: readonly string[] = [],
  commandPool?: Pool,
  onLifecycle?: (lifecycle: StandingFixtureLifecycle) => void,
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const authDatabase = `standing_auth_${process.pid}_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabase}`;
  const ownsPool = commandPool === undefined;
  const pool = commandPool ?? createPool(url);
  if (ownsPool) pool.options.max = 1;
  const reader = new Pool({ connectionString: url, max: 1 });
  let authPool: Pool | undefined;
  let authDatabaseCreated = false;
  let authDatabaseCreation: Promise<void> | undefined;
  let standingResourceCreated = false;
  let standingResourceCreation: Promise<void> | undefined;
  let pendingOperation = 'create isolated Auth database';
  let closing: Promise<void> | undefined;
  const activeOperations = new Map<Promise<unknown>, string>();
  const startedAt = performance.now();
  let reportAuthQueries: (() => void) | undefined;

  function assertStarting(): void {
    if (closing) throw new Error(`Standing fixture is closing during ${pendingOperation}`);
  }

  async function startup<T>(operation: string, action: () => Promise<T>): Promise<T> {
    assertStarting();
    pendingOperation = operation;
    const phaseStartedAt = performance.now();
    console.error(
      '[standing-fixture]',
      JSON.stringify({ operation, state: 'start', elapsed: Math.round(phaseStartedAt - startedAt) }),
    );
    const work = Promise.resolve().then(action);
    activeOperations.set(work, operation);
    try {
      const result = await work;
      assertStarting();
      return result;
    } finally {
      activeOperations.delete(work);
      console.error(
        '[standing-fixture]',
        JSON.stringify({ operation, state: 'settled', elapsed: Math.round(performance.now() - phaseStartedAt) }),
      );
    }
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      reportAuthQueries?.();
      const failures: Error[] = [];
      async function settle(label: string, action: () => Promise<unknown>): Promise<void> {
        try {
          await action();
        } catch (error) {
          failures.push(new Error(`Failed to ${label}`, { cause: error }));
        }
      }

      for (const [work, operation] of activeOperations)
        await settle(`settle standing fixture operation ${operation}`, () => work);
      if (authDatabaseCreation) await settle('settle Auth database creation', () => authDatabaseCreation!);
      if (standingResourceCreation)
        await settle('settle standing resource table creation', () => standingResourceCreation!);
      if (authPool) await settle('close Auth pool', () => authPool!.end());
      if (standingResourceCreated)
        await settle('drop standing resource fixture table', () => reader.query('DROP TABLE public.standing_resource'));
      if (authDatabaseCreated)
        await settle('drop the fixture Auth database', () => dropTestDatabase(reader, authDatabase));
      if (ownsPool) await settle('close the owned command pool', () => pool.end());
      await settle('close the fixture reader pool', () => reader.end());

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Standing fixture cleanup failed');
    })();
    return closing;
  }

  try {
    configureTestReceiptKeys(pool);
    onLifecycle?.({
      get pendingOperation() {
        return pendingOperation;
      },
      run: startup,
      ready() {
        pendingOperation = 'ready';
      },
      close,
    });
    await startup('create isolated Auth database', async () => {
      authDatabaseCreation = reader.query(`CREATE DATABASE ${authDatabase}`).then(() => {
        authDatabaseCreated = true;
      });
      await authDatabaseCreation;
    });
    const { migrate } = await startup(
      'load Auth migration entry',
      () => import(new URL('../../../auth/scripts/database.ts', import.meta.url).href),
    );
    await startup('migrate isolated Auth database', async () => migrate(authUrl.toString()));
    const authDatabasePool = new Pool({ connectionString: authUrl.toString() });
    reportAuthQueries = traceTestPool(authDatabasePool, () => pendingOperation);
    authPool = authDatabasePool;
    const signingKey = await startup('generate Auth signing key', async () => ({
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'grant-command-fixture',
      alg: 'ES256',
    }));
    const issuer = 'https://auth.example.test';
    const audience = 'https://api.rezics.test';
    const password = 'correct horse battery staple';
    const actor = newId(0x1234);
    const principal = newId(0x2345);
    const recipient = newId(0x3456);
    const resource = { route: 0x6789, id: newId(0x6789) };
    const otherResource = { route: 0x789a, id: newId(0x789a) };
    const actions = [
      ...new Set([
        'subject:read',
        'subject:update',
        'subject:create',
        'access:grant',
        'account:delegate',
        'board:read',
        'board:manage',
        'thread:create',
        'thread:read',
        'post:create',
        'media:create',
        'post:read',
        'post:revise',
        'post:erase',
        'media:read_reservation',
        'media:read',
        'media:complete',
        'media:erase',
        'report:create',
        'moderation:takedown',
        'fixture:own',
        'unmounted:action',
        ...extraActions,
      ]),
    ];
    const ordinaryClientScopes = actions.filter((action) => action !== 'media:complete');
    const approvals = new Set([actor, principal, recipient]);
    const auth = await startup('compose real Auth service', () =>
      createAuthService({
        database: authDatabasePool,
        issuer,
        audience,
        secret: 'test-only-better-auth-secret-with-at-least-32-bytes',
        signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
        trustedAccess: trustedAccessPorts({
          async readAccount(id) {
            const account = await readAccount(reader, routeOf(id)!, id);
            return (
              account && {
                accountId: account.accountId,
                kind: account.kind,
                state: account.state,
                authnEpoch: Number(account.minimumAuthnEpoch),
                automated: account.operatorAccountId !== null,
              }
            );
          },
          async authorizeProvisioning(reference) {
            if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
            return { accountId: reference };
          },
        }),
      }),
    );
    for (const id of [actor, principal, recipient]) {
      await startup(`insert pending account ${id}`, () =>
        reader.query(
          `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','pending',$2)`,
          [routeOf(id), id],
        ),
      );
      await startup(`issue real Auth credential ${id}`, () =>
        auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password }),
      );
      await startup(`activate account ${id}`, () =>
        reader.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]),
      );
    }
    const declaredTypes: Readonly<Record<string, readonly string[]>> = {
      'subject:create': [
        'content.board',
        'content.thread',
        'content.post',
        'content.media',
        'content.report',
        'semantic.communal',
        'fixture.owned',
        'fixture.unmounted',
        'fixture.missing',
        'unknown.type',
      ],
      'thread:create': ['content.thread', 'content.post'],
      'post:create': ['content.post'],
    };
    const mountedActions = await startup('compose fixture action catalogue', async () =>
      actionCatalogue(testKernel({ pool })),
    );
    const fixtureActions = new Map(mountedActions);
    for (const action of actions) {
      const mounted = mountedActions.get(action);
      fixtureActions.set(action, {
        anonymous: mounted?.anonymous ?? false,
        ...(declaredTypes[action] === undefined ? {} : { 'x-resource-types': declaredTypes[action] }),
      });
    }
    await startup('register web Auth client', () =>
      registerTestClient(auth, {
        clientId: 'web',
        firstParty: true,
        actions: fixtureActions,
        scopes: ordinaryClientScopes,
      }),
    );
    await startup('register other Auth client', () =>
      registerTestClient(auth, {
        clientId: 'other-client',
        firstParty: true,
        actions: fixtureActions,
        scopes: ordinaryClientScopes,
      }),
    );
    const access = testAccess({
      pool,
      actions: fixtureActions,
      resourceRoles: {
        roles: { 'fixture.owner': ['fixture:own'], 'fixture.unmounted': ['unmounted:action'] },
        types: {
          'fixture.owned': { owner: 'fixture.owner', standing: [] },
          'semantic.communal': { standing: [] },
          'fixture.unmounted': { owner: 'fixture.unmounted', standing: [] },
          'fixture.missing': { standing: [] },
          'unknown.type': { standing: [] },
        },
      },
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/.well-known/jwks.json`,
        fetch: async (url, init) => auth.handler(new Request(url, init)),
      },
    });
    async function context(id = actor, scopes = ordinaryClientScopes, requestedBy?: string, clientId = 'web') {
      const response = await auth.handler(
        new Request(`${issuer}/signin`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify({
            email: `${id}@example.test`,
            password,
            client_id: clientId,
            scope: clientId === 'website' ? scopes : scopes.filter((action) => action !== 'media:complete'),
          }),
        }),
      );
      if (response.status !== 200) throw new Error(`Fixture sign-in failed: ${response.status}`);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await auth.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: '{}',
        }),
      );
      let token = ((await issued.json()) as { access_token: string }).access_token;
      // The trusted requested_by issuance seam is not composed yet. As in the
      // authenticate tests, only the fixture issuer can add this signed claim.
      if (requestedBy !== undefined)
        token = await new SignJWT({ ...decodeJwt<Record<string, unknown>>(token), requested_by: requestedBy })
          .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid, typ: 'at+jwt' })
          .sign(await importJWK(signingKey, 'ES256'));
      const boundary = { pool, deadline: Date.now() + 5000 };
      return {
        ...boundary,
        creation: {
          async validate(tx: AccessClient, target: Resource) {
            return (
              (
                await tx.query(
                  'SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()',
                  [target.route, target.id],
                )
              ).rowCount === 1
            );
          },
        },
        actor: await access.authenticate(token, boundary),
        bearer: token,
      };
    }
    async function grant(subject: string, action: string, target = resource, valid = '(,)') {
      await reader.query(
        `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,$5::tstzrange,$3)
      ON CONFLICT DO NOTHING`,
        [target.route, target.id, subject, action, valid],
      );
    }
    async function reset() {
      await reader.query('DELETE FROM public.standing_resource');
      await reader.query('INSERT INTO public.standing_resource VALUES ($1,$2)', [resource.route, resource.id]);
      await reader.query('DELETE FROM access.resource_grant');
      await reader.query('DELETE FROM access.resource_role_grant');
      await reader.query('DELETE FROM access.resource_denial');
      await reader.query('DELETE FROM access.principal_assignment');
      for (const id of [actor, principal, recipient]) {
        await reader.query(
          "UPDATE access.account SET state='active', authn_fenced=false WHERE route=$1 AND account_id=$2",
          [routeOf(id), id],
        );
        await grant(id, 'account:delegate', { route: routeOf(id)!, id });
      }
      for (const action of ['subject:read', 'subject:update', 'access:grant']) await grant(actor, action);
    }
    async function permitted(id: string, action: string, requestedBy?: string) {
      const ctx = await context(id, ordinaryClientScopes, requestedBy);
      const check = await accessCheck(access, ctx.actor, action, resource, ctx);
      return check(pool);
    }
    async function snapshot(route = resource.route) {
      const rows = await reader.query(
        `SELECT row_to_json(g) AS value FROM access.resource_grant g WHERE route=$1
      ORDER BY resource_id,subject_id,subject_role,action,valid`,
        [route],
      );
      const effects = await reader.query(
        `SELECT
      (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$1) AS receipts,
      (SELECT count(*)::integer FROM core.outbox WHERE partition_no=$1) AS events`,
        [partitionOf(route)],
      );
      return { rows: rows.rows, ...effects.rows[0] };
    }
    await startup('create standing resource table', async () => {
      standingResourceCreation = reader
        .query(
          'CREATE TABLE public.standing_resource (route integer NOT NULL, id uuid NOT NULL, creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(route,id))',
        )
        .then(() => {
          standingResourceCreated = true;
        });
      await standingResourceCreation;
    });
    async function parent() {
      return {
        resource,
        async validate(client: Pick<Pool, 'query'>) {
          return (
            (
              await client.query('SELECT 1 FROM public.standing_resource WHERE route=$1 AND id=$2', [
                resource.route,
                resource.id,
              ])
            ).rowCount === 1
          );
        },
      };
    }
    const edgeKey = await startup('generate Auth consent assertion key', () =>
      generateKeyPair('RS256', { extractable: true }),
    );
    const edgeJwk = { ...(await exportJWK(edgeKey.publicKey)), kid: 'standing-edge' };
    const readConsent: CurrentConsentReader = async (input) => {
      const edge = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [edgeJwk] }) });
      const edgeIssuer = edge.url.origin;
      const handler = createInternalConsentHandler({
        database: authDatabasePool,
        issuer: edgeIssuer,
        jwksUrl: `${edgeIssuer}/certs`,
        audience: 'standing-worker',
        allowedServiceTokenIds: ['worker.access'],
      });
      const read = createAuthConsentReader({
        url: 'https://standing-private.test/internal/v1/consents:read',
        serviceTokenId: 'worker.access',
        serviceTokenSecret: 'test-secret',
        async fetch(url, init) {
          const assertion = await new SignJWT({ type: 'app', sub: '', common_name: 'worker.access' })
            .setIssuer(edgeIssuer)
            .setAudience(['standing-worker'])
            .setIssuedAt()
            .setExpirationTime('1m')
            .setProtectedHeader({ alg: 'RS256', kid: 'standing-edge' })
            .sign(edgeKey.privateKey);
          const headers = new Headers(init.headers);
          headers.set('Cf-Access-Jwt-Assertion', assertion);
          return handler(new Request(url, { ...init, headers }));
        },
      });
      try {
        return await read(input);
      } finally {
        edge.stop(true);
      }
    };
    pendingOperation = 'ready';
    return {
      parent,
      pool,
      reader,
      access,
      readConsent,
      actor,
      principal,
      recipient,
      resource,
      otherResource,
      actions,
      context,
      grant,
      reset,
      permitted,
      snapshot,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Standing fixture failed during ${pendingOperation}`);
    }
    throw new Error(`Standing fixture failed during ${pendingOperation}`, { cause: error });
  }
}
