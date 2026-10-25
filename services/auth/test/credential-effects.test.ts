import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  type AuthService,
  type CredentialEffectAuthorization,
  type CredentialEffectBinding,
  type SessionProof,
} from '../src/index.ts';

// Auth behaviour only: native authorization/floor policy is a trusted-port double.
// No kernel, cross-service authorization or floor provenance outcome is claimed.
export async function credentialFixture(suppliedPool?: Pool) {
  const database = suppliedPool ? undefined : testDatabase();
  const pool = suppliedPool ?? new Pool({ connectionString: database!.url });
  const issuer = 'https://credential.auth.test';
  const password = 'original password sufficiently long';
  const signing = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'signer',
  };
  const keyPair = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: 'new-key' };
  await pool.query(`CREATE TABLE test_authority(id text PRIMARY KEY,epoch integer NOT NULL,automated boolean NOT NULL,state text NOT NULL);
    INSERT INTO test_authority VALUES ('human',1,false,'pending'),('robot',1,true,'pending')`);
  const readAccount = async (id: string) => {
    const row = (await pool.query('SELECT * FROM test_authority WHERE id=$1', [id])).rows[0];
    return (
      row && {
        accountId: id,
        kind: 'actor' as const,
        state: row.state,
        authnEpoch: row.epoch,
        automated: row.automated,
        fenced: false,
      }
    );
  };
  const openings = new Map<
    string,
    { stage: CredentialEffectBinding; human: SessionProof; spent: boolean; expiresAt: string }
  >();
  let allowed = true;
  let afterConsume = async () => {};
  let service: AuthService;
  const options = {
    database: pool,
    issuer,
    audience: 'https://credential.api.test',
    secret: 'credential-effect-test-persistent-secret-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: {
      readAccount,
      authorizeProvisioning: async (accountId: string) => ({ accountId }),
      async approveCredentialEffect(input: { stage: CredentialEffectBinding; human: SessionProof }) {
        if (!allowed) throw new Error('Fixture authority revoked');
        expect(await service.internal.accessTokenForProof(input.human)).toBeString();
        const reference = randomUUID();
        const expiresAt = new Date(Date.now() + 60000).toISOString();
        openings.set(reference, { ...input, spent: false, expiresAt });
        return { reference, expiresAt };
      },
      async consumeAuthorization(input: { authorization: string; human: SessionProof; effectReference?: string }) {
        const row = openings.get(input.authorization);
        if (!row || row.spent || !allowed || row.stage.effectReference !== input.effectReference)
          throw new Error('Fixture consume denied');
        row.spent = true;
        const subject = await readAccount(row.stage.subjectAccountId);
        const result: CredentialEffectAuthorization = {
          ...row.stage,
          receiptId: input.authorization,
          operatorAccountId: subject.automated ? 'human' : null,
          humanEpoch: input.human.authn_epoch,
          subjectEpoch: subject.authnEpoch,
          expiresAt: row.expiresAt,
        };
        await afterConsume();
        return result;
      },
      async revalidateCredentialEffect() {
        if (!allowed) throw new Error('Fixture authority revoked');
      },
      async advanceCredentialFloor(input: {
        stage: CredentialEffectBinding;
        consumedOpening: CredentialEffectAuthorization;
        expectedPreviousFloor: number;
      }) {
        if (!allowed) throw new Error('Fixture authority revoked');
        const row = (
          await pool.query('UPDATE test_authority SET epoch=epoch+1 WHERE id=$1 AND epoch=$2 RETURNING epoch', [
            input.stage.subjectAccountId,
            input.expectedPreviousFloor,
          ])
        ).rows[0];
        if (!row) throw new Error('Fixture floor CAS denied');
        return {
          ...input.stage,
          receiptId: randomUUID(),
          accountId: input.stage.subjectAccountId,
          minimumAuthnEpoch: row.epoch,
          previousFloor: input.expectedPreviousFloor,
          openingReceiptId: input.consumedOpening.receiptId,
          fenced: false,
        };
      },
    },
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['account:manage'] });
  await service.internal.provisionPassword({ authorization: 'human', email: 'human@credential.test', password });
  await service.internal.provisionCredentialless({ authorization: 'robot' });
  await pool.query("UPDATE test_authority SET state='active'");
  const login = async () => {
    const response = await service.handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'human@credential.test', password, client_id: 'web', scope: ['account:manage'] }),
      }),
    );
    expect(response.status).toBe(200);
    return new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; '),
    });
  };
  let headers = await login();
  return {
    pool,
    publicJwk,
    keyPair,
    issuer,
    options,
    get service() {
      return service;
    },
    get headers() {
      return headers;
    },
    async restart() {
      service = await createAuthService(options);
    },
    async login() {
      headers = await login();
    },
    revoke() {
      allowed = false;
    },
    afterConsume(callback: () => Promise<void>) {
      afterConsume = callback;
    },
    async stage(
      credential: Parameters<AuthService['internal']['stageCredentialEffect']>[0]['credential'],
      subjectAccountId = 'robot',
      key = randomUUID(),
    ) {
      return service.internal.stageCredentialEffect({ key, subjectAccountId, credential, headers });
    },
    async apply(op: { effectRef: string; key: string; subjectId: string }, authorization?: string) {
      const input = { ...op, subjectAccountId: op.subjectId, headers };
      const approval = authorization ?? (await service.internal.approveCredentialEffect(input)).reference;
      return service.internal.applyCredentialEffect({ ...input, authorization: approval });
    },
    async close() {
      if (!suppliedPool) await pool.end();
      database?.close();
    },
  };
}

