import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeGoals, areasOf, briefGoal, briefClaimConflicts, readLedger, root, stateDir, withLedger } from './ledger.ts';
import { areaConflicts, goalOfBriefPath, mechanismSectionErrors, parseBrief, validateBrief } from './briefs.ts';
import { dispatchMethodErrors, neededFileWaits } from './tasks.ts';
import { prepareHandover } from './handover.ts';
import { processAlive, processIdentity } from '../qa/process/identity.ts';
import { postgresSocketRefusal, physicalPath } from './postgres-socket.ts';
import { GoalMailStore } from './mail.ts';
import { HOLDING, type Brief, type Ledger } from './types.ts';

export interface QueuedBrief {
  id: string; brief: string; goal?: string; queuedAt: string; waits: string[];
  waitedFor?: string[];
  allowArea?: boolean;
  owner?: { pid: number; start?: string; boot?: string };
}
export type QueueLedger = Ledger & {
  queue?: Record<string, QueuedBrief>;
  queueRefusals?: Record<string, QueuedBrief & { reason: string; refusedAt: string }>;
};

function assertManager(goal: string | undefined): void {
  const caller = process.env.GOAL_ID;
  if (caller && caller !== 'program' && caller !== goal) {
    throw new Error(`Brief belongs to Goal ${goal ?? '(none)'}; GOAL_ID is ${caller}`);
  }
}

async function validatedBrief(path: string): Promise<Brief> {
  const text = readFileSync(path, 'utf8');
  const brief = parseBrief(text);
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text), ...await dispatchMethodErrors(brief, text)];
  if (errors.length) throw new Error(`Invalid brief ${path}:\n  ${errors.join('\n  ')}`);
  await prepareHandover(brief, text);
  return brief;
}

function ledgerWaits(ledger: QueueLedger, brief: Brief, entry?: QueuedBrief): string[] {
  const tasks = Object.values(ledger.tasks);
  const waits = briefClaimConflicts(brief, tasks, entry?.goal);
  if (entry) {
    const holders = tasks.filter(task => briefClaimConflicts(brief, [task], entry.goal).length).map(task => task.id);
    entry.waitedFor = [...new Set([...entry.waitedFor ?? [], ...holders, ...brief.depends])];
  }
  for (const id of brief.depends) {
    const dependency = ledger.tasks[id];
    const queued = ledger.queue?.[id];
    if (!dependency && !queued) throw new Error(`Unknown dependency ${id}; cross-Goal dependencies are contracts on the program's board (docs/goals/program/state.md), not task IDs`);
    if ((dependency ? dependency.goal : queued?.goal) !== entry?.goal) throw new Error(`Dependency ${id} belongs to another Goal; cross-Goal dependencies are contracts on the program's board (docs/goals/program/state.md), not task IDs`);
    if (!dependency) { waits.push(`${brief.id} depends on ${id}, which is queued`); continue; }
    if (!['merged', 'verified'].includes(dependency.state)) waits.push(`${brief.id} depends on ${id}, which is ${dependency.state}`);
  }
  for (const id of entry?.waitedFor ?? []) {
    if (!brief.depends.includes(id) && ledger.tasks[id]?.state === 'cancelled') waits.push(`${brief.id} waited for ${id}, which is cancelled`);
  }
  return waits;
}

function waitsFor(ledger: QueueLedger, brief: Brief, entry: QueuedBrief, needs: readonly string[]): string[] {
  const waits = ledgerWaits(ledger, brief, entry);
  if (waits.length) return waits;
  return [...needs];
}

