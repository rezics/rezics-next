import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AttemptRef } from './contracts.ts';

export const WORKER_CPU_WEIGHT = 50;
export const WORKER_IO_WEIGHT = 50;
export const WORKER_SLICE = 'rezics-workers.slice';
/** Finite bound for systemctl configuration only; worker and systemd-run keep the caller's launch options. */
export const WORKER_SLICE_PREPARATION_TIMEOUT_MS = 5_000;
const GIB = 1024 ** 3;
// Total GiB minus local check MemoryMax minus 14 GiB (10 GiB floor + 4 GiB for managers, control plane and containers), at least a quarter of total.
const WORKER_MEMORY_RESERVE_GIB = 14;
const CHECK_SLICE = 'rezics-check.slice';

type Run = (command: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<Buffer>;
type ReadMeminfo = () => string;

function failure(result: SpawnSyncReturns<Buffer>): string | null {
  if (result.error) return result.error.message;
  if (result.status !== 0) {
    const detail = (result.stderr?.toString() || result.stdout?.toString() || '').trim().replace(/\s+/g, ' ');
    return `exited with status ${result.status ?? result.signal ?? 'unknown'}${detail ? `: ${detail}` : ''}`;
  }
  return null;
}

// A check-wake resume launches the same attempt again; systemd refuses a unit name that is still loaded, so each
// launch gets its own name.
function workerUnit(taskId: string, attempt: number): string {
  const safeTask = taskId.replace(/[^A-Za-z0-9:_.-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return `rezics-worker-${safeTask}-${attempt}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.scope`;
}

/** One launch policy instance caches the runtime slice configuration attempt for this process. */
export class WorkerSlice {
  private configured = false;
  private configurationError: string | null = null;

  constructor(
    private readonly run: Run = spawnSync,
    private readonly readMeminfo: ReadMeminfo = () => readFileSync('/proc/meminfo', 'utf8'),
    private readonly preparationTimeoutMs = WORKER_SLICE_PREPARATION_TIMEOUT_MS,
  ) {}

  launch(
    taskId: string,
    attempt: number,
    command: string,
    args: string[],
    options: SpawnSyncOptions,
    hasStarted: () => boolean,
    report: (message: string) => void = (message) => console.error(message),
  ): SpawnSyncReturns<Buffer> {
    if (!this.configured) {
      try {
        this.configurationError = this.configure(options);
      } catch (error) {
        this.configurationError = error instanceof Error ? error.message : String(error);
      }
      this.configured = true;
    }
    if (this.configurationError) {
      report(
        `Worker systemd slice tuning unavailable; attempting a protected scope with host defaults: ${this.configurationError}`,
      );
    }

    const scoped = this.run(
      'systemd-run',
      [
        '--user',
        '--scope',
        '--collect',
        '--quiet',
        `--slice=${WORKER_SLICE}`,
        `--unit=${workerUnit(taskId, attempt)}`,
        command,
        ...args,
      ],
      options,
    );
    const scopedError = failure(scoped);
    if (!scopedError) return scoped;
    if (hasStarted()) {
      report(
        `Worker systemd scope client failed after worker start; retaining the published worker start: ${scopedError}`,
      );
      return scoped;
    }
    const detail = [
      `systemd-run ${scopedError}`,
      ...(this.configurationError ? [`slice tuning failed: ${this.configurationError}`] : []),
    ].join('; ');
    const launchError =
      `Worker launch refused because a restart-safe user systemd scope could not be created before worker start (${detail}). ` +
      'Restore the user systemd manager and cgroup access, then retry; no unprotected worker was started.';
    report(launchError);
    throw new Error(launchError);
  }

  private configure(options: SpawnSyncOptions): string | null {
    const configuration: SpawnSyncOptions = {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: this.preparationTimeoutMs,
    };
    const env = options.env ?? process.env;
    const override = env.REZICS_WORKER_MEMORY_HIGH_GIB;
    let memoryHigh: number;
    if (override !== undefined) {
      if (!/^\d+$/.test(override) || Number(override) <= 0 || !Number.isSafeInteger(Number(override))) {
        return 'REZICS_WORKER_MEMORY_HIGH_GIB must be a positive integer';
      }
      memoryHigh = Number(override);
    } else {
      const totalMatch = /^MemTotal:\s+(\d+)\s+kB$/m.exec(this.readMeminfo());
      const totalGiB = totalMatch ? Math.floor((Number(totalMatch[1]) * 1024) / GIB) : 0;
      const check = this.run('systemctl', ['show', CHECK_SLICE, '-p', 'MemoryMax', '--value'], configuration);
      if (check.error) return failure(check);
      const checkValue = check.status === 0 ? check.stdout?.toString().trim() : '';
      const checkBytes = /^\d+$/.test(checkValue ?? '') ? Number(checkValue) : 0;
      const checkGiB = Math.floor(checkBytes / GIB);
      memoryHigh = Math.max(Math.ceil(totalGiB / 4), totalGiB - checkGiB - WORKER_MEMORY_RESERVE_GIB);
    }
    const result = this.run(
      'systemctl',
      [
        '--user',
        'set-property',
        '--runtime',
        WORKER_SLICE,
        `CPUWeight=${WORKER_CPU_WEIGHT}`,
        `IOWeight=${WORKER_IO_WEIGHT}`,
        `MemoryHigh=${memoryHigh}G`,
      ],
      configuration,
    );
    return failure(result);
  }
}

const workerSlice = new WorkerSlice();

export function launchWorkerProcess(
  taskId: string,
  attempt: AttemptRef['attempt'],
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  hasStarted: () => boolean,
): SpawnSyncReturns<Buffer> {
  return workerSlice.launch(taskId, attempt, command, args, options, hasStarted);
}
