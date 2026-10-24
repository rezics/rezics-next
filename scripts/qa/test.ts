import { ensureDependencies } from '../goal/dependencies.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { caseInventory, isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath, isQaOwnerPath, junitResults, unitHarnessFiles, unitOwnerFiles } from './acceptance.ts';
import { affectedPlan, affectedTiers, affectedUnitTierFiles, formatPlan, type AffectedPlan } from './affected.ts';
import { forgetChildScope, noteChildScope, reapChildEnvironment, reapSettleMs, removeScopedContainers } from './container-reaper.ts';
import { formatTierRunLine, goalSlotDirectory, implementedTiers, newRunId, parseArgs, qaArtifactDirectory, qaRunDeadline, sourceIdentity, splitCallerTimeout, testLogEnvironment, tierBunTestArgs, trackCommandProcess, untrackCommandProcess, writeSummary, type QaRunDeadline, type Tier } from './core.ts';
import { isLocalQaRun, qaMemoryDeadline, qaMemoryNeed, waitForMemory } from './memory-admission.ts';
import { STORY_SCREENSHOTS_ENV } from './story-screenshots.ts';
import { assertWideRunAllowed } from '../goal/admission.ts';
import { assertRetainedSources } from './retained-preflight.ts';
import { runHostAdmission } from './host-admission.ts';
import { terminateProcessGroup } from './process/terminate.ts';
import { createCommandOutputRedactor, redactCommandOutput } from '../fixture/command-output.ts';
import { completeFileResults } from './file-results.ts';
import { recordQaFailure, testFailureClass, type FailureClass } from './failure.ts';
import { declaredCaseCoverage } from './coverage.ts';

const root = resolve(import.meta.dir, '../..');
const testFile = /\.(?:test|spec|e2e|stories)\.[cm]?[jt]sx?$/;
const tierOrder = implementedTiers.filter(tier => tier !== 'static');
const borrowedBookFlag = '--borrowed-public-domain-book';
const borrowedBookFile = 'tests/qa/integration/catalogue-real-book-reading.test.ts';

export interface TestGroup {
  /** Registered QA tier. Absent for a Bun file that belongs to none. */
  tier?: Tier;
  files: string[];
  command: [string, string[]];
  borrowedPublicDomainBook?: true;
}

function registeredTier(file: string, unitGates: readonly string[]): Tier | undefined {
  if (isQaIntegrationPath(file)) return 'integration';
  if (isQaModelPath(file)) return 'model';
  if (isQaFaultPath(file)) return 'fault/recovery';
  if (isQaLoadPath(file)) return 'load';
  if (isQaE2ePath(file)) return 'e2e';
  if (isQaOwnerPath(file)) return 'owner';
  if (!file.includes('..') && (file === 'tests/qa/unit' || file.startsWith('tests/qa/unit/')
    || (unitHarnessFiles as readonly string[]).includes(file) || unitGates.includes(file))) return 'unit';
  return undefined;
}

function hostedCommand(tier: Tier, files: string[], id?: string, timeout: readonly string[] = []): [string, string[]] {
  return ['bun', ['scripts/qa/cli.ts', '--tier', tier, ...files.flatMap(file => ['--file', file]),
    ...(id ? ['--id', id] : []), ...timeout]];
}

/** One QA invocation when every file belongs to a tier the runner can host. */
function combinedQaCommand(groups: TestGroup[]): [string, string[]] | undefined {
  if (groups.length < 2 || groups.some(group => !group.tier)) return undefined;
  return ['bun', ['scripts/qa/cli.ts', ...groups.flatMap(group => ['--tier', group.tier!,
    ...group.files.flatMap(file => ['--file', file])])]];
}

export function selectTestGroups(input: string[]): TestGroup[] {
  const { timeout, rest } = splitCallerTimeout(input);
  return selectParsedTestGroups(rest, timeout ?? []);
}

