import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AttemptRef } from './contracts.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

export const WORKER_CPU_WEIGHT = defaultPolicy.workerResources.cpuWeight;
export const WORKER_IO_WEIGHT = defaultPolicy.workerResources.ioWeight;
export const WORKER_SLICE = 'rezics-workers.slice';
/** Finite bound for systemctl configuration only; worker and systemd-run keep the caller's launch options. */
export const WORKER_SLICE_PREPARATION_TIMEOUT_MS = defaultPolicy.workerResources.preparationTimeoutMs;
// Binary unit conversion, independent of admission policy.
const GIB = 1024 ** 3;
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
// Base-36 time and a short random suffix provide unit identity, not a worker admission limit.
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
    private readonly preparationTimeoutMs?: number,
    private readonly policy = defaultPolicy.workerResources,
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
      timeout: this.preparationTimeoutMs ?? this.policy.preparationTimeoutMs,
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
      memoryHigh = Math.max(
        Math.ceil(totalGiB * this.policy.minimumMemoryFraction),
        totalGiB - checkGiB - this.policy.memoryReserveGiB,
      );
    }
    const result = this.run(
      'systemctl',
      [
        '--user',
        'set-property',
        '--runtime',
        WORKER_SLICE,
        `CPUWeight=${this.policy.cpuWeight}`,
        `IOWeight=${this.policy.ioWeight}`,
        `MemoryHigh=${memoryHigh}G`,
      ],
      configuration,
    );
    return failure(result);
  }
}

// Cache configuration attempts per immutable settings policy; one caller cannot replace another caller's policy.
const workerSlices = new WeakMap<ControlPolicy['workerResources'], WorkerSlice>();

export function launchWorkerProcess(
  taskId: string,
  attempt: AttemptRef['attempt'],
  command: string,
  args: string[],
  options: SpawnSyncOptions,
  hasStarted: () => boolean,
  policy = defaultPolicy.workerResources,
): SpawnSyncReturns<Buffer> {
  let slice = workerSlices.get(policy);
  if (!slice) {
    slice = new WorkerSlice(undefined, undefined, undefined, policy);
    workerSlices.set(policy, slice);
  }
  return slice.launch(taskId, attempt, command, args, options, hasStarted);
}
