import type { KernelClient } from '@rezics/client';
import type { ManagedAuthNavigation } from './auth-navigation';
import { readWithin } from './read-deadline';

export type Identity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
};
export type DirectoryNavigation = { state: 'admitted' | 'unavailable' | 'concealed' };
export type Responsibility = {
  reservationId: string;
  accountId: string;
  account: Identity | null;
  state: 'current' | 'reconciling';
  navigation?: DirectoryNavigation;
};
export type Inventory = {
  account: Identity;
  viewer: { state: 'current'; account: Identity };
  organizations: {
    state: 'ready' | 'preparing';
    items: { account: Identity; role: 'owner' | 'member'; navigation?: DirectoryNavigation }[];
    next: string | null;
  };
  responsibilities: { items: Responsibility[]; next: string | null };
};
export type Detail = {
  account: Identity;
  self: boolean;
  role: 'owner' | 'member' | null;
  operator: Identity | null;
  relation: { operatorAccountId: string; reservationId: string; version: string } | null;
  members: {
    state: 'ready' | 'denied';
    items: { accountId: string; account: Identity | null; role: 'owner' | 'member' }[];
    next: string | null;
  };
  responsibilities: Inventory['responsibilities'] | null;
};
export type PageFailure = { state: 'denied' | 'unavailable' | 'preparing' | 'missing' | 'signed-out' };
export type Page<T> =
  | {
      state: 'ready';
      value: T;
      issuer: string | null;
      organizationsAvailable: boolean | null;
      authNavigation?: ManagedAuthNavigation;
    }
  | PageFailure;
export type DetailLoad = PageFailure | { state: 'ready'; value: Detail; authActions?: unknown };
export type Cursors = { organizationsCursor?: string; operatorsCursor?: string; membersCursor?: string };

export function readCursors(value: Record<string, unknown>): Cursors {
  const result: Cursors = {};
  for (const key of ['organizationsCursor', 'operatorsCursor', 'membersCursor'] as const) {
    const cursor = value[key];
    if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4096) result[key] = cursor;
  }
  return result;
}

export function failure(status: number, body?: unknown): PageFailure {
  const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : '';
  if (status === 401) return { state: 'signed-out' };
  if (status === 403) return { state: 'denied' };
  if (status === 404) return { state: 'missing' };
  if (code === 'membership_inverse_incomplete' || code === 'preparing' || status === 202) return { state: 'preparing' };
  return { state: 'unavailable' };
}

export async function loadInventory(
  client: KernelClient,
  authorization: string,
  cursors: Cursors,
  signal?: AbortSignal,
) {
  try {
    const result = await readWithin(
      (signal) =>
        client.me.managedAccounts.get({
          fetch: { signal },
          headers: { authorization },
          query: {
            ...(cursors.organizationsCursor ? { organizationsCursor: cursors.organizationsCursor } : {}),
            ...(cursors.operatorsCursor ? { operatorsCursor: cursors.operatorsCursor } : {}),
          },
        }),
      signal,
      10_000,
    );
    return result.error || !result.data
      ? failure(result.status, result.error?.value)
      : { state: 'ready' as const, value: result.data as Inventory };
  } catch {
    return { state: 'unavailable' as const };
  }
}

export async function loadDetail(
  client: KernelClient,
  authorization: string,
  accountId: string,
  cursors: Cursors,
  signal?: AbortSignal,
): Promise<DetailLoad> {
  try {
    const result = await readWithin(
      (signal) =>
        client.accounts({ accountId }).management.get({
          fetch: { signal },
          headers: { authorization },
          query: {
            ...(cursors.membersCursor ? { membersCursor: cursors.membersCursor } : {}),
            ...(cursors.operatorsCursor ? { operatorsCursor: cursors.operatorsCursor } : {}),
          },
        }),
      signal,
      10_000,
    );
    if (result.error || !result.data) return failure(result.status, result.error?.value);
    const data = result.data as Detail & { authActions?: unknown };
    const { authActions, ...value } = data;
    return {
      state: 'ready' as const,
      value,
      ...(authActions === undefined ? {} : { authActions }),
    };
  } catch {
    return { state: 'unavailable' as const };
  }
}

/** Discovery controls exposure only; unknown capability information grants nothing. */
export async function loadOrganizationsAvailable(client: KernelClient, authorization: string, signal?: AbortSignal) {
  try {
    const result = await readWithin(
      (signal) => client.platform.exposure.get({ headers: { authorization }, fetch: { signal } }),
      signal,
      2_000,
    );
    return result.error || !result.data ? null : result.data.admitted.includes('organizations');
  } catch {
    return null;
  }
}

export function issuerPage(
  issuer: string | null,
  path: '/organizations/new' | '/account/delete' | '/automated/new' | '/automated/open',
): string | null {
  if (!issuer) return null;
  try {
    const url = new URL(issuer);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return new URL(path, url).href;
  } catch {
    return null;
  }
}
