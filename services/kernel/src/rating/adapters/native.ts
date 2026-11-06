import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomBytes } from 'node:crypto';
import { systemClock } from '../../clock.ts';
import { runCommand } from '../../command/command.ts';
import { projectBatch } from '../../events/log.ts';
import { newId } from '../../route/route.ts';
import type { RatingAmbient, RatingCapabilities } from '../contract/capabilities.ts';

/** Only this adapter reaches native time, randomness and the command/effect libraries. */
export function createNativeRatingCapabilities(ambient: Partial<RatingAmbient> = {}): RatingCapabilities {
  const command: typeof runCommand = (pool, input, execute) =>
    runCommand(pool, { ...input, ...(ambient.clock === undefined ? {} : { clock: ambient.clock }) }, execute);
  return Object.freeze({
    clock: ambient.clock ?? systemClock,
    id: ambient.id ?? newId,
    randomBytes: ambient.randomBytes ?? randomBytes,
    command,
    projectBatch,
    workflows: DBOS,
  });
}
