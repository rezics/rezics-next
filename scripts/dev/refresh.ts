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
  if (existsSync(ready)) return checkout;
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
  // Mark only complete preparations; a failed install/gen is rebuilt on retry.
  writeFileSync(ready, revision);
  return checkout;
}

/** Startup uses the last successful refresh, including after the AppHost stops.
 * A fresh stack has no checkpoint yet and starts at its initial committed HEAD. */
export function ensureBackend(
  root: string,
  stack: string,
  command: BackendCommand = backendCommand,
): string {
  if (existsSync(join(stack, 'refresh-recovery')))
    throw new Error(
      `Retained storage recovery snapshot at ${join(stack, 'refresh-recovery')}; recover it before starting the backend`,
    );
  const pending = join(stack, 'refresh-pending');
  let interruptedBackend: string | undefined;
  if (existsSync(pending)) {
    const { pid, backend, phase } = JSON.parse(readFileSync(pending, 'utf8')) as {
      pid: number;
      backend?: string;
      phase?: string;
    };
    interruptedBackend = backend;
    if (phase !== 'committed' && phase !== 'restored') {
      try {
        process.kill(pid, 0);
        throw new Error('A backend refresh is running; startup cannot change its revision');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  const checkpoint = join(stack, 'refresh.json');
  const revision = existsSync(checkpoint)
    ? (JSON.parse(readFileSync(checkpoint, 'utf8')) as { revision: string }).revision
    : interruptedBackend || activeBackend(stack)
      ? command(interruptedBackend ?? activeBackend(stack)!, 'git', ['rev-parse', 'HEAD'])
      : command(root, 'git', ['rev-parse', 'HEAD']);
  const checkout = stageBackend(root, stack, revision, command);
  syncBackendInputs(root, checkout);
  activateBackend(stack, checkout);
  if (!existsSync(join(stack, 'storage-backend')))
    activateBackend(stack, checkout, 'storage-backend');
  cpSync(join(root, 'scripts/dev/refresh.ts'), join(stack, 'backend-gate.ts'));
  rmSync(join(stack, 'refresh-pending'), { force: true });
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
          join(stack, 'backend-gate.ts'),
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

interface GateServeOptions {
  fetch?: (request: Request, server: unknown) => Response | Promise<Response>;
  [key: string]: unknown;
}

/** Public traffic stays fenced until the refresh checkpoint commits. Readiness
 * and the refresh's private seed client can run, without accepting user writes
 * that a failed refresh would erase when restoring its owner snapshots. */
export function installBackendGate(): void {
  const stack = process.env.REZICS_BACKEND_STACK;
  const runtime = (
    globalThis as unknown as { Bun?: { serve: (options: GateServeOptions) => unknown } }
  ).Bun;
  if (stack && runtime) {
    const serve = runtime.serve;
    runtime.serve = (options) => {
      let fetch = options.fetch;
      const fenced = (next: GateServeOptions) => {
        fetch = next.fetch ?? fetch;
        if (!fetch) throw new Error('Pinned backend requires a Bun fetch handler');
        const handler = fetch;
        // Elysia promotes routes with server.reload after startup. Its ordinary
        // fetch handler covers those routes; keep every request behind the fence.
        return {
          ...next,
          routes: {},
          fetch: (request: Request, server: unknown) => {
            const pending = join(stack, 'refresh-pending');
            if (existsSync(pending)) {
              const { token, phase } = JSON.parse(readFileSync(pending, 'utf8')) as {
                token: string;
                phase?: string;
              };
              const path = new URL(request.url).pathname;
              if (
                phase !== 'committed' &&
                phase !== 'restored' &&
                !['/health/ready', '/health/live'].includes(path) &&
                request.headers.get('x-rezics-refresh') !== token
              )
                return new Response('Backend refresh in progress', {
                  status: 503,
                  headers: { 'Retry-After': '1' },
                });
            }
            return handler.call(next, request, server);
          },
        };
      };
      const server = serve.call(runtime, fenced(options)) as {
        reload: (options: GateServeOptions) => unknown;
      };
      const reload = server.reload;
      server.reload = (next) => reload.call(server, fenced(next));
      return server;
    };
  }
  const token = process.env.REZICS_REFRESH_GATE_TOKEN;
  if (token || stack) {
    const fetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (['127.0.0.1', 'localhost', '[::1]'].includes(new URL(request.url).hostname)) {
        // Main still needs Account introspection/JWKS while both public
        // listeners are fenced. The same private token accompanies that hop.
        const pending = stack && join(stack, 'refresh-pending');
        const current =
          token ??
          (pending && existsSync(pending)
            ? (JSON.parse(readFileSync(pending, 'utf8')) as { token: string }).token
            : undefined);
        if (current) request.headers.set('x-rezics-refresh', current);
      }
      return fetch(request);
    }) as typeof globalThis.fetch;
  }
}

installBackendGate();

export const refreshResources = ['account', 'main', 'main-relay'] as const;
export type RefreshResource = typeof refreshResources[number];
export type RefreshStep = 'build-image' | 'rehearse-migrations' | 'snapshot-storage'
  | 'switch-backend'
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
    !input.imagePresent
    || input.storageChanged || input.pendingMigrations.length > 0 || !input.statementCurrent || !input.membershipCurrent;
  const restart = advance || prepare || !input.modelCurrent || input.unhealthyResources.length > 0;
  const steps: RefreshStep[] = [];
  if (!input.imagePresent) steps.push('build-image');
  if (input.pendingMigrations.length) steps.push('rehearse-migrations');
  if (restart) steps.push('stop-writers');
  if (prepare|| !input.modelCurrent) steps.push('snapshot-storage');
  if (prepare) steps.push('prepare-storage');
  if (prepare || !input.modelCurrent) steps.push('align-model');
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
  snapshotStorage(): Promise<void>;
  switchBackend(): Promise<void>;
  rollbackPrevious(): Promise<void>;
  prepareStorage(): Promise<void>;
  alignModel(): Promise<void>;
  restartResources(): Promise<void>;
  waitReady(): Promise<void>;
  approveZones(): Promise<void>;
  stopAppHost(): Promise<void>;
  recordSuccess(): Promise<void>;
}

/** Ordinary failures restore the previous revision and its stopped-storage snapshot. A lost orchestration
 * resource instead shuts down this AppHost, avoiding partially stopped writers. */
export async function executeRefresh(
  plan: ReturnType<typeof refreshPlan>,
  actions: RefreshActions,
): Promise<void> {
  if (plan.blockers.length) throw new Error(plan.blockers.join('\n'));
  const operations: Record<RefreshStep, () => Promise<void>> = {
    'build-image': () => actions.buildImage(),
    'rehearse-migrations': () => actions.rehearseMigrations(),
    'stop-writers': () => actions.stopWriters(),
    'snapshot-storage': () => actions.snapshotStorage(),
    'switch-backend': () => actions.switchBackend(),
    'prepare-storage': () => actions.prepareStorage(),
    'align-model': () => actions.alignModel(),
    'restart-resources': () => actions.restartResources(),
    'wait-ready': () => actions.waitReady(),
    'approve-zones': () => actions.approveZones(),
    'record-success': () => actions.recordSuccess(),
  };
  let stopped = false;
  try {
    for (const step of plan.steps) {
      if (step === 'stop-writers') stopped = true;
      await operations[step]();
    }
  } catch (error) {
    if (error instanceof AppHostResourceLost) {
      try {
        await actions.stopAppHost();
      } catch {
        throw new Error(
          `${error.message}. Automatic AppHost shutdown failed; task dev:stop must succeed before restarting`,
          { cause: error },
        );
      }
      throw new Error(`${error.message}. This AppHost was stopped; data volumes were retained`, {
        cause: error,
      });
    }
    if (stopped) {
      try {
        await actions.rollbackPrevious();
      } catch (recovery) {
        throw new Error(`Refresh failed; previous backend recovery failed: ${String(recovery)}`, {
          cause: error,
        });
      }
    }
    throw error;
  }
}
