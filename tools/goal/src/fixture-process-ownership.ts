import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ProcessOwnershipAdapter } from './process.ts';

const OWNER_FILE = '.test-fixture-owner';
const DISPOSING_FILE = '.test-fixture-disposing';
const PROCESSES_FILE = '.test-fixture-processes.jsonl';

export type FixtureProcessIdentity = { pid: number; start: string; boot: string; group: number };
export type FixtureProcessRole = 'worker' | 'waiter';
export type FixtureOwnedProcess = {
  role: FixtureProcessRole;
  identity: FixtureProcessIdentity;
  logPath: string;
};

type FixtureProcessRecord = FixtureOwnedProcess & { token: string };

const activeWaits = new Map<string, Set<Promise<unknown>>>();
const waitFailures = new Map<string, unknown[]>();

function ownerKey(stateDirectory: string, token: string): string {
  return `${stateDirectory}\0${token}`;
}

function isIdentity(value: unknown): value is FixtureProcessIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<FixtureProcessIdentity>;
  return (
    Number.isSafeInteger(identity.pid) &&
    Number(identity.pid) > 0 &&
    Number.isSafeInteger(identity.group) &&
    Number(identity.group) > 0 &&
    typeof identity.start === 'string' &&
    /^\d+$/.test(identity.start) &&
    typeof identity.boot === 'string' &&
    identity.boot.length > 0
  );
}

/** Enable append-only ownership records for one disposable Goal test fixture. */
export function createFixtureProcessOwner(stateDirectory: string): string {
  const token = randomUUID();
  writeFileSync(join(stateDirectory, OWNER_FILE), `${token}\n`, { flag: 'wx', mode: 0o600 });
  return token;
}

function readOwner(stateDirectory: string): string | undefined {
  try {
    const token = readFileSync(join(stateDirectory, OWNER_FILE), 'utf8').trim();
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error('invalid fixture process ownership marker');
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function stateDirectoryForLog(logPath: string): string {
  return dirname(dirname(dirname(resolve(logPath))));
}

export function fixtureOwnerForLog(logPath: string): { stateDirectory: string; token: string } | undefined {
  const stateDirectory = stateDirectoryForLog(logPath);
  const token = readOwner(stateDirectory);
  return token ? { stateDirectory, token } : undefined;
}

/** Seal a disposable owner before taking the final child inventory. Waiters may still finish. */
export function beginFixtureProcessDisposal(stateDirectory: string, token: string): void {
  if (readOwner(stateDirectory) !== token)
    throw new Error('fixture process ownership marker changed; refusing cleanup');
  try {
    writeFileSync(join(stateDirectory, DISPOSING_FILE), `${token}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(join(stateDirectory, DISPOSING_FILE), 'utf8').trim() !== token)
      throw new Error('fixture disposal ownership marker changed; refusing cleanup');
  }
}

/** This guard applies only to disposable fixtures, whose stores cannot outlive disposal. */
export function fixtureOwnerForLaunch(logPath: string): ReturnType<typeof fixtureOwnerForLog> {
  const owner = fixtureOwnerForLog(logPath);
  if (!owner) return undefined;
  try {
    readFileSync(join(owner.stateDirectory, DISPOSING_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return owner;
    throw error;
  }
  throw new Error('fixture process disposal has started; refusing a new worker');
}

/** Persist ownership as soon as the detached wrapper or its waiter is identified. */
export function recordFixtureOwnedProcess(
  logPath: string,
  role: FixtureProcessRole,
  identity: FixtureProcessIdentity,
): void {
  const owner = role === 'worker' ? fixtureOwnerForLaunch(logPath) : fixtureOwnerForLog(logPath);
  if (!owner) return;
  if (!isIdentity(identity)) throw new Error('invalid fixture-owned process identity');
  const record: FixtureProcessRecord = { token: owner.token, role, identity, logPath: resolve(logPath) };
  appendFileSync(join(owner.stateDirectory, PROCESSES_FILE), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Read only records carrying this fixture's unguessable owner token. */
export function fixtureOwnedProcesses(stateDirectory: string, token: string): FixtureOwnedProcess[] {
  if (readOwner(stateDirectory) !== token)
    throw new Error('fixture process ownership marker changed; refusing cleanup');
  let source: string;
  try {
    source = readFileSync(join(stateDirectory, PROCESSES_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return source
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `invalid fixture process ownership record: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!record || typeof record !== 'object') throw new Error('invalid fixture process ownership record');
      const value = record as Partial<FixtureProcessRecord>;
      if (value.token !== token) throw new Error('fixture process ownership token changed; refusing cleanup');
      if (value.role !== 'worker' && value.role !== 'waiter') throw new Error('invalid fixture process ownership role');
      if (!isIdentity(value.identity)) throw new Error('invalid fixture-owned process identity');
      if (typeof value.logPath !== 'string' || !value.logPath) throw new Error('invalid fixture process log path');
      return { role: value.role, identity: value.identity, logPath: value.logPath };
    });
}

/** Track in-process wait continuations as well as their persisted waiter child process. */
export function trackFixtureWait(logPath: string, wait: Promise<unknown>): void {
  const owner = fixtureOwnerForLog(logPath);
  if (!owner) return;
  const key = ownerKey(owner.stateDirectory, owner.token);
  const active = activeWaits.get(key) ?? new Set<Promise<unknown>>();
  active.add(wait);
  activeWaits.set(key, active);
  void wait.then(
    () => active.delete(wait),
    (error) => {
      const failures = waitFailures.get(key) ?? [];
      failures.push(error);
      waitFailures.set(key, failures);
      active.delete(wait);
    },
  );
}

export async function settleFixtureWaits(stateDirectory: string, token: string): Promise<void> {
  if (readOwner(stateDirectory) !== token)
    throw new Error('fixture process ownership marker changed; refusing cleanup');
  const key = ownerKey(stateDirectory, token);
  while (activeWaits.get(key)?.size) {
    await Promise.all(
      [...activeWaits.get(key)!].map((wait) =>
        wait.then(
          () => undefined,
          () => undefined,
        ),
      ),
    );
  }
  const failures = waitFailures.get(key);
  activeWaits.delete(key);
  waitFailures.delete(key);
  if (failures?.length) throw failures[0];
}

export function hasUnsettledFixtureWaits(stateDirectory: string, token: string): boolean {
  if (readOwner(stateDirectory) !== token)
    throw new Error('fixture process ownership marker changed; refusing cleanup');
  const key = ownerKey(stateDirectory, token);
  return Boolean(activeWaits.get(key)?.size || waitFailures.get(key)?.length);
}

/** Test-support policy, injected into otherwise ordinary process, launch, and job code. */
export const fixtureProcessOwnershipAdapter: ProcessOwnershipAdapter = {
  assertWorkerLaunchAllowed(logPath) {
    fixtureOwnerForLaunch(logPath);
  },
  workerStarted(logPath, identity) {
    recordFixtureOwnedProcess(logPath, 'worker', identity);
  },
  waiterStarted(logPath) {
    if (!fixtureOwnerForLog(logPath)) return undefined;
    return (identity) => recordFixtureOwnedProcess(logPath, 'waiter', identity);
  },
  trackWait(logPath, wait) {
    trackFixtureWait(logPath, wait);
  },
};
