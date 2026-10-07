import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function appHostSourceHash(root: string): string {
  const digest = createHash('sha256');
  for (const path of ['apphost/apphost.mts', 'scripts/dev/refresh.ts'])
    digest.update(readFileSync(join(root, path)));
  return digest.digest('hex');
}

/** These directories are private to the stack. Never check out over a serving
 * process: even without watch, a lazy import could read the newly merged code. */
export function backendPointer(stack: string): string {
  return join(stack, 'backend');
}

export function activeBackend(stack: string): string | undefined {
  const pointer = backendPointer(stack);
  return existsSync(pointer) ? readlinkSync(pointer) : undefined;
}

export function activateBackend(stack: string, checkout: string, name = 'backend'): void {
  const pointer = join(stack, name);
  rmSync(`${pointer}.tmp`, { force: true });
  symlinkSync(checkout, `${pointer}.tmp`, 'dir');
  renameSync(`${pointer}.tmp`, pointer);
}

/** Storage is reconciled less often than code. Its original Compose bind paths
 * remain stable across code-only refreshes. */
export function storageBackend(stack: string): string | undefined {
  const pointer = join(stack, 'storage-backend');
  return existsSync(pointer) ? readlinkSync(pointer) : activeBackend(stack);
}

export function syncBackendInputs(root: string, checkout: string): void {
  const overrides = join(root, '.env.dev');
  if (existsSync(overrides)) cpSync(overrides, join(checkout, '.env.dev'));
  else rmSync(join(checkout, '.env.dev'), { force: true });
  const identities = join(root, '.temp/datasets');
  if (!existsSync(identities)) return;
  mkdirSync(join(checkout, '.temp/datasets'), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(identities)) {
    if (/^administrator-[a-f0-9]+\.json$/.test(name))
      cpSync(join(identities, name), join(checkout, '.temp/datasets', name));
  }
}

/** Keep the executable and storage revisions; older dependency copies no longer
 * participate in recovery once their successor's checkpoint has committed. */
export function pruneBackendRevisions(
  root: string,
  stack: string,
  command: BackendCommand = backendCommand,
): void {
  const retained = new Set([activeBackend(stack), storageBackend(stack)]);
  const revisions = join(stack, 'backend-revisions');
  for (const name of readdirSync(revisions)) {
    if (!/^[a-f0-9]{40,64}$/.test(name)) continue;
    const checkout = join(revisions, name);
    if (!retained.has(checkout)) command(root, 'git', ['worktree', 'remove', '--force', checkout]);
  }
}

