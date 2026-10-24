import { type Brief, DEFAULT_ENGINE, BRIEF_KINDS, HOLDING, type Task, type Ledger, isClaudeCode, isCodex, modelOf, programOf, engineOf, MAX_CAPACITY_CONTINUATIONS, MAX_TRANSPORT_CONTINUATIONS, type Attempt, type Engine, effortsOf } from './types.ts';
import { assertClaudeCapacity, assertPreviousClaudeExited, type CapacityTask } from './claude-capacity.ts';
import { root, withLedger, briefGoal, briefClaimConflicts, areasOf, activeGoals, stateDir, git, managerOf, readLedger, pidAlive, claimingTasks, assertOwner, acquireDir, briefPathOf, landScope, archiveClosedBriefs, preserveTaskOutputs, treeMentions, archiveDirOf, archiveFiles, removeFromTree, ARCHIVE_BRANCH, REGENERATION_COMMIT_SUBJECT } from './ledger.ts';
import { pathToFileURL } from 'node:url';
import { drainManagerCommits } from './manager-commit.ts';
import { join, resolve, basename, relative, dirname, posix } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, readlinkSync, renameSync } from 'node:fs';
import { parseBrief, validateBrief, mechanismSectionErrors, areaConflicts, validGoalSlug, goalFile, GOALS_DIR, HISTORY_EXEMPT, nextTaskId, goalBriefFile } from './briefs.ts';
import { launchGates, briefFile, launch, workerPrompt, lastAttempt, taskOf, readResult, capacityRefusal, transportDrop, transportContinuations, transportContinuationPrompt, handoffContinuations, hasHandoff, cleanSessionEnd, changedFiles, elapsed, describe, running } from './launch.ts';
import { postgresSocketRefusal, physicalPath } from './postgres-socket.ts';
import { describeAccount } from './usage.ts';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { clearRefusal, mergeTask } from './merge.ts';
import { cellReading, latestConfirmation, type ConfirmationRecord } from './confirmed.ts';
import { land, handoffResult, restoreLandingRebase } from './land.ts';
import { COMPOSITION_ROOTS } from './composition-roots.ts';
import { dispatchEngine, prepareHandover, stageHandover, handoverPrompt, strayFiles } from './handover.ts';
import { blockedAttemptUnchanged, recordResumeHead, updateResumeWorktree } from './resume.ts';
import type { GateLaneOptions } from './qa-slots.ts';
import { gateRefusal } from './queue.ts';
import { parkedOnJob } from './job.ts';
import { processIdentity } from '../qa/process/identity.ts';
import { GoalMailStore } from './mail.ts';

