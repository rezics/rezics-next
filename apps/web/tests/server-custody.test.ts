import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupAll,
  liveProcessGroupMemberIds,
  ownBunProcess,
  ownNodeProcess,
  processHasExited,
  processIdentity,
  observeOwnedTreeForRegression,
  processStartTicks,
  ProcessCustodyError,
  reapExitedProcessGroupMembers,
  signalOwnedProcess,
  withCleanup,
  type OwnedMember,
  type ProcessCustody,
} from './support/server-custody.ts';

type Fixture = {
  pid: number | undefined;
  custody: ProcessCustody;
  childCompletion: Promise<unknown>;
  outputCompletion: Promise<unknown>;
  descendantReady: Promise<number>;
  descendant?: OwnedMember;
};

// Outlives one full scan (500 ms), so the owned tree records a descendant while the root still leads its group.
const PARENT_OUTLIVES_SCAN_MS = 700;

/** The fixture parent's last statement: exit after the descendant is scanned, or stay alive until the owner stops it. */
function parentTail(parentExits: boolean): string {
  return parentExits
    ? `setTimeout(() => process.exit(0), ${PARENT_OUTLIVES_SCAN_MS});`
    : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
}

const fixtures: Fixture[] = [];

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function drainFixtureOutput(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  for await (const _chunk of stream) {
    // Consume the independent safety branch without retaining fixture output.
  }
}

async function safetyCleanup(fixture: Fixture): Promise<void> {
  if (fixture.descendant) signalOwnedProcess(fixture.descendant, 'SIGKILL');
  if (fixture.pid !== undefined) {
    if (processGroupExists(fixture.pid) || liveProcessGroupMemberIds(fixture.pid).length > 0) {
      try {
        process.kill(-fixture.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      reapExitedProcessGroupMembers(fixture.pid);
      if (liveProcessGroupMemberIds(fixture.pid).length === 0) break;
      await Bun.sleep(10);
    }
    reapExitedProcessGroupMembers(fixture.pid);
    if (liveProcessGroupMemberIds(fixture.pid).length > 0)
      throw new Error(`Independent fixture safety cleanup could not remove process group ${fixture.pid}`);
  }
  await Promise.race([
    Promise.allSettled([fixture.childCompletion, fixture.outputCompletion]),
    Bun.sleep(2500).then(() => {
      throw new Error(`Independent fixture safety cleanup could not settle group ${fixture.pid ?? 'without a pid'}`);
    }),
  ]);
}

afterAll(async () => {
  const results = await Promise.allSettled(fixtures.map(safetyCleanup));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, 'Independent fixture safety cleanup failed');
});

function waitForDescendant(read: (callback: (text: string) => void) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for fixture descendant: ${buffer}`)), 2000);
    read((text) => {
      buffer += text;
      const match = /descendant=(\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
}

function nodeFixture(parentExits: boolean): Fixture {
  let publish!: (text: string) => void;
  const descendantReady = waitForDescendant((callback) => {
    publish = (text) => {
      callback(text);
      publish = () => {};
    };
  });
  const descendantScript = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const source = `
    const { spawn } = require('node:child_process');
    setTimeout(() => {
      const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], {
        stdio: 'inherit'
      });
      process.stdout.write('descendant=' + descendant.pid + '\\n');
      ${parentTail(parentExits)}
    }, 30);
  `;
  const child: ChildProcess = spawn(process.execPath, ['-e', source], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childCompletion = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const outputCompletion = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const custody = ownNodeProcess(child, {
    label: 'Node fixture group',
    termGraceMs: 80,
    settleTimeoutMs: 1500,
    pollIntervalMs: 10,
    onOutput: (chunk) => publish(Buffer.from(chunk).toString()),
  });
  const fixture: Fixture = {
    pid: child.pid,
    custody,
    childCompletion,
    outputCompletion,
    descendantReady,
  };
  fixtures.push(fixture);
  return fixture;
}

function bunFixture(parentExits: boolean): Fixture {
  let output = '';
  const descendantScript = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const source = `
    const descendant = Bun.spawn(['bun', '-e', ${JSON.stringify(descendantScript)}], {
      stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'
    });
    console.log('descendant=' + descendant.pid);
    ${parentTail(parentExits)}
  `;
  const child = Bun.spawn(['bun', '-e', source], {
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = child.stdout.tee();
  const stderr = child.stderr.tee();
  const independentOutputCompletion = Promise.all([drainFixtureOutput(stdout[1]), drainFixtureOutput(stderr[1])]).then(
    () => undefined,
  );
  const custody = ownBunProcess(child, {
    label: 'Bun fixture group',
    termGraceMs: 80,
    settleTimeoutMs: 1500,
    pollIntervalMs: 10,
    streams: { stdout: stdout[0], stderr: stderr[0] },
    onOutput: (chunk) => {
      output += Buffer.from(chunk).toString();
    },
  });
  const descendantReady = new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const inspect = () => {
      const match = /descendant=(\d+)/.exec(output);
      if (match) return resolve(Number(match[1]));
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for fixture descendant: ${output}`));
      setTimeout(inspect, 10);
    };
    inspect();
  });
  const fixture: Fixture = {
    pid: child.pid,
    custody,
    childCompletion: Promise.resolve(child.exited),
    outputCompletion: independentOutputCompletion,
    descendantReady,
  };
  fixtures.push(fixture);
  return fixture;
}

