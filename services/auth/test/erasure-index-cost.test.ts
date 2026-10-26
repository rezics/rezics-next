import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type EffectAuthorization } from '../src/index.ts';

// Other suites can remove an exited fixture between the shared helper's list and inspect.
// Retry only that cleanup race; database creation, migration and operation failures still fail.
function isolatedDatabase(): ReturnType<typeof testDatabase> {
  for (let attempt = 0; ; attempt++) {
    try {
      return testDatabase();
    } catch (error) {
      if (
        attempt >= 4 ||
        !(error instanceof Error) ||
        !/^docker (?:inspect -f|rm -f) /.test(error.message) ||
        !/(?:no such object:|removal of container .* is already in progress)/.test(error.message)
      )
        throw error;
    }
  }
}

test('native account erasure preserves authorization, invalidation order and unrelated rows without resurrection', async () => {
  // This file always owns its migrated throwaway database, including under the module gate.
  const fixture = isolatedDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    const issuer = 'https://erase.auth.test';
    const password = 'correct horse battery staple';
    const accounts = new Map<string, AccessAccount>();
    const delivered = new Map<string, string>();
    const events: string[] = [];
    let outage = false;
    let inspectRead = false;
    const originalQuery = pool.query.bind(pool);
    let inflight = 0;
    pool.query = ((...args: Parameters<Pool['query']>) => {
      if (args[0] === 'DELETE FROM "user" WHERE id=$1') events.push('native-delete');
      if (typeof args.at(-1) === 'function') return originalQuery(...args);
      inflight++;
      return Promise.resolve(originalQuery(...args)).finally(() => {
        inflight--;
      });
    }) as Pool['query'];
    const drain = async () => {
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) {
          await new Promise((resolve) => setImmediate(resolve));
          if (inflight === 0) return;
        }
      }
    };
    const key = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = { ...(await exportJWK(key.privateKey)), kid: 'erase-signing', alg: 'ES256' };
    const publicJwk = { ...(await exportJWK(key.publicKey)), kid: 'erase-key', alg: 'ES256' };
    const references = [
      ['user', 'id'],
      ['account', 'userId'],
      ['session', 'userId'],
      ['auth_consent', 'account_id'],
      ['auth_public_key', 'account_id'],
      ['auth_key_assertion', 'account_id'],
      ['auth_recovery', 'account_id'],
      ['auth_session_opening', 'subject_account_id'],
    ] as const;
    async function snapshot(owner?: string) {
      return Promise.all(
        references.map(async ([table, column]) => ({
          table,
          rows: (
            await pool.query(
              `SELECT to_jsonb(t) AS value FROM "${table}" t ${owner ? `WHERE "${column}"=$1` : ''} ORDER BY to_jsonb(t)::text`,
              owner ? [owner] : [],
            )
          ).rows.map(({ value }) => value),
        })),
      );
    }
    const service = await createAuthService({
      database: pool,
      issuer,
      audience: 'https://erase.api.test',
      secret: 'erasure-regression-secret-at-least-32-bytes',
      signing: { activeKid: privateJwk.kid, privateKeys: [privateJwk] },
      recoveryDelivery: {
        async deliver(input) {
          delivered.set(input.accountId, input.token);
        },
      },
      trustedAccess: {
        async readAccount(id) {
          if (outage) throw new Error('Access unavailable');
          if (inspectRead) {
            events.push('access-read');
            // The coordinator's committed invalidation precedes every destructive statement.
            expect(accounts.get(id)).toMatchObject({ state: 'deleted', fenced: true, authnEpoch: 2 });
            expect((await snapshot(id)).every(({ rows }) => rows.length > 0)).toBe(true);
          }
          return accounts.get(id) ?? null;
        },
        async readRecoveryAccount(id) {
          return accounts.get(id) ?? null;
        },
        async authorizeProvisioning(id) {
          return { accountId: id };
        },
        async authorizeRecovery() {
          throw new Error('Deleted accounts cannot authorize recovery');
        },
        async completeRecovery() {
          throw new Error('Deleted accounts cannot complete recovery');
        },
        async consumeAuthorization(input): Promise<EffectAuthorization> {
          const subject = accounts.get(input.subjectAccountId)!;
          return {
            receiptId: input.authorization,
            subjectAccountId: subject.accountId,
            actingHumanId: input.human.account_id,
            operatorAccountId: subject.automated ? input.human.account_id : null,
            purpose: input.purpose,
            clientId: input.human.client_id,
            scopes: input.human.scope,
            humanEpoch: input.human.authn_epoch,
            subjectEpoch: subject.authnEpoch,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
    });
    const request = (path: string, body?: unknown, cookie = '') =>
      service.handler(
        new Request(`${issuer}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    const cookieOf = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
    async function provision(id: string, automated = false) {
      const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', automated, authnEpoch: 1 };
      accounts.set(id, account);
      await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
      account.state = 'active';
      return account;
    }
    await service.internal.registerClient({ clientId: 'erase-web', firstParty: true, scopes: ['read'] });
    await service.internal.registerClient({ clientId: 'erase-external', firstParty: false, scopes: ['read'] });
    const subject = await provision('erase-human');
    const peer = await provision('retained-human');
    const automated = await provision('erase-automated', true);
    const login = await request('/signin', {
      email: 'erase-human@example.test',
      password,
      client_id: 'erase-web',
      scope: ['read'],
    });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    expect((await request('/consent', { client_id: 'erase-external', scope: ['read'] }, cookie)).status).toBe(200);
    await service.internal.setCredential({
      subjectAccountId: subject.accountId,
      authorization: 'add-erasure-key',
      headers: new Headers({ cookie }),
      credential: { kind: 'key', kid: publicJwk.kid, publicJwk },
    });
    const now = Math.floor(Date.now() / 1000);
    const assertion = (jti: string) =>
      new SignJWT({
        iss: subject.accountId,
        sub: subject.accountId,
        aud: `${issuer}/token`,
        iat: now,
        exp: now + 60,
        jti,
      })
        .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
        .sign(key.privateKey);
    expect(
      (
        await request('/signin/key', {
          account_id: subject.accountId,
          assertion: await assertion('before-erasure'),
          client_id: 'erase-web',
          scope: ['read'],
        })
      ).status,
    ).toBe(200);
    expect((await request('/recovery/start', { email: 'erase-human@example.test' })).status).toBe(200);
    const deliveryDeadline = Date.now() + 5_000;
    while (!delivered.has(subject.accountId) && Date.now() < deliveryDeadline) await Bun.sleep(10);
    await drain();
    const recoveryToken = delivered.get(subject.accountId)!;
    expect(recoveryToken).toBeString();
    const opening = await service.internal.openAutomatedSession({
      subjectAccountId: automated.accountId,
      authorization: 'open-erasure-session',
      headers: new Headers({ cookie }),
    });
    expect(opening.status).toBe(200);
    const automatedCookie = cookieOf(opening);
    expect(
      (await snapshot(automated.accountId)).find(({ table }) => table === 'auth_session_opening')!.rows,
    ).toHaveLength(1);
    // Historical native opening rows have only a subject FK, independent of session lifetime.
    await pool.query(
      'INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id) VALUES ($1,$2,$3,$3,$4)',
      ['historical-session', subject.accountId, peer.accountId, 'historical-opening'],
    );
    // Many OTHER owners, each with actual native references. Compare complete retained rows below.
    await pool.query(
      `INSERT INTO "user" (id,name,"emailVerified") SELECT 'unrelated-'||i,'',false FROM generate_series(1,128) i`,
    );
    await pool.query(
      `INSERT INTO account (id,"accountId","providerId","userId",password,"updatedAt") SELECT 'credential-'||id,id,'credential',id,'unrelated-hash',now() FROM "user" WHERE id LIKE 'unrelated-%'`,
    );
    await pool.query(
      `INSERT INTO session (id,token,"userId","expiresAt","updatedAt","clientId","grantedScope","authnEpoch","authTime","authMethods") SELECT 'session-'||id,'token-'||id,id,now()+interval '1 day',now(),'erase-web','read',1,1,'pwd' FROM "user" WHERE id LIKE 'unrelated-%'`,
    );
    await pool.query(
      `INSERT INTO auth_consent SELECT id,'erase-external',ARRAY['read'] FROM "user" WHERE id LIKE 'unrelated-%'`,
    );
    await pool.query(`INSERT INTO auth_public_key SELECT id,'key',$1::jsonb FROM "user" WHERE id LIKE 'unrelated-%'`, [
      publicJwk,
    ]);
    await pool.query(
      `INSERT INTO auth_key_assertion SELECT id,'assertion',now()+interval '1 day' FROM "user" WHERE id LIKE 'unrelated-%'`,
    );
    await pool.query(
      `INSERT INTO auth_recovery SELECT id||'-'||n,id,1,now()+interval '1 day' FROM "user" CROSS JOIN generate_series(1,4) n WHERE id LIKE 'unrelated-%'`,
    );
    await pool.query(
      `INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id) SELECT id||'-'||n,id,$1,$1,'receipt-'||id||'-'||n FROM "user" CROSS JOIN generate_series(1,4) n WHERE id LIKE 'unrelated-%'`,
      [peer.accountId],
    );
    const baseline = await snapshot();
    const selected = await snapshot(subject.accountId);
    expect(selected.every(({ rows }) => rows.length > 0)).toBe(true);
    for (const state of ['pending', 'active', 'suspended', 'deleted'] as const) {
      for (const fenced of [false, true]) {
        if (state === 'deleted' && fenced) continue;
        Object.assign(subject, { state, fenced });
        await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Authentication denied');
        expect(await snapshot()).toEqual(baseline);
      }
    }
    accounts.delete(subject.accountId);
    await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Authentication denied');
    accounts.set(subject.accountId, subject);
    Object.assign(subject, { state: 'deleted', fenced: true });
    outage = true;
    await expect(service.internal.eraseAccount(subject.accountId)).rejects.toThrow('Access unavailable');
    outage = false;
    expect(await snapshot()).toEqual(baseline);
    expect(events).toEqual([]);

    subject.authnEpoch++;
    events.push('access-invalidation-committed');
    // Old native sessions fail before their rows are destroyed.
    expect((await request('/session', undefined, cookie)).status).toBe(401);
    expect((await request('/token', {}, cookie)).status).toBe(401);
    expect(await snapshot()).toEqual(baseline);
    inspectRead = true;
    await service.internal.eraseAccount(subject.accountId);
    inspectRead = false;
    expect(events).toEqual(['access-invalidation-committed', 'access-read', 'native-delete']);
    const erased = await snapshot(subject.accountId);
    expect(erased.find(({ table }) => table === 'auth_consent')!.rows).toEqual(
      selected.find(({ table }) => table === 'auth_consent')!.rows,
    );
    expect(erased.every(({ table, rows }) => table === 'auth_consent' || rows.length === 0)).toBe(true);
    const retained = baseline.map(({ table, rows }, index) => ({
      table,
      rows:
        table === 'auth_consent'
          ? rows
          : rows.filter(
              (row) => !selected[index]!.rows.some((target) => JSON.stringify(row) === JSON.stringify(target)),
            ),
    }));
    expect(await snapshot()).toEqual(retained);
    // Verification values and receipts have no owner FK: preserve the current semantics.
    expect(
      (await pool.query('SELECT value FROM verification WHERE identifier=$1', [`reset-password:${recoveryToken}`]))
        .rows,
    ).toEqual([{ value: subject.accountId }]);
    expect(
      (await pool.query('SELECT account_id FROM auth_effect_receipt WHERE receipt_id=$1', ['add-erasure-key'])).rows,
    ).toEqual([{ account_id: subject.accountId }]);
    expect(
      (
        await pool.query('SELECT proof_hash FROM auth_recovery WHERE proof_hash=$1', [
          createHash('sha256').update(recoveryToken).digest('hex'),
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await request('/signin', {
          email: 'erase-human@example.test',
          password,
          client_id: 'erase-web',
          scope: ['read'],
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/signin/key', {
          account_id: subject.accountId,
          assertion: await assertion('after-erasure'),
          client_id: 'erase-web',
          scope: ['read'],
        })
      ).status,
    ).toBe(401);
    const deliveredBefore = delivered.size;
    expect((await request('/recovery/start', { email: 'erase-human@example.test' })).status).toBe(200);
    await drain();
    expect(delivered.size).toBe(deliveredBefore);
    expect(
      (await pool.query('SELECT proof_hash FROM auth_recovery WHERE account_id=$1', [subject.accountId])).rows,
    ).toEqual([]);
    expect(
      (
        await request('/recovery/complete', {
          account_id: subject.accountId,
          token: recoveryToken,
          new_password: password,
        })
      ).status,
    ).toBe(401);
    await expect(
      service.internal.provisionPassword({
        authorization: subject.accountId,
        email: 'erase-human@example.test',
        password,
      }),
    ).rejects.toThrow('Authentication denied');
    await expect(
      service.internal.setCredential({
        subjectAccountId: subject.accountId,
        authorization: 'replay-credential',
        headers: new Headers({ cookie }),
        credential: { kind: 'password', password },
      }),
    ).rejects.toThrow('Authentication denied');
    await service.internal.eraseAccount(subject.accountId); // retry is idempotent
    expect(await snapshot()).toEqual(retained);

    Object.assign(automated, { state: 'deleted', fenced: true, authnEpoch: 2 });
    expect((await request('/session', undefined, automatedCookie)).status).toBe(401);
    await service.internal.eraseAccount(automated.accountId);
    await expect(service.internal.provisionCredentialless({ authorization: automated.accountId })).rejects.toThrow(
      'Authentication denied',
    );
    await expect(
      service.internal.openAutomatedSession({
        subjectAccountId: automated.accountId,
        authorization: 'replay-opening',
        headers: new Headers({ cookie }),
      }),
    ).rejects.toThrow('Authentication denied');
    expect(
      (await snapshot(automated.accountId)).every(({ table, rows }) => table === 'auth_consent' || rows.length === 0),
    ).toBe(true);
    expect(await snapshot()).toEqual(
      retained.map(({ table, rows }, index) => ({
        table,
        rows:
          table === 'auth_consent' ? rows : rows.filter((row) => row[references[index]![1]] !== automated.accountId),
      })),
    );
  } finally {
    await pool.end();
    fixture.close();
  }
}, 60_000);