/** Declarations and their test registrations belong to the outcomes loader, not to orchestration. */
export async function dispatchMethodErrors(brief: Brief, markdown: string, outcomeRoot = root,
  confirmation: ConfirmationRecord | undefined = latestConfirmation(stateDir)): Promise<string[]> {
  if (brief.kind === 'implementation') {
    if (!brief.rows?.length) return ['implementation brief needs at least one row in rows; tasks with no row are tooling or mechanism'];
    const owner = await import(pathToFileURL(join(outcomeRoot, 'scripts/qa/cases/outcomes.ts')).href);
    const { loadOutcomes, personas } = owner as typeof import('../qa/cases/outcomes.ts');
    const outcomes = await loadOutcomes({ root: outcomeRoot });
    const errors: string[] = [];
    for (const id of brief.rows) {
      const declaration = outcomes.get(id);
      if (!declaration) { errors.push(`implementation row ${id}: outcome declaration is missing`); continue; }
      const missing = personas.filter(persona => !declaration.cells[persona]);
      if (missing.length) errors.push(`implementation row ${id}: missing persona cells: ${missing.join(', ')}`);
      // The scheduled run on main is the judge: a declared proved cell it read as failed is reopened, and its repair is admitted.
      const reopened = confirmation?.outcomes.some(cell => cell.rowId === id && cellReading(cell) === 'failed') ?? false;
      if (!reopened && !personas.some(persona => declaration.cells[persona]?.state === 'pending')) {
        errors.push(`implementation row ${id}: needs at least one pending persona cell, or a cell the last scheduled run on main read as failed`);
      }
    }
    return errors;
  }
  if (brief.kind === 'mechanism') {
    const section = /^## Design note[ \t]*\r?\n([\s\S]*?)(?=^## (?!#)|$(?![\s\S]))/m.exec(markdown)?.[1] ?? '';
    const reviewMarker = /^(?:-\s+)?(?:Reviewed|Read by program):[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*\r?$/m.exec(section);
    const date = reviewMarker?.[1];
    const timestamp = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
    const dated = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
    if (!dated || !section.replace(reviewMarker?.[0] ?? '', '').trim()) {
      return ['mechanism brief needs a non-empty ## Design note with Reviewed: YYYY-MM-DD'];
    }
  }
  return [];
}

/** A dispatch interrupted before publishing its task may leave only a clean checkout of main. */
export function removeDispatchLeftover(ledger: Ledger, id: string, worktree: string, branch: string): void {
  if (!existsSync(worktree)) return;
  const refusal = `${worktree} already exists; remove it or use another ID`;
  if (ledger.tasks[id] || Object.values(ledger.tasks).some(task => task.worktree === worktree || task.branch === branch)
    || git(worktree, ['symbolic-ref', '--quiet', 'HEAD'], true) !== `refs/heads/${branch}`
    || git(root, ['rev-list', '--count', `main..${branch}`], true) !== '0'
    || git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') throw new Error(refusal);
  git(root, ['worktree', 'remove', worktree]);
  git(root, ['branch', '-D', branch]);
}

/** Cross-Goal results are repository files on main, independent of task ledgers and working trees. */
export function neededFileWaits(brief: Brief): string[] {
  return (brief.needs ?? []).filter(path => spawnSync('git', ['cat-file', '-e', `main:${posix.normalize(path)}`],
    { cwd: root, encoding: 'utf8' }).status !== 0).map(path => `${brief.id} needs ${path}, which is absent from main`);
}

export async function dispatch(briefPath: string, flags: Set<string>, overrideEngine?: string): Promise<void> {
  if (!briefPath) throw new Error('Usage: goalctl dispatch <G-id|brief.md> [--engine <engine>] [--dry-run]');
  let absolute = resolve(briefPath);
  if (/^G-\d{3,}$/.test(briefPath)) {
    const goal = briefGoal(readLedger(), absolute);
    if (!goal) throw new Error(`dispatch ${briefPath} needs an active Goal; set GOAL_ID or pass a brief path`);
    absolute = join(root, goalBriefFile(goal, briefPath));
  }
  const text = readFileSync(absolute, 'utf8');
  const brief = parseBrief(text);
  if (overrideEngine !== undefined) brief.engine = overrideEngine;
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text)];
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  const methodErrors = await dispatchMethodErrors(brief, text);
  if (methodErrors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${methodErrors.join('\n  ')}`);
  const handover = await prepareHandover(brief, text);
  const reservation = await withLedger(ledger => {
    if (ledger.tasks[brief.id]) throw new Error(`${brief.id} already exists (${ledger.tasks[brief.id]!.state}); use resume`);
    const goal = briefGoal(ledger, absolute);
    const reservedBy = ledger.reserved?.[brief.id];
    if (reservedBy && reservedBy !== goal) throw new Error(`${brief.id} is reserved for Goal ${reservedBy}; take an ID with \`new\``);
    const tasks = Object.values(ledger.tasks);
    const conflicts = briefClaimConflicts(brief, tasks, goal);
    if (!flags.has('--allow-area')) conflicts.push(...areaConflicts(brief.paths, goal, areasOf(activeGoals(ledger))));
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    for (const id of brief.depends) {
      const dependency = ledger.tasks[id];
      if (!dependency) {
        throw new Error(`Unknown dependency ${id}; cross-Goal dependencies are contracts on the program's board `
          + '(docs/goals/program/state.md), not task IDs');
      }
      if (!['merged', 'verified'].includes(dependency.state)) {
        throw new Error(`${brief.id} depends on ${id}, which is ${dependency.state}`);
      }
    }
    const needs = neededFileWaits(brief);
    if (needs.length) throw new Error(needs.join('\n'));
    const engine = dispatchEngine(brief.engine ?? DEFAULT_ENGINE);
    assertClaudeCapacity(engine, brief, ledger);
    const { live, limit, usage, account } = admitWorkers(tasks, engine, flags.has('--force-usage'));
    const name = brief.worktree ? `${goal ?? 'legacy'}-${brief.worktree}` : brief.id.toLowerCase();
    const worktree = join(root, '.temp', 'worktrees', name);
    const socket = postgresSocketRefusal(physicalPath(worktree));
    if (socket) throw new Error(socket);
    const branch = `goal/${name}`;
    if (brief.worktree && tasks.some(task => task.worktree === worktree && HOLDING.includes(task.state) && task.goal !== goal)) {
      throw new Error(`${worktree} has open tasks belonging to another Goal; use a different shared worktree`);
    }
    if (flags.has('--dry-run')) {
      console.log(`${brief.id}: claims ok; ${live}/${limit} live; ${account ? describeAccount(account) : `Claude usage ${usage.level}`}`);
      return;
    }
    const preparing = tasks.find(task => task.worktree === worktree && task.state === 'starting');
    if (preparing) throw new Error(`${worktree} is being prepared by ${preparing.id}; try again after its launch`);
    const reuse = brief.worktree !== undefined && existsSync(worktree);
    const cleanupLedger = { ...ledger, tasks: { ...ledger.tasks } };
    const { worktree: _shared, ...claims } = brief;
    const task: Task = { ...claims, engine, brief: absolute, worktree, branch, base: '',
      state: 'starting', attempts: [], preparer: processIdentity(process.pid) ?? { pid: process.pid },
      ...brief.worktree ? { worktreeName: brief.worktree } : {},
      ...goal ? { goal } : {}, historyGate: true };
    ledger.tasks[brief.id] = task;
    ledger.lastId = Math.max(ledger.lastId ?? 0, Number(brief.id.slice(2)));
    ledger.startedAt ??= new Date().toISOString();
    return { task, reuse, cleanupLedger };
  });
  if (!reservation) return;
  const { task, reuse, cleanupLedger } = reservation;
  const { worktree, branch, engine = DEFAULT_ENGINE } = task;
  try {
    // The published starting task holds its claims and width while preparation does I/O.
    if (!reuse) removeDispatchLeftover(cleanupLedger, brief.id, worktree, branch);
    mkdirSync(join(stateDir, 'runs', brief.id), { recursive: true });
    if (!reuse) {
      // A shared branch outlives its worktree once its last task closes; reattach to it.
      const branchExists = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true) !== '';
      git(root, branchExists && brief.worktree !== undefined ? ['worktree', 'add', '-q', worktree, branch]
        : ['worktree', 'add', '-q', worktree, '-b', branch, 'main']);
      const install = spawnSync('corepack', ['yarn', 'install', '--immutable'], { cwd: worktree, encoding: 'utf8' });
      writeFileSync(join(stateDir, 'runs', brief.id, 'install.log'), `${install.stdout}\n${install.stderr}`);
      if (install.status !== 0) throw new Error(`yarn install failed in ${worktree}; see runs/${brief.id}/install.log`);
    }
    task.base = reuse ? git(worktree, ['merge-base', 'HEAD', 'main']) : git(worktree, ['rev-parse', 'HEAD']);
    mkdirSync(join(worktree, '.temp', 'goal'), { recursive: true });
    writeFileSync(join(worktree, briefFile({ ...task, shared: !!task.worktreeName })), text);
    stageHandover(worktree, handover);
    await withLedger(async ledger => {
      const current = taskOf(ledger, brief.id);
      if (current.state !== 'starting') throw new Error(`${brief.id} is no longer being prepared (${current.state})`);
      const manager = managerOf(ledger, task.goal);
      current.base = task.base;
      current.attempts.push(launch(current, brief.effort, isClaudeCode(engine) ? randomUUID() : '',
        await workerPrompt(current, manager, engine, current.effort, handover), false, manager, engine));
      current.state = 'running';
      delete current.preparer;
      if (ledger.reserved) delete ledger.reserved[brief.id];
      console.log(`${brief.id} started: ${modelOf(engine)}/${brief.effort} pid ${lastAttempt(current).pid} in ${worktree}`);
      console.log(`Next: run \`bun scripts/goal/goalctl.ts wait ${brief.id}\` in the background.`);
    });
  } catch (error) {
    await withLedger(ledger => {
      if (ledger.tasks[brief.id]?.state === 'starting') delete ledger.tasks[brief.id];
    });
    throw error;
  }
}

/** A preparation has no worker pid yet, but has already consumed admission capacity. */
export function admitWorkers(tasks: Task[], engine: Engine, forceUsage: boolean) {
  const live = tasks.filter(task => task.state === 'starting' || running(task)).length;
  const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
  if (live >= limit) throw new Error(`Concurrency limit reached: ${live}/${limit} live workers`);
  return { ...launchGates(tasks, engine, forceUsage), live };
}

function assertPrepared(task: Task): void {
  if (task.state === 'starting') throw new Error(`${task.id} is being prepared; try again after its launch`);
}