test('Node process custody escalates from TERM to KILL for a resistant descendant', async () => {
  const fixture = nodeFixture(false);
  await fixture.descendantReady;
  const began = Date.now();
  await fixture.custody.close();
  expect(Date.now() - began).toBeGreaterThanOrEqual(40);
  expect(fixture.custody.settled).toBe(true);
  expect(fixture.pid === undefined ? [] : liveProcessGroupMemberIds(fixture.pid)).toEqual([]);
});

test('Bun process custody settles a parent-exited group whose descendant still holds output pipes', async () => {
  const fixture = bunFixture(true);
  const descendant = await fixture.descendantReady;
  await Promise.race([
    fixture.childCompletion,
    Bun.sleep(1500).then(() => {
      throw new Error('Bun fixture parent did not exit');
    }),
  ]);
  expect(processGroupExists(fixture.pid!)).toBe(true);
  let outputSettled = false;
  void fixture.custody.outputSettled.then(() => {
    outputSettled = true;
  });
  await Bun.sleep(40);
  expect(outputSettled).toBe(false);
  expect(process.kill(descendant, 0)).toBe(true);
  await fixture.custody.close();
  expect(fixture.custody.settled).toBe(true);
  expect(liveProcessGroupMemberIds(fixture.pid!)).toEqual([]);
  expect(outputSettled).toBe(true);
});

test('Bun custody preserves the runtime-owned direct child exit status', async () => {
  const child = Bun.spawn(['sh', '-c', 'exit 7'], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const custody = ownBunProcess(child, { pollIntervalMs: 1 });
  try {
    expect(await child.exited).toBe(7);
  } finally {
    await custody.close();
  }
  expect(custody.settled).toBe(true);
});

test('Bun process custody preserves an AbortError captured before stop starts', async () => {
  const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const streamFailure = new DOMException('cancelled before stop', 'AbortError');
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(streamFailure);
    },
  });
  const custody = ownBunProcess(child, {
    label: 'pre-stop stream fixture',
    streams: { stdout, stderr: null },
    termGraceMs: 80,
    settleTimeoutMs: 1500,
    pollIntervalMs: 10,
  });
  await custody.outputSettled;

  let failure: unknown;
  try {
    await custody.close();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProcessCustodyError);
  expect((failure as ProcessCustodyError).errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ cause: streamFailure })]),
  );
  expect(custody.settled).toBe(true);
});

test('Bun process custody settles an intentional stop whose output rejects after stop starts', async () => {
  const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  let failStdout: (error: unknown) => void = () => {};
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      failStdout = (error) => controller.error(error);
    },
  });
  const custody = ownBunProcess(child, {
    label: 'post-stop stream fixture',
    streams: { stdout, stderr: null },
    termGraceMs: 80,
    settleTimeoutMs: 1500,
    pollIntervalMs: 10,
  });
  const closing = custody.close();
  failStdout(new DOMException('stopped by the owner', 'AbortError'));
  await closing;
  expect(custody.settled).toBe(true);
});

