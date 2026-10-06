import { decodeJwt } from 'jose';
import type { Pool } from 'pg';

/** Order factor verification and session creation against recovery. A password
 * or passkey read before the claim must not create a session after its cleanup.
 * These lookups select the lock owner only; Better Auth still verifies the proof.
 * Cost: one indexed owner lookup and one indexed policy lock per authentication. */
export async function withRecoveryAuthentication(
  pool: Pool,
  request: Request,
  handle: () => Promise<Response>,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  let userId: string | undefined;
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
    if (typeof body?.token === 'string') {
      userId = (
        await pool.query<{ value: string }>(
          'SELECT value FROM public.verification WHERE identifier = $1',
          [`reset-password:${body.token}`],
        )
      ).rows[0]?.value;
    }
  } else if (path.startsWith('/api/auth/two-factor/verify-') && request.method === 'POST') {
    const cookie = request.headers
      .get('cookie')
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => /^(?:__Secure-)?better-auth\.two_factor=/.test(value));
    if (cookie) {
      // The signed cookie is URI-encoded identifier.signature. The provider
      // validates the signature; arbitrary identifiers grant no authority here.
      let signed = '';
      try {
        signed = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
      } catch {
        /* invalid cookie */
      }
      const identifier = signed.slice(0, signed.lastIndexOf('.'));
      userId = (
        await pool.query<{ value: string }>(
          'SELECT value FROM public.verification WHERE identifier = $1',
          [identifier],
        )
      ).rows[0]?.value;
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
    await db.query('SELECT id FROM public.rezics_account_recovery_policy WHERE id = $1 FOR SHARE', [
      userId,
    ]);
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