export type BackendCommand = (root: string, executable: string, args: string[]) => string;
export const backendCommand: BackendCommand = (root, executable, args) => {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Backend ${executable} ${args[0]} failed (exit ${result.status ?? 'timeout/error'})`,
    );
  return result.stdout.trim();
};

/** Model alignment's small intent/audit checkpoints survive executable revisions.
 * This is metadata, not a copy of owner data, and lets a newer code fix resume
 * the same generation's lost-response finalization. */
export function linkBackendModelJournal(checkout: string, stack: string): void {
  const shared = join(stack, 'model-bootstrap');
  const local = join(checkout, '.temp/datasets/model-bootstrap');
  mkdirSync(shared, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(local), { recursive: true, mode: 0o700 });
  if (existsSync(local)) {
    try { if (readlinkSync(local) === shared) return; }
    catch { /* An older checkout used a private metadata directory. */ }
    cpSync(local, shared, { recursive: true });
    rmSync(local, { recursive: true, force: true });
  }
  symlinkSync(shared, local, 'dir');
}

/** Reuse a lockfile-identical dependency tree by reflink/copy, preserving the
 * relative workspace links. A symlink to the live checkout's dependencies would
 * let the next install change the serving revision. */
export function stageBackend(
  root: string,
  stack: string,
  revision: string,
  command: BackendCommand = backendCommand,
): string {
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error('Backend revision must be a full Git commit ID');
  const checkout = join(stack, 'backend-revisions', revision);
  const ready = join(checkout, '.temp/backend-ready');
  if (existsSync(ready)) { linkBackendModelJournal(checkout, stack); return checkout; }
  if (existsSync(checkout) && activeBackend(stack) === checkout)
    throw new Error(
      'Active backend artifacts are incomplete; refuse to replace a serving checkout',
    );
  if (existsSync(checkout)) command(root, 'git', ['worktree', 'remove', '--force', checkout]);
  if (!existsSync(checkout)) {
    mkdirSync(dirname(checkout), { recursive: true });
    command(root, 'git', ['worktree', 'add', '--detach', checkout, revision]);
  }
  const source = activeBackend(stack) ?? root;
  const paths = ['ls-files', 'yarn.lock', '.yarnrc.yml', '*package.json', '.yarn/patches/*'];
  const dependencyInputs = [
    ...new Set([
      ...command(checkout, 'git', paths).split('\n').filter(Boolean),
      ...command(source, 'git', paths).split('\n').filter(Boolean),
    ]),
  ];
  const reusable =
    existsSync(join(source, 'node_modules')) &&
    dependencyInputs.every(
      (path) =>
        existsSync(join(source, path)) &&
        existsSync(join(checkout, path)) &&
        readFileSync(join(source, path)).equals(readFileSync(join(checkout, path))),
    );
  if (reusable) {
    for (const path of [
      'node_modules',
      ...dependencyInputs
        .filter((path) => path.endsWith('/package.json'))
        .map((path) => join(dirname(path), 'node_modules')),
    ]) {
      if (!existsSync(join(source, path))) continue;
      mkdirSync(dirname(join(checkout, path)), { recursive: true });
      command(root, 'cp', ['-a', '--reflink=auto', join(source, path), join(checkout, path)]);
    }
  } else command(checkout, 'task', ['install']);
  command(checkout, 'task', ['gen']);
  mkdirSync(join(checkout, '.temp/stack'), { recursive: true });
  symlinkSync(stack, join(checkout, '.temp/stack/rezics-dev'), 'dir');
  syncBackendInputs(root, checkout);
  linkBackendModelJournal(checkout, stack);
  // Mark only complete preparations; a failed install/gen is rebuilt on retry.
  writeFileSync(ready, revision);
  return checkout;
}

export interface PendingRefresh {
  revision: string;
  backend: string;
  storage: string;
  pid: number;
  refreshId: string;
  mutatingStep?: 'prepare-storage' | 'align-model' | 'approve-zones';
}

export function readPendingRefresh(stack: string): PendingRefresh | undefined {
  const path = join(stack, 'refresh-pending');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PendingRefresh) : undefined;
}

/** A failed forward-only maintenance turn keeps its target selected. AppHost
 * declares its writers with explicit start until refresh completes the retry. */
export function ensureBackend(
  root: string,
  stack: string,
  command: BackendCommand = backendCommand,
): string {
  const pending = readPendingRefresh(stack);
  const checkpointPath = join(stack, 'refresh.json');
  const checkpoint = existsSync(checkpointPath)
    ? (JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
        revision: string;
        refreshId?: string;
      })
    : undefined;
  const committed = pending && checkpoint?.refreshId === pending.refreshId;
  if (pending && !committed) {
    try {
      process.kill(pending.pid, 0);
      throw new Error('A backend refresh is running; startup cannot change its revision');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const revision =
    pending?.mutatingStep && !committed
      ? pending.revision
      : (checkpoint?.revision ??
        command(pending?.backend ?? activeBackend(stack) ?? root, 'git', ['rev-parse', 'HEAD']));
  const checkout = stageBackend(root, stack, revision, command);
  syncBackendInputs(root, checkout);
  activateBackend(stack, checkout);
  if (!existsSync(join(stack, 'storage-backend')))
    activateBackend(stack, checkout, 'storage-backend');
  if (!pending?.mutatingStep || committed) rmSync(join(stack, 'refresh-pending'), { force: true });
  return backendPointer(stack);
}

export function backendExecutable(
  mode: string,
  stack: string,
  preload: string,
  entry: string,
): {
  executable: string;
  args: string[];
} {
  return mode === 'main'
    ? {
        executable: 'sh',
        args: [
          '-c',
          'set -e; cd "$1"; shift; exec bun "$@"',
          'backend',
          backendPointer(stack),
          '--preload',
          preload,
          entry,
        ],
      }
    : {
        executable: 'bun',
        args: ['--preload', preload, ...(entry.endsWith('/relay.ts') ? [] : ['--watch']), entry],
      };
}

export const refreshResources = ['account', 'main', 'main-relay'] as const;
export type RefreshResource = typeof refreshResources[number];
export type RefreshStep = 'build-image' | 'rehearse-migrations' | 'switch-backend'
  | 'stop-writers' | 'prepare-storage' | 'align-model'
  | 'restart-resources' | 'wait-ready' | 'approve-zones' | 'record-success';

export const appHostRestartInstruction = 'In the main checkout, run task dev:stop, then task dev, then retry task dev:refresh';

export class AppHostResourceLost extends Error {
  constructor(resource: string, operation: string) {
    super(`AppHost resource ${resource} is lost (${operation}). ${appHostRestartInstruction}`);
  }
}

export interface OfficialZoneApproval { slug: string; digest: string; approvedDigest: string | null }

export interface RefreshInputs {
  revision: string;
  previousRevision?: string;
  checkpointMissing?: boolean;
  resumeStep?: PendingRefresh['mutatingStep'];
  imagePresent: boolean;
  storageChanged: boolean;
  pendingMigrations: readonly string[];
  modelCurrent: boolean;
  statementCurrent: boolean;
  membershipCurrent: boolean;
  unhealthyResources: readonly string[];
  environmentChanges: readonly string[];
  appHostChanged: boolean;
  lostResources: readonly string[];
  zoneApprovals: readonly OfficialZoneApproval[];
}

/** A checkpoint is evidence of a completed refresh, never a substitute for live
 * storage, migration, model and resource checks. */
export function refreshPlan(input: RefreshInputs): { steps: RefreshStep[]; blockers: string[] } {
  const blockers: string[] = [];
  if (input.environmentChanges.length) blockers.push(
    `Generated stack environment would change (${input.environmentChanges.join(', ')}). ${appHostRestartInstruction}`,
  );
  if (input.appHostChanged) blockers.push(
    `AppHost topology changed. ${appHostRestartInstruction}`,
  );
  if (input.lostResources.length) blockers.push(
    `AppHost restart required for lost resources: ${input.lostResources.join(', ')}. ${appHostRestartInstruction}`,
  );
  const advance = input.previousRevision !== input.revision ;
  const prepare =
    input.resumeStep === 'prepare-storage' ||
    !input.imagePresent
    || input.storageChanged || input.pendingMigrations.length > 0 || !input.statementCurrent || !input.membershipCurrent;
  const restart = Boolean(input.resumeStep) ||
    advance || prepare || !input.modelCurrent || input.unhealthyResources.length > 0;
  const steps: RefreshStep[] = [];
  if (!input.imagePresent) steps.push('build-image');
  if (input.pendingMigrations.length) steps.push('rehearse-migrations');
  if (restart) steps.push('stop-writers');
  if (prepare) steps.push('prepare-storage');
  if (prepare || !input.modelCurrent|| input.resumeStep === 'align-model') steps.push('align-model');
  if (restart) steps.push('switch-backend', 'restart-resources', 'wait-ready');
  if (!restart && input.zoneApprovals.length) steps.push('wait-ready');
  if (restart || input.zoneApprovals.length) steps.push('approve-zones');
  if (restart || input.zoneApprovals.length|| input.checkpointMissing) steps.push('record-success');
  return { steps, blockers };
}

/** Report names only: configuration values include credentials. */
export function changedEnvironment(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(name => before[name] !== after[name]).sort();
}

export function assertRefreshCheckout(worktree: boolean, branch: string, dirty: boolean): void {
  if (worktree) throw new Error('dev:refresh runs only in the main checkout, never in a worktree');
  if (branch !== 'main' || dirty) throw new Error('dev:refresh requires committed main with no tracked edits');
}

export interface RefreshActions {
  buildImage(): Promise<void>;
  rehearseMigrations(): Promise<void>;
  stopWriters(): Promise<void>;
  beforeMutation(step: NonNullable<PendingRefresh['mutatingStep']>): Promise<void>;
  switchBackend(): Promise<void>;
  restartPrevious(): Promise<void>;
  prepareStorage(): Promise<void>;
  alignModel(): Promise<void>;
  restartResources(): Promise<void>;
  waitReady(): Promise<void>;
  approveZones(beforeMutation: () => Promise<void>): Promise<void>;
  stopAppHost(): Promise<void>;
  recordSuccess(): Promise<void>;
}

/** Storage/model maintenance is forward-only. Once a mutating operation is
 * entered, an error requires stopped writers and an idempotent retry. */
export async function executeRefresh(
  plan: ReturnType<typeof refreshPlan>,
  actions: RefreshActions,
  mutationAlreadyStarted = false,
): Promise<void> {
  if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
  let mutated = mutationAlreadyStarted;
  let stopped = false;
  let failedStep: RefreshStep | undefined;
  const beforeMutation = async (step: NonNullable<PendingRefresh['mutatingStep']>) => {
    await actions.beforeMutation(step);
    mutated = true;
  };
  const operations: Record<RefreshStep, () => Promise<void>> = {
    'build-image': () => actions.buildImage(),
    'rehearse-migrations': () => actions.rehearseMigrations(),
    'stop-writers': () => actions.stopWriters(),
    'switch-backend': () => actions.switchBackend(),
    'prepare-storage': () => actions.prepareStorage(),
    'align-model': () => actions.alignModel(),
    'restart-resources': () => actions.restartResources(),
    'wait-ready': () => actions.waitReady(),
    'approve-zones': () => actions.approveZones(() => beforeMutation('approve-zones')),
    'record-success': () => actions.recordSuccess(),
  };
  try {
    for (const step of plan.steps) {
      failedStep = step;
      if (step === 'stop-writers') stopped = true;
      if (step === 'prepare-storage' || step === 'align-model') await beforeMutation(step);
      await operations[step]();
    }
  } catch (error) {
    const message = `Refresh failed at ${failedStep}: ${error instanceof Error ? error.message : String(error)}`;
    const retry = 'Retry: task dev:refresh -- --wait';
    if (error instanceof AppHostResourceLost) {
      try {
        await actions.stopAppHost();
      } catch {
        throw new Error(
          `${message}. Automatic AppHost shutdown failed; task dev:stop must succeed before restarting. ${retry}`,
          { cause: error },
        );
      }
      throw new Error(
        `${message}. This AppHost was stopped; data volumes were retained${mutated ? '; storage/model may have changed; writers remain stopped' : ''}. ${retry}`,
        {
          cause: error,
        },
      );
    }
    if (mutated) {
      try {
        await actions.stopWriters();
      } catch (stopError) {
        try {
          await actions.stopAppHost();
        } catch {
          throw new Error(
            `${message}. Writers could not be stopped: ${String(stopError)}; task dev:stop must succeed. ${retry}`,
            { cause: error },
          );
        }
      }
      throw new Error(
        `${message}. Storage/model may have changed; writers remain stopped. ${retry}`,
        { cause: error },
      );
    }
    if (stopped) {
      try {
        await actions.restartPrevious();
      } catch (recovery) {
        throw new Error(
          `${message}. Previous backend restart failed: ${String(recovery)}. ${retry}`,
          {
            cause: error,
          },
        );
      }
    }
    throw new Error(`${message}. Previous revision retained. ${retry}`, { cause: error });
  }
}
