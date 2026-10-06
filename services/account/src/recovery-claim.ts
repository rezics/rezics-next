import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { Pool, PoolClient } from 'pg';

export class AccountRecoveryDenied extends Error {}
export class AccountRecoveryConflict extends Error {}
export class AccountRecoveryStale extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const codePattern = /^[A-Za-z0-9_-]{43}$/;
export const RECOVERY_GENERATION_CLAIM = 'rezics_account_recovery_generation';

type RecoveryPolicy = { id: string; guardian_user_id: string; code_hash: string | null;
  generation: string; recovered_at: Date | null };
type RecoveryClaim = { id: string; target_user_id: string; policy_generation: string;
  code_hash: string; request_digest: string; not_before: Date; expires_at: Date };
export interface RecoveryClaimView {
  claimId: string; targetUserId: string; notBefore: string; expiresAt: string;
  approved: boolean; activated: boolean; replayed: boolean;
}

const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');
const sameHash = (a: string, b: string) => timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const validCode = (code: string) => codePattern.test(code)
  && Buffer.from(code, 'base64url').length === 32;

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the first failure */ }
    throw error;
  } finally { client.release(); }
}

/** One current credential holder enrolls one independent guardian and an
 * out-of-band 256-bit code. A live policy cannot be redirected by a later
 * session; after recovery the spent code may be enrolled afresh. */
export async function enrollAccountRecovery(pool: Pool, targetUserId: string, sessionId: string,
  guardianEmail: string, recoveryCode: string,
  previousRecoveryCode?: string): Promise<{ generation: string; replayed: boolean }> {
  if (!targetUserId || !sessionId || !validCode(recoveryCode) || guardianEmail.length > 320) {
    throw new AccountRecoveryDenied('invalid recovery enrollment');
  }
  return transaction(pool, async client => {
    const target = await client.query('SELECT id FROM public."user" WHERE id = $1 FOR UPDATE',
      [targetUserId]);
    if (!target.rowCount) throw new AccountRecoveryDenied('Account is unavailable');
    const guardian = await client.query<{ id: string }>(`SELECT id FROM public."user"
      WHERE email = $1`, [guardianEmail.trim().toLowerCase()]);
    const guardianId = guardian.rows[0]?.id;
    if (!guardianId || guardianId === targetUserId) {
      throw new AccountRecoveryDenied('independent guardian is unavailable');
    }
    const selected = await client.query<RecoveryPolicy>(`SELECT id, guardian_user_id,
      code_hash, generation, recovered_at FROM public.rezics_account_recovery_policy
      WHERE id = $1 FOR UPDATE`, [targetUserId]);
    const existing = selected.rows[0];
    const activeSession = await client.query(`SELECT 1 FROM public."session"
      WHERE id = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp()
        AND ($3::timestamptz IS NULL OR "createdAt" > $3) FOR SHARE`,
    [sessionId, targetUserId, existing?.recovered_at ?? null]);
    if (!activeSession.rowCount) throw new AccountRecoveryDenied('credential session is stale');
    const hash = codeHash(recoveryCode);
    if (existing?.code_hash) {
      if (existing.guardian_user_id === guardianId && sameHash(existing.code_hash, hash)) {
        return { generation: existing.generation, replayed: true };
      }
      if (!previousRecoveryCode || !validCode(previousRecoveryCode)
        || !sameHash(existing.code_hash, codeHash(previousRecoveryCode))) {
        throw new AccountRecoveryConflict('existing recovery code is required to rotate the policy');
      }
      const rotated = await client.query<{ generation: string }>(`UPDATE
        public.rezics_account_recovery_policy SET guardian_user_id = $2,
        code_hash = $3, generation = generation + 1, enrolled_at = clock_timestamp()
        WHERE id = $1 RETURNING generation`, [targetUserId, guardianId, hash]);
      return { generation: rotated.rows[0]!.generation, replayed: false };
    }
    if (existing) {
      await client.query(`UPDATE public.rezics_account_recovery_policy
        SET guardian_user_id = $2, code_hash = $3, enrolled_at = clock_timestamp()
        WHERE id = $1`, [targetUserId, guardianId, hash]);
      return { generation: existing.generation, replayed: false };
    }
    await client.query(`INSERT INTO public.rezics_account_recovery_policy
      (id, guardian_user_id, code_hash) VALUES ($1,$2,$3)`, [targetUserId, guardianId, hash]);
    return { generation: '0', replayed: false };
  });
}

