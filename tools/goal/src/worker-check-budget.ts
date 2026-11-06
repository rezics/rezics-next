import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One combined check plus one rerun after that check failed. */
export const WORKER_CHECK_HOST_RUN_LIMIT = 2;
export const WORKER_CHECK_HOST_BUDGET_REFUSAL =
  'Check-host budget exhausted: this attempt already used its one check and one rerun. Finish the outcome and return success or a blocker.';

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
    return readdirSync(directory).filter((name) => /^[1-9]\d*$/.test(name)).length;
  } catch {
    return 0;
  }
}

export type WorkerCheckHostAdmit = {
  directory?: string | undefined;
  limit?: string | number | null | undefined;
};

/**
 * Record one check-host wrapper request for this attempt. Missing controller state does not invent a budget.
 * A third request is refused before the caller reserves a host.
 */
export function admitWorkerCheckHostRun(
  input: WorkerCheckHostAdmit,
): { ok: true; used: number } | { ok: false; used: number; message: string } {
  const directory = input.directory?.trim();
  if (!directory) return { ok: true, used: 0 };
  const exempt = input.limit === 'off' || input.limit === null;
  mkdirSync(directory, { recursive: true });
  for (;;) {
    const used = workerCheckHostRunsUsed(directory);
    if (!exempt && used >= WORKER_CHECK_HOST_RUN_LIMIT)
      return { ok: false, used, message: WORKER_CHECK_HOST_BUDGET_REFUSAL };
    try {
      writeFileSync(join(directory, String(used + 1)), '', { flag: 'wx' });
      return { ok: true, used: used + 1 };
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
}
