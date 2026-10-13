import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { parseBrief } from './briefs.ts';
import { typecheckWorkspaces } from '../qa/affected.ts';
import { typecheckDiagnostics } from './typecheck-gate.ts';
import { mergeUnitFiles } from './unit-gate.ts';
import { parseJUnit } from '../qa/acceptance.ts';

export type CheckGroup = 'types' | 'lint' | 'tests' | 'guards';
export type CheckName = CheckGroup | 'ast';
const GROUPS: CheckGroup[] = ['types', 'lint', 'tests', 'guards'];

export function parseCheckArgs(args: readonly string[]): CheckGroup[] {
  if (!args.length) return [...GROUPS];
  if (args.length !== 2 || args[0] !== '--only') throw new Error('check accepts --only types,lint,tests,guards');
  const groups = args[1]!.split(',');
  if (groups.some(group => !GROUPS.includes(group as CheckGroup))) throw new Error('Unknown check group');
  return [...new Set(groups)] as CheckGroup[];
}

function gitOutput(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr || 'Unable to inspect the branch');
  return run.stdout;
}

/** Diffing the base directly includes staged and unstaged edits; untracked source files are not in that diff. */
export function checkChangedFiles(cwd: string): string[] {
  const base = gitOutput(cwd, ['merge-base', 'HEAD', 'main']).trim();
  return [...new Set([
    ...gitOutput(cwd, ['diff', '--no-renames', '--name-only', '-z', base, '--']).split('\0'),
    ...gitOutput(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
}

export interface CheckCommandResult { code: number; output: string }
export type CheckRunner = (command: readonly string[], cwd: string, log: string) => Promise<CheckCommandResult>;

/** Capture to disk as it arrives, including passing output, without making the worker read it. */
export const runCheckCommand: CheckRunner = (command, cwd, log) => new Promise(resolveResult => {
  writeFileSync(log, `$ ${command.join(' ')}\n`);
  const child = spawn(command[0]!, command.slice(1), {
    cwd, env: { ...process.env, AGENT: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => appendFileSync(log, chunk));
  }
  let startupFailed = false;
  child.once('error', error => { startupFailed = true; appendFileSync(log, `error: ${error.message}\n`); });
  child.once('close', code => resolveResult({ code: startupFailed ? 1 : code ?? 1, output: readFileSync(log, 'utf8') }));
});

/** Keep case names and a few lines of each diagnostic; never leak passing-case transcripts into the summary. */
export function checkFailureLines(output: string): string[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/);
  const selected = new Set<number>();
  const cases = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:\(fail\)|FAIL\b|×|✗|\d+\)\s+.*›)|<testcase\b.*<(?:failure|error)\b/.test(line)) cases.add(i);
    if (/error(?: TS\d+|:|\b)|\bError:|\bfailed\b|^\s*[×✗]/i.test(line) && !/^\$ /.test(line)) {
      selected.add(i);
      for (let next = i + 1; next < Math.min(i + 4, lines.length); next++) {
        if (!lines[next]!.trim() || /^\s*\(pass\)/.test(lines[next]!)) break;
        selected.add(next);
      }
    }
  }
  const diagnostics = typecheckDiagnostics(clean);
  const picked = [...cases, ...[...selected].sort((a, b) => a - b).filter(index => !cases.has(index))].map(index => lines[index]!);
  if (!picked.length) return (diagnostics.length ? diagnostics : lines.filter(line => line.trim() && !/^\$ |^\s*\(pass\)/.test(line))).slice(0, 60);
  return picked.filter(line => !/^\s*\(pass\)/.test(line)).slice(0, 60);
}

export interface CheckOptions {
  cwd?: string;
  only?: readonly CheckGroup[];
  changed?: readonly string[];
  tests?: readonly string[];
  runner?: CheckRunner;
  print?: (line: string) => void;
  now?: () => number;
}
export interface CheckResult { name: CheckName; code: number; seconds: number; note?: string }

/** Hosted QA prints a report link rather than its case diagnostics. Read only artifacts attributed by its slot result. */
function testArtifactOutput(resultFile: string): { output: string; failures: string; diagnostics: string } {
  if (!existsSync(resultFile)) return { output: '', failures: '', diagnostics: '' };
  const result = JSON.parse(readFileSync(resultFile, 'utf8')) as { artifactPaths?: string[] };
  const outputs: string[] = [];
  const failures: string[] = [];
  const diagnostics: string[] = [];
  for (const directory of result.artifactPaths ?? []) {
    for (const file of new Bun.Glob('**/*.{log,xml}').scanSync({ cwd: directory })) {
      const path = join(directory, file);
      const content = readFileSync(path, 'utf8');
      outputs.push(`\n=== QA artifact: ${path} ===\n${content}`);
      if (file.endsWith('.log')) diagnostics.push(content);
      if (file.endsWith('.xml')) {
        for (const test of parseJUnit(content, 'e2e').filter(test => test.failed)) {
          failures.push(`(fail) ${test.name}\n${test.detail ? `error: ${test.detail}` : ''}`);
        }
      }
    }
  }
  return { output: outputs.join('\n'), failures: failures.join('\n'), diagnostics: diagnostics.join('\n') };
}

