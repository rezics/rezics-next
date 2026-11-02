import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureHostRunning,
  recordHostLiveness,
  startHostSupervisor,
  superviseHost,
  supervisorLeasePath,
  type HostLivenessConfig,
} from './host-liveness.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { temporaryDirectory } from './test-support.ts';

const runtime = join(import.meta.dir, 'fixtures/cli-runtime.ts');
const liveness = join(import.meta.dir, 'host-liveness.ts');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await pause(20);
  expect(predicate()).toBe(true);
}
function leaseIdentity(path: string): ProcessIdentity | undefined {
  try {
    const file = readdirSync(path).find((file) => file.endsWith('.json'));
    return file ? JSON.parse(readFileSync(join(path, file), 'utf8')) : undefined;
  } catch {
    return undefined;
  }
}
function stop(identity: ProcessIdentity | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (identity && sameProcess(identity)) process.kill(identity.pid, signal);
}
async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

test('an independent owned supervisor detects host exit, restarts once, and fences duplicate supervisors and launchers', async () => {
  const dir = temporaryDirectory();
  const config: HostLivenessConfig = {
    stateDirectory: dir.path,
    managerSocket: join(dir.path, 'manager.sock'),
    mainCheckout: dir.path,
    command: [process.execPath, runtime],
    pollMs: 20,
    minBackoffMs: 40,
    maxBackoffMs: 160,
  };
  // The real CLI fixture reads these two paths; spawned children inherit this test's environment.
  const previous = { state: process.env.FAKE_GOAL_STATE, main: process.env.FAKE_GOAL_MAIN };
  process.env.FAKE_GOAL_STATE = dir.path;
  process.env.FAKE_GOAL_MAIN = dir.path;
  let duplicate: ChildProcess | undefined;
  try {
    await Promise.all([ensureHostRunning(config), ensureHostRunning(config)]);
    await startHostSupervisor(config);
    await until(() => !!leaseIdentity(supervisorLeasePath(dir.path)));
    const supervisor = leaseIdentity(supervisorLeasePath(dir.path))!;
    const original = leaseIdentity(`${config.managerSocket}.lease`)!;
    expect(sameProcess(original)).toBe(true);
    duplicate = spawn(process.execPath, [liveness, JSON.stringify(config)], { stdio: 'ignore' });
    const duplicateExit = new Promise((resolve) => duplicate!.once('exit', resolve));
    await duplicateExit;
    expect(duplicate.exitCode).toBe(0);
    expect(leaseIdentity(supervisorLeasePath(dir.path))?.pid).toBe(supervisor.pid);
    stop(original, 'SIGKILL');
    await until(() => {
      const owner = leaseIdentity(`${config.managerSocket}.lease`);
      return !!owner && owner.pid !== original.pid && sameProcess(owner);
    });
    const replacement = leaseIdentity(`${config.managerSocket}.lease`)!;
    await Promise.all([ensureHostRunning(config), ensureHostRunning(config)]);
    await pause(300);
    expect(leaseIdentity(`${config.managerSocket}.lease`)).toEqual(replacement);
    expect(leaseIdentity(supervisorLeasePath(dir.path))?.pid).toBe(supervisor.pid);
    stop(replacement);
    await until(() => !sameProcess(replacement));
    await until(() => !sameProcess(supervisor));
    await pause(200);
    expect(leaseIdentity(`${config.managerSocket}.lease`)).toBeUndefined();
  } finally {
    stop(leaseIdentity(supervisorLeasePath(dir.path)));
    stop(leaseIdentity(`${config.managerSocket}.lease`));
    if (duplicate) await terminate(duplicate);
    if (previous.state === undefined) delete process.env.FAKE_GOAL_STATE;
    else process.env.FAKE_GOAL_STATE = previous.state;
    if (previous.main === undefined) delete process.env.FAKE_GOAL_MAIN;
    else process.env.FAKE_GOAL_MAIN = previous.main;
    dir.close();
  }
}, 15_000);

test('restart failures preserve the exact cause and use durable bounded backoff across supervisor replacement', async () => {
  const dir = temporaryDirectory();
  const failing = join(dir.path, 'failure.ts');
  const attempts = join(dir.path, 'attempts.jsonl');
  writeFileSync(
    failing,
    `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(Date.now())+'\\n'); console.error('fixture host startup cause'); process.exit(17);`,
  );
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50)'], { stdio: 'ignore' });
  const identity = processIdentity(dead.pid!)!;
  await new Promise((resolve) => dead.once('exit', resolve));
  writeFileSync(join(dir.path, 'manager-host-liveness.json'), JSON.stringify({ identity, desired: true }));
  const config: HostLivenessConfig = {
    stateDirectory: dir.path,
    managerSocket: join(dir.path, 'manager.sock'),
    mainCheckout: dir.path,
    command: [process.execPath, failing],
    pollMs: 10,
    minBackoffMs: 80,
    maxBackoffMs: 240,
  };
  const count = () => {
    try {
      return readFileSync(attempts, 'utf8').trim().split('\n').map(Number);
    } catch {
      return [];
    }
  };
  let controller = new AbortController();
  let running = superviseHost(config, controller.signal);
  try {
    await until(() => count().length >= 2);
    controller.abort();
    await running;
    const saved = JSON.parse(readFileSync(join(dir.path, 'manager-host-liveness-retry.json'), 'utf8'));
    expect(saved.failures).toBeGreaterThanOrEqual(2);
    expect(saved.nextAt - count().at(-1)!).toBeLessThanOrEqual(240);
    const before = count().length;
    controller = new AbortController();
    running = superviseHost(config, controller.signal);
    await pause(20);
    expect(count()).toHaveLength(before);
    await until(() => count().length > before);
    const times = count();
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(140);
    expect(readFileSync(join(dir.path, 'manager-host.log'), 'utf8')).toContain('fixture host startup cause');
  } finally {
    controller.abort();
    await running;
    dir.close();
  }
}, 10_000);

