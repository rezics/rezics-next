import { expect, test } from 'bun:test';
import { run } from './cli.ts';
import type { IntegrationRuntime } from './integration-cli.ts';

test('the train and inbox commands do not sweep orphans before they run', async () => {
  // Every settle spawns a train; each swept the whole store before finding the lease held (load 146, 2026-10-28).
  // run() marks non-train commands detached in process.env; restore it so later tests in this process see a clean environment.
  const previousTrain = process.env.GOAL_TRAIN_MODE;
  try {
    for (const argv of [['train'], ['inbox', 'read', 'nobody']]) {
      let swept = 0;
      const runtime = {
        recoverOrphans: async () => {
          swept++;
        },
        close() {},
      } as unknown as IntegrationRuntime;
      await run(argv, () => runtime).catch(() => 1);
      expect(swept).toBe(0);
    }
  } finally {
    if (previousTrain === undefined) delete process.env.GOAL_TRAIN_MODE;
    else process.env.GOAL_TRAIN_MODE = previousTrain;
  }
});
