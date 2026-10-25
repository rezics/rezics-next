import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { FirstFailure } from './contracts.ts';

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || `git ${args[0]} failed`);
  return result.stdout.trim();
}

/** A gate runs as nobody in particular: whichever process drives the train, its manager, task and session identity must
 * not reach the gate, or the gate's own tests act on that identity. */
export function gateEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => !name.startsWith('GOAL_') && name !== 'CODEX_THREAD_ID'));
}

export type GateResult = { passed: boolean; output: string; timedOut: boolean };
export type GateRunner = (argv: readonly string[], cwd: string, logPath: string) => Promise<GateResult>;

export function gateRunner(timeoutMs = 600_000): GateRunner {
  return async (argv, cwd, logPath) => {
    if (!argv.length) throw new Error('A gate command is required');
    // A separate process group allows the timeout to stop grandchildren as well as the shell.
    const { spawn } = await import('node:child_process');
    return await new Promise<GateResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gateEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const collect = (chunk: Buffer) => { const text = chunk.toString(); output += text; appendFileSync(logPath, text); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
      }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ passed: code === 0 && !timedOut, output, timedOut }); });
    });
  };
}

/** Extract assertion content, ignoring reporter ordering, source locations and timing decoration. */
export function firstFailure(output: string): FirstFailure {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line
    .replace(/(?:[A-Za-z]:)?(?:[./\\\w@-]+[/\\])+[^\s:()]+(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|sh|json)(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/<path>\(\d+,\s*\d+\)/g, '<path>')
    .replace(/\bline\s+\d+(?:\s*[:,]\s*\d+)?/gi, 'line <n>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|s)\b/gi, '<duration>')
    .replace(/^\s*(?:\d+\)|[×✗✕❯>])\s*/, '')
    .replace(/\s+/g, ' ').trim())
    .filter(line => line && !/^at\s|^\d+\s*[|:]|^\^|^<path>\s*$/.test(line));
  const assertions = lines.filter(line => /error|assert|expect|received|actual|fail|panic|not ok/i.test(line)
    && !/^\d+ (?:pass|fail)|^(?:test suites|test files|tests|snapshots|duration|time|ran \d)/i.test(line));
  const canonical = [...new Set(assertions.length ? assertions : lines)].sort();
  const assertion = canonical.join('\n') || 'Gate exited unsuccessfully';
  return { fingerprint: createHash('sha256').update(assertion).digest('hex'), assertion, excerpt: output.slice(0, 8000) };
}

export function changedFiles(cwd: string, base: string): string[] {
  // Include both sides of renames: moving a protected file into scope is still out of scope.
  const result = spawnSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Cannot read changed paths');
  return result.stdout.split('\0').filter(Boolean);
}

export function outsideScope(files: readonly string[], patterns: readonly string[]): string[] {
  const globs = patterns.map(pattern => new Bun.Glob(pattern));
  return files.filter(file => !globs.some(glob => glob.match(file)));
}