export async function workerCheck(options: CheckOptions = {}): Promise<{ code: number; log: string; checks: CheckResult[] }> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const changed = options.changed ?? checkChangedFiles(cwd);
  const briefPath = join(cwd, '.temp/goal/brief.md');
  const tests = options.tests ?? (existsSync(briefPath) ? parseBrief(readFileSync(briefPath, 'utf8')).tests ?? [] : []);
  for (const file of tests) {
    const path = relative(cwd, resolve(cwd, file));
    if (isAbsolute(file) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Test file outside worktree: ${file}`);
    }
  }
  const only = options.only ?? GROUPS;
  const workspaces = typecheckWorkspaces(changed);
  const files = changed.filter(file => existsSync(join(cwd, file)) && statSync(join(cwd, file)).isFile());
  const directories = [...new Set(files.filter(file => /\.[cm]?[jt]sx?$/.test(file)).map(dirname))].sort();
  const root = join(cwd, '.temp/goal/check');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  const log = join(directory, 'output.log');
  writeFileSync(log, `Changed files:\n${changed.join('\n')}\n`);
  const run = options.runner ?? runCheckCommand;
  const print = options.print ?? console.log;
  const now = options.now ?? Date.now;
  const checks: CheckResult[] = [];
  const testResult = join(directory, 'test-result.json');

  async function check(name: CheckName, commands: string[][], note?: string): Promise<void> {
    const start = now();
    const outputs: string[] = [];
    let code = 0;
    for (let i = 0; i < commands.length; i++) {
      let result: CheckCommandResult;
      try { result = await run(commands[i]!, cwd, join(directory, `${name}-${i}.log`)); }
      catch (error) { result = { code: 1, output: `error: ${error instanceof Error ? error.message : String(error)}` }; }
      let failureOutput = result.output;
      if (name === 'tests') {
        try {
          const artifacts = testArtifactOutput(testResult);
          failureOutput = artifacts.failures || `${result.output}\n${artifacts.diagnostics}`;
          result.output += artifacts.output;
        } catch (error) {
          result.code = 1;
          const diagnostic = `\nerror: Unable to read test artifacts: ${String(error)}`;
          result.output += diagnostic;
          failureOutput += diagnostic;
        }
      }
      appendFileSync(log, `\n=== ${name}: ${commands[i]!.join(' ')} ===\n${result.output}\n`);
      if (result.code !== 0) { code = 1; outputs.push(failureOutput); }
    }
    const seconds = (now() - start) / 1000;
    const result = { name, code, seconds, ...(note ? { note } : {}) };
    checks.push(result);
    const summary = `${name}: ${code === 0 ? 'ok' : 'failed'} (${seconds.toFixed(1)}s)${note ? ` — ${note}` : ''}`;
    print(summary);
    appendFileSync(log, `${summary}\n`);
    if (code !== 0) for (const line of checkFailureLines(outputs.join('\n'))) print(line);
  }

  // The gate owns workspace and guard selection. Heavy compiler/lint processes share one serial lane.
  const staticLane = async () => {
    if (only.includes('types')) await check('types', workspaces.map(workspace => ['task', `${workspace}:typecheck`]),
      workspaces.length ? undefined : 'no TypeScript workspace changed');
    if (only.includes('lint')) {
      await check('lint', directories.length ? [['node_modules/.bin/oxlint', '--type-aware', ...directories]] : [],
        directories.length ? undefined : 'no source directory changed');
      await check('ast', files.length ? [['task', 'ast-grep', '--', 'scan', ...files]] : [],
        files.length ? undefined : 'no existing file changed');
    }
  };
  // `task guards` summarizes its child output; running its gate-selected files keeps the full transcript for this log.
  const guardFiles = only.includes('guards') ? mergeUnitFiles(cwd, 'Affected since worker check\n') : [];
  await Promise.all([
    staticLane(),
    only.includes('tests') ? check('tests', tests.length ? [['bun', 'scripts/goal/goalctl.ts', 'test', ...tests,
      '--result-file', testResult]] : [],
      tests.length ? undefined : 'no test files named in brief') : Promise.resolve(),
    only.includes('guards') ? check('guards', guardFiles.length ? [['task', 'goal:unit-files', '--', ...guardFiles]] : [],
      guardFiles.length ? undefined : 'no repository guard files present') : Promise.resolve(),
  ]);
  print(`Full output: ${log}`);
  return { code: checks.some(check => check.code !== 0) ? 1 : 0, log, checks };
}
