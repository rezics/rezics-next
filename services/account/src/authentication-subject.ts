import type { Pool, PoolClient } from 'pg';
import { AccountProblem } from './http.ts';
import { authenticationCookies } from './authentication-cookies.ts';
import { authenticationSession, type AuthenticationProvider, type AuthenticationSession,
  type PreparedAuthentication } from './authentication-input.ts';

export const sensitiveAuthPaths = new Set([
  '/api/auth/change-password', '/api/auth/set-password', '/api/auth/change-email', '/api/auth/delete-user',
  '/api/auth/link-social', '/api/auth/unlink-account', '/api/auth/passkey/generate-register-options',
  '/api/auth/passkey/verify-registration', '/api/auth/passkey/delete-passkey', '/api/auth/passkey/update-passkey',
  '/api/auth/two-factor/enable', '/api/auth/two-factor/disable',
  '/api/auth/two-factor/generate-backup-codes', '/api/auth/two-factor/get-totp-uri',
  '/api/auth/revoke-session', '/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions',
]);

export type AuthenticationPurpose = 'email' | 'reset-token' | 'credential' | 'session-proof'
  | 'registration' | 'session-mutation' | 'provider-owned';
export type AuthenticationSubject = Readonly<{
  purpose: AuthenticationPurpose;
  candidateUserId?: string;
  activityUserId?: string;
  session?: AuthenticationSession | null;
  verification?: { identifier: string; createdAt: Date; expiresAt: Date };
  trust?: { cookieName: string; identifier: string; createdAt: Date };
  target: string;
  signedInBudget: boolean;
}>;

/** Effective endpoint admission precedes classification. Uninstalled plugin
 * names and wrong HTTP methods cannot manufacture authentication candidates. */
export function authenticationPurpose(input: PreparedAuthentication): AuthenticationPurpose {
  if (input.kind === 'session' && ['/api/account/reauthenticate', '/api/account/reauthenticate/passkey'].includes(input.path)) return 'session-proof';
  if (!input.endpointPath) return 'provider-owned';
  if (input.path === '/api/auth/passkey/verify-registration') return 'registration';
  if (['/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-backup-code',
    '/api/auth/two-factor/verify-otp'].includes(input.path)) return 'session-proof';
  if (['/api/auth/sign-in/email', '/api/auth/sign-in/magic-link', '/api/auth/request-password-reset',
    '/api/auth/sign-up/email', '/api/auth/send-verification-email'].includes(input.path)) return 'email';
  if (input.path === '/api/auth/passkey/verify-authentication') return 'credential';
  if (input.path === '/api/auth/reset-password') return 'reset-token';
  if (sensitiveAuthPaths.has(input.path) || ['/api/auth/update-user', '/api/auth/sign-out'].includes(input.path)) return 'session-mutation';
  return 'provider-owned';
}

type Verification = { value: string; createdAt: Date; expiresAt: Date };

/** Indexed, nonconsuming projection of the provider's admitted input. Only
 * plain database-backed verification storage currently has this projection.
 * Provider proof consumption and Account policy locks remain authoritative. */
