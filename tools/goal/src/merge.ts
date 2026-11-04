import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FirstFailure } from './contracts.ts';
import {
  checkResultKey,
  reusableCommand,
  CHECK_RESULT_SCHEMA,
  type CheckResult,
  type CheckResults,
} from './check-results.ts';

/** Attach cancellation to this spawned group without replacing the runner's normal terminal cleanup. */
function cancelOwnedCommand(child: ChildProcess, signal: AbortSignal | undefined): void {
  if (!signal) return;
  const cancel = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  };
  const detach = () => signal.removeEventListener('abort', cancel);
  child.once('error', detach);
  child.once('close', detach);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || `git ${args[0]} failed`);
  return result.stdout.trim();
}

/** A gate runs as nobody in particular: whichever process drives the train, its manager, task and session identity must
 * not reach the gate, or the gate's own tests act on that identity. */
// Node's compile cache, which Vite's bin turns on, keys its entries by path under os.tmpdir(); every worktree adds its
// own, and 862k of them exhausted /tmp's inodes. It cannot be shared across worktrees, so it is off.
export const NO_COMPILE_CACHE = { NODE_DISABLE_COMPILE_CACHE: '1' } as const;
/** Kernel checks run on the development check hosts when the control plane's state directory lists them. */
export function remoteCheckEnvironment(stateDirectory: string | undefined): { KERNEL_CHECK_REMOTE?: string } {
  const hosts = stateDirectory === undefined ? undefined : join(stateDirectory, 'remote-check-hosts.json');
  return hosts !== undefined && existsSync(hosts) ? { KERNEL_CHECK_REMOTE: hosts } : {};
}
/** Gates run in the main checkout's worktrees, so the state directory is the one the control plane itself defaults to. */
function gateStateDirectory(cwd: string, parent: NodeJS.ProcessEnv): string | undefined {
  try {
    const main = dirname(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    return resolve(main, parent.GOAL_STATE_DIRECTORY || '.temp/goal');
  } catch {
    return undefined;
  }
}
export function gateEnvironment(parent: NodeJS.ProcessEnv = process.env, stateDirectory?: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(parent).filter(
        ([name]) =>
          !name.startsWith('GOAL_') &&
          name !== 'CODEX_THREAD_ID' &&
          name !== 'KERNEL_CHECK_REMOTE' &&
          name !== 'KERNEL_CHECK_ON_REMOTE',
      ),
    ),
    ...NO_COMPILE_CACHE,
    ...remoteCheckEnvironment(stateDirectory),
  };
}

export type GateResult = { passed: boolean; output: string; timedOut: boolean };
/** Cancellation belongs to one invocation, never to all commands in a controller process. */
export type GateRunOptions = { signal?: AbortSignal };
export type GateRunner = (
  argv: readonly string[],
  cwd: string,
  logPath: string,
  options?: GateRunOptions,
) => Promise<GateResult>;

const activeCommandGroups = new Map<number, () => Promise<void>>();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  let stopping = false;
  const stopGroups = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([...activeCommandGroups.values()].map((stop) => stop()));
    process.removeListener(signal, stopGroups);
    process.kill(process.pid, signal);
  };
  process.on(signal, stopGroups);
}

