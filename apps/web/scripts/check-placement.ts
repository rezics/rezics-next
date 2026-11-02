import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hostsLocation, mainCheckout, onCheckHost, type StackRun } from '../../../scripts/stack-run.ts';
import {
  createWebCheckPrivateFiles,
  disposeWebCheckEnvironmentInput,
  runPreparedWebCheck,
  webCheckCustodyRuntime,
  type WebCheckCustodyRuntime,
  type WebCheckPrivateFiles,
} from './check-placement-custody.ts';

const root = resolve(import.meta.dir, '../../..');
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export const localStorybookPublicationRevisionEnvironment = 'WEB_STORYBOOK_LOCAL_PUBLICATION_REVISION';

export class WebCheckFailure extends Error {
  constructor(
    public readonly code: number,
    label: string,
  ) {
    super(`${label} failed with status ${code}`);
  }
}

export function workspacePath(workspace: string, path: string): string {
  if (/[\0\r\n]/.test(path)) throw new Error('Web check unavailable: invalid workspace path');
  const inside = relative(resolve(workspace), resolve(workspace, path));
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error(`Web check unavailable: path must be inside the candidate workspace: ${path}`);
  // Reject symlink escapes, including destinations whose final components do not exist yet.
  let ancestor = resolve(workspace, path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const physical = relative(realpathSync(workspace), realpathSync(ancestor));
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical))
    throw new Error(`Web check unavailable: path escapes the candidate workspace: ${path}`);
  return inside.split(sep).join('/');
}

/** Actual run location, never a remote/slot/memory environment marker. */
export function hasWebCheckCustody(workspace = root, cwd = workspace): boolean {
  const physicalRoot = realpathSync(workspace);
  const physicalCwd = realpathSync(cwd);
  const inside = relative(physicalRoot, physicalCwd);
  return (
    onCheckHost(physicalRoot) &&
    onCheckHost(physicalCwd) &&
    inside !== '..' &&
    !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside)
  );
}

export function requireWebCheckCustody(workspace = root, cwd = workspace): void {
  if (!hasWebCheckCustody(workspace, cwd))
    throw new Error(
      'Web check unavailable: this callable browser/check worker requires an actual remote run directory; use its routed script entrypoint.',
    );
}

// Transport controls belong to the driver, not the native command's semantic overlay.
const transportEnvironment = /^(?:GOAL_|CODEX_|KERNEL_CHECK_|REMOTE_CHECK_|REZICS_CHECK_|REZICS_STACK_)/;
const credentialEnvironment = /^(?:CLOUDFLARE_|CF_|AWS_|GH_|GITHUB_|OPENAI_|ANTHROPIC_)/;
const hostEnvironment = new Set([
  'PATH',
  'HOME',
  'PWD',
  'OLDPWD',
  'SHELL',
  'SHLVL',
  '_',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'BUN_INSTALL',
  'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
  'BUN_INSTALL_CACHE_DIR',
  'NODE_PATH',
  // The ambient Nix trust bundle belongs to the local host, not the native check environment.
  'NIX_SSL_CERT_FILE',
  // Ambient host tooling paths are not dependencies of the native Web command.
  'DEBUGINFOD_IMA_CERT_PATH',
  'MOZ_GMP_PATH',
  'NVM_DIR',
  'NVM_BIN',
  'NVM_INC',
  // Desktop and shell session discovery must use the receiving host's own tools.
  'EDITOR',
  'VISUAL',
  'PAGER',
  'GPG_TTY',
  'KDEDIRS',
  'MAIL',
  'MEMORY_PRESSURE_WATCH',
  'NIX_PROFILES',
  'SSH_ASKPASS',
  'TMUX',
  'XDG_DATA_DIRS',
  'ZSH',
  'KERNEL_CHECK_REMOTE',
  'KERNEL_CHECK_ON_REMOTE',
  'WEB_CHECK_DRIVER_ROOT',
  localStorybookPublicationRevisionEnvironment,
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'BUN_AUTH_TOKEN',
]);
const relocatedPaths = new Set(['STORYBOOK_OUTPUT_DIR', 'GROWTH_PROFILE', 'WEB_TEST_STATE_DIR', 'WEB_CHECK_EVENTS']);

