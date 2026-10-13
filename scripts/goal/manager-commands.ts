import { resolve, join } from 'node:path';
import { stateDir, activeGoals, root, managerOf } from './ledger.ts';
import { type Ledger, effortsOf, modelOf, engineEnv } from './types.ts';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { GoalMailStore } from './mail.ts';
import { type WakeEvent, type LaunchDescriptor, processIdentity, claudeConfigHome, WAKE_PROMPT, WAKE_LAST_MESSAGE, tmuxServer, GoalCoordinator, TmuxLauncher, claudeNativeSession, claudeWakeArgs, nativeSession } from './coordinator.ts';
import { lastAttempt, running, launchCommand, managerWakeGates } from './launch.ts';
import { validGoalSlug } from './briefs.ts';
import { randomUUID } from 'node:crypto';
import { constants, homedir } from 'node:os';
import { ensureTermspacesSession, termspacesTarget, reconcileWindows } from './windows.ts';
import { startGoal } from './tasks.ts';
import { planningEvent } from './planning.ts';
import { coordinatorPassCommand } from './pass-scope.ts';

/** The override confines disposable mail/pump trials to their own ledger and local state. */
export function eventStateDirectory(): string {
  return process.env.GOAL_MAIL_STATE_DIR ? resolve(process.env.GOAL_MAIL_STATE_DIR) : stateDir;
}
export function eventLedger(directory: string): Ledger {
  const path = join(directory, 'ledger.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ledger : { tasks: {} };
}
function namedOptions(args: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || options[flag] !== undefined || !value || value.startsWith('--')) {
      throw new Error(`Invalid option: ${flag}; expected ${allowed.join(', ')}`);
    }
    options[flag] = value;
  }
  return options;
}
export function mailCommand(args: string[], options: {stateDir: string; goals: string[]; callerGoal?: string}): string[] {
  const [action, ...rest] = args;
  const store = new GoalMailStore({...options,sender:options.callerGoal ?? ''});
  try {
    if (action === 'send') {
      const goal = rest[0] ?? '';
      const flags = namedOptions(rest.slice(1), ['--file', '--key', '--deadline']);
      if (!flags['--file'] || !flags['--key']) throw new Error('mail send <goal> needs --file <path> --key <retry-key>');
      if (!options.callerGoal) throw new Error('mail send needs GOAL_ID to record its sender');
      return [JSON.stringify(store.send(goal, readFileSync(resolve(flags['--file']), 'utf8'), flags['--key'],
        flags['--deadline'] === undefined ? undefined : Number(flags['--deadline'])))];
    }
    if (action === 'inbox') {
      if (rest.length > 1) throw new Error('mail inbox accepts one Goal');
      const goal = rest[0] ?? options.callerGoal;
      if (!goal) throw new Error('mail inbox needs <goal> or GOAL_ID');
      return store.inbox(goal).map(entry => JSON.stringify(entry));
    }
    if (action === 'ack') {
      const flags = namedOptions(rest.slice(1), ['--goal']);
      const goal = flags['--goal'] ?? options.callerGoal;
      if (!goal || !rest[0]) throw new Error('mail ack <id> needs GOAL_ID or --goal <goal>');
      return [JSON.stringify(store.ack(goal, rest[0]))];
    }
    throw new Error('mail needs send <goal> --file <path> --key <retry-key> [--deadline <minutes>] | inbox [goal] | ack <id> [--goal <goal>]');
  } finally { store.close(); }
}
export function managerEvents(directory: string, goal: string, mail: GoalMailStore, repo = root): WakeEvent[] {
  const body = (message: ReturnType<GoalMailStore['pending']>[number]) =>
    `From: ${message.sender ?? 'unknown (historical mail)'}\nDeadline: ${message.deadlineAt ?? 'none'}\n${message.body}`;
  const events: WakeEvent[] = mail.pending(goal).map(message => ({key:message.id,body:body(message)}));
  for (const message of mail.overdue(goal)) {
    if (message.overdueAt !== null) events.push({key:`mail:overdue:${message.id}:${goal}`,
      body:`Mail ${message.id} is overdue and remains unacknowledged. This is its one deadline wake.\n${body(message)}`});
  }
  const ledger = eventLedger(directory);
  for (const task of Object.values(ledger.tasks)) {
    if (task.goal !== goal || ['verified', 'cancelled'].includes(task.state) || !task.attempts.length) continue;
    const attempt = lastAttempt(task);
    if (task.state === 'running' && running(task)) continue;
    if (task.settlement?.attempt !== attempt.n || !task.settlement.settledAt) continue;
    events.push({key:`task:${task.id}:${attempt.n}`,body:task.settlement.reason ?? `${task.id}: attempt ${attempt.n} settled`});
  }
  const planning = planningEvent(directory, goal, ledger, repo);
  if (planning) events.push(planning);
  return events;
}
export function coordinatorEnrollmentOptions(args: string[]): {
  goal: string; session: string; engine: LaunchDescriptor['engine']; effort: string; cwd: string; model?: string;
  socket?: string; previousOwner: NonNullable<ReturnType<typeof processIdentity>>;
} {
  const goal = args[0] ?? '';
  const flags = namedOptions(args.slice(1), ['--session', '--engine', '--effort', '--cwd', '--model', '--tmux-socket', '--previous-owner-pid']);
  const engine = flags['--engine'] ?? 'codex';
  if (engine !== 'codex' && engine !== 'codex-1' && engine !== 'luna' && engine !== 'claude') {
    throw new Error('The coordinator enrolls Codex and Claude managers only');
  }
  const effort = flags['--effort'];
  const session = flags['--session'];
  const cwd = flags['--cwd'];
  const model = flags['--model'];
  const pidText = flags['--previous-owner-pid'];
  if (!goal || !effort || !effortsOf(engine).includes(effort) || !session || !cwd || !pidText) {
    throw new Error('Enrollment requires <goal> --session <native UUID> --effort <effort> --cwd <directory> --previous-owner-pid <pid>');
  }
  if (engine === 'claude' && !model) throw new Error('Claude enrollment requires --model <id>');
  if (engine !== 'claude' && model) throw new Error('--model is only for --engine claude');
  const pid = Number(pidText);
  if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid)) throw new Error('--previous-owner-pid must be a positive integer PID');
  const previousOwner = processIdentity(pid);
  if (!previousOwner) throw new Error(`Cannot establish the live previous owner ${pid}; enroll while that process is still running`);
  return { goal, session, engine, effort, cwd, model, socket: flags['--tmux-socket'], previousOwner };
}
export function coordinatorStartOptions(args: string[]): {
  goal: string; engine: 'codex' | 'codex-1' | 'claude'; effort: string; model: string;
} {
  const goal = args[0] ?? '';
  const flags = namedOptions(args.slice(1), ['--engine', '--effort', '--model']);
  const engine = flags['--engine'];
  if (!validGoalSlug(goal) || (engine !== 'codex' && engine !== 'codex-1' && engine !== 'claude')) {
    throw new Error('coordinator start needs <goal> --engine <codex|codex-1|claude> --effort <effort> [--model <id>]');
  }
  const effort = flags['--effort'] ?? '';
  if (!effortsOf(engine).includes(effort)) throw new Error(`${engine} effort must be one of ${effortsOf(engine).join(', ')}`);
  return {goal,engine,effort,model:flags['--model'] ?? modelOf(engine)};
}
export function coordinatorStartDescriptor(options: ReturnType<typeof coordinatorStartOptions>, cwd: string, socket: string): LaunchDescriptor {
  const {goal,engine,effort,model} = options;
  const session = randomUUID();
  const home = realpathSync(engine === 'claude' ? claudeConfigHome() : engineEnv(engine).CODEX_HOME!);
  const command = (resume: boolean): [string, string[]] => {
    const [program,args] = launchCommand({id:goal,engine,effort,session,worktree:cwd,resume,
      prompt:WAKE_PROMPT,lastMessage:WAKE_LAST_MESSAGE});
    const modelFlag = args.findIndex(arg => arg === '--model' || arg === '-m');
    args[modelFlag + 1] = model;
    return [program,args];
  };
  const [program,args] = command(true);
  return {goal,generation:randomUUID(),session,engine,effort,cwd,home,
    program:Bun.which(program) ?? program,args,startArgs:command(false)[1],socket,server:tmuxServer(socket),
    env:{PATH:process.env.PATH ?? '',HOME:homedir(),GOAL_ID:goal,GOAL_MANAGER:`goal-${goal}`,
      ...(engine === 'claude' ? (process.env.CLAUDE_CONFIG_DIR ? {CLAUDE_CONFIG_DIR:home} : {}) : {CODEX_HOME:home}),
      ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS','GOAL_CODEX_HOME',
        'GOAL_CODEX_1_HOME','GOAL_CODEX_SERVICE_TIER'].filter(key=>process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
}
function eventCoordinator(directory: string): GoalCoordinator {
  return new GoalCoordinator({stateDir:directory,
    events:goal => {
      const goals = Object.keys(eventLedger(directory).goals ?? {});
      if (!goals.includes(goal)) return [];
      const mail = new GoalMailStore({stateDir:directory,goals});
      try { return managerEvents(directory,goal,mail); } finally { mail.close(); }
    },
    admit:descriptor => {
      if (!activeGoals(eventLedger(directory)).includes(descriptor.goal)) throw new Error('Enrolled Goal is no longer active');
      const home = descriptor.engine === 'claude' ? realpathSync(claudeConfigHome()) : engineEnv(descriptor.engine).CODEX_HOME;
      if (!home || realpathSync(home) !== descriptor.home) throw new Error('Selected engine account home changed; handover required');
      managerWakeGates(descriptor.engine);
    }});
}
export async function coordinatorCommand(args: string[]): Promise<void> {
  const directory = eventStateDirectory();
  const coordinator = eventCoordinator(directory);
  try {
    const [action, ...rest] = args;
    if (action === 'turns') {
      const flags = namedOptions(rest,['--goal','--since']);
      const since = flags['--since'] === undefined ? undefined : Date.parse(flags['--since']);
      if (since !== undefined && (!Number.isFinite(since) || !/(?:Z|[+]00:00)$/.test(flags['--since']!))) throw new Error('--since needs a UTC timestamp');
      const report = coordinator.turns({goal:flags['--goal'],since});
      for (const turn of report.turns) console.log(JSON.stringify({token:turn.token,goal:turn.goal,event:turn.event_key,
        start:turn.started_at === null ? null : new Date(turn.started_at).toISOString(),
        end:turn.ended_at === null ? null : new Date(turn.ended_at).toISOString(),ending:turn.ending,code:turn.code,
        input:turn.input_tokens,cached:turn.cached_tokens,output:turn.output_tokens,commands:turn.commands}));
      console.log(JSON.stringify(report.summary)); return;
    }
    if (action === 'start') {
      const options = coordinatorStartOptions(rest);
      // Registration uses goal start's existing ledger and area owner checks.
      if (directory !== stateDir) throw new Error('coordinator start must use the Goal ledger directory');
      ensureTermspacesSession();
      const socket = termspacesTarget().socket;
      const descriptor = coordinatorStartDescriptor(options,realpathSync(root),socket);
      new TmuxLauncher(directory).verify(descriptor);
      coordinator.assertStartable(options.goal);
      managerWakeGates(options.engine);
      await startGoal(options.goal,['--manager',descriptor.env.GOAL_MANAGER!]);
      coordinator.start(descriptor);
      // A running pump collects the durable start event; otherwise make the first turn concrete now.
      let acquired = false;
      try { coordinator.acquire(); acquired = true; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'Coordinator already running') throw error; }
      if (acquired) { try { coordinator.step(); } finally { coordinator.release(); } }
      console.log(JSON.stringify(descriptor,null,2)); return;
    }
    if (action === 'status') {
      if (rest.length) throw new Error('coordinator status takes no options');
      const mail = new GoalMailStore({stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {})});
      try { console.log(JSON.stringify({...coordinator.status(),overdueMail:mail.overdue(),
        lastFailedPass:lastFailedCoordinatorPass(directory)},null,2)); }
      finally { mail.close(); }
      return;
    }
    if (action === 'unenroll') {
      if (rest.length !== 1) throw new Error('coordinator unenroll needs <goal>');
      coordinator.acquire();
      try { coordinator.unenroll(rest[0]!); } finally { coordinator.release(); }
      return;
    }
    if (action === 'enroll') {
      const { goal, session, engine, effort, model, cwd: requestedCwd, previousOwner } = coordinatorEnrollmentOptions(rest);
      if (!activeGoals(eventLedger(directory)).includes(goal)) throw new Error(`Unknown active Goal: ${goal}`);
      const cwd = realpathSync(resolve(requestedCwd));
      if (engine === 'claude') {
        const home = realpathSync(claudeConfigHome());
        claudeNativeSession(home, session, cwd);
        ensureTermspacesSession();
        const socket = termspacesTarget().socket;
        const descriptor: LaunchDescriptor = {goal,generation:randomUUID(),session,engine,effort,cwd,home,previousOwner,
          program:Bun.which('claude') ?? 'claude',args:claudeWakeArgs(session,model!,effort),socket,server:tmuxServer(socket),
          env:{PATH:process.env.PATH ?? '',HOME:homedir(),GOAL_ID:goal,
            GOAL_MANAGER:managerOf(eventLedger(directory),goal),
            ...(process.env.CLAUDE_CONFIG_DIR ? {CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR} : {}),
            ...(process.env.GOAL_MAIL_STATE_DIR ? {GOAL_MAIL_STATE_DIR:directory} : {}),
            ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS'].filter(key => process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
        coordinator.acquire();
        try { coordinator.enroll(descriptor); } finally { coordinator.release(); }
        console.log(JSON.stringify(descriptor,null,2)); return;
      }
      const home = realpathSync(engineEnv(engine).CODEX_HOME!);
      nativeSession(home,session,cwd);
      ensureTermspacesSession();
      const socket = termspacesTarget().socket;
      const [program, launchArgs] = launchCommand({id:goal,engine,effort,session,worktree:cwd,resume:true,
        prompt:WAKE_PROMPT,lastMessage:WAKE_LAST_MESSAGE});
      const descriptor: LaunchDescriptor = {goal,generation:randomUUID(),session,engine,effort,cwd,home,previousOwner,
        program:Bun.which(program) ?? program,args:launchArgs,socket,server:tmuxServer(socket),
        env:{PATH:process.env.PATH ?? '',HOME:homedir(),CODEX_HOME:home,GOAL_ID:goal,
          GOAL_MANAGER:managerOf(eventLedger(directory),goal),
          ...(process.env.GOAL_MAIL_STATE_DIR ? {GOAL_MAIL_STATE_DIR:directory} : {}),
          ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS','GOAL_CODEX_HOME',
            'GOAL_CODEX_1_HOME','GOAL_CODEX_SERVICE_TIER'].filter(key => process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
      coordinator.acquire();
      try { coordinator.enroll(descriptor); } finally { coordinator.release(); }
      console.log(JSON.stringify(descriptor,null,2)); return;
    }
    const once = args.includes('--once');
    const flags = namedOptions(args.filter(arg=>arg !== '--once'),['--interval-ms']);
    const interval = Number(flags['--interval-ms'] ?? 5000);
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) throw new Error('interval must be 100..60000 ms');
    coordinator.acquire();
    try { await coordinatorSupervisor(directory,{interval,once}); }
    finally { coordinator.release(); }
  } finally { coordinator.close(); }
}

type PassResult = { code: number; lastError: string };
type FailedPass = { at: string; line: string };

export function lastFailedCoordinatorPass(directory: string): FailedPass | null {
  const path = join(directory,'coordinator-last-failed-pass.json');
  return existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) as FailedPass : null;
}

/** Ownership stays in the supervisor; a failed pass costs only the next interval. */
export async function coordinatorSupervisor(directory: string,
  options: { interval: number; once?: boolean; module?: string }): Promise<void> {
  let stopped = false;
  let interruptWait: (() => void) | undefined;
  const stop = () => { stopped = true; interruptWait?.(); };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  try {
    do {
      const result = await freshCoordinatorPass(directory,options.module);
      if (result.code !== 0) {
        const line = `Coordinator pass exited ${result.code}: ${result.lastError || 'no error output'}`;
        console.error(line);
        // SQLite may be the fault that ended the pass. Keep its diagnostic independent.
        const path = join(directory,'coordinator-last-failed-pass.json');
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary,JSON.stringify({at:new Date().toISOString(),line}));
          renameSync(temporary,path);
        } finally { rmSync(temporary,{force:true}); }
      }
      if (!options.once && !stopped) await new Promise<void>(resolveWait => {
        const timer = setTimeout(() => { interruptWait = undefined; resolveWait(); },options.interval);
        interruptWait = () => { clearTimeout(timer); interruptWait = undefined; resolveWait(); };
      });
    } while (!options.once && !stopped);
  } finally { process.off('SIGTERM',stop); process.off('SIGINT',stop); }
}

