import { t } from 'elysia';
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