test('Auth stage commits an immutable keyed commitment and rejects changed input under a used key', async () => {
  const f = await credentialFixture();
  try {
    const op = await f.stage({ kind: 'password', password: 'candidate password long enough' });
    expect(op.digest).toMatch(/^[a-f0-9]{64}$/);
    const expected = {
      operationKey: op.key,
      subjectAccountId: 'robot',
      purpose: op.purpose,
      actingHumanId: 'human',
      clientId: 'web',
      scopes: ['account:manage'],
    };
    expect((await f.service.internal.verifyCredentialEffect(op.effectRef, expected)).effectDigest).toBe(op.digest);
    await f.restart();
    expect(await f.stage({ kind: 'password', password: 'candidate password long enough' }, 'robot', op.key)).toEqual(
      op,
    );
    await expect(
      f.stage({ kind: 'password', password: 'different password long enough' }, 'robot', op.key),
    ).rejects.toThrow();
    await expect(
      f.service.internal.verifyCredentialEffect(op.effectRef, { ...expected, effectDigest: 'caller digest' }),
    ).rejects.toThrow();
    const rows = await f.pool.query('SELECT * FROM auth_effect_receipt WHERE operation_key=$1', [op.key]);
    expect(JSON.stringify(rows.rows)).not.toContain('candidate password');
  } finally {
    await f.close();
  }
}, 60000);

test('apply commits mutation session revocation and exact success receipt in one transaction', async () => {
  const f = await credentialFixture();
  try {
    await f.pool.query(`INSERT INTO auth_public_key VALUES ('robot','old',$1)`, [f.publicJwk]);
    await f.pool.query(
      `INSERT INTO session (id,token,"userId","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods","updatedAt") SELECT 's'||i,'t'||i,'robot',now()+interval '1 hour','web','account:manage',1,1,'private_key_jwt',now() FROM generate_series(1,64) i`,
    );
    const op = await f.stage({ kind: 'key', kid: 'old', remove: true });
    await f.pool.query(
      `CREATE FUNCTION reject_credential_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.committed_at IS NOT NULL THEN RAISE EXCEPTION 'fixture receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_credential_receipt BEFORE UPDATE ON auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION reject_credential_receipt()`,
    );
    await expect(f.apply(op)).rejects.toThrow();
    expect((await f.pool.query("SELECT * FROM auth_public_key WHERE account_id='robot'")).rowCount).toBe(1);
    expect((await f.pool.query('SELECT * FROM session WHERE "userId"=\'robot\'')).rowCount).toBe(64);
    expect(
      (await f.pool.query('SELECT committed_at FROM auth_effect_receipt WHERE operation_key=$1', [op.key])).rows[0]
        .committed_at,
    ).toBeNull();
    await f.pool.query('DROP TRIGGER reject_credential_receipt ON auth_effect_receipt');
    const result = await f.apply(op);
    expect(result.replayed).toBe(false);
    expect((await f.pool.query("SELECT * FROM auth_public_key WHERE account_id='robot'")).rowCount).toBe(0);
    expect((await f.pool.query('SELECT * FROM session WHERE "userId"=\'robot\'')).rowCount).toBe(0);
    const saved = (
      await f.pool.query('SELECT committed_result FROM auth_effect_receipt WHERE receipt_id=$1', [result.receiptId])
    ).rows[0];
    expect(saved.committed_result).toEqual(result);
  } finally {
    await f.close();
  }
}, 60000);

