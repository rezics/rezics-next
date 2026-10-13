import { type Brief, DEFAULT_ENGINE, HOLDING, type Task, isClaudeCode, modelOf, programOf, engineOf, CAPACITY_WAIT_MS, MAX_CAPACITY_CONTINUATIONS, MAX_TRANSPORT_CONTINUATIONS, type Attempt, type Engine, effortsOf } from './types.ts';
import { root, withLedger, briefGoal, unlandedChangeConflicts, areasOf, activeGoals, stateDir, git, managerOf, readLedger, pidAlive, claimingTasks, assertOwner, acquireDir, briefPathOf, landScope, archiveClosedBriefs, treeMentions, archiveDirOf, archiveFiles, removeFromTree, ARCHIVE_BRANCH } from './ledger.ts';
import { pathToFileURL } from 'node:url';
import { join, resolve, basename, relative, dirname } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, readlinkSync, renameSync } from 'node:fs';
import { parseBrief, validateBrief, mechanismSectionErrors, claimConflicts, areaConflicts, validGoalSlug, goalFile, GOALS_DIR, HISTORY_EXEMPT, nextTaskId, goalBriefFile } from './briefs.ts';
import { launchGates, briefFile, launch, workerPrompt, lastAttempt, taskOf, readResult, capacityRefusal, transportDrop, transportContinuations, transportContinuationPrompt, changedFiles, elapsed, describe, running } from './launch.ts';
import { postgresSocketRefusal, physicalPath } from './postgres-socket.ts';
import { describeAccount } from './usage.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { clearRefusal, mergeTask } from './merge.ts';
import { land, handoffResult } from './land.ts';
import { COMPOSITION_ROOTS } from './composition-roots.ts';

/** Declarations and their test registrations belong to the outcomes loader, not to orchestration. */
export async function dispatchMethodErrors(brief: Brief, markdown: string, outcomeRoot = root): Promise<string[]> {
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
      if (!personas.some(persona => declaration.cells[persona]?.state === 'pending')) {
        errors.push(`implementation row ${id}: needs at least one pending persona cell`);
      }
    }
    return errors;
  }
  if (brief.kind === 'mechanism') {
    const section = /^## Design note[ \t]*\r?\n([\s\S]*?)(?=^## (?!#)|$(?![\s\S]))/m.exec(markdown)?.[1] ?? '';
    const readBy = /^(?:-\s+)?Read by program:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*\r?$/m.exec(section);
    const date = readBy?.[1];
    const timestamp = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
    const dated = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
    if (!dated || !section.replace(readBy?.[0] ?? '', '').trim()) {
      return ['mechanism brief needs a non-empty ## Design note with Read by program: YYYY-MM-DD'];
    }
  }
  return [];
}

export async function dispatch(briefPath: string, flags: Set<string>): Promise<void> {
  const absolute = resolve(briefPath);
  const text = readFileSync(absolute, 'utf8');
  const brief = parseBrief(text);
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text)];
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  const methodErrors = await dispatchMethodErrors(brief, text);
  if (methodErrors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${methodErrors.join('\n  ')}`);
  await withLedger(ledger => {
    if (ledger.tasks[brief.id]) throw new Error(`${brief.id} already exists (${ledger.tasks[brief.id]!.state}); use resume`);
    const goal = briefGoal(ledger, absolute);
    const reservedBy = ledger.reserved?.[brief.id];
    if (reservedBy && reservedBy !== goal) throw new Error(`${brief.id} is reserved for Goal ${reservedBy}; take an ID with \`new\``);
    const tasks = Object.values(ledger.tasks);
    // Commits outside the claim are held until that task lands or closes, or land would refuse it.
    const conflicts = [...claimConflicts(brief, tasks), ...unlandedChangeConflicts(brief, tasks)];
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
    const engine = brief.engine ?? DEFAULT_ENGINE;
    const { live, limit, usage, account } = launchGates(tasks, engine, flags.has('--force-usage'));
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
    const reuse = brief.worktree !== undefined && existsSync(worktree);
    if (existsSync(worktree) && !reuse) throw new Error(`${worktree} already exists; remove it or use another ID`);
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
    mkdirSync(join(worktree, '.temp', 'goal'), { recursive: true });
    const { worktree: _shared, ...claims } = brief;
    const task: Task = { ...claims, brief: absolute, worktree, branch,
      base: reuse ? git(worktree, ['merge-base', 'HEAD', 'main']) : git(root, ['rev-parse', 'main']),
      state: 'running', attempts: [], ...brief.worktree ? { worktreeName: brief.worktree } : {},
      ...goal ? { goal } : {}, historyGate: true };
    copyFileSync(absolute, join(worktree, briefFile({ ...task, shared: !!task.worktreeName })));
    const manager = managerOf(ledger, goal);
    task.attempts.push(launch(task, brief.effort, isClaudeCode(engine) ? randomUUID() : '',
      workerPrompt(task, manager, engine), false, manager, engine));
    ledger.tasks[brief.id] = task;
    if (ledger.reserved) delete ledger.reserved[brief.id];
    ledger.lastId = Math.max(ledger.lastId ?? 0, Number(brief.id.slice(2)));
    ledger.startedAt ??= new Date().toISOString();
    console.log(`${brief.id} started: ${modelOf(engine)}/${brief.effort} pid ${lastAttempt(task).pid} in ${worktree}`);
    console.log(`Next: run \`bun scripts/goal/goalctl.ts wait ${brief.id}\` in the background.`);
  });
}

