import { memoizedValue } from '../memoized.ts';
import { currentCommand, CommandUnavailableError } from '../command/command.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { ShelfWrite } from './shelf-contract.ts';
import initializeQuery from './shelf-counter-owner-initialize.sql';
import readQuery from './shelf-counter-owner-read.sql';
import { enterShelfWrite as enterNativeShelfWrite } from './shelf-maintenance-runtime.ts';
import completeQuery from './shelf-counter-owner-complete.sql';
import { shelfMaintenanceQuery } from './shelf-maintenance-bounds.ts';
function initialize() {
  return memoizedValue(initialize, () => shelfMaintenanceQuery(initializeQuery));
}
function read() {
  return memoizedValue(read, () => shelfMaintenanceQuery(readQuery));
}
function complete() {
  return memoizedValue(complete, () => shelfMaintenanceQuery(completeQuery));
}

export const NIL_SHELF_GENERATION = '00000000-0000-0000-0000-000000000000';
export type ShelfNativeOwner = Readonly<{
  fenceId: string;
  epoch: string;
  ready: boolean;
  generationId: string | null;
}>;

/** The owner lock precedes heads, placements and counter keys, and is retained until command completion. */
export async function enterShelfWrite(write: ShelfWrite): Promise<ShelfNativeOwner> {
  const command = currentCommand(write.client);
  if (
    routeOf(write.accountId) !== write.route ||
    command.partition !== partitionOf(write.route) ||
    command.authorization?.mode !== 'execute'
  )
    throw new TypeError('Shelf write requires a live authorized owner command');
  // The maintained gate owns initialization, durable backfill intent, terminal mode and active generation.
  const native = await enterNativeShelfWrite(write.client as Parameters<typeof enterNativeShelfWrite>[0], {
    route: write.route,
    accountId: write.accountId,
  });
  const args = { route: write.route, account_id: write.accountId };
  const client = write.client;
  await initialize().run(client, { ...args, fence_id: newId(write.route) });
  let row = await read().run(client, args);
  if (!row) throw new Error('Shelf owner serialization row is missing');
  if (BigInt(row.epoch) > native.epoch) throw new CommandUnavailableError('contention', command.partition);
  if (row.state === 'initializing' || BigInt(row.epoch) < native.epoch || row.ready !== native.ready) {
    await complete().run(client, {
      ...args,
      ready: native.ready,
      epoch: native.epoch.toString(),
      generation_id: native.generationId,
    });
    row = (await read().run(client, args))!;
  }
  if (row.state !== 'open' || (row.ready && row.generationId !== native.generationId))
    throw new CommandUnavailableError('contention', command.partition);
  if (native.ready !== (native.generationId !== null)) throw new Error('Invalid shelf generation readiness');
  return Object.freeze({
    fenceId: row.fenceId,
    epoch: native.epoch.toString(),
    ready: native.ready,
    generationId: native.generationId,
  });
}
