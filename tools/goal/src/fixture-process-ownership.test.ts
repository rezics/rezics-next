import { expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createFixtureProcessOwner,
  fixtureOwnedProcesses,
  hasUnsettledFixtureWaits,
  recordFixtureOwnedProcess,
  settleFixtureWaits,
  trackFixtureWait,
  fixtureProcessOwnershipAdapter,
} from './fixture-process-ownership.ts';
import {
  checkedProcessGroup,
  groupMembers,
  inspectProcessIdentity,
  processIdentity,
  sameProcess,
  terminateProcessGroup,
  getProcessOwnershipAdapter,
  installProcessOwnershipAdapter,
  normalProcessOwnershipAdapter,
  waitForWorkerExit,
  waitForProcess,
  waitForProcessGroup,
} from './process.ts';

test('process ownership adapters preserve the normal default and inject fixture child tracking', async () => {
  const f = fixtureDirectory();
  const restore = installProcessOwnershipAdapter(normalProcessOwnershipAdapter);
  expect(getProcessOwnershipAdapter()).toBe(normalProcessOwnershipAdapter);
  restore();

  const restoreFixture = installProcessOwnershipAdapter(fixtureProcessOwnershipAdapter);
  let identity: ReturnType<typeof processIdentity> = null;
  let waiting: Promise<unknown> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const token = createFixtureProcessOwner(f.state);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('spawn', resolve);
    });
    identity = processIdentity(child.pid!);
    expect(identity).not.toBeNull();
    waiting = waitForWorkerExit(identity, f.log);
    expect(fixtureOwnedProcesses(f.state, token).map((process) => process.role)).toEqual(['waiter']);
    expect(hasUnsettledFixtureWaits(f.state, token)).toBe(true);

    await terminateProcessGroup(identity, 50);
    await waiting;
    await settleFixtureWaits(f.state, token);
    expect(hasUnsettledFixtureWaits(f.state, token)).toBe(false);
  } finally {
    const remaining = identity ?? (child?.pid ? processIdentity(child.pid) : null);
    if (remaining && sameProcess(remaining)) await terminateProcessGroup(remaining, 50);
    await waiting?.catch(() => {});
    child?.unref();
    restoreFixture();
    f.close();
  }
});

test('production process modules do not import fixture ownership policy', () => {
  for (const path of ['process.ts', 'launch.ts', 'job.ts']) {
    const source = fs.readFileSync(join(import.meta.dir, path), 'utf8');
    expect(source).not.toContain("from './fixture-process-ownership.ts'");
  }
});

