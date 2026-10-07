import { withQaStackStartup, type StartupMemoryOptions, type QaMemoryService } from '../qa/memory-admission.ts';

/** Memory queueing belongs to the QA run deadline, outside active preparation. */
export class FixtureWorkBudget {
  private readonly started: number;
  private waitingMs = 0;
  constructor(private readonly duration: number, private readonly now = Date.now) {
    this.started = now();
  }
  readonly excludeAdmissionWait = (ms: number): void => { this.waitingMs += ms; };
  elapsed(): number { return this.now() - this.started - this.waitingMs; }
  admissionWaitMs(): number { return this.waitingMs; }
  timing(): { elapsedMs: number; admissionWaitMs: number } {
    return { elapsedMs: this.elapsed(), admissionWaitMs: this.waitingMs };
  }
  remaining(): number {
    const remaining = this.duration - this.elapsed();
    if (remaining <= 0) throw new Error('Fixture preparation exceeded 600 seconds');
    return remaining;
  }
  startup<T>(root: string, env: NodeJS.ProcessEnv, work: () => T | Promise<T>,
    options: Partial<StartupMemoryOptions> & { services?: readonly QaMemoryService[] } = {}): Promise<T> {
    return withQaStackStartup(root, env, undefined, work, { ...options,
      onAdmissionWait: ms => { this.excludeAdmissionWait(ms); options.onAdmissionWait?.(ms); } });
  }
}