function selectParsedTestGroups(args: string[], timeout: readonly string[] = []): TestGroup[] {
  if (args.some(arg => arg.startsWith(borrowedBookFlag))) {
    if (args.length !== 2 || args.filter(arg => arg === borrowedBookFlag).length !== 1
      || args.filter(arg => arg === borrowedBookFile).length !== 1)
      throw new Error(`${borrowedBookFlag} accepts only ${borrowedBookFile} and one optional --timeout; --result-file belongs to goalctl test`);
    return [{ tier: 'integration', files: [borrowedBookFile], borrowedPublicDomainBook: true,
      command: ['bun', tierBunTestArgs('integration', [borrowedBookFile, ...timeout])] }];
  }
  // Explicit tier runs still pass through goalctl's QA slot.
  if (args[0] === '--tier') {
    parseArgs([...args, ...timeout]);
    return [{ files: [], command: ['bun', ['scripts/qa/cli.ts', ...args, ...timeout]] }];
  }
  const paths = args.filter(arg => testFile.test(arg));
  if (!paths.length) throw new Error('Provide explicit test file paths or --affected; full-suite execution belongs to task qa.');
  const files = paths.map(path => {
    const absolute = resolve(root, path);
    const local = relative(root, absolute).replaceAll('\\', '/');
    if (local.startsWith('..') || isAbsolute(local) || !existsSync(absolute)) {
      throw new Error(`Test file is outside this checkout or missing: ${path}`);
    }
    return local;
  });
  const stories = files.filter(file => file.includes('.stories.'));
  if (stories.length) {
    const workspace = stories[0]!.startsWith('apps/accounts/') ? 'apps/accounts' : 'apps/web';
    if (!stories.every(file => file.startsWith(`${workspace}/`)
      || (workspace === 'apps/web' && file.startsWith('packages/ui/')))) {
      throw new Error('Run each workspace’s stories separately');
    }
    const storyArgs = args.filter(arg => !testFile.test(arg) || arg.includes('.stories.'));
    const ordinaryArgs = args.filter(arg => !arg.includes('.stories.'));
    const ordinaryGroups = stories.length === files.length ? [] : selectParsedTestGroups(ordinaryArgs, timeout);
    return [...ordinaryGroups, { files: stories, command: ['task', [workspace === 'apps/web' ? 'storybook:test' : 'accounts:storybook:test', '--',
      ...storyArgs.map(arg => testFile.test(arg) ? relative(resolve(root, workspace), resolve(root, arg)) : arg),
      ...timeout]] }];
  }
  const tierOf = registeredTier;
  const unitGates = unitOwnerFiles();
  const tier = (file: string) => tierOf(file, unitGates);
  // Unit files and other Bun files keep the direct Bun command until a hosted tier joins them.
  const hosted = new Set<Tier>(['owner', 'integration', 'model', 'fault/recovery', 'e2e', 'load']);
  if (!files.some(file => {
    const name = tier(file);
    return name !== undefined && hosted.has(name);
  })) {
    const allUnit = files.every(file => tier(file) === 'unit');
    return [{ ...(allUnit ? { tier: 'unit' as const } : {}), files,
      command: ['bun', allUnit || timeout.length ? tierBunTestArgs('unit', [...args, ...timeout]) : ['test', ...args]] }];
  }
  const loose = files.filter(file => !tier(file));
  const groups: TestGroup[] = [];
  if (loose.length) groups.push({ files: loose, command: ['bun', timeout.length
    ? tierBunTestArgs('unit', [...loose, ...timeout]) : ['test', ...loose]] });
  for (const name of tierOrder) {
    const tierFiles = files.filter(file => tier(file) === name);
    if (!tierFiles.length) continue;
    groups.push({ tier: name, files: tierFiles,
      command: name === 'unit' ? ['bun', tierBunTestArgs('unit', [...tierFiles, ...timeout])] : hostedCommand(name, tierFiles, undefined, timeout) });
  }
  const other = args.filter(arg => !testFile.test(arg));
  if (other.length) {
    if (groups.length !== 1 || other.length !== 2 || other[0] !== '-t'
      || !/^[A-Z][A-Z0-9]*\d{2,}$/.test(other[1]!)) {
      throw new Error('QA stack selection accepts only -t <acceptance ID>');
    }
    const group = groups[0]!;
    if (group.tier) group.command = hostedCommand(group.tier, group.files, other[1], timeout);
  }
  return groups;
}

