import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One combined check plus one rerun after that check failed. */
export const WORKER_CHECK_HOST_RUN_LIMIT = 2;
export const WORKER_CHECK_HOST_BUDGET_REFUSAL =
  'Check-host budget exhausted: this attempt already used its one check and one rerun. Finish the outcome and return success or a blocker.';
/** Transport, upload or probe failure before the check command ran (`scripts/remote-check.ts`). */
export const WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT = 75;
const STAMP_NAME = /^[1-9]\d*$/;

export type WorkerCheckHostBudgetLimit = typeof WORKER_CHECK_HOST_RUN_LIMIT | 'off';

export type WorkerCheckBudgetTask = {
  brief?: {
    goal?: string;
    kind?: string;
    urgent?: boolean;
    acceptance?: { requires?: readonly string[] };
  };
  proofRun?: { binding?: { attempt?: number } } | null;
  proofAuthorization?: unknown;
};

/** Native receipt fields that prove the remote check command started. */
export type WorkerCheckHostCommandReceipt = {
  resources?: { commandStartedMonoMs?: number | null } | null;
};

/** Controller-owned stamp directory beside the attempt's check-wait file. */
export function workerCheckBudgetDirectory(stateDirectory: string, taskId: string, attempt: number): string {
  return join(stateDirectory, 'runs', taskId, `${attempt}.check-host-runs`);
}

/**
 * Proof-run, registered-proof and acceptance-requiring briefs keep their declared checks. Urgent and control-plane
 * tasks are exempt. Everyone else is held to one check-host wrapper run plus one rerun after a failure.
 */
export function workerCheckHostBudgetLimit(task: WorkerCheckBudgetTask, attempt?: number): WorkerCheckHostBudgetLimit {
  const brief = task.brief;
  if (brief?.urgent === true || brief?.goal === 'control-plane') return 'off';
  if ((brief?.acceptance?.requires?.length ?? 0) > 0) return 'off';
  if (brief?.kind === 'verification' && task.proofAuthorization) return 'off';
  if (brief?.kind === 'verification' && attempt !== undefined && task.proofRun?.binding?.attempt === attempt)
    return 'off';
  return WORKER_CHECK_HOST_RUN_LIMIT;
}

export function workerCheckHostRunsUsed(directory: string): number {
  try {
    return readdirSync(directory).filter((name) => STAMP_NAME.test(name)).length;
  } catch {
    return 0;
  }
}

function nextWorkerCheckHostStamp(directory: string): string {
  const names = new Set(readdirSync(directory).filter((name) => STAMP_NAME.test(name)));
  for (let n = 1; ; n += 1) {
    const stamp = String(n);
    if (!names.has(stamp)) return stamp;
  }
}

export type WorkerCheckHostAdmit = {
  directory?: string | undefined;
  limit?: string | number | null | undefined;
};

export type WorkerCheckHostAdmitResult =
  | { ok: true; used: number; stamp: string }
  | { ok: true; used: 0 }
  | { ok: false; used: number; message: string };

/**
 * Record one check-host wrapper request for this attempt. Missing controller state does not invent a budget.
 * A third request is refused before the caller reserves a host.
 */
export function admitWorkerCheckHostRun(input: WorkerCheckHostAdmit): WorkerCheckHostAdmitResult {
  const directory = input.directory?.trim();
  if (!directory) return { ok: true, used: 0 };
  const exempt = input.limit === 'off' || input.limit === null;
  mkdirSync(directory, { recursive: true });
  for (;;) {
    const used = workerCheckHostRunsUsed(directory);
    if (!exempt && used >= WORKER_CHECK_HOST_RUN_LIMIT)
      return { ok: false, used, message: WORKER_CHECK_HOST_BUDGET_REFUSAL };
    const stamp = nextWorkerCheckHostStamp(directory);
    try {
      writeFileSync(join(directory, stamp), '', { flag: 'wx' });
      return { ok: true, used: used + 1, stamp };
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
  }
}

/** Wrapper entry: no-op for local placement and for workers the controller did not launch. */
export function refuseExcessWorkerCheckHostRun(env: NodeJS.ProcessEnv, placesOnCheckHost: boolean): void {
  if (!placesOnCheckHost) return;
  const admitted = admitWorkerCheckHostRun({
    directory: env.GOAL_WORKER_CHECK_BUDGET_DIR,
    limit: env.GOAL_WORKER_CHECK_BUDGET,
  });
  if (!admitted.ok) throw new Error(admitted.message);
  if ('stamp' in admitted) env.GOAL_WORKER_CHECK_BUDGET_STAMP = admitted.stamp;
}

export function workerCheckHostCommandReached(receipt: WorkerCheckHostCommandReceipt | null | undefined): boolean {
  return receipt?.resources?.commandStartedMonoMs != null;
}

/**
 * Give this wrapper run's stamp back when it died with infrastructure exit 75 before the check command ran.
 * The wrapper calls this where it records the run's final exit code.
 */
export function settleWorkerCheckHostBudget(env: NodeJS.ProcessEnv, exitCode: number, commandReached: boolean): void {
  if (exitCode !== WORKER_CHECK_HOST_INFRASTRUCTURE_EXIT || commandReached) return;
  const directory = env.GOAL_WORKER_CHECK_BUDGET_DIR?.trim();
  const stamp = env.GOAL_WORKER_CHECK_BUDGET_STAMP?.trim();
  if (!directory || !stamp || !STAMP_NAME.test(stamp)) return;
  try {
    unlinkSync(join(directory, stamp));
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
}