function fixtureDirectory() {
  const parent = resolve(import.meta.dir, '../../../.temp/goal-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(join(parent, 'ownership-'));
  const state = join(root, 'state');
  const log = join(state, 'runs', 'fixture', '1.jsonl');
  fs.mkdirSync(join(state, 'runs', 'fixture'), { recursive: true });
  return { root, state, log, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('fixture ownership is append-only and rejects another owner or a changed marker', () => {
  const f = fixtureDirectory();
  try {
    const token = createFixtureProcessOwner(f.state);
    const identity = processIdentity()!;
    recordFixtureOwnedProcess(f.log, 'worker', identity);
    recordFixtureOwnedProcess(f.log, 'waiter', identity);
    expect(fixtureOwnedProcesses(f.state, token).map((p) => p.role)).toEqual(['worker', 'waiter']);
    expect(() => fixtureOwnedProcesses(f.state, 'another-owner')).toThrow('marker changed');
    fs.writeFileSync(join(f.state, '.test-fixture-owner'), '00000000-0000-0000-0000-000000000000\n');
    expect(() => fixtureOwnedProcesses(f.state, token)).toThrow('marker changed');
  } finally {
    f.close();
  }
});

test('fixture disposal waits for its continuations and preserves their actual failure', async () => {
  const f = fixtureDirectory();
  try {
    const token = createFixtureProcessOwner(f.state);
    let release!: () => void;
    let completed = false;
    const wait = new Promise<void>((done) => {
      release = done;
    });
    trackFixtureWait(f.log, wait);
    const settling = settleFixtureWaits(f.state, token).then(() => {
      completed = true;
    });
    await Bun.sleep(5);
    expect(completed).toBe(false);
    expect(hasUnsettledFixtureWaits(f.state, token)).toBe(true);
    release();
    await settling;
    expect(hasUnsettledFixtureWaits(f.state, token)).toBe(false);
    trackFixtureWait(f.log, Promise.reject(new Error('owned waiter failed')));
    await expect(settleFixtureWaits(f.state, token)).rejects.toThrow('owned waiter failed');
  } finally {
    f.close();
  }
});

test('malformed process state is unknown rather than an empty original group', () => {
  const f = fixtureDirectory();
  try {
    fs.mkdirSync(join(f.root, 'proc', '123'), { recursive: true });
    fs.writeFileSync(join(f.root, 'proc', '123', 'stat'), 'unreadable process state');
    expect(() => inspectProcessIdentity(123, join(f.root, 'proc'))).toThrow('visibility unknown');
    expect(() => groupMembers(123, join(f.root, 'proc'))).toThrow('visibility unknown');
    expect(inspectProcessIdentity(456, join(f.root, 'proc'))).toBeNull();
  } finally {
    f.close();
  }
});

test('a vanished detached leader leaves a live original child that must be reaped before group exit', async () => {
  const leader = spawn(
    process.execPath,
    [
      '-e',
      `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    child.unref(); console.log(child.pid); setTimeout(() => process.exit(0), 150);
  `,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const childPid = await new Promise<number>((done, reject) => {
    leader.once('error', reject);
    leader.stdout!.once('data', (line) => done(Number(String(line).trim())));
  });
  const identity = processIdentity(leader.pid!)!;
  let settled = false;
  let waiting: Promise<void> | undefined;
  try {
    await waitForProcess(identity);
    expect(processIdentity(childPid)?.group).toBe(identity.group);
    const read = fs.readFileSync;
    const blocked = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
      if (String(path) === `/proc/${childPid}/stat`)
        throw Object.assign(new Error('descendant inspection denied'), { code: 'EACCES' });
      return (read as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.readFileSync);
    try {
      await expect(terminateProcessGroup(identity, 20)).rejects.toThrow('visibility unknown');
      await expect(waitForProcessGroup(identity)).rejects.toThrow('visibility unknown');
    } finally {
      blocked.mockRestore();
    }
    expect(checkedProcessGroup(identity).some((p) => p.pid === childPid)).toBe(true);
    waiting = waitForProcessGroup(identity).then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    await terminateProcessGroup(identity, 20);
    await waiting;
    expect(processIdentity(childPid)).toBeNull();
  } finally {
    await terminateProcessGroup(identity, 20);
    await waiting;
  }
});

test('uninspectable original members prevent cleanup and waiting from reporting terminal state', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  const read = fs.readFileSync;
  const blocked = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
    if (String(path) === `/proc/${identity.pid}/stat`)
      throw Object.assign(new Error('inspection denied'), { code: 'EACCES' });
    return (read as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync);
  try {
    await expect(terminateProcessGroup(identity, 10)).rejects.toThrow('visibility unknown');
    await expect(waitForProcessGroup(identity)).rejects.toThrow('visibility unknown');
    await expect(waitForProcess(identity)).rejects.toThrow('visibility unknown');
  } finally {
    blocked.mockRestore();
    await terminateProcessGroup(identity, 20);
  }
});

test('aborting a waiter leaves its owned process alive until explicit cleanup', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  try {
    const abort = new AbortController();
    const waiting = waitForProcess(identity, abort.signal);
    abort.abort();
    await waiting;
    expect(sameProcess(identity)).toBe(true);
  } finally {
    await terminateProcessGroup(identity, 20);
  }
});

test('a reused zombie leader cannot authorize cleanup of another incarnation', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  const read = fs.readFileSync;
  const zombie = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
    const value = (read as (...args: unknown[]) => unknown)(path, ...args);
    if (String(path) === `/proc/${identity.pid}/stat` && typeof value === 'string')
      return value.slice(0, value.lastIndexOf(')') + 2) + 'Z' + value.slice(value.lastIndexOf(')') + 3);
    return value;
  }) as typeof fs.readFileSync);
  try {
    await expect(terminateProcessGroup({ ...identity, start: '0' }, 10)).rejects.toThrow('identity changed');
  } finally {
    zombie.mockRestore();
    await terminateProcessGroup(identity, 20);
  }
});

