import { resolveAuthenticationSubject, type AuthenticationSubject } from './authentication-subject.ts';
import type { Pool, PoolClient } from 'pg';
import { authenticationCookies } from './authentication-cookies.ts';
import type { AuthenticationProvider, PreparedAuthentication } from './authentication-input.ts';
import { runAuthenticationExchange } from './authentication-input.ts';
import { consumeStepUpAttempt } from './rate-limit.ts';
import { AccountProblem } from './http.ts';
import type { AuthContext } from 'better-auth';

/** A successful provider exchange may have changed owner after the last
 * locked reread. Revoke issued sessions before exposing any response and
 * persist one failed attempt and one event for each affected immutable user. */
type Evidence = { authenticatedUserIds: Set<string>; issuedTokens: Set<string> };
export function authenticationSubjectChanged(subject: AuthenticationSubject, evidence: Evidence) {
  return [...evidence.authenticatedUserIds].some(id => id !== subject.candidateUserId);
}
export async function settleChangedAuthentication(auth: AuthenticationProvider, pool: Pool,
  subject: AuthenticationSubject, evidence: Evidence, held?: PoolClient): Promise<void> {
  const provider = await auth.$context as AuthContext;
  for (const token of evidence.issuedTokens) await provider.internalAdapter.deleteSession(token);
  const users = [...new Set([...(subject.candidateUserId ? [subject.candidateUserId] : []),
    ...evidence.authenticatedUserIds])].sort();
  // The original proof transaction has committed and released its own rate
  // row/security locks. Opposite owner changes cannot hold A then wait for B
  // while another exchange holds B then waits for A. This operation owns one
  // transaction on the existing connection, and commits both subjects' effects
  // atomically. The caller's COMMIT released locks, not its bounded pool slot.
  const db = held ?? await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '2s'");
    await db.query("SET LOCAL statement_timeout = '5s'");
    for (const userId of users) {
      if (!(subject.signedInBudget && userId === subject.candidateUserId)) {
        try { await consumeStepUpAttempt(db, provider.secret, userId); }
        catch (error) { if (!(error instanceof AccountProblem) || error.code !== 'rate_limited') throw error; }
      }
      await db.query(`INSERT INTO rezics_account_security_event (user_id, action, detail)
        VALUES ($1, 'sign_in_failed', $2)`, [userId, JSON.stringify({ reason: 'provider_subject_changed' })]);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { if (!held) db.release(); }
}

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
  let changed: Evidence | undefined;
  const exchange = async (held?: PoolClient) => {
    const evidence = await runAuthenticationExchange(() => handle(held));
    const proof = ['credential', 'reset-token', 'session-proof'].includes(subject.purpose)
      || input.path === '/api/auth/sign-in/email';
    if (proof && evidence.kind === 'returned') {
      const output = await evidence.result.clone().json().catch(() => null) as { user?: { id?: unknown } } | null;
      if (evidence.result.ok && typeof output?.user?.id === 'string') evidence.authenticatedUserIds.add(output.user.id);
    }
    if (proof && authenticationSubjectChanged(subject, evidence)) {
      changed = evidence;
      return Response.json({ error: 'stale_request' }, { status: 403, headers: { 'cache-control': 'no-store' } });
    }
    if (evidence.kind === 'threw') throw evidence.error;
    return evidence.result;
  };
  if (!userId) {
    const response = await exchange();
    if (changed) await settleChangedAuthentication(auth, pool, subject, changed);
    return response;
  }
  const db = await pool.connect();
  let response: Response;
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
    response = await exchange(db);
    await db.query(response.status >= 500 ? 'ROLLBACK' : 'COMMIT');
    if (changed) await settleChangedAuthentication(auth, pool, subject, changed, db);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  return response;
}