export function webCheckEnvironment(env: NodeJS.ProcessEnv, workspace: string, cwd: string): Record<string, string> {
  const semantic: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      value === undefined ||
      transportEnvironment.test(name) ||
      credentialEnvironment.test(name) ||
      hostEnvironment.has(name)
    )
      continue;
    if (relocatedPaths.has(name) && value) {
      const path = workspacePath(workspace, resolve(cwd, value));
      semantic[name] = relative(cwd, resolve(workspace, path)) || '.';
    } else {
      // Login profiles export host paths (Fedora's debuginfod and Mozilla plugin paths, nvm); they mean nothing on a
      // check host, so drop them instead of refusing the check.
      // Mirror the check runner: an absolute value outside the workspace, or one that is not a declared path, is a
      // host setting and is dropped on both sides so their relocated environments agree.
      if (isAbsolute(value)) {
        const inside = relative(workspace, resolve(value));
        const pathLike = /(?:_FILE|_DIR|_PATH|_ROOT)$/.test(name);
        if (!pathLike || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) continue;
      }
      if (['NODE_OPTIONS', 'BUN_OPTIONS'].includes(name) && value)
        throw new Error(`Web check unavailable: unsupported host-path environment setting ${name}`);
      semantic[name] = value;
    }
  }
  return semantic;
}

export type DriverInput = {
  driverRoot: string;
  hosts: string;
  workspace: string;
  cwd: string;
  revision: string;
  environmentFile: string;
  command: readonly string[];
  returns: readonly string[];
};

/** The agreed Performance CLI; original argv remains individual, ordered tokens. */
export function webCheckDriverCommand(input: DriverInput): string[] {
  if (!/^[a-f0-9]{40}$/.test(input.revision))
    throw new Error('Web check unavailable: full candidate revision required');
  if (![input.driverRoot, input.hosts, input.workspace, input.environmentFile].every(isAbsolute))
    throw new Error('Web check unavailable: driver, hosts, workspace and environment file must be absolute');
  if (resolve(input.driverRoot) === resolve(input.workspace))
    throw new Error('Web check unavailable: the trusted driver must be separate from candidate source');
  if (!input.command.length) throw new Error('Web check unavailable: empty command');
  return [
    'bun',
    join(input.driverRoot, 'scripts/check-run.ts'),
    '--hosts',
    input.hosts,
    '--workspace',
    input.workspace,
    '--cwd',
    input.cwd,
    '--source-revision',
    input.revision,
    '--env-file',
    input.environmentFile,
    ...input.returns.flatMap((path) => ['--returns', path]),
    '--',
    ...input.command,
  ];
}

