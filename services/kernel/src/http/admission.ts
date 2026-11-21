import { ProblemError } from './problem.ts';

export const ADMISSION_LIMITS = { permits: 8, reserved: 2, bearer: 4, queue: 32 } as const;

export type AdmissionLane = 'normal' | 'reserved';
export type JobContext = { deadline: number; signal?: AbortSignal };

type AdmissionWork = AdmissionLane | 'bearer';

type HeldNormalJob = { context: JobContext; pending?: Promise<unknown> };
type Limits = { permits: number; reserved: number; bearer?: number; queue: number };
type Waiter = {
  lane: AdmissionWork;
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

export function requireLiveJob(context: JobContext): void {
  if (context.signal?.aborted) throw abortReason(context.signal);
  if (context.deadline <= Date.now()) throw overloaded();
}

export class Admission {
  private readonly limits: Required<Limits>;
  private readonly active = { normal: 0, reserved: 0, bearer: 0 };
  private readonly queue: Waiter[] = [];
  private readonly normalJobs = new WeakMap<AdmissionYield, HeldNormalJob>();

  constructor(limits: Limits = ADMISSION_LIMITS) {
    this.limits = { ...limits, bearer: limits.bearer ?? ADMISSION_LIMITS.bearer };
  }

  get running(): Readonly<Record<AdmissionWork, number>> {
    return { ...this.active };
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Untouched credentials need no account checkout when their next native stage cannot even queue. */
  async verify<T>(context: JobContext, requiresNormal: boolean, verify: () => Promise<T>): Promise<T> {
    if (!requiresNormal) return this.run('bearer', context, verify);
    this.requireNormalCapacity(context);
    return this.run('bearer', context, () => {
      // The normal lane can fill while this credential is waiting for a verifier.
      this.requireNormalCapacity(context);
      return verify();
    });
  }

  private requireNormalCapacity(context: JobContext): void {
    requireLiveJob(context);
    if (!this.available('normal') && this.queue.length >= this.limits.queue && this.lastQueuedBearer() === -1)
      throw overloaded();
  }

  /** A sequential Access preparation may use the enclosing native job's live permit. */
  async prepare<T>(context: JobContext, job: () => Promise<T>, permit?: AdmissionYield): Promise<T> {
    const held = permit && this.normalJobs.get(permit);
    if (!held || held.context !== context || held.pending) return this.run('normal', context, job);
    requireLiveJob(context);
    const pending = Promise.resolve().then(job);
    held.pending = pending;
    try {
      return await pending;
    } finally {
      delete held.pending;
    }
  }

  async run<T>(
    lane: AdmissionWork,
    context: JobContext,
    job: (yieldPermit: AdmissionYield) => T | Promise<T>,
  ): Promise<T> {
    let release = await this.acquire(lane, context);
    let active = true;
    let finished = false;
    const held: HeldNormalJob | undefined = lane === 'normal' ? { context } : undefined;
    const yieldPermit: AdmissionYield = async <Value>(wait: () => Promise<Value>) => {
      if (finished || !active) throw new Error('Admission permit is no longer active');
      if (held?.pending) throw new Error('Cannot yield during Access preparation');
      active = false;
      this.normalJobs.delete(yieldPermit);
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
          if (held) this.normalJobs.set(yieldPermit, held);
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
    if (held) this.normalJobs.set(yieldPermit, held);
    try {
      return await job(yieldPermit);
    } finally {
      finished = true;
      this.normalJobs.delete(yieldPermit);
      if (held?.pending) await held.pending.catch(() => {});
      if (active) {
        active = false;
        release();
      }
    }
  }

  private async acquire(lane: AdmissionWork, context: JobContext): Promise<() => void> {
    requireLiveJob(context);
    const available = this.available(lane);
    if (available) {
      this.active[lane]++;
      return this.release(lane);
    }
    if (this.queue.length >= this.limits.queue) {
      // An untouched bearer can retry. Keep room for work that already authenticated.
      const lastBearer = lane === 'bearer' ? -1 : this.lastQueuedBearer();
      if (lastBearer === -1) throw overloaded();
      const [displaced] = this.queue.splice(lastBearer, 1);
      this.clear(displaced!);
      displaced!.reject(overloaded());
    }

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

  private lastQueuedBearer(): number {
    return this.queue.findLastIndex((waiter) => waiter.lane === 'bearer');
  }

  private available(lane: AdmissionWork): boolean {
    return this.active[lane] < this.limits[lane === 'normal' ? 'permits' : lane];
  }

  private release(lane: AdmissionWork): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active[lane]--;
      this.drain(lane);
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
  }

  private drain(lane: AdmissionWork): void {
    for (let index = 0; index < this.queue.length && this.available(lane);) {
      const waiter = this.queue[index]!;
      if (waiter.lane !== lane) {
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
      this.active[lane]++;
      waiter.resolve(this.release(lane));
    }
  }
}
