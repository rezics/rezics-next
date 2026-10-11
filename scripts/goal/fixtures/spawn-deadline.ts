import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** A fixture deadline detects a hung child; SIGKILL also bounds children that ignore SIGTERM. */
export function fixtureSpawns(deadlineMs: number, logFile?: string): typeof nativeSpawnSync {
  return ((...args: Parameters<typeof nativeSpawnSync>) => {
    const started = performance.now();
    const result = nativeSpawnSync(args[0], args[1], { ...args[2], timeout: deadlineMs, killSignal: 'SIGKILL' });
    const durationMs = performance.now() - started;
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ command: args[0], args: args[1],
      cwd: args[2]?.cwd, durationMs, status: result.status, signal: result.signal })}\n`);
    if (result.status === null) throw new Error(
      `${[args[0], ...args[1] ?? []].join(' ')} did not exit after ${Math.round(durationMs)}ms`
      + ` (deadline ${deadlineMs}ms): ${result.error?.message ?? 'no exit status'}`
      + `${result.signal ? ` (${result.signal})` : ''}\n${result.stdout}\n${result.stderr}`);
    return result;
  }) as typeof nativeSpawnSync;
}
