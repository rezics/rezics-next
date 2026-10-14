import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { parseBrief } from './briefs.ts';
import { typecheckWorkspaces } from '../qa/affected.ts';
import { typecheckDiagnostics } from './typecheck-gate.ts';
import { mergeUnitFiles, timeoutOnlyTestFiles, failingTestFiles, unitFileErrorDetails, recoveredSlowTests, rememberSlowTests, slowTestLine, timeoutRetryArg, UNIT_JUNIT_MARKER } from './unit-gate.ts';
import { repositoryGuardSelectionLine } from '../qa/repository-guards.ts';
import { parseJUnit, isQaOwnerPath, isQaIntegrationPath, isQaFaultPath, isQaModelPath, isQaE2ePath, isQaLoadPath } from '../qa/acceptance.ts';
import { tierBunTestArgs, type TierTestTimeout } from '../qa/core.ts';
import { withSlot, type SlotRunOptions, type GateLaneOptions } from './qa-slots.ts';
import { selectSurface, runSurfaceGate } from './surface-gate.ts';
import { prepareCheckTree, worktreeBase } from './tree-currency.ts';

export type CheckGroup = 'types' | 'lint' | 'tests' | 'guards';
export type CheckName = CheckGroup | 'ast' | 'contract' | 'stories' | 'selection' | 'currency';
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
  const base = gitOutput(cwd, ['merge-base', 'HEAD', worktreeBase(cwd)]).trim();
  return [...new Set([
    ...gitOutput(cwd, ['diff', '--no-renames', '--name-only', '-z', base, '--']).split('\0'),
    ...gitOutput(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
}

export interface CheckCommandResult { code: number; output: string }
export type CheckRunner = (command: readonly string[], cwd: string, log: string, env?: NodeJS.ProcessEnv) => Promise<CheckCommandResult>;

/** Capture to disk as it arrives, including passing output, without making the worker read it. */
export const runCheckCommand: CheckRunner = (command, cwd, log, env = process.env) => new Promise(resolveResult => {
  writeFileSync(log, `$ ${command.join(' ')}\n`);
  const child = spawn(command[0]!, command.slice(1), {
    cwd, env: { ...env, AGENT: '1', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  /** The CLI prepares and restarts before loading the updated harness. */
  treePrepared?: boolean;
  only?: readonly CheckGroup[];
  changed?: readonly string[];
  tests?: readonly string[];
  runner?: CheckRunner;
  print?: (line: string) => void;
  now?: () => number;
  slotOptions?: Omit<SlotRunOptions, 'runCommand'>;
  gateLaneOptions?: Omit<GateLaneOptions, 'command'>;
  historyDirectory?: string;
}
export interface CheckResult { name: CheckName; code: number; seconds: number; waitSeconds?: number; note?: string }

/** Hosted QA prints a report link rather than its case diagnostics. Read this invocation's isolated artifact root. */
function testArtifactOutput(directory: string): { output: string; failures: string; diagnostics: string; report: string } {
  const outputs: string[] = [];
  const failures: string[] = [];
  const diagnostics: string[] = [];
  const reports: string[] = [];
  if (existsSync(directory)) {
    for (const file of new Bun.Glob('**/*.{log,xml}').scanSync({ cwd: directory })) {
      const path = join(directory, file);
      const content = readFileSync(path, 'utf8');
      outputs.push(`\n=== QA artifact: ${path} ===\n${content}`);
      if (file.endsWith('.log')) diagnostics.push(content);
      if (file.endsWith('.xml')) {
        reports.push(content.replace(/<\?xml[^>]*\?>|<\/?testsuites\b[^>]*>/g, ''));
        for (const test of parseJUnit(content, 'e2e').filter(test => test.failed)) {
          failures.push(`(fail) ${test.name}\n${test.detail ? `error: ${test.detail}` : ''}`);
        }
      }
    }
  }
  return { output: outputs.join('\n'), failures: failures.join('\n'), diagnostics: diagnostics.join('\n'),
    report: reports.length ? `${UNIT_JUNIT_MARKER}\n<testsuites>${reports.join('\n')}</testsuites>` : '' };
}

function checkTestTier(file: string): TierTestTimeout | undefined {
  if (file.includes('.stories.') || isQaModelPath(file) || isQaE2ePath(file) || isQaLoadPath(file)) return undefined;
  if (isQaFaultPath(file)) return 'fault/recovery';
  if (isQaIntegrationPath(file)) return 'integration';
  return isQaOwnerPath(file) ? 'owner' : 'unit';
}

export async function workerCheck(options: CheckOptions = {}): Promise<{ code: number; log: string; checks: CheckResult[] }> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const currency = options.treePrepared ? undefined : prepareCheckTree(cwd, options.print ?? console.log);
  if (currency?.failed) {
    const root = join(cwd, '.temp/goal/check');
    mkdirSync(root, { recursive: true });
    const log = join(mkdtempSync(join(root, 'run-')), 'output.log');
    writeFileSync(log, `${currency.line}\n`);
    return { code: 1, log, checks: [{ name: 'currency', code: 1, seconds: 0 }] };
  }
  const changed = options.changed ?? checkChangedFiles(cwd);
  const briefPath = join(cwd, '.temp/goal/brief.md');
  const briefText = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : undefined;
  const brief = briefText === undefined ? undefined : parseBrief(briefText);
  const tests = options.tests ?? brief?.tests ?? [];
  // A wave build task's rows are proved once for the whole wave, in its prove phase (docs/goals/wave.md).
  if (brief?.kind === 'surface' && !/^## Wave[ \t]*$/m.test(briefText ?? '')) {
    const selected = await selectSurface(cwd, { ...brief, tests: [...tests] }, changed);
    if (!selected?.selection) {
      const root = join(cwd, '.temp/goal/check');
      mkdirSync(root, { recursive: true });
      const log = join(mkdtempSync(join(root, 'run-')), 'output.log');
      const refusal = selected?.refusals.join('\n') ?? 'surface selection unavailable';
      writeFileSync(log, refusal);
      for (const line of refusal.split('\n')) (options.print ?? console.log)(line);
      return { code: 1, log, checks: [{ name: 'selection', code: 1, seconds: 0 }] };
    }
    return runSurfaceGate(cwd, selected.selection, options);
  }
  for (const file of tests) {
    const path = relative(cwd, resolve(cwd, file));
    if (isAbsolute(file) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Test file outside worktree: ${file}`);
    }
  }
  const only = options.only ?? GROUPS;
  const workspaces = typecheckWorkspaces(changed, cwd);
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
  let qaEnv = process.env;

  async function check(name: CheckName, commands: string[][], note?: string, testFiles: readonly string[] = []): Promise<void> {
    const start = now();
    const outputs: string[] = [];
    let code = 0;
    async function execute(command: string[], label: string, selected: readonly string[]): Promise<{ result: CheckCommandResult; failureOutput: string }> {
      const artifactsDirectory = join(directory, `${label}-artifacts`);
      mkdirSync(artifactsDirectory, { recursive: true });
      // Each invocation owns its artifact root; another worker's failures cannot enter this check.
      const env = { ...qaEnv, REZICS_QA_ARTIFACT_ROOT: artifactsDirectory };
      const direct = name === 'guards' || (name === 'tests' && selected.every(file => checkTestTier(file) === 'unit'));
      const invocation = direct ? [...command, '--reporter=junit', `--reporter-outfile=${join(artifactsDirectory, 'unit.xml')}`] : command;
      let result: CheckCommandResult;
      try { result = await run(invocation, cwd, join(directory, `${label}.log`), env); }
      catch (error) { result = { code: 1, output: `error: ${error instanceof Error ? error.message : String(error)}` }; }
      let failureOutput = result.output;
      if (name === 'tests' || name === 'guards') {
        try {
          const artifacts = testArtifactOutput(artifactsDirectory);
          failureOutput = artifacts.failures || `${result.output}\n${artifacts.diagnostics}`;
          result.output += `${artifacts.output}\n${artifacts.diagnostics}\n${artifacts.report}`;
        } catch (error) {
          result.code = 1;
          const diagnostic = `\nerror: Unable to read test artifacts: ${String(error)}`;
          result.output += diagnostic;
          failureOutput += diagnostic;
        }
      }
      appendFileSync(log, `\n=== ${name}: ${invocation.join(' ')} ===\n${result.output}\n`);
      return { result, failureOutput };
    }
    for (let i = 0; i < commands.length; i++) {
      const initial = await execute(commands[i]!, `${name}-${i}`, testFiles);
      if (initial.result.code === 0) continue;
      const retryFiles = timeoutOnlyTestFiles(initial.result.output, testFiles, cwd)
        .filter(file => name === 'guards' || checkTestTier(file) !== undefined);
      const allFailures = failingTestFiles(initial.result.output, testFiles, cwd);
      // An unclassified runner failure is never replaced by successful retries.
      const onlyTimeouts = retryFiles.length > 0 && allFailures.length > 0
        && allFailures.every(file => retryFiles.includes(file))
        && !unitFileErrorDetails(initial.result.output, testFiles, cwd).length
        && !/QA tier budget exceeded:|error: Unable to read test artifacts:/.test(initial.result.output);
      if (!onlyTimeouts) { code = 1; outputs.push(initial.failureOutput); }
      for (const file of retryFiles) {
        const tier = name === 'guards' ? 'unit' : checkTestTier(file)!;
        const command = name === 'guards' ? ['task', 'goal:unit-files', '--', file, timeoutRetryArg(tier)]
          : ['bun', 'scripts/qa/test.ts', file, timeoutRetryArg(tier)];
        const retried = await execute(command, `${name}-${i}-retry-${testFiles.indexOf(file)}`, [file]);
        if (retried.result.code !== 0) { code = 1; outputs.push(retried.failureOutput); continue; }
        const recovered = recoveredSlowTests(initial.result.output, retried.result.output, file, cwd);
        await rememberSlowTests(recovered, options.historyDirectory);
        appendFileSync(join(directory, 'timeout-retries.jsonl'), recovered.map(test => `${JSON.stringify(test)}\n`).join(''));
        for (const test of recovered) { const line = slowTestLine(test); print(line); appendFileSync(log, `${line}\n`); }
      }
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
  const guardFiles = only.includes('guards') ? mergeUnitFiles(cwd, 'Affected since worker check\n', changed) : [];
  if (only.includes('guards')) print(repositoryGuardSelectionLine(changed, cwd));
  const qaLane = async () => {
    const work = async () => {
      if (only.includes('tests')) await check('tests', tests.length ? [['bun', 'scripts/qa/test.ts', ...tests]] : [],
        tests.length ? undefined : 'no test files named in brief', tests);
      if (only.includes('guards')) await check('guards', guardFiles.length
        ? [['task', 'goal:unit-files', '--', ...tierBunTestArgs('unit', guardFiles).slice(1)]] : [],
        guardFiles.length ? undefined : 'no repository guard files present', guardFiles);
      return checks.some(check => (check.name === 'tests' || check.name === 'guards') && check.code !== 0) ? 1 : 0;
    };
    if ((only.includes('tests') && tests.length) || guardFiles.length) {
      await withSlot(['worker-check', ...tests, ...guardFiles], false, undefined, { ...options.slotOptions,
        runCommand: async (_command, env, onStart) => { qaEnv = env; onStart(); return work(); } });
    } else await work();
  };
  await Promise.all([staticLane(), qaLane()]);
  print(`Full output: ${log}`);
  return { code: checks.some(check => check.code !== 0) ? 1 : 0, log, checks };
}
