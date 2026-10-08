import { RelayEventBlocked } from './relay.ts';
import { runWorkerTick } from '../../worker-tick.ts';

export const RELAY_RETRY_COST = { initialMs: 500, maximumMs: 30_000 } as const;
const TICK_NAME = /^[A-Za-z][\w.:-]{0,80}$/;

/** The durable checkpoint makes retries safe, including failure after delivery. */
export async function runMainRelay(once: () => Promise<boolean>, running: () => boolean, intervalMs: number,
  options: { sleep?: (ms: number) => Promise<void>; random?: () => number;
    log?: (line: string) => void; consumer?: string } = {}): Promise<void> {
  const sleep = options.sleep ?? Bun.sleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? console.error;
  const tick = options.consumer && TICK_NAME.test(options.consumer) ? options.consumer : 'main.relay';
  let failures = 0;
  while (running()) {
    try {
      const delivered = await runWorkerTick(tick, once);
      failures = 0;
      if (!delivered && running()) await sleep(intervalMs);
    } catch (error) {
      if (error instanceof RelayEventBlocked) throw error;
      failures++;
      const cap = Math.min(RELAY_RETRY_COST.maximumMs,
        RELAY_RETRY_COST.initialMs * 2 ** Math.min(failures - 1, 16));
      const delayMs = Math.floor(cap * (0.5 + 0.5 * random()));
      log(JSON.stringify({ level: 'warn', event: 'main_relay_retry', consumer: options.consumer,
        attempt: failures,
        delayMs, reason: error instanceof Error ? error.message : String(error) }));
      if (running()) await sleep(delayMs);
    }
  }
}
