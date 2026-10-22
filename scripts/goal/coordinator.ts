import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { processIdentity, processParent, sameProcess, type ProcessIdentity } from '../qa/process/identity.ts';
import { GoalMailStore } from './mail.ts';
import { retryEventDatabase } from './event-store.ts';
import { ensureTermspacesSession, termspacesSession, missingTermspacesReason, termspacesTarget, goalWindows, newGoalWindow, turnWindowName, windowTurns, windowTmux, followTurn } from './windows.ts';
import { JobStore, jobDirectory, wakeJobs, type JobPassOptions } from './job.ts';
import { pidAlive, readLedger, withLedger } from './ledger.ts';
import { engineOf, programOf, isCodex, type Ledger } from './types.ts';
import { coordinateClaudeCapacity } from './claude-capacity.ts';

/** A parked command may run for hours. Recording its caller's end must not wait for a wake or settlement. */
export async function recordWorkerEnds(ledger: Ledger, options: JobPassOptions = {}): Promise<void> {
  const ended = Object.values(ledger.tasks).flatMap(task => task.attempts.filter(attempt => {
    if (attempt.endedAt) return task.attempts.at(-1) === attempt && task.state === 'running'
      && !pidAlive(attempt.pid, programOf(engineOf(attempt)));
    if (!pidAlive(attempt.pid, programOf(engineOf(attempt)))) return true;
    if (!attempt.lastMessage || !existsSync(attempt.lastMessage)) return false;
    const final = statSync(attempt.lastMessage);
    return final.size > 0 && final.mtimeMs >= Date.parse(attempt.startedAt);
  }).map(attempt => ({ id: task.id, n: attempt.n })));
  if (!ended.length) return;
  await (options.mutate ?? withLedger)(current => {
    for (const { id, n } of ended) {
      const task = current.tasks[id];
      const attempt = task?.attempts.find(attempt => attempt.n === n);
      if (!attempt) continue;
      attempt.endedAt ??= new Date().toISOString();
      if (task!.attempts.at(-1) === attempt && task!.state === 'running'
        && !pidAlive(attempt.pid, programOf(engineOf(attempt)))) task!.state = 'exited';
    }
  });
}

/** A coordinator pass retries worker wakes missed by their executor; commands retain their detached
 * executor while queued or running, so taking over never restarts a command or acquires a second slot. */
export async function coordinateWorkerJobs(ledger: Ledger = readLedger(), options: JobPassOptions = {}): Promise<void> {
  // Capacity interruption/checkpoints precede job wakes; test adapters retain their isolated ledger.
  if (!options.mutate) await coordinateClaudeCapacity();
  await recordWorkerEnds(ledger, options);
  for (const cwd of new Set(Object.values(ledger.tasks).map(task => task.worktree))) {
    const directory = jobDirectory(cwd);
    if (!existsSync(join(directory, 'jobs.sqlite'))) continue;
    const store = new JobStore(directory);
    try { await wakeJobs(store, options); } finally { store.close(); }
  }
}

export { processIdentity, sameProcess, type ProcessIdentity };

/** A worker a manager dispatched inherits the manager's session variables, but its `codex exec`
 * process owns its own native session, and its tools carry that session. Only a `codex exec`
 * resuming this same session is the manager itself. */
function underOtherCodexExec(pid: number, session: string, procRoot: string): boolean {
  for (let current = pid, depth = 0; current > 1 && depth < 64; depth++) {
    let args: string[];
    try { args = readFileSync(join(procRoot, String(current), 'cmdline'), 'utf8').split('\0').filter(Boolean); }
    catch { return false; }
    if (/^codex(?:\.exe)?$/.test(basename(args[0] ?? '')) && args[1] === 'exec') return !args.includes(session);
    try {
      const stat = readFileSync(join(procRoot, String(current), 'stat'), 'utf8');
      current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { return false; }
  }
  return false;
}

function procArgs(pid: number, procRoot: string): string[] | undefined {
  try { return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean); }
  catch { return undefined; }
}
function procEnv(pid: number, procRoot: string): string[] | undefined {
  try { return readFileSync(join(procRoot, String(pid), 'environ'), 'utf8').split('\0').filter(entry => entry.length > 0); }
  catch { return undefined; }
}
function procParent(pid: number, procRoot: string): number | undefined {
  return processParent(pid, procRoot);
}
function turnProcesses(token: string): ProcessIdentity[] {
  return readdirSync('/proc').filter(name=>/^\d+$/.test(name)).flatMap(name=>{
    const pid = Number(name);
    const env = procEnv(pid,'/proc');
    if (!envHas(env,'GOAL_TURN_TOKEN',token) || envHas(env,'GOAL_TASK_ID')) return [];
    const identity = processIdentity(pid);
    return identity ? [identity] : [];
  });
}
function envHas(env: string[] | undefined, key: string, value?: string): boolean {
  if (!env) return false;
  const prefix = `${key}=`;
  return env.some(entry => value === undefined ? entry.startsWith(prefix) : entry === `${prefix}${value}`);
}
/** Flags before `--`. A prompt may mention `--resume` without itself being a resume. */
function argvResumesSession(args: string[], session: string): boolean {
  const end = args.indexOf('--');
  const flags = end === -1 ? args : args.slice(0, end);
  for (let index = 0; index < flags.length; index++) {
    const arg = flags[index]!;
    if (arg === '--resume' && flags[index + 1] === session) return true;
    if (arg === `--resume=${session}`) return true;
  }
  return false;
}
function isClaudeProcess(args: string[] | undefined): boolean {
  return /^claude(?:\.exe)?$/.test(basename(args?.[0] ?? ''));
}

/** Claude writes the session id onto the shells it spawns. The claude process itself often still
 * carries its parent's id, so ownership is a claude process with a descendant shell (or that
 * shell's tools) holding this id, or a process whose argv resumes it. A worker inherits the
 * manager's variables and sets GOAL_TASK_ID; that process and its descendants are not the owner. */