export async function waitFor(id: string, options: { pollMs?: number; settleMs?: number; capacityWaitMs?: number } = {}): Promise<void> {
  // A killed waiter must never record the worker as ended (an expired monitor once marked live workers exited).
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => process.exit(143));
  let watching = lastAttempt(taskOf(readLedger(), id));
  for (;;) {
    const alive = () => pidAlive(watching.pid, programOf(engineOf(watching)));
    while (alive() || (await Bun.sleep(options.settleMs ?? 3000), alive())) await Bun.sleep(options.pollMs ?? 5000);
    const result = readResult(watching);
    const refusedTurn = capacityRefusal(watching);
    if (refusedTurn) {
      const pause = options.capacityWaitMs ?? CAPACITY_WAIT_MS;
      // Said before the pause: a manager that sees only the exit resumes by hand and races this.
      console.log(`${id} attempt ${watching.n} was refused for capacity; resuming the same session in ${Math.round(pause / 1000)} s`);
      await Bun.sleep(pause);
    }
    const outcome = await withLedger(ledger => {
      const current = taskOf(ledger, id);
      const last = lastAttempt(current);
      if (last.n !== watching.n) return { kind: 'replaced' as const, task: current };
      last.endedAt ??= new Date().toISOString();
      if (result.session && !last.session) last.session = result.session;
      // Status may already have marked a dead pid exited. A stop or a close still stands.
      const open = current.state === 'running' || current.state === 'exited';
      const drop = transportDrop(last);
      let refused: string | undefined;
      if (refusedTurn && open && last.session && transportContinuations(current, 'capacity') < MAX_CAPACITY_CONTINUATIONS) {
        const engine = engineOf(last);
        try {
          launchGates(Object.values(ledger.tasks), engine, false);
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
          launchGates(Object.values(ledger.tasks), engine, false);
          const manager = managerOf(ledger, current.goal);
          const session = isClaudeCode(engine) ? randomUUID() : '';
          const prompt = `${workerPrompt(current, manager, engine, effort)}\n\n${transportContinuationPrompt(changedFiles(current).dirty)}`;
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
      const repeated = drop && open && transportContinuations(current) >= MAX_TRANSPORT_CONTINUATIONS;
      if (current.state === 'running') { current.state = 'exited'; clearRefusal(current); }
      return { kind: 'ended' as const, task: current, repeated, refused };
    });
    const task = outcome.task;
    console.log(`${task.id} attempt ${watching.n} ended after ${elapsed(watching.startedAt)}`
      + `${result.error ? ' WITH ERROR' : ''}${result.cost !== undefined ? `; cost $${result.cost.toFixed(2)}` : ''}`
      + `${result.tokens ? `; ${modelOf(engineOf(watching))} tokens ${result.tokens}` : ''}`);
    if (outcome.kind === 'continued') {
      console.log(outcome.next.continuedFor === 'capacity'
        ? `${task.id} resumed by itself after a capacity refusal; same ${modelOf(engineOf(outcome.next))} session, pid ${outcome.next.pid}`
        : `${task.id} continued by itself after a transport error; fresh ${modelOf(engineOf(outcome.next))}/`
          + `${outcome.next.effort} session, pid ${outcome.next.pid}`);
      watching = outcome.next;
      continue;
    }
    console.log(describe(task));
    if (outcome.kind === 'ended' && outcome.repeated) console.log(`${task.id} stopped after repeated transport errors`);
    if (outcome.kind === 'ended' && outcome.refused) console.log(`${task.id} not continued after a ${refusedTurn ? 'capacity refusal' : 'transport error'}: ${outcome.refused}`);
    console.log(`--- handoff ---\n${result.text.length > 8000 ? `${result.text.slice(0, 8000)}\n[truncated]` : result.text}`);
    // A session that ended on an error has handed nothing off; landing it would only report a dirty worktree.
    if (outcome.kind === 'ended' && task.land === 'auto' && lastAttempt(task).n === watching.n && !result.error) await landTask(task.id);
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
    if (task.state !== 'running' && task.state !== 'exited') throw new Error(`${task.id}: auto-land needs a running or exited task (${task.state})`);
    if (on) task.land = 'auto'; else delete task.land;
    console.log(`${task.id}: ${on ? 'lands by itself when its worker hands off done' : 'lands on the manager\'s command only'}`);
  });
}

