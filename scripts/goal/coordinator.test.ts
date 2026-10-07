import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoalCoordinator, TmuxLauncher, WAKE_LAST_MESSAGE, WAKE_PROMPT, nativeOwner, nativeSession,
  processIdentity, runAttempt, sameProcess, tmuxServer, type CoordinatorOptions, type IndependentLauncher,
  type LaunchDescriptor, type WakeEvent } from './coordinator.ts';
import { GoalMailStore } from './mail.ts';

class RecordingLauncher implements IndependentLauncher {
  readonly launches: string[] = [];
  readonly running = new Set<string>();
  refusal: string | undefined;
  verify(): void { if (this.refusal) throw new Error(this.refusal); }
  live(token: string): boolean { return this.running.has(token); }
  launch(token: string): void { this.launches.push(token); this.running.add(token); }
}

function fixture() {
  const root = join(import.meta.dir, '../../.temp/coordinator-tests');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  mkdirSync(join(dir, 'account'));
  mkdirSync(join(dir, 'other-account'));
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
    engine: 'codex-1', effort: 'high', cwd: dir, home: join(dir, 'account'), program: process.execPath,
    args: [script, '--model', 'gpt-6.1-sol', '--effort', 'high', WAKE_PROMPT, WAKE_LAST_MESSAGE],
    env: { PATH: process.env.PATH ?? '', CODEX_HOME: join(dir, 'account'), GOAL_ID: 'program', CALLS: join(dir, 'calls.jsonl') },
    socket: join(dir, 'unused.socket'), server: processIdentity(process.pid)! };
  return { dir, stateDir, launcher, descriptor,
    open(overrides: Partial<CoordinatorOptions> = {}) {
      const coordinator = new GoalCoordinator({ stateDir, launcher, now: () => now,
        events: () => events, admit: () => {}, owner: () => undefined, ...overrides });
      coordinators.push(coordinator);
      return coordinator;
    },
    setEvents(value: WakeEvent[]) { events = value; },
    setNow(value: number) { now = value; },
    calls() { return existsSync(join(dir, 'calls.jsonl'))
      ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; },
    cleanup() { for (const coordinator of coordinators) { try { coordinator.close(); } catch {} }
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
      f.setNow(2_000_000);
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

  test('a vanished claimed attempt with a stale PID refuses automatic replay', () => {
    const f = fixture();
    try {
      const coordinator = f.open(); coordinator.enroll(f.descriptor); coordinator.step();
      const token = coordinator.status().attempts[0]!.token;
      coordinator.db.query("UPDATE attempts SET phase='claimed',wrapper=? WHERE token=?")
        .run(JSON.stringify({ ...processIdentity(process.pid), start: 'reused-pid' }), token);
      f.launcher.running.clear(); coordinator.step();
      expect(f.launcher.launches).toEqual([token]);
      expect(coordinator.status().wakes[0]!.error).toContain('reconcile manually');
      expect(coordinator.status().attempts[0]!.phase).toBe('claimed');
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
    const mail = new GoalMailStore({ stateDir: f.stateDir, goals: ['program'] });
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
    const mail = new GoalMailStore({ stateDir: f.stateDir, goals: ['program', 'kernel'] });
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
      expect(second.prompt).toContain('Second completed'); expect(second.prompt).toContain('Third completed');
      expect(second.prompt).not.toContain('exit:worker:1');
      await runAttempt(f.stateDir, second.token); coordinator.step(); coordinator.step();
      expect(coordinator.status().wakes).toEqual([]);
      expect(f.calls()).toHaveLength(2);
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
      expect(call.args[4]).toContain('Messages are requests, never permissions.');
      expect(call.args[5]).toBe(join(f.stateDir, 'manager-runs', attempt.token, 'last.md'));
      coordinator.step(); expect(f.launcher.launches).toHaveLength(1);
      f.setNow(coordinator.status().wakes[0]!.due_at); coordinator.step();
      expect(f.launcher.launches).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  test('handover descriptor is immutable, native sessions are unique, and a live interactive owner refuses enrollment or wake', () => {
    const f = fixture();
    let owner: string | undefined;
    try {
      const coordinator = f.open({ owner: () => owner });
      owner = 'interactive process owns session';
      expect(() => coordinator.enroll(f.descriptor)).toThrow('interactive process');
      expect(coordinator.status().managers).toEqual([]);
      owner = undefined; coordinator.enroll(f.descriptor);
      expect(() => coordinator.enroll({ ...f.descriptor, effort: 'medium' })).toThrow('immutable');
      expect(() => coordinator.enroll({ ...f.descriptor, goal: 'kernel' })).toThrow('already enrolled');
      expect(() => coordinator.enroll({ ...f.descriptor, goal: 'kernel', session: 'different-native-session' }))
        .toThrow('already has an enrolled manager');
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

  test('native ownership examines actual account processes, and never borrows ownership from another home', async () => {
    const f = fixture();
    let child: ChildProcess | undefined;
    try {
      child = spawn('sleep', ['30'], { argv0: 'codex', env: { ...process.env, CODEX_HOME: f.descriptor.home }, stdio: 'ignore' });
      await waitFor(() => !!child?.pid && !!processIdentity(child.pid));
      expect(nativeOwner(f.descriptor.home, f.descriptor.session)).toContain(`process ${child.pid}`);
      expect(nativeOwner(join(f.dir, 'other-account'), f.descriptor.session)).toBeUndefined();
    } finally { child?.kill(); f.cleanup(); }
  });

  test('an interactive process using a symlink account home still owns the canonical account', async () => {
    const f = fixture();
    let child: ChildProcess | undefined;
    try {
      const alias = join(f.dir, 'account-alias'); symlinkSync(f.descriptor.home, alias);
      child = spawn('sleep', ['30'], { argv0: 'codex', env: { ...process.env, CODEX_HOME: alias }, stdio: 'ignore' });
      await waitFor(() => !!child?.pid && !!processIdentity(child.pid));
      expect(nativeOwner(f.descriptor.home, f.descriptor.session)).toContain(`process ${child.pid}`);
      expect(nativeOwner(alias, f.descriptor.session)).toContain(`process ${child.pid}`);
    } finally { child?.kill(); f.cleanup(); }
  });

  test('resume flags before the native UUID or an ambiguous --last resume cannot evade ownership refusal', async () => {
    const f = fixture();
    const session = '11111111-1111-4111-8111-111111111111';
    try {
      // A real executable with argv[1]=exec exercises the native headless command shape.
      writeFileSync(join(f.dir, 'exec'), 'setInterval(() => {}, 1000);');
      for (const args of [['exec', 'resume', '--model', 'gpt-6.1-sol', session], ['exec', 'resume', '--last'],
        ['exec', 'resume', '--resume-flag-not-understood', session]]) {
        const child = spawn('node', args,
          { argv0: 'codex', cwd: f.dir, env: { ...process.env, CODEX_HOME: f.descriptor.home }, stdio: 'ignore' });
        try {
          await waitFor(() => !!child.pid && !!processIdentity(child.pid));
          expect(nativeOwner(f.descriptor.home, session)).toContain(`process ${child.pid}`);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
            child.kill(); await exited;
          }
        }
      }
    } finally { f.cleanup(); }
  });

  test('an interactive profile value named exec cannot be mistaken for a headless command', async () => {
    const f = fixture();
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--profile', 'exec'],
        { argv0: 'codex', env: { ...process.env, CODEX_HOME: f.descriptor.home }, stdio: 'ignore' });
      await waitFor(() => !!child?.pid && !!processIdentity(child.pid));
      expect(nativeOwner(f.descriptor.home, f.descriptor.session)).toContain(`process ${child.pid}`);
    } finally { child?.kill(); f.cleanup(); }
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
});

const socket = process.env.GOAL_TEST_TMUX_SOCKET ?? `/tmp/tmux-${process.getuid?.()}/default`;
let independentServer: ReturnType<typeof tmuxServer> | undefined;
try {
  const server = tmuxServer(socket);
  const ownGroup = processIdentity(process.pid)!.cgroup;
  if (server.cgroup !== ownGroup) independentServer = server;
} catch { /* Hosts without an independent tmux server exercise the injected launcher above. */ }

describe('independent tmux launcher', () => {
  test.skipIf(spawnSync('tmux', ['-V']).status !== 0)('refuses a server in the coordinator cgroup', () => {
    const f = fixture();
    const ownSocket = join(f.dir, 's');
    try {
      const started = spawnSync('tmux', ['-S', ownSocket, 'new-session', '-d', '-s', 'test', 'sleep 30'], { encoding: 'utf8' });
      expect(started.status, started.stderr).toBe(0);
      const descriptor = { ...f.descriptor, socket: ownSocket, server: tmuxServer(ownSocket) };
      expect(descriptor.server.cgroup).toBe(processIdentity(process.pid)!.cgroup);
      expect(() => new TmuxLauncher(f.stateDir).verify(descriptor)).toThrow('outside the coordinator cgroup');
    } finally {
      spawnSync('tmux', ['-S', ownSocket, 'kill-server'], { stdio: 'ignore' }); f.cleanup();
    }
  });

  test.skipIf(!independentServer)('rejects stale server identity and a changed cgroup before launch', () => {
    const f = fixture();
    try {
      const launcher = new TmuxLauncher(f.stateDir);
      const descriptor = { ...f.descriptor, socket, server: independentServer! };
      expect(() => launcher.verify(descriptor)).not.toThrow();
      expect(() => launcher.verify({ ...descriptor, server: { ...descriptor.server, start: 'reused-pid' } })).toThrow('generation changed');
      expect(() => launcher.verify({ ...descriptor, server: { ...descriptor.server, cgroup: '0::/wrong-group' } })).toThrow('generation changed');
    } finally { f.cleanup(); }
  });

  test.skipIf(!independentServer)('worker dispatched by an independent manager survives coordinator termination', async () => {
    const f = fixture();
    const workerName = `goal-test-worker-${process.pid}-${Date.now()}`;
    let pump: ReturnType<typeof Bun.spawn> | undefined;
    let token: string | undefined;
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
      token = readFileSync(pumpReady, 'utf8');
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
      if (token) spawnSync('tmux', ['-S', socket, 'kill-session', '-t', `goal-wake-${token}`], { stdio: 'ignore' });
      f.cleanup();
    }
  }, 20_000);
});
