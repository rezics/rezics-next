// Timing only. Read the existing operations in the native worker's bounded output.
export function discoveryFinalizationTrace(prefix: string, deadline: number) {
  const startedAt = Date.now();
  let generation: number | undefined;
  let phase = 'select-target';
  let phaseStart = startedAt;
  const phaseMs: Record<string, number> = {};
  function enter(operation: string) {
    const now = Date.now();
    phaseMs[phase] = (phaseMs[phase] ?? 0) + now - phaseStart;
    phase = operation;
    phaseStart = now;
  }
  let completedHomes = 0;
  let firstFailure: { owner: string; partition: number } | undefined;
  const native: Record<string, { calls: number; homes: number; settled: number; totalMs: number }> = {};
  function report(details: Record<string, unknown> = {}) {
    if (generation === undefined) return;
    const observation = {
      prefix,
      generation,
      phase,
      startedAt,
      deadline,
      elapsedMs: Date.now() - startedAt,
      phaseMs: { ...phaseMs, [phase]: (phaseMs[phase] ?? 0) + Date.now() - phaseStart },
      completedHomes,
      native,
      firstFailure,
      ...details,
    };
    console.info('Mixed Home finalization', JSON.stringify(observation));
    return observation;
  }
  return {
    start(target: number, operation: string) {
      generation = target;
      enter(operation);
      report();
    },
    step(operation: string, checkedHomes = completedHomes) {
      enter(operation);
      completedHomes = checkedHomes;
      report();
    },
    async read<T>(owner: string, partition: number, homes: number, read: () => Promise<T>) {
      const stats = (native[owner] ??= { calls: 0, homes: 0, settled: 0, totalMs: 0 });
      stats.calls++;
      stats.homes += homes;
      if (stats.calls === 1) report({ reading: owner, partition });
      const start = performance.now();
      try {
        return await read();
      } catch (error) {
        firstFailure ??= { owner, partition };
        throw error;
      } finally {
        stats.settled++;
        stats.totalMs += performance.now() - start;
      }
    },
    report,
  };
}

export type DiscoveryFinalizationTrace = ReturnType<typeof discoveryFinalizationTrace>;
