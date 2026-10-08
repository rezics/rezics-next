import { createHash } from 'node:crypto';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { logWorkerFault } from '@rezics/observability/log';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import { RequiredMediaMatchStore, REQUIRED_MATCH_COST } from './required-match-store.ts';
import type { RequiredMatch, RequiredSafetyMatcher } from './required-matcher.ts';

export class RequiredMediaMatchWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly store: RequiredMediaMatchStore,
    private readonly matcher: RequiredSafetyMatcher,
    private readonly objects: (namespace: string) => ImmutableObjects,
    private readonly timeoutMs = 10_000,
    private readonly leaseMs = 30_000,
  ) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 10_000 ||
      !Number.isInteger(leaseMs) ||
      leaseMs < 1 ||
      leaseMs > 30_000
    )
      throw new Error('invalid matcher deadline');
  }
  async tick(source?: string): Promise<void> {
    const lease = await this.store.leaseNext(this.leaseMs, source);
    if (!lease) {
      recordWorkerOutcome({ outcome: 'idle', processed: 0, unit: 'item' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('required matcher deadline')),
      this.timeoutMs,
    );
    let result: RequiredMatch;
    try {
      result = await Promise.race([
        (async () => {
          const bytes = await this.objects(lease.namespace).get(lease.digest);
          if (
            bytes.length > REQUIRED_MATCH_COST.sourceBytes ||
            createHash('sha256').update(bytes).digest('hex') !== lease.digest
          )
            throw new Error('required matcher source integrity differs');
          return this.matcher.match(bytes, lease.mediaType, controller.signal);
        })(),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch {
      // No clearance on outage. The durable lease expires for another attempt.
      recordWorkerOutcome({ outcome: 'retry', processed: 1, unit: 'item' });
      return;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await this.store.settle(lease, result);
    recordWorkerOutcome({ outcome: 'worked', processed: 1, unit: 'item' });
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.media.required-match', () => withWorkerTelemetry('main.media.required-match', () => this.tick()))
        .catch((error) => logWorkerFault('main.media.required-match', error))
        .finally(() => {
          this.running = undefined;
        });
    }, 1_000);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