test('a kernel-visible group omitted by procfs cannot be declared terminal', async () => {
  const identity = { pid: 2_000_000_000, group: 2_000_000_000, start: '0', boot: 'fixture-boot' };
  const kill = process.kill.bind(process);
  const visible = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -identity.group && signal === 0) return true;
    return kill(pid, signal);
  });
  try {
    await expect(terminateProcessGroup(identity, 10)).rejects.toThrow('visibility unknown');
    await expect(waitForProcessGroup(identity)).rejects.toThrow('visibility unknown');
  } finally {
    visible.mockRestore();
  }
});

import { signalProcessIdentity } from './process.ts';
import { beginFixtureProcessDisposal, fixtureOwnerForLaunch } from './fixture-process-ownership.ts';

test('pidfd signalling cannot be redirected after the first PID identity inspection', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  const read = fs.readFileSync;
  // The first inspection sees the recorded birth. The actual process at signal time has a different birth.
  const changed = spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
    const value = (read as (...args: unknown[]) => unknown)(path, ...args);
    if (String(path) === `/proc/${identity.pid}/stat` && typeof value === 'string') {
      const end = value.lastIndexOf(')') + 2;
      const fields = value.slice(end).trim().split(/\s+/);
      fields[19] = '0';
      return value.slice(0, end) + fields.join(' ') + '\n';
    }
    return value;
  }) as typeof fs.readFileSync);
  try {
    expect(await signalProcessIdentity({ ...identity, start: '0' }, 'SIGKILL')).toBe(false);
    changed.mockRestore();
    expect(sameProcess(identity)).toBe(true);
  } finally {
    changed.mockRestore();
    await terminateProcessGroup(identity, 20);
  }
});

test('termination uses the pinned process rather than a PID-based kill', async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  const kill = process.kill.bind(process);
  const unpinned = spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === identity.pid) throw new Error('unpinned signal');
    return kill(pid, signal);
  });
  try {
    expect(await signalProcessIdentity(identity, 'SIGKILL')).toBe(true);
    await waitForProcess(identity);
    expect(sameProcess(identity)).toBe(false);
  } finally {
    unpinned.mockRestore();
    await terminateProcessGroup(identity, 20);
  }
});

test('a failed signalling helper preserves the live process and an explicit operational error', async () => {
  const f = fixtureDirectory();
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', () => done());
  });
  const identity = processIdentity(child.pid!)!;
  const path = process.env.PATH;
  try {
    const bin = join(f.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'python3'), '#!/bin/sh\necho "fixture signal failure" >&2\nexit 7\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${path}`;
    await expect(signalProcessIdentity(identity, 'SIGTERM')).rejects.toThrow('process signalling unconfirmed');
    expect(sameProcess(identity)).toBe(true);
  } finally {
    process.env.PATH = path;
    await terminateProcessGroup(identity, 20);
    f.close();
  }
});

test('disposal seals new fixture workers while permitting existing waiter continuations', async () => {
  const f = fixtureDirectory();
  try {
    const token = createFixtureProcessOwner(f.state);
    expect(fixtureOwnerForLaunch(f.log)?.token).toBe(token);
    beginFixtureProcessDisposal(f.state, token);
    beginFixtureProcessDisposal(f.state, token);
    expect(() => fixtureOwnerForLaunch(f.log)).toThrow('disposal has started');
    expect(() => recordFixtureOwnedProcess(f.log, 'worker', processIdentity()!)).toThrow('disposal has started');
    recordFixtureOwnedProcess(f.log, 'waiter', processIdentity()!);
    trackFixtureWait(f.log, Promise.resolve());
    await settleFixtureWaits(f.state, token);
    expect(fixtureOwnedProcesses(f.state, token).map((p) => p.role)).toEqual(['waiter']);
    expect(() => beginFixtureProcessDisposal(f.state, 'another-owner')).toThrow('marker changed');
  } finally {
    f.close();
  }
});

test('a waiter rejection without a reason still refuses successful disposal', async () => {
  const f = fixtureDirectory();
  try {
    const token = createFixtureProcessOwner(f.state);
    trackFixtureWait(f.log, Promise.reject(undefined));
    let rejected = false;
    try {
      await settleFixtureWaits(f.state, token);
    } catch (reason) {
      rejected = true;
      expect(reason).toBeUndefined();
    }
    expect(rejected).toBe(true);
  } finally {
    f.close();
  }
});
