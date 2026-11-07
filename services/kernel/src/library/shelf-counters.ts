import { memoizedValue } from '../memoized.ts';
import { routeOf } from '../route/route.ts';
import type { ShelfCounters, ShelfPlacement, ShelfWrite } from './shelf-contract.ts';
import { isLegacyEntryState } from './contract/index.ts';
import { enterShelfWrite, NIL_SHELF_GENERATION } from './shelf-counter-owner.ts';
import deltaQuery from './shelf-counter-delta.sql';
import { shelfMaintenanceQuery } from './shelf-maintenance-bounds.ts';
function delta() {
  return memoizedValue(delta, () => shelfMaintenanceQuery(deltaQuery));
}

type Delta = { bucket: string; type_id: string; delta: number };
function placement(write: ShelfWrite, value: ShelfPlacement | null, sign: number): Delta[] {
  if (value === null) return [];
  if (routeOf(value.typeId) !== write.route || value.typeId === NIL_SHELF_GENERATION)
    throw new TypeError('Invalid private shelf placement');
  return [
    { bucket: 'all', type_id: NIL_SHELF_GENERATION, delta: sign },
    { bucket: 'all', type_id: value.typeId, delta: sign },
    ...(isLegacyEntryState(value.state)
      ? [
          { bucket: value.state, type_id: NIL_SHELF_GENERATION, delta: sign },
          { bucket: value.state, type_id: value.typeId, delta: sign },
        ]
      : []),
  ];
}
export function createShelfCounters(): ShelfCounters {
  async function apply(write: ShelfWrite, deltas: Delta[]) {
    const owner = await enterShelfWrite(write);
    if (!owner.ready) return;
    await delta().run(write.client, {
      route: write.route,
      account_id: write.accountId,
      generation_id: owner.generationId!,
      deltas,
    });
  }
  return {
    async transition(write, from, to) {
      await apply(write, [...placement(write, from, -1), ...placement(write, to, 1)]);
    },
    async collection(write, change) {
      if (change !== 1 && change !== -1) throw new TypeError('Invalid Collection delta');
      await apply(write, [{ bucket: 'collections', type_id: NIL_SHELF_GENERATION, delta: change }]);
    },
  };
}
export default createShelfCounters;
