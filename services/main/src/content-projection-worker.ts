import type { ContentProjectionResult } from './modules/content-publication/relay.ts';

function waitForPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** A single bounded poller. The Content cursor, rather than process memory, owns progress. */
export class ContentProjectionWorker {
  private readonly stopSignal = new AbortController();
  private task: Promise<void> | undefined;

  constructor(private readonly poll: () => Promise<ContentProjectionResult | null>,
    private readonly intervalMs = 1000,
    private readonly onError: (error: unknown) => void = error => console.error('Content projection:', error)) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
      throw new Error('CONTENT_PROJECTION_INTERVAL_MS must be an integer from 100 to 60000');
    }
  }

  pollOnce(): Promise<ContentProjectionResult | null> { return this.poll(); }

  start(): void {
    if (this.task || this.stopSignal.signal.aborted) throw new Error('Content projection worker already started or stopped');
    this.task = this.run();
  }

  async stop(): Promise<void> {
    this.stopSignal.abort();
    await this.task;
  }

  private async run(): Promise<void> {
    while (!this.stopSignal.signal.aborted) {
      let idle = false;
      try { idle = (await this.poll()) === null; }
      catch (error) { this.onError(error); idle = true; }
      if (idle && !this.stopSignal.signal.aborted) {
        await waitForPoll(this.intervalMs, this.stopSignal.signal);
      }
    }
  }
}
