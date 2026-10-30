import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { publicCredential } from './key-credentials.ts';
import type {
  CredentialEffect,
  PasskeyEffect,
  CredentialFloorPurpose,
  CredentialFloorBinding,
  CredentialEffectBinding,
  CredentialEffectExpectation,
  SessionProof,
} from './index.ts';

export class CredentialEffectDenied extends Error {
  constructor(readonly status = 401) {
    super('Credential effect denied');
  }
}
const deny = (status = 401): never => {
  throw new CredentialEffectDenied(status);
};
const stageStatement = readFileSync(new URL('./credential-effects-stage.sql', import.meta.url), 'utf8');
type Query = Pool | PoolClient;
type Row = {
  receipt_id: string;
  account_id: string;
  purpose: CredentialFloorPurpose;
  minimum_authn_epoch: number;
  operation_key: string;
  effect_reference: string;
  effect_digest: string;
  stage_version: number;
  credential_row_id: string | null;
  credential_row_version: string | null;
  acting_human_id: string;
  client_id: string;
  scopes: string[];
  stage_ciphertext: Buffer;
  opening_receipt_id: string | null;
  opening_reference: string | null;
  committed_at: Date | null;
  committed_result: { receiptId: string; replayed: false } | null;
};
export type CredentialStage = {
  row: Row;
  binding: CredentialFloorBinding;
  credential: CredentialEffect | PasskeyEffect;
};
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 1024) deny(400);
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function bindingOf(row: Row): CredentialFloorBinding {
  return {
    operationKey: row.operation_key,
    effectReference: row.effect_reference,
    effectDigest: row.effect_digest,
    subjectAccountId: row.account_id,
    purpose: row.purpose,
    credentialRowId: row.credential_row_id,
    credentialRowVersion: row.credential_row_version,
    actingHumanId: row.acting_human_id,
    clientId: row.client_id,
    scopes: row.scopes,
  };
}