function claudeSessionOwner(session: string, procRoot: string): string | undefined {
  const pids = readdirSync(procRoot).filter(name => /^\d+$/.test(name)).map(Number);
  for (const pid of pids) {
    if (!processIdentity(pid, procRoot)) continue;
    const args = procArgs(pid, procRoot);
    if (!args || !argvResumesSession(args, session) || envHas(procEnv(pid, procRoot), 'GOAL_TASK_ID')) continue;
    return `Native session still owned by process ${pid} (resume)`;
  }
  for (const pid of pids) {
    if (!processIdentity(pid, procRoot)) continue;
    const env = procEnv(pid, procRoot);
    if (!envHas(env, 'CLAUDE_CODE_SESSION_ID', session) || envHas(env, 'GOAL_TASK_ID')) continue;
    for (let parent = procParent(pid, procRoot), depth = 0; parent && parent > 1 && depth < 64; depth++) {
      if (!processIdentity(parent, procRoot)) break;
      if (envHas(procEnv(parent, procRoot), 'GOAL_TASK_ID')) break;
      if (isClaudeProcess(procArgs(parent, procRoot))) return `Native session still owned by process ${parent} (environment)`;
      parent = procParent(parent, procRoot);
    }
  }
  return undefined;
}

/** Ownership is the handed-over process generation or evidence naming this exact session. */
export function nativeOwner(_home: string, session: string, previousOwner?: ProcessIdentity, procRoot = '/proc',
  engine?: LaunchDescriptor['engine']): string | undefined {
  if (previousOwner && sameProcess(previousOwner, procRoot)) return `waiting for previous owner ${previousOwner.pid}`;
  if (engine === 'claude') return claudeSessionOwner(session, procRoot);
  for (const entry of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    const pid = Number(entry);
    if (!processIdentity(pid, procRoot)) continue;
    const env = procEnv(pid, procRoot);
    // Task servers can outlive their manager while retaining its session variables.
    if (envHas(env, 'GOAL_TASK_ID')) continue;
    let args: string[];
    try { args = readFileSync(join(procRoot, entry, 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { args = []; }
    // Codex allows options between resume and its session argument.
    if (args.some((arg, index) => arg === 'resume' && args.slice(index + 1).includes(session))) {
      return `Native session still owned by process ${pid} (resume)`;
    }
    if ((env?.includes(`CODEX_SESSION_ID=${session}`) || env?.includes(`CODEX_THREAD_ID=${session}`))
      && !underOtherCodexExec(pid, session, procRoot)) {
      return `Native session still owned by process ${pid} (environment)`;
    }
  }
  return undefined;
}

export interface LaunchDescriptor {
  goal: string; generation: string; session: string; engine: string; effort: string;
  cwd: string; home: string; program: string; args: string[]; env: Record<string, string>;
  socket: string; server: ProcessIdentity; previousOwner?: ProcessIdentity;
  /** Present only until the first native turn has created its resumable session. */
  startArgs?: string[];
}
export const WAKE_PROMPT = '__GOAL_WAKE_PROMPT__';
export const WAKE_LAST_MESSAGE = '__GOAL_WAKE_LAST_MESSAGE__';
/** Shared by startup and every event turn, regardless of manager role or engine. */
export const MANAGER_PROBLEM_SOLVING = [
  'All manager roles, including implementation managers and Program/supermanager, are engineering peers. Routine research, design and repairs need no upward approval or maintainer feedback. This supersedes older internal Program-reading/ruling holds; explicit maintainer boundaries and required independent review still apply.',
  'On any failure, blocker, stalled work or abnormal cost/delay, investigate current source, real inputs, logs and the first failing assertion or setup stage. Research credible remedies and compare correctness, time, resource cost, reuse and effects on peers. Use primary sources or a bounded researcher when needed; a known local defect needs focused investigation, not a broad survey.',
  'Choose the most efficient correct remedy, execute it yourself or through an explicit repair owner, and verify the original failure and affected behavior. Stop unchanged retries; preserve healthy work and keep independent ready work moving. A report, notice, raised retry cap or research assignment alone is not a repair.',
  'Notify every active manager and Program when the problem is discovered and again when it is verified resolved, using one problem identifier. Discovery includes evidence, impact and next action; resolution includes the fix/revision, checks, adoption steps and remaining limits. Use existing Goal mail for each recipient and ensure manager roles sharing a mailbox each receive the notice. Avoid unchanged rebroadcasts; general acknowledgement is not an approval gate.',
  'Coordinate claimed paths, contracts, data and running resources directly with affected peers before changing them; agree one repair owner and compatible boundaries. Apply shared lessons to your own affected scope and update durable guidance in its existing owner. Escalate only a genuinely maintainer-reserved decision, never routine engineering uncertainty. Follow docs/goals/manager.md#shared-problem-solving-duty.',
].join('\n');
export const MANAGER_ROLE_CARD = [
  "You are the manager of Goal <goal> for one event, in a fresh session; other turns of this Goal may run beside you. Read docs/goals/<goal>/state.md, then the event below and only what it points to. Decide it under the manager charter (docs/goals/manager.md; read it only for a rule the event needs). Write a decision into the brief it concerns when it changes what the worker does or what a reviewer accepts; a status, an acknowledgement or a landing's progress goes in no brief. Never edit the brief of a task that is landing (`.temp/goal-orchestration/runs/<id>/land.lock` exists): a landing stops when its brief changed. Edit state.md only when the event is `checkpoint`; a checkpoint does not suspend a necessary repair or other ready work. Acknowledge the mail you were given. Start no watcher and wait on nothing: end the turn when the event is decided. A decision includes its executable disposition, not merely a notice or question.",
  MANAGER_PROBLEM_SOLVING,
  'Carry out what the decision needs before the turn ends: `resume <id> -m` for a worker given more work, `land <id>` for an accepted handoff (`land <id> --step` for a partial one), and `dispatch` or `queue` for a brief you wrote. A landing runs outside the turn and mails this Goal its result: do not wait for it and do not start it again; the turn that reads that mail closes the task (`close <id> verified`) when nothing is left of its brief, or resumes its worker.',
  'Commit each brief when it is written, with `task goal -- commit -m <message> -- <path>`.',
].join('\n');

function cutRetryBody(body: string, descriptor: LaunchDescriptor): string {
  const directory = `docs/goals/${descriptor.goal}/tasks/`;
  const status = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', directory],
    { cwd: descriptor.cwd, encoding: 'utf8' });
  const briefs: string[] = [];
  const entries = status.status === 0 ? status.stdout.split('\0') : [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const file = entry.slice(3);
    if (file.startsWith(directory) && file.endsWith('.md') && existsSync(join(descriptor.cwd, file))) briefs.push(file);
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) index++;
  }
  return `${body}\n\nIts first turn was cut at the manager turn bound; decide this retry within the bound.`
    + (briefs.length ? `\nContinue these briefs rather than writing them again:\n${briefs.sort().join('\n')}` : '');
}

/** Keep the enrolled account, model and effort, but never its conversation. */
export function freshTurnDescriptor(role: LaunchDescriptor): LaunchDescriptor {
  const session = randomUUID();
  const args = [...(role.startArgs ?? role.args)];
  if (role.engine === 'claude') {
    const resume = args.indexOf('--resume');
    if (resume !== -1) args.splice(resume, 2);
    const id = args.indexOf('--session-id');
    if (id !== -1) args[id + 1] = session;
    else args.splice(args.indexOf('--') === -1 ? args.length : args.indexOf('--'), 0, '--session-id', session);
  } else if (args[0] === 'exec' && args[1] === 'resume') args.splice(1, 2);
  const {startArgs: _startArgs, ...descriptor} = role;
  return {...descriptor, session, args};
}

export function managerStartMessage(goal: string): string {
  return `You are the REZICS manager of Goal ${goal}. Read docs/goals/${goal}/GOAL.md, its
state.md, docs/goals/method.md and docs/goals/manager.md, then run the Goal.
${MANAGER_PROBLEM_SOLVING}
goalctl has registered this manager and enrolled it in the coordinator. You hold
the maintainer's authority as the manager charter describes; documents are
practice to consult, and only its standing directions bind you. Local host
credentials are in .temp/vault/ (manager only; never pass them to workers or
external tools). End each turn when nothing is ready; the coordinator starts
the next turn on mail or task exits, so arm no watchers.`;
}

export function managerSessionExists(descriptor: LaunchDescriptor): boolean {
  if (!descriptor.home) return false;
  if (descriptor.engine === 'claude') {
    return existsSync(join(descriptor.home, 'projects', claudeProjectKey(descriptor.cwd), `${descriptor.session}.jsonl`));
  }
  return [...new Bun.Glob(`sessions/**/rollout-*${descriptor.session}.jsonl`).scanSync({cwd:descriptor.home})].length > 0;
}

/** One finite Claude Code turn. The prompt placeholder is replaced after the attempt is recorded. */
export function claudeWakeArgs(session: string, model: string, effort: string): string[] {
  return ['-p', '--resume', session, '--model', model, '--effort', effort, '--dangerously-skip-permissions',
    '--output-format', 'json', '--', WAKE_PROMPT];
}

/** Claude's project directory name: every non-alphanumeric character, including `/` and `.`, becomes `-`.
 * Past 200 characters Claude keeps that prefix and a 32-bit hash of the original path. */
const CLAUDE_PROJECT_KEY_LIMIT = 200;
function claudePathHash(value: string): string {
  // Claude's own project-key hash: signed 32-bit `(hash << 5) - hash + char`.
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash).toString(36);
}
export function claudeProjectKey(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= CLAUDE_PROJECT_KEY_LIMIT) return sanitized;
  return `${sanitized.slice(0, CLAUDE_PROJECT_KEY_LIMIT)}-${claudePathHash(cwd)}`;
}
export function claudeConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}
export interface WakeEvent { key: string; body: string; dueAt?: number }
interface Attempt {
  token: string; goal: string; generation: string; phase: 'intent' | 'claimed' | 'cutting' | 'done';
  descriptor: string; prompt: string; wrapper: string | null; child: string | null;
  code: number | null; created_at: number;
  event_key: string | null; started_at: number | null; ended_at: number | null;
  ending: 'exit' | 'cut' | 'crash' | null;
  input_tokens: number | null; cached_tokens: number | null; output_tokens: number | null;
}
interface WakeRow { goal: string; due_at: number; failures: number; error: string | null; token: string | null }
interface EventRow extends WakeRow {event_key: string; body: string; handled: number; cuts:number}
export function eventTasks(event: Pick<WakeEvent,'key'|'body'>): string[] {
  // Checkpoints only write state.md; their task IDs describe handled history, not mutations.
  if (event.key.startsWith('checkpoint:')) return [];
  return [...new Set((`${event.key}\n${event.body}`.match(/\bG-\d+\b/gi) ?? []).map(task=>task.toUpperCase()))];
}
export interface CoordinatorOptions {
  stateDir: string;
  events: (goal: string) => WakeEvent[];
  /** Existing goalctl account/concurrency/memory gates; no alternate admission policy. */
  admit: (descriptor: LaunchDescriptor) => void;
  launcher?: IndependentLauncher;
  owner?: (home: string, session: string, previousOwner?: ProcessIdentity) => string | undefined;
  now?: () => number;
  afterIntent?: (token: string) => void;
  afterLaunch?: (token: string) => void;
  maxTurns?: number;
  turnMinutes?: number;
  notifyCut?: (goal: string, key: string) => void;
  storeWaitMs?: number;
}
export interface IndependentLauncher {
  verify(descriptor: LaunchDescriptor): void;
  live(token: string, descriptor: LaunchDescriptor): boolean;
  launch(token: string, descriptor: LaunchDescriptor): void;
  stop?(token: string, descriptor: LaunchDescriptor, child: ProcessIdentity | undefined): void;
}
/** Manager tools share this group; dispatched workers have their own detached groups. */
export function stopTurnProcesses(token: string, child?: ProcessIdentity): void {
  const candidates = child && sameProcess(child) ? [child] : turnProcesses(token);
  for (const identity of candidates) {
    if (!sameProcess(identity) || identity.pid === process.pid) continue;
    let group: number;
    try {
      const stat = readFileSync(join('/proc',String(identity.pid),'stat'),'utf8');
      group = Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]);
    } catch { continue; }
    if (group !== identity.pid && group !== child?.pid) continue;
    try { process.kill(-group,'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}
function tmux(socket: string, args: string[]): string {
  const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Independent tmux launcher unavailable: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
export function tmuxServer(socket: string): ProcessIdentity {
  const identity = processIdentity(Number(tmux(socket, ['display-message', '-p', '#{pid}'])));
  if (!identity) throw new Error('Cannot identify independent tmux server');
  return identity;
}
export class TmuxLauncher implements IndependentLauncher {
  constructor(private readonly stateDir: string, private readonly modulePath = import.meta.filename) {}
  verify(_descriptor: LaunchDescriptor): void {
    if (!termspacesSession()) throw new Error(missingTermspacesReason());
    const current = tmuxServer(termspacesTarget().socket);
    let own = processIdentity(process.pid)!;
    const file = join(this.stateDir,'coordinator.sqlite');
    if (existsSync(file)) {
      const db = retryEventDatabase(new Database(file,{readonly:true}));
      try {
        const row = db.query('SELECT identity FROM pump_owner WHERE singleton=1').get() as {identity:string}|null;
        if (row) {
          const pump = JSON.parse(row.identity) as ProcessIdentity;
          // A command from inside tmux is still outside the service; the live pump owns that boundary.
          if (sameProcess(pump)) own = pump;
        }
      } finally { db.close(); }
    }
    // A sibling process in the coordinator unit is still killed by KillMode=control-group.
    const ownGroup = own.cgroup.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    const serverGroup = current.cgroup.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!ownGroup || !serverGroup || serverGroup === ownGroup || serverGroup.startsWith(`${ownGroup}/`)) {
      throw new Error('tmux server must run outside the coordinator cgroup');
    }
  }
  live(token: string, descriptor: LaunchDescriptor): boolean {
    this.verify(descriptor);
    return goalWindows(ensureTermspacesSession()).some(window=>window.turn === token && !window.dead);
  }
  launch(token: string, descriptor: LaunchDescriptor): void {
    this.verify(descriptor);
    const turn = windowTurns(this.stateDir).find(turn=>turn.token === token);
    if (!turn) throw new Error('Unknown manager turn');
    const session = ensureTermspacesSession();
    const name = turnWindowName(turn);
    if (goalWindows(session).some(window=>window.name === name)) return;
    // The durable attempt CAS prevents a replay from running the native engine twice.
    const id = newGoalWindow(session,name,['sh','-c','trap "" HUP; exec "$@"','goal-turn',
      process.execPath,this.modulePath,'attempt',this.stateDir,token],descriptor.cwd);
    windowTmux(['set-option','-w','-t',id,'@goal-turn-token',token]);
  }
  stop(token: string, _descriptor: LaunchDescriptor, child?: ProcessIdentity): void {
    stopTurnProcesses(token,child);
    // Reconciliation removes the view after the cut's durable record is written.
  }
}

function openStore(stateDir: string, waitMs = 5000): Database {
  mkdirSync(stateDir, { recursive: true });
  const db = retryEventDatabase(new Database(join(stateDir, 'coordinator.sqlite'), {create:true, strict:true}), waitMs);
  for (const sql of `PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS managers(goal TEXT PRIMARY KEY, descriptor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wakes(goal TEXT PRIMARY KEY, due_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      error TEXT, token TEXT);
    CREATE TABLE IF NOT EXISTS events(goal TEXT NOT NULL, event_key TEXT NOT NULL, body TEXT NOT NULL,
      due_at INTEGER NOT NULL, token TEXT, handled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(goal,event_key));
    CREATE TABLE IF NOT EXISTS attempts(token TEXT PRIMARY KEY, goal TEXT NOT NULL, generation TEXT NOT NULL,
      phase TEXT NOT NULL, descriptor TEXT NOT NULL, prompt TEXT NOT NULL, wrapper TEXT, child TEXT,
      code INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pump_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL);`.split(';').filter(sql => sql.trim())) db.exec(sql);
  db.transaction(()=>{
    const columns = new Set((db.query('PRAGMA table_info(attempts)').all() as {name:string}[]).map(column=>column.name));
    for (const [name,type] of Object.entries({event_key:'TEXT',started_at:'INTEGER',ended_at:'INTEGER',ending:'TEXT',
      input_tokens:'INTEGER',cached_tokens:'INTEGER',output_tokens:'INTEGER'})) {
      if (!columns.has(name)) db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
    }
    for (const sql of `CREATE TABLE IF NOT EXISTS turn_commands(id INTEGER PRIMARY KEY, token TEXT NOT NULL,
    command TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admissions(goal TEXT PRIMARY KEY,due_at INTEGER NOT NULL,failures INTEGER NOT NULL,error TEXT);
    CREATE TABLE IF NOT EXISTS cut_notices(goal TEXT NOT NULL,event_key TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(goal,event_key));
    CREATE TABLE IF NOT EXISTS handled_events(sequence INTEGER PRIMARY KEY,goal TEXT NOT NULL,event_key TEXT NOT NULL,
      handled_at INTEGER NOT NULL,UNIQUE(goal,event_key));
    CREATE TABLE IF NOT EXISTS checkpoints(goal TEXT PRIMARY KEY,covered_through INTEGER NOT NULL DEFAULT 0,
      queued_key TEXT,through_sequence INTEGER)`.split(';').filter(sql => sql.trim())) db.exec(sql);
    const eventColumns = new Set((db.query('PRAGMA table_info(events)').all() as {name:string}[]).map(column=>column.name));
    for (const [name,type] of Object.entries({failures:'INTEGER NOT NULL DEFAULT 0',error:'TEXT',cuts:'INTEGER NOT NULL DEFAULT 0'})) {
      if (!eventColumns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    }
  }).immediate();
  return db;
}

/** The CLI entry calls this once; worker commands without a turn token have no recording side effect. */
export function recordTurnCommand(argv: string[]): void {
  const token = process.env.GOAL_TURN_TOKEN;
  const directory = process.env.GOAL_TURN_STATE_DIR;
  if (!token || !directory || !argv[0]) return;
  const db = openStore(directory);
  try {
    if (!db.query('SELECT token FROM attempts WHERE token=?').get(token)) throw new Error('Unknown manager turn token');
    const command = argv[0] === 'mail' ? argv.slice(0,2).join(' ') : argv[0];
    db.query('INSERT INTO turn_commands(token,command,created_at) VALUES(?,?,?)').run(token,command,Date.now());
  } finally { db.close(); }
}

export function turnUsage(output: string): {input: number | null; cached: number | null; output: number | null} {
  let input: number | null = null, cached: number | null = null, generated: number | null = null;
  const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  for (const line of output.split('\n')) {
    let record: {type?:string;usage?:Record<string,unknown>};
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (!record.usage || !['turn.completed','result'].includes(record.type ?? '')) continue;
    const usage = record.usage;
    if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') continue;
    const read = count(record.type === 'result' ? usage.cache_read_input_tokens : usage.cached_input_tokens);
    input = (input ?? 0) + count(usage.input_tokens)
      + (record.type === 'result' ? read + count(usage.cache_creation_input_tokens) : 0);
    cached = (cached ?? 0) + read;
    generated = (generated ?? 0) + count(usage.output_tokens);
  }
  return {input,cached,output:generated};
}
function finishTurn(db: Database, stateDir: string, token: string, ending: NonNullable<Attempt['ending']>, code: number, now: number): void {
  const file = join(stateDir,'manager-runs',token,'output.jsonl');
  const usage = turnUsage(existsSync(file) ? readFileSync(file,'utf8') : '');
  db.query(`UPDATE attempts SET phase='done',code=?,ended_at=?,ending=?,input_tokens=?,cached_tokens=?,output_tokens=?
    WHERE token=? AND phase!='done' AND (ending IS NULL OR ending=?)`).run(code,now,ending,usage.input,usage.cached,usage.output,token,ending);
}
export class GoalCoordinator {
  readonly db: Database;
  private readonly launcher: IndependentLauncher;
  private readonly now: () => number;
  private readonly maxTurns: number;
  private readonly turnMs: number;
  constructor(private readonly options: CoordinatorOptions) {
    this.db = openStore(options.stateDir, options.storeWaitMs);
    this.launcher = options.launcher ?? new TmuxLauncher(options.stateDir);
    this.now = options.now ?? Date.now;
    this.maxTurns = options.maxTurns ?? Number(process.env.GOAL_MANAGER_TURNS ?? 6);
    if (!Number.isSafeInteger(this.maxTurns) || this.maxTurns < 1) throw new Error('GOAL_MANAGER_TURNS must be a positive integer');
    const minutes = options.turnMinutes ?? Number(process.env.GOAL_TURN_MINUTES ?? 10);
    if (!Number.isFinite(minutes*60_000) || minutes <= 0) throw new Error('GOAL_TURN_MINUTES must be positive and finite');
    this.turnMs = minutes*60_000;
  }
  private sessionOwner(descriptor: LaunchDescriptor): string | undefined {
    if (this.options.owner) return this.options.owner(descriptor.home, descriptor.session, descriptor.previousOwner);
    return nativeOwner(descriptor.home, descriptor.session, descriptor.previousOwner, '/proc', descriptor.engine);
  }
  enroll(descriptor: LaunchDescriptor): void {
    const codex = isCodex(descriptor.engine);
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(descriptor.goal) || !descriptor.generation || !descriptor.session
      || (descriptor.engine !== 'claude' && !codex)
      || !descriptor.args.includes(WAKE_PROMPT)
      || (descriptor.engine !== 'claude' && !descriptor.args.includes(WAKE_LAST_MESSAGE))
      || (!descriptor.previousOwner && !descriptor.startArgs?.includes(WAKE_PROMPT))
      || (descriptor.previousOwner && (!Number.isSafeInteger(descriptor.previousOwner.pid) || descriptor.previousOwner.pid <= 0
        || !descriptor.previousOwner.start || !descriptor.previousOwner.boot))) throw new Error('Invalid manager launch descriptor');
    this.launcher.verify(descriptor);
    this.db.transaction(() => {
      if (this.db.query('SELECT goal FROM managers WHERE goal=?').get(descriptor.goal)) throw new Error('Manager already enrolled; descriptor is immutable');
      const enrolled = this.db.query('SELECT descriptor FROM managers').all() as {descriptor:string}[];
      for (const row of enrolled) {
        const prior = JSON.parse(row.descriptor) as LaunchDescriptor;
        if (prior.session === descriptor.session && prior.home === descriptor.home) throw new Error('Native session already enrolled');
      }
      this.db.query('INSERT INTO managers VALUES(?,?)').run(descriptor.goal, JSON.stringify(descriptor));
    }).immediate();
  }
  private managers(): LaunchDescriptor[] {
    return (this.db.query('SELECT descriptor FROM managers ORDER BY goal').all() as {descriptor:string}[])
      .map(row => JSON.parse(row.descriptor) as LaunchDescriptor);
  }
  assertStartable(goal: string): void {
    const prior = this.managers().find(manager => manager.goal === goal);
    if (!prior) return;
    if (prior.startArgs && !this.db.query('SELECT token FROM attempts WHERE goal=? AND generation=?').get(goal,prior.generation)) {
      throw new Error('Manager start is already queued');
    }
    if (this.db.query("SELECT token FROM attempts WHERE goal=? AND phase!='done'").get(goal)
      || (!prior.startArgs && this.db.query('SELECT token FROM wakes WHERE goal=? AND token IS NOT NULL').get(goal))) {
      throw new Error('Manager has an unresolved attempt; reconcile it before starting a replacement');
    }
    const owner = this.sessionOwner(prior);
    if (owner) throw new Error(owner);
    throw new Error('Manager role already enrolled; unenroll it before starting a replacement');
  }
  start(descriptor: LaunchDescriptor): void {
    if (descriptor.previousOwner || !descriptor.startArgs?.includes(WAKE_PROMPT)) throw new Error('Start needs a fresh manager, without a previous owner');
    this.db.transaction(() => {
      this.assertStartable(descriptor.goal);
      // Re-enrolling a role preserves the Goal's queued events and checkpoint coverage.
      this.db.query('DELETE FROM managers WHERE goal=?').run(descriptor.goal);
      this.db.query('DELETE FROM wakes WHERE goal=?').run(descriptor.goal);
      this.db.query('DELETE FROM admissions WHERE goal=?').run(descriptor.goal);
      this.enroll(descriptor);
      this.db.query('INSERT INTO events(goal,event_key,body,due_at) VALUES(?,?,?,?)')
        .run(descriptor.goal,`start:${descriptor.generation}`,managerStartMessage(descriptor.goal),this.now());
    }).immediate();
  }
  status(): { managers: (LaunchDescriptor & { ownership: string | null })[]; wakes: WakeRow[]; attempts: Attempt[] } {
    return {managers:this.managers().map(descriptor => ({ ...descriptor,
      ownership: this.sessionOwner(descriptor) ?? null })),
    wakes:this.db.query('SELECT * FROM wakes ORDER BY goal').all() as WakeRow[],
    attempts:this.db.query('SELECT * FROM attempts ORDER BY created_at').all() as Attempt[]};
  }
  turns(filters: {goal?: string; since?: number} = {}): {turns:(Attempt & {commands:string[]})[]; summary:{turns:number;medianInputTokens:number|null;ackOnlyTurns:number}} {
    const turns = (this.db.query(`SELECT * FROM attempts WHERE (? IS NULL OR goal=?)
      AND (? IS NULL OR COALESCE(started_at,created_at)>=?) ORDER BY created_at,rowid`)
      .all(filters.goal ?? null,filters.goal ?? null,filters.since ?? null,filters.since ?? null) as Attempt[])
      .map(turn=>({...turn,commands:(this.db.query('SELECT command FROM turn_commands WHERE token=? ORDER BY id')
        .all(turn.token) as {command:string}[]).map(row=>row.command)}));
    const inputs = turns.map(turn=>turn.input_tokens).filter((value): value is number=>value !== null).sort((a,b)=>a-b);
    const middle = Math.floor(inputs.length/2);
    return {turns,summary:{turns:turns.length,medianInputTokens:inputs.length
      ? inputs.length%2 ? inputs[middle]! : (inputs[middle-1]!+inputs[middle]!)/2 : null,
    ackOnlyTurns:turns.filter(turn=>turn.commands.length > 0 && turn.commands.every(command=>command === 'mail ack')).length}};
  }
  unenroll(goal: string): void {
    if (this.db.query('SELECT token FROM events WHERE goal=? AND token IS NOT NULL').get(goal)) throw new Error('Cannot unenroll with an unresolved attempt; reconcile it first');
    this.db.query('DELETE FROM managers WHERE goal=?').run(goal);
  }
  private defer(goal: string, error: string): void {
    const row = this.db.query('SELECT * FROM admissions WHERE goal=?').get(goal) as WakeRow | null;
    const failures = (row?.failures ?? 0) + 1;
    const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 8));
    this.db.query('INSERT OR REPLACE INTO admissions VALUES(?,?,?,?)').run(goal,this.now()+delay,failures,error);
  }
  private deferEvent(event: EventRow, error: string): void {
    const failures = event.failures+1;
    const delay = Math.min(15*60_000,5_000*2 ** Math.min(failures-1,8));
    this.db.query('UPDATE events SET due_at=?,failures=?,error=? WHERE goal=? AND event_key=?')
      .run(this.now()+delay,failures,error,event.goal,event.event_key);
  }
  private refreshWake(goal: string): void {
    const event = this.db.query('SELECT * FROM events WHERE goal=? AND handled=0 ORDER BY token IS NOT NULL DESC,due_at,event_key LIMIT 1').get(goal) as EventRow | null;
    if (!event) {
      this.db.query('DELETE FROM wakes WHERE goal=?').run(goal);
      this.db.query('DELETE FROM admissions WHERE goal=?').run(goal);
      return;
    }
    const admission = this.db.query('SELECT * FROM admissions WHERE goal=?').get(goal) as WakeRow|null;
    this.db.query('INSERT OR REPLACE INTO wakes VALUES(?,?,?,?,?)')
      .run(goal,admission?.due_at ?? event.due_at,admission?.failures ?? event.failures,admission?.error ?? event.error,event.token);
  }
  private cut(attempt: Attempt, descriptor: LaunchDescriptor): void {
    const current = this.db.transaction(()=>{
      const updated = this.db.query("UPDATE attempts SET phase='cutting',ending='cut' WHERE token=? AND phase!='done'").run(attempt.token);
      return updated.changes ? this.db.query('SELECT child FROM attempts WHERE token=?').get(attempt.token) as {child:string|null} : null;
    }).immediate();
    if (!current) return;
    const child = current.child ? JSON.parse(current.child) as ProcessIdentity : undefined;
    if (this.launcher.stop) this.launcher.stop(attempt.token,descriptor,child);
    else stopTurnProcesses(attempt.token,child);
    finishTurn(this.db,this.options.stateDir,attempt.token,'cut',137,this.now());
  }
  private sendCutNotices(): void {
    const notices = this.db.query('SELECT goal,event_key FROM cut_notices WHERE sent=0').all() as {goal:string;event_key:string}[];
    for (const notice of notices) {
      try {
        if (this.options.notifyCut) this.options.notifyCut(notice.goal,notice.event_key);
        else {
          const mail = new GoalMailStore({stateDir:this.options.stateDir,goals:['program',...new Set([notice.goal,...this.managers().map(role=>role.goal)])],sender:notice.goal});
          try { mail.send('program',`Manager event ${notice.event_key} of Goal ${notice.goal} was cut twice and stopped. Inspect its turn records.`,
            `manager-turn-cut:${notice.goal}:${notice.event_key}`); } finally { mail.close(); }
        }
        this.db.query('UPDATE cut_notices SET sent=1 WHERE goal=? AND event_key=?').run(notice.goal,notice.event_key);
      } catch (error) { console.error(`Cut notice for ${notice.goal}/${notice.event_key} remains pending: ${String(error)}`); }
    }
  }
  private handled(event: EventRow): void {
    if (event.event_key.startsWith('checkpoint:')) {
      this.db.query('UPDATE checkpoints SET covered_through=through_sequence,queued_key=NULL,through_sequence=NULL WHERE goal=? AND queued_key=?')
        .run(event.goal,event.event_key);
    } else this.db.query('INSERT OR IGNORE INTO handled_events(goal,event_key,handled_at) VALUES(?,?,?)')
      .run(event.goal,event.event_key,this.now());
  }
  private queueCheckpoint(goal: string): void {
    const state = this.db.query('SELECT * FROM checkpoints WHERE goal=?').get(goal) as {covered_through:number;queued_key:string|null}|null;
    if (state?.queued_key) return;
    const uncovered = this.db.query('SELECT sequence,event_key,handled_at FROM handled_events WHERE goal=? AND sequence>? ORDER BY sequence')
      .all(goal,state?.covered_through ?? 0) as {sequence:number;event_key:string;handled_at:number}[];
    if (!uncovered.length || (uncovered.length < 10 && this.now()-uncovered[0]!.handled_at < 30*60_000)) return;
    const key = `checkpoint:${randomUUID()}`;
    this.db.transaction(()=>{
      this.db.query('INSERT INTO events(goal,event_key,body,due_at) VALUES(?,?,?,?)')
        .run(goal,key,`Checkpoint: update docs/goals/${goal}/state.md from the decisions for these handled events:\n`
          + uncovered.map(event=>event.event_key).join('\n'),this.now());
      this.db.query(`INSERT INTO checkpoints(goal,queued_key,through_sequence) VALUES(?,?,?)
        ON CONFLICT(goal) DO UPDATE SET queued_key=excluded.queued_key,through_sequence=excluded.through_sequence`)
        .run(goal,key,uncovered.at(-1)!.sequence);
    }).immediate();
  }
  step(): void {
    this.sendCutNotices();
    for (const descriptor of this.managers()) {
      const goal = descriptor.goal;
      const incoming = this.options.events(goal);
      this.db.transaction(() => {
        for (const event of incoming) {
          this.db.query('INSERT OR IGNORE INTO events(goal,event_key,body,due_at) VALUES(?,?,?,?)')
            .run(goal,event.key,event.body,event.dueAt ?? this.now());
        }
        const pendingMail = new Set(incoming.filter(event => event.key.startsWith('mail:')).map(event => event.key));
        const queuedMail = this.db.query("SELECT event_key FROM events WHERE goal=? AND event_key LIKE 'mail:%' AND token IS NULL AND handled=0 AND cuts=0")
          .all(goal) as {event_key:string}[];
        for (const event of queuedMail) {
          if (!pendingMail.has(event.event_key)) this.db.query('UPDATE events SET handled=1 WHERE goal=? AND event_key=?').run(goal,event.event_key);
        }
      }).immediate();
      let reconciled = false;
      const assigned = this.db.query('SELECT * FROM events WHERE goal=? AND token IS NOT NULL ORDER BY due_at,event_key').all(goal) as EventRow[];
      for (const event of assigned) {
        const attempt = this.db.query('SELECT * FROM attempts WHERE token=?').get(event.token!) as Attempt;
        if (attempt.phase === 'done') {
          if (attempt.ending === 'cut') {
            this.db.transaction(()=>{
              const cuts = event.cuts+1;
              this.db.query('UPDATE events SET token=NULL,cuts=?,handled=?,body=? WHERE goal=? AND event_key=?')
                .run(cuts,cuts >= 2 ? 1 : 0,cuts === 1 ? cutRetryBody(event.body,descriptor) : event.body,goal,event.event_key);
              if (cuts >= 2) this.db.query('INSERT OR IGNORE INTO cut_notices(goal,event_key) VALUES(?,?)').run(goal,event.event_key);
              else this.deferEvent(event,'First manager turn was cut; retrying once');
            }).immediate();
            reconciled = true;
            continue;
          }
          // Acknowledgements, rather than starting a process, determine durable mail delivery.
          const remaining = new Set(incoming.map(event => event.key));
          const handled = !event.event_key.startsWith('mail:') ? attempt.code === 0
            : event.event_key.startsWith('mail:overdue:') ? attempt.code === 0 || !remaining.has(event.event_key)
            : !remaining.has(event.event_key);
          this.db.transaction(()=>{
            this.db.query('UPDATE events SET token=NULL,handled=? WHERE goal=? AND event_key=?')
              .run(handled ? 1 : 0,goal,event.event_key);
            if (handled) this.handled(event);
            else this.deferEvent(event,attempt.code === 0 ? 'Turn ended with pending events/acknowledgements' : `Manager exit ${attempt.code}`);
          }).immediate();
          reconciled = true;
          continue;
        }
        try {
          if (attempt.phase === 'cutting' || this.now()-(attempt.started_at ?? attempt.created_at) >= this.turnMs) {
            this.cut(attempt,descriptor);
            continue;
          }
          this.launcher.verify(descriptor);
          if (attempt.phase === 'claimed') {
            const wrapper = attempt.wrapper ? JSON.parse(attempt.wrapper) as ProcessIdentity : undefined;
            const child = attempt.child ? JSON.parse(attempt.child) as ProcessIdentity : undefined;
            if ((wrapper && sameProcess(wrapper)) || (child && sameProcess(child)) || this.launcher.live(attempt.token,descriptor)) continue;
            // A child can outlive a wrapper that died between spawn and registration.
            if (turnProcesses(attempt.token).length) continue;
            finishTurn(this.db,this.options.stateDir,attempt.token,'crash',127,this.now());
            continue;
          }
          if (this.launcher.live(attempt.token,descriptor)) continue;
          if (this.now() < event.due_at) continue;
          const admission = this.db.query('SELECT * FROM admissions WHERE goal=?').get(goal) as WakeRow|null;
          if (admission && this.now() < admission.due_at) continue;
          const owner = this.sessionOwner(descriptor);
          if (owner) throw new Error(owner);
          this.options.admit(descriptor);
          this.db.query('DELETE FROM admissions WHERE goal=?').run(goal);
          this.deferEvent(event, 'Retrying unregistered independent wrapper');
          this.launcher.launch(attempt.token,descriptor);
          this.options.afterLaunch?.(attempt.token);
        } catch (error) { this.defer(goal, String(error)); }
      }
      this.queueCheckpoint(goal);
      const admission = this.db.query('SELECT * FROM admissions WHERE goal=?').get(goal) as WakeRow|null;
      if (!reconciled && (!admission || this.now() >= admission.due_at)) {
        const active = this.db.query('SELECT * FROM events WHERE goal=? AND token IS NOT NULL').all(goal) as EventRow[];
        const locked = new Set(active.flatMap(event=>eventTasks({key:event.event_key,body:event.body})));
        let checkpointActive = active.some(event=>event.event_key.startsWith('checkpoint:'));
        let slots = this.maxTurns-active.length;
        const queued = this.db.query("SELECT * FROM events WHERE goal=? AND handled=0 AND token IS NULL AND due_at<=? ORDER BY event_key LIKE 'start:%' DESC,event_key LIKE 'checkpoint:%' DESC,event_key LIKE 'mail:overdue:%' DESC,due_at,rowid")
          .all(goal,this.now()) as EventRow[];
        for (const event of queued) {
          if (slots <= 0) break;
          const tasks = eventTasks({key:event.event_key,body:event.body});
          const checkpoint = event.event_key.startsWith('checkpoint:');
          if (checkpoint && checkpointActive) continue;
          if (tasks.some(task=>locked.has(task))) {
            // A blocked earlier event reserves all the tasks it names; later events cannot pass it.
            for (const task of tasks) locked.add(task);
            continue;
          }
          try {
            this.launcher.verify(descriptor);
            const owner = this.sessionOwner(descriptor);
            if (owner) throw new Error(owner);
            this.options.admit(descriptor);
          } catch (error) { this.defer(goal,String(error)); break; }
          this.db.query('DELETE FROM admissions WHERE goal=?').run(goal);
          const token = randomUUID();
          const prompt = MANAGER_ROLE_CARD.replaceAll('<goal>',goal) + `\n\nEvent: ${event.event_key}\n${event.body}`;
          const turn = freshTurnDescriptor(descriptor);
          this.db.transaction(() => {
            this.db.query('INSERT INTO attempts(token,goal,generation,phase,descriptor,prompt,created_at,event_key) VALUES(?,?,?,?,?,?,?,?)')
              .run(token,goal,descriptor.generation,'intent',JSON.stringify(turn),prompt,this.now(),event.event_key);
            this.db.query('UPDATE events SET token=? WHERE goal=? AND event_key=?')
              .run(token,goal,event.event_key);
          }).immediate();
          slots--;
          if (checkpoint) checkpointActive = true;
          for (const task of tasks) locked.add(task);
          this.refreshWake(goal);
          this.options.afterIntent?.(token);
          try {
            this.launcher.launch(token,descriptor);
            this.db.query('UPDATE events SET due_at=?,error=? WHERE goal=? AND event_key=?')
              .run(this.now()+5000,'Awaiting independent wrapper claim',goal,event.event_key);
            this.options.afterLaunch?.(token);
          } catch (error) { this.deferEvent(event,String(error)); }
        }
      }
      this.refreshWake(goal);
    }
    this.sendCutNotices();
  }
  acquire(): void {
    const identity = processIdentity(process.pid)!;
    this.db.transaction(() => {
      const prior = this.db.query('SELECT identity FROM pump_owner WHERE singleton=1').get() as {identity:string}|null;
      if (prior && sameProcess(JSON.parse(prior.identity) as ProcessIdentity)) throw new Error('Coordinator already running');
      this.db.query('INSERT OR REPLACE INTO pump_owner VALUES(1,?)').run(JSON.stringify(identity));
    }).immediate();
  }
  release(): void { this.db.query('DELETE FROM pump_owner WHERE singleton=1 AND identity=?').run(JSON.stringify(processIdentity(process.pid))); }
  close(): void { this.db.close(); }
}

