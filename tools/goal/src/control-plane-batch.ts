import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ControlPlaneBatchManifest,
  ControlPlaneBatchResult,
  ControlPlaneBatchRefContinuation,
  ControlPlaneBatchSupersession,
  ControlPlaneBatchSupersessionResult,
  ControlPlaneBatchDevHandoff,
  ControlPlaneBatchDevHandoffRequest,
  ControlPlaneBatchSource,
  ControlPlaneScopeApprovalRequest,
  ControlPlaneScopeApprovalReceipt,
  LandingRequest,
} from './contracts.ts';
import { matchesPath, readRiskOwnership } from './briefs.ts';
import type { SqliteLandingQueue } from './land.ts';
import { assertManagerLandingEvidence, requestManagerLanding } from './manager-landing.ts';
import { git } from './merge.ts';
import type { MergeTrain } from './merge-train.ts';
import { authenticatedManager } from './priority-authority.ts';
import type { WorkerStore } from './store.ts';

type ScopeRuntime = { store: WorkerStore; queue: SqliteLandingQueue; mainBranch?: string; riskAreasFile?: string };
const scopeApprovalEvent = 'control-plane-scope-approved';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** CLI and API share a concrete-file boundary. No caller-provided receipt or permissions are accepted. */
export function parseControlPlaneScopeApproval(value: unknown): ControlPlaneScopeApprovalRequest {
  if (!value || typeof value !== 'object') throw new Error('Expected a control-plane scope approval');
  const input = value as ControlPlaneScopeApprovalRequest;
  const manifest = parseControlPlaneBatchManifest({
    version: input.version,
    managerId: input.managerId,
    members: [{ taskId: input.taskId, attempt: input.attempt, acceptedCommit: input.acceptedCommit }],
  });
  if (
    !/^[0-9a-f]{64}$/.test(input.contractIdentity) ||
    !/^[0-9a-f]{64}$/.test(input.requestIdentity) ||
    !Array.isArray(input.additionalPaths) ||
    !input.additionalPaths.length ||
    input.additionalPaths.length > 32
  )
    throw new Error('Scope approval requires original contract/request identities and concrete additional files');
  const seen = new Set<string>();
  const additionalPaths = input.additionalPaths
    .map((addition: { path: string; reason: string }) => {
      if (
        !addition ||
        typeof addition.path !== 'string' ||
        typeof addition.reason !== 'string' ||
        !addition.reason.trim() ||
        addition.reason.length > 2048 ||
        !/^tools\/goal\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(addition.path) ||
        addition.path.split('/').some((part) => ['.', '..', '.git'].includes(part)) ||
        seen.has(addition.path)
      )
        throw new Error('Additional scope must name unique relative tools/goal files with a justification');
      seen.add(addition.path);
      return { path: addition.path, reason: addition.reason };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    version: 1,
    managerId: manifest.managerId,
    taskId: input.taskId,
    attempt: input.attempt,
    acceptedCommit: input.acceptedCommit,
    contractIdentity: input.contractIdentity,
    requestIdentity: input.requestIdentity,
    additionalPaths,
  };
}

/** Read-only identity capture for the owning receiver; these hashes grant no authority. */
export function controlPlaneScopeApprovalIdentity(
  source: ControlPlaneBatchSource,
  runtime: ScopeRuntime,
): Pick<ControlPlaneScopeApprovalRequest, 'contractIdentity' | 'requestIdentity'> {
  runtime.store.assertCurrent(source);
  const task = runtime.store.task(source.taskId);
  if (readFileSync(task.briefPath, 'utf8') !== task.brief.markdown)
    throw new Error('Scope approval original contract identity changed');
  const raw = runtime.queue.db
    .query('SELECT request FROM landing_queue WHERE task=? AND attempt=?')
    .get(source.taskId, source.attempt) as { request: string } | null;
  if (!raw) throw new Error('Scope approval requires the retained current queue request');
  const frozen = (task as typeof task & { frozenFiles?: { path: string; hash: string }[] }).frozenFiles ?? [];
  return {
    contractIdentity: digest(JSON.stringify({ brief: task.brief, base: task.base, frozen })),
    requestIdentity: digest(raw.request),
  };
}

function assertScopeApprovalFiles(input: ControlPlaneScopeApprovalRequest, runtime: ScopeRuntime): void {
  const task = runtime.store.task(input.taskId);
  const entry = runtime.queue.entry(input);
  const ownership = readRiskOwnership(
    runtime.riskAreasFile ?? join(import.meta.dir, '../risk-areas.json'),
    runtime.store.policy.brief,
  );
  const protectedPaths = [
    ...(entry?.request.protectedPaths ?? []),
    ...Object.entries(ownership.areas)
      .filter(([area]) => !task.brief.riskAreas.includes(area))
      .flatMap(([, paths]) => paths),
  ];
  const frozen = new Set(
    runtime.store
      .tasks()
      .flatMap(
        (owner) =>
          (owner as typeof owner & { frozenFiles?: { path: string }[] }).frozenFiles?.map((file) => file.path) ?? [],
      ),
  );
  const changed = new Set(
    git(task.worktree, 'diff', '--name-only', '--no-renames', '-z', task.base, input.acceptedCommit)
      .split('\0')
      .filter(Boolean),
  );
  for (const { path } of input.additionalPaths) {
    if (
      matchesPath(path, task.brief.paths, runtime.store.policy.brief) ||
      frozen.has(path) ||
      matchesPath(path, protectedPaths, runtime.store.policy.brief)
    )
      throw new Error(`Scope approval cannot replace declared, frozen or protected authority: ${path}`);
    // ls-tree distinguishes a concrete regular file from a directory, symlink or submodule, including deleted files.
    const object =
      git(task.worktree, 'ls-tree', input.acceptedCommit, '--', path) ||
      git(task.worktree, 'ls-tree', task.base, '--', path);
    if (!changed.has(path) || !/^100(?:644|755) blob [0-9a-f]+\t/.test(object))
      throw new Error(`Scope approval must name an actual changed regular source file: ${path}`);
  }
}

/** Only native rows created below grant scope. A fabricated generic event or request field grants nothing. */
export function controlPlaneScopeApproval(
  source: ControlPlaneBatchSource,
  runtime: ScopeRuntime,
): ControlPlaneScopeApprovalReceipt | undefined {
  const row = runtime.queue.db
    .query('SELECT body FROM landing_scope_approvals WHERE task=? AND attempt=?')
    .get(source.taskId, source.attempt) as { body: string } | null;
  if (!row) return;
  const receipt = JSON.parse(row.body) as ControlPlaneScopeApprovalReceipt;
  const input = parseControlPlaneScopeApproval(receipt);
  const { id, ...body } = receipt;
  const identity = controlPlaneScopeApprovalIdentity(source, runtime);
  if (
    digest(JSON.stringify(body)) !== id ||
    receipt.taskId !== source.taskId ||
    receipt.attempt !== source.attempt ||
    receipt.acceptedCommit !== source.acceptedCommit ||
    receipt.managerId !== runtime.store.task(source.taskId).brief.manager ||
    receipt.actor?.managerId !== receipt.managerId ||
    !receipt.actor.sessionId ||
    !receipt.approvedAt ||
    !isDeepStrictEqual(identity, {
      contractIdentity: receipt.contractIdentity,
      requestIdentity: receipt.requestIdentity,
    }) ||
    !runtime.store
      .events(source.taskId, source.attempt)
      .some((event) => event.kind === scopeApprovalEvent && event.body === row.body)
  )
    throw new Error('Native scope approval identity or audit changed');
  assertControlPlaneMember(runtime.store, source.taskId, receipt.managerId);
  assertScopeApprovalFiles(input, runtime);
  return receipt;
}

/** Authenticated owning manager only. This adds scope, never acceptance, execution authority or a new contract. */
export function receiveControlPlaneScopeApproval(
  value: ControlPlaneScopeApprovalRequest,
  runtime: ScopeRuntime,
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneScopeApprovalReceipt {
  const input = parseControlPlaneScopeApproval(value);
  if (runtime.store.db !== runtime.queue.db) throw new Error('Scope approval requires the shared native store');
  return runtime.store.write(input, () => {
    const actor = authenticatedManager(runtime.store.db, env);
    if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT || !actor || actor.id !== input.managerId)
      throw new Error('Scope approval requires an authenticated owning control-plane manager session');
    assertControlPlaneMember(runtime.store, input.taskId, actor.id);
    const entry = runtime.queue.entry(input);
    const task = runtime.store.task(input.taskId);
    if (!entry || entry.outcome || entry.delivered || entry.candidate || task.integratedCommit || task.mergedCommit)
      throw new Error('Scope approval requires an unprocessed, unpublished current source');
    if (
      !entry.request.managerLanding ||
      entry.request.managerLanding.acceptedCommit !== input.acceptedCommit ||
      (entry.request.workerCommit && entry.request.workerCommit !== input.acceptedCommit)
    )
      throw new Error('Scope approval source differs from the accepted queue source');
    assertManagerLandingEvidence(entry.request, runtime.store, {
      allowNoDeltaOn: git(task.worktree, 'rev-parse', `refs/heads/${runtime.mainBranch ?? 'main'}^{commit}`),
    });
    if (
      !isDeepStrictEqual(controlPlaneScopeApprovalIdentity(input, runtime), {
        contractIdentity: input.contractIdentity,
        requestIdentity: input.requestIdentity,
      })
    )
      throw new Error('Scope approval original contract/request identity changed');
    assertScopeApprovalFiles(input, runtime);
    const existing = controlPlaneScopeApproval(input, runtime);
    if (existing) {
      if (!isDeepStrictEqual(parseControlPlaneScopeApproval(existing), input))
        throw new Error('Conflicting immutable native scope approval');
      return existing;
    }
    const body = {
      ...input,
      actor: { managerId: actor.id, sessionId: actor.sessionId },
      approvedAt: new Date().toISOString(),
    };
    const receipt = { ...body, id: digest(JSON.stringify(body)) };
    runtime.queue.db
      .query('INSERT INTO landing_scope_approvals VALUES (?,?,?)')
      .run(input.taskId, input.attempt, JSON.stringify(receipt));
    runtime.store.event(input, scopeApprovalEvent, receipt);
    return receipt;
  });
}

/** Strict receiving boundary. A manifest cannot supply requests, commands, scope or gate evidence. */
export function parseControlPlaneBatchManifest(value: unknown): ControlPlaneBatchManifest {
  if (!value || typeof value !== 'object') throw new Error('Expected a control-plane batch manifest');
  const input = value as ControlPlaneBatchManifest;
  if (
    input.version !== 1 ||
    typeof input.managerId !== 'string' ||
    !input.managerId ||
    !Array.isArray(input.members) ||
    !input.members.length
  )
    throw new Error('A batch requires version 1, a managerId and nonempty members');
  const tasks = new Set<string>();
  for (const member of input.members) {
    if (
      !member ||
      typeof member.taskId !== 'string' ||
      !member.taskId ||
      !Number.isSafeInteger(member.attempt) ||
      member.attempt < 1 ||
      typeof member.acceptedCommit !== 'string' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(member.acceptedCommit) ||
      (member.readmitFrom !== undefined &&
        (typeof member.readmitFrom !== 'string' || !/^[0-9a-f]{64}$/.test(member.readmitFrom))) ||
      tasks.has(member.taskId)
    )
      throw new Error('Invalid or duplicate batch member identity');
    tasks.add(member.taskId);
  }
  return {
    version: 1,
    managerId: input.managerId,
    members: input.members.map(({ taskId, attempt, acceptedCommit, readmitFrom }) => ({
      taskId,
      attempt,
      acceptedCommit,
      ...(readmitFrom ? { readmitFrom } : {}),
    })),
  };
}

export function controlPlaneBatchId(manifest: ControlPlaneBatchManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(parseControlPlaneBatchManifest(manifest)))
    .digest('hex');
}