function git(directory: string, args: string[]): string {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function commonGitDirectory(directory: string, label: string): string {
  const result = spawnSync('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`Web check unavailable: cannot resolve the ${label} common Git directory`);
  if (result.status !== 0) throw new Error(`Web check unavailable: cannot resolve the ${label} common Git directory`);
  try {
    return realpathSync(result.stdout.trim());
  } catch {
    throw new Error(`Web check unavailable: the ${label} common Git directory is unavailable`);
  }
}

function canonicalDevRevision(commonDirectory: string): string {
  const result = spawnSync('git', ['--git-dir', commonDirectory, 'rev-parse', '--verify', 'refs/heads/dev^{commit}'], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      'Web check unavailable: canonical refs/heads/dev is absent from the candidate common Git directory',
    );
  return result.stdout.trim();
}

/** Selects only a clean snapshot in the candidate's repository that is integrated into canonical dev. */
export function trustedDriver(workspace: string, env: NodeJS.ProcessEnv): string {
  const candidateCommon = commonGitDirectory(workspace, 'candidate');
  // Read this canonical ref once from the shared repository; the main checkout may lag behind it.
  const devRevision = canonicalDevRevision(candidateCommon);
  const fallback = env.WEB_CHECK_DRIVER_ROOT ? undefined : mainCheckout(workspace);
  const requestedRoot = env.WEB_CHECK_DRIVER_ROOT ?? fallback;
  if (!requestedRoot) throw new Error('Web check unavailable: no Performance driver snapshot was selected');
  let driverRoot: string;
  try {
    driverRoot = realpathSync(requestedRoot);
  } catch {
    throw new Error('Web check unavailable: the selected Performance driver snapshot is missing');
  }
  if (driverRoot === realpathSync(workspace))
    throw new Error('Web check unavailable: the trusted driver must be separate from candidate source');
  const driverCommon = commonGitDirectory(driverRoot, 'Performance driver');
  if (driverCommon !== candidateCommon)
    throw new Error('Web check unavailable: the Performance driver must share the candidate common Git repository');
  const file = join(driverRoot, 'scripts/check-run.ts');
  if (!existsSync(file)) throw new Error('Web check unavailable: integrated scripts/check-run.ts is absent');
  // Do not import a live producer edit, including edits to its helper imports.
  if (git(driverRoot, ['status', '--porcelain', '--untracked-files=normal']))
    throw new Error('Web check unavailable: the trusted Performance checkout must be clean');
  git(driverRoot, ['ls-files', '--error-unmatch', 'scripts/check-run.ts']);
  const producerRevision = git(driverRoot, ['rev-parse', 'HEAD']);
  const ancestry = spawnSync('git', [
    '--git-dir',
    candidateCommon,
    'merge-base',
    '--is-ancestor',
    producerRevision,
    devRevision,
  ]);
  if (ancestry.error) throw ancestry.error;
  if (ancestry.status !== 0)
    throw new Error('Web check unavailable: the selected Performance snapshot is not integrated into canonical dev');
  const committed = spawnSync('git', ['-C', driverRoot, 'show', 'HEAD:scripts/check-run.ts']);
  if (committed.status !== 0 || !committed.stdout.equals(readFileSync(file)))
    throw new Error('Web check unavailable: Performance driver differs from its committed source');
  return driverRoot;
}

export type DriverExecution = {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

async function executeDriver(input: DriverExecution): Promise<number> {
  if (input.signal?.aborted) return 143;
  const fd = input.env.REMOTE_CHECK_RECEIPT_FD;
  const nonce = input.env.REMOTE_CHECK_RECEIPT_NONCE;
  if ((fd !== undefined || nonce !== undefined) && (fd !== '3' || !nonce))
    throw new Error('Invalid remote-check receipt channel');
  const child = spawn(input.command[0]!, input.command.slice(1), {
    cwd: input.cwd,
    env: input.env,
    stdio: fd === '3' ? ['inherit', 'inherit', 'inherit', 3] : 'inherit',
  });
  const forwarders = signals.map((signal) => {
    const forward = () => {
      child.kill(signal);
    };
    process.on(signal, forward);
    return [signal, forward] as const;
  });
  const cancel = () => {
    child.kill('SIGTERM');
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();
  try {
    // The driver owns queued cancellation, physical settlement, receipts and returns. Never replay it locally.
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 75)));
    });
  } finally {
    input.signal?.removeEventListener('abort', cancel);
    for (const [signal, forward] of forwarders) process.off(signal, forward);
  }
}

export type WebPlacementRuntime = {
  custody: (workspace: string, cwd: string) => boolean;
  driver: (workspace: string, env: NodeJS.ProcessEnv) => string;
  hosts: (workspace: string, env: NodeJS.ProcessEnv) => string;
  revision: (workspace: string) => string;
  isTreeClean: (workspace: string) => boolean;
  environment: (values: Record<string, string>) => WebCheckPrivateFiles;
  receiver: WebCheckCustodyRuntime;
  execute: (input: DriverExecution) => Promise<number>;
};

const runtime: WebPlacementRuntime = {
  custody: hasWebCheckCustody,
  driver: trustedDriver,
  hosts(workspace, env) {
    const located = hostsLocation(workspace, env);
    if ('reason' in located) throw new Error(`Web check unavailable: ${located.reason}`);
    return resolve(located.file);
  },
  revision: (workspace) => git(workspace, ['rev-parse', 'HEAD']),
  isTreeClean: (workspace) => git(workspace, ['status', '--porcelain', '--untracked-files=normal']) === '',
  environment: createWebCheckPrivateFiles,
  receiver: webCheckCustodyRuntime,
  execute: executeDriver,
};

function isLocalStorybookPublicationValidation(command: readonly string[], cwd: string, returnCount: number): boolean {
  if (cwd !== 'apps/web') return false;
  if (command.length === 3 && command[0] === 'bun' && command[1] === 'scripts/storybook-deploy.ts')
    return command[2] === '--validate-only' && returnCount === 1;
  if (command.length !== 2 || command[0] !== 'bun') return false;
  if (command[1] === 'scripts/storybook-build.ts') return returnCount === 1;
  return command[1] === 'scripts/storybook-smoke.ts' && returnCount === 0;
}

function withoutLocalPublicationControl(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env[localStorybookPublicationRevisionEnvironment] === undefined) return env;
  const sanitized = { ...env };
  delete sanitized[localStorybookPublicationRevisionEnvironment];
  return sanitized;
}

