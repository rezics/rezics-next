type Deadline = { callback: () => void; delay: number; canceled: boolean };

export function controlledDeadlines() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout, timers: Deadline[] = [];
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const timer = { callback: callback as () => void, delay: Number(delay ?? 0), canceled: false };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle) (handle as unknown as Deadline).canceled = true;
  }) as typeof clearTimeout;
  return {
    delays: () => timers.map(({ delay }) => delay),
    fireNext: () => {
      const timer = timers.find(({ canceled }) => !canceled);
      if (!timer) return false;
      timer.canceled = true;
      timer.callback();
      return true;
    },
    flush: async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    },
    restore: () => {
      globalThis.setTimeout = set;
      globalThis.clearTimeout = clear;
    },
  };
}
