import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import {
  PublicationController,
  type PublicationControllerOptions,
  type PublicationProcessObservation,
} from './publication.ts';
import { run } from './cli.ts';
import type { Runtime } from './config.ts';
import { sameProcess, groupMembers, waitForProcess, waitForProcessGroup, type ProcessIdentity } from './process.ts';
import { temporaryDirectory } from './test-support.ts';
import { dependencyKey, dependencyStoreMatches } from './shared-dependencies.ts';

const OPERATIONS = 'control-plane';
const OWNER = 'web';
const CANCELLATION_EVIDENCE_PATH = 'control-plane/storybook-duplicate-cancellation.json';
const PRIOR_SUCCESS_RECEIPT_PATH = 'web/resume-20261101/publication-1940.json';
const WORKFLOW_BLOBS = [
  { path: 'apps/web/scripts/storybook-deploy.ts', blob: '1f3f1ed73e874b046747870435a668f3861f82cd' },
  { path: 'apps/web/scripts/storybook-build.ts', blob: '80ac41d76f350cda8f1bf33be6d3ac4e44eab292' },
  { path: 'apps/web/scripts/storybook-smoke.ts', blob: 'e01be88891a79d5e217099e676073b45a916d996' },
] as const;
const HISTORIES = [
  'control-plane/storybook-publication-20261031-2100.json',
  'control-plane/storybook-publication-20261031-2200.json',
  'control-plane/storybook-publication-20261031-2300.json',
  'control-plane/storybook-duplicate-cancellation.json',
  'control-plane/publication-0100-0500-disposition.json',
  'web/resume-20261101/publication-0100-owner-decision.json',
  'web/resume-20261101/publication-1940.json',
];
const fixtureBun = [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$PUB_TEST_INVOCATIONS"',
  'touch "$PUB_TEST_READY" 2>/dev/null || true',
  'sleep "${PUB_TEST_SLEEP:-0.05}"',
  'exit "${PUB_TEST_EXIT:-0}"',
  '',
].join('\n');

type Fixture = {
  temporary: { path: string; close(): void };
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  dbPath: string;
  now: number;
  slotUtc: string;
  authorityPath: string;
  authorityRelativePath: string;
  authorityId?: string;
  sourceCommit: string;
  observedDev: string;
  requiredCommits: [string, string];
  invocationLog: string;
  readyFile: string;
};

type RuntimeOverrides = Partial<
  Omit<
    PublicationControllerOptions,
    'db' | 'mainCheckout' | 'stateDirectory' | 'worktreeRoot' | 'integrationBranch' | 'operationsManager'
  >
> & {
  failReceiptDelivery?: boolean;
  useDefaultDependencyPreparation?: boolean;
};

