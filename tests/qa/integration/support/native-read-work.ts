import { AsyncLocalStorage } from 'node:async_hooks';
import { foregroundCounted } from './query-cost-meter.ts';

export interface NativeReadWork { calls: number; counters: Record<string, number> }

/** Read the real native response counters, including nested Lucene iterators.
 * A missing counter stays absent, so a test cannot pass on missing evidence. */
export function meterNativeReadWork() {
  const active = new AsyncLocalStorage<NativeReadWork>();
  const original = globalThis.fetch;
  const origin = new URL(process.env.FUSEKI_URL!).origin;
  globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    const work = url.origin === origin && foregroundCounted() ? active.getStore() : undefined;
    const response = await original(...args);
    if (work) {
      work.calls++;
      for (const entry of (response.headers.get('x-rezics-command-work') ?? '').split(',')) {
        const match = /^([a-z_]+)=(\d+)$/.exec(entry.trim());
        if (match) work.counters[match[1]!] = (work.counters[match[1]!] ?? 0) + Number(match[2]);
      }
    }
    return response;
  }, { preconnect: original.preconnect }) as typeof fetch;
  return {
    async measure<T>(read: () => Promise<T>) {
      const work: NativeReadWork = { calls: 0, counters: {} };
      const result = await active.run(work, read);
      return { result, work };
    },
    restore() { globalThis.fetch = original; },
  };
}
