import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './ledger.ts';
import { GoalCoordinator, TmuxLauncher, WAKE_LAST_MESSAGE, WAKE_PROMPT, claudeNativeSession, claudeProjectKey,
  claudeWakeArgs, eventTasks, freshTurnDescriptor, MANAGER_ROLE_CARD, managerStartMessage, nativeOwner, nativeSession, processIdentity, runAttempt, sameProcess, tmuxServer, turnUsage,
  type CoordinatorOptions, type IndependentLauncher, type LaunchDescriptor, type WakeEvent } from './coordinator.ts';
import { GoalMailStore } from './mail.ts';
import { coordinatorStartDescriptor, coordinatorStartOptions, managerEvents } from './goalctl.ts';
import { goalWindows, termspacesSession, turnWindowName, windowTurns, reconcileWindows } from './windows.ts';
import { freshCoordinatorPass } from './manager-commands.ts';
import { testAccountSettings } from './fixtures/accounts.ts';

class RecordingLauncher implements IndependentLauncher {
  readonly launches: string[] = [];
  readonly running = new Set<string>();
  refusal: string | undefined;
  verify(): void { if (this.refusal) throw new Error(this.refusal); }
  live(token: string): boolean { return this.running.has(token); }
  launch(token: string): void { this.launches.push(token); this.running.add(token); }
}

