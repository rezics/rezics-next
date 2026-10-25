import type { BoundsProbe, RetainedSample } from '../../../specs/imports-reader-bounds-driver';
import { createImportDumpsDriver } from './dumps-driver';

/** Allocation samples come from the live production ledger. Separately observe
 * collection mutations so a source-key Set/Map cannot hide behind byte counters.
 * The collection observer has no role in parsing or duplicate rejection.
 */
export async function createImportReaderBoundsDriver(): Promise<BoundsProbe> {
  let measuring = true;
  const boundaries = await createImportDumpsDriver(() => measuring);
  const restorations: (() => void)[] = [];
  let stopRetention: (() => void) | undefined;
  let samples: RetainedSample[] = [];
  let last: Omit<RetainedSample, 'keyEntries'> | undefined;
  let keyEntries = 0;
  let observing = false;
  const collections = new WeakMap<object, Set<string>>();
  const nativeKey = /^(?:[1-9]\d*|[vQ][1-9]\d*|\/(?:works\/OL[1-9]\d*W|books\/OL[1-9]\d*M))$/;
  const emit = () => {
    if (measuring && last) samples.push({ ...last, keyEntries });
  };
  try {
    const bytes = await import('../src/dumps-bytes');
    stopRetention = bytes.observeDumpRetention((sample) => {
      last = sample;
      emit();
    });
    for (const [prototype, methods] of [
      [Set.prototype, ['add', 'delete', 'clear']],
      [Map.prototype, ['set', 'delete', 'clear']],
    ] as const) {
      for (const method of methods) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)!;
        const original = descriptor.value as Function;
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function (this: object, ...args: unknown[]) {
            const result = Reflect.apply(original, this, args);
            if (!observing && measuring) {
              observing = true;
              try {
                const key = args[0];
                let keys = collections.get(this);
                if ((method === 'add' || method === 'set') && typeof key === 'string' && nativeKey.test(key)) {
                  if (!keys) {
                    keys = new Set();
                    collections.set(this, keys);
                  }
                  const before = keys.size;
                  keys.add(key);
                  keyEntries += keys.size - before;
                } else if (keys && method === 'clear') {
                  keyEntries -= keys.size;
                  keys.clear();
                } else if (keys && method === 'delete' && typeof key === 'string' && keys.delete(key)) keyEntries--;
                emit();
              } finally {
                observing = false;
              }
            }
            return result;
          },
        });
        restorations.push(() => Object.defineProperty(prototype, method, descriptor));
      }
    }
    if (Object.values(await boundaries.effects()).some((attempts) => attempts.length))
      throw new Error('Dump reader loading attempted external effects');
    measuring = false;
    let closed = false;
    return {
      measure: async (operation) => {
        if (closed || measuring) throw new Error('Reader measurement is unavailable');
        const before = await boundaries.effects();
        samples = [];
        last = undefined;
        measuring = true;
        try {
          const value = await operation();
          const after = await boundaries.effects();
          return {
            value,
            samples,
            effects: {
              sql: after.sql.slice(before.sql.length),
              requests: after.requests.slice(before.requests.length),
              fileWrites: after.fileWrites.slice(before.fileWrites.length),
            },
          };
        } finally {
          measuring = false;
        }
      },
      transportAttempts: async () => (await boundaries.effects()).requests,
      close: async () => {
        if (closed) return;
        closed = true;
        stopRetention?.();
        for (const restore of restorations.reverse()) restore();
        await boundaries.close();
      },
    };
  } catch (error) {
    stopRetention?.();
    for (const restore of restorations.reverse()) restore();
    await boundaries.close();
    throw error;
  }
}
