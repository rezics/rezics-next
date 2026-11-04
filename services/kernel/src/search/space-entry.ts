import { isDeepStrictEqual } from 'node:util';
import { Compile } from 'typebox/compile';
import type { Actor } from '../request/access.ts';
import { ProblemError } from '../http/problem.ts';
import {
  SpaceEntryFollowSchema,
  SpaceEntryPresentationSchema,
  type SpaceEntryCard,
  type SpaceEntryFollow,
  type SpaceEntryRow,
} from '../community/space-discovery-entry-contract.ts';
import type { DiscoveryPage, DiscoveryUnionHit } from './discovery.ts';

/** Minimal consumer seam until Library publishes the shared follow-discovery producer.
 * It observes only the current reader's exact Space edges, never writes or reads one edge per hit.
 */
export type SpaceEntryFollowProducer = (
  input: Readonly<{ actor: Actor; ids: readonly string[]; deadline: number }>,
) => Promise<Readonly<{ rows: ReadonlyMap<string, SpaceEntryFollow>; current(): Promise<boolean> }>>;
const followValidator = Compile(SpaceEntryFollowSchema);
const presentationValidator = Compile(SpaceEntryPresentationSchema);

export async function observeSearchSpaceEntries(input: {
  page: DiscoveryPage;
  actor: Actor;
  deadline: number;
  read: (ids: readonly string[]) => Promise<ReadonlyMap<string, SpaceEntryCard>>;
  follow?: SpaceEntryFollowProducer;
}) {
  const hits = input.page.hits.filter((hit) => hit.summary.kind === 'space');
  const ids = hits.map((hit) => hit.key.id);
  if (!ids.length) return { page: input.page, finish: async () => true };
  if (ids.length > 100 || new Set(ids).size !== ids.length) throw new RangeError('Invalid Space entry page');
  const actor = structuredClone(input.actor);
  const initial = structuredClone(await input.read([...ids]));
  const checkPublic = () => {
    for (const hit of hits) {
      if (hit.summary.kind !== 'space') continue;
      const value = hit.summary.value;
      const card = initial.get(hit.key.id);
      if (
        !card ||
        card.id !== hit.key.id ||
        card.address !== value.address ||
        card.title !== value.title ||
        card.description !== (value.summary ?? '') ||
        card.realmId !== (value.realm?.id ?? null) ||
        card.realmTitle !== (value.realm?.title ?? null) ||
        !presentationValidator.Check(card.presentation) ||
        card.presentation.identity.id !== (card.realmId ?? card.id) ||
        card.presentation.identity.kind !== (card.realmId ? 'realm' : 'space')
      )
        throw new ProblemError('search_restart_required');
    }
  };
  checkPublic();
  let following: Awaited<ReturnType<SpaceEntryFollowProducer>> | undefined;
  if (actor.kind === 'account' && input.follow) {
    try {
      const observation = await input.follow({
        actor: structuredClone(actor),
        ids: [...ids],
        deadline: input.deadline,
      });
      following = { rows: structuredClone(observation.rows), current: () => observation.current() };
      for (const [id, row] of following.rows)
        if (
          !ids.includes(id) ||
          !followValidator.Check(row) ||
          row.state === 'sign-in' ||
          (row.state === 'current' && row.action === 'sign-in')
        )
          throw new TypeError('Invalid Space follow observation');
    } catch {
      following = undefined;
    }
  }
  const rows: SpaceEntryRow[] = ids.map((id) => {
    const card = initial.get(id)!;
    const available = card.actions.status === 'available';
    const canEnter =
      available &&
      card.actions.status === 'available' &&
      card.actions.viewerActions.some((action) =>
        action.operations.includes(card.realmId ? 'realm.home' : 'space.get'),
      );
    const canJoin =
      available &&
      card.actions.status === 'available' &&
      card.actions.viewerActions.some(
        (action) => action.action === 'realm:join' && action.operations.includes('realm.join'),
      );
    return {
      id,
      destination: card.destination,
      entry:
        card.destination.kind === 'unavailable'
          ? 'unavailable'
          : available
            ? canEnter
              ? 'allowed'
              : 'disabled'
            : 'unavailable',
      admission: !card.realmId
        ? 'disabled'
        : !available
          ? 'unavailable'
          : actor.kind === 'anonymous'
            ? 'sign-in'
            : canJoin
              ? 'allowed'
              : 'disabled',
      follow:
        actor.kind === 'anonymous'
          ? { state: 'sign-in' }
          : structuredClone(following?.rows.get(id) ?? { state: 'unavailable' }),
    };
  });
  const page: DiscoveryPage = {
    ...input.page,
    hits: input.page.hits.map((hit): DiscoveryUnionHit =>
      hit.summary.kind === 'space'
        ? {
            ...hit,
            key: { owner: 'community', kind: 'space', route: hit.key.route, id: hit.key.id },
            summary: {
              kind: 'space',
              value: { ...hit.summary.value, presentation: structuredClone(initial.get(hit.key.id)!.presentation) },
            },
          }
        : hit,
    ),
    spaceEntries: { reader: actor.kind === 'account' ? actor.accountId : null, rows },
  };
  if (
    Buffer.byteLength(JSON.stringify({ rows, presentation: [...initial.values()].map((c) => c.presentation) })) > 524288
  )
    throw new ProblemError('index_not_ready');
  return {
    page,
    async finish() {
      const final = await input.read([...ids]);
      return isDeepStrictEqual(initial, final) && (!following || (await following.current()));
    },
  };
}
