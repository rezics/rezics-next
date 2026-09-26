// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type State = 'running' | 'exited' | 'conflict' | 'merged' | 'stopped' | 'verified' | 'cancelled';
export interface Brief {
  id: string; title: string; effort: string; cases: string[]; paths: string[];
  migrations: string[]; shared: string[]; depends: string[];
}
export interface Attempt {
  n: number; effort: string; pid: number; session: string; output: string;
  startedAt: string; endedAt?: string;
}
export interface Task extends Brief {
  brief: string; worktree: string; branch: string; base: string; state: State; attempts: Attempt[];
  mergedCommit?: string; closedAt?: string;
}
export interface Ledger { startedAt?: string; manager?: string; tasks: Record<string, Task> }
export interface UsageSnapshot {
  at?: number; rate_limits?: { five_hour?: { used_percentage?: number; resets_at?: string | number } | null } | null;
}

export const MODEL = 'claude-opus-5-5';
export const EFFORTS = ['medium', 'high', 'xhigh'];
const HOLDING: State[] = ['running', 'exited', 'conflict', 'merged', 'stopped'];

export function parseBrief(text: string): Brief {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!block) throw new Error('Brief needs a leading --- frontmatter block');
  const fields: Record<string, string> = {};
  for (const line of block[1]!.split(/\r?\n/)) {
    const clean = line.replace(/\s+#.*$/, '').trim();
    if (!clean) continue;
    const at = clean.indexOf(':');
    if (at < 1) throw new Error(`Bad frontmatter line: ${line}`);
    fields[clean.slice(0, at).trim()] = clean.slice(at + 1).trim();
  }
  const list = (key: string): string[] => {
    const value = fields[key];
    if (!value) return [];
    if (!value.startsWith('[') || !value.endsWith(']')) throw new Error(`${key} must be a [a, b] list`);
    return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
  };
  return {
    id: fields.id ?? '', title: fields.title ?? '', effort: fields.effort ?? 'medium',
    cases: list('cases'), paths: list('paths'), migrations: list('migrations'), shared: list('shared'),
    depends: list('depends'),
  };
}

export function validateBrief(brief: Brief): string[] {
  const errors: string[] = [];
  if (!/^G-\d{3,}$/.test(brief.id)) errors.push(`id must look like G-038: ${brief.id || '(missing)'}`);
  if (!brief.title) errors.push('title is required');
  if (!EFFORTS.includes(brief.effort)) errors.push(`effort must be one of ${EFFORTS.join(', ')}: ${brief.effort}`);
  for (const id of brief.cases) if (!/^[A-Z]+\d{2}$/.test(id)) errors.push(`bad case ID: ${id}`);
  for (const path of brief.paths) {
    if (isAbsolute(path) || path.split('/').includes('..') || path.startsWith('.temp/')) {
      errors.push(`path claim must be repository-relative outside .temp: ${path}`);
    }
  }
  for (const range of brief.migrations) if (!parseRange(range)) errors.push(`bad migration range: ${range}`);
  for (const id of brief.depends) if (!/^G-\d{3,}$/.test(id)) errors.push(`bad dependency: ${id}`);
  return errors;
}

function parseRange(range: string): { dir: string; start: number; end: number } | undefined {
  const match = /^([a-z0-9/_-]+):(\d{3})-(\d{3})$/.exec(range);
  if (!match || Number(match[2]) > Number(match[3])) return undefined;
  return { dir: match[1]!, start: Number(match[2]), end: Number(match[3]) };
}

export function rangesOverlap(a: string, b: string): boolean {
  const left = parseRange(a);
  const right = parseRange(b);
  return !!left && !!right && left.dir === right.dir && left.start <= right.end && right.start <= left.end;
}

