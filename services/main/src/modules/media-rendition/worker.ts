import { createHash } from 'node:crypto';
import { logWorkerFault } from '@rezics/observability/log';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
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
    const leases = await this.store.leaseCrop();
    const lease = leases[0];
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
          return this.transformer.transformCrop(
            bytes,
            lease.mediaType,
            leases.map((lease) => ({ profile: lease.profile, crop: lease.crop })),
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
      if (output.length !== leases.length) throw new Error('incomplete rendition output');
      let settled = true;
      for (const [index, lease] of leases.entries()) {
        const rendition = output[index]!;
        settled =
          (await this.store.settle(lease, rendition, () =>
            this.objects(lease.namespace).put(rendition.bytes),
          )) && settled;
      }
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
      this.running = runWorkerTick('main.media.rendition', () => withWorkerTelemetry('main.media.rendition', () => this.tick()))
        .catch((error) => logWorkerFault('main.media.rendition', error))
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
