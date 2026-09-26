import { NotificationUnavailable } from './store.ts';
import { NotificationDispatcher, DISPATCH_LIMITS } from './dispatcher.ts';

/** Periodic bounded runner; database rows remain the durable schedule. */
export class NotificationDeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly dispatcher: NotificationDispatcher, private readonly intervalMs = 1_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('intervalMs must be positive');
  }

  async tick(): Promise<void> {
    await this.dispatcher.recoverExpiredLeases(DISPATCH_LIMITS.batch);
    await this.dispatcher.runOnce(DISPATCH_LIMITS.batch);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick().catch(error => {
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