/** Runs in the independent server's cgroup; the durable CAS happens before any native resume. */
export async function runAttempt(stateDir: string, token: string, display = false): Promise<void> {
  const db = openStore(stateDir);
  let attempt: Attempt | undefined;
  db.transaction(() => {
    const row = db.query('SELECT * FROM attempts WHERE token=?').get(token) as Attempt|null;
    if (!row || row.phase !== 'intent') return;
    db.query("UPDATE attempts SET phase='claimed',wrapper=?,started_at=? WHERE token=? AND phase='intent'")
      .run(JSON.stringify(processIdentity(process.pid)),Date.now(),token);
    attempt = row;
  }).immediate();
  if (!attempt) { db.close(); return; }
  // tmux closes the terminal with SIGHUP. The wrapper must still record the
  // detached engine's outcome when its view is closed or termspaces is reset.
  const ignoreHangup = () => {};
  if (display) {
    process.on('SIGHUP',ignoreHangup);
    process.stdout.on('error',ignoreHangup);
  }
  const viewing = display ? followTurn(stateDir,token) : undefined;
  const descriptor = JSON.parse(attempt.descriptor) as LaunchDescriptor;
  const directory = join(stateDir,'manager-runs',token);
  mkdirSync(directory,{recursive:true});
  const args = descriptor.args.map(arg => arg === WAKE_PROMPT ? attempt!.prompt
    : arg === WAKE_LAST_MESSAGE ? join(directory,'last.md') : arg);
  const stdout = openSync(join(directory,'output.jsonl'),'w');
  const stderr = openSync(join(directory,'stderr.log'),'w');
  try {
    const owner = nativeOwner(descriptor.home,descriptor.session,descriptor.previousOwner,'/proc',descriptor.engine);
    if (owner) throw new Error(owner);
    // The store runs this transaction again when its commit meets a reader; the engine starts once.
    let spawned: ReturnType<typeof spawn> | undefined;
    const child = db.transaction(()=>{
      const current = db.query('SELECT phase FROM attempts WHERE token=?').get(token) as {phase:string};
      if (current.phase !== 'claimed') return undefined;
      spawned ??= spawn(descriptor.program,args,{cwd:descriptor.cwd,detached:true,
        env:{...descriptor.env,GOAL_TURN_TOKEN:token,GOAL_TURN_STATE_DIR:stateDir},stdio:['ignore',stdout,stderr]});
      if (!spawned.pid) throw new Error('Native turn failed to spawn');
      db.query('UPDATE attempts SET child=? WHERE token=?').run(JSON.stringify(processIdentity(spawned.pid)),token);
      return spawned;
    }).immediate();
    if (!child) {
      if (spawned?.pid) try { process.kill(-spawned.pid,'SIGTERM'); } catch { /* already gone */ }
      return;
    }
    const result = await new Promise<{code:number;ending:'exit'|'crash'}>(resolveExit => {
      child.on('error',()=>resolveExit({code:127,ending:'crash'}));
      child.on('close',code=>resolveExit({code:code ?? 128,ending:code === null ? 'crash' : 'exit'}));
    });
    finishTurn(db,stateDir,token,result.ending,result.code,Date.now());
  } catch (error) {
    writeSync(stderr, `${String(error)}\n`);
    finishTurn(db,stateDir,token,'crash',127,Date.now());
  } finally { closeSync(stdout); closeSync(stderr); db.close(); await viewing; }
}
function sessionRecordMatches(line: string, session: string, cwd: string): boolean {
  if (!line.includes('"cwd"')) return false;
  let record: { cwd?: unknown; sessionId?: unknown };
  try { record = JSON.parse(line) as { cwd?: unknown; sessionId?: unknown }; } catch { return false; }
  if (typeof record.sessionId === 'string' && record.sessionId !== session) {
    throw new Error('Native session home/cwd does not match the handover descriptor');
  }
  if (typeof record.cwd !== 'string') return false;
  try { return realpathSync(record.cwd) === realpathSync(cwd); } catch { return false; }
}

