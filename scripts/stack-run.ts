/**
 * Places a stack-heavy run on an approved check host. A run already in a confined remote-check cgroup stays there;
 * every other run fails closed when hosts or transport are unavailable.
 *
 * The hosts file is KERNEL_CHECK_REMOTE when that name is non-empty, otherwise the shared file
 * `<main checkout>/.temp/goal/remote-check-hosts.json` when it is readable. The main checkout is the parent of
 * `git rev-parse --git-common-dir`. Kept outputs must use declared workspace-relative return paths.
 *
 * Local/off markers and inherited local leases do not change placement. KERNEL_CHECK_ON_REMOTE alone never decides
 * that a run is already remote.
 *
 * A host runs the same command in a copy of the workspace, with the caller's environment left behind. Stderr says
 * where the run went, and when it is waiting.
 */
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  Aborted,
  executionCancellation,
  executionCancellationFromEnvironment,
  observeExecutionCancellation,
  ownedLocalCommand,
  type ExecutionCancellation,
  readHosts,
  remoteCheck,
  RemoteTransportError,
  REMOTE_TRANSPORT_FAILURE,
  type RemoteCheck,
  validateEstimateMs,
} from './remote-check.ts';
import { hasOutputTreeReturn, outputTreeProfile, withKernelClientOutput } from './check-output-tree.ts';
import { withStackSlot } from './stack-lease.ts';
import {
  captureArtifactReturns,
  clearDeclaredArtifacts,
  registerArtifactDeclarations,
  validateArtifactDeclarations,
  writeArtifactCatalog,
} from './check-artifacts.ts';
import {
  isCheckHostRun,
  isCheckHostRunCandidate,
  performanceHosts,
  recognizeCheckHostRun,
  type CheckHostRecognitionDisposition,
} from './check-placement.ts';

export type StackRun = {
  label: string;
  /** The workspace root; the whole checkout is copied to the host. */
  root: string;
  /** The directory the command runs in, inside the root. */
  cwd: string;
  command: string[];
  cancellation?: ExecutionCancellation;
  /** Host slots the run holds, for a run whose peak memory exceeds a host's per-slot share. Default 1. */
  slots?: number;
  estimateMs?: number;
  /** Called after the host slot is acquired and the remote command is about to start. */
  started?: (host: string) => void;
  /** The run writes files the caller keeps; remote placement requires declared return paths. */
  keepsFiles?: boolean;
  /**
   * Workspace-relative paths copied back after the run, including when it fails. Declaring them means the run does
   * not stay local for the files it writes.
   */
  returns?: string[];
};

type Environment = Record<string, string | undefined>;

const SIGNALS = [
  ['SIGINT', 2],
  ['SIGTERM', 15],
  ['SIGHUP', 1],
] as const;

/** `bun test` options that write files the caller reads or keeps, or that need the caller's Git state. */
const KEEPING_OPTIONS =
  /^(?:--reporter-outfile|--coverage(?:-dir)?|--update-snapshots|-u|--changed|--watch|--hot)(?:=|$)/;

/** Whether the arguments of a `bun test` run ask for files kept on the caller's machine. */
export function testKeepsFiles(args: string[]): boolean {
  return args.some((argument) => KEEPING_OPTIONS.test(argument));
}

const SHARED_HOSTS = join('.temp', 'goal', 'remote-check-hosts.json');

/** A worker carries a task id. An unset or empty id is a person, who may still opt out of a remote run. */
export function isWorker(env: Environment): boolean {
  return Boolean(env.GOAL_TASK_ID);
}

/** The working directory is inside a check host's run directory. Environment variables do not count. */
export function onCheckHost(cwd: string): boolean {
  return isCheckHostRun(cwd);
}

