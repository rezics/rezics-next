import type { WorkActivationEnvironment } from '../work/activate.ts';
import { projectOccurrenceLabelsOnce } from './label-index-backfill.ts';
import { runMainRelay } from '../outbox/worker.ts';

/** Uses the existing search projection retry loop and native durable checkpoint;
 * one batch at a time, including after a restart or an interrupted rebuild. */
export class OccurrenceLabelWorker {
  private running = false;
  private task: Promise<void> | undefined;
  constructor(private readonly environment: WorkActivationEnvironment, private readonly intervalMs = 1000) {}
  start() {
    this.running = true;
    this.task ??= runMainRelay(() => projectOccurrenceLabelsOnce(this.environment),
      () => this.running, this.intervalMs, { consumer: 'occurrence-labels' });
  }
  async stop() { this.running = false; await this.task; }
}