function commandsFor(groups: TestGroup[], timeout: readonly string[] = []): [string, string[]][] {
  const combined = combinedQaCommand(groups);
  if (!combined) return groups.map(group => group.command);
  return [timeout.length ? [combined[0], [...combined[1], ...timeout]] : combined];
}

/** The commands `goalctl test` runs. Several registered tiers become one QA invocation. */
export function testCommands(args: string[]): [string, string[]][] {
  return commandsFor(selectTestGroups(args), splitCallerTimeout(args).timeout ?? []);
}

export function selectTestCommand(args: string[]): [string, string[]] {
  const commands = testCommands(args);
  if (commands.length !== 1) throw new Error('A Bun file outside a registered tier runs as its own command');
  return commands[0]!;
}

export function parseAffectedArgs(args: string[]): { ref?: string; list: boolean } | undefined {
  const flag = args.findIndex(arg => arg === '--affected' || arg.startsWith('--affected='));
  if (flag < 0) {
    if (args.includes('--list')) throw new Error('--list requires --affected');
    return undefined;
  }
  let ref = args[flag]!.startsWith('--affected=') ? args[flag]!.slice('--affected='.length) : undefined;
  const next = args[flag + 1];
  const takesNext = ref === undefined && next !== undefined && !next.startsWith('-') && !testFile.test(next);
  if (takesNext) ref = next;
  const rest = args.filter((_, index) => index !== flag && !(takesNext && index === flag + 1));
  const list = rest.includes('--list');
  const unknown = rest.filter(arg => arg !== '--list');
  if (unknown.length) throw new Error(`--affected cannot be combined with ${unknown.join(' ')}; run explicit paths separately`);
  if (ref !== undefined && !/^[A-Za-z0-9._/@^~-]+$/.test(ref)) throw new Error(`Invalid --affected revision: ${ref}`);
  return { ...(ref ? { ref } : {}), list };
}

import { nativeProofOwnerBatches } from './acceptance.ts';

export function affectedCommands(plan: AffectedPlan): { label: string; command: [string, string[]] }[] {
  const commands: { label: string; command: [string, string[]] }[] = [];
  for (const { task } of plan.tasks) commands.push({ label: task, command: ['task', [task]] });
  for (const tier of affectedTiers) {
    const files = plan.tests[tier];
    const widened = plan.widened.some(item => item.tier === tier);
    if (tier === 'unit') {
      // Widened: the registered tier except input-selected native files, plus affected
      // unit tests it does not include. Those native files run only when their own
      // COPY rule matched, as individual files below. An explicit `--tier unit` still
      // runs the full registry.
      if (widened) {
        const files = affectedUnitTierFiles(root);
        commands.push({ label: 'unit (whole tier)', command: ['bun', ['scripts/qa/cli.ts', '--tier', 'unit',
          ...files.flatMap((file) => ['--file', file])]] });
      }
      if (files.length) commands.push({ label: `unit (${files.length} files)`,
        command: ['bun', tierBunTestArgs('unit', files.map(file => `./${file}`))] });
      continue;
    }
    if (tier === 'owner') {
      if (widened) commands.push({ label: 'owner (whole tier)', command: ['bun', ['scripts/qa/cli.ts', '--tier', 'owner']] });
      for (const batch of nativeProofOwnerBatches(files)) {
        commands.push({ label: `owner (${batch.length} files)`,
          command: ['bun', ['scripts/qa/cli.ts', '--tier', 'owner', ...batch.flatMap(file => ['--file', file])]] });
      }
      continue;
    }
    if (widened) {
      commands.push({ label: `${tier} (whole tier)`, command: ['bun', ['scripts/qa/cli.ts', '--tier', tier]] });
      if (files.length) commands.push({ label: `${tier} (${files.length} files)`,
        command: ['bun', ['scripts/qa/cli.ts', '--tier', tier, ...files.flatMap(file => ['--file', file])]] });
    } else if (files.length) {
      commands.push({ label: `${tier} (${files.length} files)`,
        command: ['bun', ['scripts/qa/cli.ts', '--tier', tier, ...files.flatMap(file => ['--file', file])]] });
    }
  }
  for (const checks of plan.frontend) {
    commands.push({ label: `${checks.workspace} type/check`, command: ['task', [checks.check]] });
    if (checks.tests.length) commands.push({ label: `${checks.workspace} unit/component (${checks.tests.length} files)`,
      command: ['bun', ['test', ...checks.tests.map(file => `./${file}`)]] });
  }
  return commands;
}