/** null means this process may continue under actual check-host custody or an exact local publication grant. */
export async function routeWebCheck(
  run: Pick<StackRun, 'root' | 'cwd' | 'command' | 'returns'>,
  env: NodeJS.ProcessEnv = process.env,
  adapter: WebPlacementRuntime = runtime,
  signal?: AbortSignal,
): Promise<number | null> {
  if (signal?.aborted) return 143;
  const workspace = resolve(run.root);
  const cwd = relative(workspace, resolve(run.cwd)) || '.';
  if (cwd !== '.') workspacePath(workspace, run.cwd);
  const returns = (run.returns ?? []).map((path) => workspacePath(workspace, path));
  if (adapter.custody(workspace, run.cwd)) return null;
  for (const argument of run.command) {
    if (isAbsolute(argument) || /^--[^=]+=\//.test(argument))
      throw new Error(`Web check unavailable: unsupported host-absolute argument ${argument}`);
  }
  const localRevision = env[localStorybookPublicationRevisionEnvironment];
  if (localRevision !== undefined && isLocalStorybookPublicationValidation(run.command, cwd, returns.length)) {
    if (!/^[0-9a-f]{40}$/.test(localRevision))
      throw new Error('Web check unavailable: local Storybook publication requires a full committed revision');
    if (adapter.revision(workspace) !== localRevision)
      throw new Error('Web check unavailable: local Storybook publication revision changed');
    if (!adapter.isTreeClean(workspace))
      throw new Error('Web check unavailable: local Storybook publication requires a clean working tree');
    return null;
  }
  if (env.GROWTH_PROFILE) returns.push(workspacePath(workspace, resolve(run.cwd, env.GROWTH_PROFILE)));
  if (env.WEB_TEST_STATE_DIR) returns.push(workspacePath(workspace, resolve(run.cwd, env.WEB_TEST_STATE_DIR)));
  if (env.WEB_CHECK_EVENTS) returns.push(workspacePath(workspace, resolve(run.cwd, env.WEB_CHECK_EVENTS)));
  const driverRoot = adapter.driver(workspace, env);
  const hosts = adapter.hosts(workspace, env);
  const revision = adapter.revision(workspace);
  const semantic = webCheckEnvironment(env, workspace, run.cwd);
  const file = adapter.environment(semantic);
  try {
    const result = await runPreparedWebCheck(
      {
        driverRoot,
        hostsFile: hosts,
        workspace,
        cwd,
        sourceRevision: revision,
        command: run.command,
        environment: semantic,
        priority: env.REMOTE_CHECK_PRIORITY ?? null,
        returns,
        env: withoutLocalPublicationControl(env),
        files: file,
      },
      adapter.receiver,
      signal,
    );
    if (result.custody === 'occupied')
      console.error(
        `Web check custody remains occupied; reconcile the original descriptor with --descriptor ${result.descriptorFile}`,
      );
    return result.code;
  } catch (error) {
    // A journal is created before prepare dispatch; keep its input whenever caller close is uncertain.
    if (!existsSync(file.recordFile)) {
      try {
        file.close();
      } catch {
        try {
          disposeWebCheckEnvironmentInput(file);
        } catch {
          /* Preserve the original invocation error. */
        }
      }
    }
    throw error;
  }
}

/** StackRun-shaped receiving adapter for existing Web callers, without its historical local fallback. */
export async function placeWebCheck(
  run: StackRun,
  native: (env: Record<string, string>) => Promise<number>,
  env: NodeJS.ProcessEnv = process.env,
  adapter: WebPlacementRuntime = runtime,
): Promise<number> {
  const code = await routeWebCheck(run, env, adapter);
  return code === null ? native({}) : code;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const separator = args.indexOf('--');
    if (separator < 0 || separator % 2 !== 0)
      throw new Error('Usage: check-placement.ts [--returns <path>]... -- <command...>');
    const returns: string[] = [];
    for (let i = 0; i < separator; i += 2) {
      if (args[i] !== '--returns' || !args[i + 1]) throw new Error('Expected --returns <workspace-relative-path>');
      returns.push(args[i + 1]!);
    }
    const command = args.slice(separator + 1);
    if (separator < 0 || !command.length)
      throw new Error('Usage: check-placement.ts [--returns <path>]... -- <command...>');
    const run = { root, cwd: process.cwd(), command, returns };
    const code = await routeWebCheck(run);
    process.exitCode = code ?? (await executeDriver({ command, cwd: run.cwd, env: process.env }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 75;
  }
}