export async function landTask(id: string, step = false): Promise<void> {
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
      if (running(task) || task.state !== 'exited') throw new Error(`${task.id}: land requires an exited task (${task.state})`);
      const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
        && other.worktree === task.worktree && HOLDING.includes(other.state));
      if (sharers.length) throw new Error(`${task.id}: land requires a task with its own branch; open sharers: ${sharers.map(other => other.id).join(', ')}`);
      if (changedFiles(task).dirty.length) throw new Error(`${task.id}: land requires a clean worktree`);
      const attempt = lastAttempt(task);
      const result = readResult(attempt);
      if (result.error) throw new Error(`${task.id}: land stopped: worker handoff is missing or reports an error`);
      const brief = briefPathOf(task);
      if (!brief) throw new Error(`${task.id}: land stopped: assigned brief is missing`);
      const head = git(root, ['rev-parse', task.branch]);
      if (git(task.worktree, ['rev-parse', 'HEAD']) !== head
        || git(task.worktree, ['symbolic-ref', '--short', 'HEAD']) !== task.branch) {
        throw new Error(`${task.id}: land stopped: worktree is not on the task branch`);
      }
      return { task, attempt: attempt.n, handoff: result.text, brief: readFileSync(brief, 'utf8'),
        head, base: git(root, ['merge-base', 'main', task.branch]) };
    });
    await land({ id: snapshot.task.id, worktree: snapshot.task.worktree, runDir, step,
      kind: parseBrief(snapshot.brief).kind, changedFiles: git(snapshot.task.worktree, ['diff', '--name-only', '--no-renames', `${snapshot.base}..${snapshot.head}`]).split('\n'),
      brief: snapshot.brief, handoff: snapshot.handoff, base: snapshot.base, head: snapshot.head,
      scope: () => landScope(id),
      checkpoint: () => {
        const current = taskOf(readLedger(), id);
        if (current.state !== 'exited' || lastAttempt(current).n !== snapshot.attempt
          || readResult(lastAttempt(current)).text !== snapshot.handoff
          || readFileSync(briefPathOf(current) ?? '', 'utf8') !== snapshot.brief) throw new Error(`${id}: task or brief changed during review`);
      },
      checkTargets: files => {
        const claimed = claimingTasks(readLedger(), files, new Set([id]));
        if (claimed.length) throw new Error(`review test paths claimed by another task: ${claimed.map(item => item.id).join(', ')}`);
      },
      merge: (permittedFiles, head) => mergeTask(id, new Set(), head, current => {
        if (current.state !== 'exited' || lastAttempt(current).n !== snapshot.attempt
          || current.branch !== snapshot.task.branch || current.worktree !== snapshot.task.worktree
          || readResult(lastAttempt(current)).text !== snapshot.handoff
          || readFileSync(briefPathOf(current) ?? '', 'utf8') !== snapshot.brief) {
          throw new Error(`${current.id}: task or brief changed during review; review again`);
        }
      }, permittedFiles), close: () => closeTasks([id], 'verified') });
  } finally {
    landingLease.release();
  }
}