function literalPrefix(pattern: string): string {
  const at = pattern.search(/[*?[{]/);
  return at < 0 ? pattern : pattern.slice(0, at);
}

// Conservative: any shared literal prefix counts as overlap, so a false positive only delays dispatch.
export function pathsOverlap(a: string, b: string): boolean {
  const left = literalPrefix(a);
  const right = literalPrefix(b);
  return left.startsWith(right) || right.startsWith(left);
}

export function claimConflicts(brief: Brief, tasks: Task[]): string[] {
  const conflicts: string[] = [];
  for (const task of tasks) {
    if (task.id === brief.id || !HOLDING.includes(task.state)) continue;
    for (const id of brief.cases) if (task.cases.includes(id)) conflicts.push(`case ${id} is held by ${task.id}`);
    for (const path of brief.paths) {
      for (const held of task.paths) {
        if (pathsOverlap(path, held)) conflicts.push(`path ${path} overlaps ${task.id} ${held}`);
      }
    }
    for (const range of brief.migrations) {
      for (const held of task.migrations) {
        if (rangesOverlap(range, held)) conflicts.push(`migrations ${range} overlap ${task.id} ${held}`);
      }
    }
    for (const token of brief.shared) {
      if (task.shared.includes(token)) conflicts.push(`shared ${token} is held by ${task.id}`);
    }
  }
  return conflicts;
}

export function outOfScope(files: string[], patterns: string[]): string[] {
  const globs = patterns.map(pattern => new Bun.Glob(pattern));
  return files.filter(file => !globs.some(glob => glob.match(file)));
}

export function usageLevel(snapshot: UsageSnapshot | undefined, nowMs: number):
  { level: 'unknown' | 'normal' | 'restricted' | 'critical'; used?: number; ageSeconds?: number } {
  const used = snapshot?.rate_limits?.five_hour?.used_percentage;
  if (!snapshot?.at || typeof used !== 'number') return { level: 'unknown' };
  const ageSeconds = Math.round(nowMs / 1000 - snapshot.at);
  if (ageSeconds > 1800) return { level: 'unknown', used, ageSeconds };
  return { level: used >= 95 ? 'critical' : used >= 80 ? 'restricted' : 'normal', used, ageSeconds };
}

// Workers keep the auto-mode permission classifier and accept no inbound session messages;
// the manager changes a worker's instructions only by stopping or resuming it.
export function launchCommand(options: { id: string; effort: string; session: string; prompt: string;
  resume: boolean }): [string, string[]] {
  const { id, effort, session, prompt, resume } = options;
  return ['claude', ['-p', prompt, '--model', MODEL, '--effort', effort, '--permission-mode', 'auto',
    ...(resume ? ['--resume', session] : ['--session-id', session]), '-n', id.toLowerCase(),
    '--output-format', 'json']];
}

function workerPrompt(task: Task, manager: string): string {
  return [
    `You are REZICS Goal worker ${task.id} (${MODEL}/${task.effort}). Work only inside ${task.worktree}.`,
    'Read docs/goals/worker.md there, then your brief at .temp/goal/brief.md, and follow both.',
    `The manager session is "${manager}". End with the handoff that the worker protocol specifies.`,
  ].join('\n');
}

function git(cwd: string, args: string[], allowFail = false): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.status === 0 ? result.stdout.trim() : '';
}

const root = dirname(git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']));
const stateDir = join(root, '.temp', 'goal-orchestration');
const ledgerPath = join(stateDir, 'ledger.json');
const usagePath = process.env.GOAL_USAGE_FILE ?? join(homedir(), '.claude', 'usage', 'latest.json');

function readLedger(): Ledger {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger : { tasks: {} };
}

function writeLedger(ledger: Ledger): void {
  writeFileSync(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}

function pidAlive(pid: number, program?: string): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!program) return true;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(program); } catch { return false; }
}

async function acquireDir(path: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));
      return;
    } catch {
      const owner = existsSync(join(path, 'pid')) ? Number(readFileSync(join(path, 'pid'), 'utf8')) : 0;
      const young = existsSync(path) && Date.now() - statSync(path).mtimeMs < 10_000;
      if (!pidAlive(owner) && !young) { rmSync(path, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      if (!announced && timeoutMs > 60_000) { console.error(`waiting for ${label}`); announced = true; }
      await Bun.sleep(label === 'ledger lock' ? 100 : 3000);
    }
  }
}