/** Plain reporter text. A parent that forces color must not reach a child that parses it. */
function withoutForcedColor(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.FORCE_COLOR;
  return next;
}

// Direct Bun runs print only failures and the summary (AGENT=1); JUnit output is
// unchanged and AGENT=0 restores the listing. QA tiers keep full logs, because a
// killed tier otherwise leaves no record of the tests that had finished.
interface BorrowedBookOutput {
  log: string;
  deadline: QaRunDeadline;
  timedOut: boolean;
}

async function run([program, args]: [string, string[]], envOverride?: NodeJS.ProcessEnv,
  borrowed?: BorrowedBookOutput): Promise<number> {
  const spawningTest = program === 'bun' && (args[0] === 'test' || args[0] === 'scripts/qa/cli.ts');
  const inherited = { ...process.env, ...envOverride };
  const base = withoutForcedColor(program === 'bun'
    ? { ...inherited, AGENT: inherited.AGENT ?? '1' }
    : inherited);
  // A borrowed delivery has no container lifecycle owned by this dispatcher.
  const env = borrowed ? withoutForcedColor(testLogEnvironment(inherited)) : spawningTest ? reapChildEnvironment(base) : base;
  const scope = spawningTest && !borrowed ? env.REZICS_REAP_SCOPE : undefined;
  if (borrowed && borrowed.deadline.remainingMs() <= 0) throw new Error('Borrowed Book run deadline reached; no child started');
  noteChildScope(scope);
  // Its own process group, so cancellation can signal the child without signalling this dispatcher.
  const child = Bun.spawn([program, ...args], {
    cwd: root, env, detached: true, stdout: borrowed ? 'pipe' : 'inherit', stderr: borrowed ? 'pipe' : 'inherit',
  });
  if (child.pid) trackCommandProcess(child.pid);
  const capture = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!borrowed || !stream) return;
    const redactor = createCommandOutputRedactor();
    const append = (value: string) => { appendFileSync(borrowed.log, value); process.stderr.write(value); };
    const decoder = new TextDecoder();
    for await (const chunk of stream) append(redactor.push(decoder.decode(chunk, { stream: true })));
    append(redactor.push(decoder.decode()) + redactor.finish());
  };
  const output = borrowed ? Promise.all([capture(child.stdout), capture(child.stderr)]) : undefined;
  let stopping: Promise<void> | undefined;
  const timer = borrowed ? setTimeout(() => {
    borrowed.timedOut = true;
    stopping = terminateProcessGroup(child.pid);
  }, Math.min(borrowed.deadline.remainingMs(), 2_147_483_647)) : undefined;
  try {
    const code = await child.exited;
    await output;
    if (stopping) await stopping;
    if (scope) {
      // A scope with no marker never started a container: skip the settle and the second list.
      let again = false;
      let failed = false;
      try { again = removeScopedContainers(scope); } catch { failed = true; }
      if (again || failed) {
        // dockerd can commit the container after this list, once the killed client is gone.
        await Bun.sleep(reapSettleMs);
        try { removeScopedContainers(scope); } catch { /* the child's exit status still stands */ }
      }
    }
    return code;
  } finally {
    clearTimeout(timer);
    if (child.pid) untrackCommandProcess(child.pid);
    forgetChildScope(scope);
  }
}