test('the next pass loads landed tool code while a landing from the previous pass completes', async () => {
  const f = fixture();
  const landing = join(f.dir, 'landing.ts');
  const pass = join(f.dir, 'pass.ts');
  const entry = join(f.dir, 'tool.ts');
  const ready = join(f.dir, 'landing-ready');
  const release = join(f.dir, 'landing-release');
  const done = join(f.dir, 'landing-done');
  const output = join(f.dir, 'pass-output');
  let identity: ReturnType<typeof processIdentity>;
  try {
    writeFileSync(landing, `import { existsSync, writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      writeFileSync(${JSON.stringify(done)}, 'landed');`);
    writeFileSync(entry, "export { coordinatorPass } from './pass.ts';\n");
    const version = (value: string, launch: boolean) => `import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      export function coordinatorPass() {
        writeFileSync(${JSON.stringify(output)}, ${JSON.stringify(value)});
        ${launch ? `spawn(process.execPath, [${JSON.stringify(landing)}], {stdio:'ignore'}).unref();` : ''}
      }`;
    writeFileSync(pass, version('old', true));
    git(f.dir, ['init', '-q', '-b', 'main']);
    git(f.dir, ['add', '.']);
    git(f.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Original tool']);
    await freshCoordinatorPass(f.stateDir, entry);
    expect(readFileSync(output, 'utf8')).toBe('old');
    await waitFor(() => existsSync(ready));
    identity = processIdentity(Number(readFileSync(ready, 'utf8')));
    expect(identity).toBeDefined();
    writeFileSync(pass, version('new', false));
    git(f.dir, ['add', 'pass.ts']);
    git(f.dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Land new tool']);
    await freshCoordinatorPass(f.stateDir, entry);
    expect(readFileSync(output, 'utf8')).toBe('new');
    expect(sameProcess(identity!)).toBe(true);
    writeFileSync(release, 'finish');
    await waitFor(() => existsSync(done));
    expect(readFileSync(done, 'utf8')).toBe('landed');
    await waitFor(() => !sameProcess(identity!));
  } finally {
    if (identity && sameProcess(identity)) process.kill(identity.pid, 'SIGTERM');
    f.cleanup();
  }
});

test('the manager role card sends program readings and rulings immediately with the path and question', () => {
  expect(MANAGER_ROLE_CARD.split('\n')).toContain("If a brief needs a reading or a ruling by the program, mail the program at once with the brief's path and the question in one sentence.");
});

test('the manager role card requires decisions to be carried out and each brief committed before the turn ends', () => {
  expect(MANAGER_ROLE_CARD).toContain('before the turn ends');
  // A turn beside a landing must not void it: the landing compares the brief it reviewed.
  expect(MANAGER_ROLE_CARD).toContain('Never edit the brief of a task that is landing');
  expect(MANAGER_ROLE_CARD).toContain("a landing's progress goes in no brief");
  // A landing's gates outlast a turn: the turn starts it and a later turn reads its mailed result.
  expect(MANAGER_ROLE_CARD).toContain('A landing runs outside the turn and mails this Goal its result: do not wait for it and do not start it again');
  for (const command of ['resume <id> -m', 'land <id> --step', 'close', 'dispatch', 'queue', 'task goal -- commit -m <message> -- <path>'])
    expect(MANAGER_ROLE_CARD).toContain(command);
});

test('a second event writer waits for the first and a permanent lock ends with the statement named', async () => {
  const f = fixture();
  let writer: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
  try {
    const first = f.open();
    const second = f.open({storeWaitMs:1000});
    const bounded = f.open({storeWaitMs:75});
    const ready = join(f.dir, 'writer-ready');
    const sql = 'INSERT INTO events(goal,event_key,body,due_at) VALUES(?,?,?,?)';
    const pending = second.db.query(sql);
    const timed = bounded.db.query(sql);
    const source = `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs';
      const db = new Database(${JSON.stringify(join(f.stateDir, 'coordinator.sqlite'))});
      db.exec('BEGIN EXCLUSIVE');
      db.query(${JSON.stringify(sql)}).run('program','first','first writer',0);
      writeFileSync(${JSON.stringify(ready)}, 'locked');
      await Bun.sleep(500); db.exec('COMMIT'); db.close();`;
    writer = Bun.spawn([process.execPath, '-e', source], {stdout:'ignore',stderr:'pipe'});
    await waitFor(() => existsSync(ready));
    const start = performance.now();
    expect(() => timed.run('program','bounded','must fail',0)).toThrow(`Event store statement ${JSON.stringify(sql)} failed after waiting 75 ms`);
    expect(performance.now() - start).toBeGreaterThanOrEqual(70);
    expect(performance.now() - start).toBeLessThan(300);
    pending.run('program','second','second writer',0);
    expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
    expect(first.db.query('SELECT event_key FROM events ORDER BY event_key').all()).toEqual([{event_key:'first'},{event_key:'second'}]);
    expect(() => second.db.query('SELECT missing FROM events').all()).toThrow('SELECT missing FROM events');
  } finally {
    writer?.kill(); if (writer) await writer.exited;
    f.cleanup();
  }
});

test('a stale event transaction rolls back and rereads before retrying its write', () => {
  const f = fixture();
  try {
    const coordinator = f.open({storeWaitMs:500});
    coordinator.db.exec('PRAGMA journal_mode=WAL');
    coordinator.db.exec('CREATE TABLE counter(value INTEGER)');
    coordinator.db.exec('INSERT INTO counter VALUES(0)');
    let tries = 0;
    coordinator.db.transaction(() => {
      const row = coordinator.db.query('SELECT value FROM counter').get() as {value:number};
      if (tries++ === 0) {
        const result = spawnSync(process.execPath, ['-e', `import { Database } from 'bun:sqlite';
          const db = new Database(${JSON.stringify(join(f.stateDir,'coordinator.sqlite'))});
          db.exec('UPDATE counter SET value=value+1'); db.close();`], {encoding:'utf8'});
        expect(result.status, result.stderr).toBe(0);
      }
      coordinator.db.query('UPDATE counter SET value=?').run(row.value+1);
    })();
    expect(tries).toBe(2);
    expect(coordinator.db.query('SELECT value FROM counter').get()).toEqual({value:2});
  } finally { f.cleanup(); }
});

test('a reader blocking transaction commit produces a bounded COMMIT error and no partial event', async () => {
  const f = fixture();
  let reader: Bun.Subprocess<'ignore', 'ignore', 'pipe'> | undefined;
  try {
    const coordinator = f.open({storeWaitMs:75});
    const ready = join(f.dir, 'reader-ready');
    const source = `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs';
      const db = new Database(${JSON.stringify(join(f.stateDir, 'coordinator.sqlite'))});
      db.exec('BEGIN'); db.query('SELECT * FROM events').all();
      writeFileSync(${JSON.stringify(ready)}, 'locked');
      await Bun.sleep(500); db.exec('COMMIT'); db.close();`;
    reader = Bun.spawn([process.execPath, '-e', source], {stdout:'ignore',stderr:'pipe'});
    await waitFor(() => existsSync(ready));
    expect(() => coordinator.db.transaction(() => {
      coordinator.db.query('INSERT INTO events(goal,event_key,body,due_at) VALUES(?,?,?,?)').run('program','event','body',0);
    }).immediate()).toThrow('Event store statement "COMMIT" failed after waiting 75 ms');
    expect(await reader.exited, await new Response(reader.stderr).text()).toBe(0);
    expect(coordinator.db.query('SELECT * FROM events').all()).toEqual([]);
  } finally {
    reader?.kill(); if (reader) await reader.exited;
    f.cleanup();
  }
});

function fixture() {
  const root = join(import.meta.dir, '../../.temp/coordinator-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  mkdirSync(join(dir, 'account'));
  mkdirSync(join(dir, 'other-account'));
  const previousSettings = process.env.GOAL_SETTINGS_DIRECTORY;
  process.env.GOAL_SETTINGS_DIRECTORY = testAccountSettings(dir, [
    { engine: 'codex', home: join(dir, 'other-account') }, { engine: 'sample-b', home: join(dir, 'account') },
    { engine: 'sample-c', launcher: 'codex' },
  ]);
  const stateDir = join(dir, 'state');
  const launcher = new RecordingLauncher();
  const coordinators: GoalCoordinator[] = [];
  let now = 1_000_000;
  let events: WakeEvent[] = [{ key: 'exit:worker:1', body: 'Worker completed' }];
  const script = join(dir, 'manager.ts');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.CALLS!, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
      home: process.env.CODEX_HOME, goal: process.env.GOAL_ID }) + '\\n');
    process.exit(Number(process.env.EXIT_CODE ?? 0));`);
  const descriptor: LaunchDescriptor = { goal: 'program', generation: 'handover-1', session: 'throwaway-session',
    engine: 'sample-b', effort: 'high', cwd: dir, home: join(dir, 'account'), program: process.execPath,
    args: [script, '--model', 'gpt-6.1-sol', '--effort', 'high', WAKE_PROMPT, WAKE_LAST_MESSAGE],
    env: { PATH: process.env.PATH ?? '', CODEX_HOME: join(dir, 'account'), GOAL_ID: 'program', CALLS: join(dir, 'calls.jsonl') },
    socket: join(dir, 'unused.socket'), server: processIdentity(process.pid)!,
    previousOwner: { ...processIdentity(process.pid)!, start: 'exited-owner' } };
  const otherDescriptor: LaunchDescriptor = { ...descriptor, goal: 'kernel', generation: 'handover-2',
    session: 'other-native-session', engine: 'codex', home: join(dir, 'other-account'),
    env: { ...descriptor.env, CODEX_HOME: join(dir, 'other-account'), GOAL_ID: 'kernel' } };
  const procRoot = join(dir, 'proc');
  mkdirSync(join(procRoot, 'sys/kernel/random'), { recursive: true });
  writeFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'test-boot\n');
  return { dir, stateDir, launcher, descriptor, otherDescriptor, procRoot,
    process(pid: number, args: string[], env: string[] = [], start = '100', state = 'S', ppid = 0) {
      const directory = join(procRoot, String(pid)); mkdirSync(directory, { recursive: true });
      const fields = Array<string>(22).fill('0'); fields[0] = state; fields[1] = String(ppid); fields[19] = start;
      writeFileSync(join(directory, 'stat'), `${pid} (tool with spaces) ${fields.join(' ')}\n`);
      writeFileSync(join(directory, 'cgroup'), '0::/test\n');
      writeFileSync(join(directory, 'cmdline'), `${args.join('\0')}\0`);
      writeFileSync(join(directory, 'environ'), `${env.join('\0')}\0`);
      return processIdentity(pid, procRoot)!;
    },
    open(overrides: Partial<CoordinatorOptions> = {}) {
      const coordinator = new GoalCoordinator({ stateDir, launcher, maxTurns:1, now: () => now,
        events: () => events, admit: () => {}, owner: () => undefined, ...overrides });
      coordinators.push(coordinator);
      return coordinator;
    },
    setEvents(value: WakeEvent[]) { events = value; },
    setNow(value: number) { now = value; },
    calls() { return existsSync(join(dir, 'calls.jsonl'))
      ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; },
    cleanup() { for (const coordinator of coordinators) { try { coordinator.close(); } catch {} }
      if (previousSettings === undefined) delete process.env.GOAL_SETTINGS_DIRECTORY;
      else process.env.GOAL_SETTINGS_DIRECTORY = previousSettings;
      rmSync(dir, { recursive: true, force: true }); } };
}

async function waitFor(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for synthetic process');
    await Bun.sleep(20);
  }
}

describe('durable Goal wake coordinator', () => {
  test('planning completes through the existing event acknowledgement and survives restart without duplicate turns', async () => {
    const f = fixture();
    const mail = new GoalMailStore({stateDir:f.stateDir,goals:['program']});
    try {
      git(f.dir,['init','-b','main']);
      git(f.dir,['config','user.email','planning@example.test']);
      git(f.dir,['config','user.name','Planning fixture']);
      mkdirSync(join(f.dir,'docs/goals/program'),{recursive:true});
      writeFileSync(join(f.dir,'docs/goals/program/GOAL.md'),'---\nareas: [scripts/qa/cases/outcomes/**]\n---\n');
      mkdirSync(join(f.dir,'scripts/qa/cases/outcomes'),{recursive:true});
      const declare = (name: string) => {
        writeFileSync(join(f.dir,`scripts/qa/cases/outcomes/${name}.ts`),
          `import { rowOutcomes, pending } from '../outcome-cells.ts';\nexport default rowOutcomes('program/${name}', {owner: pending('failure')});`);
        git(f.dir,['add','--','docs','scripts']); git(f.dir,['commit','-m','Pending declaration']);
      };
      declare('first');
      mkdirSync(f.stateDir,{recursive:true});
      writeFileSync(join(f.stateDir,'ledger.json'),JSON.stringify({tasks:{},goals:{program:{manager:'manager'}}}));
      const first = f.open({events:goal=>managerEvents(f.stateDir,goal,mail,f.dir),maxTurns:6});
      first.enroll(f.descriptor); first.step();
      const attempt = first.status().attempts[0]!;
      expect(attempt.event_key).toStartWith('planning:');
      first.step();
      expect(first.status().attempts).toHaveLength(1);
      first.close();
      const restarted = f.open({events:goal=>managerEvents(f.stateDir,goal,mail,f.dir),maxTurns:6});
      restarted.step();
      expect(restarted.status().attempts).toHaveLength(1);
      await runAttempt(f.stateDir,attempt.token);
      restarted.step(); restarted.step();
      expect(restarted.status().attempts).toHaveLength(1);
      expect(restarted.db.query('SELECT handled FROM events WHERE event_key=?').get(attempt.event_key!)).toEqual({handled:1});
      declare('second'); restarted.step();
      expect(restarted.status().attempts).toHaveLength(2);
      const next = restarted.status().attempts[1]!;
      expect(next.prompt).toContain('program/first');
      expect(next.prompt).toContain('program/second');
      declare('third'); restarted.step();
      expect(restarted.status().attempts).toHaveLength(2);
      await runAttempt(f.stateDir,next.token); restarted.step(); restarted.step();
      expect(restarted.status().attempts).toHaveLength(3);
      expect(restarted.status().attempts[2]!.prompt).toContain('program/third');
    } finally { mail.close(); f.cleanup(); }
  });
  test('mail acknowledged during a cut turn still receives its one required cut retry', async () => {
    const f = fixture();
    try {
      f.setEvents([{key:'mail:request',body:'Decide request'}]);
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      f.setNow(1_600_000); coordinator.step();
      f.setEvents([]); coordinator.step(); f.setNow(1_605_000); coordinator.step();
      expect(coordinator.status().attempts).toHaveLength(2);
      expect(coordinator.status().attempts[1]!.prompt).toContain('first turn was cut');
      await runAttempt(f.stateDir,coordinator.status().attempts[1]!.token); coordinator.step();
      expect(coordinator.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });
  test('an engine terminated by a signal records a crash and the tokens reported before it', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir,'manager.ts'),`console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:90,cached_input_tokens:40,output_tokens:3}}));
        process.kill(process.pid,'SIGTERM');
        await Bun.sleep(60000);`);
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      await runAttempt(f.stateDir,coordinator.status().attempts[0]!.token);
      expect(coordinator.turns().turns[0]).toMatchObject({ending:'crash',code:128,input_tokens:90,cached_tokens:40,output_tokens:3});
    } finally { f.cleanup(); }
  });
  test('a turn starts one session when a reader of the event store makes its record wait', async () => {
    const f = fixture();
    let reader: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      const token = coordinator.status().attempts[0]!.token;
      const ready = join(f.dir, 'reader-ready');
      // A reader's shared lock refuses the commit, and the store then runs the whole transaction again.
      const source = `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs';
        const db = new Database(${JSON.stringify(join(f.stateDir, 'coordinator.sqlite'))}, {readonly:true});
        db.exec('PRAGMA busy_timeout=2000');
        const phase = db.query('SELECT phase FROM attempts WHERE token=?');
        writeFileSync(${JSON.stringify(ready)}, 'watching');
        while ((phase.get(${JSON.stringify(token)})).phase !== 'claimed') await Bun.sleep(1);
        db.exec('BEGIN'); db.query('SELECT count(*) FROM events').get();
        await Bun.sleep(250); db.exec('COMMIT'); db.close();`;
      reader = Bun.spawn([process.execPath, '-e', source], {stdout:'ignore',stderr:'inherit'});
      await waitFor(() => existsSync(ready));
      await runAttempt(f.stateDir,token);
      expect(await reader.exited).toBe(0);
      await Bun.sleep(300);
      expect(readFileSync(join(f.dir,'calls.jsonl'),'utf8').trim().split('\n')).toHaveLength(1);
      expect(coordinator.turns().turns[0]).toMatchObject({ending:'exit',code:0});
    } finally { reader?.kill(); f.cleanup(); }
  });
  test('task exclusions recognize brief filenames and mixed case without treating engine names as tasks', () => {
    expect(eventTasks({key:'task:G-42:1',body:'See brief-g-42.md and G-43; engine sample-b'})).toEqual(['G-42','G-43']);
  });
  test('checkpoint history does not block independent completed-task decisions beside an active decision after restart', async () => {
    const f = fixture();
    try {
      const history = [{key:'task:G-42:1',body:'G-42 completed'}, {key:'task:G-43:1',body:'G-43 completed'}];
      f.setEvents(history);
      const first = f.open({maxTurns:3}); first.enroll(f.descriptor); first.step();
      await Promise.all(first.status().attempts.map(attempt=>runAttempt(f.stateDir,attempt.token)));
      first.step();
      // Start a new decision just before the history's thirty-minute checkpoint becomes due.
      f.setNow(2_799_999);
      const active = {key:'task:G-42:2',body:'Decide the next G-42 result'};
      f.setEvents([...history,active]); first.step();
      const activeToken = first.status().attempts.find(attempt=>attempt.event_key === active.key)!.token;
      first.close();

      const restarted = f.open({maxTurns:3});
      const sameTask = {key:'task:G-42:3',body:'A later G-42 decision'};
      const independent = {key:'task:G-43:2',body:'G-43 completed again'};
      f.setEvents([...history,active,sameTask,independent]);
      f.setNow(2_800_000); restarted.step();
      const checkpoint = restarted.db.query("SELECT event_key,body,token FROM events WHERE event_key LIKE 'checkpoint:%'")
        .get() as {event_key:string;body:string;token:string|null};
      expect(checkpoint.body).toContain(history[0]!.key);
      expect(checkpoint.body).toContain(history[1]!.key);
      expect(restarted.status().attempts.filter(attempt=>attempt.phase !== 'done').map(attempt=>attempt.event_key))
        .toEqual([active.key,checkpoint.event_key,independent.key]);
      expect(restarted.db.query('SELECT token FROM events WHERE event_key=?').get(sameTask.key)).toEqual({token:null});
      expect(restarted.db.query('SELECT token FROM events WHERE event_key=?').get(active.key)).toEqual({token:activeToken});
      const launches = [...f.launcher.launches];
      restarted.close();
      const recovered = f.open({maxTurns:3}); recovered.step(); recovered.step();
      expect(f.launcher.launches).toEqual(launches);
      expect(recovered.db.query('SELECT token FROM events WHERE event_key=?').get(checkpoint.event_key)).toEqual({token:checkpoint.token});
    } finally { f.cleanup(); }
  });
  test('an active checkpoint does not lock its history tasks after restart', async () => {
    const f = fixture();
    try {
      const history = {key:'task:G-42:1',body:'G-42 completed'};
      f.setEvents([history]);
      const first = f.open({maxTurns:2,turnMinutes:60}); first.enroll(f.descriptor); first.step();
      await runAttempt(f.stateDir,first.status().attempts[0]!.token); first.step();
      f.setNow(2_800_000); first.step();
      const checkpoint = first.status().attempts.find(attempt=>attempt.event_key?.startsWith('checkpoint:'))!;
      expect(checkpoint.prompt).toContain(history.key);
      first.close();

      const restarted = f.open({maxTurns:2,turnMinutes:60});
      const followup = {key:'task:G-42:2',body:'G-42 completed again'};
      f.setEvents([history,followup]); restarted.step();
      expect(restarted.status().attempts.filter(attempt=>attempt.phase !== 'done').map(attempt=>attempt.event_key))
        .toEqual([checkpoint.event_key,followup.key]);
      await runAttempt(f.stateDir,restarted.status().attempts.find(attempt=>attempt.event_key === followup.key)!.token);
      restarted.step();
      f.setNow(4_600_000); restarted.step();
      expect(restarted.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'))).toHaveLength(1);
      await runAttempt(f.stateDir,checkpoint.token); restarted.step(); restarted.step();
      const checkpoints = restarted.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'));
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints[1]!.prompt).toContain(followup.key);
      expect(checkpoints[1]!.prompt).not.toContain(history.key);
    } finally { f.cleanup(); }
  });
  test('re-enrolling a role preserves a queued checkpoint and its covered-event boundary', async () => {
    const f = fixture();
    try {
      f.setEvents(Array.from({length:10},(_,index)=>({key:`task:G-${index}:1`,body:'Decision'})));
      const coordinator = f.open({maxTurns:10}); coordinator.enroll(f.descriptor); coordinator.step();
      await Promise.all(coordinator.status().attempts.map(attempt=>runAttempt(f.stateDir,attempt.token)));
      coordinator.step();
      const before = coordinator.db.query('SELECT * FROM checkpoints').get();
      expect(before).toMatchObject({covered_through:0,through_sequence:10});
      coordinator.unenroll('program');
      const {previousOwner: _previousOwner,...fresh} = f.descriptor;
      coordinator.start({...fresh,generation:'replacement',startArgs:fresh.args});
      expect(coordinator.db.query('SELECT * FROM checkpoints').get()).toEqual(before);
      coordinator.step();
      expect(coordinator.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'))).toHaveLength(1);
    } finally { f.cleanup(); }
  });
  test('a cut-notice delivery failure leaves it durable while other Goals keep launching', () => {
    const f = fixture();
    let unavailable = true;
    const delivered: string[] = [];
    try {
      const coordinator = f.open({notifyCut:(goal,key)=>{
        if (unavailable) throw new Error('mail temporarily unavailable');
        delivered.push(`${goal}/${key}`);
      }});
      coordinator.db.query('INSERT INTO cut_notices(goal,event_key) VALUES(?,?)').run('program','task:G-5:1');
      coordinator.enroll(f.otherDescriptor); coordinator.step();
      expect(f.launcher.launches).toHaveLength(1);
      expect(coordinator.db.query('SELECT sent FROM cut_notices').get()).toEqual({sent:0});
      unavailable = false; coordinator.step(); coordinator.step();
      expect(delivered).toEqual(['program/task:G-5:1']);
      expect(coordinator.db.query('SELECT sent FROM cut_notices').get()).toEqual({sent:1});
    } finally { f.cleanup(); }
  });
  test('ten handled events queue one checkpoint and later decisions remain for the next checkpoint', async () => {
    const f = fixture();
    try {
      const events = (start: number, length: number) => Array.from({length},(_,index)=>({key:`task:G-${start+index}:1`,body:`G-${start+index} completed`}));
      f.setEvents(events(1,10));
      const first = f.open({maxTurns:6}); first.enroll(f.descriptor); first.step();
      for (let wave=0; wave<2; wave++) {
        await Promise.all(first.status().attempts.filter(attempt=>attempt.phase !== 'done').map(attempt=>runAttempt(f.stateDir,attempt.token)));
        first.step(); first.step();
      }
      const checkpoint = first.status().attempts.find(attempt=>attempt.event_key?.startsWith('checkpoint:'))!;
      expect(checkpoint).toBeDefined();
      expect(checkpoint.prompt).toContain('Checkpoint: update docs/goals/program/state.md');
      expect(checkpoint.prompt).toContain('Edit state.md only when the event is `checkpoint`');
      expect(checkpoint.prompt).toContain('task:G-10:1');
      f.setEvents(events(11,10)); first.step();
      // Keep the checkpoint live while ten other decisions complete beside it.
      for (let wave=0; wave<2; wave++) {
        const ordinary = first.status().attempts.filter(attempt=>attempt.phase !== 'done' && !attempt.event_key?.startsWith('checkpoint:'));
        expect(ordinary).toHaveLength(5);
        await Promise.all(ordinary.map(attempt=>runAttempt(f.stateDir,attempt.token)));
        first.step(); first.step();
      }
      expect(first.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'))).toHaveLength(1);
      first.close(); const restarted = f.open({maxTurns:6}); restarted.step();
      expect(restarted.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'))).toHaveLength(1);
      await runAttempt(f.stateDir,checkpoint.token); restarted.step(); restarted.step();
      const checkpoints = restarted.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'));
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.filter(attempt=>attempt.phase !== 'done')).toHaveLength(1);
      expect(checkpoints[1]!.prompt).toContain('task:G-20:1');
      expect(checkpoints[1]!.prompt).not.toContain('task:G-10:1');
      await runAttempt(f.stateDir,checkpoints[1]!.token); restarted.step();
      expect(restarted.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });
  test('the first uncovered handled event starts a durable thirty-minute checkpoint clock', async () => {
    const f = fixture();
    try {
      const first = f.open(); first.enroll(f.descriptor); first.step();
      await runAttempt(f.stateDir,first.status().attempts[0]!.token); first.step();
      first.close(); const restarted = f.open();
      f.setNow(2_799_999); restarted.step();
      expect(restarted.status().attempts).toHaveLength(1);
      f.setNow(2_800_000); restarted.step();
      const checkpoint = restarted.status().attempts[1]!;
      expect(checkpoint.event_key).toStartWith('checkpoint:');
      expect(checkpoint.prompt).toContain('exit:worker:1');
      await runAttempt(f.stateDir,checkpoint.token); restarted.step();
      f.setNow(5_000_000); restarted.step();
      expect(restarted.status().attempts).toHaveLength(2);
      expect(restarted.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });
  test('a checkpoint failure retries the same checkpoint without covering its events', async () => {
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      await runAttempt(f.stateDir,coordinator.status().attempts[0]!.token); coordinator.step();
      f.setNow(2_800_000); coordinator.step();
      const checkpoint = coordinator.status().attempts[1]!;
      coordinator.db.query("UPDATE attempts SET phase='done',code=7 WHERE token=?").run(checkpoint.token);
      coordinator.step();
      expect(coordinator.db.query('SELECT covered_through,queued_key FROM checkpoints').get())
        .toEqual({covered_through:0,queued_key:checkpoint.event_key});
      f.setNow(2_805_000); coordinator.step();
      expect(coordinator.status().attempts[2]!.event_key).toBe(checkpoint.event_key);
      expect(coordinator.db.query("SELECT COUNT(*) AS n FROM events WHERE event_key LIKE 'checkpoint:%'").get()).toEqual({n:1});
    } finally { f.cleanup(); }
  });
  test('a restart completes a durable cut intent without launching the old turn again', () => {
    const f = fixture();
    try {
      const first = f.open({turnMinutes:1}); first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      first.db.query("UPDATE attempts SET phase='cutting',ending='cut' WHERE token=?").run(token);
      first.close(); const restarted = f.open({turnMinutes:1}); restarted.step(); restarted.step();
      expect(restarted.status().attempts[0]).toMatchObject({phase:'done',ending:'cut'});
      expect(f.launcher.launches).toEqual([token]);
      f.setNow(1_005_000); restarted.step();
      expect(restarted.status().attempts[1]!.prompt).toContain('first turn was cut');
    } finally { f.cleanup(); }
  });
  test('a cut retry names untracked, changed and staged briefs of its Goal so it can continue them', () => {
    const f = fixture();
    try {
      git(f.dir, ['init', '-b', 'main']);
      git(f.dir, ['config', 'user.email', 'retry@example.test']);
      git(f.dir, ['config', 'user.name', 'Retry fixture']);
      const tasks = join(f.dir, 'docs/goals/program/tasks');
      const otherTasks = join(f.dir, 'docs/goals/kernel/tasks');
      mkdirSync(tasks, {recursive:true}); mkdirSync(otherTasks, {recursive:true});
      for (const id of ['G-100', 'G-101', 'G-102']) writeFileSync(join(tasks, `${id}.md`), 'original');
      writeFileSync(join(otherTasks, 'G-200.md'), 'original');
      git(f.dir, ['add', '.']); git(f.dir, ['commit', '-m', 'Brief fixture']);
      writeFileSync(join(tasks, 'G-100.md'), 'changed');
      writeFileSync(join(tasks, 'G-101.md'), 'staged');
      git(f.dir, ['add', 'docs/goals/program/tasks/G-101.md']);
      writeFileSync(join(tasks, 'G-103.md'), 'untracked');
      writeFileSync(join(otherTasks, 'G-200.md'), 'other Goal changed');
      writeFileSync(join(tasks, 'notes.txt'), 'not a brief');
      const coordinator = f.open({turnMinutes:1}); coordinator.enroll(f.descriptor); coordinator.step();
      f.setNow(1_060_000); coordinator.step(); coordinator.step();
      f.setNow(1_065_000); coordinator.step();
      const prompt = coordinator.status().attempts[1]!.prompt;
      for (const id of ['G-100', 'G-101', 'G-103']) expect(prompt).toContain(`docs/goals/program/tasks/${id}.md`);
      expect(prompt).toContain('Continue these briefs rather than writing them again');
      expect(prompt).not.toContain('G-102.md');
      expect(prompt).not.toContain('G-200.md');
      expect(prompt).not.toContain('notes.txt');
    } finally { f.cleanup(); }
  });
  test('the default bound retries an event once, stops it on a second cut and mails program durably', () => {
    const f = fixture();
    const mail = new GoalMailStore({stateDir:f.stateDir,goals:['program','kernel']});
    try {
      f.setEvents([{key:'task:G-80:1',body:'Slow decision'}]);
      const first = f.open({maxTurns:2}); first.enroll(f.otherDescriptor); first.step();
      const token = first.status().attempts[0]!.token;
      f.setNow(1_500_000);
      f.setEvents([{key:'task:G-80:1',body:'Slow decision'},{key:'task:G-81:1',body:'Independent decision'}]);
      first.step();
      const independent = first.status().attempts[1]!.token;
      f.setNow(1_599_999); first.step();
      expect(first.status().attempts[0]!.phase).toBe('intent');
      first.close();
      const restarted = f.open({maxTurns:2}); f.setNow(1_600_000); restarted.step();
      expect(restarted.status().attempts[0]).toMatchObject({token,phase:'done',ending:'cut',code:137,ended_at:1_600_000});
      expect(restarted.status().attempts[1]).toMatchObject({token:independent,phase:'intent'});
      restarted.step(); f.setNow(1_605_000); restarted.step();
      const retry = restarted.status().attempts[2]!;
      expect(retry.event_key).toBe('task:G-80:1');
      expect(retry.prompt).toContain('first turn was cut');
      // The independent event completes before the retry reaches its bound.
      restarted.db.query("UPDATE attempts SET phase='done',code=0 WHERE token=?").run(independent);
      restarted.step(); f.setNow(2_205_000); restarted.step(); restarted.step();
      expect(restarted.status().attempts[2]).toMatchObject({ending:'cut'});
      expect(restarted.db.query('SELECT handled,cuts FROM events WHERE event_key=?').get('task:G-80:1')).toEqual({handled:1,cuts:2});
      expect(mail.pending('program')).toHaveLength(1);
      expect(mail.pending('program')[0]!.body).toContain('task:G-80:1');
      expect(mail.pending('program')[0]!.sender).toBe('kernel');
      restarted.close(); const again = f.open({maxTurns:2}); again.step();
      expect(again.status().attempts).toHaveLength(3);
      expect(mail.pending('program')).toHaveLength(1);
    } finally { mail.close(); f.cleanup(); }
  });
  test('a cut kills the real manager process group while its detached worker survives', async () => {
    const f = fixture();
    let worker: ReturnType<typeof processIdentity>;
    let pending: Promise<void> | undefined;
    try {
      const marker = join(f.dir,'descendants.json');
      writeFileSync(join(f.dir,'manager.ts'),`import {spawn} from 'node:child_process';
        import {writeFileSync} from 'node:fs';
        const tools = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
        const worker = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{...process.env,GOAL_TASK_ID:'G-99'}});
        worker.unref();
        writeFileSync(${JSON.stringify(marker)},JSON.stringify({tools:tools.pid,worker:worker.pid}));
        await Bun.sleep(60000);`);
      const first = f.open(); first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      pending = runAttempt(f.stateDir,token);
      await waitFor(()=>existsSync(marker));
      const descendants = JSON.parse(readFileSync(marker,'utf8')) as {tools:number;worker:number};
      worker = processIdentity(descendants.worker);
      expect(worker).toBeDefined();
      first.db.query('UPDATE attempts SET started_at=? WHERE token=?').run(1_000_000,token);
      first.close(); const restarted = f.open(); f.setNow(1_600_000); restarted.step();
      await pending;
      await waitFor(()=>!processIdentity(descendants.tools));
      expect(restarted.status().attempts[0]).toMatchObject({ending:'cut',code:137});
      expect(sameProcess(worker!)).toBe(true);
    } finally {
      if (worker && sameProcess(worker)) process.kill(-worker.pid,'SIGKILL');
      if (pending) await pending;
      f.cleanup();
    }
  });
  test('six fresh event turns run side by side by default and retain the cap after restart', async () => {
    const f = fixture();
    try {
      f.setEvents(Array.from({length:18},(_,index)=>({key:`task:G-${100+index}:1`,body:`G-${100+index} exited`})));
      const first = f.open({maxTurns:undefined}); first.enroll(f.descriptor); first.step();
      expect(first.status().attempts).toHaveLength(6);
      expect(new Set(first.status().attempts.map(attempt=>JSON.parse(attempt.descriptor).session)).size).toBe(6);
      first.close();
      const restarted = f.open({maxTurns:undefined}); restarted.step();
      expect(restarted.status().attempts).toHaveLength(6);
      for (let wave = 0; wave < 4; wave++) {
        const batch = restarted.status().attempts.filter(attempt=>attempt.phase !== 'done');
        expect(batch.length).toBeLessThanOrEqual(6);
        expect(batch.length).toBeGreaterThan(0);
        await Promise.all(batch.map(attempt=>runAttempt(f.stateDir,attempt.token)));
        restarted.step(); restarted.step();
      }
      expect(restarted.status().attempts.filter(attempt=>attempt.event_key?.startsWith('task:'))).toHaveLength(18);
      expect(restarted.status().attempts.filter(attempt=>attempt.event_key?.startsWith('checkpoint:'))).toHaveLength(1);
      expect(restarted.status().wakes).toEqual([]);
      expect(f.calls()).toHaveLength(19);
    } finally { f.cleanup(); }
  });
  test('events naming the same task wait while unrelated task events run, including after restart', async () => {
    const f = fixture();
    try {
      f.setEvents([{key:'task:G-42:1',body:'First exit'},
        {key:'mail:decision',body:'Decide G-42 with G-43'},
        {key:'task:G-43:1',body:'Other exit'},
        {key:'task:G-44:1',body:'Independent exit'}]);
      const first = f.open({maxTurns:3}); first.enroll(f.descriptor); first.step();
      const active = first.status().attempts;
      expect(active.map(attempt=>attempt.event_key)).toEqual(['task:G-42:1','task:G-44:1']);
      first.close();
      const restarted = f.open({maxTurns:3}); restarted.step();
      expect(restarted.status().attempts).toHaveLength(2);
      await runAttempt(f.stateDir,active[0]!.token);
      restarted.step(); restarted.step();
      expect(restarted.status().attempts.map(attempt=>attempt.event_key)).toEqual(['task:G-42:1','task:G-44:1','mail:decision']);
      await runAttempt(f.stateDir,restarted.status().attempts[2]!.token);
      f.setEvents([{key:'task:G-42:1',body:'First exit'},{key:'task:G-43:1',body:'Other exit'},{key:'task:G-44:1',body:'Independent exit'}]);
      restarted.step(); restarted.step();
      expect(restarted.status().attempts.map(attempt=>attempt.event_key)).toEqual(['task:G-42:1','task:G-44:1','mail:decision','task:G-43:1']);
    } finally { f.cleanup(); }
  });
  test('one failed event backs off without delaying another event of the same Goal', async () => {
    const f = fixture();
    try {
      f.setEvents([{key:'task:G-1:1',body:'First'},{key:'task:G-2:1',body:'Second'}]);
      const coordinator = f.open({maxTurns:2}); coordinator.enroll({...f.descriptor,env:{...f.descriptor.env,EXIT_CODE:'7'}});
      coordinator.step(); const [first,second] = coordinator.status().attempts;
      await runAttempt(f.stateDir,first!.token); coordinator.step();
      f.setEvents([{key:'task:G-1:1',body:'First'},{key:'task:G-2:1',body:'Second'},{key:'task:G-3:1',body:'Third'}]);
      coordinator.step();
      expect(coordinator.status().attempts.map(attempt=>attempt.event_key)).toEqual(['task:G-1:1','task:G-2:1','task:G-3:1']);
      expect(coordinator.db.query('SELECT due_at,failures FROM events WHERE event_key=?').get('task:G-1:1'))
        .toEqual({due_at:1_005_000,failures:1});
      expect(second!.phase).toBe('intent');
    } finally { f.cleanup(); }
  });
  test('turn records survive restart during execution and record real CLI commands and reported usage', async () => {
    const f = fixture();
    const mail = new GoalMailStore({stateDir:f.stateDir,goals:['program'],sender:'program'});
    try {
      const message = mail.send('program','Request','recorded');
      writeFileSync(join(f.stateDir,'ledger.json'),JSON.stringify({tasks:{},goals:{program:{manager:'manager'}}}));
      const script = join(f.dir,'manager.ts');
      const gate = join(f.dir,'release');
      writeFileSync(script, `import { existsSync } from 'node:fs';
        import { spawnSync } from 'node:child_process';
        while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(10);
        const ack = spawnSync(process.execPath, [${JSON.stringify(join(import.meta.dir,'goalctl.ts'))}, 'mail','ack',${JSON.stringify(message.id)}],
          {env:{...process.env,GOAL_MAIL_STATE_DIR:process.env.GOAL_TURN_STATE_DIR},encoding:'utf8'});
        if (ack.status !== 0) throw new Error(ack.stderr);
        console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,cached_input_tokens:80,output_tokens:7}}));`);
      const first = f.open({events:goal=>managerEvents(f.stateDir,goal,mail)});
      first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      const pending = runAttempt(f.stateDir,token);
      await waitFor(()=>Boolean(first.status().attempts[0]!.child));
      expect(first.turns().turns[0]).toMatchObject({event_key:message.id,ending:null,ended_at:null});
      first.close();
      const restarted = f.open({events:goal=>managerEvents(f.stateDir,goal,mail)});
      restarted.step();
      expect(f.launcher.launches).toEqual([token]);
      writeFileSync(gate,'go'); await pending; restarted.step();
      const report = restarted.turns();
      expect(report.turns[0],readFileSync(join(f.stateDir,'manager-runs',token,'stderr.log'),'utf8')).toMatchObject({goal:'program',event_key:message.id,ending:'exit',code:0,
        input_tokens:120,cached_tokens:80,output_tokens:7,commands:['mail ack']});
      expect(report.turns[0]!.ended_at!).toBeGreaterThanOrEqual(report.turns[0]!.started_at!);
      expect(report.summary).toEqual({turns:1,medianInputTokens:120,ackOnlyTurns:1});
      const cli = spawnSync(process.execPath,[join(import.meta.dir,'goalctl.ts'),'coordinator','turns','--goal','program','--since','1970-01-01T00:00:00Z'],
        {env:{...process.env,GOAL_MAIL_STATE_DIR:f.stateDir},encoding:'utf8'});
      expect(cli.status,cli.stderr).toBe(0);
      const lines = cli.stdout.trim().split('\n').map(line=>JSON.parse(line));
      expect(lines[0]).toMatchObject({event:message.id,input:120,commands:['mail ack'],ending:'exit'});
      expect(lines[1]).toEqual(report.summary);
      expect(restarted.turns({goal:'kernel'}).summary.turns).toBe(0);
      expect(restarted.turns({since:Date.now()+1000}).summary.turns).toBe(0);
    } finally { mail.close(); f.cleanup(); }
  });
  test('usage sums engine reports while absent usage remains unknown', () => {
    expect(turnUsage('noise\n{}')).toEqual({input:null,cached:null,output:null});
    expect(turnUsage(JSON.stringify({type:'result',usage:{input_tokens:20,cache_read_input_tokens:70,cache_creation_input_tokens:10,output_tokens:3}})))
      .toEqual({input:100,cached:70,output:3});
    expect(turnUsage([1,2].map(()=>JSON.stringify({type:'turn.completed',usage:{input_tokens:50,cached_input_tokens:10,output_tokens:5}})).join('\n')))
      .toEqual({input:100,cached:20,output:10});
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      coordinator.db.query('UPDATE attempts SET input_tokens=10').run();
      f.setEvents([{key:'next',body:'Next'}]);
      coordinator.db.query("UPDATE attempts SET phase='done',code=0").run(); coordinator.step(); coordinator.step();
      coordinator.db.query('UPDATE attempts SET input_tokens=20 WHERE event_key=?').run('next');
      expect(coordinator.turns().summary).toEqual({turns:2,medianInputTokens:15,ackOnlyTurns:0});
    } finally { f.cleanup(); }
  });
  test('fresh Codex and Claude argv preserve the role settings without resuming', () => {
    const f = fixture();
    try {
      const codex = freshTurnDescriptor({...f.descriptor,args:['exec','resume',f.descriptor.session,'-m','chosen','-c','model_reasoning_effort=high','--',WAKE_PROMPT,WAKE_LAST_MESSAGE]});
      expect(codex.args).toEqual(['exec','-m','chosen','-c','model_reasoning_effort=high','--',WAKE_PROMPT,WAKE_LAST_MESSAGE]);
      expect(codex.home).toBe(f.descriptor.home);
      expect(codex.previousOwner).toEqual(f.descriptor.previousOwner);
      const claude = freshTurnDescriptor({...f.descriptor,engine:'claude',args:claudeWakeArgs(f.descriptor.session,'chosen','high')});
      expect(claude.args).not.toContain('--resume');
      expect(claude.args).toContain(claude.session);
      expect(claude.session).not.toBe(f.descriptor.session);
    } finally { f.cleanup(); }
  });
  test('overdue mail adds one deadline wake and one sender notice, with sender and deadline in the wake body', async () => {
    const f = fixture();
    let now = 1_000_000;
    const mail = new GoalMailStore({stateDir:f.stateDir,goals:['program','kernel'],sender:'kernel',now:()=>now});
    try {
      const message = mail.send('program','Please act','due',1);
      const coordinator = f.open({events:goal=>managerEvents(f.stateDir,goal,mail)});
      coordinator.enroll(f.descriptor); coordinator.step();
      const first = coordinator.status().attempts[0]!;
      expect(first.prompt).toContain('From: kernel');
      expect(first.prompt).toContain(`Deadline: ${message.deadlineAt}`);
      await runAttempt(f.stateDir,first.token); coordinator.step();
      now += 60_001; f.setNow(now); mail.notifyOverdue(); coordinator.step();
      const deadline = coordinator.status().attempts[1]!;
      expect(deadline.prompt).toContain('one deadline wake');
      expect(deadline.prompt).toContain(message.deadlineAt!);
      await runAttempt(f.stateDir,deadline.token);
      const {previousOwner: _previousOwner,...fresh} = f.descriptor;
      expect(()=>coordinator.start({...fresh,generation:'replacement',startArgs:fresh.args})).toThrow('unresolved attempt');
      coordinator.step();
      now += 30_000; f.setNow(now); mail.notifyOverdue(); coordinator.step();
      const later = coordinator.status().attempts[2]!;
      expect(later.prompt).not.toContain('one deadline wake');
      expect(mail.pending('kernel')).toHaveLength(1);
      expect(coordinator.db.query("SELECT handled FROM events WHERE event_key LIKE 'mail:overdue:%'").all()).toEqual([{handled:1}]);
      await runAttempt(f.stateDir,later.token); coordinator.step();
      coordinator.unenroll('program');
      coordinator.start({...fresh,generation:'replacement',startArgs:fresh.args});
      expect(coordinator.db.query("SELECT handled FROM events WHERE event_key LIKE 'mail:overdue:%'").all()).toEqual([{handled:1}]);
    } finally { mail.close(); f.cleanup(); }
  });

  test('acknowledging overdue mail before its queued deadline turn cancels that extra wake', async () => {
    const f = fixture();
    let now = 1_000_000;
    const mail = new GoalMailStore({stateDir:f.stateDir,goals:['program','kernel'],sender:'kernel',now:()=>now});
    try {
      const message = mail.send('program','Please act','due',1);
      const coordinator = f.open({events:goal=>managerEvents(f.stateDir,goal,mail)});
      coordinator.enroll(f.descriptor); coordinator.step();
      const first = coordinator.status().attempts[0]!;
      now += 60_001; f.setNow(now); mail.notifyOverdue(); coordinator.step();
      mail.ack('program',message.id);
      await runAttempt(f.stateDir,first.token); coordinator.step(); coordinator.step();
      expect(f.launcher.launches).toHaveLength(1);
      expect(coordinator.status().wakes).toEqual([]);
    } finally { mail.close(); f.cleanup(); }
  });

  test('coordinator status lists overdue mail without sending notices or changing the store', () => {
    const f = fixture();
    const mail = new GoalMailStore({stateDir:f.stateDir,goals:['program','kernel'],sender:'kernel',
      now:()=>Date.parse('2020-01-01T00:00:00Z')});
    try {
      const message = mail.send('program','Please act','due',1);
      writeFileSync(join(f.stateDir,'ledger.json'),JSON.stringify({tasks:{},goals:{program:{manager:'manager'},kernel:{manager:'sender'}}}));
      const result = spawnSync(process.execPath,[join(import.meta.dir,'goalctl.ts'),'coordinator','status'],
        {cwd:join(import.meta.dir,'../..'),env:{...process.env,GOAL_MAIL_STATE_DIR:f.stateDir},encoding:'utf8'});
      expect(result.status,result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).overdueMail).toEqual([expect.objectContaining({id:message.id,sender:'kernel',
        goal:'program',deadlineAt:message.deadlineAt,overdueAt:null})]);
      expect(mail.pending('kernel')).toEqual([]);
      const pump = spawnSync(process.execPath,[join(import.meta.dir,'goalctl.ts'),'coordinator','--once'],
        {cwd:join(import.meta.dir,'../..'),env:{...process.env,GOAL_MAIL_STATE_DIR:f.stateDir},encoding:'utf8'});
      expect(pump.status,pump.stderr).toBe(0);
      expect(mail.pending('kernel')).toHaveLength(1);
    } finally { mail.close(); f.cleanup(); }
  });
  test('a new manager receives its charter before a backlog larger than a wake batch', () => {
    const f = fixture();
    try {
      f.setEvents(Array.from({length:101},(_,index)=>({key:`mail:${index}`,body:'Mail waiting'})));
      const {previousOwner: _previousOwner,...fresh} = f.descriptor;
      const coordinator = f.open();
      coordinator.start({...fresh,startArgs:fresh.args}); coordinator.step();
      const first = coordinator.status().attempts[0]!;
      expect(first.prompt).toContain(managerStartMessage('program'));
      expect(first.prompt).not.toContain('Mail waiting');
      expect(coordinator.db.query('SELECT COUNT(*) AS n FROM events WHERE token=?').get(first.token)).toEqual({n:1});
    } finally { f.cleanup(); }
  });
  test('start enrolls a role and each event gets a fresh conversation across restart', async () => {
    const f = fixture();
    try {
      f.setEvents([]);
      const {previousOwner: _previousOwner,...fresh} = f.descriptor;
      const descriptor = {...fresh,startArgs:fresh.args};
      const coordinator = f.open();
      coordinator.start(descriptor);
      expect(coordinator.status().managers[0]!.previousOwner).toBeUndefined();
      expect(() => coordinator.start(descriptor)).toThrow('already queued');
      coordinator.step();
      const first = coordinator.status().attempts[0]!;
      expect(first.prompt).toContain(managerStartMessage('program'));
      expect(() => coordinator.start(descriptor)).toThrow('unresolved attempt');
      await runAttempt(f.stateDir,first.token);
      expect(coordinator.status().managers[0]).toMatchObject(descriptor);
      coordinator.step();
      expect(() => coordinator.start({...descriptor,generation:'replacement'})).toThrow('role already enrolled');
      coordinator.close();
      const restarted = f.open();
      restarted.step();
      f.setEvents([{key:'exit:worker:2',body:'Next worker exited'}]);
      restarted.step();
      const second = restarted.status().attempts[1]!;
      expect(JSON.parse(second.descriptor).session).not.toBe(JSON.parse(first.descriptor).session);
      expect(second.prompt).not.toContain(managerStartMessage('program'));
      await runAttempt(f.stateDir,second.token);
      expect(f.calls()).toHaveLength(2);
      restarted.step();
      restarted.unenroll('program');
      restarted.start({...descriptor,generation:'replacement'});
      expect(restarted.status().managers[0]!.generation).toBe('replacement');
    } finally { f.cleanup(); }
  });

  test('a failed start retries as a fresh event after backoff', async () => {
    const f = fixture();
    try {
      f.setEvents([]);
      const {previousOwner: _previousOwner,...fresh} = f.descriptor;
      const descriptor = {...fresh,startArgs:fresh.args,env:{...fresh.env,EXIT_CODE:'7'}};
      const coordinator = f.open();
      coordinator.start(descriptor); coordinator.step();
      const token = coordinator.status().attempts[0]!.token;
      await runAttempt(f.stateDir,token);
      f.launcher.running.delete(token);
      coordinator.step();
      expect(f.calls()).toHaveLength(1);
      expect(f.launcher.launches).toHaveLength(1);
      expect(coordinator.status().wakes[0]!.error).toContain('Manager exit 7');
      f.setNow(coordinator.status().wakes[0]!.due_at);
      coordinator.step();
      expect(f.launcher.launches).toHaveLength(2);
      expect(JSON.parse(coordinator.status().attempts[1]!.descriptor).session)
        .not.toBe(JSON.parse(coordinator.status().attempts[0]!.descriptor).session);
    } finally { f.cleanup(); }
  });

  test('replacement refuses a live owner even when the native session file is missing', () => {
    const f = fixture();
    try {
      const coordinator = f.open({owner:()=> 'Native session still owned by process 123'});
      coordinator.enroll(f.descriptor);
      const {previousOwner: _previousOwner,...fresh} = f.descriptor;
      expect(() => coordinator.start({...fresh,startArgs:fresh.args})).toThrow('still owned');
      expect(coordinator.status().managers[0]!.generation).toBe(f.descriptor.generation);
    } finally { f.cleanup(); }
  });

  test('start enforces required engine, effort and strict options while accepting model overrides', () => {
    const f = fixture();
    try {
      for (const engine of ['codex','sample-b','sample-c','claude'] as const) {
        expect(coordinatorStartOptions(['program','--engine',engine,'--effort','high','--model','chosen-model']))
          .toEqual({goal:'program',engine,effort:'high',model:'chosen-model'});
        expect(coordinatorStartOptions(['program','--engine',engine,'--effort','high']).model).toBeTruthy();
      }
      for (const args of [[],['program'],['program','--engine','luna','--effort','high'],
        ['program','--engine','codex'],['program','--engine','codex','--effort','invalid'],
        ['program','--engine','codex','--effort','high','--previous-owner-pid','1']]) {
        expect(() => coordinatorStartOptions(args)).toThrow();
      }
    } finally { f.cleanup(); }
  });
  test('Goals on different account homes retain independent wakes and launch descriptors across restart', async () => {
    const f = fixture();
    const events = (goal: string): WakeEvent[] => [{ key: 'timer:follow-up', body: `${goal} follow-up`,
      dueAt: goal === 'program' ? 1_000_000 : 1_010_000 }];
    try {
      const first = f.open({ events });
      first.enroll(f.descriptor); first.enroll(f.otherDescriptor); first.step();
      expect(first.status().managers.map(manager => [manager.goal, manager.home]))
        .toEqual([['kernel', f.otherDescriptor.home], ['program', f.descriptor.home]]);
      expect(first.status().wakes).toHaveLength(2);
      const program = first.status().attempts[0]!;
      expect(program).toMatchObject({ goal: 'program', generation: f.descriptor.generation });
      expect(program.prompt).toContain('program follow-up');
      expect(program.prompt).not.toContain('kernel follow-up');
      expect(JSON.parse(program.descriptor)).toMatchObject({goal:f.descriptor.goal,home:f.descriptor.home,args:f.descriptor.args});
      await runAttempt(f.stateDir, program.token); first.step();
      expect(first.status().wakes).toEqual([{ goal: 'kernel', due_at: 1_010_000, failures: 0, error: null, token: null }]);
      first.close();
      const restarted = f.open({ events }); f.setNow(1_009_999); restarted.step();
      expect(f.launcher.launches).toEqual([program.token]);
      f.setNow(1_010_000); restarted.step();
      const kernel = restarted.status().attempts.find(attempt => attempt.goal === 'kernel')!;
      expect(kernel).toMatchObject({ generation: f.otherDescriptor.generation });
      expect(kernel.prompt).toContain('kernel follow-up');
      expect(kernel.prompt).not.toContain('program follow-up');
      expect(JSON.parse(kernel.descriptor)).toMatchObject({goal:f.otherDescriptor.goal,home:f.otherDescriptor.home,args:f.otherDescriptor.args});
      expect(kernel.token).not.toBe(program.token);
      await runAttempt(f.stateDir, kernel.token); restarted.step();
      expect(restarted.status().wakes).toEqual([]);
      expect(f.calls().map(call => ({ goal: call.goal, home: call.home }))).toEqual([
        { goal: 'program', home: f.descriptor.home }, { goal: 'kernel', home: f.otherDescriptor.home }]);
    } finally { f.cleanup(); }
  });

  test('one Goal manager failure backs off only its own wakes while another Goal keeps making progress', async () => {
    const f = fixture();
    let programEvents: WakeEvent[] = [];
    try {
      const coordinator = f.open({ events: goal => goal === 'kernel'
        ? [{ key: 'exit:worker:1', body: 'Kernel worker completed' }] : programEvents });
      coordinator.enroll(f.descriptor);
      coordinator.enroll({ ...f.otherDescriptor, env: { ...f.otherDescriptor.env, EXIT_CODE: '7' } });
      coordinator.step(); const kernel = coordinator.status().attempts[0]!;
      await runAttempt(f.stateDir, kernel.token);
      programEvents = [{ key: 'exit:worker:1', body: 'Program worker completed' }];
      coordinator.step();
      expect(coordinator.status().wakes.find(wake => wake.goal === 'kernel'))
        .toMatchObject({ due_at: 1_005_000, failures: 1, error: 'Manager exit 7', token: null });
      const program = coordinator.status().attempts.find(attempt => attempt.goal === 'program')!;
      expect(f.launcher.launches).toEqual([kernel.token, program.token]);
      expect(coordinator.status().wakes.find(wake => wake.goal === 'program'))
        .toMatchObject({ due_at: 1_005_000, failures: 0, token: program.token });
      await runAttempt(f.stateDir, program.token); coordinator.step();
      expect(coordinator.status().wakes.map(wake => wake.goal)).toEqual(['kernel']);
      f.setNow(1_004_999);
      programEvents.push({ key: 'exit:worker:2', body: 'Another program worker completed' });
      coordinator.step();
      expect(coordinator.status().attempts.filter(attempt => attempt.goal === 'program')).toHaveLength(2);
      expect(coordinator.status().attempts.filter(attempt => attempt.goal === 'kernel')).toHaveLength(1);
      f.setNow(1_005_000); coordinator.step();
      expect(coordinator.status().attempts.filter(attempt => attempt.goal === 'kernel')).toHaveLength(2);
      expect(f.calls().map(call => call.goal)).toEqual(['kernel', 'program']);
    } finally { f.cleanup(); }
  });

  test('one account quota denial does not delay another Goal or share its admission backoff', async () => {
    const f = fixture();
    const admissions: [string, string][] = [];
    let kernelAdmitted = false;
    let programEvents: WakeEvent[] = [];
    try {
      const coordinator = f.open({ events: goal => goal === 'kernel'
        ? [{ key: 'mail:request', body: 'Kernel request' }] : programEvents,
      admit: descriptor => {
        admissions.push([descriptor.goal, descriptor.home]);
        if (descriptor.goal === 'kernel' && !kernelAdmitted) throw new Error('account quota exhausted');
      } });
      coordinator.enroll(f.descriptor); coordinator.enroll(f.otherDescriptor); coordinator.step();
      expect(coordinator.status().wakes[0]).toMatchObject({ goal: 'kernel', due_at: 1_005_000, failures: 1, token: null });
      programEvents = [{ key: 'mail:request', body: 'Program request' }]; coordinator.step();
      const program = coordinator.status().attempts[0]!;
      expect(program.goal).toBe('program');
      expect(admissions).toEqual([['kernel', f.otherDescriptor.home], ['program', f.descriptor.home]]);
      await runAttempt(f.stateDir, program.token); programEvents = []; coordinator.step();
      f.setNow(1_005_000);
      programEvents = [{ key: 'mail:next-request', body: 'Next program request' }]; coordinator.step();
      expect(coordinator.status().wakes.find(wake => wake.goal === 'kernel'))
        .toMatchObject({ due_at: 1_015_000, failures: 2, token: null });
      expect(coordinator.status().attempts.map(attempt => attempt.goal)).toEqual(['program', 'program']);
      expect(admissions).toEqual([['kernel', f.otherDescriptor.home], ['program', f.descriptor.home],
        ['kernel', f.otherDescriptor.home], ['program', f.descriptor.home]]);
      kernelAdmitted = true; f.setNow(1_015_000); coordinator.step();
      expect(coordinator.status().attempts.filter(attempt => attempt.goal === 'kernel')).toHaveLength(1);
      expect(coordinator.status().attempts.filter(attempt => attempt.goal === 'program')).toHaveLength(2);
      expect(admissions.at(-1)).toEqual(['kernel', f.otherDescriptor.home]);
    } finally { f.cleanup(); }
  });

  test('a Goal with a claimed live wrapper or child does not block another Goal wake', async () => {
    for (const identityColumn of ['wrapper', 'child']) {
      const f = fixture();
      let kernelEvents: WakeEvent[] = [];
      try {
        const coordinator = f.open({ events: goal => goal === 'kernel' ? kernelEvents
          : [{ key: 'exit:worker:1', body: 'Program worker completed' }] });
        coordinator.enroll(f.descriptor); coordinator.enroll(f.otherDescriptor); coordinator.step();
        const program = coordinator.status().attempts[0]!;
        coordinator.db.query(`UPDATE attempts SET phase='claimed',${identityColumn}=? WHERE token=?`)
          .run(JSON.stringify(processIdentity(process.pid)), program.token);
        f.launcher.running.clear();
        kernelEvents = [{ key: 'exit:worker:1', body: 'Kernel worker completed' }];
        coordinator.step(); coordinator.step();
        const kernel = coordinator.status().attempts.find(attempt => attempt.goal === 'kernel')!;
        expect(f.launcher.launches).toEqual([program.token, kernel.token]);
        await runAttempt(f.stateDir, kernel.token); coordinator.step(); coordinator.step();
        expect(coordinator.status().wakes.map(wake => wake.goal)).toEqual(['program']);
        expect(coordinator.status().attempts.find(attempt => attempt.goal === 'program'))
          .toMatchObject({ token: program.token, phase: 'claimed', code: null });
        expect(f.calls().map(call => call.goal)).toEqual(['kernel']);
      } finally { f.cleanup(); }
    }
  });

  test('intent survives a crash before launch and restart launches the same token once', async () => {
    const f = fixture();
    try {
      const first = f.open({ afterIntent: () => { throw new Error('injected coordinator crash'); } });
      first.enroll(f.descriptor);
      expect(() => first.step()).toThrow('injected coordinator crash');
      const token = first.status().attempts[0]!.token;
      expect(first.status().attempts[0]!.phase).toBe('intent');
      expect(f.launcher.launches).toEqual([]);
      first.close();
      const restarted = f.open();
      restarted.step(); restarted.step();
      expect(f.launcher.launches).toEqual([token]);
      await runAttempt(f.stateDir, token);
      restarted.step();
      expect(f.calls()).toHaveLength(1);
      expect(restarted.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('lost launch registration after a crash adopts the live token without duplicate resume', async () => {
    const f = fixture();
    try {
      const first = f.open({ afterLaunch: () => { throw new Error('launch response lost'); } });
      first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      expect(first.status().attempts[0]!.phase).toBe('intent');
      first.close();
      const restarted = f.open();
      f.setNow(1_030_000);
      restarted.step(); restarted.step();
      expect(f.launcher.launches).toEqual([token]);
      await Promise.all([runAttempt(f.stateDir, token), runAttempt(f.stateDir, token)]);
      expect(f.calls()).toHaveLength(1);
      restarted.step();
      expect(restarted.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('a claimed live wrapper or child blocks another resume even if its tmux session is gone', () => {
    for (const identityColumn of ['wrapper', 'child']) {
      const f = fixture();
      try {
        const first = f.open(); first.enroll(f.descriptor); first.step();
        const token = first.status().attempts[0]!.token;
        first.db.query(`UPDATE attempts SET phase='claimed',${identityColumn}=? WHERE token=?`)
          .run(JSON.stringify(processIdentity(process.pid)), token);
        const failures = first.status().wakes[0]!.failures;
        f.launcher.running.clear(); first.close();
        const restarted = f.open(); restarted.step(); restarted.step();
        expect(f.launcher.launches).toEqual([token]);
        expect(restarted.status().wakes[0]!.failures).toBe(failures);
      } finally { f.cleanup(); }
    }
  });

  test('a vanished claimed attempt with a stale PID records a crash before retrying', () => {
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      const token = coordinator.status().attempts[0]!.token;
      coordinator.db.query("UPDATE attempts SET phase='claimed',wrapper=? WHERE token=?")
        .run(JSON.stringify({ ...processIdentity(process.pid), start: 'reused-pid' }), token);
      f.launcher.running.clear(); coordinator.step();
      expect(f.launcher.launches).toEqual([token]);
      expect(coordinator.status().attempts[0]).toMatchObject({phase:'done',ending:'crash',ended_at:1_000_000});
      expect(() => coordinator.unenroll('program')).toThrow('unresolved attempt');
    } finally { f.cleanup(); }
  });

  test('a claimed live tmux endpoint is adopted on restart despite stale process registration', () => {
    const f = fixture();
    try {
      const first = f.open(); first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      first.db.query("UPDATE attempts SET phase='claimed',wrapper=? WHERE token=?")
        .run(JSON.stringify({ ...processIdentity(process.pid), start: 'stale' }), token);
      const failures = first.status().wakes[0]!.failures;
      first.close();
      const restarted = f.open(); restarted.step(); restarted.step();
      expect(f.launcher.launches).toEqual([token]);
      expect(restarted.status().wakes[0]!.failures).toBe(failures);
      expect(restarted.status().attempts[0]!.phase).toBe('claimed');
    } finally { f.cleanup(); }
  });

  test('a future wake remains durable when its source disappears before restart', async () => {
    const f = fixture();
    try {
      f.setEvents([{ key: 'timer:due', body: 'Scheduled follow-up', dueAt: 1_010_000 }]);
      const first = f.open(); first.enroll(f.descriptor); first.step();
      expect(f.launcher.launches).toEqual([]);
      expect(first.status().wakes[0]!.due_at).toBe(1_010_000);
      first.close(); f.setEvents([]);
      const restarted = f.open(); f.setNow(1_009_999); restarted.step();
      expect(f.launcher.launches).toEqual([]);
      f.setNow(1_010_000); restarted.step();
      const token = restarted.status().attempts[0]!.token;
      await runAttempt(f.stateDir, token); restarted.step();
      expect(f.calls()[0].args).toContainEqual(expect.stringContaining('Scheduled follow-up'));
      expect(restarted.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('quota refusal persists exponential backoff without creating a launch token', () => {
    const f = fixture();
    let admitted = false;
    let admissions = 0;
    try {
      const coordinator = f.open({ admit: () => { admissions++; if (!admitted) throw new Error('account quota exhausted'); } });
      coordinator.enroll(f.descriptor); coordinator.step();
      expect(coordinator.status().wakes[0]).toMatchObject({ due_at: 1_005_000, failures: 1, token: null });
      f.setEvents([{ key: 'exit:worker:1', body: 'Worker completed' }, { key: 'mail:new', body: 'New urgent request' }]);
      coordinator.step(); expect(admissions).toBe(1);
      f.setNow(1_005_000); coordinator.step();
      expect(coordinator.status().wakes[0]).toMatchObject({ due_at: 1_015_000, failures: 2 });
      expect(coordinator.status().attempts).toEqual([]);
      admitted = true; f.setNow(1_015_000); coordinator.step();
      expect(f.launcher.launches).toHaveLength(1);
      expect(admissions).toBe(3);
    } finally { f.cleanup(); }
  });

  test('newly due mail advances a future timer', () => {
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor);
      f.setEvents([{ key: 'timer:tomorrow', body: 'Future follow-up', dueAt: 2_000_000 }]);
      coordinator.step(); expect(f.launcher.launches).toEqual([]);
      f.setEvents([{ key: 'timer:tomorrow', body: 'Future follow-up', dueAt: 2_000_000 },
        { key: 'mail:due-now', body: 'New request now' }]);
      coordinator.step();
      expect(f.launcher.launches).toHaveLength(1);
      expect(coordinator.status().attempts[0]!.prompt).toContain('New request now');
      expect(coordinator.status().attempts[0]!.prompt).not.toContain('Future follow-up');
    } finally { f.cleanup(); }
  });

  test('a launcher that exits before wrapper registration cannot create a resume storm across restart', () => {
    const f = fixture();
    const launches: string[] = [];
    const launcher: IndependentLauncher = { verify: () => {}, live: () => false, launch: token => { launches.push(token); } };
    try {
      const first = f.open({ launcher }); first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      expect(first.status().wakes[0]).toMatchObject({ due_at: 1_005_000, failures: 0 });
      first.step(); expect(launches).toEqual([token]); first.close();
      const restarted = f.open({ launcher });
      f.setEvents([{ key: 'exit:worker:1', body: 'Worker completed' }, { key: 'mail:while-registering', body: 'New request' }]);
      f.setNow(1_004_999); restarted.step(); expect(launches).toEqual([token]);
      f.setNow(1_005_000); restarted.step();
      expect(launches).toEqual([token, token]);
      expect(restarted.status().attempts).toHaveLength(1);
      expect(restarted.status().wakes[0]).toMatchObject({ due_at: 1_010_000, failures: 1 });
      restarted.step(); expect(launches).toEqual([token, token]);
      f.setNow(1_010_000); restarted.step();
      expect(launches).toEqual([token, token, token]);
      expect(restarted.status().wakes[0]).toMatchObject({ due_at: 1_020_000, failures: 2 });
    } finally { f.cleanup(); }
  });

  test('externally acknowledged queued mail cancels its pending wake during admission backoff', () => {
    const f = fixture();
    const mail = new GoalMailStore({ stateDir: f.stateDir, goals: ['program'],sender:'program' });
    try {
      const message = mail.send('program', 'Already received elsewhere', 'external-ack');
      const coordinator = f.open({ events: goal => mail.pending(goal).map(entry => ({ key: entry.id, body: entry.body })),
        admit: () => { throw new Error('quota'); } });
      coordinator.enroll(f.descriptor); coordinator.step();
      expect(coordinator.status().wakes).toHaveLength(1);
      mail.ack('program', message.id); coordinator.step();
      expect(coordinator.status().wakes).toEqual([]);
      expect(f.launcher.launches).toEqual([]);
    } finally { mail.close(); f.cleanup(); }
  });

  test('successful launch is not mail delivery; a lost ack response retries idempotently after restart', async () => {
    const f = fixture();
    const mail = new GoalMailStore({ stateDir: f.stateDir, goals: ['program', 'kernel'],sender:'program' });
    try {
      const message = mail.send(['program', 'kernel'], 'Sentinel request', 'sentinel');
      const events = (goal: string) => mail.pending(goal).map(entry => ({ key: entry.id, body: entry.body }));
      const first = f.open({ events }); first.enroll(f.descriptor); first.step();
      const token = first.status().attempts[0]!.token;
      await runAttempt(f.stateDir, token); first.step();
      expect(mail.pending('program')).toHaveLength(1);
      expect(first.status().wakes[0]!.error).toContain('pending events/acknowledgements');
      f.setNow(first.status().wakes[0]!.due_at); first.step();
      expect(f.launcher.launches).toHaveLength(2);
      const retryToken = first.status().attempts[1]!.token;
      const persistedAck = mail.ack('program', message.id);
      // Discard the response; the manager knows only the original message ID after restart.
      first.close();
      const reopenedMail = new GoalMailStore({ stateDir: f.stateDir, goals: ['program', 'kernel'] });
      try { expect(reopenedMail.ack('program', message.id)).toEqual(persistedAck); } finally { reopenedMail.close(); }
      const restarted = f.open({ events });
      await runAttempt(f.stateDir, retryToken); restarted.step(); restarted.step();
      expect(restarted.status().wakes).toEqual([]);
      expect(f.launcher.launches).toHaveLength(2);
      expect(mail.pending('kernel').map(entry => entry.id)).toEqual([message.id]);
    } finally { mail.close(); f.cleanup(); }
  });

  test('new events during a live turn are coalesced into one later turn', async () => {
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      const token = coordinator.status().attempts[0]!.token;
      f.setEvents([{ key: 'exit:worker:1', body: 'Worker completed' },
        { key: 'exit:worker:2', body: 'Second completed' }, { key: 'exit:worker:3', body: 'Third completed' }]);
      coordinator.step(); expect(f.launcher.launches).toHaveLength(1);
      await runAttempt(f.stateDir, token); coordinator.step();
      f.setNow(coordinator.status().wakes[0]!.due_at); coordinator.step();
      expect(f.launcher.launches).toHaveLength(2);
      const second = coordinator.status().attempts[1]!;
      expect(second.prompt).toContain('Second completed'); expect(second.prompt).not.toContain('Third completed');
      expect(second.prompt).not.toContain('exit:worker:1');
      await runAttempt(f.stateDir, second.token); coordinator.step(); coordinator.step();
      const third = coordinator.status().attempts[2]!;
      expect(third.prompt).toContain('Third completed');
      expect(third.prompt).not.toContain('Second completed');
      await runAttempt(f.stateDir,third.token); coordinator.step();
      expect(coordinator.status().wakes).toEqual([]);
      expect(f.calls()).toHaveLength(3);
    } finally { f.cleanup(); }
  });

  test('a failed synthetic manager retries after backoff and preserves engine launch arguments and account environment', async () => {
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll({ ...f.descriptor, env: { ...f.descriptor.env, EXIT_CODE: '7' } });
      coordinator.step(); const attempt = coordinator.status().attempts[0]!;
      await runAttempt(f.stateDir, attempt.token); coordinator.step();
      expect(coordinator.status().attempts[0]!.code).toBe(7);
      expect(coordinator.status().wakes[0]!.error).toContain('Manager exit 7');
      const call = f.calls()[0];
      expect(call).toMatchObject({ cwd: f.dir, home: f.descriptor.home, goal: 'program' });
      expect(call.args.slice(0, 4)).toEqual(['--model', 'gpt-6.1-sol', '--effort', 'high']);
      expect(call.args[4]).toContain(MANAGER_ROLE_CARD.replaceAll('<goal>','program'));
      expect(call.args[5]).toBe(join(f.stateDir, 'manager-runs', attempt.token, 'last.md'));
      coordinator.step(); expect(f.launcher.launches).toHaveLength(1);
      f.setNow(coordinator.status().wakes[0]!.due_at); coordinator.step();
      expect(f.launcher.launches).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  test('handover descriptor is immutable, native sessions are unique, and a live owner delays wake after enrollment', () => {
    const f = fixture();
    let owner: string | undefined;
    try {
      const coordinator = f.open({ owner: () => owner });
      owner = 'interactive process owns session';
      coordinator.enroll(f.descriptor);
      expect(coordinator.status().managers[0]!.ownership).toBe(owner);
      expect(() => coordinator.enroll({ ...f.descriptor, effort: 'medium' })).toThrow('immutable');
      expect(() => coordinator.enroll({ ...f.descriptor, goal: 'kernel' })).toThrow('already enrolled');
      owner = 'interactive process owns session'; coordinator.step();
      expect(f.launcher.launches).toEqual([]);
      expect(coordinator.status().wakes[0]!.error).toContain('interactive process');
      owner = undefined; f.setNow(coordinator.status().wakes[0]!.due_at);
      f.launcher.refusal = 'Independent tmux server generation changed'; coordinator.step();
      expect(f.launcher.launches).toEqual([]);
      expect(coordinator.status().wakes[0]!.error).toContain('generation changed');
    } finally { f.cleanup(); }
  });

  test('singleton excludes another pump, survives close, and a reused PID does not retain ownership', () => {
    const f = fixture();
    try {
      const first = f.open(); first.acquire();
      const second = f.open(); expect(() => second.acquire()).toThrow('already running');
      first.close(); expect(() => second.acquire()).toThrow('already running');
      second.db.query('UPDATE pump_owner SET identity=?').run(JSON.stringify({ ...processIdentity(process.pid), start: 'stale' }));
      second.acquire(); second.release();
      const third = f.open(); third.acquire(); third.release();
      expect(sameProcess({ ...processIdentity(process.pid)!, start: 'stale' })).toBe(false);
      expect(processIdentity(2_147_483_647)).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('workers that inherited the manager session variables do not own it; the manager and its tools do', () => {
    const f = fixture();
    try {
      const session = f.descriptor.session;
      const inherited = [`CODEX_SESSION_ID=${session}`, `CODEX_THREAD_ID=${session}`];
      const owner = () => nativeOwner(f.descriptor.home, session, undefined, f.procRoot);
      // A worker on its own session, and the code-mode host it spawned (real shapes on 2026-10-07).
      f.process(130, ['codex', 'exec', 'resume', '01a115d3-5933-78b0-b728-52d3b04a2b3b', '-m', 'gpt-6.1-sol'], inherited);
      f.process(131, ['/home/edge/.codex/packages/standalone/bin/codex-code-mode-host'], inherited, '100', 'S', 130);
      expect(owner()).toBeUndefined();
      // A tool of the manager's own interactive session still owns it.
      f.process(132, ['/bin/bash', 'next-event.sh'], inherited);
      expect(owner()).toContain('process 132 (environment)');
      rmSync(join(f.procRoot, '132'), { recursive: true });
      // A headless resume of this very session is the manager; its tools own the session too.
      f.process(133, ['codex', 'exec', 'resume', session], inherited);
      f.process(134, ['/bin/bash', 'next-event.sh'], inherited, '100', 'S', 133);
      expect(owner()).toContain('process 133 (resume)');
      rmSync(join(f.procRoot, '133'), { recursive: true });
      expect(owner()).toContain('process 134 (environment)');
    } finally { f.cleanup(); }
  });

  test('named previous owner enrolls while alive; status and first wake wait until its exact process exits', () => {
    const f = fixture();
    try {
      const previousOwner = f.process(123, ['codex']);
      const coordinator = f.open({ owner: (home, session, prior) => nativeOwner(home, session, prior, f.procRoot) });
      coordinator.enroll({ ...f.descriptor, previousOwner });
      expect(coordinator.status().managers[0]).toMatchObject({ previousOwner, ownership: 'waiting for previous owner 123' });
      coordinator.step();
      expect(coordinator.status().wakes[0]!.error).toContain('waiting for previous owner 123');
      expect(coordinator.status().attempts).toEqual([]);
      coordinator.close();
      const restarted = f.open({ owner: (home, session, prior) => nativeOwner(home, session, prior, f.procRoot) });
      expect(restarted.status().managers[0]!.ownership).toBe('waiting for previous owner 123');
      f.process(124, ['/bin/bash', 'next-event.sh'], [`CODEX_THREAD_ID=${f.descriptor.session}`]);
      rmSync(join(f.procRoot, '123'), { recursive: true });
      expect(restarted.status().managers[0]!.ownership).toContain('process 124 (environment)');
      f.setNow(restarted.status().wakes[0]!.due_at); restarted.step();
      expect(f.launcher.launches).toEqual([]);
      rmSync(join(f.procRoot, '124'), { recursive: true });
      expect(restarted.status().managers[0]!.ownership).toBeNull();
      f.setNow(restarted.status().wakes[0]!.due_at); restarted.step();
      expect(f.launcher.launches).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('the independent attempt rechecks the named owner before spawning the manager', async () => {
    const f = fixture();
    try {
      const coordinator = f.open();
      coordinator.enroll({ ...f.descriptor, previousOwner: processIdentity(process.pid)! });
      coordinator.step();
      await runAttempt(f.stateDir, coordinator.status().attempts[0]!.token);
      expect(coordinator.status().attempts[0]).toMatchObject({ phase: 'done', code: 127, ending:'crash' });
      expect(f.calls()).toEqual([]);
      expect(readFileSync(join(f.stateDir, 'manager-runs', coordinator.status().attempts[0]!.token, 'stderr.log'), 'utf8'))
        .toContain(`waiting for previous owner ${process.pid}`);
    } finally { f.cleanup(); }
  });

  test('a reused PID, another boot, or a zombie does not retain previous ownership', () => {
    const f = fixture();
    try {
      const previousOwner = f.process(123, ['codex']);
      expect(nativeOwner(f.descriptor.home, f.descriptor.session, previousOwner, f.procRoot)).toBe('waiting for previous owner 123');
      f.process(123, ['codex'], [], '101');
      expect(nativeOwner(f.descriptor.home, f.descriptor.session, previousOwner, f.procRoot)).toBeUndefined();
      f.process(123, ['codex']);
      writeFileSync(join(f.procRoot, 'sys/kernel/random/boot_id'), 'another-boot');
      expect(nativeOwner(f.descriptor.home, f.descriptor.session, previousOwner, f.procRoot)).toBeUndefined();
      writeFileSync(join(f.procRoot, 'sys/kernel/random/boot_id'), 'test-boot');
      f.process(123, ['codex'], [], '100', 'Z');
      expect(nativeOwner(f.descriptor.home, f.descriptor.session, previousOwner, f.procRoot)).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('only a resume naming the exact session owns it, including flags before the UUID', () => {
    const f = fixture();
    try {
      for (const args of [['codex', 'resume', f.descriptor.session],
        ['codex', 'exec', 'resume', '--model', 'gpt-6.1-sol', f.descriptor.session]]) {
        f.process(123, args);
        expect(nativeOwner(f.descriptor.home, f.descriptor.session, undefined, f.procRoot)).toContain('process 123 (resume)');
      }
      for (const args of [['codex', 'resume', 'other-session'], ['codex', 'exec', 'resume', '--last'],
        ['codex', '--profile', 'exec'], ['codex', 'exec', f.descriptor.session]]) {
        f.process(123, args);
        expect(nativeOwner(f.descriptor.home, f.descriptor.session, undefined, f.procRoot)).toBeUndefined();
      }
    } finally { f.cleanup(); }
  });

  test('a tool owns the session by either exact native environment ID, independent of executable and account home', () => {
    const f = fixture();
    try {
      for (const key of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID']) {
        f.process(123, ['/bin/bash', 'next-event.sh'], [`${key}=${f.descriptor.session}`]);
        expect(nativeOwner(f.descriptor.home, f.descriptor.session, undefined, f.procRoot)).toContain('process 123 (environment)');
        rmSync(join(f.procRoot, '123/cmdline'));
        expect(nativeOwner(f.descriptor.home, f.descriptor.session, undefined, f.procRoot)).toContain('process 123 (environment)');
        f.process(123, ['/bin/bash', 'next-event.sh'], [`${key}=${f.descriptor.session}-other`]);
        expect(nativeOwner(f.descriptor.home, f.descriptor.session, undefined, f.procRoot)).toBeUndefined();
      }
    } finally { f.cleanup(); }
  });

  test('account app-server, exec-server, ChatGPT bundled processes and unreadable unrelated environments do not own a session', () => {
    const f = fixture();
    try {
      for (const [index, args] of [['codex', 'app-server', 'daemon'], ['codex', 'exec-server', '--remote'],
        ['/usr/lib/chatgpt/resources/codex', 'app-server'], ['/usr/lib/chatgpt/resources/codex', 'exec-server', '--remote']].entries()) {
        f.process(100 + index, args, [`CODEX_HOME=${f.descriptor.home}`]);
      }
      f.process(123, ['codex', 'app-server']); rmSync(join(f.procRoot, '123/environ'));
      expect(nativeOwner(f.descriptor.home, f.descriptor.session, undefined, f.procRoot)).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('native session handover validates exact session, account and working directory metadata', () => {
    const f = fixture();
    try {
      const session = '11111111-1111-4111-8111-111111111111';
      const sessions = join(f.descriptor.home, 'sessions', '2026'); mkdirSync(sessions, { recursive: true });
      const path = join(sessions, `rollout-test-${session}.jsonl`);
      const meta = { type: 'session_meta', payload: { id: session, cwd: f.dir } };
      writeFileSync(path, `${JSON.stringify(meta)}\n`);
      expect(() => nativeSession(f.descriptor.home, session, f.dir)).not.toThrow();
      expect(() => nativeSession(f.descriptor.home, 'approximate', f.dir)).toThrow('exact native session');
      expect(() => nativeSession(join(f.dir, 'missing-home'), session, f.dir)).toThrow();
      writeFileSync(path, `${JSON.stringify({ ...meta, payload: { id: session, cwd: f.stateDir } })}\n`);
      mkdirSync(f.stateDir); expect(() => nativeSession(f.descriptor.home, session, f.dir)).toThrow('does not match');
      writeFileSync(path, `${JSON.stringify(meta)}\n`);
      writeFileSync(join(sessions, `rollout-other-${session}.jsonl`), `${JSON.stringify(meta)}\n`);
      expect(() => nativeSession(f.descriptor.home, session, f.dir)).toThrow('not uniquely present');
    } finally { f.cleanup(); }
  });

  test('claude wake argv resumes the enrolled session with its model and effort', async () => {
    const f = fixture();
    const session = '33333333-3333-4333-8333-333333333333';
    const model = 'claude-opus-5-5';
    try {
      expect(claudeWakeArgs(session, model, 'xhigh')).toEqual(['-p', '--resume', session, '--model', model,
        '--effort', 'xhigh', '--dangerously-skip-permissions', '--output-format', 'json', '--', WAKE_PROMPT]);
      const coordinator = f.open();
      coordinator.enroll({ ...f.descriptor, engine: 'claude', session, effort: 'xhigh',
        args: [join(f.dir, 'manager.ts'), ...claudeWakeArgs(session, model, 'xhigh')] });
      coordinator.step();
      const attempt = coordinator.status().attempts[0]!;
      expect(attempt.prompt).toContain('end the turn when the event is decided');
      expect(attempt.prompt).toContain('Start no watcher');
      expect(attempt.prompt).toContain('Worker completed');
      await runAttempt(f.stateDir, attempt.token);
      expect(f.calls()[0].args).toEqual(['-p', '--model', model, '--effort', 'xhigh',
        '--dangerously-skip-permissions', '--output-format', 'json', '--session-id', JSON.parse(attempt.descriptor).session, '--', attempt.prompt]);
      expect(f.calls()[0].cwd).toBe(f.dir);
    } finally { f.cleanup(); }
  });

  test('a live claude owner blocks the wake and an inherited worker does not', () => {
    const f = fixture();
    const session = '44444444-4444-4444-8444-444444444444';
    const owner = (home: string, id: string, prior?: LaunchDescriptor['previousOwner']) =>
      nativeOwner(home, id, prior, f.procRoot, 'claude');
    try {
      f.process(300, ['/home/edge/.local/bin/claude', '--model', 'claude-opus-5-5']);
      f.process(301, ['/usr/bin/zsh', '-c', 'watch'], [`CLAUDE_CODE_SESSION_ID=${session}`], '100', 'S', 300);
      expect(owner(f.descriptor.home, session)).toContain('process 300 (environment)');
      f.process(302, ['claude', '-p', '--resume', session, '--model', 'claude-opus-5-5']);
      expect(owner(f.descriptor.home, session)).toContain('process 302 (resume)');
      const coordinator = f.open({ owner });
      coordinator.enroll({ ...f.descriptor, engine: 'claude', session,
        args: [join(f.dir, 'manager.ts'), ...claudeWakeArgs(session, 'claude-opus-5-5', 'high')] });
      coordinator.step();
      expect(f.launcher.launches).toEqual([]);
      expect(coordinator.status().wakes[0]!.error).toContain('process 302 (resume)');
      for (const pid of [300, 301, 302]) rmSync(join(f.procRoot, String(pid)), { recursive: true });
      f.process(310, ['claude', '-p', '--resume', session], [`CLAUDE_CODE_SESSION_ID=${session}`, 'GOAL_TASK_ID=G-9']);
      f.process(311, ['/bin/zsh', '-c', 'worker'], [`CLAUDE_CODE_SESSION_ID=${session}`, 'GOAL_TASK_ID=G-9'], '100', 'S', 310);
      f.process(312, ['sleep', '30'], [`CLAUDE_CODE_SESSION_ID=${session}`], '100', 'S', 311);
      f.process(320, ['tmux', 'server'], [`CLAUDE_CODE_SESSION_ID=${session}`]);
      f.process(321, ['/bin/zsh'], [`CLAUDE_CODE_SESSION_ID=${session}`], '100', 'S', 320);
      expect(owner(f.descriptor.home, session)).toBeUndefined();
      f.setNow(coordinator.status().wakes[0]!.due_at);
      coordinator.step();
      expect(f.launcher.launches).toHaveLength(1);
    } finally { f.cleanup(); }
  });

  test('a coordinator restart after the claude intent is recorded launches that token once', async () => {
    const f = fixture();
    const session = '55555555-5555-4555-8555-555555555555';
    try {
      const first = f.open({ afterIntent: () => { throw new Error('injected coordinator crash'); } });
      first.enroll({ ...f.descriptor, engine: 'claude', session,
        args: [join(f.dir, 'manager.ts'), ...claudeWakeArgs(session, 'claude-sonnet-5-5', 'high')] });
      expect(() => first.step()).toThrow('injected coordinator crash');
      const token = first.status().attempts[0]!.token;
      expect(first.status().attempts[0]!.phase).toBe('intent');
      expect(f.launcher.launches).toEqual([]);
      first.close();
      const restarted = f.open();
      restarted.step(); restarted.step();
      expect(f.launcher.launches).toEqual([token]);
      expect(restarted.status().attempts).toHaveLength(1);
      await runAttempt(f.stateDir, token);
      restarted.step();
      expect(f.calls()).toHaveLength(1);
      expect(restarted.status().wakes).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('claude session handover reads the project transcript for the canonical working directory', () => {
    const f = fixture();
    const session = '66666666-6666-4666-8666-666666666666';
    const home = join(f.dir, 'claude-home');
    try {
      expect(claudeProjectKey('/home/edge/projects/rezics/rezics-next/.temp')).toBe('-home-edge-projects-rezics-rezics-next--temp');
      const long = `/${'Abc'.repeat(80)}`;
      expect(claudeProjectKey(long)).toBe(`${'-'.concat('Abc'.repeat(80)).slice(0, 200)}-bjox0v`);
      const directory = realpathSync(f.dir);
      const file = join(home, 'projects', claudeProjectKey(directory), `${session}.jsonl`);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ type: 'mode', sessionId: session })}\n`
        + `${JSON.stringify({ type: 'user', cwd: directory, sessionId: session })}\n`);
      expect(() => claudeNativeSession(home, session, f.dir)).not.toThrow();
      expect(() => claudeNativeSession(home, 'approximate', f.dir)).toThrow('exact native session');
      writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: f.stateDir, sessionId: session })}\n`);
      mkdirSync(f.stateDir);
      expect(() => claudeNativeSession(home, session, f.dir)).toThrow('does not match');
      writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: directory, sessionId: '77777777-7777-4777-8777-777777777777' })}\n`);
      expect(() => claudeNativeSession(home, session, f.dir)).toThrow('does not match');
    } finally { f.cleanup(); }
  });
});

