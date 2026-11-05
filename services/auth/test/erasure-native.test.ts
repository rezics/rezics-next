import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { issuer, nativeFixture, password, scopes } from './support/erasure-native.ts';
import { AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { WEBSITE_CLIENT_ID, type PublicJwks } from '../src/index.ts';

async function eventually(probe: () => Promise<boolean>, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (!(await probe())) {
    if (Date.now() > until) throw new Error('Native erasure did not progress');
    await Bun.sleep(100);
  }
}

test('existing deletion caller drains real Auth stores before user deletion; default host resumes native progress and preserves the original consent cutoff without custody or ACK fabrication', async () => {
  const f = await nativeFixture();
  try {
    expect((await f.pool.query("SELECT to_regnamespace('access') AS namespace")).rows[0]!.namespace).toBeNull();
    expect((await f.kernel.query("SELECT to_regnamespace('access') AS namespace")).rows[0]!.namespace).not.toBeNull();
    const victim = await f.person('erased');
    const survivor = await f.person('survivor');
    const owner = victim.accountId;
    // More than one client and one raw-key page, with surviving subjects on the
    // erased owner's clients. These are native fixture writes, never erasure writes.
    for (let i = 0; i < 3; i++) {
      const client = `owned-${i}`;
      await f.host.service.internal.registerClient({ clientId: client, firstParty: true, scopes });
      await f.pool.query('UPDATE auth_client SET "userId"=$2,"clientSecret"=$3 WHERE client_id=$1', [
        client,
        owner,
        `secret-${i}`,
      ]);
      await f.pool.query(
        `INSERT INTO "oauthAccessToken" (id,token,"clientId","userId","expiresAt","createdAt",scopes)
        SELECT $1||i,$1||i,$2,$3,now()+interval '300 seconds',now(),'[]'::jsonb FROM generate_series(1,105) i`,
        [`owned-token-${i}-`, client, survivor.accountId],
      );
    }
    // Use the pinned native provider for real opaque code, family and assertion
    // evidence. A second unconsumed code exercises the client-side exact locator.
    const clientKey = await generateKeyPair('ES256', { extractable: true });
    const redirect = `${issuer}/website/callback`;
    await f.host.service.internal.registerWebsiteClient({
      publicJwks: {
        keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'native-client', alg: 'ES256', use: 'sig' }],
      } as PublicJwks,
      redirectUris: [redirect],
      postLogoutRedirectUris: [`${issuer}/`],
      scopes: ['openid', 'offline_access', 'media:complete'],
    });
    await f.pool.query('UPDATE auth_client SET "userId"=$1 WHERE client_id=$2', [owner, WEBSITE_CLIENT_ID]);
    async function authorize(cookie: string) {
      const verifier = randomBytes(48).toString('base64url');
      const url = new URL(`${issuer}/authorize`);
      url.search = new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'openid offline_access media:complete',
        state: 'native-erasure',
        nonce: 'native-erasure',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        resource: 'https://native-erasure.api.test',
      }).toString();
      const response = await f.host.handler(new Request(url, { headers: { cookie } }));
      expect([302, 303]).toContain(response.status);
      const code = new URL(response.headers.get('location')!).searchParams.get('code');
      expect(code).toBeTruthy();
      return { code: code!, verifier };
    }
    async function exchangeCode(code: { code: string; verifier: string }, jti: string) {
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: 'native-client' })
        .setIssuer(WEBSITE_CLIENT_ID)
        .setSubject(WEBSITE_CLIENT_ID)
        .setAudience(issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + 120)
        .setJti(jti)
        .sign(clientKey.privateKey);
      const exchange = await f.host.handler(
        new Request(`${issuer}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: WEBSITE_CLIENT_ID,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: assertion,
            grant_type: 'authorization_code',
            code: code.code,
            code_verifier: code.verifier,
            redirect_uri: redirect,
            resource: 'https://native-erasure.api.test',
          }),
        }),
      );
      expect(exchange.status).toBe(200);
      expect(((await exchange.json()) as { refresh_token?: string }).refresh_token).toBeString();
    }
    await exchangeCode(await authorize(victim.cookie), 'native-erasure-assertion');
    await authorize(survivor.cookie);
    expect(
      (await f.pool.query('SELECT 1 FROM "oauthRefreshFamily" WHERE erasure_account_id=$1', [owner])).rowCount,
    ).toBeGreaterThan(0);
    expect(
      (await f.pool.query('SELECT 1 FROM "oauthClientAssertion" WHERE erasure_client_id=$1', [WEBSITE_CLIENT_ID]))
        .rowCount,
    ).toBe(1);
    // The provider can bind a website family to a session from another client.
    // Erasing that source client's owner must drain the cross-client children,
    // preserving the target registration and its unrelated family's credentials.
    const sourceOwner = await f.person('source-owner');
    await f.host.service.internal.registerClient({ clientId: 'owned-login', firstParty: true, scopes });
    await f.pool.query('UPDATE auth_client SET "userId"=$1 WHERE client_id=$2', [sourceOwner.accountId, 'owned-login']);
    const sourceLogin = await f.call('/signin', {
      email: survivor.email,
      password,
      client_id: 'owned-login',
      scope: scopes,
    });
    expect(sourceLogin.status).toBe(200);
    const sourceCookie = sourceLogin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    await exchangeCode(await authorize(sourceCookie), 'cross-client-assertion');
    expect(
      (await f.pool.query('SELECT 1 FROM "oauthRefreshFamily" WHERE erasure_source_client_id=$1', ['owned-login']))
        .rowCount,
    ).toBe(1);
    const sourceDeletion = await f.delete(sourceOwner);
    expect({ status: sourceDeletion.status, body: await sourceDeletion.json() }).toEqual({
      status: 200,
      body: { accountId: sourceOwner.accountId },
    });
    for (const table of ['oauthAccessToken', 'oauthRefreshToken', 'oauthRefreshFamily', 'verification'])
      expect(
        (await f.pool.query(`SELECT 1 FROM "${table}" WHERE erasure_source_client_id=$1`, ['owned-login'])).rowCount,
      ).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM auth_client WHERE client_id=$1', [WEBSITE_CLIENT_ID])).rowCount).toBe(1);
    expect(
      (await f.pool.query('SELECT 1 FROM "oauthRefreshFamily" WHERE erasure_account_id=$1', [owner])).rowCount,
    ).toBe(1);
    const actingSession = (
      await f.pool.query<{ id: string }>('SELECT id FROM session WHERE "userId"=$1', [survivor.accountId])
    ).rows[0]!.id;
    await f.pool.query(
      `INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id)
      VALUES ($1,$2,$3,$3,'operating-human')`,
      [actingSession, survivor.accountId, owner],
    );
    const staged = await f.host.service.internal.stageCredentialEffect({
      key: 'stalled-password',
      subjectAccountId: owner,
      headers: new Headers({ cookie: victim.cookie }),
      credential: { kind: 'password', password: 'replacement secret password' },
    });
    expect(staged.effectRef).toBeString();
    // A finished native credential effect has a real immutable success proof;
    // erasure must remove that encrypted stage as well as unfinished own stages.
    const committedKey = await generateKeyPair('ES256', { extractable: true });
    const committedStage = await f.host.service.internal.stageCredentialEffect({
      key: 'committed-native-key',
      subjectAccountId: owner,
      headers: new Headers({ cookie: victim.cookie }),
      credential: {
        kind: 'key',
        kid: 'committed-native-key',
        publicJwk: { ...(await exportJWK(committedKey.publicKey)), kid: 'committed-native-key', alg: 'ES256' },
      },
    });
    const commitInput = { ...committedStage, subjectAccountId: owner, headers: new Headers({ cookie: victim.cookie }) };
    const approvedEffect = await f.host.service.internal.approveCredentialEffect(commitInput);
    const committedEffect = await f.host.service.internal.applyCredentialEffect({
      ...commitInput,
      authorization: approvedEffect.reference,
    });
    expect(
      (
        await f.pool.query('SELECT committed_at FROM auth_effect_receipt WHERE receipt_id=$1', [
          committedEffect.receiptId,
        ])
      ).rows[0]!.committed_at,
    ).toBeInstanceOf(Date);
    const recovery = await f.call('/recovery/start', { email: victim.email });
    expect(recovery.status).toBe(200);
    await eventually(async () => f.deliveries.length === 1);
    expect(f.deliveries.map((message) => message.accountId)).toEqual([owner]);
    expect((await f.pool.query('SELECT 1 FROM auth_recovery WHERE account_id=$1', [owner])).rowCount).toBe(1);
    const counterKeys = (
      await f.pool.query<{ key: string }>('SELECT key FROM auth_attempt_account WHERE account_id=$1', [owner])
    ).rows;
    expect(counterKeys.length).toBeGreaterThan(0);
    const options = await f.call('/passkeys/register/options', {}, victim.cookie);
    expect(options.status).toBe(200);
    expect(
      (await f.pool.query('SELECT id FROM verification WHERE erasure_account_id=$1', [owner])).rowCount,
    ).toBeGreaterThan(0);
    const survivorPassword = (
      await f.pool.query('SELECT password FROM account WHERE "userId"=$1', [survivor.accountId])
    ).rows[0]!.password;
    // The native zero-child guard is a real database check, including legacy
    // recovered callers. No FK cascade can substitute for these child pages.
    await expect(f.pool.query('DELETE FROM "user" WHERE id=$1', [owner])).rejects.toThrow(
      'Auth native user children remain',
    );
    // A producer which entered before the account fence must commit before
    // acceptance. Its exact native artifact must then be included in cleanup.
    const producer = await f.pool.connect();
    let deletion: Promise<Response>;
    try {
      await producer.query('BEGIN');
      await producer.query(
        `INSERT INTO verification (id,identifier,value,"expiresAt","createdAt","updatedAt",erasure_account_id)
         VALUES ('racing-native-proof','racing-native-proof','opaque',now()+interval '1 hour',now(),now(),$1)`,
        [owner],
      );
      deletion = f.delete(victim);
      await eventually(
        async () =>
          (
            await f.kernel.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
              f.routeOf(owner),
              owner,
            ])
          ).rows[0]?.state === 'deleted',
      );
      expect((await f.pool.query('SELECT 1 FROM auth_erasure WHERE account_id=$1', [owner])).rowCount).toBe(0);
      await producer.query('COMMIT');
    } finally {
      await producer.query('ROLLBACK');
      producer.release();
    }
    const result = await deletion!;
    expect({ status: result.status, body: await result.json() }).toEqual({ status: 200, body: { accountId: owner } });
    const obligation = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]!;
    expect(obligation.applicable).toBe(true);
    expect(obligation.user_deleted_at).toBeInstanceOf(Date);
    expect(obligation.consent_due_at.getTime() - obligation.user_deleted_at.getTime()).toBeGreaterThanOrEqual(309_900);
    expect(obligation.native_completed_at).toBeNull();
    // Remove original operation history while native post-user phases remain.
    // Restart the actual host; its default registered maintenance must finish
    // those phases from Auth progress, without replaying the expired approval.
    const jobs = (
      await f.pool.query(
        `SELECT workflow_uuid FROM ${AUTH_SYSTEM_SCHEMA}.workflow_status WHERE name='accounts.operation'`,
      )
    ).rows;
    expect(jobs.length).toBeGreaterThan(0);
    await DBOS.deleteWorkflows(jobs.map((row) => row.workflow_uuid));
    await f.host.workflows.close();
    await f.host.workflows.start();
    expect((await f.pool.query('SELECT id FROM "user" WHERE id=$1', [owner])).rowCount).toBe(0);
    for (const [table, column] of [
      ['account', 'userId'],
      ['session', 'userId'],
      ['passkey', 'userId'],
      ['auth_public_key', 'account_id'],
      ['auth_key_assertion', 'account_id'],
      ['verification', 'erasure_account_id'],
      ['auth_effect_receipt', 'account_id'],
      ['auth_registration_stage', 'account_id'],
      ['auth_provisioning_receipt', 'account_id'],
      ['auth_recovery', 'account_id'],
      ['auth_attempt_account', 'account_id'],
      ['auth_client', 'userId'],
    ] as const) {
      expect((await f.pool.query(`SELECT 1 FROM "${table}" WHERE "${column}"=$1 LIMIT 1`, [owner])).rowCount).toBe(0);
    }
    for (const { key } of counterKeys)
      expect((await f.pool.query('SELECT 1 FROM auth_attempt_counter WHERE key=$1', [key])).rowCount).toBe(0);
    for (const [table, column] of [
      ['oauthAccessToken', 'clientId'],
      ['oauthRefreshToken', 'clientId'],
      ['oauthRefreshFamily', 'clientId'],
      ['oauthClientAssertion', 'erasure_client_id'],
      ['verification', 'erasure_client_id'],
    ] as const)
      expect((await f.pool.query(`SELECT 1 FROM "${table}" WHERE "${column}"=$1`, [WEBSITE_CLIENT_ID])).rowCount).toBe(
        0,
      );
    expect(
      (await f.pool.query('SELECT id FROM "oauthAccessToken" WHERE "clientId" LIKE $1 LIMIT 1', ['owned-%'])).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          'SELECT session_id FROM auth_session_opening WHERE acting_human_id=$1 OR operator_account_id=$1',
          [owner],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await f.pool.query('SELECT password FROM account WHERE "userId"=$1', [survivor.accountId])).rows[0]!.password,
    ).toBe(survivorPassword);
    const signed = await f.call('/signin', {
      email: survivor.email,
      password,
      client_id: 'erasure-web',
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const access = (
      await f.kernel.query('SELECT state,minimum_authn_epoch FROM access.account WHERE route=$1 AND account_id=$2', [
        f.routeOf(owner),
        owner,
      ])
    ).rows[0]!;
    expect(access.state).toBe('deleted');
    await expect(
      f.pool.query("INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,'erasure-web','{}')", [owner]),
    ).rejects.toThrow('Auth erasure fence');
    expect(Number(access.minimum_authn_epoch)).toBe(obligation.barrier);
    const due = obligation.consent_due_at;
    // Stale native issuance/recovery/reduction cannot recreate any of these rows.
    await expect(
      f.pool.query('INSERT INTO auth_recovery (proof_hash,account_id,authn_epoch,expires_at) VALUES ($1,$2,1,now())', [
        'stale',
        owner,
      ]),
    ).rejects.toThrow('Auth erasure fence');
    await expect(
      f.host.service.internal.registerClient({ clientId: 'owned-0', firstParty: true, scopes }),
    ).rejects.toThrow('Auth erased client fence');
    expect(await f.host.service.internal.startAccountErasure(owner)).toBe(obligation.id);
    expect(
      (await f.pool.query('SELECT consent_due_at,applicable FROM auth_erasure WHERE account_id=$1', [owner])).rows[0],
    ).toEqual({ consent_due_at: due, applicable: true });
    expect(await f.host.service.internal.eraseDueConsents()).toBe(0);
    await eventually(
      async () =>
        !!(await f.pool.query('SELECT native_completed_at FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]
          ?.native_completed_at,
      90_000,
    );
    await f.host.service.internal.eraseAccount(owner);
    expect(
      (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]!.pending_code,
    ).toBe('consent');
    // Real elapsed cutoff and the registered native due scheduler, not a fixture
    // UPDATE of due_at or an elapsed-lifetime shortcut.
    await Bun.sleep(Math.max(0, due.getTime() - Date.now() + 20));
    await eventually(
      async () =>
        !!(await f.pool.query('SELECT consent_completed_at FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]
          ?.consent_completed_at,
      90_000,
    );
    expect((await f.pool.query('SELECT 1 FROM auth_consent WHERE account_id=$1', [owner])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM auth_consent_erasure WHERE account_id=$1', [owner])).rowCount).toBe(0);
    expect(
      (
        await f.pool.query('SELECT applicable,pending_code,consent_due_at FROM auth_erasure WHERE account_id=$1', [
          owner,
        ])
      ).rows[0],
    ).toEqual({ applicable: true, pending_code: 'shared-copy-custody', consent_due_at: due });
    // No trusted acknowledgement port or supported copy recorder exists in the
    // composition. A native completion marker must never pretend otherwise.
    expect(
      (
        await f.pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='auth_erasure' AND column_name IN ('acknowledged_at','erased_at','none_at')",
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
}, 540_000);

test('actual automated registration attributes its immutable native provisioning witness to the approved creator and operator', async () => {
  const f = await nativeFixture();
  try {
    const owner = await f.person('registration-operator');
    const key = 'native-provisioning-roles';
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operatorAccountId: owner.accountId,
      handle: 'native_provisioning_roles',
      operationKey: key,
      authorization: 'approval-request',
    };
    const approval = await f.approvals.approve(owner.bearer, { operationKey: key, operation }, f.context());
    const result = await f.host.workflows.createAutomated({
      key,
      handle: operation.handle,
      operatorAccountId: owner.accountId,
      authorization: approval.reference,
      credential: { email: 'native-provisioning-roles@native-erasure.test', password },
    });
    const row = (
      await f.pool.query(
        `SELECT r.erasure_creator_id,r.erasure_operator_id,r.erasure_stage_id,s.registration_id,s.completed_at
         FROM auth_provisioning_receipt r JOIN auth_registration_stage s ON s.account_id=r.account_id
         WHERE r.account_id=$1`,
        [result.accountId],
      )
    ).rows[0]!;
    expect(row.erasure_creator_id).toBe(owner.accountId);
    expect(row.erasure_operator_id).toBe(owner.accountId);
    expect(row.erasure_stage_id).toBe(row.registration_id);
    expect(row.completed_at).toBeInstanceOf(Date);
  } finally {
    await f.close();
  }
}, 120_000);

test('a real stalled encrypted registration loses its secret while the native release witness stays pending', async () => {
  const f = await nativeFixture();
  try {
    const owner = await f.person('stalled-creator');
    const key = 'native-stalled-registration';
    const operation = {
      kind: 'automated' as const,
      registrationId: '',
      operatorAccountId: owner.accountId,
      handle: 'native_stalled_registration',
      operationKey: key,
      authorization: 'approval-request',
    };
    const approval = await f.approvals.approve(owner.bearer, { operationKey: key, operation }, f.context());
    // Fault the real producer after its encrypted stage and native reservation
    // have committed, before it can provision. The erasure scheduler is unchanged.
    f.bindings.workflowPorts.provisioningReference = async () => {
      throw new Error('native provisioning unavailable');
    };
    await expect(
      f.host.workflows.createAutomated({
        key,
        handle: operation.handle,
        operatorAccountId: owner.accountId,
        authorization: approval.reference,
        credential: { email: 'native-stalled-registration@native-erasure.test', password },
      }),
    ).rejects.toThrow();
    const before = (
      await f.pool.query(
        `SELECT registration_id,account_id,handle,reservation_id,ciphertext,credential_digest
         FROM auth_registration_stage WHERE erasure_creator_id=$1 AND completed_at IS NULL`,
        [owner.accountId],
      )
    ).rows[0]!;
    expect(before.ciphertext).toBeInstanceOf(Buffer);
    expect(before.credential_digest).toBeInstanceOf(Buffer);
    expect(before.reservation_id).toBeString();
    const account = await f.bindings.trustedAccess.readAccount(owner.accountId);
    const id = await startNativeErasure(f.pool, owner.accountId, account!.authnEpoch);
    let code = '';
    for (let page = 0; page < 150; page++) {
      const result = await nativeErasurePage(f.pool, id);
      code = result.code;
      if (result.state === 'pending') break;
    }
    expect(code).toBe('native-stage');
    expect(
      (
        await f.pool.query(
          `SELECT account_id,handle,reservation_id,ciphertext,credential_digest,erasure_release_at
           FROM auth_registration_stage WHERE registration_id=$1`,
          [before.registration_id],
        )
      ).rows[0],
    ).toEqual({
      account_id: before.account_id,
      handle: before.handle,
      reservation_id: before.reservation_id,
      ciphertext: null,
      credential_digest: null,
      erasure_release_at: null,
    });
    expect(
      (await f.pool.query('SELECT native_completed_at FROM auth_erasure WHERE id=$1', [id])).rows[0]!
        .native_completed_at,
    ).toBeNull();
  } finally {
    await f.close();
  }
}, 120_000);

test('an absent native user with operating evidence retains original applicability across a rolled-back page and a new native connection pool', async () => {
  const fixture = testDatabase();
  let pool = new Pool({ connectionString: fixture.url });
  try {
    // Native operating evidence deliberately has no user FK: a missing user is
    // exactly the legacy/restart case which must not become an empty inventory.
    await pool.query(`INSERT INTO auth_effect_receipt
      (receipt_id,account_id,purpose,minimum_authn_epoch,acting_human_id)
      SELECT 'operating-'||lpad(i::text,3,'0'),'surviving-subject','sessions',0,'missing-human'
      FROM generate_series(1,105) i;
      INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch,acting_human_id)
      VALUES ('unrelated-witness','unrelated-subject','sessions',0,'unrelated-human');`);
    const id = await startNativeErasure(pool, 'missing-human', 7);
    expect((await pool.query('SELECT applicable FROM auth_erasure WHERE id=$1', [id])).rows[0]!.applicable).toBe(true);
    const connect = pool.connect.bind(pool);
    let crash = true;
    pool.connect = (async () => {
      const connection = await connect();
      const query = connection.query.bind(connection);
      let changed = false;
      connection.query = ((...args: Parameters<typeof query>) => {
        if (String(args[0]).startsWith('DELETE FROM "auth_effect_receipt"')) changed = true;
        if (crash && changed && String(args[0]).startsWith('UPDATE auth_erasure SET phase=')) {
          crash = false;
          throw new Error('crash before native page checkpoint');
        }
        return query(...args);
      }) as typeof connection.query;
      return connection;
    }) as typeof pool.connect;
    await expect(
      (async () => {
        for (let page = 0; page < 100; page++) {
          const result = await nativeErasurePage(pool, id);
          if (result.state !== 'more') throw new Error(`Unexpected native hold: ${result.code}`);
        }
        throw new Error('Did not reach the operating evidence page');
      })(),
    ).rejects.toThrow('crash before native page checkpoint');
    pool.connect = connect;
    expect((await pool.query("SELECT 1 FROM auth_effect_receipt WHERE acting_human_id='missing-human'")).rowCount).toBe(
      105,
    );
    const before = (await pool.query('SELECT phase,after_key FROM auth_erasure WHERE id=$1', [id])).rows[0]!;
    expect(before.after_key).toBe('');
    await pool.end();
    pool = new Pool({ connectionString: fixture.url });
    for (let page = 0; page < 100; page++) {
      const result = await nativeErasurePage(pool, id);
      if (result.state === 'consent') break;
      expect(result.state).toBe('more');
    }
    expect((await pool.query("SELECT 1 FROM auth_effect_receipt WHERE acting_human_id='missing-human'")).rowCount).toBe(
      0,
    );
    expect((await pool.query("SELECT 1 FROM auth_effect_receipt WHERE receipt_id='unrelated-witness'")).rowCount).toBe(
      1,
    );
    const saved = (await pool.query('SELECT applicable,barrier,user_deleted_at FROM auth_erasure WHERE id=$1', [id]))
      .rows[0]!;
    expect(saved.applicable).toBe(true);
    expect(saved.barrier).toBe(7);
    expect(saved.user_deleted_at).toBeInstanceOf(Date);
    // A restarted caller can observe the same user-deletion checkpoint even
    // when another real native page committed it before the caller resumed.
    expect((await nativeErasurePage(pool, id)).state).toBe('consent');
    expect(await startNativeErasure(pool, 'missing-human', 8)).toBe(id);
    expect((await pool.query('SELECT applicable,barrier FROM auth_erasure WHERE id=$1', [id])).rows[0]).toEqual({
      applicable: true,
      barrier: 7,
    });
  } finally {
    await pool.end();
    fixture.close();
  }
}, 60_000);
