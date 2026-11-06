import type { Pool } from 'pg';
import type { KernelClock } from '../../clock.ts';
import type { RatingCapabilities } from '../contract/capabilities.ts';
import { createRatingIdentityRepairCommands } from '../identity-repair.ts';
import { createIdentityRepairRead, type IdentityRepairRead } from '../identity-repair-read.ts';
import {
  admitIdentityRepairGeneration,
  continueIdentityRepairGeneration,
  runIdentityRepairGeneration,
} from '../identity-repair-run.ts';
import { ratingIdentityProducer, type RatingIdentityProducer } from '../segment-identity-guard.ts';

export type NativeIdentityRepairHost = Readonly<{
  commands: ReturnType<typeof createRatingIdentityRepairCommands>;
  read: IdentityRepairRead;
  producer: RatingIdentityProducer;
  admit: typeof admitIdentityRepairGeneration;
  run: typeof runIdentityRepairGeneration;
  continue: typeof continueIdentityRepairGeneration;
}>;

/** Ordinary installed commands: the bound Semantic producer, never a test-injected mapping authority. */
export function createInstalledIdentityRepairCommands(config: {
  pool: Pool;
  clock?: KernelClock;
  capabilities?: RatingCapabilities;
}) {
  return createRatingIdentityRepairCommands({
    ...config,
    producer: ratingIdentityProducer(),
  });
}

/** Native Rating identity-repair host used by module application and HTTP composition. */
export function createNativeIdentityRepairHost(config: {
  pool: Pool;
  clock?: KernelClock;
  capabilities?: RatingCapabilities;
}): NativeIdentityRepairHost {
  const commands = createInstalledIdentityRepairCommands(config);
  return Object.freeze({
    commands,
    read: createIdentityRepairRead(config.pool),
    producer: ratingIdentityProducer(),
    admit: admitIdentityRepairGeneration,
    run: runIdentityRepairGeneration,
    continue: continueIdentityRepairGeneration,
  });
}
