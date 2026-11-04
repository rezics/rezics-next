import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { composeSecurityPage } from '../src/security-page.ts';

const now = Math.floor(Date.now() / 1000);
const viewer = {
  account_id: 'owner',
  session_id: 'current',
  client_id: 'login',
  fresh: true,
  credentialCommands: true,
  passwordCommands: true,
  now,
};
const session = {
  id: 'current',
  client_id: 'login',
  client_display_name: 'REZICS Account',
  created_at: new Date(now * 1000),
  expires_at: new Date((now + 3600) * 1000),
  user_agent: null,
};
const passkey = { id: 'key', name: null, created_at: new Date(now * 1000), last_used_at: null };
function database(options: { sessions?: unknown[]; passkeys?: unknown[]; password?: boolean; fail?: string } = {}) {
  const reads: unknown[][] = [];
  return {
    reads,
    pool: {
      async query(sql: string, params: unknown[]) {
        reads.push(params);
        if (sql.includes(options.fail ?? 'never match')) throw new Error('dependency unavailable');
        return {
          rows: sql.includes('FROM session')
            ? (options.sessions ?? [session])
            : sql.includes('FROM passkey')
              ? (options.passkeys ?? [passkey])
              : options.password
                ? [{ id: 'password' }]
                : [],
        };
      },
    } as unknown as Pool,
  };
}
test('one native owner projection validates rows, current session, native freshness and last credential advice', async () => {
  const db = database();
  const page = await composeSecurityPage(db.pool, viewer);
  expect(page.viewer).toEqual({ account_id: 'owner', session_id: 'current', client_id: 'login' });
  expect(page.sessions.kind === 'ready' && page.sessions.rows[0]?.current).toBe(true);
  expect(page.passkeys.kind === 'ready' && page.passkeys.rows[0]).toMatchObject({
    name: '',
    remove: 'last-credential',
  });
  expect(db.reads.every((params) => params[0] === 'owner')).toBe(true);
  const stale = await composeSecurityPage(database({ password: true }).pool, { ...viewer, fresh: false });
  expect(stale.actions.change_password).toBe('step-up-required');
  expect(stale.passkeys.kind === 'ready' && stale.passkeys.rows[0]?.remove).toBe('step-up-required');
});
test('a failed or malformed inventory stays unavailable while the other inventory remains usable', async () => {
  const failed = await composeSecurityPage(database({ fail: 'FROM passkey' }).pool, viewer);
  expect(failed.passkeys).toEqual({ kind: 'unavailable' });
  expect(failed.actions.register_passkey).toBe('unavailable');
  expect(failed.sessions.kind).toBe('ready');
  const malformed = await composeSecurityPage(database({ sessions: [session, session] }).pool, viewer);
  expect(malformed.sessions).toEqual({ kind: 'unavailable' });
  expect(malformed.passkeys.kind).toBe('ready');
});
test('sentinels declare truncation and capacity, including unnamed credentials without inventing last use', async () => {
  const rows = Array.from({ length: 33 }, (_, i) => ({ ...passkey, id: `key-${i}` }));
  const page = await composeSecurityPage(database({ passkeys: rows }).pool, viewer);
  expect(page.passkeys.kind === 'ready' && page.passkeys.rows).toHaveLength(32);
  expect(page.passkeys.kind === 'ready' && page.passkeys.truncated).toBe(true);
  expect(page.actions.register_passkey).toBe('capacity');
});

test('the existing native route revokes only a selected owned session and the next page retires its advice', async () => {
  const { databaseCheck, testDatabase } = await import('../scripts/database.ts');
  expect(
    await databaseCheck(['bun', 'test', 'test/security-page.test.ts'], async () => {
      const { Pool } = await import('pg');
      const { randomUUID } = await import('node:crypto');
      const { exportJWK, generateKeyPair } = await import('jose');
      const { createAuthService } = await import('../src/index.ts');
      const { trustedAccessPorts } = await import('./support/trusted-access.ts');
      const fixture = testDatabase();
      const pool = new Pool({ connectionString: fixture.url });
      try {
        const ids = [randomUUID(), randomUUID()];
        const accounts = new Map(
          ids.map((id) => [
            id,
            {
              accountId: id,
              kind: 'actor' as const,
              state: 'pending' as 'pending' | 'active',
              authnEpoch: 1,
              automated: false,
            },
          ]),
        );
        const key = {
          ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
          kid: 'security',
        };
        const issuer = 'https://security.auth.test';
        const auth = await createAuthService({
          database: pool,
          issuer,
          audience: 'https://security.api.test',
          secret: 'security-page-native-test-secret-at-least-32-bytes',
          signing: { activeKid: key.kid, privateKeys: [key] },
          trustedAccess: trustedAccessPorts({
            readAccount: async (id) => accounts.get(id) ?? null,
            authorizeProvisioning: async (id) => ({ accountId: id }),
          }),
        });
        const request = (path: string, cookie = '', body?: unknown) =>
          auth.handler(
            new Request(`${issuer}${path}`, {
              method: body === undefined ? 'GET' : 'POST',
              headers: { origin: issuer, cookie, 'content-type': 'application/json' },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        const client = randomUUID();
        await auth.internal.registerClient({ clientId: client, firstParty: true, scopes: ['read'] });
        for (const id of ids) {
          await auth.internal.provisionPassword({
            authorization: id,
            email: `${id}@example.test`,
            password: 'correct horse battery staple',
          });
          accounts.get(id)!.state = 'active';
        }
        const signin = async (id: string) => {
          const response = await request('/signin', '', {
            account_id: id,
            password: 'correct horse battery staple',
            client_id: client,
            scope: ['read'],
          });
          expect(response.status).toBe(200);
          return response.headers
            .getSetCookie()
            .map((cookie) => cookie.split(';')[0])
            .join('; ');
        };
        const owner = await signin(ids[0]!);
        const another = await signin(ids[0]!);
        const foreign = await signin(ids[1]!);
        const before = await (await request('/security-page', owner)).json();
        expect(before.sessions.kind).toBe('ready');
        const selected = before.sessions.rows.find((row: { current: boolean }) => !row.current);
        expect(selected.revoke).toBe('allowed');
        expect((await request('/sessions/revoke', foreign, { session_id: selected.id })).status).toBe(404);
        expect((await request('/security-page?account_id=foreign', owner)).status).toBe(400);
        expect((await request('/sessions/revoke', owner, { session_id: selected.id })).status).toBe(200);
        const after = await (await request('/security-page', owner)).json();
        expect(after.sessions.rows.map((row: { id: string }) => row.id)).not.toContain(selected.id);
        expect((await request('/security-page', another)).status).toBe(401);
        const ended = await request('/sessions/revoke', owner, { session_id: after.viewer.session_id });
        expect(ended.status).toBe(200);
        expect(ended.headers.getSetCookie().some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
        expect((await request('/security-page', owner)).status).toBe(401);
        return 0;
      } finally {
        await pool.end();
        fixture.close();
      }
    }),
  ).toBe(0);
}, 300000);
