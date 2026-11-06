import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Effect, NativeEffect } from '../../../src/events/effects.ts';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';

const TOMBSTONE = 'com.rezics.access.account-tombstoned.v1';

function keepCommerceTombstone<T extends Effect | NativeEffect>(effect: T): T | null {
  if (!effect.types.includes(TOMBSTONE) || effect.name === 'commerce_erasure') return effect;
  const types = effect.types.filter((type) => type !== TOMBSTONE);
  return types.length === 0 ? null : { ...effect, types };
}

function keepCommerceTombstones<T extends Effect | NativeEffect>(effects: T[]): T[] {
  return effects.flatMap((effect) => {
    const kept = keepCommerceTombstone(effect);
    return kept ? [kept] : [];
  });
}

// Live default composition supplies Content ambient and the Semantic domain. Foreign tombstone
// consumers are not subscribed, so Semantic's overflowing Subject-source page and other unfinished
// participants cannot occupy the shared effects executor that Commerce's participant needs.
await startWorker(
  readWorkerConfig(process.env),
  (modules) =>
    modules.map((module) => ({
      name: module.name,
      register(context) {
        return module.register({
          ...context,
          addEffects(effects) {
            context.addEffects(keepCommerceTombstones(effects));
          },
          ...(context.addNativeEffects
            ? {
                addNativeEffects: (effects: NativeEffect[]) => {
                  context.addNativeEffects!(keepCommerceTombstones(effects));
                },
              }
            : {}),
        });
      },
    })),
  process.env,
);
for (const schedule of await DBOS.listSchedules()) await DBOS.deleteSchedule(schedule.scheduleName);
for (const queue of await DBOS.listQueues()) await queue.setMinPollingIntervalMs(5);
console.info(`Commerce erasure worker ready: ${process.pid}`);
