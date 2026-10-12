import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import { authenticationBody } from './authentication-input.ts';
import { authenticationCookies, type AuthenticationCookieOptions } from './authentication-cookies.ts';

/** Only providers proving the current session's user may prefer its cookie.
 * Provider-target sign-ins must never inherit an unrelated session owner. */
export function authenticationSubjectRule(path: string): 'session' | 'registration' | 'email' | 'credential' | 'reset-token' | 'verified-email' | 'provider' {
  if (path === '/api/auth/passkey/verify-registration') return 'registration';
  if (path === '/api/account/reauthenticate' || path === '/api/account/reauthenticate/passkey'
    || path.startsWith('/api/auth/two-factor/verify-')) return 'session';
  if (['/api/auth/sign-in/email', '/api/auth/sign-in/magic-link', '/api/auth/request-password-reset'].includes(path)) return 'email';
  if (path === '/api/auth/passkey/verify-authentication') return 'credential';
  if (path === '/api/auth/reset-password') return 'reset-token';
  if (path === '/api/auth/verify-email') return 'verified-email';
  return 'provider';
}

type Session = { session: { id: string }; user: { id: string } };
type Verification = { value: string; createdAt: Date; expiresAt: Date };

/** Shared indexed subject resolution for activity, recovery and admission.
 * Epochs are read before provider consumption and checked under recovery's lock. */
export async function authenticationSubject(pool: Pool, request: Request,
  readSession: () => Promise<Session | null>, options: AuthenticationCookieOptions) {
  const path = new URL(request.url).pathname;
  const rule = authenticationSubjectRule(path);
  let userId: string | undefined;
  let session: Session | null = null;
  let verificationCreatedAt: Date | undefined;
  let trustCreatedAt: Date | undefined;
  let target = 'anonymous';
  const cookies = await authenticationCookies(request.headers, options);
  const verification = async (identifier?: string) => identifier
    ? (await pool.query<Verification>('SELECT value, "createdAt", "expiresAt" FROM public.verification WHERE identifier = $1', [identifier])).rows[0]
    : undefined;
  if (rule === 'session' || rule === 'registration') {
    session = await readSession();
    if (session) { userId = session.user.id; target = userId; }
    else if (path.startsWith('/api/auth/two-factor/verify-')) {
      // Unlike lock selection alone, failure attribution requires a signed,
      // live challenge. No body identity can replace the provider's subject.
      const identifier = await cookies.signed('two_factor');
      const proof = await verification(identifier);
      if (proof && proof.expiresAt > new Date()) { userId = proof.value; verificationCreatedAt = proof.createdAt; }
      target = identifier ?? 'anonymous';
    }
    if (session && path === '/api/auth/passkey/verify-registration') {
      verificationCreatedAt = (await verification(await cookies.signed('better-auth-passkey')))?.createdAt;
    }
  } else if (request.method === 'POST' && ['email', 'credential', 'reset-token'].includes(rule)) {
    const body = await authenticationBody(request);
    if (rule === 'email' && typeof body.email === 'string') {
      target = body.email.toLowerCase();
      userId = (await pool.query<{ id: string }>('SELECT id FROM public."user" WHERE email = $1', [target])).rows[0]?.id;
      if (path === '/api/auth/sign-in/email' && userId) {
        const identifier = (await cookies.signed('trust_device'))?.split('!')[1];
        const trust = await verification(identifier);
        if (trust?.value === userId) trustCreatedAt = trust.createdAt;
      }
    } else if (rule === 'credential') {
      const response = body.response as { id?: unknown } | undefined;
      if (typeof response?.id === 'string') {
        target = response.id;
        userId = (await pool.query<{ userId: string }>('SELECT "userId" FROM public.passkey WHERE "credentialID" = $1', [target])).rows[0]?.userId;
      }
    } else if (rule === 'reset-token') {
      const token = typeof body.token === 'string' && body.token ? body.token : new URL(request.url).searchParams.get('token');
      if (token) {
        target = token;
        const proof = await verification(`reset-password:${token}`);
        userId = proof?.value; verificationCreatedAt = proof?.createdAt;
      }
    }
  } else if (rule === 'verified-email') {
    try {
      const { email } = decodeJwt(new URL(request.url).searchParams.get('token') ?? '');
      if (typeof email === 'string') userId = (await pool.query<{ id: string }>('SELECT id FROM public."user" WHERE email = $1', [email])).rows[0]?.id;
    } catch { /* the provider refuses malformed tokens */ }
  }
  return { rule, userId, session, sessionId: session?.session.id, verificationCreatedAt, trustCreatedAt, target,
    signedInBudget: rule === 'session' && !!session };
}