export interface TestDispatchOptions {
  retainedPreflight?: typeof assertRetainedSources;
  runner?: typeof run;
  admission?: typeof waitForMemory;
  deadline?: number;
  env?: NodeJS.ProcessEnv;
  borrowedBookPreflight?: () => Promise<void>;
  hostAdmission?: typeof runHostAdmission;
}

async function preflightBorrowedBook(): Promise<void> {
  const { loadPublicDomainCorpus, loadPublicDomainBorrowedBook } = await import('../../tests/qa/support/catalogue-public-domain.ts');
  const corpus = loadPublicDomainCorpus('book');
  loadPublicDomainBorrowedBook(corpus, 'book');
}

/** One explicitly selected original integration file against an already qualified custodian's copy. */
async function dispatchBorrowedBook(group: TestGroup, options: TestDispatchOptions): Promise<number> {
  const env = options.env ?? process.env;
  const artifactRunId = newRunId();
  const directory = resolve(root, env.REZICS_QA_ARTIFACT_ROOT ?? qaArtifactDirectory(root), artifactRunId);
  const logs = join(directory, 'logs'), xml = join(directory, 'integration.xml');
  mkdirSync(logs, { recursive: true });
  const sourceBefore = sourceIdentity(root), started = Date.now();
  const deadline = qaMemoryDeadline(env, options.deadline), clock = qaRunDeadline(deadline, env);
  const output: BorrowedBookOutput = { log: join(logs, 'integration.log'), deadline: clock, timedOut: false };
  writeFileSync(output.log, '');
  let childCode: number | undefined, failureClass: FailureClass | undefined;
  const state: { phase: 'preflight' | 'admission' | 'test' } = { phase: 'preflight' };
  let code = 1;
  const errors: string[] = [];
  try {
    await (options.retainedPreflight ?? assertRetainedSources)(root, group.files);
    await (options.borrowedBookPreflight ?? preflightBorrowedBook)();
    state.phase = 'admission';
    const resume = clock.wait();
    try {
      code = await (options.hostAdmission ?? runHostAdmission)(qaMemoryNeed(root, 'other', undefined, env).host / 2 ** 30,
        group.command.flat(), { root, env, cpu: true, deadline, run: async () => {
          resume();
          // Recheck custody after a possibly long admission wait, before any OAuth or outcome request.
          await (options.borrowedBookPreflight ?? preflightBorrowedBook)();
          state.phase = 'test';
          const command: [string, string[]] = [group.command[0], [...group.command[1],
            '--reporter=junit', `--reporter-outfile=${xml}`]];
          childCode = await (options.runner ?? run)(command, { ...env,
            REZICS_QA_MEMORY_DEADLINE: String(deadline),
            REZICS_QA_RUN_REMAINING_MS: String(Math.ceil(clock.activeRemainingMs())) }, output);
          return childCode;
        } });
    } finally { resume(); }
    if (output.timedOut) { failureClass = 'timeout'; code ||= 1; }
  } catch (error) {
    failureClass = state.phase === 'test' ? 'harness' : 'environment';
    const detail = redactCommandOutput(error instanceof Error ? error.message : String(error));
    errors.push(detail);
    appendFileSync(output.log, `${detail}\n`);
  }
  const completed = completeFileResults(existsSync(xml) ? readFileSync(xml, 'utf8') : '', group.files, 'integration', {
    interrupted: output.timedOut || state.phase !== 'test', elapsedMs: Date.now() - started,
    reason: errors[0] ?? 'Selected borrowed Book file produced no complete results',
  });
  writeFileSync(xml, completed.xml);
  const tests = junitResults(directory, ['integration']);
  const log = readFileSync(output.log, 'utf8');
  if (completed.missing.length || tests.some(test => test.failed)) code ||= 1;
  if (code !== 0) {
    failureClass ??= /TEST PREMISE:/.test(log) ? 'environment' : testFailureClass({ timedOut: output.timedOut, output: log }, tests);
    errors.push(recordQaFailure(failureClass, `borrowed Book integration failed; see logs/integration.log`));
  }
  const sourceAfter = sourceIdentity(root);
  if (sourceBefore.fingerprint !== sourceAfter.fingerprint) {
    code ||= 1;
    failureClass ??= 'harness';
    errors.push(recordQaFailure('harness', 'Source changed during borrowed Book run'));
  }
  const cases = caseInventory(root);
  writeSummary(directory, { runId: artifactRunId, sourceBefore, sourceAfter, partial: true, cases, tests,
    caseCoverage: declaredCaseCoverage(cases), errors, failureClass,
    tiers: [{ name: 'integration', status: code === 0 ? 'passed' : 'failed', elapsedMs: clock.sample().activeElapsedMs,
      ...(failureClass ? { failureClass } : {}) }] });
  writeFileSync(join(directory, 'run-deadline.json'), JSON.stringify(clock.sample(), null, 2) + '\n');
  writeFileSync(join(directory, 'execution.json'), JSON.stringify({ mode: borrowedBookFlag, artifactRunId,
    retainedRunId: env.REZICS_QA_RUN_ID, file: borrowedBookFile, childCode, code, phase: state.phase, failureClass,
    // JUnit and the unmodified log retain body/hook failures; a dispatcher cannot infer an expect site's reach.
    originalOutcomeAssertionReach: state.phase === 'test' ? 'unknown; see JUnit and log' : 'not reached',
    productRevision: env.REZICS_AUDIT_PRODUCT_REVISION, testRevision: env.REZICS_AUDIT_TEST_REVISION,
    frontendRevision: env.REZICS_AUDIT_FRONTEND_REVISION, fixtureGeneration: env.REZICS_AUDIT_FIXTURE_GENERATION,
  }, null, 2) + '\n');
  appendFileSync(join(directory, 'summary.md'), `\nBorrowed delivery: ${env.REZICS_QA_RUN_ID}; artifact run: ${artifactRunId}\nChild exit: ${childCode ?? 'not started'}; phase: ${state.phase}; assertion reach: ${state.phase === 'test' ? 'see JUnit and log' : 'not reached'}\n`);
  console.log(`QA artifacts: ${directory}`);
  console.log(formatTierRunLine('integration', artifactRunId, code === 0 ? 'passed' : 'failed'));
  return code;
}