/** The worker exit decision is shared by wait and the coordinator's settlement pass. */
export async function finishAttempt(id: string, attemptNumber: number) {
  const watching = lastAttempt(taskOf(readLedger(), id));
  const result = readResult(watching);
  const refusedTurn = capacityRefusal(watching);
  return await withLedger(async ledger => {
    const current = taskOf(ledger, id);
    const last = lastAttempt(current);
    if (last.n !== attemptNumber) return { kind: 'replaced' as const, task: current };
    if (current.waitingResume || (current as CapacityTask).claudeCapacity?.pause) return { kind: 'replaced' as const, task: current };
    last.endedAt ??= new Date().toISOString();
    if (result.session && !last.session) last.session = result.session;
    if (parkedOnJob(current, last.n, result.text)) {
      if (current.state === 'running') current.state = 'exited';
      return { kind: 'ended' as const, task: current, repeated: false, refused: undefined };
    }
    // Status may already have marked a dead pid exited. A stop or a close still stands.
    const open = current.state === 'running' || current.state === 'exited';
    const drop = transportDrop(last);
    let refused: string | undefined;
    if (refusedTurn && open && last.session && transportContinuations(current, 'capacity') < MAX_CAPACITY_CONTINUATIONS) {
      const engine = engineOf(last);
      try {
        admitWorkers(Object.values(ledger.tasks), engine, false);
        const next = launch(current, last.effort, last.session,
          'The service refused your last request for capacity; nothing else changed. Continue where you stopped.',
          true, managerOf(ledger, current.goal), engine, 'continuation');
        next.continuedFor = 'capacity';
        current.attempts.push(next);
        current.engine = engine;
        current.state = 'running';
        clearRefusal(current);
        return { kind: 'continued' as const, task: current, next };
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
    }
    if (drop && open && transportContinuations(current) < MAX_TRANSPORT_CONTINUATIONS) {
      const engine = engineOf(last);
      const effort = last.effort;
      // A refused gate or a failed start must still record this attempt as ended.
      try {
        admitWorkers(Object.values(ledger.tasks), engine, false);
        const manager = managerOf(ledger, current.goal);
        const session = isClaudeCode(engine) ? randomUUID() : '';
        const prompt = `${await workerPrompt(current, manager, engine, effort)}\n\n${transportContinuationPrompt(changedFiles(current).dirty)}`;
        const next = launch(current, effort, session, prompt, false, manager, engine, 'continuation');
        next.continuedFor = 'transport';
        current.attempts.push(next);
        current.engine = engine;
        current.state = 'running';
        clearRefusal(current);
        return { kind: 'continued' as const, task: current, next };
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
    }
    if (open && !refusedTurn && !drop && !hasHandoff(result.text) && cleanSessionEnd(last)
      && last.session && handoffContinuations(current) === 0) {
      const engine = engineOf(last);
      try {
        admitWorkers(Object.values(ledger.tasks), engine, false);
        const next = launch(current, last.effort, last.session,
          'The turn ended before the handoff; nothing else changed. A command you started may have ended meanwhile. '
          + 'Continue your work and finish with the handoff. If a command is still running, wait with one call using yield_time_ms: 300000.',
          true, managerOf(ledger, current.goal), engine, 'continuation');
        next.continuedFor = 'handoff';
        current.attempts.push(next);
        current.engine = engine;
        current.state = 'running';
        clearRefusal(current);
        return { kind: 'continued' as const, task: current, next };
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
    }
    const repeated = drop && open && transportContinuations(current) >= MAX_TRANSPORT_CONTINUATIONS;
    if (current.state === 'running') { current.state = 'exited'; clearRefusal(current); }
    return { kind: 'ended' as const, task: current, repeated, refused };
  });
}

function reportAttempt(task: Task, watching: Attempt, continued: boolean, strays: readonly string[]): void {
  const result = readResult(watching);
  console.log(`${task.id} attempt ${watching.n} ended after ${elapsed(watching.startedAt)}`
    + `${result.error ? ' WITH ERROR' : ''}${result.cost !== undefined ? `; cost $${result.cost.toFixed(2)}` : ''}`
    + `${result.tokens ? `; ${modelOf(engineOf(watching))} tokens ${result.tokens}` : ''}`);
  if (continued) return;
  if (strays.length) console.log(`stray writes in the main checkout:\n  ${strays.join('\n  ')}`);
  console.log(describe(task));
  if (transportDrop(watching) && transportContinuations(task) >= MAX_TRANSPORT_CONTINUATIONS) console.log(`${task.id} stopped after repeated transport errors`);
  console.log(`--- handoff ---\n${result.text.length > 8000 ? `${result.text.slice(0, 8000)}\n[truncated]` : result.text}`);
}

export async function waitFor(id: string, options: { pollMs?: number; settleMs?: number; capacityWaitMs?: number } = {}): Promise<void> {
  // A killed waiter must never record the worker as ended.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => process.exit(143));
  const { settleTask } = await import('./settle.ts');
  const initial = taskOf(readLedger(), id);
  assertPrepared(initial);
  let watching = lastAttempt(initial);
  for (;;) {
    const alive = () => pidAlive(watching.pid, programOf(engineOf(watching)));
    while (alive() || (await Bun.sleep(options.settleMs ?? 3000), alive())) await Bun.sleep(options.pollMs ?? 5000);
    const strays = strayFiles(taskOf(readLedger(), id));
    await settleTask(id, { capacityWaitMs: options.capacityWaitMs });
    let task = taskOf(readLedger(), id);
    while (lastAttempt(task).n === watching.n && task.settlement?.attempt === watching.n && !task.settlement.settledAt) {
      await Bun.sleep(options.pollMs ?? 5000);
      await settleTask(id, { capacityWaitMs: options.capacityWaitMs });
      task = taskOf(readLedger(), id);
    }
    const next = lastAttempt(task);
    reportAttempt(task, watching, next.n !== watching.n && !!next.continuedFor, strays);
    if (next.n !== watching.n) {
      if (next.continuedFor) console.log(next.continuedFor === 'capacity'
        ? `${task.id} resumed by itself after a capacity refusal; same ${modelOf(engineOf(next))} session, pid ${next.pid}`
        : next.continuedFor === 'handoff'
          ? `${task.id} continued by itself after a turn ended before the handoff; same ${modelOf(engineOf(next))} session, pid ${next.pid}`
        : `${task.id} continued by itself after a transport error; fresh ${modelOf(engineOf(next))}/${next.effort} session, pid ${next.pid}`);
      watching = next;
      continue;
    }
    if (task.settlement?.reason) console.log(task.settlement.reason);
    return;
  }
}

/** Records that the holders of `files` lend them to task `id`, so its landing may carry hunks in files another
 * open task claims. Only the Goal of every claiming task, or the program, may lend: the claim is theirs. */
export async function lendFiles(id: string, files: string[]): Promise<void> {
  if (!files.length) throw new Error('loan needs at least one path');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (!HOLDING.includes(task.state)) throw new Error(`${task.id}: loan needs an open task (${task.state})`);
    const caller = process.env.GOAL_ID;
    for (const file of files) {
      const holders = claimingTasks(ledger, [file], new Set([task.id])).map(item => ledger.tasks[item.id]!);
      if (!holders.length) throw new Error(`${file} is claimed by no other open task; no loan is needed`);
      const foreign = holders.filter(holder => caller !== 'program' && holder.goal !== caller);
      if (foreign.length) {
        throw new Error(`${file} is claimed by ${foreign.map(holder => `${holder.id} (${holder.goal})`).join(', ')}; `
          + `its Goal's manager or the program lends it (GOAL_ID is ${caller ?? 'unset'})`);
      }
    }
    task.loans = [...new Set([...task.loans ?? [], ...files])].sort();
    console.log(`${task.id} may land hunks in: ${task.loans.join(', ')}`);
  });
}

/** A task already dispatched takes or drops automatic landing; a brief's `land: auto` sets it at dispatch.
 * It takes effect when a `wait` on the task sees its worker hand off. */
export async function setAutoLand(id: string, on: boolean): Promise<void> {
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    assertPrepared(task);
    if (task.state !== 'running' && task.state !== 'exited') throw new Error(`${task.id}: auto-land needs a running or exited task (${task.state})`);
    if (on) task.land = 'auto'; else delete task.land;
    console.log(`${task.id}: ${on ? 'lands by itself when its worker hands off done' : 'lands on the manager\'s command only'}`);
  });
}