async function withLedger<T>(change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'ledger.lock');
  await acquireDir(lock, 120_000, 'ledger lock');
  try {
    const ledger = readLedger();
    const result = await change(ledger);
    writeLedger(ledger);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readUsage(): UsageSnapshot | undefined {
  try { return JSON.parse(readFileSync(usagePath, 'utf8')) as UsageSnapshot; } catch { return undefined; }
}

function taskOf(ledger: Ledger, id: string): Task {
  const task = ledger.tasks[id.toUpperCase()];
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

function lastAttempt(task: Task): Attempt {
  const attempt = task.attempts.at(-1);
  if (!attempt) throw new Error(`${task.id} has no attempt`);
  return attempt;
}

function running(task: Task): boolean {
  return task.state === 'running' && pidAlive(lastAttempt(task).pid, 'claude');
}

function launch(task: Task, effort: string, session: string, prompt: string, resume: boolean,
  manager: string): Attempt {
  const n = task.attempts.length + 1;
  const runDir = join(stateDir, 'runs', task.id);
  mkdirSync(runDir, { recursive: true });
  const output = join(runDir, `attempt-${n}.json`);
  const [program, args] = launchCommand({ id: task.id, effort, session, prompt, resume });
  const child = spawn(program, args, {
    cwd: task.worktree, detached: true,
    stdio: ['ignore', openSync(output, 'w'), openSync(join(runDir, `attempt-${n}.err`), 'w')],
    env: { ...process.env, GOAL_TASK_ID: task.id, GOAL_MANAGER: manager },
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${program}`);
  return { n, effort, pid: child.pid, session, output, startedAt: new Date().toISOString() };
}

function changedFiles(task: Task): { committed: string[]; dirty: string[]; ahead: number } {
  if (!existsSync(task.worktree)) return { committed: [], dirty: [], ahead: 0 };
  const committed = git(root, ['diff', '--name-only', `main...${task.branch}`], true).split('\n').filter(Boolean);
  const dirty = git(task.worktree, ['status', '--porcelain', '--untracked-files=all'], true).split('\n')
    .filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, ''));
  const ahead = Number(git(root, ['rev-list', '--count', `main..${task.branch}`], true) || 0);
  return { committed, dirty, ahead };
}

function describe(task: Task): string {
  const { committed, dirty, ahead } = changedFiles(task);
  const violations = outOfScope([...new Set([...committed, ...dirty])], task.paths);
  return [
    `${task.branch}: ${ahead} commit(s) ahead of main; worktree ${dirty.length ? `DIRTY (${dirty.length} files)` : 'clean'}`,
    violations.length ? `scope: VIOLATIONS\n  ${violations.join('\n  ')}` : 'scope: ok',
  ].join('\n');
}

function readResult(attempt: Attempt): { text: string; session?: string; error: boolean; cost?: number } {
  try {
    const data = JSON.parse(readFileSync(attempt.output, 'utf8')) as Record<string, unknown>;
    const text = String(data.result ?? data.text ?? '');
    const session = data.session_id as string | undefined;
    return { text, session, error: data.is_error === true || !text, cost: data.total_cost_usd as number | undefined };
  } catch {
    const errPath = attempt.output.replace(/\.json$/, '.err');
    const tail = existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(-3000) : '';
    return { text: `(no parsable output)\n${tail}`, error: true };
  }
}

function elapsed(fromIso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(fromIso)) / 60_000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

async function dispatch(briefPath: string, flags: Set<string>): Promise<void> {
  const absolute = resolve(briefPath);
  const brief = parseBrief(readFileSync(absolute, 'utf8'));
  const errors = validateBrief(brief);
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    if (ledger.tasks[brief.id]) throw new Error(`${brief.id} already exists (${ledger.tasks[brief.id]!.state}); use resume`);
    const tasks = Object.values(ledger.tasks);
    const conflicts = claimConflicts(brief, tasks);
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    for (const id of brief.depends) {
      const dependency = ledger.tasks[id];
      if (dependency && !['merged', 'verified'].includes(dependency.state)) {
        throw new Error(`${brief.id} depends on ${id}, which is ${dependency.state}`);
      }
    }
    const live = tasks.filter(running).length;
    const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
    if (live >= limit) throw new Error(`Concurrency limit reached: ${live}/${limit} live workers`);
    const usage = usageLevel(readUsage(), Date.now());
    if (['restricted', 'critical'].includes(usage.level) && !flags.has('--force-usage')) {
      throw new Error(`5h usage is ${usage.used}% (${usage.level}); reduce concurrency or pass --force-usage`);
    }
    if (flags.has('--dry-run')) { console.log(`${brief.id}: claims ok; ${live}/${limit} live; usage ${usage.level}`); return; }
    const worktree = join(root, '.temp', 'worktrees', brief.id.toLowerCase());
    const branch = `goal/${brief.id.toLowerCase()}`;
    if (existsSync(worktree)) throw new Error(`${worktree} already exists; remove it or use another ID`);
    git(root, ['worktree', 'add', '-q', worktree, '-b', branch, 'main']);
    const install = spawnSync('corepack', ['yarn', 'install', '--immutable'], { cwd: worktree, encoding: 'utf8' });
    mkdirSync(join(stateDir, 'runs', brief.id), { recursive: true });
    writeFileSync(join(stateDir, 'runs', brief.id, 'install.log'), `${install.stdout}\n${install.stderr}`);
    if (install.status !== 0) throw new Error(`yarn install failed in ${worktree}; see runs/${brief.id}/install.log`);
    mkdirSync(join(worktree, '.temp', 'goal'), { recursive: true });
    copyFileSync(absolute, join(worktree, '.temp', 'goal', 'brief.md'));
    const task: Task = { ...brief, brief: absolute, worktree, branch, base: git(root, ['rev-parse', 'main']),
      state: 'running', attempts: [] };
    const manager = ledger.manager ?? process.env.GOAL_MANAGER ?? 'goal-manager';
    task.attempts.push(launch(task, brief.effort, randomUUID(), workerPrompt(task, manager), false, manager));
    ledger.tasks[brief.id] = task;
    ledger.startedAt ??= new Date().toISOString();
    console.log(`${brief.id} started: ${MODEL}/${brief.effort} pid ${lastAttempt(task).pid} in ${worktree}`);
    console.log(`Next: run \`bun scripts/goal/goalctl.ts wait ${brief.id}\` in the background.`);
  });
}

async function waitFor(id: string): Promise<void> {
  const initial = taskOf(readLedger(), id);
  const attempt = lastAttempt(initial);
  while (pidAlive(attempt.pid, 'claude')) await Bun.sleep(5000);
  const result = readResult(attempt);
  const task = await withLedger(ledger => {
    const current = taskOf(ledger, id);
    const last = lastAttempt(current);
    if (last.n === attempt.n) {
      last.endedAt ??= new Date().toISOString();
      if (current.state === 'running') current.state = 'exited';
    }
    return current;
  });
  console.log(`${task.id} attempt ${attempt.n} ended after ${elapsed(attempt.startedAt)}`
    + `${result.error ? ' WITH ERROR' : ''}${result.cost !== undefined ? `; cost $${result.cost.toFixed(2)}` : ''}`);
  console.log(describe(task));
  console.log(`--- handoff ---\n${result.text.length > 8000 ? `${result.text.slice(0, 8000)}\n[truncated]` : result.text}`);
}

async function resumeTask(id: string, args: string[]): Promise<void> {
  let message = '';
  let effort: string | undefined;
  let fresh = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m') message = args[++i] ?? '';
    else if (args[i] === '--file') message = readFileSync(args[++i] ?? '', 'utf8');
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--fresh') fresh = true;
    else throw new Error(`Unsupported resume option: ${args[i]}`);
  }
  if (!message.trim()) throw new Error('resume needs -m <message> or --file <path>');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first or message it`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const previous = lastAttempt(task);
    const nextEffort = effort ?? previous.effort;
    if (!EFFORTS.includes(nextEffort)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
    const manager = ledger.manager ?? process.env.GOAL_MANAGER ?? 'goal-manager';
    const continuing = !fresh && !!previous.session;
    const session = continuing ? previous.session : randomUUID();
    const prompt = continuing ? message : `${workerPrompt(task, manager)}\n\nManager note:\n${message}`;
    task.attempts.push(launch(task, nextEffort, session, prompt, continuing, manager));
    task.state = 'running';
    console.log(`${task.id} attempt ${task.attempts.length}: ${MODEL}/${nextEffort}`
      + ` ${continuing ? 'resumed' : 'fresh session'}, pid ${lastAttempt(task).pid}`);
  });
}

async function stopTask(id: string): Promise<void> {
  const attempt = lastAttempt(taskOf(readLedger(), id));
  if (pidAlive(attempt.pid, 'claude')) {
    process.kill(-attempt.pid, 'SIGTERM');
    const deadline = Date.now() + 30_000;
    while (pidAlive(attempt.pid, 'claude') && Date.now() < deadline) await Bun.sleep(500);
    if (pidAlive(attempt.pid, 'claude')) process.kill(-attempt.pid, 'SIGKILL');
  }
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    lastAttempt(task).endedAt ??= new Date().toISOString();
    if (task.state === 'running') task.state = 'stopped';
  });
  console.log(`${id.toUpperCase()} stopped; its worktree and claims remain until close`);
}

async function mergeTask(id: string, flags: Set<string>): Promise<void> {
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (!['exited', 'conflict', 'stopped'].includes(task.state)) throw new Error(`${task.id} is ${task.state}`);
    if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
    const { committed, dirty, ahead } = changedFiles(task);
    if (dirty.length) throw new Error(`${task.id} worktree has uncommitted files:\n  ${dirty.join('\n  ')}`);
    if (!ahead) throw new Error(`${task.id} has no commits to merge`);
    const violations = outOfScope(committed, task.paths);
    if (violations.length && !flags.has('--allow-scope')) {
      throw new Error(`${task.id} changed files outside its claim:\n  ${violations.join('\n  ')}`);
    }
    const rebase = spawnSync('git', ['rebase', 'main'], { cwd: task.worktree, encoding: 'utf8' });
    if (rebase.status !== 0) {
      const conflicted = git(task.worktree, ['diff', '--name-only', '--diff-filter=U'], true);
      git(task.worktree, ['rebase', '--abort'], true);
      task.state = 'conflict';
      throw new Error(`${task.id} does not rebase onto main; conflicts:\n  ${conflicted.split('\n').join('\n  ')}`);
    }
    const merge = spawnSync('git', ['merge', '--ff-only', task.branch], { cwd: root, encoding: 'utf8' });
    if (merge.status !== 0) throw new Error(`Fast-forward failed in the main checkout:\n${merge.stderr}`);
    task.state = 'merged';
    task.mergedCommit = git(root, ['rev-parse', 'HEAD']);
    console.log(`${task.id} merged at ${task.mergedCommit.slice(0, 12)}; ${committed.length} file(s):`);
    console.log(`  ${committed.join('\n  ')}`);
  });
}

async function closeTask(id: string, outcome: string): Promise<void> {
  if (outcome !== 'verified' && outcome !== 'cancelled') throw new Error('close needs verified or cancelled');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first`);
    if (outcome === 'verified' && task.state !== 'merged') throw new Error(`${task.id} is ${task.state}, not merged`);
    if (existsSync(task.worktree)) git(root, ['worktree', 'remove', '--force', task.worktree]);
    if (task.state === 'merged') git(root, ['branch', '-d', task.branch], true);
    task.state = outcome;
    task.closedAt = new Date().toISOString();
    console.log(`${task.id} ${outcome}; claims released${outcome === 'cancelled' ? `, branch ${task.branch} kept` : ''}`);
  });
}