async function runTierGroups(groups: TestGroup[], options: TestDispatchOptions): Promise<number> {
  const artifactRoot = join(root, '.artifacts', 'qa');
  const lines: string[] = [];
  let failed = false;
  for (const group of groups) {
    const before = new Set(existsSync(artifactRoot) ? readdirSync(artifactRoot) : []);
    const code = await dispatchSelectedTest([group], group.command, options);
    failed ||= code !== 0;
    const created = (existsSync(artifactRoot) ? readdirSync(artifactRoot) : []).filter(name => !before.has(name));
    lines.push(formatTierRunLine(group.tier ?? 'bun', created.length === 1 ? created[0]! : 'no run id',
      code === 0 ? 'passed' : 'failed'));
  }
  console.log(lines.join('\n'));
  return failed ? 1 : 0;
}

/** Explicit stories bypass the stack harness, but their browser workers still need host memory. */
export async function dispatchTest(args: string[], options: TestDispatchOptions = {}): Promise<number> {
  assertWideRunAllowed(['bun', 'scripts/qa/test.ts', ...args], options.env ?? process.env);
  const groups = selectTestGroups(args);
  if (groups[0]?.borrowedPublicDomainBook) return dispatchBorrowedBook(groups[0], options);
  await (options.retainedPreflight ?? assertRetainedSources)(root, groups.flatMap(group => group.files));
  const commands = commandsFor(groups, splitCallerTimeout(args).timeout ?? []);
  if (commands.length !== 1) return runTierGroups(groups, options);
  return dispatchSelectedTest(groups, commands[0]!, options);
}