const independentServerAvailable = spawnSync('systemctl',['--user','show-environment'],{stdio:'ignore'}).status === 0;
function tmuxFixture(independent = true) {
  const f = fixture();
  const prior = {...process.env};
  const socketDirectory = mkdtempSync('/tmp/goal-turn-');
  const socket = join(socketDirectory,'s');
  const unit = `goal-turn-test-${crypto.randomUUID()}`;
  process.env.GOAL_TERMSPACES_SOCKET = socket;
  process.env.GOAL_TERMSPACES_SESSION = 'test-agents';
  const args = ['tmux','-S',socket,'new-session','-d','-s','test-agents','-n','maintainer','sleep 300'];
  const started = independent
    ? spawnSync('systemd-run',['--user',`--unit=${unit}`,'--property=Type=forking',...args],{encoding:'utf8'})
    : spawnSync(args[0]!,args.slice(1),{encoding:'utf8'});
  expect(started.status,started.stderr).toBe(0);
  // The service starts asynchronously; each test owns this socket and unit.
  let server: ReturnType<typeof tmuxServer> | undefined;
  for (let attempt = 0; attempt < 100 && !server; attempt++) {
    try { server = tmuxServer(socket); }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }
  }
  expect(server).toBeDefined();
  spawnSync('tmux',['-S',socket,'set-option','-t','test-agents','remain-on-exit','on']);
  for (const [key,value] of Object.entries({GOAL_TERMSPACES_SOCKET:socket,GOAL_TERMSPACES_SESSION:'test-agents'})) {
    spawnSync('tmux',['-S',socket,'set-environment','-g',key,value]);
  }
  return {...f,socket,server:server!,cleanup() {
    spawnSync('tmux',['-S',socket,'kill-server'],{stdio:'ignore'});
    if (independent) spawnSync('systemctl',['--user','stop',unit],{stdio:'ignore'});
    process.env = prior; f.cleanup(); rmSync(socketDirectory,{recursive:true,force:true});
  }};
}