/** A code holder requests one specifically identified credential replacement.
 * Claim identity is the idempotency key; no unauthenticated lookup reveals the
 * guardian or whether an email has a recovery policy. */
export async function requestAccountRecovery(pool: Pool, input: {
  claimId: string; targetEmail: string; recoveryCode: string;
}): Promise<RecoveryClaimView> {
  if (!uuid.test(input.claimId) || !validCode(input.recoveryCode)
    || !input.targetEmail || input.targetEmail.length > 320) {
    throw new AccountRecoveryDenied('invalid recovery claim');
  }
  const hash = codeHash(input.recoveryCode);
  return transaction(pool, async client => {
    const target = await client.query<{ id: string }>(`SELECT id FROM public."user"
      WHERE email = $1 FOR UPDATE`, [input.targetEmail.trim().toLowerCase()]);
    if (!target.rows[0]) throw new AccountRecoveryDenied('recovery claim is unavailable');
    const targetId = target.rows[0].id;
    const digest = createHash('sha256').update(JSON.stringify([input.claimId, targetId, hash]))
      .digest('hex');
    const prior = await client.query<RecoveryClaim>(`SELECT * FROM
      public.rezics_account_recovery_claim WHERE id = $1`, [input.claimId]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== digest) {
        throw new AccountRecoveryConflict('claim ID binds another request');
      }
      return claimView(client, prior.rows[0], true);
    }
    const policy = await client.query<RecoveryPolicy>(`SELECT id, guardian_user_id,
      code_hash, generation, recovered_at FROM public.rezics_account_recovery_policy
      WHERE id = $1 FOR SHARE`, [targetId]);
    const current = policy.rows[0];
    if (!current?.code_hash || !sameHash(current.code_hash, hash)) {
      throw new AccountRecoveryDenied('recovery claim is unavailable');
    }
    const recent = await client.query<{ count: string }>(`SELECT count(*) AS count FROM
      public.rezics_account_recovery_claim WHERE target_user_id = $1
        AND created_at > clock_timestamp() - interval '1 day'`, [targetId]);
    if (Number(recent.rows[0]?.count ?? '0') >= 8) {
      throw new AccountRecoveryConflict('recovery claim rate limit reached');
    }
    const created = await client.query<RecoveryClaim>(`INSERT INTO
      public.rezics_account_recovery_claim
      (id, target_user_id, policy_generation, code_hash, request_digest,
        not_before, expires_at)
      VALUES ($1,$2,$3,$4,$5,clock_timestamp() + interval '1 day',
        clock_timestamp() + interval '7 days') RETURNING *`,
    [input.claimId, targetId, current.generation, hash, digest]);
    return claimView(client, created.rows[0]!, false);
  });
}

/** The guardian is an Account identity different from the credential owner.
 * An approval is immutable and does not alone issue a replacement credential. */
