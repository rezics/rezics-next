import type { KernelClient } from '@rezics/client';
import type { AccountProfile } from '../../features/pages/account-read';
import { publicAccountRead } from './request';

export type PublicReadState = 'denied' | 'preparing' | 'unavailable';
export type RealmRow = { id: string; title: string; summary: string | null; role: 'owner' | 'member' };
export type PublicRealms =
  | { state: 'ready'; realms: RealmRow[]; next: string | null }
  | { state: PublicReadState | 'invalid-cursor' };

export function readFailure(status: number): PublicReadState | 'invalid-cursor' {
  if (status === 400) return 'invalid-cursor';
  if (status === 401 || status === 403) return 'denied';
  if (status === 202) return 'preparing';
  return 'unavailable';
}

/** The owner supplies both the inverse and its signed continuation. Never discover membership by scanning. */
export async function readPublicRealms(
  client: KernelClient,
  profile: AccountProfile,
  cursor?: string,
  signal?: AbortSignal,
): Promise<PublicRealms> {
  if (!profile.publicViews.realms) return { state: 'denied' };
  try {
    return await publicAccountRead(
      client,
      async (client): Promise<PublicRealms> => {
        const result = await client.accounts({ accountId: profile.id }).realms.get({
          query: { limit: 20, ...(cursor ? { cursor } : {}) },
        });
        if (result.status !== 200 || !result.data) return { state: readFailure(result.status) };
        const rows = await Promise.all(
          result.data.realms.map(async ({ id, role }) => {
            const response = await client.realms({ realmId: id }).get();
            // A hidden or removed Realm contributes no text, link, placeholder or count.
            if (response.status === 403 || response.status === 404) return null;
            if (response.status !== 200 || !response.data) throw new Error('Realm unavailable');
            const realm = response.data.realm;
            return { id, role, title: realm.title, summary: realm.summary };
          }),
        );
        return { state: 'ready', realms: rows.filter((row) => row !== null), next: result.data.next };
      },
      signal,
    );
  } catch {
    return { state: 'unavailable' };
  }
}
