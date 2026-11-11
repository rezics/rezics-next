import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type PressureSample = { memoryFull: number; ioFull: number };
export type PressureBrake = { paused: boolean; healthySince?: number };
export const PRESSURE_RECOVERY_MS = 30_000;
/** PSI measures stalled work, not an assertion that the kernel killed a process. */
export function pressureBrake(previous: PressureBrake, sample: PressureSample, now: number): PressureBrake {
  if (sample.memoryFull >= 1 || sample.ioFull >= 10) return { paused: true };
  if (!previous.paused) return { paused: false };
  if (sample.memoryFull >= 0.2 || sample.ioFull >= 2) return { paused: true };
  const healthySince = previous.healthySince ?? now;
  return now - healthySince >= PRESSURE_RECOVERY_MS ? { paused: false } : { paused: true, healthySince };
}
export function readHostPressure(): PressureSample {
  const read = (resource: string) => {
    try {
      return Number(/^full avg10=([\d.]+)/m.exec(readFileSync(`/proc/pressure/${resource}`, 'utf8'))?.[1] ?? 0);
    } catch {
      return 0; // Non-Linux hosts retain their existing memory-floor admission.
    }
  };
  return { memoryFull: read('memory'), ioFull: read('io') };
}
export const CODE_WORKER_MIB = 2048;
export const HEAVY_WORKER_MIB = 4096;
const MIB = 1024 ** 2;
export const WORKER_SLICE_ROOT = `/sys/fs/cgroup/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/rezics.slice/rezics-workers.slice`;
/** Initial working-set reservation; hard safety limits are deliberately not expected working sets. */
export function workerReservationMiB(goal?: string): number {
  return goal && goal !== 'control-plane' ? CODE_WORKER_MIB : HEAVY_WORKER_MIB;
}
/** A finite operator slice opts in. Account for support services' actual use and workers' measured peaks. */
export function workerHeadroomMiB(
  running: number,
  root = WORKER_SLICE_ROOT,
  parkedScopes: ReadonlySet<string> = new Set(),
  activeScopes?: ReadonlySet<string>,
): number {
  const read = (path: string) => Number(readFileSync(path, 'utf8').trim());
  let maximum: number;
  try {
    maximum = read(join(root, 'memory.max'));
    if (!Number.isFinite(maximum)) return Infinity;
  } catch {
    return Infinity; // Existing hosts without the operator slice are unchanged.
  }
  try {
    let reserved = read(join(root, 'memory.current'));
    let scopes = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^rezics-worker-.+\.scope$/.test(entry.name)) continue;
      const scope = join(root, entry.name);
      try {
        const current = read(join(scope, 'memory.current'));
        // Aggregate memory.current already charges parked checks in full. Only a reconciled owned scope may
        // relinquish its writing reserve, and it cannot stand in for a missing running worker below.
        if (parkedScopes.has(entry.name) && !activeScopes?.has(entry.name)) continue;
        const peak = read(join(scope, 'memory.peak'));
        reserved += Math.max(0, Math.max(HEAVY_WORKER_MIB * MIB, peak) - current);
        // An old or unidentified scope keeps its own reserve, but cannot replace an unreconciled current writer.
        if (!activeScopes || activeScopes.has(entry.name)) scopes++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A scope removed during this read is covered conservatively by the running counter below.
      }
    }
    reserved += Math.max(0, running - scopes) * HEAVY_WORKER_MIB * MIB;
    return Number.isFinite(reserved) ? Math.max(0, maximum - reserved) / MIB : 0;
  } catch {
    return 0; // A known finite budget with unreadable usage cannot admit another reservation.
  }
}