/** A blocked attempt that left the branch as it found it reports an inquiry, not the branch: the landing reads the
 * handoff of the last attempt before it. */
/** A blocked attempt added nothing when the branch carries no patch beyond main that its launch head lacked, apart
 * from the tool's own regeneration. A landing rebases the branch and regenerates, so the heads cannot be compared. */
export function blockedAttemptAddedNothing(task: Task, attempt: Attempt): boolean {
  const checkpoint = `${attempt.output}.head`;
  const start = existsSync(checkpoint) ? readFileSync(checkpoint, 'utf8').trim() : task.base;
  return !git(task.worktree, ['cherry', '-v', start, 'HEAD', 'main']).split('\n')
    .some(line => line.startsWith('+') && !line.endsWith(` ${REGENERATION_COMMIT_SUBJECT}`))
    && git(task.worktree, ['status', '--porcelain', '--untracked-files=all']) === '';
}

export function landingAttempt(task: Task, read: (attempt: Attempt) => { text: string; error: boolean } = readResult,
  unchanged: (task: Task, attempt: Attempt) => boolean = blockedAttemptAddedNothing): Attempt {
  let at = task.attempts.length - 1;
  while (at > 0) {
    const result = read(task.attempts[at]!);
    if (result.error || handoffResult(result.text) !== 'blocked' || !unchanged(task, task.attempts[at]!)) break;
    at--;
  }
  return task.attempts[at] ?? lastAttempt(task);
}

/** Review and merge refuse a task that a worker or a manager touched since the landing read it. The attempt is
 * chosen once, before the landing rebases: its rebase moves the branch, so the choice cannot be made again. */
export function landingMoved(current: Task, snapshot: { attempt: number; attempts: number; handoff: string; brief: string },
  read: (attempt: Attempt) => { text: string; error: boolean } = readResult,
  briefOf: (task: Task) => string = task => readFileSync(briefPathOf(task) ?? '', 'utf8')): boolean {
  const attempt = current.attempts.find(item => item.n === snapshot.attempt);
  return current.state !== 'exited' || current.attempts.length !== snapshot.attempts || !attempt
    || read(attempt).text !== snapshot.handoff || briefOf(current) !== snapshot.brief;
}

export async function landTask(id: string, step = false, gateLane: GateLaneOptions = {}): Promise<void> {
  const initial = taskOf(readLedger(), id);
  assertOwner(initial);
  const runDir = join(stateDir, 'runs', initial.id);
  mkdirSync(runDir, { recursive: true });
  const lock = join(runDir, 'land.lock');
  const landingLease = await acquireDir(lock, 120_000, `${initial.id} landing lock`);
  try {
    const snapshot = await withLedger(ledger => {
      const task = taskOf(ledger, id);
      assertOwner(task);
      assertPrepared(task);
      const retry = task.state === 'conflict' && task.mergeStop?.landing && task.mergeStop.kind !== 'task';
      if (running(task) || (task.state !== 'exited' && !retry)) {
        throw new Error(`${task.id}: land requires an exited task (${task.state})${task.mergeStop ? `\n${task.mergeStop.message}` : task.refusal ? `\n${task.refusal}` : ''}`
          + (task.state === 'conflict' && task.mergeStop?.kind === 'task'
            ? `\nCorrect the brief, reclaim ${task.id} <brief>, then merge ${task.id}.` : ''));
      }
      const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
        && other.worktree === task.worktree && HOLDING.includes(other.state));
      if (sharers.length) throw new Error(`${task.id}: land requires a task with its own branch; open sharers: ${sharers.map(other => other.id).join(', ')}`);
      restoreLandingRebase(runDir, task);
      if (changedFiles(task).dirty.length) throw new Error(`${task.id}: land requires a clean worktree`);
      const attempt = landingAttempt(task);
      const result = readResult(attempt);
      if (result.error) throw new Error(`${task.id}: land stopped: worker handoff is missing or reports an error`);
      const brief = briefPathOf(task);
      if (!brief) throw new Error(`${task.id}: land stopped: assigned brief is missing`);
      const head = git(root, ['rev-parse', task.branch]);
      if (git(task.worktree, ['rev-parse', 'HEAD']) !== head
        || git(task.worktree, ['symbolic-ref', '--short', 'HEAD']) !== task.branch) {
        throw new Error(`${task.id}: land stopped: worktree is not on the task branch`);
      }
      if (retry) { task.state = 'exited'; clearRefusal(task); }
      return { task, attempt: attempt.n, attempts: task.attempts.length, handoff: result.text, brief: readFileSync(brief, 'utf8'),
        head, base: git(root, ['merge-base', 'main', task.branch]) };
    });
    await land({ id: snapshot.task.id, worktree: snapshot.task.worktree, runDir, step,
      kind: parseBrief(snapshot.brief).kind, changedFiles: git(snapshot.task.worktree, ['diff', '--name-only', '--no-renames', `${snapshot.base}..${snapshot.head}`]).split('\n'),
      brief: snapshot.brief, handoff: snapshot.handoff, base: snapshot.base, head: snapshot.head,
      scope: () => landScope(id),
      checkpoint: () => {
        const current = taskOf(readLedger(), id);
        if (landingMoved(current, snapshot)) throw new Error(`${id}: task or brief changed during review`);
      },
      checkTargets: files => {
        const claimed = claimingTasks(readLedger(), files, new Set([id]));
        if (claimed.length) throw new Error(`review test paths claimed by another task: ${claimed.map(item => item.id).join(', ')}`);
      },
      unconfirmed: (findings, directory) => {
        const sender = snapshot.task.goal ?? 'program';
        const mail = new GoalMailStore({ stateDir, goals: [...new Set(['program', sender])], sender });
        try {
          mail.send('program', `${id}: unconfirmed review findings after the one setup correction. No worker fix round is authorized by these findings.\n`
            + findings.map(finding => `${finding.text}\n${finding.reason}`).join('\n\n') + `\nEvidence: ${directory}`,
          `review-setup:${id}:${directory}:${createHash('sha256').update(JSON.stringify(findings)).digest('hex')}`);
        } finally { mail.close(); }
      },
      merge: (permittedFiles, head) => mergeTask(id, new Set(), head, current => {
        if (landingMoved(current, snapshot)
          || current.branch !== snapshot.task.branch || current.worktree !== snapshot.task.worktree) {
          throw new Error(`${current.id}: task or brief changed during review; review again`);
        }
      }, permittedFiles, false, gateLane, landingLease), close: () => closeTasks([id], 'verified') });
  } finally {
    landingLease.release();
  }
}

