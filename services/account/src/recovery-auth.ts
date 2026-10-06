import { decodeJwt } from 'jose';
import type { Pool } from 'pg';

type VerificationRecord = { value: string; createdAt: Date };

function challengeIdentifier(request: Request, name: string): string | undefined {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`) || value.startsWith(`__Secure-${name}=`));
  if (!cookie) return undefined;
  // These bytes select a lock owner/epoch only. Better Auth verifies signatures.
  try {
    const signed = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
    const signature = signed.lastIndexOf('.');
    return signature > 0 ? signed.slice(0, signature) : undefined;
  } catch {
    return undefined;
  }
}

/** Order factor verification and session creation against recovery. A password
 * or passkey read before the claim must not create a session after its cleanup.
 * These lookups select the lock owner only; Better Auth still verifies the proof.
 * Cost: indexed owner/session/verification lookups and one indexed policy lock;
 * no verification inventory is scanned or parsed. */
export async function withRecoveryAuthentication(
  pool: Pool,
  request: Request,
  handle: () => Promise<Response>,
  readSession: () => Promise<{ session: { id: string }; user: { id: string } } | null>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  let userId: string | undefined;
  let verificationCreatedAt: Date | undefined;
  let sessionId: string | undefined;
  let trustCreatedAt: Date | undefined;
  if (
    request.method === 'POST' &&
    ['/api/auth/sign-in/email', '/api/auth/request-password-reset'].includes(path)
  ) {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email === 'string') {
      userId = (
        await pool.query<{ id: string }>('SELECT id FROM public."user" WHERE email = $1', [
          body.email.trim().toLowerCase(),
        ])
      ).rows[0]?.id;
      if (path === '/api/auth/sign-in/email' && userId) {
        const identifier = challengeIdentifier(request, 'better-auth.trust_device')?.split('!')[1];
        if (identifier) {
          const trust = (
            await pool.query<VerificationRecord>(
              'SELECT value, "createdAt" FROM public.verification WHERE identifier = $1',
              [identifier],
            )
          ).rows[0];
          if (trust?.value === userId) trustCreatedAt = trust.createdAt;
        }
      }
    }
  } else if (path === '/api/auth/passkey/verify-authentication' && request.method === 'POST') {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { response?: { id?: unknown } } | null;
    if (typeof body?.response?.id === 'string') {
      userId = (
        await pool.query<{ userId: string }>(
          'SELECT "userId" FROM public.passkey WHERE "credentialID" = $1',
          [body.response.id],
        )
      ).rows[0]?.userId;
    }
  } else if (path === '/api/auth/reset-password' && request.method === 'POST') {
    const body = (await request
      .clone()
      .json()
      .catch(() => null)) as { token?: unknown } | null;
    const token =
      typeof body?.token === 'string' && body.token
        ? body.token
        : new URL(request.url).searchParams.get('token');
    if (token) {
      const verification = (
        await pool.query<VerificationRecord>(
          'SELECT value, "createdAt" FROM public.verification WHERE identifier = $1',
          [`reset-password:${token}`],
        )
      ).rows[0];
      userId = verification?.value;
      verificationCreatedAt = verification?.createdAt;
    }
  } else if (path === '/api/auth/passkey/verify-registration' && request.method === 'POST') {
    const session = await readSession();
    if (session) {
      userId = session.user.id;
      sessionId = session.session.id;
      const identifier = challengeIdentifier(request, 'better-auth.better-auth-passkey');
      if (identifier) {
        verificationCreatedAt = (
          await pool.query<{ createdAt: Date }>(
            'SELECT "createdAt" FROM public.verification WHERE identifier = $1',
            [identifier],
          )
        ).rows[0]?.createdAt;
      }
    }
  } else if (path.startsWith('/api/auth/two-factor/verify-') && request.method === 'POST') {
    // Better Auth uses the signed-in session before a challenge cookie. Do not
    // let a leftover pre-recovery cookie block the owner's new TOTP enrollment.
    const session = await readSession();
    if (session) {
      userId = session.user.id;
      sessionId = session.session.id;
    } else {
      const identifier = challengeIdentifier(request, 'better-auth.two_factor');
      if (identifier) {
        const verification = (
          await pool.query<VerificationRecord>(
            'SELECT value, "createdAt" FROM public.verification WHERE identifier = $1',
            [identifier],
          )
        ).rows[0];
        userId = verification?.value;
        verificationCreatedAt = verification?.createdAt;
      }
    }
  } else if (path === '/api/auth/verify-email') {
    try {
      const { email } = decodeJwt(new URL(request.url).searchParams.get('token') ?? '');
      if (typeof email === 'string') {
        userId = (
          await pool.query<{ id: string }>('SELECT id FROM public."user" WHERE email = $1', [email])
        ).rows[0]?.id;
      }
    } catch {
      /* the provider refuses malformed tokens */
    }
  }
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
    if (policy.rows[0]?.stale_trust) {
      // A valid new password may sign in, but an old trusted-device artifact
      // cannot bypass the owner's newly enrolled second factor.
      request.headers.set(
        'cookie',
        (request.headers.get('cookie') ?? '')
          .split(';')
          .filter((value) => !/^(?:__Secure-)?better-auth\.trust_device=/.test(value.trim()))
          .join(';'),
      );
    }
    const response = await handle();
    await db.query('COMMIT');
    return response;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
