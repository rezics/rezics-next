import { createHash } from 'node:crypto';
import { logWorkerFault } from '@rezics/observability/log';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { ImageClassifier } from './classifier.ts';
import { SCREEN_LIMITS, screenUnavailable, screenVerdict, type ScreenVerdict } from './policy.ts';
import { MediaScreenStore, type ScreeningCases } from './store.ts';

/** Single-flight bounded Main loop; the database owns the schedule and retry fences. */
export class MediaScreenWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly store: MediaScreenStore, private readonly classifier: ImageClassifier,
    private readonly objects: (namespace: string) => ImmutableObjects, private readonly cases: ScreeningCases,
    private readonly timeoutMs: number = SCREEN_LIMITS.timeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SCREEN_LIMITS.timeoutMs) throw new Error('invalid screen deadline');
  }
  async tick(): Promise<void> {
    let processed = 0;
    let retry = false;
    await this.store.cancelObsolete();
    await this.store.holdExhausted();
    const lease = await this.store.leaseNext();
    if (lease) {
      const controller = new AbortController();
      let verdict: ScreenVerdict;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        verdict = await Promise.race([ (async () => {
          const bytes = await this.objects(lease.namespace).get(lease.digest);
          if (bytes.length > SCREEN_LIMITS.bytes || createHash('sha256').update(bytes).digest('hex') !== lease.digest) {
            throw new Error('screen input integrity');
          }
          controller.signal.throwIfAborted();
          return screenVerdict(await this.classifier.classify(bytes, lease.mediaType, controller.signal));
        })(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('screen deadline')), this.timeoutMs);
        }) ]);
      } catch { verdict = screenUnavailable(); }
      finally { controller.abort(); if (timer) clearTimeout(timer); }
      await this.store.settle(lease, verdict);
      processed++;
      retry = verdict.reason === 'screen-unavailable';
    }
    for (const review of await this.store.pendingReviews()) {
      try { await this.store.reviewAttempt(review.job, await this.cases.openScreeningCase(review)); }
      catch { retry = true; await this.store.reviewAttempt(review.job, null); }
      processed++;
    }
    recordWorkerOutcome({ outcome: retry ? 'retry' : processed ? 'worked' : 'idle', processed, unit: 'item' });
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.media.screen', () => withWorkerTelemetry('main.media.screen', () => this.tick())).catch(error => logWorkerFault('main.media.screen', error))
        .finally(() => { this.running = undefined; });
    }, 1_000);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
