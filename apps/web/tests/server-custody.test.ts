import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cleanupAll,
  ownBunProcess,
  ownNodeProcess,
  withCleanup,
  type ProcessCustody,
} from './support/server-custody.ts';

type Fixture = {
  pid: number | undefined;
  custody: ProcessCustody;
  childCompletion: Promise<unknown>;
  outputCompletion: Promise<unknown>;
  descendantReady: Promise<number>;
  descendantPid?: number;
};

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

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await Bun.sleep(10);
  }
  return !processGroupExists(pid);
}

async function drainFixtureOutput(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  for await (const _chunk of stream) {
    // Consume the independent safety branch without retaining fixture output.
  }
}

async function safetyCleanup(fixture: Fixture): Promise<void> {
  if (fixture.pid !== undefined) {
    if (processGroupExists(fixture.pid)) {
      try {
        process.kill(-fixture.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (fixture.descendantPid !== undefined) {
      try {
        process.kill(fixture.descendantPid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (!(await waitUntilGone(fixture.pid, 2500)))
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
      ${parentExits ? 'process.exit(0);' : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"}
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
    ${parentExits ? 'process.exit(0);' : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"}
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
  expect(fixture.pid === undefined ? false : processGroupExists(fixture.pid)).toBe(false);
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
  expect(processGroupExists(fixture.pid!)).toBe(false);
  expect(outputSettled).toBe(true);
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
  fixture.descendantPid = descendant;
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
