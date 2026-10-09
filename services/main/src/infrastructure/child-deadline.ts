/** A child Main must be able to stop when its deadline or the caller aborts. */
export interface DeadlineChild {
  kill(signal?: number | NodeJS.Signals): void;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
}

export interface ArmedChildDeadline {
  /** True only after the deadline elapses. An abort does not set it. */
  readonly expired: boolean;
  /** Drop the timer and abort listener, then SIGKILL a child that is still running. */
  release(): Promise<void>;
}

/** SIGKILL so a child that ignores SIGTERM cannot outlive the deadline or an abort. */
export function enforceChildDeadline(
  child: DeadlineChild,
  timeoutMs: number,
  signal?: AbortSignal,
): ArmedChildDeadline {
  let expired = false;
  const kill = () => {
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => {
    expired = true;
    kill();
  }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  // Abort may arrive between the caller's check and listener registration.
  if (signal?.aborted) kill();
  return {
    get expired() {
      return expired;
    },
    async release() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (child.exitCode === null) kill();
      await child.exited;
    },
  };
}
