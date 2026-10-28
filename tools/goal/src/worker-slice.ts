import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import type { AttemptRef } from './contracts.ts';

export const WORKER_CPU_WEIGHT = 50;
export const WORKER_IO_WEIGHT = 50;
export const WORKER_SLICE = 'rezics-workers.slice';

type Run = (command: string, args: string[], options: SpawnSyncOptions) => SpawnSyncReturns<Buffer>;

function failure(result: SpawnSyncReturns<Buffer>): string | null {
  if (result.error) return result.error.message;
  if (result.status !== 0) {
    const detail = (result.stderr?.toString() || result.stdout?.toString()).trim().replace(/\s+/g, ' ');
    return `exited with status ${result.status ?? result.signal ?? 'unknown'}${detail ? `: ${detail}` : ''}`;
  }
  return null;
}

function workerUnit(taskId: string, attempt: number): string {
  const safeTask = taskId.replace(/[^A-Za-z0-9:_.-]/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return `rezics-worker-${safeTask}-${attempt}.scope`;
}

/** One launch policy instance caches the runtime slice configuration attempt for this process. */
export class WorkerSlice {
  private configured = false;
  private configurationError: string | null = null;

  constructor(private readonly run: Run = spawnSync) {}

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
      this.configured = true;
      this.configurationError = this.configure(options);
    }
    if (this.configurationError) {
      report(`Worker systemd scope unavailable; starting without a scope: ${this.configurationError}`);
      return this.run(command, args, options);
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
    if (!scopedError || hasStarted()) return scoped;
    report(`Worker systemd scope unavailable; starting without a scope: systemd-run ${scopedError}`);
    return this.run(command, args, options);
  }

  private configure(options: SpawnSyncOptions): string | null {
    const result = this.run(
      'systemctl',
      [
        '--user',
        'set-property',
        '--runtime',
        WORKER_SLICE,
        `CPUWeight=${WORKER_CPU_WEIGHT}`,
        `IOWeight=${WORKER_IO_WEIGHT}`,
      ],
      { ...options, stdio: ['ignore', 'pipe', 'pipe'] },
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