/** Parent of `git rev-parse --git-common-dir` for `root`, or null when `root` is not a checkout. */
export function mainCheckout(root: string): string | null {
  const result = Bun.spawnSync(['git', '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) return null;
  const common = result.stdout.toString().trim();
  return common ? dirname(common) : null;
}

function readable(file: string): boolean {
  try {
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * KERNEL_CHECK_REMOTE when it is non-empty, otherwise the shared hosts file under the main checkout when that file
 * can be read. A non-empty name that cannot be read does not fall back.
 */
export function hostsLocation(root: string, env: Environment): { file: string } | { reason: string } {
  const named = env.KERNEL_CHECK_REMOTE;
  if (named) {
    return readable(named) ? { file: named } : { reason: `the hosts file ${named} is not readable` };
  }
  const main = mainCheckout(root);
  const shared = main ? join(main, SHARED_HOSTS) : undefined;
  if (shared && readable(shared)) return { file: shared };
  return { reason: 'no check host is configured' };
}

export const LOCAL_CONTAINER_REFUSAL =
  'A worker cannot start a local stack container outside an approved remote-check run. ' +
  'Hand the run to `bun run --cwd services/kernel check <files>`, ' +
  '`bun run --cwd services/auth check <files>`, or root `bun test`.';

/**
 * The error a worker must see instead of starting a local stack container outside an approved remote-check run.
 */
export async function workerLocalContainerError(env: Environment, cwd: string): Promise<string | null> {
  if (!isWorker(env) || onCheckHost(cwd)) return null;
  return LOCAL_CONTAINER_REFUSAL;
}

function pollMs(env: Environment): number | undefined {
  const value = env.REMOTE_CHECK_POLL_MS;
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function remoteReason(run: StackRun, env: Environment): string | { hostsFile: string } {
  if (run.keepsFiles && run.returns === undefined) return 'the run keeps files it writes and declares no returns';
  const inside = relative(resolve(run.root), resolve(run.cwd));
  if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
    return 'the directory is outside the workspace';
  const located = hostsLocation(run.root, env);
  if ('reason' in located) return located.reason;
  return { hostsFile: located.file };
}

/**
 * Runs the command on host a or b and returns its exit code. Null means the process is already in an approved remote
 * run directory; it never means an unavailable host may fall back to this machine.
 */
export async function runOnCheckHost(
  run: StackRun,
  env: Environment = process.env,
  runRemote: (options: RemoteCheck, signal: AbortSignal) => Promise<number> = remoteCheck,
  recognize: (cwd: string) => CheckHostRecognitionDisposition = recognizeCheckHostRun,
): Promise<number | null> {
  validateEstimateMs(run.estimateMs);
  const recognition = recognize(run.cwd);
  if (recognition.outcome === 'admitted') {
    console.error(`stack-run: ${run.label} already on an approved remote-check run`);
    return null;
  }
  const checkHostCandidate = isCheckHostRunCandidate(run.cwd);
  if (checkHostCandidate)
    console.error(`stack-run: ${run.label} physical run recognition refused (${recognition.reason})`);
  const cancellation = run.cancellation ?? executionCancellationFromEnvironment(env);
  const cancelled = () => executionCancellation(cancellation);
  const intent = cancelled();
  if (intent) return 128 + intent.signal;
  if (checkHostCandidate) return REMOTE_TRANSPORT_FAILURE;
  const requestedPriority = env.REMOTE_CHECK_PRIORITY;
  if (requestedPriority !== undefined && requestedPriority !== 'landing' && requestedPriority !== 'critical') {
    throw new Error(`REMOTE_CHECK_PRIORITY must be landing or critical when set, received ${requestedPriority}`);
  }
  const priority = requestedPriority === 'landing' && isWorker(env) ? undefined : requestedPriority;
  if (requestedPriority === 'landing' && isWorker(env)) {
    console.error('stack-run: worker environment ignores REMOTE_CHECK_PRIORITY=landing');
  }
  let profile: string | undefined;
  let priorProfile: Buffer | undefined;
  if (env.GROWTH_PROFILE) {
    const root = resolve(run.root);
    const absolute = resolve(process.cwd(), env.GROWTH_PROFILE);
    const path = relative(root, absolute);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new Error(`Usage error: GROWTH_PROFILE path is outside the run root: ${env.GROWTH_PROFILE}`);
    profile = path || '.';
    const profileFile = join(root, profile);
    if (existsSync(profileFile)) priorProfile = readFileSync(profileFile);
  }
  const reason = remoteReason(run, env);
  if (typeof reason === 'string') {
    if (reason === 'no check host is configured' || reason.startsWith('the hosts file ')) {
      console.error(`stack-run: ${run.label} unavailable: ${reason}`);
      return REMOTE_TRANSPORT_FAILURE;
    }
    throw new Error(`stack-run: ${run.label} cannot be placed remotely: ${reason}`);
  }
  const controller = new AbortController();
  let received: number | undefined;
  const handlers = SIGNALS.map(([name, number]) => {
    const handler = () => {
      received ??= number;
      controller.abort();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  try {
    const interval = pollMs(env);
    let hosts: RemoteCheck['hosts'];
    try {
      hosts = performanceHosts(readHosts(reason.hostsFile));
    } catch (error) {
      console.error(
        `stack-run: ${run.label} unavailable: invalid check hosts: ${error instanceof Error ? error.message : error}`,
      );
      return REMOTE_TRANSPORT_FAILURE;
    }
    if (hosts.length === 0) {
      console.error(`stack-run: ${run.label} unavailable: hosts file ${reason.hostsFile} has no approved a/b host`);
      return REMOTE_TRANSPORT_FAILURE;
    }
    let outcome: number;
    try {
      outcome = await runRemote(
        {
          ...(cancellation === undefined ? {} : { cancellation }),
          hosts,
          allowedHosts: ['a', 'b'],
          hostsFile: reason.hostsFile,
          workspace: run.root,
          cwd: relative(resolve(run.root), resolve(run.cwd)) || '.',
          command: profile ? ['env', `GROWTH_PROFILE=${profile}`, ...run.command] : run.command,
          ...(run.slots === undefined ? {} : { slots: run.slots }),
          ...(run.estimateMs === undefined ? {} : { estimateMs: run.estimateMs }),
          ...(priority === undefined ? {} : { priority }),
          ...(interval === undefined ? {} : { pollMs: interval }),
          ...(run.returns === undefined && profile === undefined && env.GROWTH_PROFILE === undefined
            ? {}
            : { returns: [...(run.returns ?? []), ...(profile === undefined ? [] : [profile])] }),
          started: (host) => {
            run.started?.(host);
            console.error(`stack-run: ${run.label}${priority ? ` priority ${priority}` : ''} on ${host}`);
          },
        },
        controller.signal,
      );
    } catch (error) {
      if (
        error instanceof RemoteTransportError ||
        (error instanceof Error && error.message === 'remote-check: no check host answered')
      )
        return REMOTE_TRANSPORT_FAILURE;
      throw error;
    }
    if (profile && priorProfile) {
      const profileFile = join(resolve(run.root), profile);
      if (existsSync(profileFile)) {
        const returned = readFileSync(profileFile);
        if (!returned.subarray(0, priorProfile.length).equals(priorProfile))
          writeFileSync(profileFile, Buffer.concat([priorProfile, returned]));
      }
    }
    return outcome;
  } catch (error) {
    if (error instanceof Aborted || received !== undefined || cancelled())
      return 128 + (received ?? cancelled()?.signal ?? 15);
    throw error;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
}

/** The one place a stack-heavy run is placed: host a/b or an already-confined remote-check run. */
export async function stackRun(
  run: StackRun,
  local: (env: Record<string, string>) => Promise<number>,
  env: Environment = process.env,
  runRemote: (options: RemoteCheck, signal: AbortSignal) => Promise<number> = remoteCheck,
): Promise<number> {
  const returned = validateArtifactDeclarations(run.returns ?? []);
  if (returned.length) clearDeclaredArtifacts(run.root, returned);
  const remoteCode = await runOnCheckHost(run, env, runRemote);
  const logicalCheckId = env.REZICS_CHECK_ID;
  if (remoteCode !== null) {
    if (logicalCheckId && returned.length) {
      try {
        writeArtifactCatalog(run.root, logicalCheckId, returned);
      } catch (error) {
        console.error(
          `stack-run: could not record declared outputs: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return remoteCode;
  }
  const cancellation = run.cancellation ?? executionCancellationFromEnvironment(env);
  const intent = executionCancellation(cancellation);
  if (intent) return 128 + intent.signal;
  const stageDirectory = env.REZICS_CHECK_ARTIFACTS_DIR;
  const physicalRunId = env.REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID;
  let handoff = false;
  if (stageDirectory !== undefined && physicalRunId !== undefined && returned.length > 0) {
    try {
      await registerArtifactDeclarations(run.root, stageDirectory, physicalRunId, returned);
      handoff = true;
    } catch (error) {
      if (hasOutputTreeReturn(returned)) throw error;
      console.error(`stack-run: artifact handoff unavailable: ${error instanceof Error ? error.message : error}`);
    }
  }
  let code: number | undefined;
  try {
    code = await withStackSlot(run.label, (leaseEnv) => {
      const intent = executionCancellation(cancellation);
      return intent
        ? Promise.resolve(128 + intent.signal)
        : hasOutputTreeReturn(returned)
          ? withKernelClientOutput(run.root, () => local(leaseEnv), { returns: returned })
          : local(leaseEnv);
    });
  } finally {
    if (handoff && stageDirectory !== undefined && physicalRunId !== undefined) {
      try {
        await captureArtifactReturns(run.root, stageDirectory, physicalRunId, returned);
      } catch (error) {
        if (hasOutputTreeReturn(returned) && (code === undefined || code === 0)) throw error;
        console.error(`stack-run: could not stage declared outputs: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  if (logicalCheckId && returned.length) {
    try {
      writeArtifactCatalog(run.root, logicalCheckId, returned);
    } catch (error) {
      console.error(`stack-run: could not record declared outputs: ${error instanceof Error ? error.message : error}`);
    }
  }
  return code!;
}

if (import.meta.main) {
  const usage =
    'Usage: bun scripts/stack-run.ts [--keeps-files] [--returns <path>]... [--slots <n>] [--estimate-ms <n>] <label> <root> <cwd> -- <command...>';
  const rest = process.argv.slice(2);
  let keepsFiles = false;
  let slots: number | undefined;
  let estimateMs: number | undefined;
  let returns: string[] | undefined;
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    const flag = rest.shift();
    if (flag === '--keeps-files') keepsFiles = true;
    else if (flag === '--output-tree') {
      returns ??= [];
      returns.push(outputTreeProfile(rest.shift() ?? '').transport);
    } else if (flag === '--returns' && rest.length > 0) {
      returns ??= [];
      returns.push(rest.shift()!);
    } else if (flag === '--slots' && rest.length > 0) slots = Number(rest.shift());
    else if (flag === '--estimate-ms') estimateMs = Number(rest.shift());
    else throw new Error(`Unknown option: ${flag}\n${usage}`);
  }
  const [label, root, cwd, separator, ...command] = rest;
  if (estimateMs !== undefined && (!Number.isSafeInteger(estimateMs) || estimateMs < 0)) {
    console.error(`--estimate-ms must be a non-negative safe integer\n${usage}`);
    process.exitCode = 2;
  } else if (!label || !root || !cwd || separator !== '--' || command.length === 0) {
    console.error(usage);
    process.exitCode = 2;
  } else if (slots !== undefined && (!Number.isSafeInteger(slots) || slots < 1)) {
    console.error(`--slots must be a positive integer\n${usage}`);
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await stackRun(
        {
          label,
          root: resolve(root),
          cwd: resolve(cwd),
          command,
          keepsFiles,
          ...(returns === undefined ? {} : { returns }),
          ...(slots === undefined ? {} : { slots }),
          ...(estimateMs === undefined ? {} : { estimateMs }),
        },
        async (env) => {
          const cancellation = executionCancellationFromEnvironment();
          const observed = observeExecutionCancellation(cancellation);
          if (observed.signal.aborted) {
            observed.close();
            return 128 + (executionCancellation(cancellation)?.signal ?? 15);
          }
          const child = Bun.spawn(ownedLocalCommand(command), {
            cwd: resolve(cwd),
            env: { ...process.env, ...env },
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
          });
          // Until here a signal ends this process by default, which is right while it waits and while a host runs it.
          const forwarders = SIGNALS.map(([name]) => {
            const forward = () => child.kill(name);
            process.on(name, forward);
            return [name, forward] as const;
          });
          const cancel = () => child.kill('SIGTERM');
          observed.signal.addEventListener('abort', cancel, { once: true });
          try {
            const code = await child.exited;
            const intent = executionCancellation(cancellation);
            return intent ? 128 + intent.signal : code;
          } finally {
            observed.close();
            observed.signal.removeEventListener('abort', cancel);
            for (const [name, forward] of forwarders) process.off(name, forward);
          }
        },
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
