import { readCommunityPresentations } from './domain-ports.ts';
import { communityPresentationResponse } from '../content/community-presentation-model.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { OwnRealmMembership, OwnRealmsDependencies } from './own-realms-shape.ts';
import { createRealmViewerObservation, type RealmViewerObservation } from './own-realms-viewer.ts';

/** Compose the installed home owners, with no account transaction held and no
 * per-card HTTP. Disclosure never feeds back into raw inventory selection.
 */
export async function hydrateOwnRealms(
  deps: OwnRealmsDependencies,
  actor: AccountActor,
  selected: readonly OwnRealmMembership[],
  context: { deadline: number },
) {
  const homes = new Map<number, OwnRealmMembership[]>();
  for (const member of selected) {
    const home = partitionOf(routeOf(member.realmId)!);
    homes.set(home, [...(homes.get(home) ?? []), member]);
  }
  const items = [];
  const observe = createRealmViewerObservation(deps);
  for (const members of homes.values()) {
    const observations = new Map<string, RealmViewerObservation>();
    for (const member of members) {
      const observation = await observe({
        actor,
        realmId: member.realmId,
        selected: member,
        deadline: context.deadline,
      });
      if (observation) observations.set(member.realmId, observation);
    }
    const presentations = await readCommunityPresentations(deps, [...observations.keys()], { ...context, actor });
    for (const member of members) {
      const observation = observations.get(member.realmId);
      if (!observation) continue;
      const current = await observation.finish();
      if (!current) continue;
      const presentation = presentations.get(member.realmId);
      if (
        !presentation ||
        presentation.name !== current.realm.title ||
        presentation.description !== current.realm.summary ||
        presentation.spaceId !== current.source.spaceId
      )
        throw new ProblemError('transaction_retry_exhausted');
      if (!current.membership) throw new ProblemError('transaction_retry_exhausted');
      const { avatar, banner } = communityPresentationResponse(presentation);
      items.push({
        realmId: current.realm.realmId,
        name: current.realm.title,
        role: 'member' as const,
        current: {
          description: current.realm.summary,
          avatar,
          banner,
          destination: {
            kind: 'realm' as const,
            realmId: current.realm.realmId,
          },
          spaceId: current.source.spaceId,
          viewer: {
            ...current.viewer,
            membership: {
              state: 'member' as const,
              since: new Date(current.membership.since).toISOString(),
              reservationId: current.membership.reservationId,
              transactionId: current.membership.transactionId,
            },
          },
          actions: current.actions,
        },
      });
    }
  }
  // Home grouping must not change the inventory's full-key order.
  const order = new Map(selected.map((member, index) => [member.realmId, index]));
  return items.sort((a, b) => order.get(a.realmId)! - order.get(b.realmId)!);
}
