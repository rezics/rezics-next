import type { KernelClient } from '@rezics/client';

export type ShellCommunity = {
  id: string;
  kind: 'realm' | 'space';
  title: string;
  path: `/realms/${string}` | `/spaces/${string}`;
  /** Realm routes redirect to a Space address when one exists. Both mark the same destination. */
  alternatePath?: `/realms/${string}`;
};
export type ShellCommunities = { subject: string; locale: string; items: ShellCommunity[]; more: boolean };
export const SHELL_COMMUNITY_LIMIT = 12;

/** A bounded first follows page; only readable active Spaces are enriched, never arbitrary target IDs. */
export async function loadShellCommunities(
  client: KernelClient,
  authorization: string,
): Promise<Pick<ShellCommunities, 'items' | 'more'>> {
  const auth = { headers: { authorization }, fetch: { cache: 'no-store' as const, redirect: 'manual' as const } };
  const follows = await client.follows.get({ ...auth, query: { view: 'FULL', limit: 100 } });
  if (follows.error || !follows.data) throw new Error('Community navigation unavailable');
  const spaces = follows.data.follows.filter(
    (follow) => follow.targetType === 'space' && follow.state === 'following' && follow.target,
  );
  const items = await Promise.all(
    spaces.slice(0, SHELL_COMMUNITY_LIMIT).map(async (follow): Promise<ShellCommunity | null> => {
      try {
        const result = await client.spaces({ spaceId: follow.targetId }).get(auth);
        const space = !result.error && result.data?.space;
        if (!space || space.state !== 'active' || space.spaceId !== follow.targetId) return null;
        if (space.realmId) {
          const result = await client.realms({ realmId: space.realmId }).get(auth);
          const realm = !result.error && result.data?.realm;
          if (realm && realm.state === 'active' && realm.realmId === space.realmId && realm.spaceId === space.spaceId) {
            const realmPath = `/realms/${encodeURIComponent(realm.realmId)}` as const;
            return {
              id: space.spaceId,
              kind: 'realm',
              title: realm.title,
              path: space.address ? `/spaces/${encodeURIComponent(space.address)}` : realmPath,
              alternatePath: realmPath,
            };
          }
        }
        return space.address
          ? {
              id: space.spaceId,
              kind: 'space',
              title: space.title,
              path: `/spaces/${encodeURIComponent(space.address)}`,
            }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return {
    items: items.filter((item): item is ShellCommunity => item !== null),
    more: !!follows.data.next || spaces.length > SHELL_COMMUNITY_LIMIT,
  };
}
