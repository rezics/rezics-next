import { afterAll, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  commandTimingSnapshot,
  recordAccessClockTiming,
  withAccessPreparationTiming,
  withCommandTiming,
} from '../../src/command/timing.ts';

class DelayedPool extends EventEmitter {
  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
  }

  connect(callback?: (error: Error | null, client: { on(): void }, release: () => void) => void) {
    const client = { on() {} };
    const release = () => {};
    if (callback) {
      setTimeout(() => {
        this.emit('connect', client);
        callback(null, client, release);
      }, 18);
      return;
    }
    return new Promise<{ on(): void }>((resolve) => {
      this.connect((_error, connected) => resolve(connected));
    });
  }

  query() {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}

mock.module('pg', () => ({
  default: {
    Pool: DelayedPool,
    types: { getTypeParser: () => () => null },
  },
}));
const { createPool, withPoolCheckoutObservation } = await import('../../src/database/pool.ts');
afterAll(() => mock.restore());

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('request diagnostics separate Access preparation, pool checkout, and clock query time', async () => {
  const pool = createPool('postgres://timing.invalid/ignored');
  let snapshot: ReturnType<typeof commandTimingSnapshot> | undefined;
  await withCommandTiming(async () => {
    await withAccessPreparationTiming(async () => {
      let checkoutObserved = false;
      let poolWaitMs = 0;
      let acquired = false;
      await withPoolCheckoutObservation(
        {
          started() {
            checkoutObserved = true;
          },
          completed(waitMs, connected) {
            poolWaitMs = waitMs;
            acquired = connected;
          },
        },
        async () => {
          const client = await new Promise<{ release(): void }>((resolve, reject) => {
            pool.connect((error, _client, release) => {
              if (error) return reject(error);
              resolve({ release });
            });
          });

          const queryStarted = performance.now();
          try {
            await delay(27);
            recordAccessClockTiming(poolWaitMs, performance.now() - queryStarted);
          } finally {
            client.release();
          }
        },
      );
      expect(checkoutObserved).toBe(true);
      expect(acquired).toBe(true);
    });
    snapshot = commandTimingSnapshot();
  });

  expect(snapshot).toBeDefined();
  if (!snapshot) throw new Error('Request timing snapshot was not captured');
  const sample = snapshot.access_preparations?.[0];
  expect(sample).toBeDefined();
  if (!sample) throw new Error('Access preparation timing was not captured');
  expect(sample.pool_checkout_ms).toBeGreaterThanOrEqual(18);
  expect(sample.pool_checkout_ms).toBeLessThan(40);
  expect(sample.clock_query_after_checkout_ms).toBeGreaterThanOrEqual(27);
  expect(sample.clock_query_after_checkout_ms).toBeLessThan(50);
  expect(sample.wall_ms).toBeGreaterThanOrEqual(sample.pool_checkout_ms + sample.clock_query_after_checkout_ms);
  expect(Object.keys(sample).sort()).toEqual(['clock_query_after_checkout_ms', 'pool_checkout_ms', 'wall_ms']);
  const phaseTotal = Object.values(snapshot.phases_ms).reduce((total, value) => total + value, 0);
  expect(Math.abs(phaseTotal - snapshot.elapsed_ms)).toBeLessThan(0.1);
});
