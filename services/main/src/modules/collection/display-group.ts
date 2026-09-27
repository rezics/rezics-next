import { GraphLayoutMissing, type GraphLayoutActor, type GraphLayoutDocument,
  type GraphLayouts } from '../graph-layout/store.ts';
import { hash } from '../work/activate.ts';

export class CollectionDisplayGroupUnavailable extends Error {}

/** Apply a Collection display-group move to Content-owned layout state.
 * The caller saves the returned document through GraphLayouts.save; this
 * transformation never mutates Collection Structure or semantic graph facts. */
export function moveCollectionDisplayGroup(layout: GraphLayoutDocument,
  groupId: string, placement: { x: number; y: number; collapsed: boolean }): GraphLayoutDocument {
  const group = layout.groups.find(item => item.id === groupId);
  if (!group) throw new CollectionDisplayGroupUnavailable('display group is unavailable');
  return { ...layout, groups: layout.groups.map(item => item.id === groupId
    ? { ...item, ...placement } : item) };
}

/** Persist one move as an exact Content layout revision; no Jena mutation occurs. */
export async function saveCollectionDisplayGroupMove(layouts: GraphLayouts,
  actor: GraphLayoutActor, input: { collection: string; layout: string; expectedHead: string;
    group: string; placement: { x: number; y: number; collapsed: boolean };
    idempotencyKey: string }) {
  const prior = await layouts.read(actor, input.layout, input.expectedHead);
  if (prior.view.anchor !== input.collection) throw new GraphLayoutMissing('Collection layout is unavailable');
  const body = moveCollectionDisplayGroup(prior.body, input.group, input.placement);
  return layouts.save(actor, input.layout, input.expectedHead, body, {
    idempotencyKey: input.idempotencyKey,
    requestDigest: hash(JSON.stringify({ family: 'collection-display-group-move-v1',
      collection: input.collection, layout: input.layout, expectedHead: input.expectedHead,
      group: input.group, placement: input.placement, actingSubject: actor.actingSubject })),
  });
}

/** Content layout save owns persistence; semantic reads and writes are zero. */
export const DISPLAY_GROUP_MOVE_COST = { maxGroups: 200, graphReads: 0, graphWrites: 0,
  statementReads: 0, statementWrites: 0, contentExactReads: 1, contentRevisionWrites: 1 } as const;