export function assertControlPlaneMember(store: WorkerStore, taskId: string, managerId: string): void {
  const task = store.task(taskId);
  if (
    task.brief.manager !== managerId ||
    task.brief.goal !== 'control-plane' ||
    task.workspace ||
    task.brief.target !== 'main'
  )
    throw new Error(`Task ${taskId} is not an owning manager's control-plane main source`);
}

/** Capture current landing-state requests, never ready-to-start work or historical successes. No task is changed. */
export function captureControlPlaneBatch(
  store: WorkerStore,
  queue: SqliteLandingQueue,
  managerId: string,
  excludedTaskIds: readonly string[] = [],
  mainBranch = 'main',
): ControlPlaneBatchManifest {
  const members: ControlPlaneBatchManifest['members'][number][] = [];
  for (const task of store.activeTasks()) {
    if (
      task.state !== 'landing' ||
      task.brief.manager !== managerId ||
      task.brief.goal !== 'control-plane' ||
      task.workspace ||
      task.brief.target !== 'main' ||
      excludedTaskIds.includes(task.id)
    )
      continue;
    const entry = queue.entry({ taskId: task.id, attempt: task.currentAttempt });
    if (!entry || entry.delivered || entry.outcome || entry.batchId) continue;
    const acceptedCommit = git(task.worktree, 'rev-parse', '--verify', 'HEAD^{commit}');
    assertManagerLandingEvidence(
      {
        ...entry.request,
        managerLanding: {
          managerId,
          acceptedCommit,
          acceptanceCommand: task.brief.acceptance.command,
        },
      },
      store,
      { allowNoDeltaOn: git(task.worktree, 'rev-parse', `refs/heads/${mainBranch}^{commit}`) },
    );
    members.push({ taskId: task.id, attempt: task.currentAttempt, acceptedCommit });
  }
  return parseControlPlaneBatchManifest({ version: 1, managerId, members });
}

