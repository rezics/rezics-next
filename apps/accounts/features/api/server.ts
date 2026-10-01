// Server Component reads from the Account service with the visitor's cookies.
import { parseContentPreferences } from './content-preferences.ts';
import { headers } from 'next/headers';
import { cache } from 'react';
import { parseActivity, parseConnectedApps, parseConsentPreview, parseDisplayPreferences, parseMethods, parsePublicClient, parseSession,
  parseSessions, record } from './account-data.ts';
import { accountsConfig, httpOrigin } from '../config/env.ts';
import { parsePolicyStatus } from '../auth/policies.ts';

export type { AccountSession } from './account-data.ts';

/** `stale`: the service wants a recent sign-in first; `missing`: the endpoint
 * is not deployed yet. */
export type Read<T> = { status: 'ok'; data: T } | { status: 'signed-out' } | { status: 'stale' }
  | { status: 'unavailable' } | { status: 'missing' };

const origins = () => {
  const config = accountsConfig();
  return { service: httpOrigin('ACCOUNT_SERVICE_ORIGIN', config.ACCOUNT_SERVICE_ORIGIN),
    public: httpOrigin('ACCOUNT_BASE_URL', config.ACCOUNT_BASE_URL) };
};

async function read<T>(path: string, parse: (value: unknown) => T | null,
  init: { body?: Record<string, unknown>; anonymous?: boolean } = {}): Promise<Read<T>> {
  const cookie = (await headers()).get('cookie');
  if (!cookie && !init.anonymous) return { status: 'signed-out' };
  const { service, public: publicOrigin } = origins();
  let response: Response;
  try {
    response = await fetch(new URL(path, service), { cache: 'no-store', signal: AbortSignal.timeout(8_000),
      method: init.body ? 'POST' : 'GET', body: init.body ? JSON.stringify(init.body) : undefined,
      headers: { accept: 'application/json', ...(cookie ? { cookie } : {}),
        // A POST read speaks for this public Account origin, as the proxy does.
        ...(init.body ? { 'content-type': 'application/json', origin: publicOrigin } : {}) } });
  } catch {
    return { status: 'unavailable' };
  }
  if (response.status === 401) return { status: 'signed-out' };
  if (response.status === 404) return { status: 'missing' };
  const body = await response.json().catch(() => undefined) as unknown;
  if (response.status === 403 && record(body)?.code === 'SESSION_NOT_FRESH') return { status: 'stale' };
  if (!response.ok) return { status: 'unavailable' };
  if (body === null && path === '/api/auth/get-session') return { status: 'signed-out' };
  const data = parse(body);
  return data === null ? { status: 'unavailable' } : { status: 'ok', data };
}

/** One session read per request, shared by the page and its sections. */
export const readSession = cache(() => read('/api/auth/get-session', parseSession));
export const readMethods = cache(() => read('/api/account/methods', parseMethods));
export const readContentPreferences = cache(() => read('/api/account/content-preferences', parseContentPreferences));
export const readPublicBirthday = cache((id: string) => read(`/api/account/birthday/${encodeURIComponent(id)}`,
  value => typeof record(value)?.birthDate === 'string' ? record(value)!.birthDate as string : null, { anonymous: true }));
export const readDisplayPreferences = cache(() => read('/api/account/display-preferences', parseDisplayPreferences));
export const readSessions = cache((cursor?: string) => read(`/api/account/sessions?limit=100${
  cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, parseSessions));
export const readSecurityActivity = cache((cursor?: string) => read(`/api/account/security-activity?limit=50${
  cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, parseActivity));
export const readConnectedApps = cache(() => read('/api/account/connected-apps?limit=100', parseConnectedApps));
export const readConsent = cache((oauthQuery: string) =>
  read(`/api/account/consent?${new URLSearchParams({ oauth_query: oauthQuery })}`, parseConsentPreview));
export const readPublicClient = cache((clientId: string) =>
  read(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, parsePublicClient));
/** The App behind a signed authorization request, before anyone signs in. */
export const readRequestingClient = cache((clientId: string, oauthQuery: string) =>
  read('/api/auth/oauth2/public-client-prelogin', parsePublicClient,
    { anonymous: true, body: { client_id: clientId, oauth_query: oauthQuery } }));
/** The current policy versions and whether this visitor must accept them; public, so sign-up can read it. */
export const readPolicyStatus = cache(() =>
  read('/api/account/policies', parsePolicyStatus, { anonymous: true }));
/** Whether the signed link behind an unsubscribe email is still valid; reading it changes nothing. */
export const readUnsubscribe = cache(async (token: string): Promise<'valid' | 'invalid' | 'unavailable'> => {
  try {
    const response = await fetch(new URL(`/api/account/mail/unsubscribe?${new URLSearchParams({ token })}`,
      origins().service), { cache: 'no-store', signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => null) as unknown;
    if (response.status === 400) return 'invalid';
    return response.ok && record(body)?.confirmationRequired === true ? 'valid' : 'unavailable';
  } catch { return 'unavailable'; }
});
