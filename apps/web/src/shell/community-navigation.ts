import type { KernelClient } from '@rezics/client';
import { followListQuery, getFollowList, type FollowEdge } from '../library/follow-transport';

/** The native Follow destination union is the receiving seam for future supported destinations. */
type NativeDestination = Exclude<NonNullable<FollowEdge['destination']>, { kind: 'unavailable' }>;
export type ShellCommunity = {
  id: string;
  kind: NativeDestination['kind'];
  title: string;
  titleLanguage?: string;
  path: `/${string}`;
};
export type ShellCommunities = { subject: string; locale: string; items: ShellCommunity[]; more: boolean };
export const SHELL_COMMUNITY_LIMIT = 12;

/** Consume the FULL projection; never infer a Realm from ownership or a Space address from its UUID. */
export function shellFollowDestination(follow: FollowEdge): ShellCommunity | null {
  const { target, destination } = follow;
  if (
    follow.state !== 'following' ||
    !target ||
    !('label' in target) ||
    !target.label ||
    !destination ||
    destination.kind === 'unavailable'
  )
    return null;
  const title = typeof target.label === 'string' ? target.label : target.label.value;
  const titleLanguage = typeof target.label === 'string' ? undefined : target.label.language;
  const path = shellDestinationPath(destination);
  if (path === null) return null;
  return {
    id: follow.targetId,
    kind: destination.kind,
    title,
    ...(titleLanguage === undefined ? {} : { titleLanguage }),
    path,
  };
}

function shellDestinationPath(destination: NativeDestination): `/${string}` | null {
  switch (destination.kind) {
    case 'space':
      return `/spaces/${encodeURIComponent(destination.address)}`;
    case 'realm':
      return `/realms/${encodeURIComponent(destination.realmId)}`;
    case 'zone':
      return null;
  }
}

/** Filter before native paging so Subject follows cannot crowd Spaces out of the rail. */
export async function loadShellCommunities(
  client: KernelClient,
  authorization: string,
): Promise<Pick<ShellCommunities, 'items' | 'more'>> {
  const result = await getFollowList(client, authorization, followListQuery(undefined, SHELL_COMMUNITY_LIMIT, 'space'));
  if (result.error || !result.data) throw new Error('Community navigation unavailable');
  return {
    items: result.data.follows.flatMap((follow) => {
      const item = shellFollowDestination(follow);
      return item ? [item] : [];
    }),
    more: !!result.data.next,
  };
}