function compilerContainerCleanup(pid: number): string | undefined {
  const query = () =>
    spawnSync('docker', ['ps', '-aq', '--filter', `label=rezics.compiler.pid=${pid}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  const describeFailure = (result: ReturnType<typeof query>) =>
    result.error?.message || result.stderr?.trim() || `docker exited with status ${result.status}`;
  let listed = query();
  if (listed.error || listed.status !== 0)
    return `Compiler database cleanup could not be proven for PID ${pid}: ${describeFailure(listed)}`;
  let containers = (listed.stdout ?? '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (containers.length > 1)
    return `Compiler database cleanup could not be proven for PID ${pid}: expected one owned container, found ${containers.join(', ')}`;
  if (containers.length) {
    const removed = spawnSync('docker', ['rm', '-f', '-v', containers[0]!], { encoding: 'utf8', timeout: 10_000 });
    if (removed.error || removed.status !== 0)
      return `Compiler database cleanup failed for PID ${pid}: ${describeFailure(removed)}`;
    listed = query();
    if (listed.error || listed.status !== 0)
      return `Compiler database cleanup could not be proven for PID ${pid}: ${describeFailure(listed)}`;
    containers = (listed.stdout ?? '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return containers.length
    ? `Compiler database cleanup could not be proven for PID ${pid}: owned containers remain: ${containers.join(', ')}`
    : undefined;
}

function isRootTypecheck(argv: readonly string[]): boolean {
  return argv.some((part) => part === 'scripts/typecheck.ts' || part.endsWith('/scripts/typecheck.ts'));
}

/** Run a command in an isolated process group and reap the entire group on every exit path. */
export function processGroupRunner(
  timeoutMs?: number,
  stateDirectory?: string,
  parent: NodeJS.ProcessEnv = process.env,
  sanitizeEnvironment = true,
): GateRunner {
  const run: GateRunner = async (argv, cwd, logPath, options) => {
    if (!argv.length) throw new Error('A gate command is required');
    return await new Promise<GateResult>((resolve, reject) => {
      let finishCleanup!: () => void;
      const cleanupComplete = new Promise<void>((done) => (finishCleanup = done));
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: sanitizeEnvironment ? gateEnvironment(parent, stateDirectory ?? gateStateDirectory(cwd, parent)) : parent,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pid = child.pid;
      let output = '';
      let timedOut = false;
      let settled = false;
      let stopPromise: Promise<boolean> | undefined;
      const signalGroup = (signal: NodeJS.Signals) => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal);
        } catch {}
      };
      const groupAlive = () => {
        if (pid === undefined) return false;
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      };
      const stopGroup = (graceMs = 12_000): Promise<boolean> => {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          if (!groupAlive()) return true;
          signalGroup('SIGTERM');
          const deadline = Date.now() + graceMs;
          while (groupAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          if (groupAlive()) {
            signalGroup('SIGKILL');
            const killDeadline = Date.now() + 1_000;
            while (groupAlive() && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return !groupAlive();
        })();
        return stopPromise;
      };
      if (pid !== undefined)
        activeCommandGroups.set(pid, async () => {
          await stopGroup();
          await cleanupComplete;
        });
      const collect = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        appendFileSync(logPath, text);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      cancelOwnedCommand(child, options?.signal);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              void stopGroup();
            }, timeoutMs);
      const cleanup = async () => {
        try {
          if (timer !== undefined) clearTimeout(timer);
          const groupStopped = await stopGroup();
          if (!groupStopped) output += `Command process group cleanup could not be proven for PID ${pid}\n`;
          if (
            groupStopped &&
            pid !== undefined &&
            isRootTypecheck(argv) &&
            output.includes('Compiler database owner PID=')
          ) {
            const owner = output.match(/^Compiler database owner PID=(\d+)\s*$/m);
            if (!owner) {
              output += `Compiler database cleanup could not be proven for PID ${pid}: owner identity was malformed\n`;
            } else if (Number(owner[1]) !== pid) {
              output += `Compiler database cleanup could not be proven for PID ${pid}: producer reported owner PID ${owner[1]}\n`;
            } else {
              const failure = compilerContainerCleanup(pid);
              if (failure) output += `${failure}\n`;
            }
          }
        } finally {
          if (pid !== undefined) activeCommandGroups.delete(pid);
          finishCleanup();
        }
      };
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        void cleanup().then(
          () => reject(error),
          (cleanupError) =>
            reject(
              new Error(
                `${error instanceof Error ? error.message : String(error)}; command cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              ),
            ),
        );
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        void cleanup().then(
          () =>
            resolve({
              passed:
                code === 0 &&
                !timedOut &&
                !/Compiler database cleanup (?:could not be proven|failed)|Command process group cleanup could not be proven/.test(
                  output,
                ),
              output,
              timedOut,
            }),
          (error) =>
            resolve({
              passed: false,
              output: `${output}\nCommand cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              timedOut,
            }),
        );
      });
    });
  };
  return async (argv, cwd, logPath, options) => {
    options?.signal?.throwIfAborted();
    // Await the complete runner, including any asynchronous terminal cleanup composed by the receiving tree.
    const result = await run(argv, cwd, logPath, options);
    options?.signal?.throwIfAborted();
    return result;
  };
}

export type CheckResultGateOptions = {
  root: string;
  results: CheckResults;
  producer?: string;
  host?: string;
  shadow?: boolean;
  enabled?: boolean;
  alert?: (message: string) => void;
};

export function gateRunner(
  timeoutMs = 600_000,
  stateDirectory?: string,
  environment: NodeJS.ProcessEnv | CheckResultGateOptions = {},
  reuse?: CheckResultGateOptions,
): GateRunner {
  if ('root' in environment && 'results' in environment) {
    reuse = environment as CheckResultGateOptions;
    environment = {};
  }
  const env = environment as NodeJS.ProcessEnv;
  const run = processGroupRunner(timeoutMs, stateDirectory, { ...process.env, ...env });
  return async (argv, cwd, logPath, options = {}) => {
    options.signal?.throwIfAborted();
    let key: ReturnType<typeof checkResultKey> | undefined;
    let cached: CheckResult | undefined;
    let cleanBefore = false;
    let head: string | undefined;
    const startedAt = Date.now();
    if (reuse && reusableCommand(argv)) {
      try {
        cleanBefore = git(cwd, 'status', '--porcelain').length === 0;
        if (cleanBefore) {
          head = git(cwd, 'rev-parse', 'HEAD');
          key = checkResultKey({ root: reuse.root, cwd, command: argv, env: { ...process.env, ...env } });
          cached = reuse.results.lookup(key.key);
          appendFileSync(logPath, `check-results: ${cached ? 'hit' : 'miss'} ${key.key}\n`);
          if (cached && reuse.enabled && !reuse.shadow)
            return { passed: true, output: 'reused check result', timedOut: false };
        }
      } catch {
        /* An incomplete committed snapshot is not reusable. */
      }
    }
    try {
      const result = await run(argv, cwd, logPath, options);
      options.signal?.throwIfAborted();
      try {
        if (
          key &&
          cleanBefore &&
          !result.timedOut &&
          git(cwd, 'status', '--porcelain').length === 0 &&
          git(cwd, 'rev-parse', 'HEAD') === head &&
          result.passed
        ) {
          reuse!.results.record({
            key: key.key,
            unit: key.unit,
            passed: true,
            producer: reuse!.producer ?? 'gateRunner',
            host: reuse!.host ?? process.env.HOSTNAME ?? 'unknown',
            duration: Date.now() - startedAt,
            logPath,
            time: Date.now(),
            schemaVersion: CHECK_RESULT_SCHEMA,
          });
        }
        if (cached && !result.passed)
          reuse?.alert?.(
            `Fresh check failed after reusable result hit ${key!.key}; cached log: ${cached.logPath}; fresh log: ${logPath}`,
          );
      } catch {
        /* Persistence or alert delivery cannot change the fresh check result. */
      }
      return result;
    } catch (error) {
      if (cached)
        reuse?.alert?.(
          `Fresh check failed after reusable result hit ${key!.key}; cached log: ${cached.logPath}; fresh log: ${logPath}`,
        );
      throw error;
    }
  };
}

/** Extract assertion content, ignoring reporter ordering, source locations and timing decoration. */
export function firstFailure(output: string): FirstFailure {
  const raw = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const lines = raw
    .map((line) =>
      line
        .replace(/(?:[A-Za-z]:)?(?:[./\\\w@-]+[/\\])+[^\s:()]+(?::\d+(?::\d+)?)?/g, '<path>')
        .replace(/\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|sh|json)(?::\d+(?::\d+)?)?/g, '<path>')
        .replace(/<path>\(\d+,\s*\d+\)/g, '<path>')
        .replace(/\bline\s+\d+(?:\s*[:,]\s*\d+)?/gi, 'line <n>')
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|s)\b/gi, '<duration>')
        .replace(/^\s*(?:\d+\)|[×✗✕❯>])\s*/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line && !/^at\s|^\d+\s*[|:]|^\^|^<path>\s*$/.test(line));
  const assertions = lines.filter(
    (line) =>
      /error|assert|expect|received|actual|fail|panic|not ok/i.test(line) &&
      !/^\d+ (?:pass|fail)|^(?:test suites|test files|tests|snapshots|duration|time|ran \d)/i.test(line),
  );
  const canonical = [...new Set(assertions.length ? assertions : lines)].sort();
  const assertion = canonical.join('\n') || 'Gate exited unsuccessfully';
  // The assertion is masked so a repeated failure keeps its fingerprint; the worker needs the real file and line. The
  // excerpt leads with the failing lines as printed, then the end of the output, where a failing check stops.
  const failing = raw.filter(
    (line) =>
      /error|assert|expect|received|actual|fail|panic|not ok/i.test(line) &&
      !/^\s*\d+ (?:pass|fail)|^\s*(?:test suites|test files|tests|snapshots|duration|time|ran \d)/i.test(line),
  );
  const head = [...new Set(failing.map((line) => line.trim()))].slice(0, 60).join('\n').slice(0, 4000);
  const tail = output.slice(-(8000 - head.length - 5));
  return {
    fingerprint: createHash('sha256').update(assertion).digest('hex'),
    assertion,
    excerpt: head ? `${head}\n...\n${tail}` : output.slice(-8000),
  };
}

export function changedFiles(cwd: string, base: string): string[] {
  // Include both sides of renames: moving a protected file into scope is still out of scope.
  const result = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot read changed paths');
  return result.stdout.split('\0').filter(Boolean);
}

/** Paths marked linguist-generated are excluded from estimates, using attributes in this checkout. */
export function nonGeneratedFiles(cwd: string, files: readonly string[]): string[] {
  if (!files.length) return [];
  const result = spawnSync('git', ['check-attr', '-z', '--stdin', 'linguist-generated'], {
    cwd,
    encoding: 'utf8',
    input: `${files.join('\0')}\0`,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot read linguist-generated attributes');
  const values = result.stdout.split('\0');
  const generated = new Set<string>();
  for (let i = 0; i + 2 < values.length; i += 3)
    if (values[i + 1] === 'linguist-generated' && values[i + 2] === 'true') generated.add(values[i]!);
  return files.filter((file) => !generated.has(file));
}

export function diffLineCount(cwd: string, base: string, files?: readonly string[]): number {
  const args = ['diff', '--numstat', base, 'HEAD'];
  if (files) {
    args.push('--', ...files);
    if (!files.length) return 0;
  }
  return git(cwd, ...args)
    .split('\n')
    .reduce((sum, line) => {
      const [added, removed] = line.split('\t');
      return sum + (Number(added) || 0) + (Number(removed) || 0);
    }, 0);
}

export function outsideScope(files: readonly string[], patterns: readonly string[]): string[] {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern));
  return files.filter((file) => !globs.some((glob) => glob.match(file)));
}