test('startup failure diagnostics bound current launch evidence and report missing or truncated output honestly', async () => {
  const dir = temporaryDirectory();
  const logPath = join(dir.path, 'manager-host.log');
  const oldFailure = 'previous launch failure';
  const oldFailureBytes = Buffer.from(oldFailure);
  const log = openSync(logPath, 'w');
  ftruncateSync(log, 128 * 1024 * 1024);
  writeSync(log, oldFailureBytes, 0, oldFailureBytes.length, 128 * 1024 * 1024 - oldFailureBytes.length);
  closeSync(log);

  const failing = join(dir.path, 'failure.js');
  const config: HostLivenessConfig = {
    stateDirectory: dir.path,
    managerSocket: join(dir.path, 'manager.sock'),
    mainCheckout: dir.path,
    command: [process.execPath, failing],
  };
  const failAndRead = async () => {
    const error = await ensureHostRunning(config).then(() => undefined, (reason) => reason as Error);
    expect(error).toBeInstanceOf(Error);
    return error!.message;
  };

  try {
    const currentFailure = 'current launch failure';
    writeFileSync(failing, `console.error(${JSON.stringify(currentFailure)}); process.exit(17);`);
    const first = await failAndRead();
    expect(first).toContain('exited with code 17');
    expect(first).toContain(`log path: ${logPath}`);
    expect(first).toContain('Current launch output complete');
    expect(first).toContain(currentFailure);
    expect(first).not.toContain(oldFailure);

    const currentTail = 'current launch tail';
    writeFileSync(failing, `console.error(${JSON.stringify(`${'x'.repeat(5000)}${currentTail}`)}); process.exit(18);`);
    const second = await failAndRead();
    expect(second).toContain('exited with code 18');
    expect(second).toContain(`log path: ${logPath}`);
    expect(second).toContain('Current launch output truncated');
    expect(second).toContain(currentTail);
    expect(second).not.toContain(oldFailure);
    expect(second.length).toBeLessThan(4500);

    for (const [source, outcome, evidence] of [
      ['process.exit(19);', 'code 19', 'complete (0 bytes; no output recorded)'],
      ['process.kill(process.pid, "SIGTERM");', 'signal SIGTERM', 'complete (0 bytes; no output recorded)'],
      [
        `import { truncateSync } from 'node:fs'; truncateSync(${JSON.stringify(logPath)}, 0); console.error('replacement output'); process.exit(20);`,
        'code 20',
        'unavailable: the log shrank',
      ],
    ]) {
      writeFileSync(failing, source!);
      const diagnostic = await failAndRead();
      expect(diagnostic).toContain(`exited with ${outcome}`);
      expect(diagnostic).toContain(`log path: ${logPath}`);
      expect(diagnostic).toContain(evidence!);
      for (const previous of [oldFailure, currentFailure, currentTail]) expect(diagnostic).not.toContain(previous);
    }
  } finally {
    dir.close();
  }
}, 10_000);

test('supervisor launch reports readiness only after fenced ownership is established', async () => {
  const dir = temporaryDirectory();
  const config: HostLivenessConfig = {
    stateDirectory: dir.path,
    managerSocket: join(dir.path, 'manager.sock'),
    mainCheckout: dir.path,
    command: [process.execPath, runtime],
    pollMs: 20,
  };
  let owner: ProcessIdentity | undefined;
  try {
    recordHostLiveness(dir.path, true);
    await startHostSupervisor(config);
    owner = leaseIdentity(supervisorLeasePath(dir.path));
    expect(owner).toBeDefined();
    expect(owner && sameProcess(owner)).toBe(true);
  } finally {
    owner ??= leaseIdentity(supervisorLeasePath(dir.path));
    stop(owner);
    if (owner) await until(() => !sameProcess(owner!));
    dir.close();
  }
}, 10_000);

test('a supervisor arriving after state teardown never recreates the removed directory', async () => {
  const dir = temporaryDirectory();
  const config: HostLivenessConfig = {
    stateDirectory: dir.path,
    managerSocket: join(dir.path, 'manager.sock'),
    mainCheckout: dir.path,
    command: [process.execPath, runtime],
  };
  dir.close();
  try {
    await superviseHost(config);
    expect(existsSync(dir.path)).toBe(false);
    await startHostSupervisor(config);
    expect(existsSync(dir.path)).toBe(false);
  } finally {
    dir.close();
  }
});