/** Authenticate the manager's persisted provider session before granting any landing authority. */
function authorizeControlPlaneBatch(
  input: unknown,
  runtime: {
    store: WorkerStore;
    queue: SqliteLandingQueue;
    train: MergeTrain;
    mainBranch?: string;
    landing(taskId: string): LandingRequest;
  },
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneBatchManifest {
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
    if (
      entry.request.managerLanding?.acceptedCommit &&
      entry.request.managerLanding.acceptedCommit !== member.acceptedCommit
    )
      throw new Error(`Accepted source moved for ${member.taskId}`);
    assertManagerLandingEvidence(
      {
        ...entry.request,
        managerLanding: {
          managerId: manager.id,
          acceptedCommit: member.acceptedCommit,
          acceptanceCommand: task.brief.acceptance.command,
        },
      },
      runtime.store,
      {
        allowIntegrated: true,
        allowNoDeltaOn: git(task.worktree, 'rev-parse', `refs/heads/${runtime.mainBranch ?? 'main'}^{commit}`),
      },
    );
  }
  for (const member of manifest.members)
    requestManagerLanding(member.taskId, manager.id, runtime.store, runtime.queue, runtime.landing, {
      allowNoDeltaOn: git(
        runtime.store.task(member.taskId).worktree,
        'rev-parse',
        `refs/heads/${runtime.mainBranch ?? 'main'}^{commit}`,
      ),
    });
  return manifest;
}