function git(root: string, args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0 || result.error)
    throw new Error(result.error?.message ?? result.stderr.trim() ?? `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function retainedBlob(blob: string): string {
  const repository = resolve(import.meta.dir, '../../..');
  const result = spawnSync('git', ['cat-file', 'blob', blob], { cwd: repository, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0 || result.error) throw new Error(`retained workflow blob ${blob} is unavailable`);
  return result.stdout;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function processFixtureIdentity(pid: number): ProcessIdentity {
  return { pid, start: String(100_000 + pid), boot: 'fixture-boot-identity', group: pid };
}

function createFixture(options: { staleAuthority?: boolean; alterSmoke?: boolean } = {}): Fixture {
  const temporary = temporaryDirectory();
  const mainCheckout = join(temporary.path, 'repo');
  mkdirSync(mainCheckout, { recursive: true });
  git(mainCheckout, ['init', '-b', 'dev']);
  git(mainCheckout, ['config', 'user.email', 'goal-publication@example.invalid']);
  git(mainCheckout, ['config', 'user.name', 'Goal publication fixture']);
  writeFileSync(join(mainCheckout, '.gitignore'), '.temp/\n');
  writeJson(join(mainCheckout, 'package.json'), { name: 'publication-fixture', private: true, workspaces: [] });
  writeJson(join(mainCheckout, 'apps/web/package.json'), {
    name: '@rezics/web',
    private: true,
    scripts: { 'storybook:deploy': 'bun scripts/storybook-deploy.ts' },
  });
  for (const entry of WORKFLOW_BLOBS) {
    const path = join(mainCheckout, entry.path);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, retainedBlob(entry.blob));
  }
  git(mainCheckout, ['add', '.']);
  git(mainCheckout, ['commit', '-m', 'Fixture immutable Storybook workflow']);
  const observedDev = git(mainCheckout, ['rev-parse', 'HEAD']);
  writeFileSync(join(mainCheckout, 'required-one.md'), 'integrated requirement one\n');
  git(mainCheckout, ['add', 'required-one.md']);
  git(mainCheckout, ['commit', '-m', 'Fixture required integration one']);
  const requiredOne = git(mainCheckout, ['rev-parse', 'HEAD']);
  writeFileSync(join(mainCheckout, 'required-two.md'), 'integrated requirement two\n');
  git(mainCheckout, ['add', 'required-two.md']);
  git(mainCheckout, ['commit', '-m', 'Fixture required integration two']);
  const requiredTwo = git(mainCheckout, ['rev-parse', 'HEAD']);
  if (options.alterSmoke) {
    writeFileSync(join(mainCheckout, 'apps/web/scripts/storybook-smoke.ts'), 'throw new Error("smokes altered");\n');
    git(mainCheckout, ['add', 'apps/web/scripts/storybook-smoke.ts']);
    git(mainCheckout, ['commit', '-m', 'Fixture changed smoke workflow']);
  }
  const sourceCommit = git(mainCheckout, ['rev-parse', 'HEAD']);
  const now = Date.UTC(2027, 0, 2, 3, 15, 0);
  const slot = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
  const dateName = slot.slice(0, 10).replaceAll('-', '');
  const timeName = slot.slice(11, 16).replace(':', '');
  const authorityRelativePath = `.temp/goal/web/resume-${dateName}/publication-${timeName}-owner-decision.json`;
  const authorityPath = join(mainCheckout, authorityRelativePath);
  const stateDirectory = join(mainCheckout, '.temp/goal');
  mkdirSync(stateDirectory, { recursive: true });
  const authority = {
    owner: OWNER,
    controller: 'control-plane',
    recordedAt: '2027-01-02T03:00:00.000Z',
    slotUtc: slot,
    decision: 'authorize-one-conditional-normal-hourly-workflow',
    maximumWorkflowInvocations: 1,
    observedDev: options.staleAuthority ? sourceCommit : observedDev,
    eligibleNewIntegratedSource: [
      `${requiredOne} fixture integrated change one`,
      `${requiredTwo} fixture integrated change two`,
    ],
    publicBuildRead: {
      checkedAt: '2027-01-02T02:59:00.000Z',
      url: 'https://storybook.rezics.com/build.json',
      commit: 'f'.repeat(40),
      builtAt: '2027-01-02T02:58:00.000Z',
    },
    previousPublisher: {
      slot: '2027-01-02T02:00:00Z',
      source: 'a'.repeat(40),
      exit: 1,
      result: 'failed-no-repeat before upload',
      receipt: 'control-plane/storybook-publication-20261031-2300.json',
    },
    conditions: ['ordinary hourly cadence', 'exact clean integrated source', 'all unchanged smokes'],
    notAuthorized: ['repeat failed publisher', 'capture', 'skip checks'],
    status: 'conditional decision only; no start, delivery, or acceptance claimed',
  };
  writeJson(authorityPath, authority);
  return {
    temporary,
    mainCheckout,
    stateDirectory,
    worktreeRoot: join(mainCheckout, '.temp/worktrees'),
    dbPath: join(stateDirectory, 'goal.sqlite'),
    now,
    slotUtc: slot,
    authorityPath,
    authorityRelativePath,
    sourceCommit,
    observedDev,
    requiredCommits: [requiredOne, requiredTwo],
    invocationLog: join(stateDirectory, 'fixture-invocations.log'),
    readyFile: join(stateDirectory, 'fixture-ready'),
  };
}

function historicalOwnerDecision(): Record<string, unknown> {
  return {
    owner: 'web',
    controller: 'control-plane',
    recordedAt: '2026-11-01T01:00:36.013Z',
    slotUtc: '2026-11-01T01:00:00Z',
    decision: 'authorize-one-conditional-normal-hourly-workflow',
    maximumWorkflowInvocations: 1,
    observedDev: '25f48e55818c53a32e0e9665dbbc8221a2649adf',
    eligibleNewIntegratedSource: [
      'd893df41173d27d24e4e3a0c19128c7bb03f4f21 header search label repair',
      '6db386f5e532f771ca118e726b78a7797bccdf13 Home kind consumer',
    ],
    publicBuildRead: {
      checkedAt: '2026-11-01T01:00:36.013Z',
      url: 'https://storybook.rezics.com/build.json',
      commit: 'f1883eed738f8ff36322ffe38ddd0e682b9133fd',
      builtAt: '2026-10-31T22:37:01.664Z',
    },
    previousPublisher: {
      slot: '2026-10-31T23:00:00Z',
      source: '4a0a08db9a36414b28847c30a442c06a94d9ac01',
      exit: 1,
      result: 'failed-no-repeat before upload',
      receipt: '.temp/goal/control-plane/storybook-publication-20261031-2300.json',
    },
    conditions: ['ordinary cadence', 'eligible new integrated source'],
    notAuthorized: ['repeat earlier publisher', 'second invocation', 'capture', 'skip checks'],
    status: 'conditional decision only; no start, delivery, or acceptance claimed',
  };
}

function writeHistoricalEvidence(fixture: Fixture): Array<Record<string, unknown>> {
  const state = fixture.stateDirectory;
  const historyRoot = (path: string) => join(state, path);
  const oldLog = (name: string) => {
    const path = historyRoot(`control-plane/${name}.log`);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `retained fixture log for ${name}\n`);
    return path;
  };
  const histories: Record<string, unknown>[] = [];
  const receipt = (name: string, at: string, exitCode: number, pid: number, result?: string) => {
    const value = {
      state: 'terminal',
      startedAt: at,
      workflowStartedAt: at,
      endedAt: at,
      exitCode,
      ...(result ? { result } : {}),
      attempts: 1,
      maximumWorkflowInvocations: 1,
      launcher: processFixtureIdentity(pid),
      log: oldLog(name),
    };
    const path = `control-plane/${name}.json`;
    writeJson(historyRoot(path), value);
    histories.push({ kind: 'publisher', path });
    return value;
  };
  receipt('storybook-publication-20261031-2100', '2026-10-31T21:00:08.997Z', 1, 987_650_101, 'failed-no-repeat');
  receipt(
    'storybook-publication-20261031-2200',
    '2026-10-31T22:25:11.141Z',
    0,
    987_650_102,
    'normal-workflow-terminal-zero',
  );
  receipt('storybook-publication-20261031-2300', '2026-10-31T23:16:13.332Z', 1, 987_650_103, 'failed-no-repeat');
  const oldPublisher = processFixtureIdentity(987_650_104);
  const duplicateIdentity = processFixtureIdentity(987_650_105);
  const duplicatePath = 'control-plane/storybook-duplicate-cancellation.json';
  const duplicateObserved = {
    ...duplicateIdentity,
    group: duplicateIdentity.pid,
    state: 'S',
    cwd: '/fixture/storybook/apps/web',
    cmd: 'timeout --signal=TERM --kill-after=30s 1800s /fixture/apps/web/node_modules/.bin/bun run storybook:deploy',
  };
  const duplicate = {
    at: 1_793_476_025.9245746,
    toolSession: 50167,
    toolExit: 130,
    expected: { ...duplicateIdentity, group: duplicateIdentity.pid - 7 },
    observed: duplicateObserved,
    firstPublisher: oldPublisher,
    signal: 'SIGTERM to exact owned timeout PID only',
    groupChange: 'timeout created its own process group after launch identity capture',
    postSignalObservation: {
      [duplicateIdentity.pid]: null,
      [duplicateIdentity.pid + 1]: null,
      [duplicateIdentity.pid + 2]: null,
      [oldPublisher.pid]: { start: oldPublisher.start, state: 'S', group: String(oldPublisher.group) },
    },
    observedAt: 1_793_476_032.6193025,
    laterKnownTreeGone: true,
  };
  writeJson(historyRoot(duplicatePath), duplicate);
  histories.push({
    kind: 'publisher',
    path: duplicatePath,
    identityEvidencePath: duplicatePath,
    identityField: 'observed',
  });
  const successLog = join(state, 'web/resume-20261101/publication-1940.log');
  mkdirSync(join(successLog, '..'), { recursive: true });
  writeFileSync(successLog, 'retained successful legacy workflow log\n');
  const priorSuccessPath = 'web/resume-20261101/publication-1940.json';
  writeJson(historyRoot(priorSuccessPath), {
    state: 'terminal',
    sourceCommit: '6661bbf502caf1f4ccaa86d7c100f44651855802',
    workflowStartedAt: '2026-10-31T19:41:31.523625Z',
    workflowPid: oldPublisher.pid,
    exitCode: 0,
    finishedAt: '2026-10-31T20:01:55.362812Z',
    log: successLog,
  });
  histories.push({
    kind: 'publisher',
    path: priorSuccessPath,
    identityEvidencePath: duplicatePath,
    identityField: 'firstPublisher',
  });

  writeJson(historyRoot('control-plane/publication-0100-0500-disposition.json'), {
    at: '2026-11-01T05:04:00Z',
    authority: '.temp/goal/web/resume-20261101/publication-0100-owner-decision.json',
    maximumWorkflowInvocations: 1,
    workflowInvocationsByThisDecision: 0,
    authorityDisposition: 'unconsumed-retained',
    observedDev: fixture.observedDev,
    requiredSourceAncestry: Object.fromEntries(fixture.requiredCommits.map((commit) => [commit, true])),
    prior23Receipt: 'terminal exit1 failed-no-repeat; stale running handle does not override terminal receipt',
    currentPublicDelivery: 'Web GET403; latest successful retained observation is not current proof',
    actual01Handle: null,
    absenceCaveat: 'No receipt or handle does not prove the absence of a live process.',
    disposition: 'No launch until native custody is known.',
  });
  writeJson(historyRoot('web/resume-20261101/publication-0100-owner-decision.json'), historicalOwnerDecision());
  writeJson(
    historyRoot('web/resume-20261101/publication-1940.json'),
    JSON.parse(readFileSync(historyRoot(priorSuccessPath), 'utf8')),
  );
  return histories;
}

function writeBootstrap(
  fixture: Fixture,
  options: { records?: Array<Record<string, unknown>>; historyPaths?: string[] } = {},
): void {
  const records = options.records ?? writeHistoricalEvidence(fixture);
  const historyEvidencePaths = options.historyPaths ?? HISTORIES;
  const manifest = {
    version: 1,
    visibility: 'complete-native-publisher-capture-host-inventory',
    observedAt: new Date(fixture.now).toISOString(),
    noUnregisteredPublisherOrCaptureGroups: true,
    records,
    historyEvidencePaths,
  };
  writeJson(join(fixture.stateDirectory, 'publication/bootstrap.json'), manifest);
}

function initializeManagers(fixture: Fixture): void {
  const db = openDb(fixture.dbPath);
  try {
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    for (const [id, threadId] of [
      [OWNER, 'web-thread'],
      [OPERATIONS, 'control-plane-thread'],
    ] as const) {
      db.query('INSERT INTO manager_sessions(id, state) VALUES (?, ?)').run(
        id,
        JSON.stringify({
          id,
          kind: 'managed',
          provider: 'codex',
          status: 'running',
          threadId,
          history: [],
        }),
      );
    }
    new SqliteManagerInbox(db, fixture.stateDirectory);
  } finally {
    db.close();
  }
}

function runtimeFor(fixture: Fixture, overrides: RuntimeOverrides = {}): Runtime {
  const db = openDb(fixture.dbPath);
  const inbox = overrides.inbox ?? new SqliteManagerInbox(db, fixture.stateDirectory);
  if (overrides.failReceiptDelivery) {
    const deliver = inbox.deliver.bind(inbox);
    inbox.deliver = (event) => {
      if (event.from === OPERATIONS && event.summary.startsWith('Storybook publication '))
        throw new Error('fixture receipt inbox delivery failure');
      deliver(event);
    };
  }
  const prepareDependencies = overrides.useDefaultDependencyPreparation
    ? undefined
    : (overrides.prepareDependencies ??
      ((_main, sourceTree, worktreeRoot) => fixtureDependencies(sourceTree, worktreeRoot)));
  const controller = new PublicationController({
    db,
    mainCheckout: fixture.mainCheckout,
    stateDirectory: fixture.stateDirectory,
    worktreeRoot: fixture.worktreeRoot,
    integrationBranch: 'dev',
    operationsManager: OPERATIONS,
    now: () => fixture.now,
    inbox,
    workflowBlobs: WORKFLOW_BLOBS,
    ...(prepareDependencies ? { prepareDependencies } : {}),
    fetchLiveBuild: overrides.fetchLiveBuild ?? (() => Promise.resolve({ commit: fixture.sourceCommit })),
    ...(overrides.process ? { process: overrides.process } : {}),
    ...(overrides.beforeSpawn ? { beforeSpawn: overrides.beforeSpawn } : {}),
    ...(overrides.afterSpawnIntent ? { afterSpawnIntent: overrides.afterSpawnIntent } : {}),
    ...(overrides.afterIdentityRecorded ? { afterIdentityRecorded: overrides.afterIdentityRecorded } : {}),
  });
  const runtime = {
    db,
    inbox,
    publicationController: controller,
    mainCheckout: fixture.mainCheckout,
    stateDirectory: fixture.stateDirectory,
    worktreeRoot: fixture.worktreeRoot,
    managerSocket: join(fixture.stateDirectory, 'manager.sock'),
    supermanager: 'supermanager',
    settings: { integration: { operationsManager: OPERATIONS }, integrationBranch: 'dev' },
    fence: {
      assertCurrent() {},
      commitMerge<T>(_ref: unknown, merge: () => T): T {
        return merge();
      },
    },
    sink: { onGateOutcome() {} },
    landing: () => ({}) as never,
    manager: () => ({}) as never,
    managerServices: {} as never,
  };
  return runtime as unknown as Runtime;
}

async function withManager<T>(manager: string, action: () => Promise<T>): Promise<T> {
  const names = ['GOAL_MANAGER', 'GOAL_TASK_ID', 'GOAL_ATTEMPT', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID'];
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.GOAL_MANAGER = manager;
  process.env.CODEX_THREAD_ID = `${manager}-thread`;
  try {
    return await action();
  } finally {
    for (const name of names) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function invoke(
  fixture: Fixture,
  argv: string[],
  manager = OPERATIONS,
  overrides: RuntimeOverrides = {},
): Promise<number> {
  return withManager(manager, () => run(argv, () => runtimeFor(fixture, overrides)));
}

async function invokeWithManagerHintOnly(fixture: Fixture, argv: string[]): Promise<number> {
  const names = ['GOAL_MANAGER', 'GOAL_TASK_ID', 'GOAL_ATTEMPT', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID'];
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.GOAL_MANAGER = OPERATIONS;
  try {
    return await run(argv, () => runtimeFor(fixture));
  } finally {
    for (const name of names) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function stateRow<T extends Record<string, unknown>>(
  fixture: Fixture,
  sql: string,
  ...params: (string | number)[]
): T | null {
  const db = openDb(fixture.dbPath);
  try {
    return db.query(sql).get(...params) as T | null;
  } finally {
    db.close();
  }
}

function readAuthorityId(fixture: Fixture): string {
  const row = stateRow<{ id: string }>(
    fixture,
    'SELECT id FROM publication_authorities ORDER BY received_at DESC LIMIT 1',
  );
  if (!row) throw new Error('fixture authority was not received');
  fixture.authorityId = row.id;
  return row.id;
}

async function sendRetainedAuthority(fixture: Fixture): Promise<number> {
  const code = await invoke(
    fixture,
    [
      'inbox',
      'send',
      OPERATIONS,
      'decision',
      'Retained conditional Storybook authority',
      '--document',
      fixture.authorityRelativePath,
    ],
    OWNER,
  );
  expect(code).toBe(0);
  const row = stateRow<{ id: number; event: string }>(
    fixture,
    'SELECT id, event FROM manager_inbox WHERE manager=? ORDER BY id DESC LIMIT 1',
    OPERATIONS,
  );
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.event).senderSessionId).toBe('web-thread');
  return Number(row!.id);
}

async function bootstrapAndReceive(fixture: Fixture, overrides: RuntimeOverrides = {}): Promise<string> {
  writeBootstrap(fixture);
  expect(await invoke(fixture, ['publication', 'bootstrap'], OPERATIONS, overrides)).toBe(0);
  const messageId = await sendRetainedAuthority(fixture);
  expect(await invoke(fixture, ['publication', 'receive', String(messageId)], OPERATIONS, overrides)).toBe(0);
  return readAuthorityId(fixture);
}

function fixtureDependencies(sourceTree: string, worktreeRoot: string) {
  const executable = join(sourceTree, '.temp/publication-fixture-bun');
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, fixtureBun);
  chmodSync(executable, 0o700);
  const key = dependencyKey(sourceTree);
  const storeRoot = join(dirname(resolve(worktreeRoot)), 'dependency-stores');
  const store = join(storeRoot, key);
  if (!existsSync(store)) {
    mkdirSync(store, { recursive: true });
    copyFileSync(join(sourceTree, 'package.json'), join(store, 'package.json'));
  }
  if (!dependencyStoreMatches(store, key)) throw new Error('fixture exact dependency store does not match source key');
  return { key, store, bunVersion: '1.4.4', bunExecutable: executable };
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  if (!existsSync(path)) throw new Error(`fixture child did not create ${path}`);
}

function childStartSource(fixture: Fixture, authorityId: string, crashAt: string): string {
  const dbUrl = pathToFileURL(join(import.meta.dir, 'db.ts')).href;
  const publicationUrl = pathToFileURL(join(import.meta.dir, 'publication.ts')).href;
  const dependenciesUrl = pathToFileURL(join(import.meta.dir, 'shared-dependencies.ts')).href;
  return `
    import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { dirname, join, resolve } from 'node:path';
    import { openDb } from ${JSON.stringify(dbUrl)};
    import { PublicationController } from ${JSON.stringify(publicationUrl)};
    import { dependencyKey, dependencyStoreMatches } from ${JSON.stringify(dependenciesUrl)};
    const config = JSON.parse(process.env.PUB_CRASH_CONFIG);
    const db = openDb(config.dbPath);
    const blobs = ${JSON.stringify(WORKFLOW_BLOBS)};
    const controller = new PublicationController({
      db,
      mainCheckout: config.mainCheckout,
      stateDirectory: config.stateDirectory,
      worktreeRoot: config.worktreeRoot,
      integrationBranch: 'dev',
      operationsManager: 'control-plane',
      now: () => config.now,
      workflowBlobs: blobs,
      fetchLiveBuild: async () => ({ commit: config.sourceCommit }),
      prepareDependencies: (_main, sourceTree, worktreeRoot) => {
        const executable = join(sourceTree, '.temp/publication-fixture-bun');
        mkdirSync(dirname(executable), { recursive: true });
        writeFileSync(executable, config.fixtureBun);
        chmodSync(executable, 0o700);
        const key = dependencyKey(sourceTree);
        const store = join(dirname(resolve(worktreeRoot)), 'dependency-stores', key);
        if (!existsSync(store)) {
          mkdirSync(store, { recursive: true });
          copyFileSync(join(sourceTree, 'package.json'), join(store, 'package.json'));
        }
        if (!dependencyStoreMatches(store, key)) throw new Error('fixture dependency mismatch');
        return { key, store, bunVersion: '1.4.4', bunExecutable: executable };
      },
      beforeSpawn: () => { if (config.crashAt === 'beforeSpawn') process.exit(41); },
      afterSpawnIntent: () => { if (config.crashAt === 'afterSpawnIntent') process.exit(42); },
      afterIdentityRecorded: () => { if (config.crashAt === 'afterIdentityRecorded') process.exit(43); },
    });
    await controller.start(${JSON.stringify(authorityId)}, { id: 'control-plane', sessionId: 'control-plane-thread' });
    db.close();
  `;
}

function crashChild(fixture: Fixture, authorityId: string, crashAt: string): number | null {
  const result = spawnSync(process.execPath, ['-e', childStartSource(fixture, authorityId, crashAt)], {
    cwd: fixture.mainCheckout,
    env: {
      ...process.env,
      PUB_CRASH_CONFIG: JSON.stringify({
        dbPath: fixture.dbPath,
        mainCheckout: fixture.mainCheckout,
        stateDirectory: fixture.stateDirectory,
        worktreeRoot: fixture.worktreeRoot,
        now: fixture.now,
        sourceCommit: fixture.sourceCommit,
        fixtureBun,
        crashAt,
      }),
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return result.status;
}

function invocationCount(fixture: Fixture): number {
  if (!existsSync(fixture.invocationLog)) return 0;
  return readFileSync(fixture.invocationLog, 'utf8').trim().split('\n').filter(Boolean).length;
}

function temporaryStatePath(fixture: Fixture, relativePath: string): string {
  return join(fixture.stateDirectory, relativePath);
}

async function withFixtureEnvironment<T>(fixture: Fixture, sleepSeconds: string, action: () => Promise<T>): Promise<T> {
  const names = ['PUB_TEST_INVOCATIONS', 'PUB_TEST_READY', 'PUB_TEST_SLEEP', 'PUB_TEST_EXIT'];
  const prior = new Map(names.map((name) => [name, process.env[name]]));
  process.env.PUB_TEST_INVOCATIONS = fixture.invocationLog;
  process.env.PUB_TEST_READY = fixture.readyFile;
  process.env.PUB_TEST_SLEEP = sleepSeconds;
  process.env.PUB_TEST_EXIT = '0';
  try {
    return await action();
  } finally {
    for (const name of names) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function sameFixtureIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.start === right.start && left.boot === right.boot && left.group === right.group;
}

function observedFixtureProcess(
  identity: ProcessIdentity,
  members: ProcessIdentity[] = [identity],
): PublicationProcessObservation {
  return {
    identity: (pid) => (pid === identity.pid ? identity : null),
    same: (candidate) => sameFixtureIdentity(candidate, identity),
    members: (group) => (group === identity.group ? members : []),
  };
}

async function setupRetainedAuthority(fixture: Fixture, overrides: RuntimeOverrides = {}): Promise<string> {
  initializeManagers(fixture);
  return bootstrapAndReceive(fixture, overrides);
}

test('Authenticated retained authority reaches one exclusive managed workflow and a truthful terminal receipt', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const authorityId = await bootstrapAndReceive(fixture);
    const message = stateRow<{ id: number }>(
      fixture,
      'SELECT id FROM manager_inbox WHERE manager=? AND sender=? ORDER BY id DESC LIMIT 1',
      OPERATIONS,
      OWNER,
    );
    expect(message).not.toBeNull();
    expect(await invokeWithManagerHintOnly(fixture, ['publication', 'receive', String(message!.id)])).toBe(1);
    expect(await invoke(fixture, ['publication', 'receive', String(message!.id)])).toBe(0);
    expect(stateRow<{ count: number }>(fixture, 'SELECT COUNT(*) AS count FROM publication_authorities')?.count).toBe(
      1,
    );

    await withFixtureEnvironment(fixture, '0.15', async () => {
      expect(
        await invoke(fixture, ['publication', 'start', authorityId], OPERATIONS, { failReceiptDelivery: true }),
      ).toBe(1);
    });

    const invocation = stateRow<{
      id: string;
      source_commit: string;
      bun_executable: string;
      argv: string;
      state: string;
      receipt_path: string;
      receipt: string;
      delivered_at: string | null;
      delivery_error: string | null;
    }>(fixture, 'SELECT * FROM publication_invocations WHERE authority_id=?', authorityId);
    expect(invocation).not.toBeNull();
    expect(invocation!.source_commit).toBe(fixture.sourceCommit);
    expect(invocation!.state).toBe('terminal-success');
    expect(invocation!.delivered_at).toBeNull();
    expect(invocation!.delivery_error).toContain('fixture receipt inbox delivery failure');
    expect(existsSync(invocation!.receipt_path)).toBe(true);
    const firstReceipt = readFileSync(invocation!.receipt_path, 'utf8');
    expect(firstReceipt).toBe(invocation!.receipt);
    const receipt = JSON.parse(firstReceipt) as Record<string, any>;
    expect(receipt.success).toBe(true);
    expect(receipt.exitCode).toBe(0);
    expect(receipt.live).toEqual({ status: 'match', commit: fixture.sourceCommit });
    expect(receipt.process).toEqual(
      JSON.parse(
        stateRow<{ process_identity: string }>(
          fixture,
          'SELECT process_identity FROM publication_invocations WHERE id=?',
          invocation!.id,
        )!.process_identity,
      ),
    );
    expect(receipt.deadlineSeconds).toBe(1800);

    const argv = JSON.parse(invocation!.argv) as string[];
    expect(argv).toEqual([
      'timeout',
      '--signal=TERM',
      '--kill-after=30s',
      '1800s',
      invocation!.bun_executable,
      'run',
      'storybook:deploy',
      '--force',
    ]);
    expect(readFileSync(fixture.invocationLog, 'utf8').trim()).toBe('run storybook:deploy --force');
    expect(invocationCount(fixture)).toBe(1);
    for (const workflow of WORKFLOW_BLOBS)
      expect(
        readFileSync(join(fixture.worktreeRoot, 'storybook-publications', invocation!.id, workflow.path), 'utf8'),
      ).toBe(retainedBlob(workflow.blob));
    const smoke = retainedBlob(WORKFLOW_BLOBS[2].blob);
    for (const requiredSmoke of [
      'Signed out, account menu open',
      'Member, account menu open',
      'Components/Cover Card',
      'locale:ja;theme:dark',
      'Pages/Subjects/Subject',
      'Pages/Library/Copies',
      'copies?.[1]',
    ])
      expect(smoke).toContain(requiredSmoke);

    expect(await invoke(fixture, ['publication', 'recover', invocation!.id])).toBe(0);
    expect(readFileSync(invocation!.receipt_path, 'utf8')).toBe(firstReceipt);
    expect(invocationCount(fixture)).toBe(1);
    expect(
      stateRow<{ count: number }>(
        fixture,
        'SELECT COUNT(*) AS count FROM publication_receipt_deliveries WHERE invocation_id=?',
        invocation!.id,
      )?.count,
    ).toBe(2);
    const finalStatus = stateRow<{ state: string; delivered_at: string | null }>(
      fixture,
      'SELECT state, delivered_at FROM publication_invocations WHERE id=?',
      invocation!.id,
    );
    expect(finalStatus?.state).toBe('terminal-success');
    expect(finalStatus?.delivered_at).not.toBeNull();
    expect(await invoke(fixture, ['publication', 'status', authorityId])).toBe(0);
  } finally {
    fixture.temporary.close();
  }
}, 30_000);

test('Concurrent publisher or capture custody and unknown legacy handles refuse without invocation', async () => {
  const concurrent = createFixture();
  try {
    const authorityId = await setupRetainedAuthority(concurrent);
    await withFixtureEnvironment(concurrent, '2.0', async () => {
      const first = invoke(concurrent, ['publication', 'start', authorityId]);
      await waitForFile(concurrent.readyFile);
      expect(crashChild(concurrent, authorityId, 'contender')).toBe(1);
      expect(await first).toBe(0);
    });
    expect(invocationCount(concurrent)).toBe(1);
    expect(
      stateRow<{ count: number }>(concurrent, 'SELECT COUNT(*) AS count FROM publication_invocations')?.count,
    ).toBe(1);
  } finally {
    concurrent.temporary.close();
  }

  const capture = createFixture();
  try {
    const captureIdentity = processFixtureIdentity(987_650_401);
    const observation = observedFixtureProcess(captureIdentity);
    const authorityId = await setupRetainedAuthority(capture);
    writeJson(temporaryStatePath(capture, 'captures/active-capture.json'), {
      owner: 'fixture',
      purpose: 'custody only',
    });
    expect(
      await invoke(
        capture,
        ['publication', 'capture-register', String(captureIdentity.pid), 'captures/active-capture.json'],
        OPERATIONS,
        { process: observation },
      ),
    ).toBe(0);
    expect(await invoke(capture, ['publication', 'start', authorityId], OPERATIONS, { process: observation })).toBe(1);
    expect(invocationCount(capture)).toBe(0);
    expect(
      stateRow<{ state: string }>(capture, 'SELECT state FROM publication_authorities WHERE id=?', authorityId)?.state,
    ).toBe('received');
  } finally {
    capture.temporary.close();
  }

  const reused = createFixture();
  try {
    initializeManagers(reused);
    const identity = processFixtureIdentity(987_650_402);
    const survivingMember = { ...processFixtureIdentity(identity.pid + 1), group: identity.group };
    const observation: PublicationProcessObservation = {
      identity: () => null,
      same: () => false,
      members: (group) => (group === identity.group ? [survivingMember] : []),
    };
    const histories = writeHistoricalEvidence(reused);
    writeJson(temporaryStatePath(reused, 'control-plane/unregistered-legacy-publisher.json'), {
      state: 'running',
      launcher: identity,
      log: temporaryStatePath(reused, 'control-plane/unregistered-legacy-publisher.log'),
    });
    writeFileSync(
      temporaryStatePath(reused, 'control-plane/unregistered-legacy-publisher.log'),
      'legacy group still visible\n',
    );
    writeBootstrap(reused, {
      records: [...histories, { kind: 'publisher', path: 'control-plane/unregistered-legacy-publisher.json' }],
    });
    expect(await invoke(reused, ['publication', 'bootstrap'], OPERATIONS, { process: observation })).toBe(0);
    const inboxId = await sendRetainedAuthority(reused);
    expect(
      await invoke(reused, ['publication', 'receive', String(inboxId)], OPERATIONS, { process: observation }),
    ).toBe(0);
    const authorityId = readAuthorityId(reused);
    expect(await invoke(reused, ['publication', 'start', authorityId], OPERATIONS, { process: observation })).toBe(1);
    expect(invocationCount(reused)).toBe(0);
    expect(stateRow<{ count: number }>(reused, 'SELECT COUNT(*) AS count FROM publication_invocations')?.count).toBe(0);
  } finally {
    reused.temporary.close();
  }

  const empty = createFixture();
  try {
    initializeManagers(empty);
    writeBootstrap(empty, { records: [] });
    expect(await invoke(empty, ['publication', 'bootstrap'])).toBe(1);
    const inboxId = await sendRetainedAuthority(empty);
    expect(await invoke(empty, ['publication', 'receive', String(inboxId)])).toBe(0);
    const authorityId = readAuthorityId(empty);
    expect(await invoke(empty, ['publication', 'start', authorityId])).toBe(1);
    expect(invocationCount(empty)).toBe(0);
    expect(stateRow<{ count: number }>(empty, 'SELECT COUNT(*) AS count FROM publication_invocations')?.count).toBe(0);
  } finally {
    empty.temporary.close();
  }
}, 30_000);

test('Crash and restart retain once-only authority and original process identity without redispatch', async () => {
  for (const [crashAt, exitCode, expectedCalls] of [
    ['beforeSpawn', 41, 0],
    ['afterSpawnIntent', 42, 0],
    ['afterIdentityRecorded', 43, 1],
  ] as const) {
    const fixture = createFixture();
    try {
      const authorityId = await setupRetainedAuthority(fixture);
      await withFixtureEnvironment(fixture, '0.65', async () => {
        expect(crashChild(fixture, authorityId, crashAt)).toBe(exitCode);
        expect(invocationCount(fixture)).toBe(expectedCalls);
        const invocation = stateRow<{
          id: string;
          process_identity: string | null;
          spawn_intent_at: string | null;
          receipt: string | null;
          state: string;
        }>(fixture, 'SELECT * FROM publication_invocations WHERE authority_id=?', authorityId);
        expect(invocation).not.toBeNull();
        expect(invocation!.receipt).toBeNull();
        expect(invocation!.spawn_intent_at !== null).toBe(crashAt !== 'beforeSpawn');

        if (crashAt === 'afterIdentityRecorded') {
          expect(invocation!.process_identity).not.toBeNull();
          const original = JSON.parse(invocation!.process_identity!) as ProcessIdentity;
          const statusCode = await invoke(fixture, ['publication', 'status', invocation!.id]);
          expect(statusCode).toBe(0);
          await waitForProcess(original);
          await waitForProcessGroup(original);
          const groupMembersAfterExit = groupMembers(original.group);
          expect(groupMembersAfterExit.some((member) => sameProcess(member))).toBe(false);
        } else {
          expect(invocation!.process_identity).toBeNull();
        }

        expect(await invoke(fixture, ['publication', 'recover', invocation!.id])).toBe(1);
        expect(
          stateRow<{ state: string }>(fixture, 'SELECT state FROM publication_invocations WHERE id=?', invocation!.id)
            ?.state,
        ).toBe('unknown');
        expect(await invoke(fixture, ['publication', 'start', authorityId])).toBe(1);
        expect(invocationCount(fixture)).toBe(expectedCalls);
      });
    } finally {
      fixture.temporary.close();
    }
  }
}, 30_000);

test('Exact eligible source dependencies unchanged workflow six smokes and live equality guard success', async () => {
  const success = createFixture();
  try {
    const authorityId = await setupRetainedAuthority(success);
    await withFixtureEnvironment(success, '0.12', async () => {
      expect(await invoke(success, ['publication', 'start', authorityId])).toBe(0);
    });
    const row = stateRow<{
      id: string;
      source_commit: string;
      dependency_key: string;
      dependency_store: string;
      bun_version: string;
      argv: string;
      receipt: string;
      receipt_path: string;
    }>(success, 'SELECT * FROM publication_invocations WHERE authority_id=?', authorityId);
    expect(row).not.toBeNull();
    expect(row!.source_commit).toBe(success.sourceCommit);
    expect(row!.dependency_key).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.dependency_store.endsWith(row!.dependency_key)).toBe(true);
    expect(row!.bun_version).toBe('1.4.4');
    expect(dependencyStoreMatches(row!.dependency_store, row!.dependency_key)).toBe(true);
    expect(JSON.parse(row!.receipt).live).toEqual({ status: 'match', commit: success.sourceCommit });
    expect(invocationCount(success)).toBe(1);
    expect(await invoke(success, ['publication', 'recover', row!.id])).toBe(0);
    expect(invocationCount(success)).toBe(1);
  } finally {
    success.temporary.close();
  }

  const stale = createFixture({ staleAuthority: true });
  try {
    const authorityId = await setupRetainedAuthority(stale);
    expect(await invoke(stale, ['publication', 'start', authorityId])).toBe(1);
    expect(invocationCount(stale)).toBe(0);
    expect(
      stateRow<{ state: string; invocation_id: string | null }>(
        stale,
        'SELECT state, invocation_id FROM publication_authorities WHERE id=?',
        authorityId,
      ),
    ).toEqual({ state: 'received', invocation_id: null });
    expect(stateRow<{ count: number }>(stale, 'SELECT COUNT(*) AS count FROM publication_invocations')?.count).toBe(0);
  } finally {
    stale.temporary.close();
  }

  const changedWorkflow = createFixture({ alterSmoke: true });
  try {
    const authorityId = await setupRetainedAuthority(changedWorkflow);
    expect(await invoke(changedWorkflow, ['publication', 'start', authorityId])).toBe(1);
    expect(invocationCount(changedWorkflow)).toBe(0);
    const row = stateRow<{ receipt: string; spawn_intent_at: string | null }>(
      changedWorkflow,
      'SELECT receipt, spawn_intent_at FROM publication_invocations WHERE authority_id=?',
      authorityId,
    );
    expect(row?.spawn_intent_at).toBeNull();
    expect(JSON.parse(row!.receipt).terminalCause).toBe('preparation-failed-before-workflow-spawn');
  } finally {
    changedWorkflow.temporary.close();
  }

  const mismatchedDependencies = createFixture();
  try {
    const authorityId = await setupRetainedAuthority(mismatchedDependencies);
    expect(
      await invoke(mismatchedDependencies, ['publication', 'start', authorityId], OPERATIONS, {
        prepareDependencies: (_main, sourceTree, worktreeRoot) => {
          const prepared = fixtureDependencies(sourceTree, worktreeRoot);
          writeFileSync(join(prepared.store, 'package.json'), '{"name":"different-dependencies"}\n');
          return prepared;
        },
      }),
    ).toBe(1);
    const row = stateRow<{ receipt: string; spawn_intent_at: string | null }>(
      mismatchedDependencies,
      'SELECT receipt, spawn_intent_at FROM publication_invocations WHERE authority_id=?',
      authorityId,
    );
    expect(row?.spawn_intent_at).toBeNull();
    expect(JSON.parse(row!.receipt).error).toContain('dependency store does not match');
    expect(invocationCount(mismatchedDependencies)).toBe(0);
  } finally {
    mismatchedDependencies.temporary.close();
  }

  const mismatchedLive = createFixture();
  try {
    const authorityId = await setupRetainedAuthority(mismatchedLive);
    await withFixtureEnvironment(mismatchedLive, '0.08', async () => {
      expect(
        await invoke(mismatchedLive, ['publication', 'start', authorityId], OPERATIONS, {
          fetchLiveBuild: async () => ({ commit: 'e'.repeat(40) }),
        }),
      ).toBe(1);
    });
    const receipt = JSON.parse(
      stateRow<{ receipt: string }>(
        mismatchedLive,
        'SELECT receipt FROM publication_invocations WHERE authority_id=?',
        authorityId,
      )!.receipt,
    );
    expect(receipt.exitCode).toBe(0);
    expect(receipt.live).toEqual({ status: 'mismatch', commit: 'e'.repeat(40) });
    expect(receipt.success).toBe(false);
    expect(invocationCount(mismatchedLive)).toBe(1);
  } finally {
    mismatchedLive.temporary.close();
  }

  const unavailableLive = createFixture();
  try {
    const authorityId = await setupRetainedAuthority(unavailableLive);
    await withFixtureEnvironment(unavailableLive, '0.08', async () => {
      expect(
        await invoke(unavailableLive, ['publication', 'start', authorityId], OPERATIONS, {
          fetchLiveBuild: async () => {
            throw new Error('live Storybook metadata HTTP 403');
          },
        }),
      ).toBe(1);
    });
    const receipt = JSON.parse(
      stateRow<{ receipt: string }>(
        unavailableLive,
        'SELECT receipt FROM publication_invocations WHERE authority_id=?',
        authorityId,
      )!.receipt,
    );
    expect(receipt.exitCode).toBe(0);
    expect(receipt.live.status).toBe('unavailable');
    expect(receipt.live.reason).toContain('403');
    expect(receipt.success).toBe(false);
    expect(invocationCount(unavailableLive)).toBe(1);
  } finally {
    unavailableLive.temporary.close();
  }

  const unavailableDependencies = createFixture();
  try {
    const authorityId = await setupRetainedAuthority(unavailableDependencies);
    await withFixtureEnvironment(unavailableDependencies, '0.05', async () => {
      expect(
        await invoke(unavailableDependencies, ['publication', 'start', authorityId], OPERATIONS, {
          useDefaultDependencyPreparation: true,
        }),
      ).toBe(1);
    });
    const receipt = JSON.parse(
      stateRow<{ receipt: string }>(
        unavailableDependencies,
        'SELECT receipt FROM publication_invocations WHERE authority_id=?',
        authorityId,
      )!.receipt,
    );
    expect(receipt.terminalCause).toBe('preparation-failed-before-workflow-spawn');
    expect(receipt.error).toContain('pinned Bun artifact is unavailable');
    expect(receipt.workflowInvocationCount).toBe(0);
    expect(invocationCount(unavailableDependencies)).toBe(0);
  } finally {
    unavailableDependencies.temporary.close();
  }
}, 30_000);

test('Legacy bootstrap binds terminal workflow PIDs and validates cancellation identity evidence', async () => {
  const mismatchedWorkflow = createFixture();
  try {
    initializeManagers(mismatchedWorkflow);
    const records = writeHistoricalEvidence(mismatchedWorkflow);
    const receiptPath = temporaryStatePath(mismatchedWorkflow, PRIOR_SUCCESS_RECEIPT_PATH);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.workflowPid = Number(receipt.workflowPid) + 1;
    writeJson(receiptPath, receipt);
    writeBootstrap(mismatchedWorkflow, { records });
    expect(await invoke(mismatchedWorkflow, ['publication', 'bootstrap'])).toBe(1);
    expect(
      stateRow<{ count: number }>(mismatchedWorkflow, 'SELECT COUNT(*) AS count FROM publication_inventory')?.count,
    ).toBe(0);
  } finally {
    mismatchedWorkflow.temporary.close();
  }

  const invalidCancellation = createFixture();
  try {
    initializeManagers(invalidCancellation);
    const records = writeHistoricalEvidence(invalidCancellation);
    const cancellationPath = temporaryStatePath(invalidCancellation, CANCELLATION_EVIDENCE_PATH);
    const cancellation = JSON.parse(readFileSync(cancellationPath, 'utf8')) as Record<string, any>;
    cancellation.observed.start = String(BigInt(cancellation.observed.start) + 1n);
    writeJson(cancellationPath, cancellation);
    writeBootstrap(invalidCancellation, { records });
    expect(await invoke(invalidCancellation, ['publication', 'bootstrap'])).toBe(1);
    expect(
      stateRow<{ count: number }>(invalidCancellation, 'SELECT COUNT(*) AS count FROM publication_inventory')?.count,
    ).toBe(0);
  } finally {
    invalidCancellation.temporary.close();
  }

  const arbitraryPointer = createFixture();
  try {
    initializeManagers(arbitraryPointer);
    const records = writeHistoricalEvidence(arbitraryPointer);
    const cancellationRecord = records.find((record) => record.path === CANCELLATION_EVIDENCE_PATH);
    expect(cancellationRecord).toBeDefined();
    cancellationRecord!.identityField = 'firstPublisher';
    writeBootstrap(arbitraryPointer, { records });
    expect(await invoke(arbitraryPointer, ['publication', 'bootstrap'])).toBe(1);
    expect(
      stateRow<{ count: number }>(arbitraryPointer, 'SELECT COUNT(*) AS count FROM publication_inventory')?.count,
    ).toBe(0);
  } finally {
    arbitraryPointer.temporary.close();
  }
}, 30_000);

// These reconciliation cases use only private fixture state and the normal authenticated command boundary.
function evidenceHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function sendLegacyDecision(
  fixture: Fixture,
  path: string,
  document: Record<string, unknown>,
  owner = OWNER,
): Promise<number> {
  writeJson(join(fixture.stateDirectory, path), document);
  expect(
    await invoke(
      fixture,
      [
        'inbox',
        'send',
        OPERATIONS,
        'decision',
        'Retained original custody evidence',
        '--document',
        `.temp/goal/${path}`,
      ],
      owner,
    ),
  ).toBe(0);
  return Number(
    stateRow<{ id: number }>(
      fixture,
      'SELECT id FROM manager_inbox WHERE manager=? ORDER BY id DESC LIMIT 1',
      OPERATIONS,
    )!.id,
  );
}

function legacyEntries(fixture: Fixture): Array<Record<string, any>> {
  const db = openDb(fixture.dbPath);
  try {
    return db.query('SELECT * FROM publication_legacy_entries ORDER BY id').all() as Array<Record<string, any>>;
  } finally {
    db.close();
  }
}

function publicationCounts(fixture: Fixture): Record<string, unknown> {
  return {
    authorities: stateRow(fixture, 'SELECT COUNT(*) AS count FROM publication_authorities'),
    claimed: stateRow(fixture, "SELECT COUNT(*) AS count FROM publication_authorities WHERE state='claimed'"),
    invocations: stateRow(fixture, 'SELECT COUNT(*) AS count FROM publication_invocations'),
    invocationLog: existsSync(fixture.invocationLog) ? readFileSync(fixture.invocationLog, 'utf8') : null,
  };
}

async function sendUnavailableOriginals(fixture: Fixture): Promise<number> {
  expect(
    await invoke(fixture, ['inbox', 'send', OWNER, 'decision', 'Receive unavailable original custody'], OPERATIONS),
  ).toBe(0);
  const agreement = stateRow<{ id: number }>(
    fixture,
    'SELECT id FROM manager_inbox WHERE manager=? ORDER BY id DESC LIMIT 1',
    OWNER,
  )!;
  return sendLegacyDecision(fixture, `${OWNER}/legacy-disposition.json`, {
    owner: OWNER,
    reply: agreement.id,
    disposition: 'unavailable-exact-capture-terminal-identity; unknown custody remains occupied',
    evidenceLimits: 'Original observations only; no current absence attestation',
    capture: {
      metadata: { state: 'running', jobs: 4960, completed: 4135, sourceCommit: fixture.observedDev },
      terminalFilePresent: false,
      nativeProcessIdentity: null,
      originalTerminalHandle: null,
    },
    previewCompanion: {
      pid: 910001,
      serverSession: 17,
      startupHistory: [{ pid: 910002, exitCode: 1 }],
      refreshHistory: [{ pid: 910003 }, { pid: 910004 }],
    },
    legacyPublisher: {
      state: 'terminal',
      process: processFixtureIdentity(910005),
      exitCode: 0,
      children: [processFixtureIdentity(910006)],
      physicalSettlement: { pipesSettled: true },
    },
    legacyKnownCustody: [
      { identity: processFixtureIdentity(910007), sameIncarnationLive: false },
      { identity: processFixtureIdentity(910008), sameIncarnationLive: false },
    ],
  });
}

async function sendVersionedOriginal(
  fixture: Fixture,
  key: string,
  surface: 'capture' | 'publisher' | 'preview',
  original: Record<string, unknown>,
  owner = OWNER,
): Promise<number> {
  const evidencePath = `${owner}/${key}.original.json`;
  writeJson(join(fixture.stateDirectory, evidencePath), original);
  return sendLegacyDecision(
    fixture,
    `${owner}/${key}.decision.json`,
    {
      version: 1,
      kind: 'publication-legacy-disposition',
      owner,
      controller: OPERATIONS,
      records: [
        {
          key,
          surface,
          evidencePath,
          sha256: evidenceHash(readFileSync(join(fixture.stateDirectory, evidencePath), 'utf8')),
        },
      ],
    },
    owner,
  );
}

async function sendResolution(
  fixture: Fixture,
  key: string,
  row: Record<string, any>,
  originalIdentity: ProcessIdentity,
  extra: Record<string, unknown> = {},
  owner = OWNER,
): Promise<number> {
  return sendLegacyDecision(
    fixture,
    `${owner}/${key}.resolution.json`,
    {
      version: 1,
      kind: 'publication-legacy-resolution',
      owner,
      controller: OPERATIONS,
      resolutions: [{ id: row.id, evidenceSha256: row.evidence_hash, originalIdentity, ...extra }],
    },
    owner,
  );
}

test('Legacy reconciliation receives genuine identity-less disposition with authenticated bilateral provenance and no false bootstrap', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const message = await sendUnavailableOriginals(fixture);
    const before = publicationCounts(fixture);
    const raw = readFileSync(join(fixture.stateDirectory, `${OWNER}/legacy-disposition.json`), 'utf8');
    expect(await invokeWithManagerHintOnly(fixture, ['publication', 'legacy-receive', String(message)])).toBe(1);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)], OWNER)).toBe(1);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    const first = legacyEntries(fixture);
    expect(first).toHaveLength(8);
    expect(
      first.every((row) => row.resolution === null && row.evidence === raw && row.evidence_hash === evidenceHash(raw)),
    ).toBe(true);
    const capture = first.find((row) => row.surface === 'capture')!;
    expect(capture.identity).toBeNull();
    expect(JSON.parse(capture.original).nativeProcessIdentity).toBeNull();
    expect(first.filter((row) => row.surface === 'preview')).toHaveLength(4);
    expect(first.filter((row) => row.surface === 'preview').every((row) => row.identity === null)).toBe(true);
    const request = stateRow<{ receipt: string; provenance: string }>(
      fixture,
      'SELECT receipt, provenance FROM publication_legacy_requests WHERE message_id=?',
      message,
    )!;
    expect(JSON.parse(request.provenance).ownerSession).toBe('web-thread');
    expect(JSON.parse(request.receipt).state).toBe('UNKNOWN OCCUPIED');
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    expect(
      stateRow<{ receipt: string }>(
        fixture,
        'SELECT receipt FROM publication_legacy_requests WHERE message_id=?',
        message,
      )!.receipt,
    ).toBe(request.receipt);
    expect(legacyEntries(fixture)).toEqual(first);
    expect(await invoke(fixture, ['publication', 'legacy-status'])).toBe(0);
    expect(await invoke(fixture, ['publication', 'status'])).toBe(0);
    writeBootstrap(fixture);
    expect(await invoke(fixture, ['publication', 'bootstrap'])).toBe(1);
    expect(stateRow<{ count: number }>(fixture, 'SELECT COUNT(*) AS count FROM publication_inventory')!.count).toBe(0);
    expect(publicationCounts(fixture)).toEqual(before);
    // A newly opened controller/migration sees exactly the same immutable occupied originals.
    expect(await invoke(fixture, ['publication', 'legacy-status'])).toBe(0);
    expect(legacyEntries(fixture)).toEqual(first);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy receiving supports operations-owned records without owner impersonation and rejects foreign malformed and stale provenance', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const own = await sendVersionedOriginal(
      fixture,
      'own-capture',
      'capture',
      { state: 'running', identity: null },
      OPERATIONS,
    );
    const before = publicationCounts(fixture);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(own)])).toBe(0);
    expect(legacyEntries(fixture)[0]!.owner).toBe(OPERATIONS);
    const foreign = await sendLegacyDecision(fixture, `${OWNER}/foreign.json`, {
      version: 1,
      kind: 'publication-legacy-disposition',
      owner: OPERATIONS,
      records: [],
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(foreign)])).toBe(1);
    const earlier = await sendVersionedOriginal(fixture, 'earlier', 'capture', { identity: { pid: 910010 } });
    const later = await sendVersionedOriginal(fixture, 'later', 'preview', { pid: 910011 });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(later)])).toBe(0);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(earlier)])).toBe(1);
    const pointer = await sendVersionedOriginal(fixture, 'pointer', 'capture', {
      identityField: 'preview',
      preview: processFixtureIdentity(910012),
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(pointer)])).toBe(1);
    const wrongHash = await sendVersionedOriginal(fixture, 'wrong-hash', 'capture', { state: 'running' });
    writeJson(join(fixture.stateDirectory, `${OWNER}/wrong-hash.original.json`), { state: 'terminal', exitCode: 0 });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(wrongHash)])).toBe(1);
    const wrongNamespace = await sendLegacyDecision(fixture, `${OPERATIONS}/wrong-namespace.json`, {
      version: 1,
      kind: 'publication-legacy-disposition',
      owner: OWNER,
      controller: OPERATIONS,
      records: [],
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(wrongNamespace)])).toBe(1);
    const mismatch = await sendVersionedOriginal(fixture, 'workflow-pid', 'publisher', {
      workflowPid: 910014,
      process: processFixtureIdentity(910013),
      state: 'terminal',
      exitCode: 0,
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(mismatch)])).toBe(1);
    const unauthenticated = await sendVersionedOriginal(fixture, 'no-session', 'capture', { identity: null });
    const db = openDb(fixture.dbPath);
    try {
      const inbox = db.query('SELECT event FROM manager_inbox WHERE id=?').get(unauthenticated) as { event: string };
      const event = JSON.parse(inbox.event);
      delete event.senderSessionId;
      db.query('UPDATE manager_inbox SET event=? WHERE id=?').run(JSON.stringify(event), unauthenticated);
    } finally {
      db.close();
    }
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(unauthenticated)])).toBe(1);
    expect(legacyEntries(fixture)).toHaveLength(2);
    expect(publicationCounts(fixture)).toEqual(before);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy duplicate conflicts evidence changes refresh omissions and receipt-file failure preserve occupied originals across restart', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const authority = await bootstrapAndReceive(fixture);
    const message = await sendUnavailableOriginals(fixture);
    const before = publicationCounts(fixture);
    // Deliberately obstruct only this fixture's receipt materialization; SQLite must retain the actual acceptance.
    mkdirSync(join(fixture.stateDirectory, 'publication/legacy'), { recursive: true });
    writeFileSync(join(fixture.stateDirectory, 'publication/legacy', `request-${message}.json`), 'delivery sentinel');
    // An existing directory cannot be atomically replaced by the receipt file.
    const { unlinkSync, rmdirSync } = await import('node:fs');
    unlinkSync(join(fixture.stateDirectory, 'publication/legacy', `request-${message}.json`));
    mkdirSync(join(fixture.stateDirectory, 'publication/legacy', `request-${message}.json`));
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(1);
    const saved = stateRow<{ receipt: string }>(
      fixture,
      'SELECT receipt FROM publication_legacy_requests WHERE message_id=?',
      message,
    )!.receipt;
    expect(legacyEntries(fixture)).toHaveLength(8);
    rmdirSync(join(fixture.stateDirectory, 'publication/legacy', `request-${message}.json`));
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    expect(readFileSync(join(fixture.stateDirectory, 'publication/legacy', `request-${message}.json`), 'utf8')).toBe(
      saved,
    );
    const first = legacyEntries(fixture);
    const decisionPath = join(fixture.stateDirectory, `${OWNER}/legacy-disposition.json`);
    const original = readFileSync(decisionPath, 'utf8');
    writeFileSync(decisionPath, `${original}\n`);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(1);
    expect(legacyEntries(fixture)).toEqual(first);
    writeFileSync(decisionPath, original);
    const changed = await sendVersionedOriginal(fixture, 'different-capture', 'capture', {
      state: 'terminal',
      exitCode: 0,
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(changed)])).toBe(0);
    expect(legacyEntries(fixture)).toHaveLength(9);
    const changedAgain = await sendVersionedOriginal(fixture, 'different-capture', 'capture', {
      state: 'running',
      completed: 1,
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(changedAgain)])).toBe(0);
    expect(legacyEntries(fixture)).toHaveLength(10);
    expect(
      first.every((old) =>
        legacyEntries(fixture).some(
          (row) => row.id === old.id && row.evidence === old.evidence && row.resolution === null,
        ),
      ),
    ).toBe(true);
    // Omit all unknown records from a newer otherwise complete original bootstrap: no retirement is permitted.
    writeBootstrap(fixture);
    expect(await invoke(fixture, ['publication', 'bootstrap'])).toBe(1);
    expect(await invoke(fixture, ['publication', 'start', authority])).toBe(1);
    expect(await invoke(fixture, ['publication', 'legacy-prepare'])).toBe(1);
    expect(legacyEntries(fixture).every((row) => row.resolution === null)).toBe(true);
    expect(publicationCounts(fixture)).toEqual(before);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Concurrent reconciliation publisher and capture contenders share the native cross-process custody lease without consuming authority', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const authority = await bootstrapAndReceive(fixture);
    const message = await sendUnavailableOriginals(fixture);
    const before = publicationCounts(fixture);
    const leaseModule = pathToFileURL(join(import.meta.dir, 'lease.ts')).href;
    const ready = join(fixture.stateDirectory, 'lease-holder.ready');
    const source = join(fixture.stateDirectory, 'lease-holder.ts');
    writeFileSync(
      source,
      `import { acquireDirectoryLease } from ${JSON.stringify(leaseModule)};
      import { writeFileSync } from 'node:fs';
      const lease = acquireDirectoryLease(${JSON.stringify(join(fixture.stateDirectory, 'publication/custody.lease'))});
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      await new Promise(resolve => setTimeout(resolve, 2000));
      lease.release();`,
    );
    const child = Bun.spawn([process.execPath, source], { stdout: 'pipe', stderr: 'pipe' });
    try {
      await waitForFile(ready);
      const results = await withManager(OPERATIONS, () =>
        Promise.all([
          run(['publication', 'legacy-receive', String(message)], () => runtimeFor(fixture)),
          run(['publication', 'start', authority], () => runtimeFor(fixture)),
          run(['publication', 'capture-register', String(process.pid), `${OWNER}/legacy-disposition.json`], () =>
            runtimeFor(fixture),
          ),
        ]),
      );
      expect(results).toEqual([1, 1, 1]);
      expect(publicationCounts(fixture)).toEqual(before);
      expect(legacyEntries(fixture)).toHaveLength(0);
    } finally {
      expect(await child.exited).toBe(0);
    }
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    expect(await invoke(fixture, ['publication', 'start', authority])).toBe(1);
    expect(publicationCounts(fixture)).toEqual(before);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy preparation refuses stale incomplete fabricated inventory and release markers and reports concrete credentials and host capabilities', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const message = await sendUnavailableOriginals(fixture);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    const before = publicationCounts(fixture);
    expect(await invoke(fixture, ['publication', 'legacy-prepare'])).toBe(1);
    const preparation = () =>
      JSON.parse(
        stateRow<{ receipt: string }>(
          fixture,
          'SELECT receipt FROM publication_legacy_preparations ORDER BY rowid DESC LIMIT 1',
        )!.receipt,
      );
    const unavailable = preparation();
    expect(unavailable.state).toBe('unavailable');
    expect(unavailable.launchReady).toBe(false);
    expect(unavailable.unresolved).toHaveLength(8);
    expect(unavailable.blockers.some((item: any) => item.field === 'capture.originalIdentity')).toBe(true);
    expect(unavailable.blockers.some((item: any) => item.field === 'providerCredential')).toBe(true);
    expect(unavailable.blockers.some((item: any) => item.field === 'nativePublisherCaptureInventoryProducer')).toBe(
      true,
    );
    const runtime = runtimeFor(fixture);
    const original = (
      runtime as unknown as { publicationController: PublicationController }
    ).publicationController.process.identity()!;
    runtime.db.close();
    const inventory = {
      version: 1,
      kind: 'publication-native-inventory',
      owner: OPERATIONS,
      host: hostname(),
      boot: original.boot,
      observedAt: new Date(fixture.now).toISOString(),
      retainedSetSha256: unavailable.retainedSetSha256,
      controller: { manager: OPERATIONS, sessionId: 'control-plane-thread', identity: original },
      noUnknown: true,
      visibility: 'complete',
      release: { state: 'validated' },
      entries: [],
    };
    const forgedComplete = await sendLegacyDecision(
      fixture,
      `${OPERATIONS}/native-inventory.json`,
      inventory,
      OPERATIONS,
    );
    expect(await invoke(fixture, ['publication', 'legacy-prepare', String(forgedComplete)])).toBe(1);
    expect(preparation().launchReady).toBe(false);
    expect(preparation().inventoryProvenance.owner).toBe(OPERATIONS);
    expect(preparation().blockers.some((item: any) => item.field === 'nativeProducerReceipt')).toBe(true);
    const last = preparation().id;
    for (const [name, change] of [
      ['stale', { observedAt: new Date(fixture.now - 300_001).toISOString() }],
      ['foreign-host', { host: 'another-host' }],
      ['omitted-originals', { retainedSetSha256: '0'.repeat(64) }],
      ['missing-controller', { controller: null }],
    ] as const) {
      const bad = await sendLegacyDecision(
        fixture,
        `${OPERATIONS}/${name}.inventory.json`,
        { ...inventory, ...change },
        OPERATIONS,
      );
      expect(await invoke(fixture, ['publication', 'legacy-prepare', String(bad)])).toBe(1);
      expect(preparation().id).toBe(last);
    }
    expect(publicationCounts(fixture)).toEqual(before);
    expect(legacyEntries(fixture).every((row) => row.resolution === null)).toBe(true);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy preparation keeps known reused incarnations surviving descendants pipes and incomplete visibility occupied', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const original = processFixtureIdentity(920001);
    const descendant = processFixtureIdentity(920002);
    const message = await sendVersionedOriginal(fixture, 'known-original', 'publisher', {
      state: 'terminal',
      exitCode: 0,
      process: original,
      children: [descendant],
      physicalSettlement: { pipesSettled: false },
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    const before = publicationCounts(fixture);
    for (const incomplete of [false, true]) {
      const processApi: PublicationProcessObservation = {
        identity: (pid) => (pid === original.pid ? { ...original, start: String(BigInt(original.start) + 1n) } : null),
        same: () => false,
        members: (group) => {
          if (incomplete) throw new Error('fixture missing host visibility');
          return group === descendant.group ? [descendant] : [];
        },
      };
      expect(await invoke(fixture, ['publication', 'legacy-prepare'], OPERATIONS, { process: processApi })).toBe(1);
      const receipt = JSON.parse(
        stateRow<{ receipt: string }>(
          fixture,
          'SELECT receipt FROM publication_legacy_preparations ORDER BY rowid DESC LIMIT 1',
        )!.receipt,
      );
      expect(
        receipt.blockers.some((item: any) => item.field === (incomplete ? 'groupVisibility' : 'originalIncarnation')),
      ).toBe(true);
      if (!incomplete) expect(receipt.blockers.some((item: any) => item.field === 'groupMembers')).toBe(true);
      expect(receipt.blockers.some((item: any) => item.field === 'publisher.originalTerminalHandle')).toBe(true);
    }
    expect(publicationCounts(fixture)).toEqual(before);
    expect(legacyEntries(fixture)[0]!.resolution).toBeNull();
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy resolution refuses preview substitution foreign ownership arbitrary pointers and absent capture terminal producers', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const message = await sendUnavailableOriginals(fixture);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    const capture = legacyEntries(fixture).find((row) => row.surface === 'capture')!;
    const before = publicationCounts(fixture);
    const substituted = await sendResolution(fixture, 'preview-substitution', capture, processFixtureIdentity(910001));
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(substituted)])).toBe(1);
    const foreign = await sendResolution(
      fixture,
      'foreign-owner',
      capture,
      processFixtureIdentity(930001),
      {},
      OPERATIONS,
    );
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(foreign)])).toBe(1);
    const pointer = await sendResolution(fixture, 'arbitrary-pointer', capture, processFixtureIdentity(930001), {
      identityField: 'preview',
    });
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(pointer)])).toBe(1);
    const unavailable = await sendResolution(
      fixture,
      'capture-terminal-unavailable',
      capture,
      processFixtureIdentity(930001),
    );
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(unavailable)])).toBe(1);
    const receipt = stateRow<{ receipt: string }>(
      fixture,
      'SELECT receipt FROM publication_legacy_requests WHERE message_id=?',
      unavailable,
    )!.receipt;
    expect(JSON.parse(receipt).unavailable[0].field).toBe('capture.nativeTerminalProducer');
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(unavailable)])).toBe(1);
    expect(
      stateRow<{ receipt: string }>(
        fixture,
        'SELECT receipt FROM publication_legacy_requests WHERE message_id=?',
        unavailable,
      )!.receipt,
    ).toBe(receipt);
    expect(legacyEntries(fixture).every((row) => row.resolution === null)).toBe(true);
    expect(publicationCounts(fixture)).toEqual(before);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy positive settlement binds the actual original finite native workflow and never creates an allowance or redispatch', async () => {
  const fixture = createFixture();
  try {
    const authority = await setupRetainedAuthority(fixture);
    await withFixtureEnvironment(fixture, '0.15', async () => {
      expect(await invoke(fixture, ['publication', 'start', authority])).toBe(0);
    });
    const native = stateRow<{ id: string; process_identity: string; receipt: string }>(
      fixture,
      'SELECT id, process_identity, receipt FROM publication_invocations',
    )!;
    const original = JSON.parse(native.process_identity) as ProcessIdentity;
    const message = await sendVersionedOriginal(fixture, 'original-native-publisher', 'publisher', {
      state: 'terminal',
      process: original,
      workflowPid: original.pid,
      sourceCommit: fixture.sourceCommit,
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    const row = legacyEntries(fixture)[0]!;
    const before = publicationCounts(fixture);
    const proof = { nativeInvocationId: native.id, terminalReceiptSha256: evidenceHash(native.receipt) };
    const reused = await sendResolution(
      fixture,
      'reused',
      row,
      { ...original, start: String(BigInt(original.start) + 1n) },
      proof,
    );
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(reused)])).toBe(1);
    const surviving = await sendResolution(fixture, 'surviving', row, original, proof);
    const observed: PublicationProcessObservation = {
      identity: () => null,
      same: () => false,
      members: (group) => (group === original.group ? [{ ...original, pid: original.pid + 1 }] : []),
    };
    expect(
      await invoke(fixture, ['publication', 'legacy-resolve', String(surviving)], OPERATIONS, { process: observed }),
    ).toBe(1);
    expect(legacyEntries(fixture)[0]!.resolution).toBeNull();
    const resolved = await sendResolution(fixture, 'exact-original', row, original, proof);
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(resolved)])).toBe(0);
    const saved = legacyEntries(fixture)[0]!.resolution;
    expect(JSON.parse(saved).nativeInvocationId).toBe(native.id);
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(resolved)])).toBe(0);
    expect(legacyEntries(fixture)[0]!.resolution).toBe(saved);
    const conflict = await sendResolution(fixture, 'conflicting-resolution', row, original, proof);
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(conflict)])).toBe(1);
    expect(await invoke(fixture, ['publication', 'start', authority])).toBe(1);
    expect(await invoke(fixture, ['publication', 'recover', native.id])).toBe(0);
    expect(publicationCounts(fixture)).toEqual(before);
    expect(invocationCount(fixture)).toBe(1);
    expect(readFileSync(fixture.invocationLog, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Identity-less publisher receiving cannot acquire an original identity from a resolution request', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const message = await sendVersionedOriginal(fixture, 'missing-original-publisher', 'publisher', {
      state: 'unknown',
      originalTerminalHandle: null,
    });
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    const row = legacyEntries(fixture)[0]!;
    const before = publicationCounts(fixture);
    const request = await sendResolution(fixture, 'supplied-publisher-identity', row, processFixtureIdentity(930003), {
      nativeInvocationId: 'unrelated-native-invocation',
      terminalReceiptSha256: '0'.repeat(64),
    });
    expect(await invoke(fixture, ['publication', 'legacy-resolve', String(request)])).toBe(1);
    const receipt = JSON.parse(
      stateRow<{ receipt: string }>(
        fixture,
        'SELECT receipt FROM publication_legacy_requests WHERE message_id=?',
        request,
      )!.receipt,
    );
    expect(receipt.unavailable[0].field).toBe('publisher.nativeOriginalIdentityBinding');
    expect(legacyEntries(fixture)[0]!.identity).toBeNull();
    expect(legacyEntries(fixture)[0]!.resolution).toBeNull();
    expect(publicationCounts(fixture)).toEqual(before);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);

test('Legacy receiving crash around its real SQLite commit retains one journal and original occupied evidence on reopen', async () => {
  const fixture = createFixture();
  try {
    initializeManagers(fixture);
    const message = await sendUnavailableOriginals(fixture);
    const before = publicationCounts(fixture);
    const source = join(fixture.stateDirectory, 'legacy-crash.ts');
    const dbModule = pathToFileURL(join(import.meta.dir, 'db.ts')).href;
    const controllerModule = pathToFileURL(join(import.meta.dir, 'publication.ts')).href;
    const cliModule = pathToFileURL(join(import.meta.dir, 'cli.ts')).href;
    writeFileSync(
      source,
      `
      import { openDb } from ${JSON.stringify(dbModule)};
      import { PublicationController } from ${JSON.stringify(controllerModule)};
      import { run } from ${JSON.stringify(cliModule)};
      const db = openDb(${JSON.stringify(fixture.dbPath)});
      const options = ${JSON.stringify({
        mainCheckout: fixture.mainCheckout,
        stateDirectory: fixture.stateDirectory,
        worktreeRoot: fixture.worktreeRoot,
        integrationBranch: 'dev',
        operationsManager: OPERATIONS,
      })};
      const publicationController = new PublicationController({ ...options, db, now: () => ${fixture.now} });
      if (process.env.LEGACY_CRASH === 'before') process.exit(85);
      const transaction = db.transaction.bind(db);
      db.transaction = (action) => {
        const original = transaction(action);
        const immediate = original.immediate.bind(original);
        original.immediate = (...args) => { immediate(...args); process.exit(86); };
        return original;
      };
      await run(['publication', 'legacy-receive', ${JSON.stringify(String(message))}], () => ({
        ...options, db, publicationController,
        settings: { integration: { operationsManager: 'control-plane' } }
      }));
    `,
    );
    for (const [when, exit] of [
      ['before', 85],
      ['after', 86],
    ] as const) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GOAL_MANAGER: OPERATIONS,
        CODEX_THREAD_ID: 'control-plane-thread',
        LEGACY_CRASH: when,
      };
      delete env.GOAL_TASK_ID;
      delete env.GOAL_ATTEMPT;
      delete env.CLAUDE_CODE_SESSION_ID;
      const child = Bun.spawn([process.execPath, source], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(await child.exited).toBe(exit);
      expect(legacyEntries(fixture)).toHaveLength(when === 'before' ? 0 : 8);
      expect(publicationCounts(fixture)).toEqual(before);
    }
    const committed = stateRow<{ receipt: string }>(
      fixture,
      'SELECT receipt FROM publication_legacy_requests WHERE message_id=?',
      message,
    )!.receipt;
    expect(await invoke(fixture, ['publication', 'legacy-status', String(message)])).toBe(0);
    expect(await invoke(fixture, ['publication', 'legacy-receive', String(message)])).toBe(0);
    expect(legacyEntries(fixture)).toHaveLength(8);
    expect(
      stateRow<{ count: number }>(fixture, 'SELECT COUNT(*) AS count FROM publication_legacy_requests')!.count,
    ).toBe(1);
    expect(readFileSync(join(fixture.stateDirectory, 'publication/legacy', `request-${message}.json`), 'utf8')).toBe(
      committed,
    );
    expect(publicationCounts(fixture)).toEqual(before);
  } finally {
    fixture.temporary.close();
  }
}, 10_000);
