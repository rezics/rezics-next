export const CONSENT_PAGE_MAX_SCOPES = 1000;
export const CONSENT_PAGE_MAX_SCOPE_QUERY_BYTES = 8192;

const scopePattern = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const encoder = new TextEncoder();

export type ConsentPageInput = {
  client: { client_id: string; display_name: string | null; first_party: boolean; scopes: string[] };
  identity: { account_id: string; email: string | null };
  requested: string[];
  consent: { scopes: string[]; pending_scopes: string[] | null } | null;
};

export type ConsentPage = {
  client_id: string;
  display_name: string | null;
  scopes: string[];
  requested: string[];
  granted: string[];
  pending_reduction: boolean;
  acting_account: { account_id: string; email: string | null };
  decisions: { allow: boolean; decline: boolean; switch_account: boolean };
};

/** Parse the untrusted OAuth scope query as a bounded set without treating it as authority. */
export function parseConsentRequestedScopes(value: string): string[] | null {
  if (encoder.encode(value).byteLength > CONSENT_PAGE_MAX_SCOPE_QUERY_BYTES) return null;
  const trimmed = value.replace(/^ +| +$/gu, '');
  if (!trimmed) return [];
  return normalizeConsentRequestedScopes(trimmed.split(/ +/u));
}

/** The POST writer uses the same syntax and count bound for reviewed request names. */
export function normalizeConsentRequestedScopes(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > CONSENT_PAGE_MAX_SCOPES ||
    value.some((scope) => typeof scope !== 'string' || scope.length > 128 || !scopePattern.test(scope))
  )
    return null;
  return [...new Set(value as string[])];
}

/** Compose the exact private review from current registration, session identity and consent observations. */
export function projectConsentPage(input: ConsentPageInput): ConsentPage | null {
  const { client, identity, requested, consent } = input;
  const normalizedRequested = normalizeConsentRequestedScopes(requested);
  if (
    !client.client_id ||
    client.client_id.length > 1024 ||
    client.first_party ||
    (client.display_name !== null && (typeof client.display_name !== 'string' || client.display_name.length > 100)) ||
    !scopeSet(client.scopes) ||
    !normalizedRequested ||
    !identity.account_id ||
    identity.account_id.length > 1024 ||
    (identity.email !== null && (identity.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identity.email))) ||
    (consent !== null &&
      (!scopeSet(consent.scopes) ||
        (consent.pending_scopes !== null &&
          (!scopeSet(consent.pending_scopes) ||
            consent.pending_scopes.some((scope) => !consent.scopes.includes(scope))))))
  )
    return null;

  const pendingReduction = consent?.pending_scopes !== null && consent !== null;
  const registered = new Set(client.scopes);
  if (consent?.scopes.some((scope) => !registered.has(scope))) return null;
  const pending = consent?.pending_scopes === null || consent === null ? null : new Set(consent.pending_scopes);
  const granted = consent?.scopes.filter((scope) => !pending || pending.has(scope)) ?? [];

  return {
    client_id: client.client_id,
    display_name: client.display_name,
    scopes: [...client.scopes],
    requested: normalizedRequested,
    granted,
    pending_reduction: pendingReduction,
    acting_account: { account_id: identity.account_id, email: identity.email },
    decisions: { allow: !pendingReduction, decline: true, switch_account: true },
  };
}

function scopeSet(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= CONSENT_PAGE_MAX_SCOPES &&
    value.every(
      (scope) => typeof scope === 'string' && scope.length > 0 && scope.length <= 128 && scopePattern.test(scope),
    ) &&
    new Set(value).size === value.length
  );
}
