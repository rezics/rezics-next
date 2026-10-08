import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath, isQaOwnerPath } from './acceptance.ts';
import { affectedPlan, affectedTiers, affectedUnitTierFiles, formatPlan, type AffectedPlan } from './affected.ts';
import { forgetChildScope, noteChildScope, reapChildEnvironment, reapSettleMs, removeScopedContainers } from './container-reaper.ts';
import { goalSlotDirectory, parseArgs, trackCommandProcess, untrackCommandProcess } from './core.ts';
import { isLocalQaRun, qaMemoryDeadline, qaMemoryNeed, waitForMemory } from './memory-admission.ts';

const root = resolve(import.meta.dir, '../..');
const testFile = /\.(?:test|spec|e2e|stories)\.[cm]?[jt]sx?$/;

export function selectTestCommand(args: string[]): [string, string[]] {
  // Explicit tier runs still pass through goalctl's QA slot.
  if (args[0] === '--tier') {
    parseArgs(args);
    return ['bun', ['scripts/qa/cli.ts', ...args]];
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
    if (stories.length !== files.length || !stories.every(file => file.startsWith(`${workspace}/`)
      || (workspace === 'apps/web' && file.startsWith('packages/ui/')))) {
      throw new Error('Run each workspace’s stories separately from other tests');
    }
    return ['task', [workspace === 'apps/web' ? 'storybook:test' : 'accounts:storybook:test', '--',
      ...args.map(arg => testFile.test(arg) ? relative(resolve(root, workspace), resolve(root, arg)) : arg)]];
  }
  const integration = files.filter(isQaIntegrationPath);
  const model = files.filter(isQaModelPath);
  const fault = files.filter(isQaFaultPath);
  const load = files.filter(isQaLoadPath);
  const e2e = files.filter(isQaE2ePath);
  const owner = files.filter(file => isQaOwnerPath(file) && !integration.includes(file) && !model.includes(file)
    && !fault.includes(file) && !load.includes(file) && !e2e.includes(file));
  if (!integration.length && !model.length && !fault.length && !load.length && !e2e.length && !owner.length) return ['bun', ['test', ...args]];
  if (integration.length + model.length + fault.length + load.length + e2e.length + owner.length !== files.length
    || [integration, model, fault, load, e2e, owner].filter(group => group.length).length !== 1) {
    throw new Error('Run registered QA integration, model, fault/recovery, load, e2e and other test files in separate commands');
  }
  const other = args.filter(arg => !testFile.test(arg));
  let id: string | undefined;
  if (other.length) {
    if (other.length !== 2 || other[0] !== '-t'
      || !/^[A-Z][A-Z0-9]*\d{2,}$/.test(other[1]!)) {
      throw new Error('QA stack selection accepts only -t <acceptance ID>');
    }
    id = other[1];
  }
  return ['bun', ['scripts/qa/cli.ts', '--tier', owner.length ? 'owner' : model.length ? 'model' : fault.length ? 'fault/recovery' : load.length ? 'load' : e2e.length ? 'e2e' : 'integration',
    ...files.flatMap(file => ['--file', file]), ...(id ? ['--id', id] : [])]];
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
        command: ['bun', ['test', ...files.map(file => `./${file}`)]] });
      continue;
    }
    if (widened) {
      commands.push({ label: `${tier} (whole tier)`, command: ['bun', ['scripts/qa/cli.ts', '--tier', tier]] });
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
async function run([program, args]: [string, string[]]): Promise<number> {
  const spawningTest = program === 'bun' && (args[0] === 'test' || args[0] === 'scripts/qa/cli.ts');
  const base = withoutForcedColor(program === 'bun'
    ? { ...process.env, AGENT: process.env.AGENT ?? '1' }
    : process.env);
  const env = spawningTest ? reapChildEnvironment(base) : base;
  const scope = spawningTest ? env.REZICS_REAP_SCOPE : undefined;
  noteChildScope(scope);
  // Its own process group, so cancellation can signal the child without signalling this dispatcher.
  const child = Bun.spawn([program, ...args], {
    cwd: root, env, detached: true, stdout: 'inherit', stderr: 'inherit',
  });
  if (child.pid) trackCommandProcess(child.pid);
  try {
    const code = await child.exited;
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
    if (child.pid) untrackCommandProcess(child.pid);
    forgetChildScope(scope);
  }
}

export interface TestDispatchOptions {
  runner?: typeof run;
  admission?: typeof waitForMemory;
  deadline?: number;
  env?: NodeJS.ProcessEnv;
}

/** Explicit stories bypass the stack harness, but their browser workers still need host memory. */
export async function dispatchTest(args: string[], options: TestDispatchOptions = {}): Promise<number> {
  const command = selectTestCommand(args);
  const env = options.env ?? process.env;
  if (command[0] === 'task' && ['storybook:test', 'accounts:storybook:test'].includes(command[1][0]!)
    && await isLocalQaRun(root, env)) {
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
  return (options.runner ?? run)(command);
}

export async function runAffected(plan: AffectedPlan, runner = run): Promise<{ failed: boolean; results: string[] }> {
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
  const affected = parseAffectedArgs(args);
  if (!affected) process.exit(await dispatchTest(args));
  const plan = affectedPlan(root, affected.ref);
  console.log(formatPlan(plan));
  if (affected.list) process.exit(0);
  const { failed, results } = await runAffected(plan);
  if (results.length) console.log(['Affected run:', ...results].join('\n'));
  process.exit(failed ? 1 : 0);
}
