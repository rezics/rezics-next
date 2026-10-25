import { ProblemError } from './problem.ts';

export const ADMISSION_LIMITS = { permits: 8, reserved: 2, queue: 32 } as const;

export type AdmissionLane = 'normal' | 'reserved';
export type JobContext = { deadline: number; signal?: AbortSignal };

type Limits = { permits: number; reserved: number; queue: number };
type Waiter = {
  lane: AdmissionLane;
  context: JobContext;
  job: () => unknown | Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

function overloaded(): ProblemError {
  return new ProblemError('overloaded', { headers: { 'retry-after': '1' } });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

export class Admission {
  private readonly limits: Limits;
  private readonly active = { normal: 0, reserved: 0 };
  private readonly queue: Waiter[] = [];

  constructor(limits: Limits = ADMISSION_LIMITS) {
    this.limits = { ...limits };
  }

  get running(): Readonly<{ normal: number; reserved: number }> {
    return { ...this.active };
  }

  get waiting(): number {
    return this.queue.length;
  }

  run<T>(lane: AdmissionLane, context: JobContext, job: () => T | Promise<T>): Promise<T> {
    if (context.signal?.aborted) return Promise.reject(abortReason(context.signal));
    if (context.deadline <= Date.now()) return Promise.reject(overloaded());

    const hasEarlier = this.queue.some((waiter) => waiter.lane === lane);
    if (!hasEarlier && this.active[lane] < this.capacity(lane)) return this.execute(lane, job);
    if (this.queue.length >= this.limits.queue) return Promise.reject(overloaded());

    return new Promise<T>((resolve, reject) => {
      const remaining = Math.max(0, context.deadline - Date.now());
      const waiter: Waiter = {
        lane,
        context,
        job,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => this.remove(waiter, overloaded()), remaining),
      };
      if (context.signal) {
        waiter.abort = () => this.remove(waiter, abortReason(context.signal!));
        context.signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  private capacity(lane: AdmissionLane): number {
    return lane === 'normal' ? this.limits.permits : this.limits.reserved;
  }

  private execute<T>(lane: AdmissionLane, job: () => T | Promise<T>): Promise<T> {
    this.active[lane]++;
    return Promise.resolve()
      .then(job)
      .finally(() => {
        this.active[lane]--;
        this.drain();
      });
  }

  private clear(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    if (waiter.abort && waiter.context.signal) waiter.context.signal.removeEventListener('abort', waiter.abort);
  }

  private remove(waiter: Waiter, reason: unknown): void {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.clear(waiter);
    waiter.reject(reason);
    this.drain();
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length;) {
      const waiter = this.queue[index]!;
      if (this.active[waiter.lane] >= this.capacity(waiter.lane)) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      this.clear(waiter);
      if (waiter.context.signal?.aborted) {
        waiter.reject(abortReason(waiter.context.signal));
        continue;
      }
      if (waiter.context.deadline <= Date.now()) {
        waiter.reject(overloaded());
        continue;
      }
      this.execute(waiter.lane, waiter.job).then(waiter.resolve, waiter.reject);
    }
  }
}
