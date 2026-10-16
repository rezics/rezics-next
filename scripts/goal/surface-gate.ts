import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript-6';
import { type Brief } from './types.ts';
import { type CheckGroup, type CheckRunner, runCheckCommand, checkFailureLines } from './check.ts';
import { affectedSelection } from './merge.ts';
import {
  mergeUnitFiles, unitFilesFromPlan, completedUnitShard, runUnitSide, unitFailureDetails, unitFileErrorDetails,
  introducedUnitFailures, prepareUnitBaseline, removeUnitBaseline, reportCases, slowTestLine,
  ownerArtifactFiles, unitArtifactReport, timeoutRetryArg, runUnitGate, gateShardRunner, type UnitShardRunner,
} from './unit-gate.ts';
import { repositoryGuardSelectionLine } from '../qa/repository-guards.ts';
import * as repositoryGuardRunner from '../qa/repository-guards.ts';
import { workerTypeCommands } from '../qa/worker-types.ts';
import { inferenceGateCommand, needsInferenceGate } from '../api/inference-cost.ts';
import { workerInferenceCheck } from './inference-check.ts';
import { withGateLane, withSlot, type SlotRunOptions, type GateLaneOptions } from './qa-slots.ts';
import { type loadOutcomes, personas, type RowOutcomes } from '../qa/cases/outcomes.ts';
import { isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath, isQaOwnerPath } from '../qa/acceptance.ts';

const unitFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const storyFile = /\.stories\.tsx$/;
export interface SurfaceSelection { main: string; rows: string[]; units: string[]; outcomes?: string[]; stories: string[]; guards: string[]; changed: string[]; proofs: string[] }
export interface SurfaceSelectionResult { selection?: SurfaceSelection; refusals: string[] }

/** Read the outcome owner's declarations and registration checks from the exact main commit,
 * never from declarations a surface branch could mark proved itself. */
async function mainOutcomes(cwd: string, main: string): Promise<Map<string, RowOutcomes>> {
  const parent = join(cwd, '.temp/goal/surface-outcomes');
  mkdirSync(parent, { recursive: true });
  const snapshot = mkdtempSync(join(parent, 'main-'));
  try {
    const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', '-z', main], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (listed.status !== 0) throw new Error(listed.stderr.trim());
    const tracked = new Set(listed.stdout.split('\0').filter(Boolean));
    const copied = new Map<string, string>();
    const copy = (file: string) => {
      if (copied.has(file)) return;
      const shown = spawnSync('git', ['show', `${main}:${file}`], { cwd, maxBuffer: 16 * 1024 * 1024 });
      if (shown.status !== 0) throw new Error(shown.stderr.toString().trim());
      mkdirSync(dirname(join(snapshot, file)), { recursive: true });
      writeFileSync(join(snapshot, file), shown.stdout);
      copied.set(file, shown.stdout.toString());
    };
    for (const file of tracked) {
      if (file.startsWith('scripts/qa/cases/') || file.startsWith('tests/qa/') || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) copy(file);
    }
    // Declarations may export fixture helpers. Their relative dependencies must also
    // come from main; test bodies are inspected by the owner and are never imported.
    const queue = [...copied.keys()].filter(file => file.startsWith('scripts/qa/cases/') && file.endsWith('.ts'));
    const visited = new Set<string>();
    while (queue.length) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      for (const imported of ts.preProcessFile(copied.get(file)!, true, true).importedFiles) {
        if (!imported.fileName.startsWith('.')) continue;
        const base = posix.normalize(posix.join(posix.dirname(file), imported.fileName));
        const dependency = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js'].map(extension => base + extension)]
          .find(candidate => tracked.has(candidate));
        if (!dependency) throw new Error(`Missing main declaration dependency: ${file} -> ${imported.fileName}`);
        copy(dependency);
        queue.push(dependency);
      }
    }
    symlinkSync(resolve(import.meta.dir, '../../node_modules'), join(snapshot, 'node_modules'), 'dir');
    const owner = await import(pathToFileURL(join(snapshot, 'scripts/qa/cases/outcomes.ts')).href) as { loadOutcomes: typeof loadOutcomes };
    return await owner.loadOutcomes({ root: snapshot });
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}

