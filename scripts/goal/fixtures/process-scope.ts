import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { processRunning } from '../../../tests/qa/support/process-liveness.ts';

/** Detached fixture descendants can outlive both their launcher and their ledger entry. */
export function fixtureProcessScope(token = randomUUID()) {
  const marker = `GOAL_TEST_PROCESS_SCOPE=${token}`;
  const processes = (): number[] => {
    const found: number[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(marker)
          && processRunning(Number(entry))) found.push(Number(entry));
      } catch (error) {
        if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    return found;
  };
  return {
    env: { GOAL_TEST_PROCESS_SCOPE: token },
    processes,
    cleanup(): void {
      const deadline = Date.now() + 5_000;
      // Rescan after killing launchers: a child may have forked during the preceding scan.
      for (;;) {
        const remaining = processes();
        if (!remaining.length) return;
        for (const pid of remaining) {
          try { process.kill(pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
        if (Date.now() >= deadline) throw new Error(`Fixture processes did not stop: ${remaining.join(', ')}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    },
  };
}
