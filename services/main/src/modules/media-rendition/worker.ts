import { createHash } from 'node:crypto';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { RENDITION_LIMITS } from './policy.ts';
import type { MediaRenditionStore } from './store.ts';
import type { ImageTransformer } from './transform.ts';

/** One still image per single-flight Main tick, never a separate service. */
export class MediaRenditionWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly store: MediaRenditionStore,
    private readonly transformer: ImageTransformer,
    private readonly objects: (namespace: string) => ImmutableObjects,
    private readonly timeoutMs: number = RENDITION_LIMITS.timeoutMs,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RENDITION_LIMITS.timeoutMs)
      throw new Error('invalid rendition deadline');
  }
  async tick(): Promise<void> {
    const lease = await this.store.leaseNext();
    if (!lease) {
      recordWorkerOutcome({ outcome: 'idle', processed: 0, unit: 'item' });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        (async () => {
          const bytes = await this.objects(lease.namespace).get(lease.digest);
          if (
            bytes.length > RENDITION_LIMITS.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== lease.digest
          ) {
            throw new Error('rendition input integrity');
          }
          controller.signal.throwIfAborted();
          return this.transformer.transform(
            bytes,
            lease.mediaType,
            { profile: lease.profile, crop: lease.crop },
            controller.signal,
          );
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('rendition deadline'));
          }, this.timeoutMs);
        }),
      ]);
      controller.abort();
      if (timer) clearTimeout(timer);
      const settled = await this.store.settle(lease, output, () =>
        this.objects(lease.namespace).put(output.bytes),
      );
      recordWorkerOutcome({ outcome: settled ? 'worked' : 'retry', processed: 1, unit: 'item' });
    } catch {
      // Lease expiry retries interrupted decode and object storage outages. The
      // indexed expired head retires the sixteenth attempt without stranding it.
      recordWorkerOutcome({ outcome: 'retry', processed: 1, unit: 'item' });
    } finally {
      controller.abort();
      if (timer) clearTimeout(timer);
    }
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = withWorkerTelemetry('main.media.rendition', () => this.tick())
        .catch((error) => console.error('media rendition tick failed', error))
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
