import { readCommunityPresentations } from '../content/community-presentation.ts';
import { communityPresentationResponse } from '../content/community-presentation-model.ts';
import { ProblemError } from '../http/problem.ts';
import type { AccountActor, AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { OwnRealmMembership, OwnRealmsDependencies } from './own-realms.ts';
import { createRealmParticipationCheck } from './participation.ts';
import { readRealm } from './realm.ts';

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
  const participation = createRealmParticipationCheck(deps);
  for (const members of homes.values()) {
    const initial = new Map<string, NonNullable<Awaited<ReturnType<typeof readRealm>>>>();
    const participates = new Map<string, boolean>();
    for (const member of members) {
      const realm = await readRealm(deps, actor, member.realmId, context);
      if (!realm) continue;
      if (realm.headRevisionId !== member.headRevisionId) throw new ProblemError('transaction_retry_exhausted');
      initial.set(member.realmId, realm);
      participates.set(
        member.realmId,
        await participation(deps.pool as unknown as AccessClient, { realmId: member.realmId, actor }),
      );
    }
    const presentations = await readCommunityPresentations(deps, [...initial.keys()], { ...context, actor });
    for (const member of members) {
      const before = initial.get(member.realmId);
      if (!before) continue;
      // The native presentation protocol owns Realm/Space and optional media
      // rounds. Its missing entry is concealment or a changed source, never a
      // licence to return the inventory's previously readable name.
      const presentation = presentations.get(member.realmId);
      const current = await readRealm(deps, actor, member.realmId, context);
      if (!current) continue;
      if (!presentation) throw new ProblemError('transaction_retry_exhausted');
      if (
        JSON.stringify(before) !== JSON.stringify(current) ||
        presentation.name !== current.title ||
        presentation.description !== current.summary ||
        presentation.spaceId !== current.spaceId ||
        presentation.join.membership !== 'member'
      )
        throw new ProblemError('transaction_retry_exhausted');
      const allowed = await participation(deps.pool as unknown as AccessClient, { realmId: member.realmId, actor });
      if (allowed !== participates.get(member.realmId)) throw new ProblemError('transaction_retry_exhausted');
      const { avatar, banner } = communityPresentationResponse(presentation);
      items.push({
        realmId: current.realmId,
        name: current.title,
        role: 'member' as const,
        current: {
          description: current.summary,
          avatar,
          banner,
          destination: { kind: 'realm' as const, realmId: current.realmId },
          spaceId: current.spaceId,
          viewer: {
            membership: { state: 'member' as const, since: new Date(member.since).toISOString() },
            participation: allowed ? ('allowed' as const) : ('denied' as const),
          },
          // Mounted permission advice lacks the leave holder invariant and a
          // Realm home action observation. Keep these capabilities unavailable
          // until their owner supplies that protocol; member is not authority.
          actions: { state: 'unavailable' as const },
        },
      });
    }
  }
  // Home grouping must not change the inventory's full-key order.
  const order = new Map(selected.map((member, index) => [member.realmId, index]));
  return items.sort((a, b) => order.get(a.realmId)! - order.get(b.realmId)!);
}