/** Do not wait for descendants to close inherited pipes: they may outlive the pass. */
async function runCoordinatorPass(command: string[]): Promise<PassResult> {
  const child = spawn(command[0]!,command.slice(1),{cwd:root,stdio:['ignore','inherit','pipe']});
  let tail = '';
  const capture = (chunk: Buffer) => {
    process.stderr.write(chunk);
    tail = (tail + chunk.toString('utf8')).slice(-16_384);
  };
  child.stderr!.on('data',capture);
  try {
    const code = await new Promise<number>((resolveExit,reject) => {
      child.once('error',reject);
      child.once('exit',(code,signal) => resolveExit(code ?? 128 + (signal ? constants.signals[signal] : 0)));
    });
    // read() emits buffered bytes through the existing data listener too.
    child.stderr!.read();
    return {code,lastError:tail.trim().split(/\r?\n/).at(-1) ?? ''};
  } finally { child.stderr!.destroy(); }
}

/** Every pass loads current code in a scope whose descendants survive a service fault. */
export async function freshCoordinatorPass(directory: string, module = import.meta.url,
  cgroup = existsSync('/proc/self/cgroup') ? readFileSync('/proc/self/cgroup','utf8') : ''): Promise<PassResult> {
  mkdirSync(directory,{recursive:true});
  const started = join(directory,`coordinator-pass-${randomUUID()}.started`);
  const source = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, 'started'); const { coordinatorPass } = await import(${JSON.stringify(module)}); await coordinatorPass(${JSON.stringify(directory)});`;
  const direct = [process.execPath,'-e',source];
  const command = coordinatorPassCommand(cgroup,direct);
  try {
    if (command[0] === direct[0]) return await runCoordinatorPass(direct);
    let result: PassResult;
    try { result = await runCoordinatorPass(command); }
    catch (error) { result = {code:1,lastError:error instanceof Error ? error.message : String(error)}; }
    // A failed pass is never retried. Only failure before its first instruction falls back.
    if (existsSync(started)) return result;
    console.error(`Coordinator pass scope unavailable; running in supervisor group: ${result.lastError || `launcher exited ${result.code}`}`);
    return await runCoordinatorPass(direct);
  } finally { rmSync(started,{force:true}); }
}

export async function coordinatorPass(directory: string): Promise<void> {
  const coordinator = eventCoordinator(directory);
  try {
    if (directory === stateDir) await (await import('./settle.ts')).settlePass();
    const mail = new GoalMailStore({stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {})});
    try { mail.notifyOverdue(); } finally { mail.close(); }
    coordinator.step();
    const windows = reconcileWindows(directory,eventLedger(directory));
    if (windows.error) console.error(windows.error);
  } finally { coordinator.close(); }
}