export async function resolveAuthenticationSubject(auth: AuthenticationProvider, database: Pool | PoolClient,
  input: PreparedAuthentication): Promise<AuthenticationSubject> {
  const purpose = authenticationPurpose(input);
  const provider = await auth.$context;
  const cookies = await authenticationCookies(input.headers, provider);
  let candidateUserId: string | undefined;
  let activityUserId: string | undefined;
  let session: AuthenticationSession | null = null;
  let verification: AuthenticationSubject['verification'];
  let trust: AuthenticationSubject['trust'];
  let target = 'anonymous';
  const proof = async (identifier?: string) => {
    if (!identifier) return undefined;
    if (provider.options.secondaryStorage || (provider.options.verification?.storeIdentifier
      && provider.options.verification.storeIdentifier !== 'plain')) throw new AccountProblem('temporarily_unavailable', 503);
    const rows = (await database.query<Verification>(`SELECT value, "createdAt", "expiresAt"
      FROM public.verification WHERE identifier = $1 ORDER BY "createdAt" DESC LIMIT 2`, [identifier])).rows;
    if (rows[0] && rows[1] && rows[0].createdAt.getTime() === rows[1].createdAt.getTime()) throw new AccountProblem('invalid_request', 400);
    return rows[0];
  };
  const liveUser = async (id: string) => (await database.query<{ id: string }>(
    'SELECT id FROM public."user" WHERE id = $1', [id])).rows[0]?.id;
  if (['session-proof', 'registration', 'session-mutation'].includes(purpose)) {
    session = await authenticationSession(auth, input);
    if (session) { candidateUserId = session.user.id; activityUserId = candidateUserId; target = candidateUserId; }
    const credentialOwners = new Set<string>(session ? [session.user.id] : []);
    const selectedSessionToken = await cookies.signed('session_token');
    for (const candidate of await cookies.candidateHeaders('session_token')) {
      if (candidate.value === selectedSessionToken) continue;
      const candidateInput = { ...input, headers: candidate.headers,
        ...(input.providerContext ? { providerContext: { ...input.providerContext, headers: candidate.headers,
          context: { ...input.providerContext.context, session: null } } } : {}),
        ...(input.kind === 'session' ? { kind: 'http' as const, session: undefined } : {}) };
      const other = await authenticationSession(auth, candidateInput);
      if (other) credentialOwners.add(other.user.id);
    }
    if (purpose === 'session-proof' && input.path !== '/api/account/reauthenticate/passkey') {
      const identifier = await cookies.signed('two_factor');
      const row = await proof(identifier);
      for (const candidate of await cookies.signedCandidates('two_factor')) {
        const other = candidate === identifier ? row : await proof(candidate);
        if (other && other.expiresAt > new Date()) {
          const owner = await liveUser(other.value);
          if (owner) credentialOwners.add(owner);
        }
      }
      if (!session && row && row.expiresAt > new Date()) {
        candidateUserId = await liveUser(row.value);
        activityUserId = candidateUserId;
        verification = { identifier: identifier!, createdAt: row.createdAt, expiresAt: row.expiresAt };
      }
      if (!session) target = identifier ?? 'anonymous';
    }
    if (purpose === 'registration') {
      const identifier = await cookies.signed('better-auth-passkey');
      const row = await proof(identifier);
      if (row) verification = { identifier: identifier!, createdAt: row.createdAt, expiresAt: row.expiresAt };
      for (const candidate of await cookies.signedCandidates('better-auth-passkey')) {
        const other = candidate === identifier ? row : await proof(candidate);
        if (!other || other.expiresAt <= new Date()) continue;
        try {
          const owner = (JSON.parse(other.value) as { userData?: { id?: unknown } }).userData?.id;
          if (typeof owner === 'string') credentialOwners.add(owner);
        } catch { /* malformed provider artifacts cannot prove another owner */ }
      }
    }
    if (input.path === '/api/account/reauthenticate/passkey') {
      const response = input.body.response as { id?: unknown } | undefined;
      if (typeof response?.id === 'string') {
        const owner = (await database.query<{ userId: string }>(
          'SELECT "userId" FROM public.passkey WHERE "credentialID" = $1', [response.id])).rows[0]?.userId;
        if (owner) credentialOwners.add(owner);
      }
    }
    if (credentialOwners.size > 1) throw new AccountProblem('invalid_request', 400);
  } else if (purpose === 'email' && typeof input.body.email === 'string') {
    target = input.body.email.toLowerCase();
    if (input.path === '/api/auth/send-verification-email') {
      session = await authenticationSession(auth, input);
      if (session) {
        if (session.user.email.toLowerCase() !== target) throw new AccountProblem('invalid_request', 400);
        target = session.user.email.toLowerCase();
      }
    }
    candidateUserId = (await database.query<{ id: string }>('SELECT id FROM public."user" WHERE email = $1', [target])).rows[0]?.id;
    activityUserId = candidateUserId;
    if (input.path === '/api/auth/sign-in/email' && candidateUserId) {
      // The outer signature supplies a lock candidate only. The provider owns
      // its inner user-bound trust HMAC and final bypass decision.
      const identifier = (await cookies.signed('trust_device'))?.split('!')[1];
      const row = await proof(identifier);
      if (row?.value === candidateUserId) trust = { cookieName: cookies.name('trust_device'), identifier: identifier!, createdAt: row.createdAt };
    }
  } else if (purpose === 'credential') {
    const response = input.body.response as { id?: unknown } | undefined;
    if (typeof response?.id === 'string') {
      target = response.id;
      candidateUserId = (await database.query<{ userId: string }>(
        'SELECT "userId" FROM public.passkey WHERE "credentialID" = $1', [target])).rows[0]?.userId;
      activityUserId = candidateUserId;
    }
  } else if (purpose === 'reset-token') {
    const token = typeof input.body.token === 'string' && input.body.token ? input.body.token : input.query.token;
    if (typeof token === 'string' && token) {
      target = token;
      const row = await proof(`reset-password:${token}`);
      if (row) {
        candidateUserId = row.value;
        verification = { identifier: `reset-password:${token}`, createdAt: row.createdAt, expiresAt: row.expiresAt };
        if (row.expiresAt > new Date()) activityUserId = await liveUser(row.value);
      }
    }
  }
  return Object.freeze({ purpose, candidateUserId, activityUserId, session, verification, trust, target,
    signedInBudget: purpose === 'session-proof' && !!session });
}