export async function selectSurface(cwd: string, brief: Brief, changed: readonly string[], main = 'main'): Promise<SurfaceSelectionResult | undefined> {
  if (brief.kind !== 'surface') return undefined;
  const refusals: string[] = [];
  const rows = [...new Set(brief.rows ?? [])];
  const proofs = ['scripts/qa/cases/outcomes.ts', 'scripts/qa/cases/outcome-cells.ts', 'scripts/qa/cases/launch-coverage.ts'];
  if (!rows.length) refusals.push('surface requires rows: naming outcomes proved on main');
  const validRows = rows.filter(row => /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(row));
  let mainCommit = main;
  for (const row of rows.filter(row => !validRows.includes(row))) refusals.push(`invalid surface row: ${row}`);
  if (validRows.length) {
    try {
      const revision = spawnSync('git', ['rev-parse', '--verify', `${main}^{commit}`], { cwd, encoding: 'utf8' });
      if (revision.status !== 0) throw new Error(revision.stderr.trim());
      mainCommit = revision.stdout.trim();
      const outcomes = await mainOutcomes(cwd, mainCommit);
      for (const row of validRows) {
        const declaration = outcomes.get(row);
        proofs.push(`scripts/qa/cases/outcomes/${row}.ts`);
        for (const cell of Object.values(declaration?.cells ?? {})) {
          if (cell && cell.state !== 'notApplicable' && cell.file) proofs.push(cell.file);
        }
        if (!declaration || personas.some(persona => !declaration.cells[persona] || declaration.cells[persona]?.state === 'pending')) {
          refusals.push(`row is not declared proved on main: ${row}`);
        }
      }
    } catch (error) { refusals.push(`main outcome declarations unavailable: ${String(error)}`); }
    for (const row of validRows) {
      const file = `tests/qa/fixtures/outcomes/${row}.json`;
      if (!existsSync(join(cwd, file)) || !statSync(join(cwd, file)).isFile()) refusals.push(`missing row record: ${file}`);
    }
  }
  const tests = [...new Set(brief.tests ?? [])];
  const units: string[] = [];
  const outcomes: string[] = [];
  const stories: string[] = [];
  for (const file of tests) {
    const local = relative(cwd, resolve(cwd, file));
    if (isAbsolute(file) || local.startsWith('../') || local === '..' || local !== file) {
      refusals.push(`test file outside worktree or not canonical: ${file}`);
    } else if (!existsSync(join(cwd, file)) || !statSync(join(cwd, file)).isFile()) {
      refusals.push(`missing named test file: ${file}`);
    } else if (validRows.some(row => file === `tests/qa/integration/outcomes/${row}.test.ts`)) outcomes.push(file);
    else if (storyFile.test(file) && (file.startsWith('apps/web/') || file.startsWith('packages/ui/'))) stories.push(file);
    else if (unitFile.test(file) && !(file.startsWith('tests/qa/') && !file.startsWith('tests/qa/unit/'))
      && ![isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath].some(classify => classify(file))) units.push(file);
    else refusals.push(`surface test must be a unit test, web *.stories.tsx or its named row outcome test: ${file}`);
  }
  if (!stories.length) refusals.push('surface requires tests: naming at least one web *.stories.tsx');
  const guards = mergeUnitFiles(cwd, 'Affected since surface gate\n', changed);
  try {
    const affected = await affectedSelection(cwd, mainCommit, changed);
    const required = 'plan' in affected
      ? [...unitFilesFromPlan(cwd, affected.plan, changed), ...affected.plan.frontend.flatMap(workspace => workspace.tests)]
      : mergeUnitFiles(cwd, affected.text, changed).filter(file => !guards.includes(file));
    // The change's consumers run beside the named tests: the affected plan knows them, a brief written before the work cannot.
    for (const file of [...new Set(required)].sort()) {
      if (unitFile.test(file) && !guards.includes(file) && !units.includes(file)) units.push(file);
    }
  } catch (error) { refusals.push(`surface unit selection failed: ${String(error)}`); }
  return { refusals, ...(!refusals.length ? { selection: { main: mainCommit, rows, units,
    ...(outcomes.length ? { outcomes } : {}), stories, guards, changed: [...changed], proofs: [...new Set(proofs)] } } : {}) };
}