test('lost acknowledgement returns the saved result without repeating the effect', async () => {
  const f = await credentialFixture();
  try {
    const op = await f.stage({ kind: 'key', kid: 'new-key', publicJwk: f.publicJwk });
    const input = { ...op, subjectAccountId: op.subjectId, headers: f.headers };
    const approval = await f.service.internal.approveCredentialEffect(input);
    const first = await f.apply(op, approval.reference);
    const version = (await f.pool.query("SELECT xmin::text FROM auth_public_key WHERE account_id='robot'")).rows;
    await f.restart();
    expect(await f.apply(op, approval.reference)).toEqual({ ...first, replayed: true });
    expect((await f.pool.query("SELECT xmin::text FROM auth_public_key WHERE account_id='robot'")).rows).toEqual(
      version,
    );
    await expect(
      f.stage({ kind: 'key', kid: 'another', publicJwk: { ...f.publicJwk, kid: 'another' } }, 'robot', op.key),
    ).rejects.toThrow();
    f.revoke();
    await expect(f.apply(op, approval.reference)).rejects.toThrow();
  } finally {
    await f.close();
  }
}, 60000);

test('last interactive credential of a person cannot be removed', async () => {
  const f = await credentialFixture();
  try {
    const op = await f.stage({ kind: 'password', password: null }, 'human');
    await expect(f.apply(op)).rejects.toMatchObject({ status: 409 });
    expect((await f.pool.query('SELECT password FROM account WHERE "userId"=\'human\'')).rows[0].password).toBeString();
    await f.pool.query("INSERT INTO auth_public_key VALUES ('human','retained',$1)", [f.publicJwk]);
    expect((await f.apply(op)).replayed).toBe(false);
  } finally {
    await f.close();
  }
}, 60000);

test('only public ES256 keys are accepted', async () => {
  const f = await credentialFixture();
  try {
    for (const publicJwk of [
      { ...f.publicJwk, d: 'private' },
      { ...f.publicJwk, k: 'private' },
      { ...f.publicJwk, alg: 'ES384' },
      { ...f.publicJwk, kid: 'wrong' },
      { kty: 'oct', k: 'private' },
    ])
      await expect(f.stage({ kind: 'key', kid: 'new-key', publicJwk })).rejects.toThrow();
    const op = await f.stage({ kind: 'key', kid: 'new-key', publicJwk: f.publicJwk });
    await f.apply(op);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'new-key' })
      .setIssuer('robot')
      .setSubject('robot')
      .setAudience(`${f.issuer}/signin/key`)
      .setIssuedAt()
      .setExpirationTime('30s')
      .setJti(randomUUID())
      .sign(f.keyPair.privateKey);
    const login = await f.service.handler(
      new Request(`${f.issuer}/signin/key`, {
        method: 'POST',
        headers: { origin: f.issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: 'robot', assertion, client_id: 'web', scope: ['account:manage'] }),
      }),
    );
    expect(login.status).toBe(200);
  } finally {
    await f.close();
  }
}, 60000);

test('authority lost after consume and credential row races leave the stage unfinished', async () => {
  const f = await credentialFixture();
  try {
    const op = await f.stage({ kind: 'key', kid: 'new-key', publicJwk: f.publicJwk });
    f.afterConsume(async () => {
      f.revoke();
    });
    await expect(f.apply(op)).rejects.toThrow();
    expect((await f.pool.query("SELECT * FROM auth_public_key WHERE account_id='robot'")).rowCount).toBe(0);
  } finally {
    await f.close();
  }
}, 60000);