export async function approveAccountRecovery(pool: Pool, claimId: string,
  guardianUserId: string, guardianSessionId: string): Promise<RecoveryClaimView> {
  if (!uuid.test(claimId) || !guardianUserId || !guardianSessionId) {
    throw new AccountRecoveryDenied('invalid approval');
  }
  return transaction(pool, async client => {
    const guardianPolicy = await client.query<{ recovered_at: Date | null }>(`SELECT
      recovered_at FROM public.rezics_account_recovery_policy WHERE id = $1 FOR SHARE`,
    [guardianUserId]);
    const guardianSession = await client.query(`SELECT 1 FROM public."session"
      WHERE id = $1 AND "userId" = $2 AND "expiresAt" > clock_timestamp()
        AND ($3::timestamptz IS NULL OR "createdAt" > $3) FOR SHARE`,
    [guardianSessionId, guardianUserId, guardianPolicy.rows[0]?.recovered_at ?? null]);
    if (!guardianSession.rowCount) throw new AccountRecoveryDenied('guardian session is stale');
    const row = await client.query<RecoveryClaim & { guardian_user_id: string;
      generation: string; current_code_hash: string | null }>(`SELECT c.*,
      p.guardian_user_id, p.generation, p.code_hash AS current_code_hash
      FROM public.rezics_account_recovery_claim c
      JOIN public.rezics_account_recovery_policy p ON p.id = c.target_user_id
      WHERE c.id = $1 FOR UPDATE OF c`, [claimId]);
    const claim = row.rows[0];
    if (!claim || guardianUserId !== claim.guardian_user_id
      || guardianUserId === claim.target_user_id) {
      throw new AccountRecoveryDenied('independent approval is unavailable');
    }
    const prior = await client.query<{ approver_user_id: string }>(`SELECT approver_user_id
      FROM public.rezics_account_recovery_approval WHERE id = $1`, [claimId]);
    if (prior.rows[0]) return claimView(client, claim, true);
    if (claim.policy_generation !== claim.generation
      || claim.code_hash !== claim.current_code_hash
      || claim.expires_at.getTime() <= Date.now()) {
      throw new AccountRecoveryStale('claim policy or window changed');
    }
    await client.query(`INSERT INTO public.rezics_account_recovery_approval
      (id, approver_user_id) VALUES ($1,$2)`, [claimId, guardianUserId]);
    return claimView(client, claim, false);
  });
}

/** Binds a new password only after both independent proofs and the waiting
 * period. The generation advances with all old factor and session/token removal
 * in one Account transaction. Token introspection rejects every old generation
 * before cleanup could otherwise be mistaken for an authorization fence.
 * Cost: indexed claim/policy/account reads plus O(F+S+T+V_user) removal of this
 * user's own factors, sessions, token families and value-keyed verifications
 * through the password fence, plus three indexed verification identifier deletes.
 * Value-keyed artifacts are revoked by recovered_at at authentication, without
 * scanning other users' verification rows. */
