import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { securityResponseLimits } from '@rezics/auth-contract';
import { readJsonBounded } from './private-auth-json';
import { readSecurityIssuerResponse, trustedSecurityResponseConfiguration } from './security-response-config';
import type { AccountSessionResult } from './account-operations';

type SessionObservation = Exclude<AccountSessionResult, { kind: 'failure' }> | { kind: 'failure' };

/** Validate only the native session values consumed by account journeys. */
export function parseAccountSession(body: unknown, scopeLimit: number): SessionObservation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'failure' };
  const value = body as Record<string, unknown>;
  if (typeof value.account_id !== 'string' || !value.account_id || value.account_id.length > securityResponseLimits.id)
    return { kind: 'failure' };
  const clientId = value.client_id;
  const scopes = value.scope;
  if (
    (clientId !== undefined &&
      (typeof clientId !== 'string' || !clientId || clientId.length > securityResponseLimits.id)) ||
    (scopes !== undefined &&
      (!Array.isArray(scopes) ||
        scopes.length > scopeLimit ||
        !scopes.every((scope) => typeof scope === 'string' && scope.length <= securityResponseLimits.scope)))
  )
    return { kind: 'failure' };
  return {
    kind: 'ready',
    accountId: value.account_id,
    ...(typeof clientId === 'string' ? { clientId } : {}),
    ...(Array.isArray(scopes) ? { scopes: [...scopes] as string[] } : {}),
  };
}

/** Read the caller's native session through the shared trusted issuer transport. */
export const readNativeAccountSessionAuthority = createServerOnlyFn(
  async (): Promise<SessionObservation | { kind: 'denied' }> => {
    const configuration = await trustedSecurityResponseConfiguration();
    if (!configuration) return { kind: 'failure' };
    return readSecurityIssuerResponse('/session', undefined, async (response, signal) => {
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 403) return { kind: 'denied' };
      if (response.status !== 200) return { kind: 'failure' };
      return parseAccountSession(
        await readJsonBounded(response, configuration.sessionBytes, signal),
        configuration.scopeLimit,
      );
    });
  },
);

// Existing account consumers retain their failure classification for native denial.
export const readNativeAccountSession = createServerOnlyFn(async (): Promise<SessionObservation> => {
  const result = await readNativeAccountSessionAuthority();
  return result.kind === 'denied' ? { kind: 'failure' } : result;
});

const readSession = createServerFn({ method: 'POST' }).handler(async () => readNativeAccountSession());

export function requestAccountSession(signal?: AbortSignal): Promise<SessionObservation> {
  return readSession(signal ? { signal } : {});
}