/** Auth-only encrypted staging and point reads; no second effect ledger. */
export function credentialEffects(database: Pool, secret: string) {
  // Separate from registration, and separate encryption and commitment keys for
  // each purpose. The persistent Auth secret supports restart-safe verification.
  const key = (purpose: CredentialFloorPurpose, role: string) =>
    Buffer.from(hkdfSync('sha256', secret, '', `rezics.auth.credential-${role}.${purpose}.v1`, 32));
  const aad = (b: CredentialFloorBinding) =>
    Buffer.from(JSON.stringify([1, b.effectReference, b.operationKey, b.subjectAccountId, b.purpose]));
  const digest = (b: CredentialFloorBinding, credential: CredentialEffect | PasskeyEffect) =>
    createHmac('sha256', key(b.purpose, 'binding'))
      .update(
        JSON.stringify([
          1,
          b.effectReference,
          b.operationKey,
          b.subjectAccountId,
          b.purpose,
          credential,
          b.credentialRowId,
          b.credentialRowVersion,
          b.actingHumanId,
          b.clientId,
          b.scopes,
        ]),
      )
      .digest('hex');
  async function normalize(
    value:
      | CredentialEffect
      | PasskeyEffect
      | Parameters<import('./index.ts').AuthService['internal']['stageCredentialEffect']>[0]['credential'],
  ): Promise<{ credential: CredentialEffect | PasskeyEffect; purpose: CredentialFloorPurpose }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) deny(400);
    const fields = Object.keys(value);
    if (value.kind === 'password') {
      if (
        fields.some((f) => !['kind', 'password'].includes(f)) ||
        (value.password !== null && typeof value.password !== 'string')
      )
        deny(400);
      return {
        credential: { kind: 'password', password: value.password },
        purpose: value.password === null ? 'remove-password' : 'set-password',
      };
    }
    if (value.kind === 'passkey') {
      text(value.id);
      if (value.remove === true) {
        if (fields.some((f) => !['kind', 'id', 'remove'].includes(f))) deny(400);
        return { credential: { kind: 'passkey', id: value.id, remove: true }, purpose: 'remove-passkey' };
      }
      // Only the private verified ceremony path can stage an installation.
      return { credential: value, purpose: 'add-passkey' };
    }
    if (value.kind !== 'key') return deny(400);
    text(value.kid);
    if (value.remove === true) {
      if (fields.some((f) => !['kind', 'kid', 'remove'].includes(f))) deny(400);
      return { credential: { kind: 'key', kid: value.kid, remove: true }, purpose: 'remove-key' };
    }
    if (
      fields.some((f) => !['kind', 'kid', 'publicJwk'].includes(f)) ||
      !value.publicJwk ||
      value.publicJwk.kid !== value.kid
    )
      deny(400);
    try {
      return {
        credential: { kind: 'key', kid: value.kid, publicJwk: await publicCredential(value.publicJwk, value.kid) },
        purpose: 'add-key',
      };
    } catch {
      return deny(400);
    }
  }
  async function selected(query: Query, subject: string, credential: CredentialEffect | PasskeyEffect) {
    const row =
      credential.kind === 'passkey'
        ? (
            await query.query('SELECT id,xmin::text AS version FROM passkey WHERE "userId"=$1 AND id=$2', [
              subject,
              credential.id,
            ])
          ).rows[0]
        : credential.kind === 'password'
          ? (
              await query.query(
                'SELECT id,password,xmin::text AS version FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',
                [subject],
              )
            ).rows[0]
          : (
              await query.query('SELECT xmin::text AS version FROM auth_public_key WHERE account_id=$1 AND kid=$2', [
                subject,
                credential.kid,
              ])
            ).rows[0];
    return row && (credential.kind !== 'password' || row.password !== null)
      ? {
          id: credential.kind === 'key' ? JSON.stringify([subject, credential.kid]) : (row.id as string),
          version: row.version as string,
        }
      : { id: null, version: null };
  }
  function resolve(
    row: Row | undefined,
    expected?: CredentialEffectExpectation<CredentialFloorPurpose>,
  ): CredentialStage {
    if (!row || row.stage_version !== 1 || !row.stage_ciphertext) return deny();
    const binding = bindingOf(row);
    Object.freeze(binding.scopes);
    Object.freeze(binding);
    if (
      expected &&
      (binding.operationKey !== expected.operationKey ||
        binding.subjectAccountId !== expected.subjectAccountId ||
        binding.purpose !== expected.purpose ||
        binding.actingHumanId !== expected.actingHumanId ||
        binding.clientId !== expected.clientId ||
        !same(binding.scopes, expected.scopes) ||
        (expected.effectDigest !== undefined && binding.effectDigest !== expected.effectDigest))
    )
      deny();
    let credential: CredentialEffect | PasskeyEffect;
    try {
      const encrypted = row.stage_ciphertext;
      const decipher = createDecipheriv('aes-256-gcm', key(binding.purpose, 'staging'), encrypted.subarray(0, 12));
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(encrypted.subarray(12, 28));
      credential = JSON.parse(
        Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8'),
      );
      const actual = Buffer.from(digest(binding, credential), 'hex');
      const stored = Buffer.from(binding.effectDigest, 'hex');
      if (actual.length !== stored.length || !timingSafeEqual(actual, stored)) deny();
    } catch {
      return deny();
    }
    if (
      row.committed_at &&
      (!row.opening_receipt_id ||
        row.committed_result?.receiptId !== row.receipt_id ||
        row.committed_result?.replayed !== false ||
        Object.keys(row.committed_result).length !== 2)
    )
      deny();
    return { row, binding, credential };
  }
  async function read(
    reference: string,
    expected?: CredentialEffectExpectation<CredentialFloorPurpose>,
    query: Query = database,
    lock = false,
  ) {
    text(reference);
    return resolve(
      (await query.query<Row>(stageStatement.trim() + (lock ? ' FOR UPDATE' : ''), [reference])).rows[0],
      expected,
    );
  }
  async function current(query: Query, stage: CredentialStage) {
    const row = await selected(query, stage.binding.subjectAccountId, stage.credential);
    if (row.id !== stage.binding.credentialRowId || row.version !== stage.binding.credentialRowVersion) deny(409);
  }
  async function stage(input: {
    key: string;
    subjectAccountId: string;
    credential: CredentialEffect | PasskeyEffect;
    human: SessionProof;
    sourceSessionId?: string | undefined;
  }) {
    text(input.key);
    text(input.subjectAccountId);
    const { credential, purpose } = await normalize(input.credential);
    const connection = await database.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT auth_assert_session_capacity($1,true)', [input.subjectAccountId]);
      const existing = (
        await connection.query<Row>('SELECT * FROM auth_effect_receipt WHERE account_id=$1 AND operation_key=$2', [
          input.subjectAccountId,
          input.key,
        ])
      ).rows[0];
      if (existing) {
        const saved = resolve(existing);
        if (
          saved.binding.purpose !== purpose ||
          saved.binding.actingHumanId !== input.human.account_id ||
          saved.binding.clientId !== input.human.client_id ||
          !same(saved.binding.scopes, input.human.scope) ||
          !same(saved.credential, credential)
        )
          deny(409);
        await connection.query('COMMIT');
        return saved.binding;
      }
      const selectedRow = await selected(connection, input.subjectAccountId, credential);
      if ((purpose === 'remove-password' || purpose === 'remove-key') && selectedRow.id === null) deny(409);
      if (purpose === 'add-key' && selectedRow.id !== null) deny(409);
      const binding: CredentialFloorBinding = {
        operationKey: input.key,
        effectReference: randomUUID(),
        effectDigest: '',
        subjectAccountId: input.subjectAccountId,
        purpose,
        credentialRowId: selectedRow.id,
        credentialRowVersion: selectedRow.version,
        actingHumanId: input.human.account_id,
        clientId: input.human.client_id,
        scopes: input.human.scope,
      };
      binding.effectDigest = digest(binding, credential);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(purpose, 'staging'), nonce);
      cipher.setAAD(aad(binding));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
      await connection.query(
        `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch,operation_key,effect_reference,effect_digest,stage_version,credential_row_id,credential_row_version,acting_human_id,client_id,scopes,stage_ciphertext,erasure_operator_id)
        VALUES ($1,$2,$3,0,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,
          (SELECT operator_account_id FROM auth_session_opening WHERE session_id=$13))`,
        [
          randomUUID(),
          input.subjectAccountId,
          purpose,
          input.key,
          binding.effectReference,
          binding.effectDigest,
          selectedRow.id,
          selectedRow.version,
          binding.actingHumanId,
          binding.clientId,
          binding.scopes,
          Buffer.concat([nonce, cipher.getAuthTag(), encrypted]),
          input.sourceSessionId ?? null,
        ],
      );
      await connection.query('COMMIT');
      return binding;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }
  async function mutate(connection: PoolClient, stage: CredentialStage, passwordHash: string | null) {
    await current(connection, stage);
    const b = stage.binding;
    const value = stage.credential;
    let count: number | null;
    if (value.kind === 'password') {
      // Owner lock covers expected absence too; the credential owner is unique.
      count = (
        await connection.query(
          `UPDATE account SET password=$2,"updatedAt"=statement_timestamp()
        WHERE "userId"=$1 AND "providerId"='credential'
        AND (($3::text IS NULL AND password IS NULL) OR (id=$3 AND xmin::text=$4))`,
          [b.subjectAccountId, passwordHash, b.credentialRowId, b.credentialRowVersion],
        )
      ).rowCount;
    } else if (value.kind === 'passkey') {
      if (value.remove) {
        count = (
          await connection.query('DELETE FROM passkey WHERE "userId"=$1 AND id=$2 AND xmin::text=$3', [
            b.subjectAccountId,
            value.id,
            b.credentialRowVersion,
          ])
        ).rowCount;
      } else {
        const size = await connection.query('SELECT id FROM passkey WHERE "userId"=$1 LIMIT 32', [b.subjectAccountId]);
        if (size.rows.length >= 32) deny(409);
        count = (
          await connection.query(
            `INSERT INTO passkey(id,"userId",name,"publicKey","credentialID",counter,"deviceType","backedUp",transports,"createdAt",aaguid)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
            [
              value.id,
              b.subjectAccountId,
              value.name,
              value.publicKey,
              value.credentialID,
              value.counter,
              value.deviceType,
              value.backedUp,
              value.transports,
              value.createdAt,
              value.aaguid,
            ],
          )
        ).rowCount;
      }
    } else if (value.remove) {
      count = (
        await connection.query('DELETE FROM auth_public_key WHERE account_id=$1 AND kid=$2 AND xmin::text=$3', [
          b.subjectAccountId,
          value.kid,
          b.credentialRowVersion,
        ])
      ).rowCount;
    } else {
      count = (
        await connection.query(
          'INSERT INTO auth_public_key(account_id,kid,public_jwk) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [b.subjectAccountId, value.kid, value.publicJwk],
        )
      ).rowCount;
    }
    if (count !== 1) deny(409);
  }
  async function verify<Purpose extends CredentialFloorPurpose>(
    reference: string,
    expected: CredentialEffectExpectation<Purpose>,
  ): Promise<CredentialEffectBinding<Purpose>>;
  async function verify(reference: string, expected: CredentialEffectExpectation): Promise<CredentialEffectBinding>;
  async function verify(
    reference: string,
    expected: CredentialEffectExpectation<CredentialFloorPurpose>,
  ): Promise<CredentialFloorBinding> {
    const stage = await read(reference, expected);
    if (!stage.row.committed_at) await current(database, stage);
    return stage.binding;
  }
  return {
    normalize,
    stage,
    read,
    current,
    mutate,
    verify,
  };
}
