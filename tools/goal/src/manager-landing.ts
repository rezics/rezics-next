import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { AttemptRef, LandingRequest } from './contracts.ts';
import { agentAdapter } from './agents.ts';
import type { SqliteLandingQueue } from './land.ts';
import { git } from './merge.ts';
import { reportsSuccess } from './records.ts';
import type { WorkerStore } from './store.ts';

function cleanTrackedTree(cwd: string): void {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim())
    throw new Error('Manager landing requires the accepted worker commit with a clean worktree');
  if (result.status !== 0)
    throw new Error(result.stderr?.trim() || result.error?.message || 'Could not verify the accepted worker tree');
}

/** Validate the durable worker acceptance and commit carried by a manager-owned landing request. */
export function assertManagerLandingEvidence(
  request: LandingRequest,
  store: WorkerStore,
  options: { allowIntegrated?: boolean } = {},
): void {
  const evidence = request.managerLanding;
  if (!evidence) throw new Error('Missing manager landing authorization');
  const task = store.task(request.taskId);
  const ref: AttemptRef = { taskId: request.taskId, attempt: request.attempt };
  store.assertCurrent(ref);
  if (task.brief.manager !== evidence.managerId)
    throw new Error(`Manager ${evidence.managerId} does not own task ${task.id}`);
  if (
    request.attempt !== task.currentAttempt ||
    request.branch !== task.branch ||
    request.worktree !== task.worktree ||
    JSON.stringify(request.declaredPaths) !== JSON.stringify(task.brief.paths) ||
    JSON.stringify(evidence.acceptanceCommand) !== JSON.stringify(task.brief.acceptance.command) ||
    JSON.stringify(request.gate) !== JSON.stringify(task.brief.acceptance.command)
  )
    throw new Error(`Manager landing evidence does not match current task ${task.id}`);

  const alreadyIntegrated = ['integrated', 'merged'].includes(task.state);
  if (alreadyIntegrated && options.allowIntegrated) return;
  if (task.state !== 'landing') throw new Error(`Task ${task.id} is not ready to land (state: ${task.state})`);

  const attempt = store.attempt(ref);
  const record = store.record(ref);
  if (
    attempt.state !== 'exited' ||
    attempt.failureKind ||
    attempt.blocker ||
    attempt.exitCode !== 0 ||
    !reportsSuccess(attempt.result, agentAdapter(attempt.profile.cli)) ||
    !attempt.endedAt ||
    record?.outcome !== 'pending-gate'
  )
    throw new Error(`Task ${task.id} does not have a completed accepted current attempt`);
  if (!task.worktree || !existsSync(task.worktree)) throw new Error(`Task ${task.id} has no worker worktree`);

  const head = git(task.worktree, 'rev-parse', '--verify', 'HEAD^{commit}');
  const branch = git(task.worktree, 'rev-parse', '--verify', `refs/heads/${task.branch}^{commit}`);
  if (head !== branch || head !== evidence.acceptedCommit)
    throw new Error(`Accepted commit for task ${task.id} is stale`);
  try {
    git(task.worktree, 'merge-base', '--is-ancestor', task.base, head);
  } catch {
    throw new Error(`Accepted commit for task ${task.id} is not based on its recorded task base`);
  }
  if (/^0+$/.test(git(task.worktree, 'rev-list', '--count', `${task.base}..${head}`).trim()))
    throw new Error(`Task ${task.id} has no committed work`);
  cleanTrackedTree(task.worktree);
}

/** Queue already accepted work through the ordinary train and sink; no evidence can be supplied by the caller. */
export function requestManagerLanding(
  taskId: string,
  managerId: string,
  store: WorkerStore,
  queue: SqliteLandingQueue,
  landing: (taskId: string) => LandingRequest,
): boolean {
  if (!managerId) throw new Error('Manager authentication is required to use direct landing');
  const task = store.task(taskId);
  if (task.brief.manager !== managerId) throw new Error(`Manager ${managerId} does not own task ${task.id}`);
  if (['integrated', 'merged'].includes(task.state)) return false;
  if (task.currentAttempt <= 0) throw new Error(`Task ${task.id} has no accepted worker attempt`);
  if (task.state !== 'landing') throw new Error(`Task ${task.id} is not ready to land (state: ${task.state})`);
  if (!task.worktree || !existsSync(task.worktree)) throw new Error(`Task ${task.id} has no worker worktree`);

  const ref: AttemptRef = { taskId, attempt: task.currentAttempt };
  store.assertCurrent(ref);
  const acceptedCommit = git(task.worktree, 'rev-parse', '--verify', 'HEAD^{commit}');
  const request = {
    ...landing(taskId),
    managerLanding: {
      managerId,
      acceptedCommit,
      acceptanceCommand: [...task.brief.acceptance.command],
    },
  } satisfies LandingRequest;
  let changed = true;
  store.write(ref, () => {
    assertManagerLandingEvidence(request, store);
    const row = store.db
      .query('SELECT request, outcome, delivered FROM landing_queue WHERE task=? AND attempt=?')
      .get(taskId, ref.attempt) as { request: string; outcome: string | null; delivered: number } | null;
    if (!row) {
      const alreadyRequested = store.events(taskId, ref.attempt).some((event) => event.kind === 'landing-requested');
      if (alreadyRequested) queue.enqueue(request);
      else store.landing(request, (queued) => queue.enqueue(queued));
      store.event(ref, 'manager-landing-authorized', request.managerLanding);
      return;
    }
    if (row.outcome || row.delivered) throw new Error(`Landing for task ${task.id} has already been processed`);
    const previous = JSON.parse(row.request) as LandingRequest;
    if (
      previous.taskId !== request.taskId ||
      previous.attempt !== request.attempt ||
      previous.branch !== request.branch ||
      previous.worktree !== request.worktree ||
      JSON.stringify(previous.declaredPaths) !== JSON.stringify(request.declaredPaths) ||
      JSON.stringify(previous.protectedPaths ?? []) !== JSON.stringify(request.protectedPaths ?? []) ||
      JSON.stringify(previous.gate) !== JSON.stringify(request.gate)
    )
      throw new Error(`Queued landing for task ${task.id} no longer matches its current work`);
    if (previous.managerLanding) {
      if (
        previous.managerLanding.managerId !== managerId ||
        previous.managerLanding.acceptedCommit !== request.managerLanding!.acceptedCommit ||
        JSON.stringify(previous.managerLanding.acceptanceCommand) !==
          JSON.stringify(request.managerLanding!.acceptanceCommand)
      )
        throw new Error(`Landing authorization for task ${task.id} does not match its accepted attempt`);
      changed = false;
      return;
    }
    const updated = store.db
      .query('UPDATE landing_queue SET request=? WHERE task=? AND attempt=? AND delivered=0 AND outcome IS NULL')
      .run(JSON.stringify(request), taskId, ref.attempt);
    if (updated.changes !== 1) throw new Error(`Landing for task ${task.id} changed while the manager authorized it`);
    if (!store.events(taskId, ref.attempt).some((event) => event.kind === 'landing-requested'))
      store.event(ref, 'landing-requested', request);
    store.event(ref, 'manager-landing-authorized', request.managerLanding);
  });
  return changed;
}