export async function activateAccountRecovery(pool: Pool, input: {
  claimId: string; recoveryCode: string; newPassword: string; digestKey: string;
}): Promise<{ claimId: string; recoveryGeneration: string; replayed: boolean }> {
  if (!uuid.test(input.claimId) || !validCode(input.recoveryCode)
    || input.newPassword.length < 12 || input.newPassword.length > 128
    || input.digestKey.length < 32) throw new AccountRecoveryDenied('invalid credential recovery');
  const hash = codeHash(input.recoveryCode);
  const digest = createHmac('sha256', input.digestKey)
    .update(JSON.stringify([input.claimId, input.recoveryCode, input.newPassword])).digest('hex');
  const replay = await pool.query<{ activation_digest: string;
    recovery_generation: string }>(`SELECT activation_digest, recovery_generation FROM
    public.rezics_account_recovery_activation WHERE id = $1`, [input.claimId]);
  if (replay.rows[0]) {
    if (replay.rows[0].activation_digest !== digest) {
      throw new AccountRecoveryConflict('claim activation binds another credential');
    }
    return { claimId: input.claimId,
      recoveryGeneration: replay.rows[0].recovery_generation, replayed: true };
  }
  const preflight = await pool.query<{ code_hash: string; not_before: Date;
    expires_at: Date; current_code_hash: string | null; generation: string;
    policy_generation: string; guardian_user_id: string;
    approver_user_id: string | null; activation_digest: string | null;
    recovery_generation: string | null }>(`SELECT c.code_hash, c.not_before,
    c.expires_at, c.policy_generation, p.code_hash AS current_code_hash,
    p.generation, p.guardian_user_id, a.approver_user_id,
    activated.activation_digest, activated.recovery_generation
    FROM public.rezics_account_recovery_claim c
    JOIN public.rezics_account_recovery_policy p ON p.id = c.target_user_id
    LEFT JOIN public.rezics_account_recovery_approval a ON a.id = c.id
    LEFT JOIN public.rezics_account_recovery_activation activated ON activated.id = c.id
    WHERE c.id = $1`, [input.claimId]);
  const candidate = preflight.rows[0];
  // Activation can commit between the first replay read and this preflight.
  if (candidate?.activation_digest) {
    if (candidate.activation_digest !== digest) {
      throw new AccountRecoveryConflict('claim activation binds another credential');
    }
    return { claimId: input.claimId,
      recoveryGeneration: candidate.recovery_generation!, replayed: true };
  }
  if (!candidate || candidate.code_hash !== hash
    || candidate.approver_user_id !== candidate.guardian_user_id) {
    throw new AccountRecoveryDenied('recovery proof is unavailable');
  }
  if (candidate.current_code_hash !== hash
    || candidate.policy_generation !== candidate.generation) {
    throw new AccountRecoveryStale('recovery code or policy changed');
  }
  const currentTime = Date.now();
  if (candidate.not_before.getTime() > currentTime
    || candidate.expires_at.getTime() <= currentTime) {
    throw new AccountRecoveryStale('recovery waiting period or window is not open');
  }
  const passwordHash = await hashPassword(input.newPassword);
  return transaction(pool, async client => {
    const claim = await client.query<RecoveryClaim>(`SELECT * FROM
      public.rezics_account_recovery_claim WHERE id = $1 FOR UPDATE`, [input.claimId]);
    const row = claim.rows[0];
    if (!row) throw new AccountRecoveryDenied('recovery claim is unavailable');
    const prior = await client.query<{ activation_digest: string;
      recovery_generation: string }>(`SELECT activation_digest, recovery_generation
      FROM public.rezics_account_recovery_activation WHERE id = $1`, [input.claimId]);
    if (prior.rows[0]) {
      if (prior.rows[0].activation_digest !== digest) {
        throw new AccountRecoveryConflict('claim activation binds another credential');
      }
      return { claimId: input.claimId,
        recoveryGeneration: prior.rows[0].recovery_generation, replayed: true };
    }
    const policy = await client.query<RecoveryPolicy>(`SELECT id, guardian_user_id,
      code_hash, generation, recovered_at FROM public.rezics_account_recovery_policy
      WHERE id = $1 FOR UPDATE`, [row.target_user_id]);
    const current = policy.rows[0];
    if (!current?.code_hash || !sameHash(current.code_hash, hash)
      || row.code_hash !== hash || row.policy_generation !== current.generation) {
      throw new AccountRecoveryStale('recovery code or policy changed');
    }
    const approved = await client.query<{ approver_user_id: string }>(`SELECT approver_user_id
      FROM public.rezics_account_recovery_approval WHERE id = $1`, [input.claimId]);
    if (approved.rows[0]?.approver_user_id !== current.guardian_user_id) {
      throw new AccountRecoveryDenied('independent approval is missing');
    }
    const now = Date.now();
    if (row.not_before.getTime() > now || row.expires_at.getTime() <= now) {
      throw new AccountRecoveryStale('recovery waiting period or window is not open');
    }
    const target = await client.query<{ email: string }>(`SELECT email FROM public."user"
      WHERE id = $1 FOR UPDATE`, [row.target_user_id]);
    if (!target.rows[0]) throw new AccountRecoveryDenied('Account is unavailable');
    const credential = await client.query<{ id: string }>(`SELECT id FROM public."account"
      WHERE "userId" = $1 AND "providerId" = 'credential' FOR UPDATE`, [row.target_user_id]);
    if (credential.rows.length > 1) throw new AccountRecoveryDenied('credential is ambiguous');
    // Bind first, so last-method protection also permits passkey-only recovery.
    if (credential.rows[0]) {
      await client.query(`UPDATE public."account" SET password = $2, "updatedAt" = now()
        WHERE id = $1`, [credential.rows[0].id, passwordHash]);
    } else {
      await client.query(`INSERT INTO public."account"
        (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        VALUES ($1,$2,'credential',$2,$3,now(),now())`,
      [randomUUID(), row.target_user_id, passwordHash]);
    }
    await client.query(`DELETE FROM public.passkey WHERE "userId" = $1`, [row.target_user_id]);
    // Better Auth stores the encrypted backup codes alongside the TOTP secret.
    await client.query(`DELETE FROM public."twoFactor" WHERE "userId" = $1`, [row.target_user_id]);
    await client.query(`UPDATE public."user" SET "twoFactorEnabled" = false, "updatedAt" = now()
      WHERE id = $1`, [row.target_user_id]);
    await client.query(`DELETE FROM public."oauthAccessToken" WHERE "userId" = $1`, [row.target_user_id]);
    await client.query(`DELETE FROM public."oauthRefreshToken" WHERE "userId" = $1`, [row.target_user_id]);
    await client.query(`DELETE FROM public."oauthConsent" WHERE "userId" = $1`, [row.target_user_id]);
    await client.query(`DELETE FROM public."session" WHERE "userId" = $1`, [row.target_user_id]);
    await client.query(`DELETE FROM public."verification" WHERE identifier = ANY($1::text[])`, [[
      `sign-in-otp-${target.rows[0].email}`, `email-verification-otp-${target.rows[0].email}`,
      `forget-password-otp-${target.rows[0].email}`,
    ]]);
    const advanced = await client.query<{ generation: string }>(`UPDATE
      public.rezics_account_recovery_policy SET code_hash = NULL,
      generation = generation + 1, recovered_at = clock_timestamp()
      WHERE id = $1 RETURNING generation`, [row.target_user_id]);
    await client.query(`INSERT INTO public.rezics_account_recovery_activation
      (id, activation_digest, recovery_generation) VALUES ($1,$2,$3)`,
    [input.claimId, digest, advanced.rows[0]!.generation]);
    return { claimId: input.claimId,
      recoveryGeneration: advanced.rows[0]!.generation, replayed: false };
  });
}