async function readEscapedPid(path: string): Promise<number> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const text = readFileSync(path, 'utf8').trim();
    if (/^[0-9]+$/.test(text)) return Number(text);
    if (Date.now() > deadline) throw new Error(`escaped descendant pid was never written to ${path}`);
    await Bun.sleep(10);
  }
}

test('a descendant that leaves the group and is reparented before close is still terminated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'custody-escape-'));
  const pidFile = join(directory, 'escaped.pid');
  // The leader starts a session-leading descendant, then stays alive until the test kills it.
  const leader = Bun.spawn(['sh', '-c', 'setsid sleep 60 & echo $! > "$0"; wait', pidFile], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const custody = ownBunProcess(leader, {
    label: 'escaped descendant fixture',
    termGraceMs: 80,
    settleTimeoutMs: 1500,
    pollIntervalMs: 10,
  });
  let escaped: number | undefined;
  try {
    escaped = await readEscapedPid(pidFile);
    // Give the owned tree time to record the escapee while its parent is alive.
    await Bun.sleep(150);
    expect(processIdentity(escaped)?.ppid).toBe(leader.pid);
    process.kill(leader.pid, 'SIGKILL');
    await leader.exited;
    // The escapee now belongs to another parent and no longer shares the leader's group.
    expect(processIdentity(escaped)?.ppid).not.toBe(leader.pid);
    await custody.close();
    expect(custody.settled).toBe(true);
    expect(processHasExited(escaped)).toBe(true);
  } finally {
    if (escaped !== undefined && !processHasExited(escaped)) process.kill(escaped, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

async function readFirstChild(parent: number): Promise<number> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const [first] = readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8').trim().split(/\s+/);
    if (first && /^[0-9]+$/.test(first)) return Number(first);
    if (Date.now() > deadline) throw new Error(`no child of ${parent} appeared`);
    await Bun.sleep(10);
  }
}

test('a group id recycled after its owners exit is never adopted or signalled', async () => {
  // The leader leads a group with one member. Its recorded launch start time no longer names the live leader,
  // as after PID reuse, so nothing in that group is ours.
  const leader = Bun.spawn(['sh', '-c', 'sleep 60 & wait'], {
    detached: true,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const member = await readFirstChild(leader.pid);
  const startTicks = processStartTicks(leader.pid) ?? '';
  const tree = observeOwnedTreeForRegression(leader.pid, { pid: leader.pid, startTicks: `${startTicks}0` });
  try {
    tree.sample(true);
    const errors: unknown[] = [];
    tree.signal('SIGKILL', errors);
    await Bun.sleep(100);
    expect(errors).toEqual([]);
    expect(tree.live()).toEqual([]);
    // Unrecorded, the group member is reported as unattributed rather than adopted or signalled.
    expect(tree.unattributed().map((row) => Number(row.split(' ')[0]))).toContain(member);
    expect(processHasExited(member)).toBe(false);
    expect(processHasExited(leader.pid)).toBe(false);
  } finally {
    tree.stop();
    for (const pid of [member, leader.pid]) {
      try {
        if (!processHasExited(pid)) process.kill(pid, 'SIGKILL');
      } catch {}
    }
    await leader.exited;
  }
});

test('a recorded process is never signalled once its PID names a different process', async () => {
  const bystander = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    const startTicks = processStartTicks(bystander.pid) ?? '';
    expect(startTicks).not.toBe('');
    // A stale record names the same PID with another start time, as after PID reuse.
    expect(signalOwnedProcess({ pid: bystander.pid, startTicks: `${startTicks}0` }, 'SIGKILL')).toBe(false);
    expect(processHasExited(bystander.pid)).toBe(false);
    expect(signalOwnedProcess({ pid: bystander.pid, startTicks }, 'SIGKILL')).toBe(true);
    await bystander.exited;
  } finally {
    if (!processHasExited(bystander.pid)) bystander.kill('SIGKILL');
  }
});

test('server group cleanup runs even when browser close rejects', async () => {
  const fixture = bunFixture(false);
  await fixture.descendantReady;
  let browserAttempted = false;
  let failure: unknown;
  try {
    await cleanupAll([
      {
        label: 'browser.close',
        run: () => {
          browserAttempted = true;
          return Promise.reject(new Error('browser close rejected'));
        },
        timeoutMs: 250,
      },
      { label: 'server group', run: () => fixture.custody.close(), timeoutMs: 4000 },
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(browserAttempted).toBe(true);
  expect(fixture.custody.settled).toBe(true);
});

test('server group cleanup runs even when browser close hangs', async () => {
  const fixture = bunFixture(false);
  await fixture.descendantReady;
  const began = Date.now();
  let failure: unknown;
  try {
    await cleanupAll([
      { label: 'browser.close', run: () => new Promise<void>(() => {}), timeoutMs: 60 },
      { label: 'server group', run: () => fixture.custody.close(), timeoutMs: 4000 },
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(Date.now() - began).toBeLessThan(1500);
  expect(fixture.custody.settled).toBe(true);
});

function bunDetachedDescendantFixture(): Fixture {
  let output = '';
  const descendantScript = `setInterval(() => {}, 1000);`;
  const source = `
    const descendant = Bun.spawn(['bun', '-e', ${JSON.stringify(descendantScript)}], {
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    descendant.unref();
    console.log('descendant=' + descendant.pid);
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `;
  const child = Bun.spawn(['bun', '-e', source], {
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = child.stdout.tee();
  const stderr = child.stderr.tee();
  const independentOutputCompletion = Promise.all([drainFixtureOutput(stdout[1]), drainFixtureOutput(stderr[1])]).then(
    () => undefined,
  );
  const custody = ownBunProcess(child, {
    label: 'Bun detached-descendant fixture',
    termGraceMs: 80,
    settleTimeoutMs: 1500,
    pollIntervalMs: 10,
    streams: { stdout: stdout[0], stderr: stderr[0] },
    onOutput: (chunk) => {
      output += Buffer.from(chunk).toString();
    },
  });
  const descendantReady = new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const inspect = () => {
      const match = /descendant=(\d+)/.exec(output);
      if (match) return resolve(Number(match[1]));
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for fixture descendant: ${output}`));
      setTimeout(inspect, 10);
    };
    inspect();
  });
  const fixture: Fixture = {
    pid: child.pid,
    custody,
    childCompletion: Promise.resolve(child.exited),
    outputCompletion: independentOutputCompletion,
    descendantReady,
  };
  fixtures.push(fixture);
  return fixture;
}

test('Bun process custody reaps a descendant that left the process group', async () => {
  const fixture = bunDetachedDescendantFixture();
  const descendant = await fixture.descendantReady;
  const startTicks = processStartTicks(descendant);
  if (startTicks !== undefined) fixture.descendant = { pid: descendant, startTicks };
  expect(process.kill(descendant, 0)).toBe(true);
  await fixture.custody.close();
  expect(fixture.custody.settled).toBe(true);
  expect(fixture.pid === undefined ? false : processGroupExists(fixture.pid)).toBe(false);
  expect(() => process.kill(descendant, 0)).toThrow();
});

test('closing one process group repeatedly shares the same bounded settlement', async () => {
  const fixture = nodeFixture(false);
  await fixture.descendantReady;
  const first = fixture.custody.close();
  const repeated = fixture.custody.close();
  expect(repeated).toBe(first);
  await first;
  expect(fixture.custody.settled).toBe(true);
});

test('cancellation after partial setup still cleans the process group', async () => {
  const fixture = bunFixture(false);
  await fixture.descendantReady;
  const controller = new AbortController();
  const cancellation = new DOMException('fixture setup cancelled', 'AbortError');
  let failure: unknown;
  try {
    await withCleanup(async () => {
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
      throw cancellation;
    }, [{ label: 'partial Storybook setup', run: () => fixture.custody.close(), timeoutMs: 4000 }]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBe(cancellation);
  expect(fixture.custody.settled).toBe(true);
});

test('operation and cleanup failures retain both original errors', async () => {
  const fixture = nodeFixture(false);
  await fixture.descendantReady;
  const primary = new Error('original assertion failed');
  const cleanup = new Error('browser close failed');
  let failure: unknown;
  try {
    await withCleanup(async () => {
      throw primary;
    }, [
      { label: 'browser.close', run: () => Promise.reject(cleanup), timeoutMs: 250 },
      { label: 'server group', run: () => fixture.custody.close(), timeoutMs: 4000 },
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(primary);
  expect((failure as AggregateError).errors.some((error) => (error as Error).cause === cleanup)).toBe(true);
  expect(fixture.custody.settled).toBe(true);
});