async function status(): Promise<void> {
  const ledger = await withLedger(current => {
    for (const task of Object.values(current.tasks)) {
      if (task.state === 'running' && !running(task)) {
        task.state = 'exited';
        lastAttempt(task).endedAt ??= new Date().toISOString();
      }
    }
    return current;
  });
  const tasks = Object.values(ledger.tasks);
  const usage = usageLevel(readUsage(), Date.now());
  const live = tasks.filter(running);
  console.log(`program elapsed ${ledger.startedAt ? elapsed(ledger.startedAt) : 'not started'}; `
    + `live ${live.length}/${process.env.GOAL_MAX_WORKERS ?? 25}; `
    + `5h usage ${usage.used ?? '?'}% ${usage.level}${usage.ageSeconds !== undefined ? ` (${usage.ageSeconds}s old)` : ''}`);
  for (const task of tasks.filter(t => !['verified', 'cancelled'].includes(t.state))) {
    const attempt = lastAttempt(task);
    console.log(`${task.id} ${task.state.padEnd(8)} ${attempt.effort} #${attempt.n} `
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`);
  }
  const closed = tasks.length - tasks.filter(t => !['verified', 'cancelled'].includes(t.state)).length;
  if (closed) console.log(`${closed} closed task(s) omitted`);
}

async function withSlot(command: string[]): Promise<number> {
  const slots = Number(process.env.GOAL_QA_SLOTS ?? 8);
  const dir = join(stateDir, 'qa-slots');
  mkdirSync(dir, { recursive: true });
  let held: string | undefined;
  const deadline = Date.now() + 3_600_000;
  while (!held) {
    for (let k = 0; k < slots && !held; k++) {
      const path = join(dir, String(k));
      try { await acquireDir(path, 0, 'slot'); held = path; } catch { /* busy */ }
    }
    if (!held) {
      if (Date.now() > deadline) throw new Error('No QA slot became free within one hour');
      await Bun.sleep(3000);
    }
  }
  const slot = held;
  const release = () => rmSync(slot, { recursive: true, force: true });
  try {
    const child = spawn(command[0]!, command.slice(1), { cwd: process.cwd(), stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    return await new Promise<number>(done => child.on('exit', code => done(code ?? 1)));
  } finally {
    release();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  switch (command) {
    case 'init': {
      const at = rest.indexOf('--manager');
      await withLedger(ledger => {
        if (at >= 0) ledger.manager = rest[at + 1];
        ledger.startedAt ??= new Date().toISOString();
        console.log(`program started ${ledger.startedAt}; manager ${ledger.manager ?? 'goal-manager'}`);
      });
      return 0;
    }
    case 'dispatch': await dispatch(positional[0] ?? '', flags); return 0;
    case 'wait': await waitFor(positional[0] ?? ''); return 0;
    case 'resume': await resumeTask(rest[0] ?? '', rest.slice(1)); return 0;
    case 'stop': await stopTask(positional[0] ?? ''); return 0;
    case 'scope': console.log(describe(taskOf(readLedger(), positional[0] ?? ''))); return 0;
    case 'merge': await mergeTask(positional[0] ?? '', flags); return 0;
    case 'close': await closeTask(positional[0] ?? '', positional[1] ?? ''); return 0;
    case 'status': await status(); return 0;
    case 'usage': console.log(JSON.stringify({ ...usageLevel(readUsage(), Date.now()), file: usagePath })); return 0;
    case 'test': return withSlot(['corepack', 'yarn', 'test', ...rest]);
    case 'slot': return withSlot(rest[0] === '--' ? rest.slice(1) : rest);
    default:
      console.error('Usage: goalctl init [--manager <name>] | dispatch <brief.md> [--dry-run] [--force-usage]'
        + ' | wait <id> | resume <id> (-m <text> | --file <path>) [--effort e] [--fresh]'
        + ' | stop <id> | scope <id> | merge <id> [--allow-scope] | close <id> verified|cancelled'
        + ' | status | usage | test <yarn test args> | slot -- <command>');
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