/** Old ledgers lack round labels: their first attempt is initial, and later manual attempts are fixes. */
export function resumeDecisionError(attempts: readonly Attempt[], markdown: string): string | undefined {
  const fixes = attempts.filter((attempt, index) => !attempt.continuedFor
    && (attempt.round === 'fix' || (attempt.round === undefined && index > 0))).length;
  if (fixes < 2) return undefined;
  const decision = [...markdown.matchAll(/^## Decision\b[^\r\n]*(?:\r?\n|$)([\s\S]*?)(?=^## (?!#)|$(?![\s\S]))/gm)].at(-1);
  const heading = decision?.[0].split(/\r?\n/)[0];
  const section = decision?.[0] ?? '';
  const lastStart = Date.parse(attempts.at(-1)?.startedAt ?? '');
  const dates = [...section.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z|[ \t]+\d{2}:\d{2}(?::\d{2})?[ \t]+UTC|(?=[ \t]+UTC))/g)];
  const dated = dates.some(match => Date.parse(match[0].length === 10 ? `${match[0]}T00:00:00Z` : match[0].replace(/ UTC$/, 'Z').replace(' ', 'T')) > lastStart);
  return dated && /\b(?:cut|split|design note)\b/i.test(section) ? undefined
    : 'two fix rounds exhausted; brief needs a ## Decision dated UTC after the last attempt started, naming a cut, split or design note'
      + (heading ? `; looked at "${heading}"` : '; no ## Decision heading found');
}

