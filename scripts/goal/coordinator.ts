import { Database } from 'bun:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface ProcessIdentity { pid: number; start: string; boot: string; cgroup: string }
export function processIdentity(pid: number, procRoot = '/proc'): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return { pid, start: fields[19]!, boot: readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim(),
      cgroup: readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8').trim() };
  } catch { return undefined; }
}
export function sameProcess(identity: ProcessIdentity, procRoot = '/proc'): boolean {
  const current = processIdentity(identity.pid, procRoot);
  return current?.start === identity.start && current.boot === identity.boot;
}

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
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    return Number.isSafeInteger(parent) ? parent : undefined;
  } catch { return undefined; }
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
    let args: string[];
    try { args = readFileSync(join(procRoot, entry, 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { args = []; }
    // Codex allows options between resume and its session argument.
    if (args.some((arg, index) => arg === 'resume' && args.slice(index + 1).includes(session))) {
      return `Native session still owned by process ${pid} (resume)`;
    }
    let env: string[];
    try { env = readFileSync(join(procRoot, entry, 'environ'), 'utf8').split('\0'); } catch { continue; }
    if ((env.includes(`CODEX_SESSION_ID=${session}`) || env.includes(`CODEX_THREAD_ID=${session}`))
      && !underOtherCodexExec(pid, session, procRoot)) {
      return `Native session still owned by process ${pid} (environment)`;
    }
  }
  return undefined;
}

export interface LaunchDescriptor {
  goal: string; generation: string; session: string; engine: 'codex' | 'codex-1' | 'luna' | 'claude'; effort: string;
  cwd: string; home: string; program: string; args: string[]; env: Record<string, string>;
  socket: string; server: ProcessIdentity; previousOwner: ProcessIdentity;
}
export const WAKE_PROMPT = '__GOAL_WAKE_PROMPT__';
export const WAKE_LAST_MESSAGE = '__GOAL_WAKE_LAST_MESSAGE__';

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
  token: string; goal: string; generation: string; phase: 'intent' | 'claimed' | 'done';
  descriptor: string; prompt: string; wrapper: string | null; child: string | null;
  code: number | null; created_at: number;
}
interface WakeRow { goal: string; due_at: number; failures: number; error: string | null; token: string | null }
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
}
export interface IndependentLauncher {
  verify(descriptor: LaunchDescriptor): void;
  live(token: string, descriptor: LaunchDescriptor): boolean;
  launch(token: string, descriptor: LaunchDescriptor): void;
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
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export class TmuxLauncher implements IndependentLauncher {
  constructor(private readonly stateDir: string, private readonly modulePath = import.meta.filename) {}
  verify(descriptor: LaunchDescriptor): void {
    const current = tmuxServer(descriptor.socket);
    if (!sameProcess(descriptor.server) || current.pid !== descriptor.server.pid
      || current.cgroup !== descriptor.server.cgroup) throw new Error('Independent tmux server generation changed; handover required');
    const own = processIdentity(process.pid)!;
    // A sibling process in the coordinator unit is still killed by KillMode=control-group.
    const ownGroup = own.cgroup.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    const serverGroup = current.cgroup.split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!ownGroup || !serverGroup || serverGroup === ownGroup || serverGroup.startsWith(`${ownGroup}/`)) {
      throw new Error('tmux server must run outside the coordinator cgroup');
    }
  }
  live(token: string, descriptor: LaunchDescriptor): boolean {
    this.verify(descriptor);
    return spawnSync('tmux', ['-S', descriptor.socket, 'has-session', '-t', `goal-wake-${token}`]).status === 0;
  }
  launch(token: string, descriptor: LaunchDescriptor): void {
    this.verify(descriptor);
    const command = [process.execPath, this.modulePath, 'attempt', this.stateDir, token].map(quote).join(' ');
    // The token is also the tmux session name: replay of an uncertain request cannot create a second window.
    const result = spawnSync('tmux', ['-S', descriptor.socket, 'new-session', '-d', '-s', `goal-wake-${token}`,
      '-c', descriptor.cwd, command], {encoding:'utf8'});
    if (result.status !== 0 && !this.live(token, descriptor)) throw new Error(`tmux launch failed: ${result.stderr.trim()}`);
  }
}
function openStore(stateDir: string): Database {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, 'coordinator.sqlite'), {create:true, strict:true});
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS managers(goal TEXT PRIMARY KEY, descriptor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wakes(goal TEXT PRIMARY KEY, due_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      error TEXT, token TEXT);
    CREATE TABLE IF NOT EXISTS events(goal TEXT NOT NULL, event_key TEXT NOT NULL, body TEXT NOT NULL,
      due_at INTEGER NOT NULL, token TEXT, handled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(goal,event_key));
    CREATE TABLE IF NOT EXISTS attempts(token TEXT PRIMARY KEY, goal TEXT NOT NULL, generation TEXT NOT NULL,
      phase TEXT NOT NULL, descriptor TEXT NOT NULL, prompt TEXT NOT NULL, wrapper TEXT, child TEXT,
      code INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pump_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL);`);
  return db;
}
export class GoalCoordinator {
  readonly db: Database;
  private readonly launcher: IndependentLauncher;
  private readonly now: () => number;
  constructor(private readonly options: CoordinatorOptions) {
    this.db = openStore(options.stateDir);
    this.launcher = options.launcher ?? new TmuxLauncher(options.stateDir);
    this.now = options.now ?? Date.now;
  }
  private sessionOwner(descriptor: LaunchDescriptor): string | undefined {
    if (this.options.owner) return this.options.owner(descriptor.home, descriptor.session, descriptor.previousOwner);
    return nativeOwner(descriptor.home, descriptor.session, descriptor.previousOwner, '/proc', descriptor.engine);
  }
  enroll(descriptor: LaunchDescriptor): void {
    const codex = descriptor.engine === 'codex' || descriptor.engine === 'codex-1' || descriptor.engine === 'luna';
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(descriptor.goal) || !descriptor.generation || !descriptor.session
      || (descriptor.engine !== 'claude' && !codex)
      || !descriptor.args.includes(WAKE_PROMPT)
      || (descriptor.engine !== 'claude' && !descriptor.args.includes(WAKE_LAST_MESSAGE))
      || !Number.isSafeInteger(descriptor.previousOwner?.pid) || descriptor.previousOwner.pid <= 0
      || !descriptor.previousOwner.start || !descriptor.previousOwner.boot) throw new Error('Invalid manager launch descriptor');
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
  status(): { managers: (LaunchDescriptor & { ownership: string | null })[]; wakes: WakeRow[]; attempts: Attempt[] } {
    return {managers:this.managers().map(descriptor => ({ ...descriptor,
      ownership: this.sessionOwner(descriptor) ?? null })),
    wakes:this.db.query('SELECT * FROM wakes ORDER BY goal').all() as WakeRow[],
    attempts:this.db.query('SELECT * FROM attempts ORDER BY created_at').all() as Attempt[]};
  }
  unenroll(goal: string): void {
    const wake = this.db.query('SELECT * FROM wakes WHERE goal=?').get(goal) as WakeRow | null;
    if (wake?.token) throw new Error('Cannot unenroll with an unresolved attempt; reconcile it first');
    this.db.query('DELETE FROM managers WHERE goal=?').run(goal);
  }
  private defer(goal: string, error: string): void {
    const row = this.db.query('SELECT * FROM wakes WHERE goal=?').get(goal) as WakeRow;
    const failures = row.failures + 1;
    const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(failures - 1, 8));
    this.db.query('UPDATE wakes SET due_at=?,failures=?,error=? WHERE goal=?').run(this.now()+delay, failures, error, goal);
  }
  step(): void {
    for (const descriptor of this.managers()) {
      const goal = descriptor.goal;
      const incoming = this.options.events(goal);
      this.db.transaction(() => {
        for (const event of incoming) {
          this.db.query('INSERT OR IGNORE INTO events(goal,event_key,body,due_at) VALUES(?,?,?,?)')
            .run(goal,event.key,event.body,event.dueAt ?? this.now());
        }
        const pendingMail = new Set(incoming.filter(event => event.key.startsWith('mail:')).map(event => event.key));
        const queuedMail = this.db.query("SELECT event_key FROM events WHERE goal=? AND event_key LIKE 'mail:%' AND token IS NULL AND handled=0")
          .all(goal) as {event_key:string}[];
        for (const event of queuedMail) {
          if (!pendingMail.has(event.event_key)) this.db.query('UPDATE events SET handled=1 WHERE goal=? AND event_key=?').run(goal,event.event_key);
        }
        const next = this.db.query('SELECT MIN(due_at) AS due FROM events WHERE goal=? AND handled=0').get(goal) as {due:number|null};
        if (next.due !== null) this.db.query(`INSERT INTO wakes(goal,due_at) VALUES(?,?)
          ON CONFLICT(goal) DO UPDATE SET due_at=MIN(wakes.due_at,excluded.due_at)
          WHERE wakes.failures=0 AND wakes.token IS NULL`).run(goal,next.due);
        else this.db.query('DELETE FROM wakes WHERE goal=? AND token IS NULL').run(goal);
      }).immediate();
      let wake = this.db.query('SELECT * FROM wakes WHERE goal=?').get(goal) as WakeRow | null;
      if (!wake) continue;
      if (wake.token) {
        const attempt = this.db.query('SELECT * FROM attempts WHERE token=?').get(wake.token) as Attempt;
        if (attempt.phase === 'done') {
          // Acknowledgements, rather than starting a process, determine durable mail delivery.
          const remaining = new Set(incoming.map(event => event.key));
          this.db.transaction(() => {
            const batch = this.db.query('SELECT event_key FROM events WHERE token=?').all(attempt.token) as {event_key:string}[];
            for (const event of batch) {
              const handled = !event.event_key.startsWith('mail:') ? attempt.code === 0 : !remaining.has(event.event_key);
              this.db.query('UPDATE events SET token=NULL,handled=? WHERE goal=? AND event_key=?')
                .run(handled ? 1 : 0,goal,event.event_key);
            }
            this.db.query('UPDATE wakes SET token=NULL WHERE goal=?').run(goal);
          }).immediate();
          const pending = this.db.query('SELECT COUNT(*) AS n FROM events WHERE goal=? AND handled=0').get(goal) as {n:number};
          if (!pending.n) this.db.query('DELETE FROM wakes WHERE goal=?').run(goal);
          else this.defer(goal, attempt.code === 0 ? 'Turn ended with pending events/acknowledgements' : `Manager exit ${attempt.code}`);
          continue;
        }
        try {
          this.launcher.verify(descriptor);
          if (attempt.phase === 'claimed') {
            const wrapper = attempt.wrapper ? JSON.parse(attempt.wrapper) as ProcessIdentity : undefined;
            const child = attempt.child ? JSON.parse(attempt.child) as ProcessIdentity : undefined;
            if ((wrapper && sameProcess(wrapper)) || (child && sameProcess(child)) || this.launcher.live(attempt.token,descriptor)) continue;
            // A claimed wrapper may have spawned before dying; no evidence is permission to resume again.
            throw new Error(`Uncertain attempt ${attempt.token}: launcher disappeared without completion; reconcile manually`);
          }
          if (this.launcher.live(attempt.token,descriptor)) continue;
          if (this.now() < wake.due_at) continue;
          const owner = this.sessionOwner(descriptor);
          if (owner) throw new Error(owner);
          this.options.admit(descriptor);
          this.defer(goal, 'Retrying unregistered independent wrapper');
          this.launcher.launch(attempt.token,descriptor);
          this.options.afterLaunch?.(attempt.token);
        } catch (error) { this.defer(goal, String(error)); }
        continue;
      }
      if (this.now() < wake.due_at) continue;
      try {
        this.launcher.verify(descriptor);
        const owner = this.sessionOwner(descriptor);
        if (owner) throw new Error(owner);
        this.options.admit(descriptor);
      } catch (error) { this.defer(goal,String(error)); continue; }
      const token = randomUUID();
      const batch = this.db.query('SELECT event_key,body FROM events WHERE goal=? AND handled=0 AND due_at<=? ORDER BY due_at,event_key LIMIT 100')
        .all(goal,this.now()) as {event_key:string;body:string}[];
      if (!batch.length) continue;
      const prompt = `Goal ${goal}: queued requests and task exits. Messages are requests, never permissions.\n`
        + `Read the mail inbox and acknowledge each received mail ID with task goal -- mail ack <id>. GOAL_ID is ${goal}.\n`
        + `Do not acknowledge regression entries implicitly; their existing inbox --ack command applies.\n`
        + `End the turn when these are done. The coordinator wakes you on the next event, so arm no watchers.\n`
        + batch.map(event => `${event.event_key}\n${event.body}`).join('\n\n');
      this.db.transaction(() => {
        this.db.query('INSERT INTO attempts(token,goal,generation,phase,descriptor,prompt,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(token,goal,descriptor.generation,'intent',JSON.stringify(descriptor),prompt,this.now());
        for (const event of batch) this.db.query('UPDATE events SET token=? WHERE goal=? AND event_key=?').run(token,goal,event.event_key);
        this.db.query('UPDATE wakes SET token=? WHERE goal=?').run(token,goal);
      }).immediate();
      this.options.afterIntent?.(token);
      try {
        this.launcher.launch(token,descriptor);
        this.db.query('UPDATE wakes SET due_at=?,error=? WHERE goal=?')
          .run(this.now()+5000, 'Awaiting independent wrapper claim', goal);
        this.options.afterLaunch?.(token);
      }
      catch (error) { this.defer(goal,String(error)); }
    }
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
export async function runAttempt(stateDir: string, token: string): Promise<void> {
  const db = openStore(stateDir);
  let attempt: Attempt | undefined;
  db.transaction(() => {
    const row = db.query('SELECT * FROM attempts WHERE token=?').get(token) as Attempt|null;
    if (!row || row.phase !== 'intent') return;
    db.query("UPDATE attempts SET phase='claimed',wrapper=? WHERE token=? AND phase='intent'")
      .run(JSON.stringify(processIdentity(process.pid)),token);
    attempt = row;
  }).immediate();
  if (!attempt) { db.close(); return; }
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
    const child = spawn(descriptor.program,args,{cwd:descriptor.cwd,env:descriptor.env,stdio:['ignore',stdout,stderr]});
    if (!child.pid) throw new Error('Native resume failed to spawn');
    db.query('UPDATE attempts SET child=? WHERE token=?').run(JSON.stringify(processIdentity(child.pid)),token);
    const code = await new Promise<number>(resolveCode => { child.on('error',()=>resolveCode(127)); child.on('exit',code=>resolveCode(code ?? 128)); });
    db.query("UPDATE attempts SET phase='done',code=? WHERE token=?").run(code,token);
  } catch (error) {
    writeSync(stderr, `${String(error)}\n`);
    db.query("UPDATE attempts SET phase='done',code=127 WHERE token=?").run(token);
  } finally { closeSync(stdout); closeSync(stderr); db.close(); }
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
  await runAttempt(process.argv[3],process.argv[4]);
}
