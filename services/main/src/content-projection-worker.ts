import type { ContentProjectionResult } from './modules/content-publication/relay.ts';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { logWorkerFault, telemetryLog } from '@rezics/observability/log';
import { RelayHandoffIncomplete } from './modules/outbox/relay.ts';
import { runWorkerTick } from './worker-tick.ts';

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
    private readonly onError: (error: unknown) => void = error => logWorkerFault('main.content.projection', error)) {
    if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) {
      throw new Error('CONTENT_PROJECTION_INTERVAL_MS must be an integer from 100 to 60000');
    }
  }

  pollOnce(): Promise<ContentProjectionResult | null> {
    return runWorkerTick('main.content.projection', async () => (await this.pollComplete()).result);
  }

  private async pollComplete(): Promise<{ result: ContentProjectionResult | null; deferred: boolean }> {
    try { return { result: await this.poll(), deferred: false }; }
    catch (error) {
      if (!(error instanceof RelayHandoffIncomplete)) throw error;
      telemetryLog('worker_run_deferred', 'warn', {
        'rezics.worker.name': 'main.content.projection',
        'error.code': 'main_relay_handoff_incomplete',
        'rezics.relay.data_epoch': error.dataEpoch,
        'rezics.relay.requested_sequence': error.sequence,
        'rezics.projection.recovery_retry_ms': this.intervalMs,
      });
      return { result: null, deferred: true };
    }
  }

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
      try { idle = (await runWorkerTick('main.content.projection', () => withWorkerTelemetry('main.content.projection', () => this.pollComplete(), tick => ({
        outcome: tick.deferred ? 'deferred' : tick.result === null ? 'idle' : 'worked',
        processed: tick.result === null ? 0 : 1, unit: 'event',
      })))).result === null; }
      catch (error) { this.onError(error); idle = true; }
      if (idle && !this.stopSignal.signal.aborted) {
        await waitForPoll(this.intervalMs, this.stopSignal.signal);
      }
    }
  }
}
