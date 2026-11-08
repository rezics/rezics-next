import { ProblemError } from './problem.ts';

export const ADMISSION_LIMITS = { permits: 8, reserved: 2, queue: 32 } as const;

export type AdmissionLane = 'normal' | 'reserved';
export type JobContext = { deadline: number; signal?: AbortSignal };

type Limits = { permits: number; reserved: number; queue: number };
type Waiter = {
  lane: AdmissionLane;
  context: JobContext;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

/** Temporarily releases a permit during an explicit wait, then fairly reacquires it. */
export type AdmissionYield = <T>(wait: () => Promise<T>) => Promise<T>;

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

  async run<T>(
    lane: AdmissionLane,
    context: JobContext,
    job: (yieldPermit: AdmissionYield) => T | Promise<T>,
  ): Promise<T> {
    let release = await this.acquire(lane, context);
    let active = true;
    let finished = false;
    const yieldPermit: AdmissionYield = async <Value>(wait: () => Promise<Value>) => {
      if (finished || !active) throw new Error('Admission permit is no longer active');
      active = false;
      release();
      let result: Value | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = await wait();
      } catch (error) {
        failure = error;
        failed = true;
      }
      if (finished) {
        if (failed) throw failure;
        throw new Error('Admission job finished during its yielded wait');
      }
      if (!context.signal?.aborted) {
        try {
          const acquired = await this.acquire(lane, context);
          if (finished) {
            acquired();
            throw new Error('Admission job finished before permit reacquisition');
          }
          release = acquired;
          active = true;
        } catch (error) {
          if (!failed) {
            failure = error;
            failed = true;
          }
        }
      } else if (!failed) {
        failure = abortReason(context.signal);
        failed = true;
      }
      if (failed) throw failure;
      return result as Value;
    };
    try {
      return await job(yieldPermit);
    } finally {
      finished = true;
      if (active) {
        active = false;
        release();
      }
    }
  }

  private acquire(lane: AdmissionLane, context: JobContext): Promise<() => void> {
    if (context.signal?.aborted) return Promise.reject(abortReason(context.signal));
    if (context.deadline <= Date.now()) return Promise.reject(overloaded());

    const hasEarlier = this.queue.some((waiter) => waiter.lane === lane);
    if (!hasEarlier && this.active[lane] < this.capacity(lane)) {
      this.active[lane]++;
      return Promise.resolve(this.release(lane));
    }
    if (this.queue.length >= this.limits.queue) return Promise.reject(overloaded());

    return new Promise((resolve, reject) => {
      const remaining = Math.max(0, context.deadline - Date.now());
      const waiter: Waiter = {
        lane,
        context,
        resolve,
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

  private release(lane: AdmissionLane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active[lane]--;
      this.drain();
    };
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
      this.active[waiter.lane]++;
      waiter.resolve(this.release(waiter.lane));
    }
  }
}
