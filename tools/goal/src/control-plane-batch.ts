import { createHash } from 'node:crypto';
import type { ControlPlaneBatchManifest, ControlPlaneBatchResult, LandingRequest } from './contracts.ts';
import type { SqliteLandingQueue } from './land.ts';
import { assertManagerLandingEvidence, requestManagerLanding } from './manager-landing.ts';
import { git } from './merge.ts';
import type { MergeTrain } from './merge-train.ts';
import { authenticatedManager } from './priority-authority.ts';
import type { WorkerStore } from './store.ts';

/** Strict receiving boundary. A manifest cannot supply requests, commands, scope or gate evidence. */
export function parseControlPlaneBatchManifest(value: unknown): ControlPlaneBatchManifest {
  if (!value || typeof value !== 'object') throw new Error('Expected a control-plane batch manifest');
  const input = value as ControlPlaneBatchManifest;
  if (input.version !== 1 || typeof input.managerId !== 'string' || !input.managerId ||
      !Array.isArray(input.members) || !input.members.length)
    throw new Error('A batch requires version 1, a managerId and nonempty members');
  const tasks = new Set<string>();
  for (const member of input.members) {
    if (!member || typeof member.taskId !== 'string' || !member.taskId ||
        !Number.isSafeInteger(member.attempt) || member.attempt < 1 ||
        typeof member.acceptedCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(member.acceptedCommit) ||
        tasks.has(member.taskId)) throw new Error('Invalid or duplicate batch member identity');
    tasks.add(member.taskId);
  }
  return { version: 1, managerId: input.managerId,
    members: input.members.map(({ taskId, attempt, acceptedCommit }) => ({ taskId, attempt, acceptedCommit })) };
}

export function controlPlaneBatchId(manifest: ControlPlaneBatchManifest): string {
  return createHash('sha256').update(JSON.stringify(parseControlPlaneBatchManifest(manifest))).digest('hex');
}

export function assertControlPlaneMember(store: WorkerStore, taskId: string, managerId: string): void {
  const task = store.task(taskId);
  if (task.brief.manager !== managerId || task.brief.goal !== 'control-plane' || task.workspace ||
      task.brief.target === 'stabilize')
    throw new Error(`Task ${taskId} is not an owning manager's control-plane main source`);
}

/** Capture current landing-state requests, never ready-to-start work or historical successes. No task is changed. */
export function captureControlPlaneBatch(
  store: WorkerStore, queue: SqliteLandingQueue, managerId: string, excludedTaskIds: readonly string[] = [], mainBranch = 'main',
): ControlPlaneBatchManifest {
  const members: ControlPlaneBatchManifest['members'][number][] = [];
  for (const task of store.activeTasks()) {
    if (task.state !== 'landing' || task.brief.manager !== managerId || task.brief.goal !== 'control-plane' ||
        task.workspace || task.brief.target === 'stabilize' || excludedTaskIds.includes(task.id)) continue;
    const entry = queue.entry({ taskId: task.id, attempt: task.currentAttempt });
    if (!entry || entry.delivered || entry.outcome || entry.batchId) continue;
    const acceptedCommit = git(task.worktree, 'rev-parse', '--verify', 'HEAD^{commit}');
    assertManagerLandingEvidence({ ...entry.request, managerLanding: {
      managerId, acceptedCommit, acceptanceCommand: task.brief.acceptance.command,
    } }, store, { allowNoDeltaOn: git(task.worktree, 'rev-parse', `refs/heads/${mainBranch}^{commit}`) });
    members.push({ taskId: task.id, attempt: task.currentAttempt, acceptedCommit });
  }
  return parseControlPlaneBatchManifest({ version: 1, managerId, members });
}

/** Authenticate the manager's persisted provider session before granting any landing authority. */
export async function receiveControlPlaneBatch(
  input: unknown,
  runtime: { store: WorkerStore; queue: SqliteLandingQueue; train: MergeTrain; mainBranch?: string; landing(taskId: string): LandingRequest },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneBatchResult> {
  const manifest = parseControlPlaneBatchManifest(input);
  const manager = authenticatedManager(runtime.store.db, env);
  if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT || !manager || manager.id !== manifest.managerId)
    throw new Error('An authenticated owning control-plane manager session is required');
  // Preflight all selected identities before upgrading any authorization. The train fences them again at publication.
  for (const member of manifest.members) {
    assertControlPlaneMember(runtime.store, member.taskId, manager.id);
    const task = runtime.store.task(member.taskId);
    runtime.store.assertCurrent(member);
    const entry = runtime.queue.entry(member);
    if (!entry) throw new Error(`Missing current landing request for ${member.taskId}`);
    if (entry.request.managerLanding?.acceptedCommit && entry.request.managerLanding.acceptedCommit !== member.acceptedCommit)
      throw new Error(`Accepted source moved for ${member.taskId}`);
    assertManagerLandingEvidence({ ...entry.request, managerLanding: {
      managerId: manager.id, acceptedCommit: member.acceptedCommit, acceptanceCommand: task.brief.acceptance.command,
    } }, runtime.store, { allowIntegrated: true,
      allowNoDeltaOn: git(task.worktree, 'rev-parse', `refs/heads/${runtime.mainBranch ?? 'main'}^{commit}`) });
  }
  for (const member of manifest.members)
    requestManagerLanding(member.taskId, manager.id, runtime.store, runtime.queue, runtime.landing, {
      allowNoDeltaOn: git(runtime.store.task(member.taskId).worktree, 'rev-parse', `refs/heads/${runtime.mainBranch ?? 'main'}^{commit}`),
    });
  return runtime.train.releaseControlPlaneBatch(manifest);
}
