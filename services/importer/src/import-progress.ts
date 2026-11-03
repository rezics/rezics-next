import { randomUUID } from 'node:crypto';
import type { ImportProgressPhase } from './import-contract.ts';

export type ImportProgressMode = 'human' | 'jsonl';
export type ImportProgressOutcome =
  | 'committed'
  | 'invalid-input'
  | 'mass-disappearance'
  | 'busy'
  | 'interrupted'
  | 'denied'
  | 'failed';

export type ImportProgressCounts = Readonly<{
  inputBytes: number;
  materializedRecords: number;
  stagedRecords: number;
  acknowledgedEffects: number;
  newRecords: number;
  changedRecords: number;
  unchangedRecords: number;
  vanishedRecords: number;
  skippedRecords: number;
  deferredMedia: number;
  rejectedMedia: number;
}>;

export type ImportProgressEvent = Readonly<{
  version: 1;
  source: string;
  invocation: string;
  sequence: number;
  run: string | null;
  sourceRun: string | null;
  resumed: boolean;
  phase: ImportProgressPhase;
  terminal: boolean;
  outcome: ImportProgressOutcome | null;
  sourceComplete: boolean;
  selectedCatalogue: 'not-read';
  counts: ImportProgressCounts;
}>;

/** One bounded progress frame at a time. The sink must settle or reject when its signal aborts. */
export interface ImportProgressSink {
  write(frame: string, signal: AbortSignal): void | Promise<void>;
}

export type ProgressCounter = keyof ImportProgressCounts;
const CADENCE_MS = 250;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

export class ImportProgressOutputError extends Error {
  constructor() {
    super('Import progress output failed');
    this.name = 'ImportProgressOutputError';
  }
}

export class ImportProgressReporter {
  readonly invocation = randomUUID();
  private readonly counts: Record<ProgressCounter, number> = {
    inputBytes: 0,
    materializedRecords: 0,
    stagedRecords: 0,
    acknowledgedEffects: 0,
    newRecords: 0,
    changedRecords: 0,
    unchangedRecords: 0,
    vanishedRecords: 0,
    skippedRecords: 0,
    deferredMedia: 0,
    rejectedMedia: 0,
  };
  private phase: ImportProgressPhase = 'acquiring';
  private run: string | null = null;
  private sourceRun: string | null = null;
  private resumed = false;
  private sourceComplete = false;
  private outcome: ImportProgressOutcome | null = null;
  private sequence = 0;
  private dirty = true;
  private terminal = false;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private failure = false;
  private terminalFlushed = false;

  constructor(
    private readonly options: {
      source: string;
      mode: ImportProgressMode;
      tty: boolean;
      sink: ImportProgressSink;
      signal: AbortSignal;
      onFailure(): void;
    },
  ) {}

  get outputFailed(): boolean {
    return this.failure;
  }

  get outputIncomplete(): boolean {
    return this.terminal && !this.terminalFlushed;
  }

  setRun(run: string, resumed: boolean): void {
    this.run = run;
    this.resumed = resumed;
    this.changed();
  }

  setSourceRun(run: string): void {
    this.sourceRun = run;
    this.changed();
  }

  setSourceComplete(): void {
    this.sourceComplete = true;
    this.changed();
  }

  add(counter: ProgressCounter, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) return;
    this.counts[counter] = Math.min(MAX_COUNT, this.counts[counter] + amount);
    this.changed();
  }

  async setPhase(phase: ImportProgressPhase): Promise<void> {
    if (this.closed || (this.phase === phase && this.sequence > 0)) return;
    this.phase = phase;
    this.dirty = true;
    await this.flushNow();
  }

  async finish(phase: ImportProgressPhase, outcome: ImportProgressOutcome): Promise<void> {
    if (this.closed) return;
    this.phase = phase;
    this.outcome = outcome;
    this.terminal = true;
    this.dirty = true;
    this.cancelTimer();
    try {
      await this.flushNow();
      this.terminalFlushed = !this.dirty && !this.failure && !this.options.signal.aborted;
    } finally {
      this.closed = true;
      this.cancelTimer();
    }
  }

  close(): void {
    this.closed = true;
    this.cancelTimer();
  }

  private changed(): void {
    if (this.closed) return;
    this.dirty = true;
    if (!this.timer && !this.inFlight) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.pump().catch(() => {});
      }, CADENCE_MS);
      (this.timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private snapshot(): ImportProgressEvent {
    return {
      version: 1,
      source: this.options.source,
      invocation: this.invocation,
      sequence: ++this.sequence,
      run: this.run,
      sourceRun: this.sourceRun,
      resumed: this.resumed,
      phase: this.phase,
      terminal: this.terminal,
      outcome: this.outcome,
      sourceComplete: this.sourceComplete,
      selectedCatalogue: 'not-read',
      counts: { ...this.counts },
    };
  }

  private async pump(): Promise<void> {
    if (this.closed || !this.dirty || this.failure || this.options.signal.aborted) return;
    if (this.inFlight) {
      await this.inFlight;
      if (this.dirty && !this.closed) this.schedule();
      return;
    }
    this.dirty = false;
    const frame = this.render(this.snapshot());
    const pending = this.deliver(frame);
    this.inFlight = pending;
    try {
      await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = undefined;
    }
    if (this.dirty && !this.closed) this.schedule();
  }

  private async flushNow(): Promise<void> {
    this.cancelTimer();
    while (this.dirty && !this.closed && !this.failure) {
      if (this.options.signal.aborted) return;
      if (this.inFlight) {
        await this.inFlight;
        continue;
      }
      this.dirty = false;
      const frame = this.render(this.snapshot());
      const pending = this.deliver(frame);
      this.inFlight = pending;
      try {
        await pending;
      } finally {
        if (this.inFlight === pending) this.inFlight = undefined;
      }
    }
  }

  private schedule(): void {
    if (this.timer || this.closed || this.failure) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump().catch(() => {});
    }, CADENCE_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async deliver(frame: string): Promise<void> {
    try {
      await withAbort(Promise.resolve().then(() => this.options.sink.write(frame, this.options.signal)), this.options.signal);
    } catch {
      if (!this.options.signal.aborted) {
        this.failure = true;
        this.options.onFailure();
        throw new ImportProgressOutputError();
      }
    }
  }

  private render(event: ImportProgressEvent): string {
    if (this.options.mode === 'jsonl') return `${JSON.stringify(event)}\n`;
    const source = safeTerminalText(event.source);
    const counts = event.counts;
    const line = `Import ${source} ${event.phase}: ${counts.inputBytes} bytes, ${counts.materializedRecords} materialized, ${counts.stagedRecords} staged, ${counts.acknowledgedEffects} acknowledged effects; new ${counts.newRecords}, changed ${counts.changedRecords}, unchanged ${counts.unchangedRecords}, vanished ${counts.vanishedRecords}, skipped ${counts.skippedRecords}, media deferred ${counts.deferredMedia}, rejected ${counts.rejectedMedia}`;
    return `${this.options.tty ? '\r' : ''}${line}${this.options.tty && event.terminal ? '\n' : this.options.tty ? '' : '\n'}`;
  }
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Progress output cancelled', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(new DOMException('Progress output cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createWritableProgressSink(writable: {
  write(frame: string, callback: (error?: Error | null) => void): boolean;
}): ImportProgressSink {
  return {
    write(frame, signal) {
      if (signal.aborted) return Promise.reject(new DOMException('Progress output cancelled', 'AbortError'));
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new DOMException('Progress output cancelled', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        try {
          writable.write(frame, (error) => finish(error));
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Progress output failed'));
        }
      });
    },
  };
}