/** Old ledgers lack round labels: their first attempt is initial, and later manual attempts are fixes. */
export function resumeDecisionError(attempts: readonly Attempt[], markdown: string): string | undefined {
  const fixes = attempts.filter((attempt, index) => !attempt.continuedFor
    && (attempt.round === 'fix' || (attempt.round === undefined && index > 0))).length;
  if (fixes < 2) return undefined;
  const section = /^## Decision[ \t]*\r?\n([\s\S]*?)(?=^## (?!#)|$(?![\s\S]))/m.exec(markdown)?.[1] ?? '';
  const lastStart = Date.parse(attempts.at(-1)?.startedAt ?? '');
  const dates = [...section.matchAll(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z|[ \t]+\d{2}:\d{2}(?::\d{2})?[ \t]+UTC|(?=[ \t]+UTC))/g)];
  const dated = dates.some(match => Date.parse(match[0].length === 10 ? `${match[0]}T00:00:00Z` : match[0].replace(/ UTC$/, 'Z').replace(' ', 'T')) > lastStart);
  return dated && /\b(?:cut|split|design note)\b/i.test(section) ? undefined
    : 'two fix rounds exhausted; brief needs a ## Decision dated UTC after the last attempt started, naming a cut, split or design note';
}

export async function resumeTask(id: string, args: string[]): Promise<void> {
  let message = '';
  let effort: string | undefined;
  let engine: Engine | undefined;
  let fresh = false;
  let forceUsage = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m') message = args[++i] ?? '';
    else if (args[i] === '--file') message = readFileSync(args[++i] ?? '', 'utf8');
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--engine') engine = args[++i] as Engine;
    else if (args[i] === '--fresh') fresh = true;
    else if (args[i] === '--force-usage') forceUsage = true;
    else throw new Error(`Unsupported resume option: ${args[i]}`);
  }
  if (!message.trim()) throw new Error('resume needs -m <message> or --file <path>');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first or message it`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const previous = lastAttempt(task);
    let round: 'step' | 'fix' = 'fix';
    const result = readResult(previous);
    if (!result.error && handoffResult(result.text) === 'partial') {
      const changes = changedFiles(task);
      if (task.state === 'merged' || (changes.ahead === 0 && changes.dirty.length === 0)) round = 'step';
    }
    const refusal = round === 'fix' ? resumeDecisionError(task.attempts, readFileSync(briefPathOf(task) ?? '', 'utf8')) : undefined;
    if (refusal) throw new Error(`${task.id}: ${refusal}`);
    const nextEngine = engine ?? engineOf(previous);
    const nextEffort = effort ?? previous.effort;
    if (!effortsOf(nextEngine).includes(nextEffort)) {
      throw new Error(`${nextEngine} effort must be one of ${effortsOf(nextEngine).join(', ')}`);
    }
    launchGates(Object.values(ledger.tasks), nextEngine, forceUsage);
    const manager = managerOf(ledger, task.goal);
    // A session continues only on its own engine: switching back resumes that engine's latest session,
    // and an engine without one starts fresh on the same worktree.
    const sameEngine = [...task.attempts].reverse().find(attempt => engineOf(attempt) === nextEngine
      && (attempt.session || readResult(attempt).session));
    const previousSession = sameEngine ? sameEngine.session || readResult(sameEngine).session || '' : '';
    const continuing = !fresh && !!previousSession;
    const session = continuing ? previousSession : isClaudeCode(nextEngine) ? randomUUID() : '';
    const prompt = continuing ? message
      : `${workerPrompt(task, manager, nextEngine, nextEffort)}\n\nManager note:\n${message}`;
    task.attempts.push(launch(task, nextEffort, session, prompt, continuing, manager, nextEngine, round));
    task.engine = nextEngine;
    task.state = 'running';
    clearRefusal(task);
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
      && other.worktree === task.worktree && HOLDING.includes(other.state) && running(other));
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

// Re-read an updated brief for an open task (for example a schema task continuing to its template) and
// replace its claims after the same conflict checks as dispatch. `--allow-area` skips another Goal's
// areas the same way; every other conflict still refuses. The new brief is copied into the worktree.
export async function reclaimTask(id: string, briefPath: string, flags: Set<string>): Promise<void> {
  const absolute = resolve(briefPath);
  const text = readFileSync(absolute, 'utf8');
  const brief = parseBrief(text);
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text)];
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    if (brief.id !== task.id) throw new Error(`${briefPath} is for ${brief.id}, not ${task.id}`);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    // A path this task already holds was claimed before any later change to it, so only added paths can
    // collide with another task's unlanded change.
    const added = { ...brief, paths: brief.paths.filter(path => !task.paths.includes(path)) };
    const conflicts = [...claimConflicts(brief, Object.values(ledger.tasks)),
      ...unlandedChangeConflicts(added, Object.values(ledger.tasks))];
    if (!flags.has('--allow-area')) conflicts.push(...areaConflicts(brief.paths, task.goal, areasOf(activeGoals(ledger))));
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    Object.assign(task, { kind: brief.kind, rows: brief.rows, title: brief.title, effort: brief.effort, cases: brief.cases, paths: brief.paths,
      migrations: brief.migrations, shared: brief.shared, depends: brief.depends, brief: absolute, land: brief.land });
    if (existsSync(task.worktree)) copyFileSync(absolute, join(task.worktree, briefFile({ ...task, shared: !!task.worktreeName })));
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
  }
}

async function closeTask(id: string, outcome: 'verified' | 'cancelled'): Promise<void> {
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first`);
    // A read-only task (no path claims, nothing committed) is verified by its accepted handoff.
    const readOnly = !task.paths.length && task.state === 'exited' && !changedFiles(task).ahead;
    if (outcome === 'verified' && task.state !== 'merged' && !readOnly) {
      throw new Error(`${task.id} is ${task.state}, not merged`);
    }
    // A shared worktree stays while another open task still works in it.
    const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
      && other.worktree === task.worktree && !['verified', 'cancelled'].includes(other.state));
    if (existsSync(task.worktree) && !sharers.length) {
      killWorktreeProcesses(task.worktree);
      removeWorktreeStack(task.worktree);
      // Tasks may leave intentionally read-only artifacts (for example immutable release trees).
      spawnSync('chmod', ['-R', 'u+w', task.worktree]);
      preserveWorktreeArtifacts(task.worktree, join(stateDir, 'runs', task.id));
      git(root, ['worktree', 'remove', '--force', task.worktree]);
    }
    if (task.state === 'merged' && !sharers.length) git(root, ['branch', '-d', task.branch], true);
    task.state = outcome;
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
  return withLedger(ledger => {
    const goal = ledger.goals?.[slug];
    if (!goal || goal.closedAt) throw new Error(`Goal ${slug} is not active`);
    const tasks = Object.values(ledger.tasks).filter(task => task.goal === slug);
    const problems = tasks.filter(task => !['verified', 'cancelled'].includes(task.state))
      .map(task => `${task.id} is ${task.state}; merge and close or cancel it`);
    if (!problems.length && !flags.has('--dry-run')) for (const note of archiveClosedBriefs(ledger, tasks)) console.log(note);
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
}

/** Reserves the next task ID for a Goal and writes its brief skeleton, so two managers never take the same number. */
export async function newBrief(args: string[]): Promise<void> {
  const goalArg = valueOf(args, '--goal');
  const title = args.filter((arg, at) => arg !== '--goal' && args[at - 1] !== '--goal').join(' ').trim();
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
    writeFileSync(path, ['---', `id: ${id}`, `title: ${title}`, `engine: ${DEFAULT_ENGINE}`, 'effort: high', 'cases: []',
      'paths: []                             # name new files by capability, never g-NNN', 'migrations: []', 'shared: []',
      'depends: []', '---', '', '## Outcome', '', '## Mechanisms', '', 'none',
      '# <id>: consume | configure | extend | new — <why no owner fits>', '', '## Checks', ''].join('\n'));
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
}
