import type { ShelfReadGenerationReader } from './shelf-contract.ts';
import gateReadQuery from './shelf-maintenance-gate-read.sql';
import { shelfMaintenanceQuery } from './shelf-maintenance-bounds.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

const gateRead = shelfMaintenanceQuery(gateReadQuery);

/** Indexed current-state probe, after owner admission. Absence requests guarded initialization, never empty. */
export const shelfNeedsInitialization = async (
  ...[client, owner]: Parameters<ShelfReadGenerationReader>
): Promise<boolean> => {
  const gate = await gateRead.run(client, { route: owner.route, account_id: owner.accountId });
  return !gate || (!gate.initialized && gate.mode === 'open');
};

/** The very RR client used for entries/counts supplies the producer's committed completeness and epoch. */
export const readShelfGeneration: ShelfReadGenerationReader = async (client, owner) => {
  const gate = await gateRead.run(client, { route: owner.route, account_id: owner.accountId });
  if (!gate?.initialized || gate.mode !== 'open' || !gate.ready || gate.activeGeneration === null || gate.epoch < 0n)
    throw new ShelfReadUnavailableError('native RR gate/current-generation reader: owner generation is not ready');
  return { readiness: 'ready', epoch: gate.epoch, activeGeneration: gate.activeGeneration };
};