function assertDispatchable(ledger: Ledger, brief: Brief, goal: string | undefined, allowArea = false): void {
  if (ledger.tasks[brief.id]) throw new Error(`${brief.id} already exists (${ledger.tasks[brief.id]!.state}); use resume`);
  const reserved = ledger.reserved?.[brief.id];
  if (reserved && reserved !== goal) throw new Error(`${brief.id} is reserved for Goal ${reserved}; take an ID with \`new\``);
  const areas = allowArea ? [] : areaConflicts(brief.paths, goal, areasOf(activeGoals(ledger)));
  if (areas.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${areas.join('\n  ')}`);
  const worktree = join(root, '.temp/worktrees', brief.worktree ? `${goal ?? 'legacy'}-${brief.worktree}` : brief.id.toLowerCase());
  const socket = postgresSocketRefusal(physicalPath(worktree));
  if (socket) throw new Error(socket);
  if (brief.worktree && Object.values(ledger.tasks).some(task => task.worktree === worktree
    && HOLDING.includes(task.state) && task.goal !== goal)) throw new Error(`${worktree} has open tasks belonging to another Goal; use a different shared worktree`);
}

export function gateRefusal(reason: string): boolean {
  // Dispatch owns gate decisions; only its temporary refusals are retried.
  return /^(?:Concurrency limit reached:|Memory floor reached:|Claude usage is (?:restricted|critical)\b)/.test(reason)
    || /; use another engine or pass --force-usage$/.test(reason);
}

function recordRefusal(ledger: QueueLedger, entry: QueuedBrief, reason: string): void {
  (ledger.queueRefusals ??= {})[entry.id] = { ...entry, owner: undefined, reason, refusedAt: new Date().toISOString() };
  delete ledger.queue?.[entry.id];
  if (entry.goal) {
    const mail = new GoalMailStore({ stateDir, goals: Object.keys(ledger.goals ?? {}), sender: 'program' });
    try { mail.send(entry.goal, `${entry.id} queue refused: ${reason}`, `queue-refusal:${entry.id}:${entry.queuedAt}`); }
    finally { mail.close(); }
  }
}

async function startQueued(id: string, submission = false): Promise<void> {
  const captured = (readLedger() as QueueLedger).queue?.[id];
  if (!captured) return;
  let brief: Brief | undefined;
  let parseError: unknown;
  try { brief = parseBrief(readFileSync(captured.brief, 'utf8')); }
  catch (error) { parseError = error; }
  const candidate = await withLedger((ledger: QueueLedger) => {
    const current = ledger.queue?.[id];
    if (!current || current.queuedAt !== captured.queuedAt || (current.owner && processAlive(current.owner))) return;
    // Recover a crash between dispatch publishing its task and removing its queue entry.
    if (ledger.tasks[id]) {
      if (ledger.tasks[id]!.state === 'starting') current.waits = [`${id} is being prepared`];
      else delete ledger.queue![id];
      return;
    }
    if (current.goal && !activeGoals(ledger).includes(current.goal)) {
      current.waits = [`Goal ${current.goal} is not active`];
      return;
    }
    try {
      if (parseError) throw parseError;
      current.waits = ledgerWaits(ledger, brief!, current);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      recordRefusal(ledger, current, reason);
      return { ...current, refusal: reason };
    }
    if (current.waits.length) return;
    return { ...current, refusal: undefined };
  });
  if (!candidate) return;
  let reason = candidate.refusal;
  let computed: { brief: Brief; needs: string[] } | undefined;
  if (!reason) {
    try {
      const validated = await validatedBrief(candidate.brief);
      if (validated.id !== id) throw new Error(`Queued brief ID changed from ${id} to ${validated.id}`);
      const fromPath = goalOfBriefPath(relative(root, candidate.brief));
      if (fromPath && fromPath !== candidate.goal) throw new Error('Queued brief Goal changed');
      computed = { brief: validated, needs: neededFileWaits(validated) };
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  }
  if (candidate.refusal) {
    if (submission) throw new Error(candidate.refusal);
    return;
  }
  const entry = await withLedger((ledger: QueueLedger) => {
    const current = ledger.queue?.[id];
    if (!current || current.queuedAt !== candidate.queuedAt || (current.owner && processAlive(current.owner))) return;
    if (ledger.tasks[id]) {
      if (ledger.tasks[id]!.state === 'starting') current.waits = [`${id} is being prepared`];
      else delete ledger.queue![id];
      return;
    }
    if (current.goal && !activeGoals(ledger).includes(current.goal)) {
      current.waits = [`Goal ${current.goal} is not active`];
      return;
    }
    try {
      if (reason) throw new Error(reason);
      assertDispatchable(ledger, computed!.brief, current.goal, current.allowArea);
      // Dispatch repeats live claims under its own lock before reserving the task.
      current.waits = waitsFor(ledger, computed!.brief, current, computed!.needs);
    } catch (error) {
      const refusal = error instanceof Error ? error.message : String(error);
      recordRefusal(ledger, current, refusal);
      return { ...current, refusal };
    }
    if (current.waits.length) return;
    current.owner = processIdentity(process.pid) ?? { pid: process.pid };
    return { ...current, refusal: undefined };
  });
  if (!entry) return;
  if (entry.refusal) {
    if (submission) throw new Error(entry.refusal);
    return;
  }
  let refusal: string | undefined;
  try {
    // Dispatch resolves Goal ownership from its caller. Isolate that caller so one
    // manager's settling pass can pump every Goal without changing process.env.
    const source = `import { dispatch } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'tasks.ts')).href)}; try { await dispatch(${JSON.stringify(entry.brief)}, new Set(${JSON.stringify(entry.allowArea ? ['--allow-area'] : [])})); } catch (error) { console.error(error.message); process.exit(1); }`;
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: root, env: { ...process.env, GOAL_ID: entry.goal ?? '' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (stdout) process.stdout.write(stdout);
    if (code !== 0) throw new Error(stderr.trim());
  }
  catch (error) { refusal = error instanceof Error ? error.message : String(error); }
  await withLedger((ledger: QueueLedger) => {
    const current = ledger.queue?.[id];
    if (!current || current.queuedAt !== entry.queuedAt) return;
    if (!refusal || ledger.tasks[id]) { delete ledger.queue![id]; return; }
    current.owner = undefined;
    if (current.goal && !activeGoals(ledger).includes(current.goal)) current.waits = [`Goal ${current.goal} is not active`];
    else if (gateRefusal(refusal)) current.waits = [refusal];
    else if (refusal.startsWith(`Claim conflict for ${id}:`) || refusal.startsWith(`${id} depends on `) || refusal.startsWith(`${id} needs `)) {
      // Claims and main may have changed while dispatch waited for the ledger lock.
      try { current.waits = ledgerWaits(ledger, computed!.brief, current); }
      catch { current.waits = []; }
      if (!current.waits.length) current.waits = [refusal];
    } else recordRefusal(ledger, current, refusal);
  });
  if (submission && refusal && !(readLedger() as QueueLedger).queue?.[id]) throw new Error(refusal);
}

export async function queueBrief(path: string, flags = new Set<string>()): Promise<void> {
  const absolute = resolve(path);
  const brief = await validatedBrief(absolute);
  await withLedger((ledger: QueueLedger) => {
    // The program can enqueue any Goal, even when invoked with GOAL_ID=program.
    const goal = briefGoalForProgram(ledger, absolute);
    assertManager(goal);
    const allowArea = flags.has('--allow-area');
    assertDispatchable(ledger, brief, goal, allowArea);
    const entry: QueuedBrief = { id: brief.id, brief: absolute, goal, queuedAt: new Date().toISOString(), waits: [], allowArea };
    entry.waits = ledgerWaits(ledger, brief, entry);
    if (ledger.queue?.[brief.id]) throw new Error(`${brief.id} is already queued`);
    (ledger.queue ??= {})[brief.id] = entry;
    ledger.lastId = Math.max(ledger.lastId ?? 0, Number(brief.id.slice(2)));
  });
  await startQueued(brief.id, true);
  const queued = (readLedger() as QueueLedger).queue?.[brief.id];
  if (queued) console.log(queueLine(queued));
}

function briefGoalForProgram(ledger: Ledger, path: string): string | undefined {
  if (process.env.GOAL_ID !== 'program' || !goalOfBriefPath(relative(root, path))) return briefGoal(ledger, path);
  const caller = process.env.GOAL_ID;
  try { delete process.env.GOAL_ID; return briefGoal(ledger, path); }
  finally { process.env.GOAL_ID = caller; }
}

function queueLine(entry: QueuedBrief): string {
  return `${entry.id} (${entry.goal ?? 'legacy'}) queued since ${entry.queuedAt}: ${entry.waits.join('; ') || 'ready'}`;
}

export async function listQueue(): Promise<void> {
  const snapshot = readLedger() as QueueLedger;
  const entries = Object.values(snapshot.queue ?? {}).filter(entry => !process.env.GOAL_ID
    || process.env.GOAL_ID === 'program' || entry.goal === process.env.GOAL_ID);
  const computed = new Map<string, { brief: Brief; needs: string[] }>();
  const errors = new Map<string, string>();
  for (const entry of entries) {
    try {
      const brief = parseBrief(readFileSync(entry.brief, 'utf8'));
      const blocked = ledgerWaits(snapshot, brief, entry).length || (entry.goal && !activeGoals(snapshot).includes(entry.goal));
      computed.set(entry.id, { brief, needs: blocked ? [] : neededFileWaits(brief) });
    } catch (error) { errors.set(entry.id, error instanceof Error ? error.message : String(error)); }
  }
  await withLedger((ledger: QueueLedger) => {
    for (const captured of entries.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))) {
      const entry = ledger.queue?.[captured.id];
      if (!entry || entry.queuedAt !== captured.queuedAt) continue;
      try {
        if (errors.has(entry.id)) throw new Error(errors.get(entry.id));
        const result = computed.get(entry.id)!;
        entry.waits = entry.goal && !activeGoals(ledger).includes(entry.goal) ? [`Goal ${entry.goal} is not active`]
          : [...waitsFor(ledger, result.brief, entry, result.needs), ...entry.waits.filter(gateRefusal)];
      } catch (error) { entry.waits = [error instanceof Error ? error.message : String(error)]; }
      console.log(queueLine(entry));
    }
    if (!entries.length) console.log('No queued briefs');
  });
}

export async function dropQueue(id: string): Promise<void> {
  await withLedger((ledger: QueueLedger) => {
    const entry = ledger.queue?.[id];
    if (!entry) throw new Error(`${id} is not queued`);
    assertManager(entry.goal);
    if (entry.owner && processAlive(entry.owner)) throw new Error(`${id} is being dispatched; try again after its launch`);
    delete ledger.queue![id];
    console.log(`${id} dropped from queue`);
  });
}

export async function pumpQueue(): Promise<void> {
  const ledger = readLedger() as QueueLedger;
  // Resumes retain their task and claim; give them admission before new briefs.
  for (const task of Object.values(ledger.tasks).filter(task => task.waitingResume)
    .sort((a, b) => a.waitingResume!.queuedAt.localeCompare(b.waitingResume!.queuedAt))) {
    if (task.goal && !activeGoals(ledger).includes(task.goal)) continue;
    const source = `import { resumeTask } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, 'tasks.ts')).href)}; try { await resumeTask(${JSON.stringify(task.id)}, [], ${JSON.stringify(task.waitingResume!.token)}); } catch (error) { console.error(error.message); process.exit(1); }`;
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: root, env: { ...process.env, GOAL_ID: task.goal ?? '' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (stdout) process.stdout.write(stdout);
    if (code !== 0) console.error(`${task.id} waiting resume failed: ${stderr.trim()}`);
  }
  const entries = Object.values(ledger.queue ?? {}).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  for (const entry of entries) await startQueued(entry.id);
}
