// Server Component reads of the operator API with the visitor's cookies.
import { headers } from 'next/headers';
import { cache } from 'react';
import { accountsConfig, httpOrigin } from '../../config/env.ts';
import { queryString } from './client.ts';
import type { AdminMe, AuditPage, AuditParams, ClientPage, Directory, DirectoryParams, Operators, Overview,
  Preferences, UserDetail } from './types.ts';

/** `forbidden`: signed in, but not an operator with the permission this read needs. */
export type AdminRead<T> = { status: 'ok'; data: T } | { status: 'signed-out' } | { status: 'forbidden' }
  | { status: 'not-found' } | { status: 'unavailable' };

async function read<T>(path: string): Promise<AdminRead<T>> {
  const cookie = (await headers()).get('cookie');
  if (!cookie) return { status: 'signed-out' };
  const origin = httpOrigin('ACCOUNT_SERVICE_ORIGIN', accountsConfig().ACCOUNT_SERVICE_ORIGIN);
  let response: Response;
  try {
    response = await fetch(new URL(`/api/account/admin${path}`, origin), { cache: 'no-store',
      headers: { accept: 'application/json', cookie }, signal: AbortSignal.timeout(8_000) });
  } catch {
    return { status: 'unavailable' };
  }
  if (response.status === 401) return { status: 'signed-out' };
  if (response.status === 403) return { status: 'forbidden' };
  if (response.status === 404) return { status: 'not-found' };
  if (!response.ok) return { status: 'unavailable' };
  const data = await response.json().catch(() => null) as T | null;
  return data === null ? { status: 'unavailable' } : { status: 'ok', data };
}

/** One role read per request, shared by the shell and the page. */
export const readAdminMe = cache(() => read<AdminMe>('/me'));
export const readPreferences = cache(() => read<Preferences>('/preferences'));
export const readOverview = () => read<Overview>('/overview');
export const readDirectory = (params: DirectoryParams) => read<Directory>(`/users${queryString(params)}`);
export const readUser = (userId: string) => read<UserDetail>(`/users/${encodeURIComponent(userId)}`);
export const readSanctions = (userId: string) => read<AuditPage>(`/users/${encodeURIComponent(userId)}/sanctions`);
export const readAudit = (params: AuditParams) => read<AuditPage>(`/audit${queryString(params)}`);
export const readOperators = () => read<Operators>('/operators');
export const readClients = () => read<ClientPage>(`/clients${queryString({ limit: 100 })}`);
