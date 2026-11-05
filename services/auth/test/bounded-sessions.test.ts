import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, decodeJwt, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { runPlacedTests } from '../scripts/placed-tests.ts';
import { betterAuthOptions } from '../src/better-auth.ts';
import { withAuthTransport } from '../src/rate-limit.ts';
let peerSequence = 0;
const nextPeer = () => `192.0.2.${++peerSequence}`;
import {
  createAuthService,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type CredentialEffectAuthorization,
  type CredentialEffectBinding,
} from '../src/index.ts';

// Exercise native production defaults in a fresh module graph.
if (process.env.NODE_ENV !== 'production') {
  test('bounded production behavior preserves security outcomes', async () => {
    const child = await runPlacedTests(['bun', 'test', 'test/bounded-sessions.test.ts'], {
      cwd: import.meta.dir + '/..',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    if (child.output) console.info(child.output);
    expect(child.code).toBe(0);
  }, 120000);
} else {
  let db: ReturnType<typeof testDatabase>;
  let pool: Pool;
  let other: Pool;
  beforeAll(() => {
    db = testDatabase();
    pool = new Pool({ connectionString: db.url });
    other = new Pool({ connectionString: db.url });
  }, 60000);
  afterAll(async () => {
    await other?.end();
    await pool?.end();
    db?.close();
  }, 30000);

  const issuer = 'https://bounded.auth.test';
  const secret = 'bounded-session-tests-persistent-secret-at-least-32';
  const password = 'correct horse battery staple';
  async function nativeOwner(database: Pool, id: string) {
    await database.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'',NULL,false)`, [id]);
    await database.query(
      `INSERT INTO auth_client VALUES ('bounded-native',true,ARRAY['read','write']) ON CONFLICT DO NOTHING`,
    );
  }
  function native(database: Pool) {
    return betterAuth(betterAuthOptions(database, issuer, secret));
  }
  async function insertNative(database: Pool, userId: string, expired = false) {
    const ctx = await native(database).$context;
    return ctx.internalAdapter.createSession(
      userId,
      false,
      {
        clientId: 'bounded-native',
        grantedScope: 'read',
        authnEpoch: 1,
        authTime: 123,
        authMethods: 'pwd',
        ...(expired ? { expiresAt: new Date(0) } : {}),
      },
      true,
    );
  }
  async function count(id: string) {
    return Number((await pool.query('SELECT count(*) FROM session WHERE "userId"=$1', [id])).rows[0].count);
  }
  async function credentialEffect(
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

  test('two native instances atomically evict the deterministic oldest stored row, including expired rows; rollback retains it', async () => {
    await nativeOwner(pool, 'capacity');
    for (let i = 0; i < 64; i++) await insertNative(pool, 'capacity', true);
    await pool.query(`UPDATE session SET "createdAt"='2000-01-01' WHERE "userId"='capacity'`);
    const oldest = (
      await pool.query(`SELECT id FROM session WHERE "userId"='capacity' ORDER BY "createdAt",id LIMIT 12`)
    ).rows;
    await nativeOwner(pool, 'isolated');
    await insertNative(other, 'isolated', true);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => insertNative(i % 2 ? other : pool, 'capacity')),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(await count('capacity')).toBe(64);
    expect((await pool.query('SELECT id FROM session WHERE id=ANY($1)', [oldest.map((r) => r.id)])).rows).toEqual([]);
    expect(await count('isolated')).toBe(1);
    const before = (await pool.query(`SELECT * FROM session WHERE "userId"='capacity' ORDER BY id`)).rows;
    await expect(
      pool.query(
        `INSERT INTO session SELECT id,"expiresAt",token,"createdAt","updatedAt","ipAddress","userAgent","userId","clientId","grantedScope","authnEpoch","authTime","authMethods" FROM session WHERE "userId"='capacity' LIMIT 1`,
      ),
    ).rejects.toThrow();
    expect((await pool.query(`SELECT * FROM session WHERE "userId"='capacity' ORDER BY id`)).rows).toEqual(before);
    // Fresh native context has no in-memory capacity state.
    await insertNative(other, 'capacity');
    expect(await count('capacity')).toBe(64);
    await (await native(other).$context).internalAdapter.deleteUserSessions('capacity');
    expect(await count('capacity')).toBe(0);
    expect(await count('isolated')).toBe(1);
  }, 30000);

  test('production service preserves expiry, auth_time, scopes, JWT lifetime and Access-first epoch denial across eviction', async () => {
    const signing = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(signing.privateKey)), kid: 'bounded-signing', alg: 'ES256' };
    const accounts = new Map<string, AccessAccount>();
    let unavailable = false;
    const options: AuthServiceOptions = {
      database: pool,
      issuer,
      audience: 'https://bounded.api.test',
      secret,
      signing: { activeKid: jwk.kid, privateKeys: [jwk] },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return this.readAccount(id);
        },
        async readAccount(id) {
          if (unavailable) throw new Error('Access unavailable');
          return accounts.get(id) ?? null;
        },
        async authorizeProvisioning(id) {
          return { accountId: id };
        },
        async invalidateAccount({ accountId, previousEpoch }) {
          if (unavailable) throw new Error('Access barrier unavailable');
          const account = accounts.get(accountId)!;
          expect(account.authnEpoch).toBe(previousEpoch);
          account.authnEpoch++;
          return { accountId, minimumAuthnEpoch: account.authnEpoch, receiptId: `floor-${accountId}` };
        },
      }),
    };
    const first = await createAuthService(options);
    const second = await createAuthService({ ...options, database: other });
    await first.internal.registerClient({ clientId: 'bounded-web', firstParty: true, scopes: ['read', 'write'] });
    accounts.set('human', { accountId: 'human', state: 'pending', kind: 'actor', authnEpoch: 1, automated: false });
    await first.internal.provisionPassword({ authorization: 'human', email: 'human@bounded.test', password });
    accounts.get('human')!.state = 'active';
    await first.internal.registerClient({ clientId: 'bounded-external', firstParty: false, scopes: ['read', 'write'] });
    const request = (path: string, body?: unknown, cookie = '', target = first) =>
      withAuthTransport(nextPeer(), () =>
        target.handler(
          new Request(issuer + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { origin: issuer, 'content-type': 'application/json', cookie },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      );
    const login = async () => {
      const response = await request('/signin', {
        email: 'human@bounded.test',
        password,
        client_id: 'bounded-web',
        scope: ['read'],
      });
      expect(response.status).toBe(200);
      return response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    };
    const cookie = await login();
    await (await request('/session', undefined, cookie)).json();
    const jwt = (await (await request('/token', {}, cookie)).json()) as { access_token: string };
    const claims = decodeJwt(jwt.access_token);
    expect(claims.exp! - claims.iat!).toBe(300);
    await pool.query(`UPDATE session SET "expiresAt"='2000-01-01' WHERE "userId"='human'`);
    expect((await request('/session', undefined, cookie, second)).status).toBe(401);
    // Paused maintenance cannot grow expired history, even for an inactive owner.
    for (let i = 0; i < 70; i++) await insertNative(pool, 'human', true);
    expect(await count('human')).toBe(64);
    const currentCookie = await login();
    const currentProof = await (await request('/session', undefined, currentCookie)).json();
    await insertNative(other, 'human');
    expect(await (await request('/session', undefined, currentCookie)).json()).toEqual(currentProof);
    expect(currentProof).toMatchObject({ scope: ['read'], authn_epoch: 1 });
    unavailable = true;
    const before = await count('human');
    expect(
      (await request('/consent', { client_id: 'bounded-external', scope: ['read'] }, currentCookie)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await count('human')).toBe(before);
    unavailable = false;
    accounts.get('human')!.authnEpoch++;
    // Refresh must never upgrade old evidence to the new floor.
    expect((await request('/session', undefined, currentCookie, second)).status).toBe(401);
    expect((await request('/token', {}, currentCookie, second)).status).toBe(401);
    expect(decodeJwt(jwt.access_token)).toEqual(claims);
    await second.internal.revokeSessions('human');
    expect(await count('human')).toBe(0);
  }, 30000);

  test('expiry maintenance admits one indexed page, skips locks without scanning beyond admission and validates batches', async () => {
    const { pruneExpiredSessions } = await import('../src/session-limits.ts');
    await nativeOwner(pool, 'maintenance');
    for (let i = 0; i < 8; i++) await insertNative(pool, 'maintenance', true);
    await pool.query(`UPDATE session SET "expiresAt"='1900-01-01' WHERE "userId"='maintenance'`);
    const lock = await other.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM session ORDER BY "expiresAt",id LIMIT 4 FOR UPDATE');
      expect(await pruneExpiredSessions(pool, 4)).toBe(0);
      await lock.query('ROLLBACK');
      expect(await pruneExpiredSessions(pool, 4)).toBe(4);
      expect(await count('maintenance')).toBe(4);
      for (const batch of [0, 1001, 1.5, NaN]) await expect(pruneExpiredSessions(pool, batch)).rejects.toThrow();
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  test('legacy deployment upgrades without loading history; trimming is resumable and revocation/erasure stay behind the barrier', async () => {
    const { mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { migrate } = await import('../scripts/database.ts');
    const { trimSessionHistory, sessionUpgradePage } = await import('../src/session-limits.ts');
    mkdirSync('.temp', { recursive: true });
    const directory = mkdtempSync(resolve('.temp/session-upgrade-'));
    const fixture = testDatabase();
    const database = new Pool({ connectionString: fixture.url });
    try {
      const migrations = resolve(import.meta.dir, '../db/migrations');
      for (const file of readdirSync(migrations))
        if (!file.endsWith('_bounded_sessions.sql')) copyFileSync(resolve(migrations, file), resolve(directory, file));
      await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      migrate(fixture.url, directory);
      await nativeOwner(database, 'legacy');
      await database.query(`INSERT INTO session (id,token,"userId","clientId","expiresAt","createdAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
      SELECT 'legacy-'||i,'legacy-'||i,'legacy','bounded-native','2000-01-01','2000-01-01'::timestamptz+i*interval '1 second',now(),'read',1,123,'pwd' FROM generate_series(1,2100) i`);
      migrate(fixture.url);
      const ctx = await native(database).$context;
      expect(await sessionUpgradePage(database, '', 1)).toEqual(['legacy']);
      expect(await sessionUpgradePage(database, 'legacy', 1)).toEqual([]);
      await expect(
        ctx.internalAdapter.createSession('legacy', false, {
          clientId: 'bounded-native',
          grantedScope: 'read',
          authnEpoch: 1,
          authTime: 123,
          authMethods: 'pwd',
        }),
      ).rejects.toThrow();
      await expect(ctx.internalAdapter.deleteUserSessions('legacy')).rejects.toThrow();
      await expect(database.query(`DELETE FROM "user" WHERE id='legacy'`)).rejects.toThrow();
      const rows = async () =>
        Number((await database.query(`SELECT count(*) FROM session WHERE "userId"='legacy'`)).rows[0].count);
      expect(await rows()).toBe(2100);
      expect(await trimSessionHistory(database, 'legacy', 1000)).toEqual({ deleted: 1000, ready: false });
      expect(await rows()).toBe(1100);
      // Restart the caller between pages; all progress and the barrier live in PostgreSQL.
      expect(await trimSessionHistory(database, 'legacy', 1000)).toEqual({ deleted: 1000, ready: false });
      expect(await trimSessionHistory(database, 'legacy', 1000)).toEqual({ deleted: 36, ready: true });
      expect(await rows()).toBe(64);
      expect(await sessionUpgradePage(database, '', 1)).toEqual([]);
      expect(
        (await database.query(`SELECT min("createdAt") AS oldest FROM session WHERE "userId"='legacy'`)).rows[0].oldest,
      ).toEqual(new Date(Date.UTC(2000, 0, 1) + 2037 * 1000));
      await (await native(database).$context).internalAdapter.deleteUserSessions('legacy');
      expect(await rows()).toBe(0);
    } finally {
      await database.end();
      fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60000);

  test('native transaction rollback restores evicted rows and process restart preserves the cap', async () => {
    await nativeOwner(pool, 'rollback');
    for (let i = 0; i < 64; i++) await insertNative(pool, 'rollback', true);
    const ctx = await native(pool).$context;
    const before = (await pool.query(`SELECT id FROM session WHERE "userId"='rollback' ORDER BY id`)).rows;
    await expect(
      ctx.adapter.transaction(async (transaction) => {
        await transaction.create({
          model: 'session',
          data: {
            userId: 'rollback',
            token: 'rolled-back-token',
            clientId: 'bounded-native',
            grantedScope: 'read',
            authnEpoch: 1,
            authTime: 123,
            authMethods: 'pwd',
            createdAt: new Date(),
            updatedAt: new Date(),
            expiresAt: new Date(Date.now() + 60000),
          },
        });
        throw new Error('Abort after native insertion');
      }),
    ).rejects.toThrow('Abort after native insertion');
    expect((await pool.query(`SELECT id FROM session WHERE "userId"='rollback' ORDER BY id`)).rows).toEqual(before);
    const child = Bun.spawn(
      [
        'bun',
        '--eval',
        `
    import { Pool } from 'pg';
    import { betterAuth } from 'better-auth';
    import { betterAuthOptions } from './src/better-auth.ts';
    const pool = new Pool({connectionString:process.env.BOUNDED_RESTART_DATABASE});
    const context = await betterAuth(betterAuthOptions(pool,'https://bounded.auth.test','bounded-session-tests-persistent-secret-at-least-32')).$context;
    await context.internalAdapter.createSession('rollback',false,{clientId:'bounded-native',grantedScope:'read',authnEpoch:1,authTime:123,authMethods:'pwd'});
    await pool.end();
  `,
      ],
      {
        cwd: import.meta.dir + '/..',
        env: { ...process.env, BOUNDED_RESTART_DATABASE: db.url },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    expect(await child.exited).toBe(0);
    expect(await count('rollback')).toBe(64);
  }, 30000);

  test('password, website, key and operator establishment share capacity; destructive effects and Access barrier failures preserve security', async () => {
    const signing = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(signing.privateKey)), kid: 'effects-bounded-signing', alg: 'ES256' };
    const accounts = new Map<string, AccessAccount>();
    let failBarrier = false;
    let serial = 0;
    const delivered: string[] = [];
    const receipts = new Map<string, { accountId: string; minimumAuthnEpoch: number; receiptId: string }>();
    const credentialApprovals = new Map<
      string,
      { stage: CredentialEffectBinding; expiresAt: string; consumed: boolean }
    >();
    const barrier = (accountId: string) => {
      if (failBarrier) throw new Error('Access barrier unavailable');
      const account = accounts.get(accountId)!;
      account.authnEpoch++;
      const receipt = { accountId, minimumAuthnEpoch: account.authnEpoch, receiptId: `bounded-effect-${serial++}` };
      receipts.set(accountId, receipt);
      return receipt;
    };
    const options: AuthServiceOptions = {
      database: pool,
      issuer,
      audience: 'https://bounded.api.test',
      secret,
      signing: { activeKid: jwk.kid, privateKeys: [jwk] },
      recoveryDelivery: {
        async deliver({ token }) {
          delivered.push(token);
        },
      },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
        },
        async readAccount(id) {
          const account = accounts.get(id);
          return account ? { ...account } : null;
        },
        async readRecoveryAccount(id) {
          return accounts.get(id) ?? null;
        },
        async authorizeProvisioning(id) {
          return { accountId: id };
        },
        async approveCredentialEffect({ stage }) {
          const reference = `credential-opening-${serial++}`;
          const expiresAt = new Date(Date.now() + 60000).toISOString();
          credentialApprovals.set(reference, { stage, expiresAt, consumed: false });
          return { reference, expiresAt };
        },
        async invalidateAccount({ accountId }) {
          return barrier(accountId);
        },
        async authorizeRecovery({ accountId }) {
          return barrier(accountId);
        },
        async completeRecovery(reference) {
          const witness = await service.internal.resolveRecoveryEstablishment(reference);
          const account = witness && accounts.get(witness.accountId);
          const receipt = witness && receipts.get(witness.accountId);
          if (
            !witness ||
            !account ||
            account.state !== 'active' ||
            account.automated ||
            account.authnEpoch !== witness.authnEpoch ||
            receipt?.receiptId !== witness.receiptId ||
            receipt.minimumAuthnEpoch !== witness.authnEpoch
          )
            throw new Error('Invalid completion');
          account.fenced = false;
        },
        async consumeAuthorization(input) {
          const { subjectAccountId, purpose, human } = input;
          if (purpose !== 'session') {
            const opening = credentialApprovals.get(input.authorization);
            const stage = opening?.stage;
            const account = accounts.get(subjectAccountId);
            if (
              !opening ||
              opening.consumed ||
              !stage ||
              !account ||
              stage.subjectAccountId !== subjectAccountId ||
              stage.purpose !== purpose ||
              stage.operationKey !== input.operationKey ||
              stage.effectReference !== input.effectReference ||
              stage.actingHumanId !== human.account_id ||
              stage.clientId !== human.client_id ||
              JSON.stringify(stage.scopes) !== JSON.stringify(human.scope)
            )
              throw new Error('Access denied');
            opening.consumed = true;
            const receipt: CredentialEffectAuthorization = {
              ...stage,
              receiptId: input.authorization,
              subjectAccountId,
              actingHumanId: human.account_id,
              operatorAccountId: account.automated ? 'operator' : null,
              purpose: stage.purpose,
              clientId: human.client_id,
              scopes: human.scope,
              humanEpoch: human.authn_epoch,
              subjectEpoch: account.authnEpoch,
              expiresAt: opening.expiresAt,
            };
            return receipt;
          }
          return {
            receiptId: `opening-${serial++}`,
            subjectAccountId,
            purpose,
            actingHumanId: human.account_id,
            operatorAccountId: accounts.get(subjectAccountId)!.automated ? 'operator' : null,
            clientId: human.client_id,
            scopes: human.scope,
            humanEpoch: human.authn_epoch,
            subjectEpoch: accounts.get(subjectAccountId)!.authnEpoch,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          };
        },
        async revalidateCredentialEffect({ stage, authorization }) {
          const opening = credentialApprovals.get(authorization);
          if (!opening || JSON.stringify(opening.stage) !== JSON.stringify(stage)) throw new Error('Access denied');
        },
        async advanceCredentialFloor({ stage, consumedOpening, expectedPreviousFloor }) {
          const floor = barrier(stage.subjectAccountId);
          if (floor.minimumAuthnEpoch !== expectedPreviousFloor + 1) throw new Error('Access denied');
          return {
            receiptId: floor.receiptId,
            accountId: stage.subjectAccountId,
            minimumAuthnEpoch: floor.minimumAuthnEpoch,
            operationKey: stage.operationKey,
            effectReference: stage.effectReference,
            effectDigest: stage.effectDigest,
            purpose: stage.purpose,
            openingReceiptId: consumedOpening.receiptId,
            previousFloor: expectedPreviousFloor,
            fenced: !!accounts.get(stage.subjectAccountId)!.fenced,
          };
        },
      }),
    };
    const service = await createAuthService(options);
    const second = await createAuthService({ ...options, database: other });
    await service.internal.registerClient({ clientId: 'bounded-web', firstParty: true, scopes: ['read', 'write'] });
    accounts.set('effects-human', {
      accountId: 'effects-human',
      kind: 'actor',
      state: 'pending',
      automated: false,
      authnEpoch: 1,
    });
    accounts.set('effects-robot', {
      accountId: 'effects-robot',
      kind: 'actor',
      state: 'pending',
      automated: true,
      authnEpoch: 1,
    });
    await service.internal.provisionPassword({
      authorization: 'effects-human',
      email: 'effects@bounded.test',
      password,
    });
    await service.internal.provisionCredentialless({ authorization: 'effects-robot' });
    for (const account of accounts.values()) account.state = 'active';
    await service.internal.registerClient({
      clientId: 'effects-external',
      firstParty: false,
      scopes: ['read', 'write'],
    });
    const request = (path: string, body?: unknown, cookie = '', target = service) =>
      withAuthTransport(nextPeer(), () =>
        target.handler(
          new Request(issuer + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { origin: issuer, 'content-type': 'application/json', cookie },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        ),
      );
    const cookieOf = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    const login = async (byId = false) => {
      const response = await request('/signin', {
        ...(byId ? { account_id: 'effects-human' } : { email: 'effects@bounded.test' }),
        password,
        client_id: 'bounded-web',
        scope: ['read'],
      });
      expect(response.status).toBe(200);
      return cookieOf(response);
    };
    for (let i = 0; i < 64; i++) await insertNative(pool, 'effects-human', true);
    const humanCookie = await login(); // Website/email establishment.
    expect(await count('effects-human')).toBe(64);
    expect((await request('/session', undefined, await login(true))).status).toBe(200);
    expect(await count('effects-human')).toBe(64);
    const key = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = { ...(await exportJWK(key.publicKey)), kid: 'bounded-own-key', alg: 'ES256' };
    await pool.query('INSERT INTO auth_public_key VALUES ($1,$2,$3)', ['effects-human', publicJwk.kid, publicJwk]);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
      .setIssuer('effects-human')
      .setSubject('effects-human')
      .setAudience(issuer + '/token')
      .setIssuedAt()
      .setExpirationTime('60s')
      .setJti('bounded-key-once')
      .sign(key.privateKey);
    const keyResponse = await request('/signin/key', {
      account_id: 'effects-human',
      assertion,
      client_id: 'bounded-web',
      scope: ['read'],
    });
    expect(keyResponse.status).toBe(200);
    expect(await keyResponse.json()).toMatchObject({ amr: ['private_key_jwt'], scope: ['read'] });
    expect(await count('effects-human')).toBe(64);
    for (let i = 0; i < 64; i++) await insertNative(pool, 'effects-robot', true);
    const operator = await second.internal.openAutomatedSession({
      authorization: 'opening',
      subjectAccountId: 'effects-robot',
      headers: new Headers({ cookie: humanCookie }),
    });
    expect(operator.status).toBe(200);
    expect(await operator.json()).toMatchObject({ amr: ['operator'], scope: ['read'] });
    expect(await count('effects-robot')).toBe(64);
    expect(
      (await request('/consent', { client_id: 'effects-external', scope: ['read', 'write'] }, humanCookie)).status,
    ).toBe(200);
    failBarrier = true;
    expect((await request('/consent', { client_id: 'effects-external', scope: ['read'] }, humanCookie)).status).toBe(
      503,
    );
    expect(await count('effects-human')).toBe(64);
    expect(
      (
        await pool.query(
          `SELECT scopes FROM auth_consent WHERE account_id='effects-human' AND client_id='effects-external'`,
        )
      ).rows[0].scopes,
    ).toEqual(['read', 'write']);
    expect(accounts.get('effects-human')!.authnEpoch).toBe(1);
    const credential = (await pool.query(`SELECT password FROM account WHERE "userId"='effects-human'`)).rows[0]
      .password;
    await expect(
      credentialEffect(service, {
        key: 'replace',
        subjectAccountId: 'effects-human',
        headers: new Headers({ cookie: humanCookie }),
        credential: { kind: 'password', password },
      }),
    ).rejects.toThrow('Access barrier unavailable');
    expect((await pool.query(`SELECT password FROM account WHERE "userId"='effects-human'`)).rows[0].password).toBe(
      credential,
    );
    failBarrier = false;
    expect((await request('/consent', { client_id: 'effects-external', scope: ['read'] }, humanCookie)).status).toBe(
      200,
    );
    expect(await count('effects-human')).toBe(0);
    expect((await request('/session', undefined, humanCookie, second)).status).toBe(401);
    const fresh = await login();
    for (let i = 0; i < 63; i++) await insertNative(pool, 'effects-human', true);
    // Credential replacement must invalidate before revoking the full neighborhood.
    await credentialEffect(service, {
      key: 'replace-applied',
      subjectAccountId: 'effects-human',
      headers: new Headers({ cookie: fresh }),
      credential: { kind: 'password', password },
    });
    expect(await count('effects-human')).toBe(0);
    expect((await request('/session', undefined, fresh)).status).toBe(401);
    await login();
    for (let i = 0; i < 63; i++) await insertNative(pool, 'effects-human', true);
    const startRecovery = async () => {
      const key = createHmac('sha256', secret)
        .update(JSON.stringify(['auth-recovery-mail-v1', 'effects-human']))
        .digest('hex');
      await pool.query('DELETE FROM auth_attempt_counter WHERE key=$1', [key]);
      const before = delivered.length;
      expect((await request('/recovery/start', { email: 'effects@bounded.test' })).status).toBe(200);
      const deadline = Date.now() + 5_000;
      while (delivered.length === before && Date.now() < deadline) await Bun.sleep(10);
      expect(delivered.length).toBe(before + 1);
    };
    await startRecovery();
    failBarrier = true;
    expect(
      (
        await request('/recovery/complete', {
          account_id: 'effects-human',
          token: delivered.at(-1),
          new_password: password,
        })
      ).status,
    ).toBe(503);
    expect(await count('effects-human')).toBe(64);
    failBarrier = false;
    await startRecovery();
    expect(
      (
        await request('/recovery/complete', {
          account_id: 'effects-human',
          token: delivered.at(-1),
          new_password: password,
        })
      ).status,
    ).toBe(200);
    expect(await count('effects-human')).toBe(0);
    accounts.get('effects-robot')!.state = 'suspended';
    await expect(
      second.internal.openAutomatedSession({
        authorization: 'inactive',
        subjectAccountId: 'effects-robot',
        headers: new Headers({ cookie: fresh }),
      }),
    ).rejects.toThrow();
    expect(await count('effects-robot')).toBe(64);
    accounts.get('effects-robot')!.state = 'deleted';
    accounts.get('effects-robot')!.fenced = true;
    await second.internal.eraseAccount('effects-robot');
    expect(await count('effects-robot')).toBe(0);
  }, 60000);
}
