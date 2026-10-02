import { NotificationUnavailable } from './store.ts';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';
import { NotificationDispatcher, DISPATCH_LIMITS } from './dispatcher.ts';

/** Periodic bounded runner; database rows remain the durable schedule. */
export class NotificationDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly dispatcher: NotificationDispatcher, private readonly intervalMs = 1_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('intervalMs must be positive');
  }

  async tick(): Promise<void> {
    const recovered = await this.dispatcher.recoverExpiredLeases(DISPATCH_LIMITS.batch);
    const summary = await this.dispatcher.runOnce(DISPATCH_LIMITS.batch);
    recordWorkerOutcome({
      outcome: summary.failed ? 'blocked' : summary.retried || summary.uncertain ? 'retry'
        : summary.claimed || summary.cancelled || recovered ? 'worked' : 'idle',
      processed: summary.claimed + summary.cancelled, unit: 'item',
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = withWorkerTelemetry('main.notification.delivery', () => this.tick()).catch(error => {
        if (!(error instanceof NotificationUnavailable)) {
          console.error('notification delivery tick failed', error);
        }
      }).finally(() => { this.running = undefined; });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