export async function resumeTask(id: string, args: string[], waitingToken?: string): Promise<void> {
  let message = '';
  let effort: string | undefined;
  let engine: Engine | undefined;
  let fresh = false;
  let forceUsage = false;
  let resumeClass: Attempt['resumeClass'];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--class') {
      const value = args[++i];
      if (value !== 'baselineRed' && value !== 'environment' && value !== 'fixRound' && value !== 'sameScope')
        throw new Error('--class must be baselineRed, environment, fixRound or sameScope');
      resumeClass = value;
    } else if (args[i] === '-m') message = args[++i] ?? '';
    else if (args[i] === '--file') message = readFileSync(args[++i] ?? '', 'utf8');
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--engine') engine = args[++i] as Engine;
    else if (args[i] === '--fresh') fresh = true;
    else if (args[i] === '--force-usage') forceUsage = true;
    else throw new Error(`Unsupported resume option: ${args[i]}`);
  }
  if (!waitingToken && !message.trim()) throw new Error('resume needs -m <message> or --file <path>');
  await withLedger(async ledger => {
    const task = taskOf(ledger, id);
    if (waitingToken) {
      const pending = task.waitingResume;
      if (!pending || pending.token !== waitingToken) return;
      ({ message, effort, engine, fresh, forceUsage, resumeClass } = pending);
    }
    assertOwner(task);
    assertPrepared(task);
    assertPreviousClaudeExited(task);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first or message it`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const source = readClaimBrief(briefPathOf(task) ?? task.brief);
    const replacement = replacementClaims(task, ledger, source, new Set(), true);
    const previous = lastAttempt(task);
    let round: 'step' | 'fix' = 'fix';
    const result = readResult(previous);
    if (task.state === 'stopped' && previous.endedAt && !hasHandoff(result.text)) round = 'step';
    if (!result.error && handoffResult(result.text) === 'partial') {
      const changes = changedFiles(task);
      if (task.state === 'merged' || (changes.ahead === 0 && changes.dirty.length === 0)) round = 'step';
    }
    if (!result.error && handoffResult(result.text) === 'blocked' && blockedAttemptUnchanged(task, previous)) round = 'step';
    if ((task as CapacityTask).claudeCapacity?.pause) round = 'step';
    // A manager can record an exact correction without manufacturing a new brief Decision.
    // Changed claims still require the ordinary fresh decision and cannot use this class.
    if (resumeClass === 'sameScope' && (replacement.changed.length || !message.trim()))
      throw new Error('sameScope resume requires unchanged claims and a recorded correction message');
    const refusal = round === 'fix' && resumeClass !== 'sameScope'
      ? resumeDecisionError(task.attempts, source.text) : undefined;
    if (refusal) throw new Error(`${task.id}: ${refusal}`);
    const previousEngine = engineOf(previous);
    const nextEngine = engine === 'sol'
      ? isCodex(previousEngine) ? previousEngine : dispatchEngine(engine)
      : engine ?? previousEngine;
    const nextEffort = effort ?? previous.effort;
    if (!effortsOf(nextEngine).includes(nextEffort)) {
      throw new Error(`${nextEngine} effort must be one of ${effortsOf(nextEngine).join(', ')}`);
    }
    try {
      assertClaudeCapacity(nextEngine, task, ledger);
      admitWorkers(Object.values(ledger.tasks), nextEngine, forceUsage);
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!gateRefusal(reason)) throw error;
      task.waitingResume = { token: waitingToken ?? randomUUID(),
        queuedAt: waitingToken ? task.waitingResume!.queuedAt : new Date().toISOString(),
        reason, message, effort, engine, fresh, forceUsage, resumeClass };
      console.log(`${task.id} resume waiting: ${reason}`);
      return;
    }
    if (replacement.changed.length) Object.assign(task, replacement.claims);
    const manager = managerOf(ledger, task.goal);
    // A session continues only on its own engine: switching back resumes that engine's latest session,
    // and an engine without one starts fresh on the same worktree.
    const sameEngine = [...task.attempts].reverse().find(attempt => engineOf(attempt) === nextEngine
      && (attempt.session || readResult(attempt).session));
    const previousSession = sameEngine ? sameEngine.session || readResult(sameEngine).session || '' : '';
    const continuing = !fresh && !!previousSession;
    const session = continuing ? previousSession : isClaudeCode(nextEngine) ? randomUUID() : '';
    const handover = await prepareHandover(task, source.text);
    const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
      && resolve(other.worktree) === resolve(task.worktree) && (other.state === 'starting' || running(other)));
    const worktreeUpdate = updateResumeWorktree(task, sharers);
    console.log(worktreeUpdate);
    writeFileSync(join(task.worktree, briefFile({ ...task, shared: !!task.worktreeName })), source.text);
    stageHandover(task.worktree, handover);
    const prompt = (continuing ? handoverPrompt(handover, task.tests ?? [])
      : await workerPrompt(task, manager, nextEngine, nextEffort, handover))
      + `\n\n${worktreeUpdate}\n\nManager note:\n${message}`;
    recordResumeHead(task);
    task.attempts.push({ ...launch(task, nextEffort, session, prompt, continuing, manager, nextEngine, round),
      ...(resumeClass ? { resumeClass } : {}) });
    task.engine = nextEngine;
    task.state = 'running';
    delete task.waitingResume;
    clearRefusal(task);
    if (replacement.changed.length) console.log(`${task.id} claims updated: ${replacement.changed.join(', ')}`);
    console.log(`${task.id} attempt ${task.attempts.length}: ${modelOf(nextEngine)}/${nextEffort}`
      + ` ${continuing ? 'resumed' : 'fresh session'}, ${round === 'step' ? 'next step' : 'fix round'}, pid ${lastAttempt(task).pid}`);
  });
}


/** Detached children inherit the launcher's task and worktree markers even if they change cwd.
 * A task ID alone is not unique across repositories; older workers without a worktree marker stay scoped by cwd.
 * Without a task ID, sweep the worktree only when its last live worker has stopped.
 * Linux only: reads /proc. */
export function killWorktreeProcesses(worktree: string, taskId?: string, signal: NodeJS.Signals = 'SIGTERM'): number {
  if (!existsSync('/proc')) return 0;
  const origin = resolve(worktree);
  const prefix = `${origin}/`;
  const victims: number[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (taskId) {
        const environment = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        if (!environment.includes(`GOAL_TASK_ID=${taskId}`)) continue;
        if (environment.some(value => value.startsWith('GOAL_WORKTREE='))) {
          if (environment.includes(`GOAL_WORKTREE=${origin}`)) victims.push(pid);
          continue;
        }
      }
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === origin || cwd.startsWith(prefix)) victims.push(pid);
    } catch { /* exited or not ours */ }
  }
  for (const pid of victims) { try { process.kill(pid, signal); } catch { /* gone */ } }
  return victims.length;
}

/** A worktree's `task dev -- --backend` stack is Compose project rezics-qa-wt-<dir>;
 * its containers live in Docker, not in the worker's process tree. */
export function removeWorktreeStack(worktree: string): void {
  const project = `rezics-qa-wt-${basename(worktree)}`;
  const listed = spawnSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
    { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0 || !listed.stdout.trim()) return;
  spawnSync('docker', ['compose', '-p', project, 'down', '-v'], { encoding: 'utf8', timeout: 180_000 });
}

/** Handoffs cite files under the worktree's `.temp` (profiles, corpus backups,
 * prepared patches); keep them beside the task's run records when the worktree goes. */
export function preserveWorktreeArtifacts(worktree: string, runDir: string): string | null {
  const source = join(worktree, '.temp');
  if (!existsSync(source)) return null;
  mkdirSync(runDir, { recursive: true });
  let target = join(runDir, 'worktree-temp');
  if (existsSync(target)) target = `${target}-${Date.now()}`;
  renameSync(source, target);
  return target;
}

export async function stopTask(id: string): Promise<void> {
  // Keep dispatch/resume from adding a live sharer between the last-worker check and the cwd sweep.
  await withLedger(async ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    assertPrepared(task);
    delete task.waitingResume;
    // Cancel capacity resumption, while preserving the provenance requiring a manager landing.
    if ((task as CapacityTask).claudeCapacity) delete (task as CapacityTask).claudeCapacity!.pause;
    const attempt = lastAttempt(task);
    const program = programOf(engineOf(attempt));
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!pidAlive(attempt.pid, program)) return;
      try { process.kill(-attempt.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    signalGroup('SIGTERM');
    const deadline = Date.now() + 30_000;
    let children = killWorktreeProcesses(task.worktree, task.id);
    while ((pidAlive(attempt.pid, program) || children) && Date.now() < deadline) {
      await Bun.sleep(100);
      children = killWorktreeProcesses(task.worktree, task.id);
    }
    signalGroup('SIGKILL');
    killWorktreeProcesses(task.worktree, task.id, 'SIGKILL');
    const liveSharers = Object.values(ledger.tasks).some(other => other.id !== task.id
      && other.worktree === task.worktree && HOLDING.includes(other.state) && (other.state === 'starting' || running(other)));
    if (!liveSharers) {
      killWorktreeProcesses(task.worktree);
      removeWorktreeStack(task.worktree);
    }
    lastAttempt(task).endedAt ??= new Date().toISOString();
    if (task.state === 'running') { task.state = 'stopped'; clearRefusal(task); }
  });
  console.log(`${id.toUpperCase()} stopped; its worktree and claims remain until close`);
}

export { COMPOSITION_ROOTS };

export interface Lex {
  depth: number; block: boolean; single: boolean; double: boolean; template: boolean;
}

function readClaimBrief(briefPath: string) {
  const absolute = resolve(briefPath);
  const text = readFileSync(absolute, 'utf8');
  const brief = parseBrief(text);
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text)];
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  return { brief, text, absolute, briefPath };
}

function assertClaimIdentity(task: Task, source: ReturnType<typeof readClaimBrief>): void {
  if (source.brief.id !== task.id) throw new Error(`${source.briefPath} is for ${source.brief.id}, not ${task.id}`);
}

function replacementClaims(task: Task, ledger: Ledger, source: ReturnType<typeof readClaimBrief>, flags: Set<string>,
  resuming = false) {
  const { brief, absolute } = source;
  assertClaimIdentity(task, source);
  const claims = { kind: brief.kind, rows: brief.rows, title: brief.title, effort: brief.effort, cases: brief.cases, paths: brief.paths,
    tests: brief.tests, refs: brief.refs, operations: brief.operations,
    migrations: brief.migrations, shared: brief.shared, depends: brief.depends, brief: absolute,
    // Dispatch or an explicit reclaim takes the brief's default; resume keeps the manager's current choice.
    land: resuming ? task.land : brief.land };
  const changed = Object.entries(claims).filter(([key, value]) => !isDeepStrictEqual(task[key as keyof Task], value))
    .map(([key]) => key);
  if (resuming && !changed.length) return { claims, changed };
  const added = { ...brief, paths: brief.paths.filter(path => !task.paths.includes(path)) };
  const conflicts = briefClaimConflicts(brief, Object.values(ledger.tasks), task.goal);
  // Another Goal's area is likewise checked for added paths only: a held path was admitted, with `--allow-area`
  // where it needed it, and a resume that changes anything else in the brief must not refuse it again.
  if (!flags.has('--allow-area')) conflicts.push(...areaConflicts(added.paths, task.goal, areasOf(activeGoals(ledger))));
  if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
  return { claims, changed };
}

// Re-read an updated brief for an open task (for example a schema task continuing to its template) and
// replace its claims after the same conflict checks as dispatch. `--allow-area` skips another Goal's
// areas the same way; every other conflict still refuses. The new brief is copied into the worktree.
export async function reclaimTask(id: string, briefPath: string, flags: Set<string>): Promise<void> {
  const source = readClaimBrief(briefPath);
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    assertPrepared(task);
    assertClaimIdentity(task, source);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const { claims } = replacementClaims(task, ledger, source, flags);
    if (running(task)) {
      // A running worker may need more files (a surface recording its own requests); it never loses one mid-attempt.
      const dropped = (['paths', 'tests', 'migrations', 'shared', 'operations', 'refs'] as const)
        .flatMap(key => ((task[key] ?? []) as string[]).filter(item => !((claims[key] ?? []) as string[]).includes(item)));
      if (dropped.length) {
        throw new Error(`${task.id} is still running; a running task can only add claims (${dropped.join(', ')} would be dropped)`);
      }
    }
    Object.assign(task, claims);
    if (existsSync(task.worktree)) writeFileSync(join(task.worktree, briefFile({ ...task, shared: !!task.worktreeName })), source.text);
    console.log(`${task.id} claims replaced from ${briefPath}`);
  });
}

/** Closes the tasks in order, stopping at the first that cannot close, then moves the briefs and handoffs of those
 * closed to archive/goals in one commit. */
export async function closeTasks(ids: string[], outcome: string): Promise<void> {
  if (outcome !== 'verified' && outcome !== 'cancelled') throw new Error('close needs verified or cancelled');
  if (!ids.length) throw new Error('close needs a task ID');
  const ledger = readLedger();
  for (const id of ids) assertOwner(taskOf(ledger, id));
  try {
    for (const id of ids) await closeTask(id, outcome);
  } finally {
    await withLedger(current => {
      for (const note of archiveClosedBriefs(current, ids.map(id => taskOf(current, id)))) console.log(note);
    });
    await drainManagerCommits(root, stateDir, process.env.GOAL_ID);
  }
}

/** A clean final step can verify work already on main, while retaining its original claims. */
export function canVerifyReadOnly(task: Task): boolean {
  if (task.state !== 'exited') return false;
  const changes = changedFiles(task);
  const head = git(root, ['rev-parse', '--verify', task.branch], true);
  return !changes.ahead && !changes.dirty.length
    && (!task.paths.length || !!task.mergedCommit) && !!head
    && git(root, ['merge-base', 'main', head], true) === head;
}

async function closeTask(id: string, outcome: 'verified' | 'cancelled'): Promise<void> {
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertPrepared(task);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first`);
    const readOnly = canVerifyReadOnly(task);
    if (outcome === 'verified' && task.state !== 'merged' && !readOnly) {
      throw new Error(`${task.id} is ${task.state}, not merged`);
    }
    // A shared worktree stays while another open task still works in it.
    const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
      && other.worktree === task.worktree && !['verified', 'cancelled'].includes(other.state));
    preserveTaskOutputs(task);
    if (existsSync(task.worktree) && !sharers.length) {
      killWorktreeProcesses(task.worktree);
      removeWorktreeStack(task.worktree);
      // Tasks may leave intentionally read-only artifacts (for example immutable release trees).
      spawnSync('chmod', ['-R', 'u+w', task.worktree]);
      preserveWorktreeArtifacts(task.worktree, join(stateDir, 'runs', task.id));
      git(root, ['worktree', 'remove', '--force', task.worktree]);
    }
    if ((task.state === 'merged' || (outcome === 'verified' && readOnly && task.mergedCommit)) && !sharers.length) git(root, ['branch', '-d', task.branch], true);
    task.state = outcome;
    delete task.waitingResume;
    clearRefusal(task);
    task.closedAt = new Date().toISOString();
    console.log(`${task.id} ${outcome}; claims released${outcome === 'cancelled' ? `, branch ${task.branch} kept` : ''}`);
  });
}