async function dispatchSelectedTest(groups: TestGroup[], command: [string, string[]], options: TestDispatchOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stories = command[0] === 'task' && ['storybook:test', 'accounts:storybook:test'].includes(command[1][0]!);
  if (stories && await isLocalQaRun(root, env)) {
    const slotDirectory = env.GOAL_QA_SLOT_DIRECTORY ?? goalSlotDirectory(root);
    const admissionEnv: NodeJS.ProcessEnv = { ...env,
      ...(slotDirectory && !env.GOAL_QA_WAIT_DIR ? { GOAL_QA_WAIT_DIR: join(slotDirectory, 'waiters') } : {}),
      GOAL_QA_COMMAND: env.GOAL_QA_COMMAND ?? [command[0], ...command[1]].join(' '),
    };
    await (options.admission ?? waitForMemory)(qaMemoryNeed(root, 'browser', undefined, env), {
      root, env: admissionEnv,
      deadline: qaMemoryDeadline(env, options.deadline),
    });
  }
  const runner = options.runner ?? run;
  if (!stories) return runner(command);
  const runId = newRunId();
  const directory = resolve(root, env.REZICS_QA_ARTIFACT_ROOT ?? qaArtifactDirectory(root), runId);
  const screenshots = join(directory, 'story-screenshots');
  const summary = join(directory, 'summary.md');
  let summaryReady = false;
  let warned = false;
  const artifactWarning = (error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`Warning: story screenshot artifacts ${directory}: ${String(error)}`.replaceAll(/[\r\n]+/g, ' '));
  };
  try {
    mkdirSync(screenshots, { recursive: true });
    writeFileSync(summary, [`# QA ${runId}`, '', `Story files: ${groups[0]!.files.join(', ')}`,
      `Story screenshots: \`${screenshots}\``, ''].join('\n'));
    summaryReady = true;
  } catch (error) { artifactWarning(error); }
  let code: number | undefined;
  try {
    code = await runner(command, { ...env, [STORY_SCREENSHOTS_ENV]: screenshots });
    return code;
  } finally {
    const result = formatTierRunLine(command[1][0]!, runId, code === 0 ? 'passed' : 'failed');
    if (summaryReady) {
      try { appendFileSync(summary, `\n${result}\n`); } catch (error) { artifactWarning(error); }
    }
    console.log(`QA artifacts: ${directory}`);
    console.log(result);
  }
}

export async function runAffected(plan: AffectedPlan, runner = run): Promise<{ failed: boolean; results: string[] }> {
  await assertRetainedSources(root, Object.values(plan.tests).flat());
  const results: string[] = [];
  let failed = false;
  // Every cheap selection runs, so one failure does not hide another workspace's checks.
  for (const { label, command } of affectedCommands(plan)) {
    const code = await runner(command);
    failed ||= code !== 0;
    results.push(`  ${label}: ${code === 0 ? 'passed' : `failed (exit ${code})`}`);
  }
  return { failed, results };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  assertWideRunAllowed(['bun', 'scripts/qa/test.ts', ...args]);
  const affected = parseAffectedArgs(args);
  if (!affected?.list) ensureDependencies(root);
  if (!affected) process.exit(await dispatchTest(args));
  const plan = affectedPlan(root, affected.ref);
  console.log(formatPlan(plan));
  if (affected.list) process.exit(0);
  const { failed, results } = await runAffected(plan);
  if (results.length) console.log(['Affected run:', ...results].join('\n'));
  process.exit(failed ? 1 : 0);
}
