import type { KernelClient } from '@rezics/client';
import type { Media, ReservationInput } from '../media/kernel';
import { dependencyUnavailable } from '../media/kernel';
import type {
  RealmAppearanceRead,
  RealmAppearanceResult,
  RealmAppearanceSelection,
  RealmAppearanceCommand,
  RealmAppearanceChoice,
} from './realm-presentation';

export type RealmMediaReservation = Readonly<{
  purpose: 'realm-icon' | 'realm-banner';
  mediaType: ReservationInput['mediaType'];
  byteCount: number;
  sha256?: string;
}>;

/** Pending native POST /v1/realms/{id}/media. Never fall back to post/account avatar reservation. */
export async function reserveRealmMedia(
  _client: KernelClient,
  _authorization: string | null,
  _realmId: string,
  _input: RealmMediaReservation,
): Promise<Media> {
  throw dependencyUnavailable(503);
}

/** Current native admission controls visibility even while the optional presentation producer is absent. */
export async function readRealmAppearance(
  client: KernelClient,
  authorization: string | null,
  realmId: string,
): Promise<RealmAppearanceRead> {
  if (!authorization) return { kind: 'hidden' };
  const auth = { headers: { authorization } };
  try {
    const before = await client.realms({ realmId }).get(auth);
    if (before.error || before.data.realm.realmId !== realmId || before.data.realm.state !== 'active')
      return { kind: 'hidden' };
    const actions = await client.viewerActions.post({ resources: [{ type: 'community.realm', id: realmId }] }, auth);
    if (
      actions.error ||
      !actions.data.resources.some(
        (resource) =>
          resource.type === 'community.realm' &&
          resource.id === realmId &&
          'viewerActions' in resource &&
          resource.viewerActions.some((action) => action.operations.includes('realm.update')),
      )
    )
      return { kind: 'hidden' };
    const final = await client.realms({ realmId }).get(auth);
    if (
      final.error ||
      final.data.realm.state !== 'active' ||
      final.data.realm.realmId !== realmId ||
      final.data.realm.headRevisionId !== before.data.realm.headRevisionId ||
      final.data.realm.contextId !== before.data.realm.contextId ||
      final.data.realm.spaceId !== before.data.realm.spaceId
    )
      return { kind: 'hidden' };
    // Generated Realm GET/PATCH and image/rules summaries do not yet include the selected presentation contract.
    return { kind: 'unavailable' };
  } catch {
    return { kind: 'hidden' };
  }
}

/** Isolated unavailable adapter, removed when generated native delivery is present. No speculative HTTP or casts. */
export async function changeRealmAppearance(_command: RealmAppearanceCommand): Promise<RealmAppearanceResult> {
  return { kind: 'unavailable' };
}
export async function selectRealmAppearance(_choice: RealmAppearanceChoice): Promise<RealmAppearanceSelection> {
  return { kind: 'unavailable' };
}
