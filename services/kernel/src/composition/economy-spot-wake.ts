import { createHash } from 'node:crypto';
import type { SpotAccessPort } from '../economy/spot-routes.ts';
import type { WorkClient } from '../work/client.ts';

export const ECONOMY_SPOT_MATCH_WAKE = 'economy.spot.matchAccepted';
type SpotBookBinding = Readonly<{ bookId: string; node: string }>;
export type SpotMatchWake = SpotBookBinding & Readonly<{ instrumentId: string; sequence: string }>;
const maxPendingWakes = 32;

export function withCommittedSpotWake(
  spot: SpotAccessPort,
  binding: SpotBookBinding,
  client: Pick<WorkClient, 'enqueue'>,
): SpotAccessPort {
  const pending = new Set<string>();

  async function enqueue(id: string, wake: SpotMatchWake) {
    try {
      await client.enqueue(
        {
          workflowName: ECONOMY_SPOT_MATCH_WAKE,
          queueName: 'maintenance',
          workflowID: id,
          workflowIDReusePolicy: 'return-existing',
        },
        wake,
      );
    } catch {
      // The stored acceptance remains ready for the maintenance sweep.
    } finally {
      pending.delete(id);
    }
  }

  return {
    ...spot,
    async place(input) {
      const result = await spot.place(input);
      if (result.kind === 'ok' && pending.size < maxPendingWakes) {
        const wake = { ...binding, instrumentId: input.instrumentId, sequence: result.value.sequence.toString() };
        const key = createHash('sha256')
          .update(JSON.stringify([wake.bookId, wake.node, wake.instrumentId, wake.sequence]))
          .digest('hex');
        const id = `economy:spot:accepted:${key}`;
        if (!pending.has(id)) {
          // Collapse in-flight replays before admitting to the existing bounded worker queue.
          pending.add(id);
          void enqueue(id, wake);
        }
      }
      return result;
    },
  };
}
