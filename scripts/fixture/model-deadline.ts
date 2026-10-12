/** The restore phase owns this deadline, including every graph/object await. */
export class ModelAlignmentTimeout extends Error {
  readonly phase = 'align-model';
  constructor() { super('Fixture restore timed out during align-model'); this.name = 'ModelAlignmentTimeout'; }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? new ModelAlignmentTimeout() : signal.reason;
}
function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function modelWork<T>(signal: AbortSignal | undefined, work: () => T | Promise<T>): Promise<T> {
  checkSignal(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortReason(signal!));
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { checkSignal(signal); return work(); }).then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', aborted));
  });
}

export class ModelWorkBudget {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  constructor(private readonly remainingWork: () => number, parent?: AbortSignal) {
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(new ModelAlignmentTimeout()), this.remaining());
  }
  remaining(): number {
    checkSignal(this.signal);
    let ms: number;
    try { ms = this.remainingWork(); } catch { ms = 0; }
    if (ms <= 0) { this.controller.abort(new ModelAlignmentTimeout()); checkSignal(this.signal); }
    return Math.max(1, Math.ceil(ms));
  }
  run<T>(work: () => T | Promise<T>): Promise<T> {
    this.remaining();
    return modelWork(this.signal, work);
  }
  close(): void { clearTimeout(this.timer); }
}
