import { securityResponseLimits as limits, securityResponseByteBudgets } from './security-response-bounds';

export type SignInProfile = Readonly<{ client_id: string; scope: readonly string[] }>;
export type SignInProof = {
  account_id: string;
  client_id: string;
  scope: string[];
  authn_epoch: number;
  auth_time: number;
  amr: ('pwd' | 'pop')[];
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= limits.id;
const number = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Native normalizes submitted scopes by deduplicating and sorting, never by catalogue union. */
export function parseSignInProof(v: unknown, profile: SignInProfile, method: 'pwd' | 'pop'): SignInProof | null {
  const scope = [...new Set(profile.scope)].sort();
  if (
    !record(v) ||
    !exact(v, ['account_id', 'client_id', 'scope', 'authn_epoch', 'auth_time', 'amr']) ||
    !id(v.account_id) ||
    !id(v.client_id) ||
    v.client_id !== profile.client_id ||
    !Array.isArray(v.scope) ||
    v.scope.length !== scope.length ||
    !scope.every((s, i) => (v.scope as unknown[])[i] === s) ||
    !number(v.authn_epoch) ||
    !number(v.auth_time) ||
    !Array.isArray(v.amr) ||
    v.amr.length !== 1 ||
    v.amr[0] !== method
  )
    return null;
  return {
    account_id: v.account_id,
    client_id: v.client_id,
    scope,
    authn_epoch: v.authn_epoch,
    auth_time: v.auth_time,
    amr: [method],
  };
}

/** Same native ID, number and scope maxima as Security; only issued scope count comes from the fixed input. */
export const signInProofBytes = (profile: SignInProfile) =>
  securityResponseByteBudgets(new Set(profile.scope).size).session;

export type SignInOptions = { rpId: 'rezics.com'; challenge: string; timeout: 60000; userVerification: 'required' };
// Pinned generator: base64url(32 bytes), configured RP, default timeout; no session header means no allow list.
const optionsBytes = (verification: string) =>
  JSON.stringify({ rpId: 'rezics.com', challenge: 'A'.repeat(43), timeout: 60000, userVerification: verification })
    .length;
export const signInResponseBytes = Object.freeze({
  options: optionsBytes('required'),
  pluginOptions: optionsBytes('preferred'),
  error: JSON.stringify({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }).length,
});
export function parseSignInOptions(v: unknown, plugin = false): SignInOptions | null {
  if (
    !record(v) ||
    !exact(v, ['rpId', 'challenge', 'timeout', 'userVerification']) ||
    v.rpId !== 'rezics.com' ||
    typeof v.challenge !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.challenge) ||
    v.timeout !== 60000 ||
    v.userVerification !== (plugin ? 'preferred' : 'required')
  )
    return null;
  return { rpId: 'rezics.com', challenge: v.challenge, timeout: 60000, userVerification: 'required' };
}
/** Native wrapper emits authentication_denied even for attempt throttling. Keep older rate_limited compatibility. */
export function parseSignInError(v: unknown, status: number): string | null {
  if (!record(v)) return null;
  if (exact(v, ['error']) && v.error === 'authentication_denied' && status !== 200) return v.error;
  if (status === 429 && exact(v, ['error']) && v.error === 'rate_limited') return v.error;
  if (status === 429 && exact(v, ['code']) && v.code === 'rate_limited') return v.code;
  if (
    status === 403 &&
    exact(v, ['error', 'code']) &&
    v.error === 'account_suspended' &&
    v.code === 'ACCOUNT_SUSPENDED'
  )
    return 'ACCOUNT_SUSPENDED';
  return null;
}
