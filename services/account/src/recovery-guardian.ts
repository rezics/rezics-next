import type { Pool, PoolClient } from 'pg';
import {
  AccountRecoveryDenied,
  AccountRecoveryStale,
  recoveryTransaction,
} from './recovery-claim.ts';

export type GuardianState =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'cancelled'
  | 'spent'
  | 'unconfirmed'
  | 'expired';
export interface GuardianInvitationView {
  invitationId: string;
  ownerEmail: string;
  state: 'pending' | 'accepted';
  expiresAt: string;
}
export interface RecoveryPolicyView {
  policy: null | {
    invitationId: string;
    guardianEmail: string;
    state: GuardianState;
    expiresAt: string;
    hasCode: boolean;
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Session proof is checked against both credential recovery and deletion.
 * Cost: indexed identity, security, policy and session lookups. */
export async function requireRecoverySession(
  client: Pool | PoolClient,
  userId: string,
  sessionId: string,
) {
  const result = await client.query<{ email: string; emailVerified: boolean }>(
    `SELECT u.email, u."emailVerified"
    FROM public."user" u JOIN public."session" s ON s."userId" = u.id
    LEFT JOIN public.rezics_account_recovery_policy p ON p.id = u.id
    LEFT JOIN public.rezics_account_security security ON security.user_id = u.id
    WHERE u.id = $1 AND s.id = $2 AND s."expiresAt" > clock_timestamp()
      AND (p.recovered_at IS NULL OR s."createdAt" > p.recovered_at)
      AND security.deletion_started_at IS NULL`,
    [userId, sessionId],
  );
  if (!result.rows[0]) throw new AccountRecoveryDenied('credential session is stale');
  return result.rows[0];
}

/** Called with the policy locked by its owning transaction. Consent remains
 * bound to the accepted identity after mailbox changes. Cost: one PK lookup. */
export async function activeGuardianConsent(
  db: Pool | PoolClient,
  invitationId: string | null,
  guardianId: string | null,
): Promise<boolean> {
  if (!invitationId || !guardianId) return false;
  const result = await db.query(
    `SELECT 1 FROM public.rezics_account_recovery_guardian_invitation
    WHERE id = $1 AND state = 'accepted' AND guardian_user_id = $2`,
    [invitationId, guardianId],
  );
  return !!result.rowCount;
}

/** Cost: one current policy and invitation PK lookup; no recipient Account
 * lookup or delivery status can become an inviter's account-directory oracle. */
export async function readRecoveryPolicy(
  pool: Pool,
  userId: string,
  sessionId: string,
): Promise<RecoveryPolicyView> {
  await requireRecoverySession(pool, userId, sessionId);
  const result = await pool.query<{
    id: string;
    guardian_email: string;
    state: GuardianState;
    expires_at: Date;
    has_code: boolean;
  }>(
    `SELECT i.id, i.guardian_email,
      CASE WHEN i.state = 'pending' AND i.expires_at <= clock_timestamp() THEN 'expired' ELSE i.state END AS state,
      i.expires_at, p.code_hash IS NOT NULL AS has_code
    FROM public.rezics_account_recovery_policy p
    JOIN public.rezics_account_recovery_guardian_invitation i ON i.id = p.guardian_invitation_id
    WHERE p.id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    policy: row
      ? {
          invitationId: row.id,
          guardianEmail: row.guardian_email,
          state: row.state,
          expiresAt: row.expires_at.toISOString(),
          hasCode: row.has_code,
        }
      : null,
  };
}

/** Cost: expiry-indexed pending selection/sort over at most 6,054 live invites
 * per mailbox (3/300 seconds and a 7-day window), plus a limit+1 indexed accepted
 * range and a bounded page merge. Expired history is outside the expiry range.
 * Expired/superseded/deleted-owner invitations grant no membership. */
export async function readGuardianInvitations(
  pool: Pool,
  userId: string,
  sessionId: string,
  cursor?: string,
  limit = 50,
  acceptedOnly = false,
): Promise<{ items: GuardianInvitationView[]; nextCursor: string | null }> {
  if ((cursor && !uuid.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AccountRecoveryDenied('invalid invitation page');
  const actor = await requireRecoverySession(pool, userId, sessionId);
  const result = await pool.query<{
    id: string;
    owner_email: string;
    state: 'pending' | 'accepted';
    expires_at: Date;
  }>(
    `
    WITH pending AS (
      SELECT i.* FROM public.rezics_account_recovery_guardian_invitation i
      JOIN public.rezics_account_recovery_policy p ON p.id = i.owner_user_id AND p.guardian_invitation_id = i.id
      JOIN public."user" u ON u.id = i.owner_user_id
      WHERE i.guardian_email = $1 AND $2 AND NOT $6 AND i.state = 'pending' AND i.expires_at > statement_timestamp()
        AND i.owner_user_id <> $3 AND p.code_hash IS NOT NULL AND i.id > $4::uuid
      ORDER BY i.id LIMIT $5
    ), accepted AS (
      SELECT i.* FROM public.rezics_account_recovery_guardian_invitation i
      JOIN public.rezics_account_recovery_policy p ON p.id = i.owner_user_id AND p.guardian_invitation_id = i.id
      JOIN public."user" u ON u.id = i.owner_user_id
      WHERE i.guardian_user_id = $3 AND i.state = 'accepted' AND p.code_hash IS NOT NULL
        AND p.guardian_user_id = $3 AND i.id > $4::uuid ORDER BY i.id LIMIT $5
    ) SELECT i.id, u.email AS owner_email, i.state, i.expires_at
      FROM (SELECT * FROM pending UNION ALL SELECT * FROM accepted) i
      JOIN public."user" u ON u.id = i.owner_user_id ORDER BY i.id LIMIT $5`,
    [
      actor.email,
      actor.emailVerified,
      userId,
      cursor ?? '00000000-0000-0000-0000-000000000000',
      limit + 1,
      acceptedOnly,
    ],
  );
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map((row) => ({
      invitationId: row.id,
      ownerEmail: row.owner_email,
      state: row.state,
      expiresAt: row.expires_at.toISOString(),
    })),
    nextCursor: result.rows.length > limit ? rows.at(-1)!.id : null,
  };
}

/** Cost: constant indexed identity/session/policy/invitation reads and writes.
 * The same guardian identity lock serializes acceptance with account deletion;
 * policy locks serialize every consent change with approval and activation. */
export async function changeGuardianInvitation(
  pool: Pool,
  invitationId: string,
  userId: string,
  sessionId: string,
  action: 'accept' | 'decline' | 'withdraw',
): Promise<{ state: GuardianState; replayed: boolean }> {
  if (!uuid.test(invitationId)) throw new AccountRecoveryDenied('invalid invitation');
  return recoveryTransaction(pool, async (client) => {
    await client.query('SELECT id FROM public."user" WHERE id = $1 FOR UPDATE', [userId]);
    const actor = await requireRecoverySession(client, userId, sessionId);
    const candidate = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM
      public.rezics_account_recovery_guardian_invitation WHERE id = $1`,
      [invitationId],
    );
    const ownerId = candidate.rows[0]?.owner_user_id;
    if (!ownerId || ownerId === userId)
      throw new AccountRecoveryDenied('independent consent is unavailable');
    const policy = await client.query<{ guardian_invitation_id: string; code_hash: string | null }>(
      `SELECT
      guardian_invitation_id, code_hash FROM public.rezics_account_recovery_policy WHERE id = $1 FOR UPDATE`,
      [ownerId],
    );
    const selected = await client.query<{
      state: GuardianState;
      guardian_email: string;
      guardian_user_id: string | null;
      expires_at: Date;
    }>(
      `SELECT state, guardian_email, guardian_user_id, expires_at
      FROM public.rezics_account_recovery_guardian_invitation WHERE id = $1 FOR UPDATE`,
      [invitationId],
    );
    const row = selected.rows[0]!;
    const acceptedActor = row.guardian_user_id === userId;
    const mailboxActor = actor.emailVerified && actor.email === row.guardian_email;
    if (
      (action === 'withdraw' && !acceptedActor) ||
      (action === 'accept' && row.state === 'accepted'
        ? !acceptedActor
        : action !== 'withdraw' && !mailboxActor)
    )
      throw new AccountRecoveryDenied('invitation is unavailable');
    const next = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'withdrawn';
    if (row.state === next && (action !== 'accept' || acceptedActor))
      return { state: next, replayed: true };
    if (policy.rows[0]?.guardian_invitation_id !== invitationId || !policy.rows[0].code_hash)
      throw new AccountRecoveryStale('invitation is no longer current');
    if (action === 'withdraw' ? row.state !== 'accepted' : row.state !== 'pending')
      throw new AccountRecoveryStale('invitation cannot make this transition');
    const changed = await client.query(
      `UPDATE public.rezics_account_recovery_guardian_invitation
      SET state = $2, guardian_user_id = CASE WHEN $2 = 'accepted' THEN $3 ELSE guardian_user_id END,
        accepted_at = CASE WHEN $2 = 'accepted' THEN clock_timestamp() ELSE accepted_at END,
        ended_at = CASE WHEN $2 = 'accepted' THEN NULL ELSE clock_timestamp() END
      WHERE id = $1 AND ($2 = 'withdrawn' OR expires_at > clock_timestamp()) RETURNING id`,
      [invitationId, next, userId],
    );
    if (!changed.rowCount) throw new AccountRecoveryStale('invitation expired');
    await client.query(
      `UPDATE public.rezics_account_recovery_policy
      SET guardian_user_id = CASE WHEN $2 = 'accepted' THEN $3 ELSE NULL END,
        code_hash = CASE WHEN $2 = 'accepted' THEN code_hash ELSE NULL END WHERE id = $1`,
      [ownerId, next, userId],
    );
    return { state: next, replayed: false };
  });
}
