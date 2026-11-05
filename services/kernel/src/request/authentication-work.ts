import type { Access } from './access.ts';
import type { Pool } from 'pg';
import {
  accessNativeDeclaration,
  addAccessWork,
  type AccessWork,
  type AccessWorkAccounting,
  type AccessWorkProducer,
} from '../work/access-work.ts';

/** The public Auth signer has at most three live ES256/P-256 keys. */
export const AUTHENTICATION_JWKS_LIMITS = Object.freeze({
  keys: 3,
  responseBytes: 8192,
  fetchesPerVerification: 2,
  timeoutMilliseconds: 2000,
  cacheMilliseconds: 300_000,
  cooldownMilliseconds: 0,
});

/** Exact per-call values stay in memory and never enter an Access work receipt. */
export type OriginalAuthenticationInvocation = Readonly<{
  token: string;
  pool: Pool;
  deadline: number;
  work: AccessWorkAccounting;
}>;

export type AuthenticationWorkProducer = AccessWorkProducer<OriginalAuthenticationInvocation, AccessWork> &
  Readonly<{
    invoke<T>(
      input: OriginalAuthenticationInvocation,
      dispatch: () => Promise<T>,
    ): Promise<Readonly<{ value: T; usage: AccessWork }>>;
  }>;

const maximumRoute = 65535;
const maximumUuid = 'x'.repeat(36);
const maximumTimestamp = 'x'.repeat(64);
const accountState = accessNativeDeclaration(
  'account-state',
  { route: maximumRoute, account_id: maximumUuid },
  { targets: 1 },
).bound;
const assignment = accessNativeDeclaration(
  'assignment',
  {
    route: maximumRoute,
    principal_id: maximumUuid,
    request_id: maximumUuid,
    actor_id: maximumUuid,
    at: maximumTimestamp,
  },
  {},
).bound;
const checkout: AccessWork = Object.freeze({
  keys: 0,
  points: 1,
  witnesses: 0,
  rows: 0,
  bytes: 0,
  emptySeeks: 0,
});

/** Bounded JOSE and remote-key lookup declaration for this exact compact token. */
export function authenticationVerificationWorkBound(token: string): AccessWork {
  const tokenBytes = Buffer.byteLength(token, 'utf8');
  if (!Number.isSafeInteger(tokenBytes)) throw new TypeError('Invalid Bearer token size');
  return {
    keys: AUTHENTICATION_JWKS_LIMITS.keys * AUTHENTICATION_JWKS_LIMITS.fetchesPerVerification,
    points: 1 + AUTHENTICATION_JWKS_LIMITS.fetchesPerVerification,
    witnesses: 0,
    rows: AUTHENTICATION_JWKS_LIMITS.keys * AUTHENTICATION_JWKS_LIMITS.fetchesPerVerification,
    bytes: tokenBytes + AUTHENTICATION_JWKS_LIMITS.responseBytes * AUTHENTICATION_JWKS_LIMITS.fetchesPerVerification,
    emptySeeks: 0,
  };
}

/**
 * Pure declaration for one original Bearer authentication. The JOSE side uses
 * the admitted token byte length, at most two JWKS responses of at most 8192
 * bytes and at most three Auth signing keys per response. Native declarations
 * come from the existing account-state and assignment producers.
 */
export function authenticationWorkBound(token: string): AccessWork {
  return addAccessWork(authenticationVerificationWorkBound(token), checkout, accountState, checkout, assignment);
}

function producer(): AuthenticationWorkProducer {
  const value: AuthenticationWorkProducer = {
    bound(input) {
      if (input.work.deadline !== input.deadline || !Number.isFinite(input.deadline)) return undefined;
      return authenticationWorkBound(input.token);
    },
    actual(_input, usage) {
      return usage;
    },
    async invoke<T>(
      input: OriginalAuthenticationInvocation,
      dispatch: () => Promise<T>,
    ): Promise<Readonly<{ value: T; usage: AccessWork }>> {
      const bound = value.bound(input);
      if (!bound) return input.work.unavailable('Auth bearer authentication frame/deadline mismatch');
      const receipt = await input.work.invocation('access.authenticate', bound, dispatch, input.deadline);
      const actual = value.actual(input, receipt.usage);
      if (!actual) return input.work.unavailable('Auth bearer authentication actual receipt');
      return { value: receipt.value, usage: actual };
    },
  };
  return Object.freeze(value);
}

const originalAuthenticationWork = producer();
const originalAuthenticators = new WeakMap<Access['authenticate'], AuthenticationWorkProducer>();

/** Installed only by createAuthenticator for the original implementation. */
export function installOriginalAuthenticator(authenticate: Access['authenticate']): void {
  originalAuthenticators.set(authenticate, originalAuthenticationWork);
}

/** Derived Access preserves the producer only when it preserves the auth port. */
export function inheritOriginalAuthenticator(base: Access['authenticate'], derived: Access['authenticate']): void {
  const work = originalAuthenticators.get(base);
  if (work) originalAuthenticators.set(derived, work);
}

/** Unknown callbacks never acquire trust by shape or by being wrapped. */
export function hasOriginalAuthenticator(authenticate: Access['authenticate']): boolean {
  return originalAuthenticators.has(authenticate);
}

export function runOriginalAuthentication<T>(
  authenticate: Access['authenticate'],
  input: OriginalAuthenticationInvocation,
  dispatch: () => Promise<T>,
): Promise<Readonly<{ value: T; usage: AccessWork }>> {
  const work = originalAuthenticators.get(authenticate);
  if (!work) return input.work.unavailable('Auth bearer authentication native work producer');
  return work.invoke(input, dispatch);
}