/** `~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl` exists and names this directory. */
export function claudeNativeSession(home: string, session: string, cwd: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(session)) throw new Error('Enrollment needs an exact native session UUID');
  const directory = realpathSync(cwd);
  const file = join(home, 'projects', claudeProjectKey(directory), `${session}.jsonl`);
  if (!existsSync(file)) throw new Error('Native session is not present for the selected working directory');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (sessionRecordMatches(line, session, directory)) return;
  }
  throw new Error('Native session home/cwd does not match the handover descriptor');
}
export function nativeSession(home: string, session: string, cwd: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(session)) throw new Error('Enrollment needs an exact native session UUID');
  const files = [...new Bun.Glob(`sessions/**/rollout-*${session}.jsonl`).scanSync({cwd:home})];
  if (files.length !== 1) throw new Error('Native session is not uniquely present in the selected account home');
  const first = readFileSync(join(home,files[0]!), 'utf8').split('\n')[0]!;
  const meta = JSON.parse(first) as {type:string;payload:{id:string;cwd:string}};
  if (meta.type !== 'session_meta' || meta.payload.id !== session || realpathSync(meta.payload.cwd) !== realpathSync(cwd)) {
    throw new Error('Native session home/cwd does not match the handover descriptor');
  }
}
if (import.meta.main) {
  if (process.argv[2] !== 'attempt' || !process.argv[3] || !process.argv[4]) throw new Error('Internal attempt requires stateDir and token');
  await runAttempt(process.argv[3],process.argv[4],true);
}