export type SurfacePart = 'contract' | 'types' | 'lint' | 'ast' | 'tests' | 'guards' | 'stories';
export interface SurfaceTiming { name: SurfacePart; code: number; seconds: number; waitSeconds: number }
export interface SurfaceExcusedTest {
  part: 'tests' | 'guards'; file: string; test: string;
  reason: 'timeout-retry' | 'order-dependent' | 'fails-on-main'; revision: string;
  originalSeconds?: number; retrySeconds?: number;
}
export interface SurfaceRunOptions {
  /** Worker checks narrow static tools; landing retains its full gate. */
  workerStatic?: boolean;
  absoluteInference?: boolean;
  /** Revision already used by the worker's changed-file selection. */
  inferenceBase?: string;
  runner?: CheckRunner;
  print?: (line: string) => void;
  now?: () => number;
  only?: readonly CheckGroup[];
  slotOptions?: Omit<SlotRunOptions, 'runCommand'>;
  gateLaneOptions?: Omit<GateLaneOptions, 'command'>;
  /** Landing commits and verifies generated artifacts using its existing owner. */
  generate?: () => Promise<string | undefined>;
  /** Landing keeps evidence after its worktree is archived and removed. */
  evidenceDirectory?: string;
}

/** Tests and guards share candidate confirmation with the unit gate, then compare untouched failures with main. */
export async function runSurfaceGate(cwd: string, selection: SurfaceSelection, options: SurfaceRunOptions = {}) {
  const root = options.evidenceDirectory ?? join(cwd, '.temp/goal/surface-gate');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  const log = join(directory, 'output.log');
  const evidence = join(directory, 'evidence.json');
  const checks: SurfaceTiming[] = [];
  const excused: SurfaceExcusedTest[] = [];
  const print = options.print ?? console.log;
  const now = options.now ?? Date.now;
  const run = options.runner ?? runCheckCommand;
  const only = options.only ?? ['types', 'lint', 'tests', 'guards'];
  if (only.includes('guards')) print(repositoryGuardSelectionLine(selection.changed, cwd));
  let env = process.env;
  writeFileSync(log, `${JSON.stringify(selection)}\n`);
  async function unitPart(name: 'tests' | 'guards', files: string[]): Promise<{ code: number; output: string }> {
    let output = '';
    let invocation = 0;
    const notes: string[] = [];
    const firstOutputs = new Map<string, string>();
    const rememberFirst = (selected: readonly string[], transcript: string) => {
      for (const file of selected) if (!firstOutputs.has(file)) firstOutputs.set(file, transcript);
    };
    const note = (line: string) => { print(line); notes.push(line); };
    const runShard: UnitShardRunner = async (root, selected, deadline, retryOptions) => {
      const label = `${name}-${invocation++}`;
      if (!options.runner) {
        const owners = new Set(name === 'guards' ? [] : selected.filter(isQaOwnerPath));
        const result = await gateShardRunner(owners, env)(root, selected, deadline, retryOptions);
        rememberFirst(selected, result.output);
        writeFileSync(join(directory, `${label}.log`), result.output);
        output += `\n${root}: ${selected.join(', ')}\n${result.output}\n`;
        return result;
      }
      const artifacts = join(directory, `${label}-artifacts`);
      mkdirSync(artifacts, { recursive: true });
      const report = join(artifacts, 'unit.xml');
      const direct = name === 'guards' || selected.every(file => !isQaOwnerPath(file));
      const started = now();
      const command = name === 'guards' ? ['task', options.workerStatic && 'runRepositoryGuardFiles' in repositoryGuardRunner
        ? 'guards' : 'goal:unit-files', '--'] : ['bun', 'scripts/qa/test.ts'];
      const result = await run([...command, ...selected,
        ...retryOptions?.testTimeoutMultiplier ? [timeoutRetryArg(direct ? 'unit' : 'owner')] : [],
        ...direct ? ['--reporter=junit', `--reporter-outfile=${report}`] : []], root, join(directory, `${label}.log`),
      { ...env, REZICS_QA_ARTIFACT_ROOT: artifacts });
      // Harness tests deliberately fail child stacks. Only this invocation's reports are verdicts.
      const diagnostics = ownerArtifactFiles(artifacts, ['*/logs/owner.log']).map(path => readFileSync(path, 'utf8')).join('\n');
      result.output += `\n${diagnostics}\n${unitArtifactReport(root, ownerArtifactFiles(artifacts,
        direct ? ['unit.xml'] : ['owner.xml', '*/owner.xml']))}`;
      rememberFirst(selected, result.output);
      output += `\n${root}: ${selected.join(', ')}\n${result.output}\n`;
      return completedUnitShard(root, selected, result.code, result.output, now() - started);
    };
    // One surface holds one QA slot; all candidate adjudication uses the unit gate's rule.
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const recovered = new Map<string, number>();
    const branch = await runUnitSide(cwd, files, 'affected', [], runShard, {
      now, shards: 1, historyDirectory: join(directory, 'timeout-history'),
      timeoutRetryPassed: test => {
        recovered.set(`${test.file}\0${test.test}`, test.seconds);
        const original = reportCases(firstOutputs.get(test.file) ?? '', cwd)?.find(item => item.file === test.file && item.name === test.test);
        const originalSeconds = original?.durationMs === undefined ? undefined : original.durationMs / 1000;
        note(`${slowTestLine(test)}; first attempt ${originalSeconds?.toFixed(3) ?? 'unknown'}s, retry ${test.seconds.toFixed(3)}s`);
      },
    });
    for (const file of branch.orderDependent) {
      const first = firstOutputs.get(file) ?? '';
      const recoveredFailures = [
        ...unitFailureDetails(first, [file], cwd),
        ...unitFileErrorDetails(first, [file], cwd).map(error => ({ file: error.file, test: '[file error]' })),
      ];
      for (const failure of recoveredFailures) {
        const retrySeconds = recovered.get(`${file}\0${failure.test}`);
        const original = reportCases(first, cwd)?.find(item => item.file === file && item.name === failure.test);
        excused.push({ part: name, file, test: failure.test,
          reason: retrySeconds === undefined ? 'order-dependent' : 'timeout-retry', revision,
          ...(original?.durationMs === undefined ? {} : { originalSeconds: original.durationMs / 1000 }),
          ...(retrySeconds === undefined ? {} : { retrySeconds }) });
        if (retrySeconds === undefined) note(`Candidate confirmation passed: ${file} > ${failure.test}; order or load dependent, reported, not blocking`);
      }
    }
    if (branch.inconclusive.length) note(`Surface gate unfinished files: ${branch.inconclusive.join(', ')}`);
    if (branch.runnerErrors.length || branch.inconclusive.length) return { code: 1, output: `${output}\n${notes.join('\n')}` };
    const { failing, failures, fileErrors: errors } = branch;
    const changed = new Set(selection.changed);
    const candidates = failing.filter(file => !changed.has(file));
    const blocking = new Set(failing.filter(file => changed.has(file)));
    if (candidates.length) {
      const baseline = mkdtempSync(join(cwd, '.temp/unit-gate-'));
      try {
        await prepareUnitBaseline(cwd, baseline, selection.main, options.runner ? async root => {
          const installed = await run(['task', 'install'], root, join(directory, `${name}-main-install.log`), env);
          output += installed.output;
          if (installed.code) throw new Error(`Unit baseline dependency install failed: ${installed.output}`);
        } : undefined);
        const existing = candidates.filter(file => existsSync(join(baseline, file)));
        for (const file of candidates.filter(file => !existing.includes(file))) blocking.add(file);
        if (existing.length) {
          const main = await runUnitGate(baseline, existing, 1, runShard, { now });
          if (!main.done || main.runnerErrors.length) for (const file of existing) blocking.add(file);
          else {
            const introduced = introducedUnitFailures(existing, failures, main.failures, errors, main.fileErrors);
            for (const file of existing) {
              const ownFailures = failures.filter(item => item.file === file);
              const ownErrors = errors.filter(item => item.file === file);
              if (introduced.some(item => item.file === file) || (!ownFailures.length && !ownErrors.length)) blocking.add(file);
              for (const failure of ownFailures.filter(item => main.failures.some(base => base.file === file && base.test === item.test))) {
                excused.push({ part: name, file, test: failure.test, reason: 'fails-on-main', revision: selection.main });
                note(`Failure on main: ${file} > ${failure.test} (${selection.main}); reported, not blocking`);
              }
              if (!introduced.some(item => item.file === file) && ownErrors.length) {
                note(`Failure on main: ${file} > file error (${selection.main}); reported, not blocking`);
                excused.push({ part: name, file, test: '[file error]', reason: 'fails-on-main', revision: selection.main });
              }
            }
          }
        }
      } finally { removeUnitBaseline(cwd, baseline); }
    }
    return { code: blocking.size ? 1 : 0, output: `${output}\n${notes.join('\n')}` };
  }
  async function part(name: SurfacePart, commands: string[][], waitSeconds = 0): Promise<boolean> {
    const start = now();
    let code = 0;
    let output = '';
    try {
      if (name === 'contract' && options.generate) {
        output = await options.generate() ?? '';
        code = output ? 1 : 0;
      } else if ((name === 'tests' || name === 'guards') && commands.length) {
        const files = name === 'tests' ? selection.units : selection.guards;
        const result = files.length ? await unitPart(name, files) : { code: 0, output: '' };
        code = result.code;
        output = result.output;
        // A Method Surface may capture its own row. Its named outcome proof runs
        // through the stack harness, never through the unit shard or baseline excuses.
        if (!code && name === 'tests' && selection.outcomes?.length) {
          const outcome = await run(['bun', 'scripts/qa/test.ts', ...selection.outcomes], cwd,
            join(directory, 'outcomes.log'), env);
          code = outcome.code;
          output += `\n${outcome.output}`;
        }
      } else for (const command of commands) {
        const commandLog = join(directory, `${name}-${commands.indexOf(command)}.log`);
        const result = options.workerStatic && !options.absoluteInference && command === inferenceGateCommand
          ? await workerInferenceCheck(cwd, commandLog, env, run, print, options.inferenceBase)
          : await run(command, cwd, commandLog, env);
        output += result.output;
        if (result.code) { code = result.code; break; }
      }
    } catch (error) { code = 1; output += `error: ${String(error)}`; }
    const timing = { name, code, seconds: (now() - start) / 1000 + waitSeconds, waitSeconds };
    checks.push(timing);
    const line = `${name}: ${code ? 'failed' : 'ok'} (${timing.seconds.toFixed(1)}s; slot wait ${waitSeconds.toFixed(1)}s)`;
    print(line);
    writeFileSync(log, `${readFileSync(log, 'utf8')}\n${line}\n${output}\n`);
    if (code) for (const line of checkFailureLines(output)) print(line);
    return code === 0;
  }
  const existing = selection.changed.filter(file => existsSync(join(cwd, file)) && statSync(join(cwd, file)).isFile());
  const directories = [...new Set(existing.filter(file => /\.[cm]?[jt]sx?$/.test(file)).map(dirname))].sort();
  const finish = () => {
    const code = checks.some(check => check.code !== 0) ? 1 : 0;
    writeFileSync(evidence, `${JSON.stringify({ code, selection, checks, excused, log }, null, 2)}\n`);
    print(`Surface gate evidence: ${evidence}`);
    print(`Full output: ${log}`);
    return { code, log, evidence, checks };
  };
  if (!await part('contract', [['task', 'gen'], ['task', 'gen:check']])) return finish();
  const staticParts: [SurfacePart, string[][]][] = [
    ...(only.includes('types') ? [['types', [
      ...(options.workerStatic ? workerTypeCommands(cwd, selection.changed) : [['task', 'web:typecheck']]),
      ...(needsInferenceGate(selection.changed) ? [inferenceGateCommand] : []),
    ]] as [SurfacePart, string[][]]] : []),
    ...(only.includes('lint') ? [
      ['lint', directories.length ? [options.workerStatic
        ? ['node_modules/.bin/oxlint', ...existing.filter(file => /\.[cm]?[jt]sx?$/.test(file))]
        : ['node_modules/.bin/oxlint', '--type-aware', ...directories]] : []],
      ['ast', directories.length ? [['task', 'ast-grep', '--', 'scan', ...(options.workerStatic ? existing : directories)]] : []],
    ] as [SurfacePart, string[][]][] : []),
  ];
  for (const [name, commands] of staticParts) {
    const waiting = now();
    const ok = options.workerStatic ? await part(name, commands)
      : await withGateLane(() => part(name, commands, (now() - waiting) / 1000), { ...options.gateLaneOptions, command: `surface ${name}` });
    if (!ok) return finish();
  }
  const waiting = now();
  await withSlot(['surface-gate', ...selection.units, ...(selection.outcomes ?? []), ...selection.guards, ...selection.stories], false, undefined, {
    ...options.slotOptions,
    runCommand: async (_command, slotEnv, onStart) => {
      env = { ...slotEnv, REZICS_QA_ARTIFACT_ROOT: join(directory, 'qa-artifacts') };
      onStart();
      let wait = (now() - waiting) / 1000;
      const parts: [SurfacePart, string[]][] = [
        ...(only.includes('tests') ? [['tests', [...selection.units, ...(selection.outcomes ?? [])]] as [SurfacePart, string[]]] : []),
        ...(only.includes('guards') ? [['guards', selection.guards] as [SurfacePart, string[]]] : []),
        ...(only.includes('tests') ? [['stories', selection.stories] as [SurfacePart, string[]]] : []),
      ];
      for (const [name, files] of parts) {
        if (!await part(name, files.length ? [['bun', 'scripts/qa/test.ts', ...files]] : [], wait)) return 1;
        wait = 0;
      }
      return 0;
    },
  });
  return finish();
}
