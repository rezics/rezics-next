import { t } from 'elysia';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';
import { currentIntrospection } from './introspection.ts';
import type { TLiteral, TUnion } from 'typebox';
import type { createAccountAuth } from './auth.ts';

/** A union of literal schemas whose static type keeps every literal; a bare
 * `t.Union(values.map(t.Literal))` reaches typed clients as `never`. */
export const literalUnion = <const T extends readonly string[]>(values: T): TUnion<{ -readonly [K in keyof T]: TLiteral<T[K]> }> =>
  t.Union(values.map(value => t.Literal(value))) as never;

export const accountErrorCodes = ['unauthenticated', 'forbidden', 'invalid_origin', 'invalid_request',
  'not_found', 'conflict', 'stale_request', 'step_up_required', 'last_sign_in_method',
  'rate_limited', 'temporarily_unavailable', 'account_suspended', 'password_reset_required',
  'invalid_birth_date', 'birth_date_required', 'age_ineligible', 'market_unavailable', 'market_restricted'] as const;
export type AccountErrorCode = typeof accountErrorCodes[number];
export const accountErrorSchema = t.Object({ error: literalUnion(accountErrorCodes) });

export class AccountProblem extends Error {
  constructor(readonly code: AccountErrorCode, readonly status: number) { super(code); }
}
export function accountJson<T>(value: T, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
export function accountFailure(error: unknown) {
  return error instanceof AccountProblem ? accountJson({ error: error.code }, error.status)
    : accountJson({ error: 'temporarily_unavailable' as const }, 503);
}
export type AccountAuth = ReturnType<typeof createAccountAuth>;
export async function accountSession(auth: AccountAuth, request: Request, write = request.method !== 'GET') {
  if (write && request.headers.get('origin') !== new URL(String(auth.options.baseURL)).origin) {
    throw new AccountProblem('invalid_origin', 403);
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AccountProblem('unauthenticated', 401);
  return session;
}

/** First-party preference reads verify the bearer and its current Account grant. */
export async function preferenceUser(auth: AccountAuth, pool: Pool, request: Request,
  allowedClientIds: ReadonlySet<string>): Promise<string> {
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(String(auth.options.baseURL)).origin) {
    throw new AccountProblem('invalid_origin', 403);
  }
  if (!request.headers.has('authorization')) return (await accountSession(auth, request)).user.id;
  const token = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  let claims: ReturnType<typeof decodeJwt> | undefined;
  try { if (token) claims = decodeJwt(token); } catch { /* invalid bearer */ }
  const clientId = claims?.client_id;
  if (typeof clientId !== 'string') throw new AccountProblem('unauthenticated', 401);
  if (!allowedClientIds.has(clientId)) throw new AccountProblem('forbidden', 403);
  const profile = await auth.api.oauth2UserInfo({ headers: request.headers }).catch(() => null);
  if (!profile || typeof profile.sub !== 'string' || !profile.sub) throw new AccountProblem('unauthenticated', 401);
  // UserInfo verifies the bearer signature; Account's current introspection
  // also checks revocation, suspension and the grant's present generation.
  const current = await currentIntrospection(pool, token!, Response.json({ ...claims, active: true }));
  if (!current.ok) throw new AccountProblem('temporarily_unavailable', 503);
  if ((await current.json() as { active?: boolean }).active !== true || claims?.sub !== profile.sub) {
    throw new AccountProblem('unauthenticated', 401);
  }
  return profile.sub;
}
