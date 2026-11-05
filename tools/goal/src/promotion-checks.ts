import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { defaultPolicy } from './policy.ts';
import { firstFailure, gateRunner, git } from './merge.ts';
import { stopProcessesUnder } from './process.ts';
import type { PromotionOptions } from './promotion.ts';
import type { PromotionGateResult, PromotionRun, Task } from './types.ts';
import { isPromotionInfrastructureText } from './check-failure.ts';
import {
  beginPromotionGroupWindow,
  finishPromotionGroupWindow,
  linkPromotionParentWindow,
  markPromotionGroupPhase,
  recordPromotionCustodyUnavailable,
} from './promotion-observation.ts';

function observe<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    // Promotion observation is best-effort and can never alter a gate verdict.
    return undefined;
  }
}

export const PROMOTION_GATE_TIMEOUT_MS = defaultPolicy.promotion.gateTimeoutMs;

// Specification and research tasks deliver suites that stay red until a later task binds them; the root gate covers them.
const RED_BY_DESIGN = new Set(['specification', 'research']);
const WORKSPACE = /^(?:apps|services|packages)\/[^/]+|^tools\/goal(?=\/|$)/;
// The root gate runs every workspace's full check and the control plane's gate. A test command confined to those
// trees reruns a subset of it, so a batch of hundreds of tasks costs one root gate plus the few commands that
// reach outside, such as root specs, each run once.
export function coveredByRootGate(command: readonly string[]): boolean {
  if (command[0] === 'bun' && command[1] === 'run' && command[2] === '--cwd' && command[4] === 'check')
    return WORKSPACE.exec(command[3] ?? '')?.[0] === command[3];
  const shell =
    command[0] === 'sh' && command[1] === '-c'
      ? /^cd ((?:apps|services|packages)\/[^/\s]+) && /.exec(command[2] ?? '')
      : null;
  if (shell) return !/[;|]|&&\s*cd\b/.test(command[2]!.slice(shell[0].length));
  if (command[0] !== 'bun' || !command.includes('test')) return false;
  const paths = command.filter((argument) => argument.includes('/'));
  return paths.length > 0 && paths.every((path) => WORKSPACE.test(path));
}
// A plain `bun test` that mixes workspace files with outside ones runs only the outside ones: the root gate already
// ran the workspace files under their own check, and a kernel test run bare has no database and fails on that alone.
export function promotionCommand(command: readonly string[]): string[] | null {
  if (coveredByRootGate(command)) return null;
  if (command[0] !== 'bun' || command[1] !== 'test') return [...command];
  return command.filter((argument) => !(argument.includes('/') && WORKSPACE.test(argument)));
}
export function commandsFor(
  rootGate: readonly string[],
  tasks: readonly Task[],
  checkout: string,
  commit: string,
): string[][] {
  // Promotion gates on correctness: the root gate and the promoted tasks' own acceptance. Capability completion is
  // the completion checker's report on main, never a promotion condition: frozen-red capability suites made every
  // promotion fail before its first command, so main could move only once every In row was complete.
  const commands = new Map<string, string[]>([[JSON.stringify(rootGate), [...rootGate]]]);
  for (const task of tasks) {
    const command = promotionCommand(task.brief.acceptance.command);
    // A specification is red by design whatever class its risk areas route it to; its verifier proves the
    // specification, not the product, and a 20-second red run once blocked a promotion whose root gate passed.
    if (!command || RED_BY_DESIGN.has(task.taskClass) || RED_BY_DESIGN.has(task.brief.kind)) continue;
    if (command.some((argument) => argument.endsWith('specs/support/verify-outcome-suite.ts'))) continue;
    commands.set(JSON.stringify(command), [...command]);
  }
  return [...commands.values()];
}
function resultKey(result: PromotionGateResult): string {
  return `${result.commit}\n${JSON.stringify(result.command)}`;
}
function appendResult(
  run: PromotionRun,
  target: 'headResults' | 'prefixResults',
  result: PromotionGateResult,
): PromotionRun {
  const key = resultKey(result),
    results = run[target];
  const index = results.findIndex((existing) => resultKey(existing) === key);
  if (index < 0) results.push(result);
  else results[index] = result;
  return run;
}

