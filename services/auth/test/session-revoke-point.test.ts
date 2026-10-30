import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount } from '../src/index.ts';
import { assertGrowthAccessPaths, checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://session-point.auth.test';
const password = 'native session point correct horse battery staple';

async function nativeAuth(pool: Pool, admin = pool) {
  const accounts = new Map<string, AccessAccount>();
  let afterTargetRead: (() => Promise<void>) | undefined;
  // Schedule real database mutations after the actual owner read has completed.
  // No query result, proof, adapter or authentication outcome is substituted.
  const database = new Proxy(pool, {
    get(target, property) {
      if (property === 'query')
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.query, target, args);
          if (args[0] === 'SELECT "userId" FROM session WHERE id=$1' && afterTargetRead) {
            const change = afterTargetRead;
            afterTargetRead = undefined;
            await change();
          }
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'point',
  };
  const auth = await createAuthService({
    database,
    issuer,
    audience: 'https://session-point.api.test',
    secret: 'native-session-point-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      readAccount: async (id) => accounts.get(id) ?? null,
      authorizeProvisioning: async (id) => ({ accountId: id }),
    }),
  });
  await auth.internal.registerClient({ clientId: 'point-web', firstParty: true, scopes: ['read'] });
  const request = (path: string, cookie = '', body?: unknown) =>
    auth.handler(
      new Request(`${issuer}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  async function person() {
    const id = randomUUID();
    const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', automated: false, authnEpoch: 1 };
    accounts.set(id, account);
    await auth.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    account.state = 'active';
    return account;
  }
  async function signin(owner: string) {
    const response = await request('/signin', '', {
      account_id: owner,
      password,
      client_id: 'point-web',
      scope: ['read'],
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const listed = await request('/sessions', cookie);
    expect(listed.status).toBe(200);
    const { sessions } = await listed.json();
    const id = sessions.find((entry: { current: boolean }) => entry.current).id as string;
    return { id, cookie };
  }
  return {
    person,
    signin,
    request,
    revoke: (id: string, cookie: string) => request('/sessions/revoke', cookie, { session_id: id }),
    changeAfterOwnerRead(change: () => Promise<void>) {
      afterTargetRead = change;
    },
    snapshot: async () => (await admin.query('SELECT * FROM session ORDER BY id')).rows,
  };
}

async function withNative(run: (f: Awaited<ReturnType<typeof nativeAuth>>, database: Pool) => Promise<void>) {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url });
  try {
    await run(await nativeAuth(database), database);
  } finally {
    await database.end();
    fixture.close();
  }
}

test('authenticated human can revoke only the exact owned session while unknown and foreign ids preserve 404 and all other sessions', async () => {
  await withNative(async (f, database) => {
    const owner = await f.person();
    const caller = await f.signin(owner.accountId);
    const target = await f.signin(owner.accountId);
    const expired = await f.signin(owner.accountId);
    const foreign = await f.signin((await f.person()).accountId);
    await database.query('UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [expired.id]);
    const before = await f.snapshot();
    for (const id of [foreign.id, randomUUID()]) {
      const response = await f.revoke(id, caller.cookie);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'authentication_denied' });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await f.snapshot()).toEqual(before);
    }
    for (const cookie of ['', 'better-auth.session_token=invalid', expired.cookie]) {
      expect((await f.revoke(target.id, cookie)).status).toBe(401);
      expect(await f.snapshot()).toEqual(before);
    }
    for (const patch of [{ automated: true }, { fenced: true }, { state: 'suspended' as const }, { authnEpoch: 2 }]) {
      const saved = { ...owner };
      Object.assign(owner, patch);
      expect((await f.revoke(target.id, caller.cookie)).status).toBe(401);
      Object.assign(owner, saved);
      delete owner.fenced;
      expect(await f.snapshot()).toEqual(before);
    }
    const response = await f.revoke(target.id, caller.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await f.snapshot()).toEqual(before.filter((row) => row.id !== target.id));
    expect((await f.request('/session', target.cookie)).status).toBe(401);
    expect((await f.request('/session', caller.cookie)).status).toBe(200);
    expect((await f.request('/session', foreign.cookie)).status).toBe(200);
    expect((await f.request('/session', expired.cookie)).status).toBe(401);
    // An expired exact owned target remains revocable, without history cleanup.
    expect((await f.revoke(expired.id, caller.cookie)).status).toBe(200);
    expect(await f.snapshot()).toEqual(before.filter((row) => ![target.id, expired.id].includes(row.id)));
    expect((await f.revoke(target.id, caller.cookie)).status).toBe(404);
  });
}, 60000);

test('revoking the current native session clears exactly the existing cookies and immediately invalidates its proof while other session behavior stays unchanged', async () => {
  await withNative(async (f) => {
    const owner = await f.person();
    const current = await f.signin(owner.accountId);
    const other = await f.signin(owner.accountId);
    const foreign = await f.signin((await f.person()).accountId);
    const before = await f.snapshot();
    expect((await f.request('/session', current.cookie)).status).toBe(200);
    const response = await f.revoke(current.id, current.cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(response.headers.get('cache-control')).toBe('no-store');
    const cookies = response.headers.getSetCookie();
    expect(cookies.map((value) => value.split('=')[0]).sort()).toEqual([
      '__Secure-better-auth.dont_remember',
      '__Secure-better-auth.session_data',
      '__Secure-better-auth.session_token',
    ]);
    for (const cookie of cookies) {
      expect(cookie).toContain('=;');
      expect(cookie).toMatch(/Max-Age=0/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    }
    expect(await f.snapshot()).toEqual(before.filter((row) => row.id !== current.id));
    expect((await f.request('/session', current.cookie)).status).toBe(401);
    expect((await f.request('/token', current.cookie, {})).status).toBe(401);
    expect((await f.revoke(other.id, current.cookie)).status).toBe(401);
    expect((await f.request('/session', other.cookie)).status).toBe(200);
    expect((await f.request('/session', foreign.cookie)).status).toBe(200);
    expect((await f.request('/token', other.cookie, {})).status).toBe(200);
  });
}, 60000);

test('native owner mismatch and concurrent state changes never turn a bounded point deletion into a foreign mutation', async () => {
  await withNative(async (f, database) => {
    const owner = await f.person();
    const caller = await f.signin(owner.accountId);
    const foreign = await f.signin((await f.person()).accountId);
    for (const change of ['immutable', 'expiry', 'delete', 'replace'] as const) {
      const target = await f.signin(owner.accountId);
      let beforeMutation: Awaited<ReturnType<typeof f.snapshot>> = [];
      let changed = false;
      f.changeAfterOwnerRead(async () => {
        changed = true;
        if (change === 'immutable') {
          for (const [column, value] of [
            ['"userId"', foreign.id],
            ['id', randomUUID()],
          ] as const)
            await expect(
              database.query(`UPDATE session SET ${column}=$2 WHERE id=$1`, [target.id, value]),
            ).rejects.toMatchObject({ code: '55000', message: 'Session identity is immutable' });
        } else if (change === 'expiry') {
          await database.query('UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [target.id]);
        } else {
          await database.query('DELETE FROM session WHERE id=$1', [target.id]);
          if (change === 'replace') {
            // Reuse a deleted key with a genuine foreign native session's data.
            // This deliberately crosses the pre-read/DELETE gap; owner immutability
            // alone cannot protect a later statement from key reuse.
            await database.query(
              `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
               SELECT $1,$1,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods"
               FROM session WHERE id=$2`,
              [target.id, foreign.id],
            );
          }
        }
        beforeMutation = await f.snapshot();
      });
      const response = await f.revoke(target.id, caller.cookie);
      expect(changed).toBe(true);
      // Once the original owner lookup succeeds, a concurrently absent target
      // remains a successful no-op, as does a replacement with another owner.
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await f.snapshot()).toEqual(
        change === 'replace' ? beforeMutation : beforeMutation.filter((row) => row.id !== target.id),
      );
      expect((await f.request('/session', caller.cookie)).status).toBe(200);
      expect((await f.request('/session', foreign.cookie)).status).toBe(200);
      if (change === 'replace') expect((await f.revoke(target.id, caller.cookie)).status).toBe(404);
    }
  });
}, 60000);

test('native session revoke examines a fixed exact session neighborhood as the same owner expired and unrelated sessions grow at the original scales', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    const f = await nativeAuth(db.pool, db.admin);
    let selected: { caller: string; id: string; owner: string };
    // A fresh native caller and target are prepared after the harness settles,
    // on every physical invocation (including cold-backend discards). Neither
    // a vacuum's aborted DELETE nor an earlier warmup can consume the target.
    async function prepare(scale: number) {
      const owner = (await f.person()).accountId;
      const caller = await f.signin(owner);
      const target = await f.signin(owner);
      const connection = await db.admin.connect();
      try {
        await connection.query('BEGIN');
        // Existing native legacy-history contract: fixtures alone bypass the
        // insertion cap, restoring it before any production request executes.
        await connection.query('ALTER TABLE session DISABLE TRIGGER session_capacity');
        await connection.query('UPDATE "user" SET sessions_bounded=false WHERE id=$1', [owner]);
        await connection.query(
          `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
           SELECT $1||'-history-'||i,$1||'-history-'||i,$1,'point-web',
             CASE WHEN i<=62 THEN '2099-01-01'::timestamptz ELSE '2000-01-01'::timestamptz END,
             now(),'read',1,1,'pwd' FROM generate_series(1,$2::int+62) i`,
          [owner, scale * 1000],
        );
        await connection.query('ALTER TABLE session ENABLE TRIGGER session_capacity');
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      selected = { caller: caller.cookie, id: target.id, owner };
    }
    async function operation() {
      expect((await db.admin.query('SELECT id FROM session WHERE id=$1', [selected.id])).rowCount).toBe(1);
      const response = await f.revoke(selected.id, selected.caller);
      expect(response.status).toBe(200);
      const output = await response.text();
      expect(output).toBe('{}');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect((await db.admin.query('SELECT id FROM session WHERE id=$1', [selected.id])).rowCount).toBe(0);
      const retained = await db.admin.query(
        `SELECT count(*) FILTER (WHERE "expiresAt">now())::int AS live,
                count(*) FILTER (WHERE "expiresAt"<=now())::int AS expired FROM session WHERE "userId"=$1`,
        [selected.owner],
      );
      expect(retained.rows[0].live).toBe(63);
      return { output: output.length, expired: retained.rows[0].expired };
    }
    const report = await checkGrowth(db, {
      name: 'native exact session revoke with fresh target and retained owner history',
      scales: [1, 8, 64],
      repetitions: 3,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      includeBackends: true,
      counted: {
        read: (value) => ({ output: (value as { output: number }).output }),
        limits: { output: 2, connections: 1 },
        bounds: { output: 'constant', connections: 'constant' },
      },
      async grow(_, scale, previous) {
        // Same original unrelated population, without inflating a seed floor or
        // changing planner options. Actual measured layouts govern path checks.
        await db.admin.query(
          `INSERT INTO "user" (id,name,"emailVerified") SELECT 'unrelated-'||i,'',false
           FROM generate_series($1::int,$2::int) i`,
          [previous * 1000 + 1, scale * 1000],
        );
        await db.admin.query(
          `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
           SELECT 'unrelated-'||i,'unrelated-'||i,'unrelated-'||i,'point-web','2099-01-01',now(),'read',1,1,'pwd'
           FROM generate_series($1::int,$2::int) i`,
          [previous * 1000 + 1, scale * 1000],
        );
      },
      prepare: (_, scale) => prepare(scale),
      async warmup(_, scale) {
        await prepare(scale);
        expect((await operation()).expired).toBe(scale * 1000);
      },
      async operation(_, scale) {
        const value = await operation();
        expect(value.expired).toBe(scale * 1000);
        return value;
      },
    });
    assertGrowthAccessPaths(report.name, report.samples, [
      'public.session',
      'public.user',
      'public.auth_client',
      'public.auth_client_coverage',
      'public.auth_client_reduction',
      'public.auth_consent',
    ]);
    const plans = [];
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.rows).toBeLessThanOrEqual(32);
        expect(cost.statements).toBeGreaterThanOrEqual(5);
        expect(cost.controlStatements).toBe(0);
      }
      for (const [rep, occurrences] of sample.occurrenceRepetitions.entries()) {
        const deletion = occurrences.statements.filter((entry) => /^DELETE FROM session\b/i.test(entry.statement));
        expect(deletion).toHaveLength(1);
        expect(deletion[0]!.planDocuments.length).toBeGreaterThan(0);
        expect(deletion[0]!.rows).toBeLessThanOrEqual(2);
        // Use only the shared harness's occurrence-linked native documents;
        // retain every nested node and never reassign a plan by SQL text.
        plans.push({ scale: sample.scale, rep, ...deletion[0] });
      }
    }
    console.info('Native session revoke proof:', JSON.stringify({ report, plans }));
  } finally {
    await db.close();
    fixture.close();
  }
}, 240000);
