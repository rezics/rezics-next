import { resolveAuthenticationSubject, type AuthenticationSubject } from './authentication-subject.ts';
import type { Pool, PoolClient } from 'pg';
import { authenticationCookies } from './authentication-cookies.ts';
import type { AuthenticationProvider, PreparedAuthentication } from './authentication-input.ts';

/** Order factor verification and session creation against recovery. A password
 * or passkey read before the claim must not create a session after its cleanup.
 * These lookups select the lock owner only; Better Auth still verifies the proof.
 * Cost: indexed owner/session/verification lookups and one indexed policy lock;
 * no verification inventory is scanned or parsed. */
export async function withRecoveryAuthentication(
  auth: AuthenticationProvider,
  pool: Pool,
  request: Request,
  input: PreparedAuthentication,
  subject: AuthenticationSubject,
  handle: (db?: PoolClient) => Promise<Response>,
): Promise<Response> {
  const userId = subject.candidateUserId;
  const sessionId = subject.session?.session.id;
  const verificationCreatedAt = subject.verification?.createdAt;
  const trustCreatedAt = subject.trust?.createdAt;
  if (!userId) return handle();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const policy = await db.query<{
      stale_verification: boolean;
      stale_session: boolean;
      stale_trust: boolean;
    }>(
      `SELECT id,
      coalesce($2::timestamptz <= recovered_at, false) AS stale_verification,
      coalesce($4::timestamptz <= recovered_at, false) AS stale_trust,
      $3::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."session" s
        WHERE s.id = $3 AND s."userId" = $1 AND s."expiresAt" > clock_timestamp()
          AND s.rezics_generation = (SELECT session_generation FROM rezics_account_security WHERE user_id = $1)
          AND (recovered_at IS NULL OR s."createdAt" > recovered_at)) AS stale_session
      FROM public.rezics_account_recovery_policy WHERE id = $1 FOR SHARE`,
      [userId, verificationCreatedAt ?? null, sessionId ?? null, trustCreatedAt ?? null],
    );
    // Check under the lock: recovery may have committed after the indexed
    // verification/session lookup. Old value-keyed artifacts can remain until
    // expiry, but they cannot reset a password or finish a sign-in challenge.
    if (policy.rows[0]?.stale_verification || policy.rows[0]?.stale_session) {
      await db.query('ROLLBACK');
      return Response.json(
        { error: 'invalid_token' },
        { status: 403, headers: { 'cache-control': 'no-store' } },
      );
    }
    // SQL policy checks protect the retained epoch; the provider-backed recheck
    // protects identity changes after admission. Reuse the held connection.
    const current = await resolveAuthenticationSubject(auth, db, input);
    if (current.candidateUserId !== userId || current.session?.session.id !== sessionId) {
      await db.query('ROLLBACK');
      return Response.json({ error: 'stale_request' }, { status: 403,
        headers: { 'cache-control': 'no-store' } });
    }
    if (policy.rows[0]?.stale_trust) {
      (await authenticationCookies(request.headers, await auth.$context)).remove('trust_device');
      // The admitted snapshot is no longer an authority for trust. Future
      // rechecks read the explicitly updated header snapshot.
      (await authenticationCookies(input.headers, await auth.$context)).remove('trust_device');
    }
    const response = await handle(db);
    await db.query(response.status >= 500 ? 'ROLLBACK' : 'COMMIT');
    return response;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
