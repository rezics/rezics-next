// Server Component reads from the Account service with the visitor's cookies.
import { headers } from 'next/headers';
import { cache } from 'react';
import { type AccountSession, list, parseConsent, parseDeviceSession, parseLinkedAccount,
  parsePublicClient, parseSession, record } from './account-data.ts';
import { accountsConfig, httpOrigin } from '../config/env.ts';

export type { AccountSession } from './account-data.ts';

/** `stale`: the service wants a recent sign-in first; `missing`: the endpoint
 * is not deployed yet. */
export type Read<T> = { status: 'ok'; data: T } | { status: 'signed-out' } | { status: 'stale' }
  | { status: 'unavailable' } | { status: 'missing' };

async function read<T>(path: string, parse: (value: unknown) => T | null): Promise<Read<T>> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return { status: 'signed-out' };
  const origin = httpOrigin('ACCOUNT_SERVICE_ORIGIN', accountsConfig().ACCOUNT_SERVICE_ORIGIN);
  let response: Response;
  try {
    response = await fetch(new URL(`/api/auth${path}`, origin), { cache: 'no-store',
      headers: { accept: 'application/json', cookie }, signal: AbortSignal.timeout(8_000) });
  } catch {
    return { status: 'unavailable' };
  }
  if (response.status === 401) return { status: 'signed-out' };
  if (response.status === 404) return { status: 'missing' };
  const body = await response.json().catch(() => undefined) as unknown;
  if (response.status === 403 && record(body)?.code === 'SESSION_NOT_FRESH') return { status: 'stale' };
  if (!response.ok) return { status: 'unavailable' };
  if (body === null && path === '/get-session') return { status: 'signed-out' };
  const data = parse(body);
  return data === null ? { status: 'unavailable' } : { status: 'ok', data };
}

/** One session read per request, shared by the page and its sections. */
export const readSession = cache(() => read('/get-session', parseSession));
export const readDeviceSessions = cache(() =>
  read('/list-sessions', value => list(value, parseDeviceSession)));
export const readLinkedAccounts = cache(() =>
  read('/list-accounts', value => list(value, parseLinkedAccount)));
export const readConsents = cache(() => read('/oauth2/get-consents', value => list(value, parseConsent)));
export const readPublicClient = cache((clientId: string) =>
  read(`/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`, parsePublicClient));
