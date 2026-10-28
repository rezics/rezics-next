import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FirstFailure } from './contracts.ts';

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
        ([name]) => !name.startsWith('GOAL_') && name !== 'CODEX_THREAD_ID' && name !== 'KERNEL_CHECK_REMOTE',
      ),
    ),
    ...NO_COMPILE_CACHE,
    ...remoteCheckEnvironment(stateDirectory),
  };
}

export type GateResult = { passed: boolean; output: string; timedOut: boolean };
export type GateRunner = (argv: readonly string[], cwd: string, logPath: string) => Promise<GateResult>;

export function gateRunner(timeoutMs = 600_000, stateDirectory?: string): GateRunner {
  return async (argv, cwd, logPath) => {
    if (!argv.length) throw new Error('A gate command is required');
    // A separate process group allows the timeout to stop grandchildren as well as the shell.
    const { spawn } = await import('node:child_process');
    return await new Promise<GateResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: gateEnvironment(process.env, stateDirectory ?? gateStateDirectory(cwd, process.env)),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let timedOut = false;
      const collect = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        appendFileSync(logPath, text);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ passed: code === 0 && !timedOut, output, timedOut });
      });
    });
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