const valueOf = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Registers a Goal whose file exists, or records its manager's new session after a restart. `--adopt` gives it the
 * open tasks that have no Goal: the tasks of the single manager that ran before Goals had names. */
export async function startGoal(slug: string, args: string[]): Promise<void> {
  if (!validGoalSlug(slug)) throw new Error(`Goal slug must be lower-case words joined by hyphens: ${slug || '(missing)'}`);
  const manager = valueOf(args, '--manager');
  if (!manager) throw new Error('goal start needs --manager <session name>');
  if (!existsSync(join(root, goalFile(slug)))) throw new Error(`${goalFile(slug)} is missing; write the Goal first`);
  await withLedger(ledger => {
    const existing = ledger.goals?.[slug];
    if (existing?.closedAt) throw new Error(`Goal ${slug} closed at ${existing.closedAt}; choose another slug`);
    const own = areasOf([slug])[slug] ?? [];
    const overlaps = areaConflicts(own, slug, areasOf(activeGoals(ledger).filter(other => other !== slug)));
    if (overlaps.length && !args.includes('--allow-area')) {
      throw new Error(`Goal ${slug}'s areas overlap another Goal's:\n  ${overlaps.join('\n  ')}`);
    }
    ledger.goals = { ...ledger.goals, [slug]: { ...existing, manager, startedAt: existing?.startedAt ?? new Date().toISOString() } };
    const adopted = args.includes('--adopt')
      ? Object.values(ledger.tasks).filter(task => !task.goal && !['verified', 'cancelled'].includes(task.state)) : [];
    for (const task of adopted) task.goal = slug;
    console.log(`Goal ${slug} ${existing ? 'resumed' : 'started'}; manager ${manager}; ${own.length} area(s)`
      + (adopted.length ? `; adopted ${adopted.map(task => task.id).join(', ')}` : ''));
  });
}

/** Ends a Goal once nothing of it remains in the tree: no open task, no brief, no file or line naming its tasks and no
 * link into its directory. Then its directory and ledger entries move to archive/goals. */