describe('independent tmux launcher', () => {
  test.skipIf(!independentServerAvailable)('a turn runs in its named window and is recovered after a coordinator restart', async () => {
    const f = tmuxFixture();
    try {
      const ready = join(f.dir,'ready'), release = join(f.dir,'release');
      const manager = join(f.dir,'live-turn.ts');
      writeFileSync(manager,`import { existsSync, writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(ready)},String(process.pid));
        console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Reviewing the event'}}));
        while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
        console.log(JSON.stringify({type:'result',result:'Decided'}));`);
      const launcher = new TmuxLauncher(f.stateDir);
      const first = f.open({launcher});
      // The launch ignores both the caller's and the enrolled server.
      first.enroll({...f.descriptor,args:[manager,WAKE_PROMPT,WAKE_LAST_MESSAGE],socket:'/old/server'});
      first.step();
      await waitFor(()=>existsSync(ready));
      const turn = windowTurns(f.stateDir)[0]!;
      expect(goalWindows(termspacesSession()!).map(window=>window.name)).toEqual([turnWindowName(turn)]);
      expect(launcher.live(turn.token,f.descriptor)).toBe(true);
      const native = processIdentity(Number(readFileSync(ready,'utf8')))!;
      first.close();
      const restarted = f.open({launcher}); restarted.step();
      expect(restarted.status().attempts).toHaveLength(1);
      expect(sameProcess(native)).toBe(true);
      // Closing the view must not turn a successful native result into a lost-wrapper crash.
      expect(reconcileWindows(f.stateDir,{tasks:{}},true).removed).toEqual([turnWindowName(turn)]);
      expect(sameProcess(native)).toBe(true);
      expect(reconcileWindows(f.stateDir,{tasks:{}}).made).toEqual([turnWindowName(turn)]);
      restarted.step();
      expect(restarted.status().attempts).toHaveLength(1);
      writeFileSync(release,'finish');
      await waitFor(()=>windowTurns(f.stateDir)[0]!.phase === 'done');
      expect(windowTurns(f.stateDir)[0]!.code).toBe(0);
      // The launcher's completion cleanup can remove the view before reconciliation.
      expect(reconcileWindows(f.stateDir,{tasks:{}}).error).toBeUndefined();
      expect(goalWindows(termspacesSession()!).map(window=>window.name)).not.toContain(turnWindowName(turn));
      expect(readFileSync(join(f.stateDir,'manager-runs',turn.token,'output.jsonl'),'utf8')).toContain('Decided');
    } finally { f.cleanup(); }
  },15_000);
  test.skipIf(!independentServerAvailable)('commands verify against the recorded live pump cgroup across tmux session scopes', async () => {
    const f = tmuxFixture(); const {socket,server:independentServer} = f;
    const name = `manager-start-check-${crypto.randomUUID()}`;
    try {
      const coordinator = f.open(); coordinator.acquire();
      const descriptor = {...f.descriptor,socket,server:independentServer};
      const output = join(f.dir,'verified.json');
      const script = join(f.dir,'verify.ts');
      writeFileSync(script, `import { writeFileSync } from 'node:fs';
        import { TmuxLauncher, processIdentity } from ${JSON.stringify(join(import.meta.dir,'coordinator.ts'))};
        let error = null;
        try { new TmuxLauncher(${JSON.stringify(f.stateDir)}).verify(${JSON.stringify(descriptor)}); }
        catch (cause) { error = String(cause); }
        writeFileSync(${JSON.stringify(output)},JSON.stringify({error,identity:processIdentity(process.pid)}));`);
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const result = spawnSync('tmux',['-S',socket,'new-session','-d','-s',name,
        [process.execPath,script].map(quote).join(' ')],{encoding:'utf8'});
      expect(result.status,result.stderr).toBe(0);
      await waitFor(()=>existsSync(output));
      expect(JSON.parse(readFileSync(output,'utf8')).error).toBeNull();
      // The server can spawn into a fresh scope. A caller's different cgroup must not hide
      // a live pump that was started in the server's own cgroup.
      coordinator.db.query('UPDATE pump_owner SET identity=?').run(JSON.stringify(independentServer));
      rmSync(output);
      const second = spawnSync('tmux',['-S',socket,'new-session','-d','-s',`${name}-refusal`,
        [process.execPath,script].map(quote).join(' ')],{encoding:'utf8'});
      expect(second.status,second.stderr).toBe(0);
      await waitFor(()=>existsSync(output));
      expect(JSON.parse(readFileSync(output,'utf8')).error).toContain('outside the coordinator cgroup');
      coordinator.release();
    } finally {
      spawnSync('tmux',['-S',socket,'kill-session','-t',name],{stdio:'ignore'}); f.cleanup();
      spawnSync('tmux',['-S',socket,'kill-session','-t',`${name}-refusal`],{stdio:'ignore'});
    }
  });
  test.skipIf(!independentServerAvailable)('start CLI registers headless managers and wakes their exact native sessions for all engines', async () => {
    const f = tmuxFixture(); const {socket} = f;
    const tokens: string[] = [];
    let pump: ChildProcess | undefined;
    let pumpErrors = '';
    const waitForPump = async (coordinator: GoalCoordinator, predicate: () => boolean, label: string) => {
      try {
        // A pump failure must not masquerade as a synthetic startup timeout.
        await waitFor(() => {
          if (pump && (pump.exitCode !== null || pump.signalCode !== null)) throw new Error('Coordinator pump exited');
          return predicate();
        });
      } catch (error) {
        const state = {
          pump: {code:pump?.exitCode,signal:pump?.signalCode,stderr:pumpErrors},
          admissions:coordinator.db.query('SELECT goal,error FROM admissions').all(),
          events:coordinator.db.query('SELECT goal,event_key,error FROM events').all(),
          turns:coordinator.db.query('SELECT goal,phase,code FROM attempts').all(),
        };
        throw new Error(`${label}: ${String(error)}\n${JSON.stringify(state)}`);
      }
    };
    try {
      const repository = join(f.dir,'repository');
      mkdirSync(repository);
      expect(spawnSync('git',['init','-b','main',repository],{encoding:'utf8'}).status).toBe(0);
      // The live pump settles against a committed Main snapshot before waking managers.
      expect(spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
        'commit','--allow-empty','-m','fixture'],{cwd:repository,encoding:'utf8'}).status).toBe(0);
      const bin = join(f.dir,'bin'); mkdirSync(bin);
      const agent = `#!${process.execPath}
        import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const args = process.argv.slice(2);
        const claude = process.argv[1].endsWith('/claude');
        const resume = claude ? args.includes('--resume') : args[1] === 'resume';
        const session = claude ? args[args.indexOf(resume ? '--resume' : '--session-id') + 1]
          : resume ? args[2] : crypto.randomUUID();
        const home = claude ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
        const directory = claude ? join(home,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-')) : join(home,'sessions');
        mkdirSync(directory,{recursive:true});
        if (!resume) writeFileSync(join(directory,(claude ? '' : 'rollout-') + session + '.jsonl'),
          JSON.stringify(claude ? {sessionId:session,cwd:process.cwd()} : {type:'session_meta',payload:{id:session,cwd:process.cwd()}}) + '\\n');
        appendFileSync(join(process.cwd(),'.temp','calls.jsonl'),JSON.stringify({args,session,resume,home,
          goal:process.env.GOAL_ID,manager:process.env.GOAL_MANAGER,
          ledger:JSON.parse(readFileSync(join(process.cwd(),'.temp','goal-orchestration','ledger.json'),'utf8'))}) + '\\n');
        console.log(JSON.stringify(claude ? {session_id:session,result:'Ready'} : {type:'thread.started',thread_id:session}));`;
      for (const engine of ['codex','claude']) {
        writeFileSync(join(bin,engine),agent); chmodSync(join(bin,engine),0o755);
      }
      const homes = {codex:join(f.dir,'first-account'),'sample-b':join(f.dir,'second-account'),claude:join(f.dir,'claude-account')};
      for (const home of Object.values(homes)) mkdirSync(home);
      const env: NodeJS.ProcessEnv = {...process.env,PATH:`${bin}:${process.env.PATH}`,GOAL_TERMSPACES_SOCKET:socket,
        GOAL_SETTINGS_DIRECTORY:testAccountSettings(repository,[
          {engine:'codex',home:homes.codex},{engine:'sample-b',home:homes['sample-b']},
        ]),CLAUDE_CONFIG_DIR:homes.claude,
        GOAL_MEMORY_FLOOR_GIB:'0'};
      delete env.GOAL_MAIL_STATE_DIR;
      const invoke = (args: string[]) => spawnSync(process.execPath,[join(import.meta.dir,'goalctl.ts'),'coordinator',...args],
        {cwd:repository,env,encoding:'utf8',timeout:15_000});
      const directory = join(repository,'.temp','goal-orchestration');
      const pumpState = new GoalCoordinator({stateDir:directory,events:()=>[],admit:()=>{}});
      try {
        // Start before any Goal exists: the pump must discover registrations added while it runs.
        pump = spawn(process.execPath,[join(import.meta.dir,'goalctl.ts'),'coordinator','--interval-ms','100'],
          {cwd:repository,env,stdio:['ignore','ignore','pipe']});
        pump.stderr!.on('data',chunk=>{ pumpErrors = (pumpErrors + String(chunk)).slice(-8_000); });
        await waitForPump(pumpState,()=>Boolean(pumpState.db.query('SELECT identity FROM pump_owner').get()),'Pump registration');
      } finally { pumpState.close(); }
      for (const engine of ['codex','sample-b','claude'] as const) {
        const goal = `manager-${engine}`;
        mkdirSync(join(repository,'docs','goals',goal),{recursive:true});
        writeFileSync(join(repository,'docs','goals',goal,'GOAL.md'),`---\nareas: []\n---\n# Synthetic Goal\n`);
        writeFileSync(join(repository,'docs','goals',goal,'state.md'),'Ready\n');
        const result = invoke(['start',goal,'--engine',engine,'--effort','high','--model','chosen-model']);
        expect(result.status,result.stderr).toBe(0);
        const coordinator = new GoalCoordinator({stateDir:directory,events:()=>[],admit:()=>{}});
        try {
          // Completion polling needs durable turn records, not repeated host-wide session-owner scans.
          await waitForPump(coordinator,()=>coordinator.turns({goal}).turns.some(turn=>turn.phase === 'done'),`${goal} startup`);
          const first = coordinator.status().attempts.find(attempt=>attempt.goal === goal)!;
          tokens.push(first.token);
          expect(first.code,readFileSync(join(directory,'manager-runs',first.token,'stderr.log'),'utf8')).toBe(0);
          const descriptor = coordinator.status().managers.find(manager=>manager.goal === goal)!;
          expect(descriptor).toMatchObject({engine,effort:'high',home:homes[engine],env:{GOAL_ID:goal,GOAL_MANAGER:`goal-${goal}`}});
          expect(descriptor.previousOwner).toBeUndefined();
          expect(descriptor.startArgs).toBeDefined();
          expect(descriptor.args).toContain('chosen-model');
          const calls = readFileSync(join(repository,'.temp','calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
          const call = calls.find(call=>call.goal === goal);
          expect(call.resume).toBe(false);
          expect(call.ledger.goals[goal].manager).toBe(`goal-${goal}`);
          expect(call.args).toContain('chosen-model');
          expect(call.args.join('\n')).toContain(managerStartMessage(goal));
          expect(invoke(['start',goal,'--engine',engine,'--effort','high']).status).not.toBe(0);
          const mail = new GoalMailStore({stateDir:directory,goals:[goal],sender:goal});
          try {
            const message = mail.send(goal,'Next request',`request-${engine}`);
            await waitForPump(coordinator,()=>coordinator.turns({goal}).turns.filter(turn=>turn.phase === 'done').length >= 2,`${goal} mail wake`);
            mail.ack(goal,message.id);
            const second = coordinator.status().attempts.filter(attempt=>attempt.goal === goal)[1]!;
            tokens.push(second.token);
            expect(second.code).toBe(0);
            expect(JSON.parse(second.descriptor).session).not.toBe(call.session);
          } finally { mail.close(); }
        } finally { coordinator.close(); }
      }
    } finally {
      if (pump && pump.exitCode === null) {
        pump.kill('SIGTERM');
        await new Promise<void>(resolve=>pump!.once('exit',()=>resolve()));
      }
      f.cleanup();
    }
  },60_000);

  test.skipIf(!independentServerAvailable)('startup descriptors retain the selected account and model without inherited session ownership', () => {
    const f = tmuxFixture(); const {socket} = f;
    const prior = {...process.env};
    try {
      process.env.GOAL_CODEX_HOME = f.descriptor.home;
      process.env.CLAUDE_CONFIG_DIR = f.descriptor.home;
      for (const engine of ['codex','claude'] as const) {
        const descriptor = coordinatorStartDescriptor(coordinatorStartOptions(['program','--engine',engine,'--effort','high','--model','chosen-model']),f.dir,socket);
        expect(descriptor.args).toContain('chosen-model');
        expect(descriptor.startArgs).toContain('chosen-model');
        expect(descriptor.previousOwner).toBeUndefined();
        expect(descriptor.env.CODEX_SESSION_ID).toBeUndefined();
        expect(descriptor.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      }
    } finally { process.env = prior; f.cleanup(); }
  });
  test.skipIf(spawnSync('tmux', ['-V']).status !== 0)('refuses a server in the coordinator cgroup', () => {
    const f = tmuxFixture(false);
    const ownSocket = f.socket;
    try {
      const descriptor = { ...f.descriptor, socket: ownSocket, server: tmuxServer(ownSocket) };
      expect(descriptor.server.cgroup).toBe(processIdentity(process.pid)!.cgroup);
      expect(() => new TmuxLauncher(f.stateDir).verify(descriptor)).toThrow('outside the coordinator cgroup');
    } finally {
      spawnSync('tmux', ['-S', ownSocket, 'kill-server'], { stdio: 'ignore' }); f.cleanup();
    }
  });

  test.skipIf(!independentServerAvailable)('the termspaces server replaces the enrolled socket and stale server identity', () => {
    const f = tmuxFixture(); const {socket,server:independentServer} = f;
    try {
      const launcher = new TmuxLauncher(f.stateDir);
      const descriptor = { ...f.descriptor, socket, server: independentServer! };
      expect(() => launcher.verify(descriptor)).not.toThrow();
      expect(() => launcher.verify({ ...descriptor,socket:'/nonexistent/enrolled-server',
        server: { ...descriptor.server, start: 'reused-pid',cgroup:'0::/wrong-group' } })).not.toThrow();
    } finally { f.cleanup(); }
  });

  test.skipIf(!independentServerAvailable)('worker dispatched by an independent manager survives coordinator termination', async () => {
    const f = tmuxFixture(); const {socket,server:independentServer} = f;
    const workerName = `goal-test-worker-${process.pid}-${Date.now()}`;
    let pump: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const worker = join(f.dir, 'worker.ts');
      const ready = join(f.dir, 'worker-ready'); const release = join(f.dir, 'worker-release'); const done = join(f.dir, 'worker-done');
      writeFileSync(worker, `import { existsSync, writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(20);
        writeFileSync(${JSON.stringify(done)}, 'completed');`);
      const manager = join(f.dir, 'dispatch.ts');
      writeFileSync(manager, `import { spawnSync } from 'node:child_process';
        const result = spawnSync('tmux', ['-S', ${JSON.stringify(socket)}, 'new-session', '-d', '-s',
          ${JSON.stringify(workerName)}, '-c', ${JSON.stringify(f.dir)},
          ${JSON.stringify(`'${process.execPath}' '${worker}'`)}]);
        process.exit(result.status ?? 1);`);
      const launcher = new TmuxLauncher(f.stateDir);
      const enrolled = f.open({ launcher });
      enrolled.enroll({ ...f.descriptor, socket, server: independentServer!, args: [manager, WAKE_PROMPT, WAKE_LAST_MESSAGE] });
      enrolled.close();
      const pumpReady = join(f.dir, 'pump-ready');
      const source = join(f.dir, 'pump.ts');
      writeFileSync(source, `import { GoalCoordinator } from ${JSON.stringify(join(import.meta.dir, 'coordinator.ts'))};
        import { writeFileSync } from 'node:fs';
        const coordinator = new GoalCoordinator({ stateDir: ${JSON.stringify(f.stateDir)},
          events: () => [{ key: 'exit:dispatch', body: 'Dispatch synthetic worker' }], admit: () => {} });
        coordinator.acquire(); coordinator.step();
        writeFileSync(${JSON.stringify(pumpReady)}, coordinator.status().attempts[0]!.token);
        while (true) await Bun.sleep(100);`);
      pump = Bun.spawn([process.execPath, source], { stdout: 'ignore', stderr: 'pipe' });
      await waitFor(() => existsSync(pumpReady) && existsSync(ready), 10_000);
      const workerIdentity = processIdentity(Number(readFileSync(ready, 'utf8')))!;
      const pumpGroup = processIdentity(pump.pid)!.cgroup.split('\n').find(line => line.startsWith('0::'))!.slice(3);
      const workerGroup = workerIdentity.cgroup.split('\n').find(line => line.startsWith('0::'))!.slice(3);
      expect(workerGroup).not.toBe(pumpGroup);
      expect(workerGroup.startsWith(`${pumpGroup}/`)).toBe(false);
      pump.kill('SIGTERM'); await pump.exited;
      expect(sameProcess(workerIdentity)).toBe(true);
      expect(spawnSync('tmux', ['-S', socket, 'has-session', '-t', workerName]).status).toBe(0);
      const restarted = f.open({ launcher }); restarted.acquire(); restarted.step();
      expect(restarted.status().attempts).toHaveLength(1);
      restarted.release();
      writeFileSync(release, 'finish'); await waitFor(() => existsSync(done));
      expect(readFileSync(done, 'utf8')).toBe('completed');
    } finally {
      pump?.kill(); if (pump) await pump.exited;
      spawnSync('tmux', ['-S', socket, 'kill-session', '-t', workerName], { stdio: 'ignore' });
      f.cleanup();
    }
  }, 20_000);
});
