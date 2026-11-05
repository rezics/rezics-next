import { Client, Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthService } from '@rezics/auth';
import { createAuthDatabase } from '../support/auth-database.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/index.ts';
import { createDelegationCommands, type AssignmentInput } from '../../src/access/delegation-commands.ts';
import { routeOf } from '../../src/route/route.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `assignment_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

/** Positive verifier fixtures need the same principal command provenance as production. */
export async function delegatedAssignmentFixture(pool: Pool) {
  const fixture = await cloneAuthDatabase();
  const database = new Pool({ connectionString: fixture.url });
  const issuer = 'https://assignment-fixture.auth.test';
  const password = 'correct horse battery staple';
  const action = 'account:delegate';
  const provisioned = new Set<string>();
  const approvals = new Set<string>();
  try {
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'assignment-fixture',
      alg: 'ES256',
    };
    const auth = await createAuthService({
      database,
      issuer,
      audience: 'https://api.rezics.test',
      secret: 'assignment-fixture-secret-with-at-least-thirty-two-characters',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        async readAccount(id) {
          const account = await readAccount(pool, routeOf(id)!, id);
          return (
            account && {
              accountId: account.accountId,
              kind: account.kind,
              state: account.state,
              authnEpoch: Number(account.minimumAuthnEpoch),
              automated: account.operatorAccountId !== null,
              fenced: account.fenced,
            }
          );
        },
        async authorizeProvisioning(reference) {
          if (!approvals.delete(reference)) throw new Error('No fixture provisioning approval');
          return { accountId: reference };
        },
      }),
    });
    await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes: [action] });
    const access = createAccess({
      actions: new Map([[action, { anonymous: false }]]),
      auth: {
        ...auth.verifier,
        fetch: async (url, init) => auth.handler(new Request(url, init)),
      },
    });
    const commands = createDelegationCommands({ pool, access, action });
    async function request(path: string, body: unknown, cookie = '') {
      const response = await auth.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        }),
      );
      if (response.status !== 200) throw new Error(`Assignment fixture ${path} failed: ${response.status}`);
      return response;
    }
    return {
      async create(input: Omit<AssignmentInput, 'key'>) {
        const id = input.principalId;
        if (!provisioned.has(id)) {
          await pool.query("UPDATE access.account SET state='pending' WHERE route=$1 AND account_id=$2", [
            routeOf(id),
            id,
          ]);
          approvals.add(id);
          await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
          await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
            routeOf(id),
            id,
          ]);
          provisioned.add(id);
        }
        await pool.query(
          `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
          VALUES ($1,$2,$2,$3,'(,)',$2)`,
          [routeOf(id), id, action],
        );
        const login = await request('/signin', { account_id: id, password, client_id: 'web', scope: [action] });
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const issued = await request('/token', {}, cookie);
        const token = ((await issued.json()) as { access_token: string }).access_token;
        const context = { pool, deadline: Date.now() + 5000 };
        const actor = await access.authenticate(token, context);
        return commands.create({ ...context, actor }, { ...input, key: Bun.randomUUIDv7() });
      },
      async close() {
        await database.end();
        await fixture.close();
      },
    };
  } catch (error) {
    await database.end();
    await fixture.close();
    throw error;
  }
}