export async function closeGoal(slug: string, flags: Set<string>): Promise<number> {
  const caller = process.env.GOAL_ID;
  if (caller && caller !== slug) throw new Error(`Goal ${slug} is not this manager's (GOAL_ID is ${caller})`);
  if (!flags.has('--dry-run')) {
    await withLedger(ledger => {
      const goal = ledger.goals?.[slug];
      if (!goal || goal.closedAt) throw new Error(`Goal ${slug} is not active`);
      const tasks = Object.values(ledger.tasks).filter(task => task.goal === slug);
      if (tasks.every(task => ['verified', 'cancelled'].includes(task.state)))
        for (const note of archiveClosedBriefs(ledger, tasks)) console.log(note);
    });
    await drainManagerCommits(root, stateDir, slug);
  }
  const result = await withLedger(ledger => {
    const goal = ledger.goals?.[slug];
    if (!goal || goal.closedAt) throw new Error(`Goal ${slug} is not active`);
    const tasks = Object.values(ledger.tasks).filter(task => task.goal === slug);
    const problems = tasks.filter(task => !['verified', 'cancelled'].includes(task.state))
      .map(task => `${task.id} is ${task.state}; merge and close or cancel it`);
    const dir = `${GOALS_DIR}/${slug}`;
    const tasksDir = join(root, dir, 'tasks');
    problems.push(...(existsSync(tasksDir) ? readdirSync(tasksDir) : []).map(name => `${dir}/tasks/${name} remains`));
    const ids = tasks.map(task => task.id);
    problems.push(...treeMentions(root, ids, { words: true }).map(line => `names a task: ${line}`));
    const numbers = new Set(ids.map(id => id.slice(2)));
    const exempt = HISTORY_EXEMPT.map(pattern => new Bun.Glob(pattern));
    problems.push(...git(root, ['ls-files']).split('\n').filter(path => !exempt.some(glob => glob.match(path)) && path.split('/')
      .some(segment => numbers.has(/^g-(\d{3,})(?!\d)/i.exec(segment)?.[1] ?? ''))).map(path => `named after a task: ${path}`));
    problems.push(...treeMentions(root, [`goals/${slug}/`], { exclude: [`${GOALS_DIR}/*/**`, 'scripts/goal/**'] })
      .map(line => `links into the Goal: ${line}`));
    if (problems.length) {
      console.log(`Goal ${slug} has not converged:\n  ${problems.join('\n  ')}`);
      return 1;
    }
    if (flags.has('--dry-run')) { console.log(`Goal ${slug} has converged; close would archive ${dir}`); return 0; }
    const archive = archiveDirOf(ledger, slug);
    const files = git(root, ['ls-files', '--', dir]).split('\n').filter(Boolean)
      .concat(git(root, ['ls-files', '--others', '--exclude-standard', '--', dir]).split('\n').filter(Boolean));
    archiveFiles(root, [...files.map(path => ({ path: `${archive}/${relative(dir, path)}`, content: readFileSync(join(root, path), 'utf8') })),
      { path: `${archive}/ledger.json`, content: `${JSON.stringify({ goal: { slug, ...goal }, tasks }, null, 2)}\n` }],
    `Archive Goal ${slug}\n\nGoal: ${slug}`);
    removeFromTree(root, files, `Close Goal ${slug}\n\nIts directory and ledger entries are on ${ARCHIVE_BRANCH} under ${archive}/.\n\nGoal: ${slug}`);
    ledger.lastId = Math.max(ledger.lastId ?? 0, ...ids.map(id => Number(id.slice(2))));
    for (const id of ids) delete ledger.tasks[id];
    Object.assign(goal, { closedAt: new Date().toISOString(), archive });
    console.log(`Goal ${slug} closed; ${ARCHIVE_BRANCH}:${archive}/ holds its directory, briefs, handoffs and ledger`);
    return 0;
  });
  if (!flags.has('--dry-run')) await drainManagerCommits(root, stateDir, slug);
  return result;
}

/** Reserves the next task ID for a Goal and writes its brief skeleton, so two managers never take the same number. */
export async function newBrief(args: string[]): Promise<void> {
  const goalArg = valueOf(args, '--goal');
  const kind = valueOf(args, '--kind');
  if (!kind || !(BRIEF_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`new needs --kind <kind>; kinds: ${BRIEF_KINDS.join(', ')}: ${kind ?? '(missing)'}`);
  }
  const options = ['--goal', '--kind'];
  const title = args.filter((arg, at) => !options.includes(arg) && !options.includes(args[at - 1] ?? '')).join(' ').trim();
  if (!title) throw new Error('new needs a title');
  await withLedger(ledger => {
    const active = activeGoals(ledger);
    const goal = goalArg ?? process.env.GOAL_ID ?? (active.length === 1 ? active[0] : undefined);
    if (!goal || !active.includes(goal)) throw new Error(`new needs an active Goal (--goal <slug>): ${active.join(', ') || 'none started'}`);
    const goalsDir = join(root, GOALS_DIR);
    const onDisk = readdirSync(goalsDir).flatMap(entry => {
      const dir = entry === 'tasks' ? join(goalsDir, 'tasks') : join(goalsDir, entry, 'tasks');
      return existsSync(dir) ? readdirSync(dir).map(name => name.replace(/\.md$/, '')) : [];
    });
    const id = nextTaskId([...Object.keys(ledger.tasks), ...Object.keys(ledger.reserved ?? {}), ...onDisk], ledger.lastId);
    const path = join(root, goalBriefFile(goal, id));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ['---', `id: ${id}`, `title: ${title}`,
      `kind: ${kind}                        # ${BRIEF_KINDS.join(' | ')}`,
      'rows: []                             # required for implementation; optional otherwise',
      'engine: sol', 'effort: high', 'cases: []                             # acceptance IDs such as IAM02, when the task has them',
      'paths: []                             # name new files by capability, never g-NNN',
      'tests: []                             # optional: the files `task goal -- check` runs in one QA slot',
      'refs: []                              # optional: files `dispatch` copies to `.temp/ref/` in the worktree before the worker starts',
      'operations: []                        # optional: operations whose index entry the first prompt carries',
      'migrations: []                        # <directory>:<first>-<last>', 'shared: []', 'depends: []',
      'needs: []                             # optional: repository files that must exist on main before dispatch',
      '# worktree: wave-9                    # optional: tasks naming one worktree share its tree and branch',
      `${['outcome', 'surface', 'tooling'].includes(kind) ? '' : '# '}land: auto                           # optional: wait lands a done handoff on an exclusive branch`,
      '---', '', '## Outcome', '', '## Mechanisms', '', 'none',
      '# <id>: consume | configure | extend | new — <why no owner fits>',
      ...kind === 'mechanism' ? ['', '## Design note', '', 'Reviewed: YYYY-MM-DD', ''] : [],
      '', '## Checks', ''].join('\n'));
    ledger.reserved = { ...ledger.reserved, [id]: goal };
    console.log(`${id} reserved for Goal ${goal}: ${relative(root, path)}`);
  });
}

/** Archives the briefs of closed tasks still in the tree: a close that stopped part-way, or pre-Goal briefs. */
export async function tidy(args: string[]): Promise<void> {
  const caller = process.env.GOAL_ID;
  await withLedger(ledger => {
    const tasks = Object.values(ledger.tasks).filter(task => !caller || !task.goal || task.goal === caller);
    const notes = archiveClosedBriefs(ledger, tasks, valueOf(args, '--legacy'));
    console.log(notes.length ? notes.join('\n') : 'Nothing to tidy');
  });
  await drainManagerCommits(root, stateDir, caller);
}
