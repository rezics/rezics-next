import { deadlineClient } from '../access/authenticate.ts';
import { readViewerActions, type ViewerActionBindings, type ViewerActionResources } from '../access/viewer-actions.ts';
import { readRealmPresentationImages } from '../content/realm-media.ts';
import { withConnection } from '../database/pool.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readActiveSpaceAddressClaims } from './space-address.ts';
import { prepareSpaceDiscovery, spaceDiscoveryRound } from './space-discovery-read.ts';
import type { SpaceDiscoveryDependencies, SpaceDiscoveryKey } from './space-discovery.ts';
import type { SpaceEntryCard, SpaceEntryPresentation } from './space-discovery-entry-contract.ts';

export type SpaceEntryActionRuntime = Readonly<{
  resources: ViewerActionResources;
  bindings: ViewerActionBindings;
}>;

/** Fixed full-key owner batches; all Community snapshots end before Access/media preparation. */
export async function readSpaceDiscoveryEntryBatch(
  deps: SpaceDiscoveryDependencies,
  actor: Actor,
  ids: readonly string[],
  deadline: number,
  runtime?: SpaceEntryActionRuntime,
): Promise<ReadonlyMap<string, SpaceEntryCard>> {
  if (ids.length > 100 || new Set(ids).size !== ids.length)
    throw new RangeError('Space entry accepts at most 100 unique native keys');
  if (!ids.length) return new Map();
  const groups = new Map<number, SpaceDiscoveryKey[]>();
  for (const id of ids) {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Invalid Space entry identity');
    const partition = partitionOf(route);
    groups.set(partition, [...(groups.get(partition) ?? []), { route, id }]);
  }
  const decisions = await prepareSpaceDiscovery(deps, deadline);
  const cards = new Map<
    string,
    Awaited<ReturnType<typeof spaceDiscoveryRound>>['cards'] extends Map<string, infer C> ? C : never
  >();
  for (const [partition, keys] of groups) {
    const round = await spaceDiscoveryRound(deps, decisions, partition, keys, deadline);
    for (const [id, card] of round.cards) cards.set(id, card);
  }
  const addressed = [...cards.values()].flatMap(({ indexed }) =>
    indexed.address ? [{ spaceId: indexed.id, address: indexed.address }] : [],
  );
  const claims = await withConnection(deps.pool, (client) =>
    readActiveSpaceAddressClaims(deadlineClient(client, deadline), addressed),
  );
  const actionResults = new Map<string, Awaited<ReturnType<typeof readViewerActions>>['resources'][number]>();
  if (runtime) {
    // Both resources participate even when the Space has an address. A label is never an association.
    const refs = [...cards.values()].flatMap(({ indexed }) => [
      { type: 'community.space', id: indexed.id },
      ...(indexed.realmId ? [{ type: 'community.realm', id: indexed.realmId }] : []),
    ]);
    for (let offset = 0; offset < refs.length; offset += 100) {
      try {
        const batch = await readViewerActions(
          { ...deps, ...runtime, clock: deps.clock ?? (() => new Date()) },
          actor,
          refs.slice(offset, offset + 100),
          deadline,
        );
        for (const result of batch.resources) actionResults.set(`${result.type}/${result.id}`, result);
      } catch {
        /* Optional advice failure leaves current public presentation intact. */
      }
    }
  }
  const result = new Map<string, SpaceEntryCard>();
  for (const [id, card] of cards) {
    const space = card.indexed;
    if (space.address && !claims.has(JSON.stringify([id, space.address]))) continue;
    let mediaBinding: unknown = null;
    let avatar: SpaceEntryPresentation['avatar'] = { state: 'none' };
    if (space.realmId && card.avatarMediaId) {
      const images = await readRealmPresentationImages(
        deps,
        {
          realmId: space.realmId,
          avatarMediaId: card.avatarMediaId,
          bannerMediaId: null,
        },
        { actor: { kind: 'anonymous' }, deadline },
      );
      mediaBinding = images.avatar;
      if (images.avatar.state === 'available') {
        const image = images.avatar.value;
        const variant =
          image.variants.find((v) => v.format === 'webp' && v.width <= 2560) ??
          image.variants.find((v) => v.width <= 2560);
        avatar =
          image.id === card.avatarMediaId && image.containerId === space.realmId && variant
            ? {
                state: 'available',
                mediaId: image.id,
                realmId: space.realmId,
                format: variant.format,
                width: variant.width,
              }
            : { state: 'unavailable' };
      } else avatar = { state: images.avatar.state === 'none' ? 'withheld' : 'unavailable' };
    }
    const type = space.realmId ? 'community.realm' : 'community.space';
    const resourceId = space.realmId ?? id;
    const actions = actionResults.get(`${type}/${resourceId}`);
    const spaceActions = actionResults.get(`community.space/${id}`);
    const admitted = actions && 'viewerActions' in actions && spaceActions && 'viewerActions' in spaceActions;
    const destination = admitted
      ? space.realmId
        ? { kind: 'realm' as const, realmId: space.realmId }
        : space.address && claims.has(JSON.stringify([id, space.address]))
          ? { kind: 'space' as const, spaceId: id, address: space.address }
          : { kind: 'unavailable' as const }
      : { kind: 'unavailable' as const };
    result.set(id, {
      id,
      address: space.address,
      title: space.title,
      description: space.description,
      realmId: space.realmId,
      realmTitle: space.realmTitle,
      binding: JSON.stringify([card.binding, mediaBinding]),
      presentation: { identity: { kind: space.realmId ? 'realm' : 'space', id: resourceId, name: space.name }, avatar },
      destination,
      actions: admitted
        ? { status: 'available', resourceType: type, resourceId, viewerActions: actions.viewerActions }
        : { status: 'unavailable' },
    });
  }
  // A changed/occupied concealed carrier invalidates the original row, never turns it into standalone.
  for (const [partition, keys] of groups) {
    const final = await spaceDiscoveryRound(deps, decisions, partition, keys, deadline);
    for (const key of keys) if (cards.get(key.id)?.binding !== final.cards.get(key.id)?.binding) result.delete(key.id);
  }
  return result;
}