export async function receiveControlPlaneBatch(
  input: unknown,
  runtime: Parameters<typeof authorizeControlPlaneBatch>[1],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneBatchResult> {
  return runtime.train.releaseControlPlaneBatch(authorizeControlPlaneBatch(input, runtime, env), env);
}

/** Close an interrupted unpublished draft and transfer claims only; release still needs the full native proof. */
export async function receiveControlPlaneBatchSupersession(
  input: ControlPlaneBatchSupersession,
  runtime: Parameters<typeof authorizeControlPlaneBatch>[1],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneBatchSupersessionResult> {
  authorizeControlPlaneBatch(input.replacement, runtime, env);
  return runtime.train.supersedeControlPlaneBatch(input, env);
}

/** Migration receiver supplies its synchronous native store migration; claims move only after the full main proof. */
export async function receiveControlPlaneBatchDevHandoff(
  input: ControlPlaneBatchDevHandoffRequest,
  runtime: { train: MergeTrain; receiveDev(handoff: ControlPlaneBatchDevHandoff): void },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneBatchDevHandoff> {
  return runtime.train.receiveControlPlaneBatchDevHandoff(input, (handoff) => runtime.receiveDev(handoff), env);
}

/** JSON entry for the existing CLI; validation of physical evidence stays in the native fenced operation. */
export function parseControlPlaneBatchSupersession(input: unknown): ControlPlaneBatchSupersession {
  if (!input || typeof input !== 'object') throw new Error('Expected a control-plane supersession request');
  const value = input as ControlPlaneBatchSupersession;
  if (
    value.version !== 1 ||
    typeof value.previousBatchId !== 'string' ||
    !value.handoff ||
    typeof value.handoff !== 'object' ||
    !Array.isArray(value.changedInputs) ||
    (value.memberMapping !== undefined && !Array.isArray(value.memberMapping))
  )
    throw new Error('Supersession requires version, prior batch, handoff and changed producer inputs');
  return { ...value, replacement: parseControlPlaneBatchManifest(value.replacement) };
}

/** This port grants one fresh stabilized proof, never acceptance or worker retry authority. */
export function parseControlPlaneBatchRefContinuation(value: unknown): ControlPlaneBatchRefContinuation {
  if (!value || typeof value !== 'object') throw new Error('Expected a ref-exhausted continuation');
  const input = value as ControlPlaneBatchRefContinuation;
  const manifest = parseControlPlaneBatchManifest(input.manifest);
  if (
    input.version !== 1 ||
    manifest.members.length !== 1 ||
    manifest.members[0]!.readmitFrom ||
    !/^[0-9a-f]{64}$/.test(input.logHash) ||
    !input.handoff ||
    !/^[0-9a-f]{64}$/.test(input.handoff.journalHash) ||
    !input.handoff.controller ||
    !Array.isArray(input.handoff.ownedCommands) ||
    !input.handoff.evidence?.trim() ||
    !['complete', 'legacy-inventory-unavailable'].includes(input.handoff.inventory ?? 'complete') ||
    'failures' in input.handoff
  )
    throw new Error('Ref continuation requires one exact source, journal/log hashes and verified terminal handoff');
  return { version: 1, manifest, handoff: input.handoff, logHash: input.logHash };
}

export async function receiveControlPlaneBatchRefContinuation(
  input: unknown,
  runtime: { train: MergeTrain },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ControlPlaneBatchResult> {
  return runtime.train.continueControlPlaneBatchRefs(parseControlPlaneBatchRefContinuation(input), env);
}
