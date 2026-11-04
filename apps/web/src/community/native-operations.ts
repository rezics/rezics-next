import type { KernelClient } from '@rezics/client';

export type RealmJoinAdvice =
  | { state: 'current'; allowed: boolean }
  | { state: 'refused' | 'unavailable' | 'withheld' };

/** Read only the installed personal advice for the one Realm join operation. */
export async function readRealmJoinAdvice(
  client: KernelClient,
  realmId: string,
  authorization: string,
): Promise<RealmJoinAdvice> {
  try {
    const result = await client.viewerActions.post(
      { resources: [{ type: 'community.realm', id: realmId }] },
      { headers: { authorization }, fetch: { cache: 'no-store' } },
    );
    if (result.status === 401 || result.status === 403) return { state: 'refused' };
    if (result.status !== 200 || !result.data || result.data.resources.length !== 1) return { state: 'unavailable' };
    const resource = result.data.resources[0];
    if (!resource || resource.type !== 'community.realm' || resource.id !== realmId) return { state: 'unavailable' };
    if (!('viewerActions' in resource)) return { state: 'withheld' };

    const entries = resource.viewerActions;
    if (
      entries.length > 64 ||
      entries.reduce((count, entry) => count + entry.operations.length, 0) > 256 ||
      entries.some(
        (entry) =>
          typeof entry.action !== 'string' ||
          !Array.isArray(entry.operations) ||
          entry.operations.some((operation) => typeof operation !== 'string'),
      )
    )
      return { state: 'unavailable' };

    return {
      state: 'current',
      allowed: entries.some((entry) => entry.action === 'realm:join' && entry.operations.includes('realm.join')),
    };
  } catch {
    return { state: 'unavailable' };
  }
}