export async function readAccountRecoveryClaim(pool: Pool, claimId: string,
  recoveryCode: string): Promise<RecoveryClaimView> {
  if (!uuid.test(claimId) || !validCode(recoveryCode)) {
    throw new AccountRecoveryDenied('invalid recovery read');
  }
  const row = await pool.query<RecoveryClaim>(`SELECT * FROM
    public.rezics_account_recovery_claim WHERE id = $1`, [claimId]);
  if (!row.rows[0] || !sameHash(row.rows[0].code_hash, codeHash(recoveryCode))) {
    throw new AccountRecoveryDenied('recovery claim is unavailable');
  }
  return claimView(pool, row.rows[0], true);
}

async function claimView(db: Pool | PoolClient, claim: RecoveryClaim,
  replayed: boolean): Promise<RecoveryClaimView> {
  const evidence = await db.query<{ approved: boolean; activated: boolean }>(`SELECT
    EXISTS (SELECT 1 FROM public.rezics_account_recovery_approval WHERE id = $1) AS approved,
    EXISTS (SELECT 1 FROM public.rezics_account_recovery_activation WHERE id = $1) AS activated`,
  [claim.id]);
  return { claimId: claim.id, targetUserId: claim.target_user_id,
    notBefore: claim.not_before.toISOString(), expiresAt: claim.expires_at.toISOString(),
    approved: evidence.rows[0]!.approved, activated: evidence.rows[0]!.activated, replayed };
}

/** User JWTs are bound to the current Account credential generation. */
export async function currentRecoveryGeneration(pool: Pool, userId: string): Promise<string> {
  const result = await pool.query<{ generation: string }>(`SELECT generation FROM
    public.rezics_account_recovery_policy WHERE id = $1`, [userId]);
  return result.rows[0]?.generation ?? '0';
}

export async function recoveryBasisActive(client: PoolClient,
  payload: Record<string, unknown>): Promise<boolean> {
  const userId = payload.sub;
  const generation = payload[RECOVERY_GENERATION_CLAIM];
  if (typeof userId !== 'string' || typeof generation !== 'string') return false;
  const result = await client.query<{ generation: string }>(`SELECT generation FROM
    public.rezics_account_recovery_policy WHERE id = $1`, [userId]);
  return generation === (result.rows[0]?.generation ?? '0');
}
