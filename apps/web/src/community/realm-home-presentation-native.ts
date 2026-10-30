import type { KernelClient } from '@rezics/client';
import { boardCommunitySource, type CommunityPresentation } from '../threads/board-community-source';
import { realmClaimSnapshot, sameRealmClaimSource } from './realm-claim';
import { sameRealmPresentation } from './realm-presentation';

type RealmRoute = ReturnType<KernelClient['realms']>;
type NativeRealm = NonNullable<Awaited<ReturnType<RealmRoute['get']>>['data']>['realm'];
type NativeSpace = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['spaces']>['get']>>['data']>['space'];
type Auth = { headers: { authorization: string } } | Record<string, never>;

export type RealmHomePresentation =
  | { state: 'available'; value: CommunityPresentation }
  | { state: 'unavailable' | 'hidden'; value: null };

// The declared original route is not in the installed client yet. Keep only its consumer seam here;
// the generated original declaration takes precedence as soon as it is installed.
type PresentationRoute = RealmRoute extends { presentation: infer Route }
  ? Route
  : {
      get(auth: Auth): Promise<{
        status: number;
        data?: { community: CommunityPresentation } | null;
        error?: unknown;
      }>;
    };

const unavailable = { state: 'unavailable', value: null } as const;
const hidden = { state: 'hidden', value: null } as const;

/** One optional presentation read after the ordinary page reads, with no source/board enrichment or retry. */
export async function readRealmHomePresentation(
  client: KernelClient,
  auth: Auth,
  realm: NativeRealm,
  space: NativeSpace,
): Promise<RealmHomePresentation> {
  const before = realmClaimSnapshot(realm);
  if (
    realm.state !== 'active' ||
    space.state !== 'active' ||
    realm.spaceId !== space.spaceId ||
    space.realmId !== realm.realmId
  )
    return hidden;
  // Older responses cannot establish the current lifecycle or selected-reference binding.
  if (!before || !realm.presentation) return unavailable;
  // Governance freezes writes; the native presentation read still decides disclosure for an active orphan.
  try {
    const route = client.realms({ realmId: realm.realmId }) as RealmRoute & { presentation?: PresentationRoute };
    const result = await route.presentation?.get(auth);
    if (!result) return unavailable;
    if (result.status === 401 || result.status === 403 || result.status === 404) return hidden;
    const source =
      !result.error && result.status === 200 && result.data
        ? boardCommunitySource({ realmId: realm.realmId, ...{ community: result.data.community } })
        : unavailable;
    const [finalRealm, finalSpace] = await Promise.all([
      client.realms({ realmId: realm.realmId }).get(auth),
      client.spaces({ spaceId: space.spaceId }).get(auth),
    ]);
    if (finalRealm.error || finalSpace.error || !finalRealm.data || !finalSpace.data)
      return [finalRealm.status, finalSpace.status].some((status) => [401, 403, 404].includes(status))
        ? hidden
        : unavailable;
    const current = realmClaimSnapshot(finalRealm.data.realm);
    if (
      !current ||
      !sameRealmClaimSource(before, current) ||
      finalRealm.data.realm.visibility !== realm.visibility ||
      finalSpace.data.space.state !== 'active' ||
      finalSpace.data.space.spaceId !== space.spaceId ||
      finalSpace.data.space.headRevisionId !== space.headRevisionId ||
      finalSpace.data.space.realmId !== realm.realmId ||
      !sameRealmPresentation(realm.presentation, finalRealm.data.realm.presentation)
    )
      return hidden;
    if (source?.state !== 'available') return unavailable;
    const community = source.value;
    if (
      community.spaceId !== space.spaceId ||
      community.contextId !== realm.contextId ||
      community.name !== realm.title ||
      community.description !== realm.summary
    )
      return hidden;
    for (const [slot, selected] of [
      [community.avatar, realm.presentation.avatarMediaId],
      [community.banner, realm.presentation.bannerMediaId],
    ] as const) {
      if (slot.state === 'available' && slot.value.id !== selected) return unavailable;
      // Native concealment/erasure is also `none`, even while the selected reference remains set.
    }
    if (
      community.rules.state === 'available' &&
      (community.rules.value.postId !== realm.presentation.rules?.postId ||
        community.rules.value.revisionId !== realm.presentation.rules?.revisionId)
    )
      return unavailable;
    return source;
  } catch {
    return unavailable;
  }
}