export async function gateAt(
  options: PromotionOptions,
  run: PromotionRun,
  commit: string,
  commands: readonly string[][],
  label: string,
  target: 'headResults' | 'prefixResults',
  force = false,
): Promise<PromotionGateResult[]> {
  const store = options.job.tasks.store,
    main = options.settings.mainCheckout;
  const results: PromotionGateResult[] = [];
  const tree = join(options.settings.worktreeRoot, `promotion-${run.id}-${label}`);
  for (let index = 0; index < commands.length; index++) {
    const command = [...commands[index]!];
    const placementBefore = run.placement;
    let preparedForCache: string[] | null = null;
    let placementPreflightFailed = false;
    try {
      preparedForCache = options.prepareGateCommand?.(run, command) ?? null;
    } catch {
      placementPreflightFailed = true;
    }
    if (preparedForCache) store.savePromotion(run);
    const needsFreshPlacementGate = preparedForCache !== null && placementBefore === undefined;
    const cached =
      force || placementPreflightFailed || needsFreshPlacementGate
        ? undefined
        : run[target].find(
            (result) => result.commit === commit && JSON.stringify(result.command) === JSON.stringify(command),
          );
    if (!cached) break;
    results.push(cached);
    if (!cached.passed) return results;
  }
  if (results.length === commands.length) return results;
  const missingCommands = commands.slice(results.length).map((command) => [...command]);
  const observationWindowId = observe(() =>
    beginPromotionGroupWindow(
      store.db,
      {
        ...(options.observationParentId === undefined ? {} : { parentWindowId: options.observationParentId }),
        promotionId: run.id,
        group: label,
        commit,
        commands: missingCommands,
      },
      options.settings.policy?.promotion,
    ),
  );
  observe(() => linkPromotionParentWindow(store.db, options.observationParentId, run.id));
  observe(() =>
    recordPromotionCustodyUnavailable(store.db, observationWindowId, undefined, options.settings.policy?.promotion),
  );
  observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'wait-ended'));
  observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'admitted'));
  observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'preparation-started'));
  const logFor = (index: number) => join(options.settings.stateDirectory, `promotion-${run.id}-${label}-${index}.log`);
  mkdirSync(options.settings.worktreeRoot, { recursive: true });
  if (existsSync(tree)) {
    try {
      git(main, 'worktree', 'remove', '--force', tree);
    } catch {}
  }
  try {
    git(main, 'worktree', 'add', '--detach', tree, commit);
  } catch (error) {
    observe(() => finishPromotionGroupWindow(store.db, observationWindowId, 'failed', false));
    throw error;
  }
  try {
    mkdirSync(join(tree, '.temp'), { recursive: true });
    results.length = 0;
    // A fresh worktree has no node_modules; only the root gate installs by itself, and a narrowed or acceptance
    // command would fail on every commit without this.
    if (existsSync(join(tree, 'package.json')) && existsSync(join(tree, 'bun.lock'))) {
      const installed = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: tree, encoding: 'utf8' });
      appendFileSync(
        logFor(0),
        `$ bun install --frozen-lockfile (cwd: ${tree})\n${installed.stdout ?? ''}${installed.stderr ?? ''}`,
      );
      if (installed.status !== 0) {
        const result = {
          commit,
          command: [...commands[0]!],
          passed: false,
          timedOut: false,
          firstFailure: firstFailure(
            `bun install --frozen-lockfile failed: ${installed.stderr || installed.error?.message || ''}`,
          ),
        };
        appendResult(run, target, result);
        store.savePromotion(run);
        observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'preparation-ended'));
        observe(() => finishPromotionGroupWindow(store.db, observationWindowId, 'failed', false));
        return [result];
      }
    }
    let executionStarted = false;
    let preparationEnded = false;
    for (let index = 0; index < commands.length; index++) {
      const command = [...commands[index]!];
      const cached = force
        ? undefined
        : run[target].find(
            (result) => result.commit === commit && JSON.stringify(result.command) === JSON.stringify(command),
          );
      if (cached) {
        results.push(cached);
        if (!cached.passed) break;
        continue;
      }
      let result: PromotionGateResult;
      try {
        const prepared = options.prepareGateCommand?.(run, command) ?? null;
        const executionCommand = prepared ?? command;
        store.savePromotion(run);
        if (!preparationEnded) {
          observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'preparation-ended'));
          preparationEnded = true;
        }
        if (!executionStarted) {
          observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'execution-started'));
          executionStarted = true;
        }
        const outcome = await (
          options.runGate ?? gateRunner((options.settings.policy ?? defaultPolicy).promotion.gateTimeoutMs)
        )(executionCommand, tree, logFor(index));
        observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'execution-ended'));
        let failure = outcome.passed ? undefined : firstFailure(outcome.output);
        if (git(tree, 'rev-parse', 'HEAD') !== commit || git(tree, 'status', '--porcelain'))
          failure = firstFailure(`${failure?.assertion ?? ''}\nGate changed the checked commit or worktree`);
        result = {
          commit,
          command,
          passed: outcome.passed && !failure,
          timedOut: outcome.timedOut,
          ...(failure ? { firstFailure: failure } : {}),
        };
      } catch (error) {
        if (!preparationEnded) {
          observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'preparation-ended'));
          preparationEnded = true;
        }
        if (executionStarted) observe(() => markPromotionGroupPhase(store.db, observationWindowId, 'execution-ended'));
        result = { commit, command, passed: false, timedOut: false, firstFailure: firstFailure(String(error)) };
      }
      results.push(result);
      appendResult(run, target, result);
      store.savePromotion(run);
      // The first failure decides the run; later commands on a broken commit only cost time.
      if (!result.passed) break;
    }
    const failure = results.find((result) => !result.passed);
    observe(() =>
      finishPromotionGroupWindow(
        store.db,
        observationWindowId,
        failure ? 'failed' : 'passed',
        failure?.timedOut ?? false,
      ),
    );
  } finally {
    await stopProcessesUnder(tree, options.settings.terminationGraceMs, undefined, options.settings.policy?.process);
    git(main, 'worktree', 'remove', '--force', tree);
  }
  return results;
}

