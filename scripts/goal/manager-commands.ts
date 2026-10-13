import { resolve, join } from 'node:path';
import { stateDir, activeGoals, root, managerOf } from './ledger.ts';
import { type Ledger, effortsOf, modelOf, engineEnv } from './types.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { GoalMailStore } from './mail.ts';
import { type WakeEvent, type LaunchDescriptor, processIdentity, claudeConfigHome, WAKE_PROMPT, WAKE_LAST_MESSAGE, tmuxServer, GoalCoordinator, TmuxLauncher, claudeNativeSession, claudeWakeArgs, nativeSession } from './coordinator.ts';
import { lastAttempt, running, launchCommand, managerWakeGates } from './launch.ts';
import { validGoalSlug } from './briefs.ts';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { startGoal } from './tasks.ts';

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
export function managerEvents(directory: string, goal: string, mail: GoalMailStore): WakeEvent[] {
  const body = (message: ReturnType<GoalMailStore['pending']>[number]) =>
    `From: ${message.sender ?? 'unknown (historical mail)'}\nDeadline: ${message.deadlineAt ?? 'none'}\n${message.body}`;
  const events: WakeEvent[] = mail.pending(goal).map(message => ({key:message.id,body:body(message)}));
  for (const message of mail.overdue(goal)) {
    if (message.overdueAt !== null) events.push({key:`mail:overdue:${message.id}:${goal}`,
      body:`Mail ${message.id} is overdue and remains unacknowledged. This is its one deadline wake.\n${body(message)}`});
  }
  for (const task of Object.values(eventLedger(directory).tasks)) {
    if (task.goal !== goal || ['verified', 'cancelled', 'merged'].includes(task.state) || !task.attempts.length) continue;
    const attempt = lastAttempt(task);
    if (task.state === 'running' && running(task)) continue;
    events.push({key:`task:${task.id}:${attempt.n}`,body:`${task.id}: ${task.state}; attempt ${attempt.n} exited. Output: ${attempt.output}`});
  }
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
export async function coordinatorCommand(args: string[]): Promise<void> {
  const directory = eventStateDirectory();
  const coordinator = new GoalCoordinator({stateDir:directory,
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
  try {
    const [action, ...rest] = args;
    if (action === 'start') {
      const options = coordinatorStartOptions(rest);
      // Registration uses goal start's existing ledger and area owner checks.
      if (directory !== stateDir) throw new Error('coordinator start must use the Goal ledger directory');
      const socket = process.env.GOAL_COORDINATOR_TMUX_SOCKET
        ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
      if (!socket) throw new Error('Start needs an independent tmux server; set GOAL_COORDINATOR_TMUX_SOCKET');
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
      try { console.log(JSON.stringify({...coordinator.status(),overdueMail:mail.overdue()},null,2)); }
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
      const { goal, session, engine, effort, model, cwd: requestedCwd, socket: requestedSocket, previousOwner } = coordinatorEnrollmentOptions(rest);
      if (!activeGoals(eventLedger(directory)).includes(goal)) throw new Error(`Unknown active Goal: ${goal}`);
      const cwd = realpathSync(resolve(requestedCwd));
      if (engine === 'claude') {
        const home = realpathSync(claudeConfigHome());
        claudeNativeSession(home, session, cwd);
        const socket = requestedSocket ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
        if (!socket) throw new Error('Enrollment needs an existing independent tmux server');
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
      const socket = requestedSocket ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
      if (!socket) throw new Error('Enrollment needs an existing independent tmux server');
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
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM',stop); process.on('SIGINT',stop);
    try {
      do {
        const mail = new GoalMailStore({stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {})});
        try { mail.notifyOverdue(); } finally { mail.close(); }
        coordinator.step();
        if (!once && !stopped) await Bun.sleep(interval);
      } while (!once && !stopped);
    } finally { process.off('SIGTERM',stop); process.off('SIGINT',stop); coordinator.release(); }
  } finally { coordinator.close(); }
}
