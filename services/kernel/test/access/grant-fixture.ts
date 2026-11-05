import { actionDeclarations } from './native-account-bindings-fixture.ts';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, importJWK, SignJWT, decodeJwt } from 'jose';
import { createAuthService } from '@rezics/auth';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { accessCheck } from '../../src/request/access.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

/** Real Auth issuance and production Access; SQL below is privileged fixture setup. */
export async function grantFixture(
  extraActions: readonly string[] = [],
  policyProfile?: Readonly<{ action: string; resourceType: string }>,
) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  const pool = createPool(url);
  pool.options.max = 1;
  const reader = new Pool({ connectionString: url, max: 1 });
  const authDatabase = `grant_auth_${process.pid}`;
  const authUrl = new URL(url);
  authUrl.pathname = `/${authDatabase}`;
  await reader.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  const authPool = new Pool({ connectionString: authUrl.toString() });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'grant-command-fixture',
    alg: 'ES256',
  };
  const issuer = 'https://auth.example.test';
  const audience = 'https://api.rezics.test';
  const password = 'correct horse battery staple';
  const actor = newId(0x1234);
  const principal = newId(0x2345);
  const recipient = newId(0x3456);
  const resource = { route: 0x6789, id: newId(0x6789) };
  const otherResource = { route: 0x789a, id: newId(0x789a) };
  const actions = [...new Set(['subject:read', 'subject:update', 'access:grant', 'account:delegate', ...extraActions])];
  const approvals = new Set([actor, principal, recipient]);
  const auth = await createAuthService({
    database: authPool,
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
  });
  await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: actions });
  await auth.internal.registerClient({ clientId: 'other-client', firstParty: true, scopes: actions });
  for (const id of [actor, principal, recipient]) {
    await reader.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','pending',$2)`,
      [routeOf(id), id],
    );
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await reader.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
  }
  const declaredActions = actionDeclarations(actions);
  if (policyProfile) {
    const metadata = declaredActions.get(policyProfile.action)!;
    declaredActions.set(policyProfile.action, {
      ...metadata,
      'x-resource-types': [policyProfile.resourceType],
    });
  }
  const access = createAccess({
    actions: declaredActions,
    ...(policyProfile
      ? {
          resourceRoles: {
            roles: { 'fixture.permission.reader': [policyProfile.action] },
            types: {
              [policyProfile.resourceType]: { owner: 'fixture.permission.reader', standing: [] },
            },
          },
        }
      : {}),
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (url, init) => auth.handler(new Request(url, init)),
    },
  });
  async function context(id = actor, scopes = actions, requestedBy?: string, clientId = 'web') {
    const response = await auth.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${id}@example.test`, password, client_id: clientId, scope: scopes }),
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
    return { ...boundary, actor: await access.authenticate(token, boundary) };
  }
  async function grant(subject: string, action: string, target = resource, valid = '(,)') {
    await reader.query(
      `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,$5::tstzrange,$3)`,
      [target.route, target.id, subject, action, valid],
    );
  }
  async function reset() {
    await reader.query('DELETE FROM access.resource_grant');
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
    const ctx = await context(id, actions, requestedBy);
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
  let closing: Promise<void> | undefined;
  return {
    pool,
    reader,
    access,
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
    close() {
      // Repeated teardown shares one Auth pool close and one exact database drop.
      closing ??= (async () => {
        try {
          await authPool.end();
          await dropTestDatabase(reader, authDatabase);
        } finally {
          try {
            await pool.end();
          } finally {
            await reader.end();
          }
        }
      })();
      return closing;
    },
  };
}