function infrastructureFailure(
  options: PromotionOptions,
  run: PromotionRun,
  result: PromotionGateResult,
  index: number,
): boolean {
  if (result.timedOut) return true;
  const path = join(options.settings.stateDirectory, `promotion-${run.id}-head-${index}.log`);
  const text = `${result.firstFailure?.assertion ?? ''}\n${existsSync(path) ? readFileSync(path, 'utf8') : ''}`;
  return isPromotionInfrastructureText(text);
}

function stabilizeRetryCommands(
  options: PromotionOptions,
  run: PromotionRun,
  failed: PromotionGateResult,
  index: number,
): string[][] {
  if (JSON.stringify(failed.command) !== JSON.stringify(run.rootGate)) return [[...failed.command]];
  const path = join(options.settings.stateDirectory, `promotion-${run.id}-head-${index}.log`);
  if (!existsSync(path)) return [[...failed.command]];
  const log = readFileSync(path, 'utf8');
  const workspaces = (log.match(/^Failed workspaces:\s*(.+)$/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const unique = [...new Set(workspaces.filter((workspace) => /^(?:apps|services|packages)\/[^/]+$/.test(workspace)))];
  return unique.length ? unique.map((workspace) => ['bun', 'run', '--cwd', workspace, 'check']) : [[...failed.command]];
}

export async function rerunStabilizeInfrastructure(
  options: PromotionOptions,
  run: PromotionRun,
  result: PromotionGateResult[],
  commands: readonly string[][],
): Promise<PromotionGateResult[]> {
  const initial = result.find((item) => !item.passed);
  if (!initial || !infrastructureFailure(options, run, initial, result.indexOf(initial))) return result;
  const failedIndex = result.indexOf(initial);
  // Every rerun command must pass, and the commands the first failure kept from running still run afterwards: a
  // passing first rerun once hid another workspace's failure and skipped the acceptance commands after the gate.
  let pending = stabilizeRetryCommands(options, run, initial, failedIndex);
  const passed: PromotionGateResult[] = [];
  let current = initial;
  for (
    let attempt = 1;
    attempt <= (options.settings.policy ?? defaultPolicy).promotion.infrastructureReruns && pending.length;
    attempt++
  ) {
    const label = `head-infrastructure-rerun-${attempt}`;
    const reruns = await gateAt(options, run, run.devHead, pending, label, 'headResults', true);
    if (!reruns.length) break;
    run.infrastructureReruns = [
      ...(run.infrastructureReruns ?? []),
      ...reruns.map((rerun) => ({
        kind: 'promotion-infrastructure-rerun' as const,
        commit: run.devHead,
        command: [...rerun.command],
        attempt,
        initial: current,
        result: rerun,
        log: join(options.settings.stateDirectory, `promotion-${run.id}-${label}-0.log`),
      })),
    ];
    options.job.tasks.store.savePromotion(run);
    const failed = reruns.find((rerun) => !rerun.passed);
    passed.push(...reruns.filter((rerun) => rerun.passed));
    if (!failed && reruns.length === pending.length) {
      const remaining = commands.slice(failedIndex + 1);
      const rest = remaining.length
        ? await gateAt(options, run, run.devHead, remaining, 'head-after-infrastructure-rerun', 'headResults')
        : [];
      return [...result.slice(0, failedIndex), ...passed, ...rest];
    }
    if (!failed) break;
    current = failed;
    pending = pending.slice(reruns.indexOf(failed));
    if (!failed.timedOut && !isPromotionInfrastructureText(failed.firstFailure?.assertion ?? '')) break;
  }
  return [...result.slice(0, failedIndex), ...passed, current];
}
