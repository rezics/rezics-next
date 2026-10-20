import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Script } from 'node:vm';
import ts from 'typescript-6';
import { devStackStopArgs, rememberDevStack, startedDevStacks, stopDevSession }
  from '../../../scripts/dev/stack-session.ts';
import { fusekiBuildInputs } from '../../../scripts/dev/fuseki-image.ts';
import { browserBudgets, browserFileCounts, browserProjectCount } from '../../../scripts/qa/browser-budget.ts';
import { dispatchTest, selectTestCommand } from '../../../scripts/qa/test.ts';
import { acquireQaSlots, commandAsync, parseArgs, selfManagedFaultFiles, tierBunTestArgs } from '../../../scripts/qa/core.ts';
import { waitForMemory } from '../../../scripts/qa/memory-admission.ts';
import { qaFailure } from '../../../scripts/qa/failure.ts';
import { parseJUnit } from '../../../scripts/qa/acceptance.ts';
import { qaWaitStatusLines } from '../../../scripts/goal/goalctl.ts';
import { cleanupQaStacks, forgetQaStack, QA_STACK_REGISTRY, rememberQaStack }
  from '../../../scripts/qa/stack-ownership.ts';
import { createQaStackPool, qaStackFingerprint, type QaStackPoolLease } from '../../../scripts/qa/stack-pool.ts';

const root = resolve(import.meta.dir, '../../..');

// CLI cases prove process boundaries and event order, with no startup latency contract.
// A watchdog ends a hung child; each case can start several children in sequence.
const PROCESS_HANG_MS = 5 * 60_000;
setDefaultTimeout(PROCESS_HANG_MS * 4);

/** Exercise direct-run admission without starting the harness's unrelated tiers. */
function harnessAdmission(env: NodeJS.ProcessEnv, slotDirectory: string) {
  const source = ts.createSourceFile('cli.ts', readFileSync(join(root, 'scripts/qa/cli.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['qaSlotDirectory', 'heavyQaRun', 'releaseDeferredHeavy', 'deferredHeavyUsers', 'admissionIntervals']);
  const statements = source.statements.filter(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.has(declaration.name.text))
    || ts.isFunctionDeclaration(node) && node.name?.text === 'acquireRunSlots'
    || ts.isIfStatement(node) && node.getText(source).startsWith('if (qaSlotDirectory)')
    || ts.isExpressionStatement(node) && node.getText(source).startsWith('process.env.GOAL_QA_COMMAND ??='));
  if (statements.length !== 8) throw new Error('Missing QA CLI admission boundary');
  const boundary = ts.transpileModule(statements.map(node => node.getText(source)).join('\n')
    + '\nacquireRunSlots;', { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  return new Script(boundary).runInNewContext({
    process: { env, pid: process.pid, argv: ['bun', 'scripts/qa/cli.ts', '--tier', 'model'],
      on: process.on.bind(process), off: process.off.bind(process) },
    goalSlotDirectory: () => slotDirectory, root, join, randomUUID, mkdirSync, renameSync, rmSync, writeFileSync,
    // The run deadline belongs to the tiers this boundary leaves out; ending its initial wait has nothing to end here.
    acquireQaSlots, Date, console, finishInitialWait: () => undefined,
  }) as (wanted: number, options?: Parameters<typeof acquireQaSlots>[4]) => ReturnType<typeof acquireQaSlots>;
}

/** Keep the real fingerprint, startup and finish branches; test execution is
 * already proved by the stack tests and is replaced by one successful result. */
function poolStartupBoundary(bindings: Record<string, unknown>) {
  const source = ts.createSourceFile('cli.ts', readFileSync(join(root, 'scripts/qa/cli.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = (name: string) => source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const shard = declaration('runShardWork');
  const testBoundary = shard.body!.statements.find(node =>
    ts.isIfStatement(node) && node.expression.getText(source) === '!needsStack')!;
  const boundary = ts.transpileModule(declaration('integrationInfrastructureFingerprint').getText(source) + '\n'
    + declaration('fail').getText(source) + '\n'
    + source.text.slice(shard.getStart(source), testBoundary.getStart(source))
    + "\nrecord.stage = 'test'; return finish({ ok: testPassed, timedOut: false, noMatch: false, xml: '' });\n}\n"
    + '({ runShardWork, integrationInfrastructureFingerprint });',
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  return new Script(boundary).runInNewContext(bindings) as {
    runShardWork(tier: string, project: string, files: string[], flags: string[], budget: number): Promise<{ ok: boolean }>;
    integrationInfrastructureFingerprint(env: NodeJS.ProcessEnv): Promise<string | undefined>;
  };
}

/** Fingerprint the same synthetic checkout bytes through the actual CLI
 * function; Docker resolves identical immutable images for both checkouts. */
function checkoutFingerprintBoundary(checkout: string) {
  const source = ts.createSourceFile('cli.ts', readFileSync(join(root, 'scripts/qa/cli.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'integrationInfrastructureFingerprint')!;
  const boundary = ts.transpileModule(declaration.getText(source) + '\nintegrationInfrastructureFingerprint;',
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  return new Script(boundary).runInNewContext({ root: checkout, Bun, Buffer, join, readFileSync, fusekiBuildInputs,
    qaStackFingerprint, preserveReapEnvironment: (environment: NodeJS.ProcessEnv) => environment,
    commandAsync: async (_root: string, command: string, args: string[]) => {
      expect(command).toBe('docker');
      expect(args.slice(0, 3)).toEqual(['image', 'inspect', '--format']);
      return { ok: true, output: 'sha256:postgres\nsha256:fuseki\nsha256:rustfs\nsha256:mailpit\n' };
    },
  }) as (environment: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

function writeFingerprintFile(checkout: string, path: string, bytes: string | Uint8Array): void {
  const destination = join(checkout, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

function fingerprintCheckout(checkout: string): void {
  // Tiny source trees retain the real schema and preparation sources under
  // examination. They do not import or execute any copied application code.
  for (const path of ['infra/dev/compose.yaml', 'infra/dev/compose.qa.yaml', 'infra/dev/compose.qa-resources.yaml', 'infra/dev/postgres/00-owners.sh',
    'scripts/qa/bootstrap.ts', 'scripts/qa/integration-reset.ts', 'scripts/dev/config.ts', 'scripts/ops/migrate.ts',
    'services/account/src/migrate.ts', 'services/account/src/auth.ts', 'services/account/src/account-settings.ts',
    'services/account/package.json', 'yarn.lock', 'scripts/lib/migration-order.ts',
    'scripts/dev/signup-policy-fixture.ts', 'scripts/dev/seed/plan.ts', 'scripts/fixture/owners/graph.ts',
    'services/main/src/modules/work/activate.ts', 'packages/model/src/index.ts',
    'packages/model/package.json', 'packages/model/tsconfig.json', 'services/account/tsconfig.json',
    'package.json']) {
    writeFingerprintFile(checkout, path, readFileSync(join(root, path)));
  }
  writeFingerprintFile(checkout, 'infra/jena/Dockerfile',
    'FROM scratch\nCOPY infra/jena/fuseki-text-qa.ttl /fuseki/config.ttl\n');
  writeFingerprintFile(checkout, 'infra/jena/fuseki-text-qa.ttl', readFileSync(join(root, 'infra/jena/fuseki-text-qa.ttl')));
  writeFingerprintFile(checkout, 'generated/openapi/main/public.json', '{"openapi":"3.1.0"}\n');
  writeFingerprintFile(checkout, 'generated/model/manifest.json', '{"profiles":[]}\n');
  writeFingerprintFile(checkout, 'bunfig.toml', '[test]\ntimeout = 5000\n');
  writeFingerprintFile(checkout, 'tsconfig.fingerprint.json', '{"compilerOptions":{"strict":true}}\n');
}

test('Account locale-field schema changes qualify a different stack even with identical SQL and images', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-account-schema-'));
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  try {
    fingerprintCheckout(first);
    fingerprintCheckout(second);
    const fingerprintFirst = checkoutFingerprintBoundary(first);
    const fingerprintSecond = checkoutFingerprintBoundary(second);
    const before = await fingerprintFirst({});
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprintSecond({})).toBe(before);
    const path = 'services/account/src/account-settings.ts';
    const source = readFileSync(join(second, path), 'utf8');
    const changed = source.replace("type: 'string', required: false, input: true, returned: true",
      "type: 'string', required: true, input: true, returned: true");
    expect(changed).not.toBe(source);
    writeFingerprintFile(second, path, changed);
    expect(await fingerprintSecond({})).not.toBe(before);
    expect(await fingerprintFirst({})).toBe(before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each(['services/account/src', 'services/main/src', 'packages/model/src', 'scripts', 'generated'])(
  'fingerprints cover added, changed and deleted nested hidden binary files in %s', async sourceDirectory => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-source-inventory-'));
  try {
    fingerprintCheckout(directory);
    const fingerprint = checkoutFingerprintBoundary(directory);
    const original = await fingerprint({});
    const path = `${sourceDirectory}/.schema-state/nested/unnamed`;
    writeFingerprintFile(directory, path, new Uint8Array([0xff, 0xfe, 0x00]));
    const added = await fingerprint({});
    expect(added).not.toBe(original);
    // These two byte sequences collapse to the same UTF-8 replacement text.
    // Their identities still must differ, so every source byte needs coverage.
    writeFingerprintFile(directory, path, new Uint8Array([0xfd, 0xfe, 0x00]));
    const changed = await fingerprint({});
    expect(changed).not.toBe(added);
    rmSync(join(directory, path));
    expect(await fingerprint({})).toBe(original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each(['scripts/lib/migration-order.ts', 'scripts/dev/signup-policy-fixture.ts',
  'scripts/dev/seed/plan.ts', 'scripts/fixture/owners/graph.ts', 'services/main/src/modules/work/activate.ts',
  'packages/model/src/index.ts', 'generated/openapi/main/public.json', 'generated/model/manifest.json',
  'package.json', 'bunfig.toml', 'tsconfig.fingerprint.json', 'packages/model/package.json', 'packages/model/tsconfig.json',
  'services/account/package.json', 'services/account/tsconfig.json', 'infra/jena/Dockerfile', 'infra/jena/fuseki-text-qa.ttl'])(
  'fingerprints include preparation sources, generated contracts and workspace configuration: %s', async path => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-pool-preparation-source-'));
    try {
      fingerprintCheckout(directory);
      const fingerprint = checkoutFingerprintBoundary(directory);
      const before = await fingerprint({});
      const bytes = readFileSync(join(directory, path));
      writeFingerprintFile(directory, path, Buffer.concat([bytes, Buffer.from('\n// Changed preparation source.\n')]));
      expect(await fingerprint({})).not.toBe(before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

function coldPoolHarness(directory: string, inspectionError: string,
  mode: { initialPresent?: boolean; postMissing?: boolean; rejectSnapshot?: boolean; realPool?: boolean;
    leased?: boolean; capacity?: boolean; enabled?: boolean; eligible?: boolean; keep?: boolean;
    testFailed?: boolean; resetFailed?: boolean; switchOffAfterReset?: boolean } = {}) {
  // Fingerprint an isolated, small checkout, as the inventory tests do. Scanning
  // the live repository measures unrelated workers' source trees and host I/O.
  fingerprintCheckout(directory);
  const events: string[] = [];
  const errors: string[] = [];
  const computed: string[] = [];
  let imagesPresent = false;
  let recordedFingerprint: string | undefined;
  let enabled = mode.enabled ?? true;
  const rejections: { projectRunId: string; scope: string; key: string; value: string; reason: string }[] = [];
  const apps = { MAIN_OBJECT_DIRECTORY: join(directory, 'objects') };
  const compose = { REZICS_STACK_PROFILE: 'qa' };
  let realLease: QaStackPoolLease | undefined;
  const realPool = mode.realPool ? createQaStackPool({ root: directory, slotDirectory: join(directory, 'slots'),
    slots: 1, now: () => 100, janitor: false, destroy: async () => {}, destroySync: () => {} }) : undefined;
  if (realPool) {
    writeFileSync(join(directory, 'qa-stack-pool'), 'on\n');
    mkdirSync(apps.MAIN_OBJECT_DIRECTORY);
  }
  const result = (ok = true, output = '') => ({ ok, output, timedOut: false,
    elapsedMs: 1, activeElapsedMs: 1, admissionWaitMs: 0 });
  const lease = {
    entry: { projectRunId: 'previous-i1', apps, compose }, parkedMs: 123,
    async recordFingerprint(value: string | undefined) {
      events.push(value === undefined ? 'record pending fingerprint' : 'record fingerprint');
      recordedFingerprint = value;
      if (realLease && value !== undefined) await realLease.recordFingerprint(value);
    },
    async park(nextApps: unknown, nextCompose: unknown) {
      events.push(recordedFingerprint === undefined ? 'refuse pending park' : 'park');
      expect(nextApps).toEqual(apps);
      expect(nextCompose).toEqual(compose);
      if (recordedFingerprint !== undefined && !mode.leased) expect(recordedFingerprint).toBe(computed.at(-1));
      if (!enabled) return false;
      return realLease ? await realLease.park(apps, compose) : recordedFingerprint !== undefined;
    },
    async destroy() { events.push('destroy'); await realLease?.destroy(); },
  };
  const boundary = poolStartupBoundary({
    root: directory, directory, logs: directory, runId: 'cold-pool', Date, Bun, join, fusekiBuildInputs,
    process: { env: {} }, readFileSync, writeFileSync, appendFileSync, mkdirSync,
    options: { keep: mode.keep }, testPassed: !mode.testFailed,
    faultFixtureEnvironment: {}, qaSlotDirectory: join(directory, 'slots'),
    QA_STACK_TIER: 'REZICS_QA_STACK_TIER',
    startedProjects: [], startedFixtureProjects: [], rawUpdateProjects: new Set(),
    stackLeaseNotes: [], errors, runDeadline: Date.now() + 60_000,
    qaFailure, noteFailure: () => {},
    qaStackPoolEnabled: () => enabled, integrationStackPoolEligible: () => mode.eligible ?? !mode.keep,
    integrationResourceClass: () => 'ordinary', qaResourceClasses: { ordinary: { budgetMs: 60_000 } },
    qaStackEnvironment: (environment: NodeJS.ProcessEnv) => environment, qaStackMode: () => 'test',
    commandOnlyIntegrationFiles: new Set(), integrationStackAdmitsWorkScope: () => false,
    tierArtifactName: (tier: string) => tier, preserveReapEnvironment: (environment: NodeJS.ProcessEnv) => environment,
    reserveRunSlot: async () => {}, admitRun: async (work: () => Promise<unknown>) => await work(),
    noteMemory: () => {}, assertQaResourceAllocation: () => {},
    redactCommandOutput: (value: string) => value,
    replacePrivate: () => {},
    readEnv: (path: string) => path.endsWith('apps.env') ? apps : compose,
    stageQaBootstrap: () => ({ apps, args: ['scripts/qa/bootstrap.ts'] }),
    qaStackFingerprint: (input: Parameters<typeof qaStackFingerprint>[0]) => {
      expect(input.images).toEqual(['sha256:postgres', 'sha256:fuseki',
        imagesPresent ? 'sha256:rustfs-after-startup' : 'sha256:rustfs-before-startup', 'sha256:mailpit']);
      const value = qaStackFingerprint(input);
      computed.push(value);
      return value;
    },
    stackPool: {
      rejections: realPool?.rejections ?? rejections,
      async acquire() {
        events.push('acquire');
        if (mode.rejectSnapshot) rejections.push({ projectRunId: 'prior-i1', scope: 'apps',
          key: 'MAIN_EXTRA_CACHE_DIRECTORY', value: '/other-checkout/.temp/cache',
          reason: 'snapshot path belongs to another checkout' });
        if (mode.leased) { recordedFingerprint = computed.at(-1); return lease; }
        return undefined;
      },
      async register(project: string, fingerprint: string | undefined) {
        expect(project).toBe('cold-pool-i1');
        expect(fingerprint).toBe(mode.initialPresent ? computed[0] : undefined);
        events.push('register pending');
        recordedFingerprint = fingerprint;
        realLease = await realPool?.register(project, fingerprint);
        if (realPool) expect(realLease).toBeDefined();
        return mode.capacity ? undefined : lease;
      },
    },
    startRunStack: async () => { events.push('startup'); imagesPresent = true; return result(); },
    commandAsync: async (_root: string, command: string, args: string[]) => {
      if (command === 'docker' && args[0] === 'image') {
        const present = imagesPresent ? !mode.postMissing : mode.initialPresent;
        events.push(present ? 'inspect ready images' : 'inspect missing images');
        return present ? result(true, `sha256:postgres\nsha256:fuseki\nsha256:rustfs-${imagesPresent ? 'after' : 'before'}-startup\nsha256:mailpit\n`)
          : result(false, inspectionError);
      }
      if (command === 'docker' && args[0] === 'inspect') return result(true, '{}');
      if (args[0] === 'scripts/qa/bootstrap.ts') { events.push('bootstrap'); return result(); }
      if (args[0] === 'scripts/qa/integration-reset.ts') {
        expect(args[3]).toBe('--release');
        events.push('reset');
        if (mode.switchOffAfterReset) enabled = false;
        return result(!mode.resetFailed);
      }
      if (args[1] === 'stack:logs') return result();
      if (args[1] === 'stack:reset') { events.push('destroy'); return result(); }
      throw new Error(`Unexpected cold-pool command: ${command} ${args.join(' ')}`);
    },
  });
  return { boundary, events, errors, computed, realPool, async cleanup() {
    if (!realPool) return;
    await realLease?.destroy();
    writeFileSync(join(directory, 'qa-stack-pool'), 'off\n');
    await realPool.sweep();
  } };
}

test.each(['Error response from daemon: No such image: rustfs/rustfs:1.0.0',
  'Error: No such object: rustfs/rustfs:1.0.0'])('a missing local image starts normally and parks under its post-startup fingerprint: %s', async error => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-cold-start-'));
  const harness = coldPoolHarness(directory, error, { realPool: true });
  try {
    const run = await harness.boundary.runShardWork('integration', 'cold-pool-i1',
      ['tests/qa/integration/shared-stack.test.ts'], [], 60_000);
    expect(run.ok).toBe(true);
    expect(harness.errors).toEqual([]);
    expect(harness.events).toEqual(['inspect missing images', 'register pending', 'startup',
      'inspect ready images', 'record fingerprint', 'bootstrap', 'reset', 'park']);
    expect(harness.computed).toHaveLength(1);
    const parked = JSON.parse(readFileSync(join(directory, 'qa-stack-pool-state', 'cold-pool-i1.json'), 'utf8'));
    expect(parked.fingerprint).toBe(harness.computed[0]);
    expect(parked.holder).toBeUndefined();
    const reused = await harness.realPool!.acquire(harness.computed[0]!);
    expect(reused).toBeDefined();
    try { expect(reused!.entry.projectRunId).toBe('cold-pool-i1'); }
    finally { await reused?.destroy(); }
  } finally { await harness.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});

test('a Docker daemon inspection error is not treated as a missing image or a pool miss', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-inspection-error-'));
  try {
    const harness = coldPoolHarness(directory, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
    await expect(harness.boundary.runShardWork('integration', 'cold-pool-i1',
      ['tests/qa/integration/shared-stack.test.ts'], [], 60_000)).rejects.toThrow('Cannot fingerprint QA images');
    expect(harness.events).toEqual(['inspect missing images']);
    expect(harness.computed).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('startup refreshes a known fingerprint before parking pulled or rebuilt images', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-image-refresh-'));
  try {
    const harness = coldPoolHarness(directory, '', { initialPresent: true });
    const run = await harness.boundary.runShardWork('integration', 'cold-pool-i1',
      ['tests/qa/integration/shared-stack.test.ts'], [], 60_000);
    expect(run.ok).toBe(true);
    expect(harness.events).toEqual(['inspect ready images', 'acquire', 'register pending', 'startup',
      'inspect ready images', 'record fingerprint', 'bootstrap', 'reset', 'park']);
    expect(harness.computed).toHaveLength(2);
    expect(harness.computed[1]).not.toBe(harness.computed[0]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([false, true])('images still missing after startup refuse to park even with a prior identity: %s', async initialPresent => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-pending-images-'));
  try {
    const harness = coldPoolHarness(directory, 'No such image: rustfs/rustfs:1.0.0', { postMissing: true, initialPresent });
    const run = await harness.boundary.runShardWork('integration', 'cold-pool-i1',
      ['tests/qa/integration/shared-stack.test.ts'], [], 60_000);
    expect(run.ok).toBe(true);
    expect(harness.events).toEqual([...(initialPresent ? ['inspect ready images', 'acquire'] : ['inspect missing images']), 'register pending', 'startup',
      'inspect missing images', 'record pending fingerprint', 'bootstrap', 'reset', 'refuse pending park', 'destroy']);
    expect(harness.computed).toHaveLength(initialPresent ? 1 : 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a refused snapshot identifies its path key and value in the run summary and starts a replacement', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-snapshot-refusal-'));
  try {
    const harness = coldPoolHarness(directory, '', { initialPresent: true, rejectSnapshot: true });
    const run = await harness.boundary.runShardWork('integration', 'cold-pool-i1',
      ['tests/qa/integration/shared-stack.test.ts'], [], 60_000);
    expect(run.ok).toBe(true);
    const summary = readFileSync(join(directory, 'summary.md'), 'utf8');
    expect(summary).toContain('Integration shard cold-pool-i1 pool miss: rezics-qa-prior-i1 destroyed');
    expect(summary).toContain('apps.MAIN_EXTRA_CACHE_DIRECTORY=/other-checkout/.temp/cache');
    expect(summary).toContain('snapshot path belongs to another checkout');
    expect(harness.events).toEqual(['inspect ready images', 'acquire', 'register pending', 'startup',
      'inspect ready images', 'record fingerprint', 'bootstrap', 'reset', 'park']);
    expect(harness.errors).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
  { mode: { initialPresent: true }, line: 'started and parked', ok: true },
  { mode: { initialPresent: true, leased: true }, line: 'leased from rezics-qa-previous-i1, parked for 123 ms', ok: true },
  { mode: { initialPresent: true, testFailed: true }, line: 'started and destroyed (failed)', ok: false },
  { mode: { initialPresent: true, resetFailed: true }, line: 'started and destroyed (reset failed)', ok: false },
  { mode: { initialPresent: true, capacity: true }, line: 'started and destroyed (capacity)', ok: true },
  { mode: { enabled: false }, line: 'started and destroyed (switch off)', ok: true },
  { mode: { initialPresent: true, switchOffAfterReset: true }, line: 'started and destroyed (switch off)', ok: true },
  { mode: { eligible: false }, line: 'not eligible', ok: true },
  { mode: { keep: true }, line: 'not eligible', ok: true },
])('integration project summary records $line', async ({ mode, line, ok }) => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-pool-outcome-'));
  try {
    const harness = coldPoolHarness(directory, '', mode);
    const run = await harness.boundary.runShardWork('integration', 'cold-pool-i1',
      ['tests/qa/integration/shared-stack.test.ts'], [], 60_000);
    expect(run.ok).toBe(ok);
    expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toBe(`- Integration shard cold-pool-i1 ${line}.\n`);
    if (line === 'started and parked') expect(harness.events.slice(-2)).toEqual(['reset', 'park']);
    if ('enabled' in mode && !mode.enabled || 'eligible' in mode || 'keep' in mode)
      expect(harness.events).not.toContain('inspect ready images');
    if ('testFailed' in mode || 'capacity' in mode || 'enabled' in mode || 'eligible' in mode || 'keep' in mode)
      expect(harness.events).not.toContain('reset');
    if ('keep' in mode) expect(harness.events).not.toContain('destroy');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

/** Run the CLI entrypoint; replace only disposable stack lifecycle commands. */
function startupHarness(directory: string, inheritedEnvironment: NodeJS.ProcessEnv = process.env) {
  const executable = join(directory, 'bun');
  const slots = join(directory, 'slots');
  const control = join(directory, 'control');
  const lockFile = join(directory, 'startup.sqlite');
  mkdirSync(slots);
  mkdirSync(control);
  writeFileSync(executable, `#!${process.execPath}
    import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { withQaStackStartup } from ${JSON.stringify(join(root, 'scripts/qa/memory-admission.ts'))};
    import { commandAsync } from ${JSON.stringify(join(root, 'scripts/qa/core.ts'))};
    const args = process.argv.slice(2);
    const captureFixtureEnvironment = phase => {
      if (process.env.QA_HARNESS_CAPTURE_FIXTURE !== '1') return;
      const keys = ['REZICS_FIXTURE_ROOT', 'G727_LAUNCH_FIXTURE', 'G727_LAUNCH_PREPARATION_MS',
        'ERASURE_CAMPAIGN_PROFILE', 'ERASURE_CAMPAIGN_FIXTURE', 'ERASURE_CAMPAIGN_SOURCES', 'ERASURE_CAMPAIGN_COPY'];
      const values = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      appendFileSync(join(process.env.QA_HARNESS_CONTROL, process.env.QA_HARNESS_NAME + '-fixture-events'),
        JSON.stringify({ phase, args, values }) + '\\n');
    };
    if (['scripts/qa/test.ts', 'scripts/qa/cli.ts'].includes(args[0]) || process.env.QA_HARNESS_REAL_HOST_TEST === '1' && args[0] === 'test') {
      const forwardedEnv = process.env.QA_HARNESS_REAL_HOST_TEST === '1' && args[0] === 'test'
        ? { ...process.env, QA_HARNESS_SLOT_OWNER: String(process.ppid) } : process.env;
      const result = await commandAsync(${JSON.stringify(root)}, process.execPath, args, ${PROCESS_HANG_MS}, forwardedEnv,
        line => {
          console.log(line);
          if (line.startsWith('Admitted; QA memory:')) writeFileSync(join(process.env.QA_HARNESS_CONTROL, process.env.QA_HARNESS_NAME + '-admitted'), '');
        }, { runDeadline: Number(process.env.REZICS_QA_MEMORY_DEADLINE) });
      if (args[0] === 'test') writeFileSync(join(process.env.QA_HARNESS_CONTROL, process.env.QA_HARNESS_NAME + '-host-finished'), '');
      process.exitCode = result.ok ? 0 : 1;
    } else if (args[0] === 'scripts/fixture/cli.ts') {
      captureFixtureEnvironment('prepare');
      if (process.env.QA_HARNESS_FAIL_FIXTURE_PREPARATION === '1') {
        writeFileSync(join(process.env.QA_HARNESS_CONTROL, process.env.QA_HARNESS_NAME + '-prepare-failed'), '');
        process.exitCode = 1;
      } else {
        await withQaStackStartup(${JSON.stringify(root)}, process.env, undefined, () => {
          const owner = readFileSync(join(process.env.GOAL_QA_SLOT_DIRECTORY, '0', 'pid'), 'utf8');
          if (owner !== String(process.ppid)) throw new Error('Fixture preparation started without its lease');
          writeFileSync(args[args.indexOf('--evidence') + 1], JSON.stringify({
            fixture: process.env.QA_HARNESS_PREPARED_FIXTURE ?? 'prepared-source', elapsedMs: 0,
          }));
          writeFileSync(join(process.env.QA_HARNESS_CONTROL, process.env.QA_HARNESS_NAME + '-prepared'), '');
        }, { lockFile: ${JSON.stringify(lockFile)}, pollMs: 10, readingMaxAgeMs: 0, readLoad: () => 0,
          read: async () => ({ vmTotal: 64 * 1024 ** 3, vmUsed: 0, hostAvailable: 64 * 1024 ** 3 }) });
      }
    } else if (args[0] === 'test') {
      captureFixtureEnvironment('test');
      const result = await commandAsync(${JSON.stringify(root)}, 'bun', ['scripts/dev/cli.ts', 'stack:up'], ${PROCESS_HANG_MS},
        { ...process.env, QA_HARNESS_SLOT_OWNER: process.env.QA_HARNESS_SLOT_OWNER ?? String(process.ppid) });
      console.log(result.output);
      if (process.env.QA_HARNESS_REPEAT === '1') {
        const next = await commandAsync(${JSON.stringify(root)}, 'bun', ['scripts/dev/cli.ts', 'stack:up'], ${PROCESS_HANG_MS},
          { ...process.env, QA_HARNESS_SLOT_OWNER: process.env.QA_HARNESS_SLOT_OWNER ?? String(process.ppid) });
        console.log(next.output);
      }
      process.exitCode = 1;
    } else {
    if (args[0] !== 'scripts/dev/cli.ts') throw new Error('Unexpected non-stack command: ' + args.join(' '));
    if (args[1] === 'stack:up') {
      captureFixtureEnvironment('stack-up');
      const control = process.env.QA_HARNESS_CONTROL;
      const name = process.env.QA_HARNESS_NAME;
      await withQaStackStartup(${JSON.stringify(root)}, process.env, undefined, async () => {
        const leases = readdirSync(process.env.GOAL_QA_SLOT_DIRECTORY).filter(name => /^\\d+$/.test(name));
        if (!leases.some(name => Number(readFileSync(join(process.env.GOAL_QA_SLOT_DIRECTORY, name, 'pid'), 'utf8')) === Number(process.env.QA_HARNESS_SLOT_OWNER ?? process.ppid)))
          throw new Error('Stack started without its runner slot');
        writeFileSync(join(control, name + '-started'), process.env.QA_HARNESS_SLOT_OWNER ?? String(process.ppid));
        appendFileSync(join(control, name + '-startups'), String(process.pid) + '\\n');
        while (!existsSync(join(control, name + '-finish'))) await Bun.sleep(10);
        throw new Error('Intentional stack startup stub failure');
      }, { lockFile: ${JSON.stringify(lockFile)}, pollMs: 10, readingMaxAgeMs: 0, readLoad: () => 0,
        announce: message => {
          console.log(message);
          // Captured output can be replayed in the same chunk before reservation finishes.
          if (message.startsWith('QA_STARTUP_SLOT_READY')) {
            appendFileSync(join(process.env.QA_HARNESS_CONTROL, process.env.QA_HARNESS_NAME + '-requests'), message + '\\n');
            console.log(message);
          }
        },
        read: async () => ({ vmTotal: 64 * 1024 ** 3, vmUsed: existsSync(join(control, name + '-memory')) ? 0 : 64 * 1024 ** 3,
          hostAvailable: 64 * 1024 ** 3 }) });
    } else if (!['stack:reset', 'stack:logs'].includes(args[1])) throw new Error('Unexpected stack operation');
    }
  `);
  chmodSync(executable, 0o755);
  // Execute the selected native test, refusing its actual resource startup before any data exists.
  const nativeStartup = `#!${process.execPath}
    import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
    import { basename, dirname, join } from 'node:path';
    const args = process.argv.slice(2);
    if (basename(process.argv[1]) === 'docker') {
      // Daemon discovery precedes resource startup. Refusing it would exercise
      // the real 60-second retry loop rather than the resource lease boundary.
      if (args[0] === 'info') { console.log('fixture-engine'); process.exit(0); }
      const filterAt = args.indexOf('--filter');
      const filter = filterAt >= 0 ? String(args[filterAt + 1] ?? '') : '';
      const reapList = args[0] === 'ps' && (filter.startsWith('label=rezics.reap-owner')
        || filter.startsWith('label=rezics.reap-scope.'))
        || (args[0] === 'volume' || args[0] === 'network') && args[1] === 'ls'
          && filter.startsWith('label=rezics.reap-owner');
      // Ids come from that listing. A named rm is still resource startup.
      const reapRemove = args[0] === 'rm' && args[1] === '-f' && args.length > 2
        && args.slice(2).every(id => /^[0-9a-f]{12,64}$/.test(id));
      if ((args[0] === 'ps' && args[1] === '-a') || reapList || reapRemove) process.exit(0);
    }
    const control = process.env.QA_HARNESS_CONTROL;
    const name = process.env.QA_HARNESS_NAME;
    writeFileSync(join(control, name + '-resource-attempt'), '');
    if (process.env.REZICS_QA_STARTUP_SLOT_GATE) throw new Error('Native startup requires host admission, not an event gate');
    const owner = readFileSync(join(process.env.GOAL_QA_SLOT_DIRECTORY, '0', 'pid'), 'utf8');
    if (owner !== process.env.QA_HARNESS_SLOT_OWNER) throw new Error('Native resource started without its runner lease');
    writeFileSync(join(control, name + '-started'), owner);
    while (!existsSync(join(control, name + '-finish'))) await Bun.sleep(10);
    if (basename(process.argv[1]) === 'initdb') {
      const data = args[args.indexOf('-D') + 1];
      if (!data.startsWith(${JSON.stringify(join(root, '.temp') + '/')})) throw new Error('Native data escaped its checkout');
      rmSync(dirname(data), { recursive: true, force: true });
    }
    console.error('Intentional native startup stub failure');
    process.exit(1);
  `;
  for (const tool of ['initdb', 'docker']) {
    const path = join(directory, tool);
    writeFileSync(path, nativeStartup);
    chmodSync(path, 0o755);
  }
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const launch = (name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...inheritedEnvironment,
        PATH: `${directory}:${inheritedEnvironment.PATH}`, GOAL_QA_SLOT_DIRECTORY: slots, GOAL_QA_SLOTS: '1',
        GOAL_QA_WAIT_DIR: join(slots, 'waiters'), GOAL_QA_HEAVY_RUN: '0', GOAL_IN_SLOT: '0',
        REZICS_QA_ARTIFACT_ROOT: join(directory, 'artifacts'), REZICS_FIXTURE_ROOT: join(directory, 'fixture'),
        G727_LAUNCH_PROFILE: undefined, G727_LAUNCH_SOURCE_RUN_ID: undefined, G727_LAUNCH_FIXTURE: undefined,
        ERASURE_CAMPAIGN_PROFILE: undefined, ERASURE_CAMPAIGN_FIXTURE: undefined,
        ERASURE_CAMPAIGN_SOURCES: undefined, ERASURE_CAMPAIGN_COPY: undefined,
        REZICS_QA_MEMORY_DEADLINE: String(Date.now() + PROCESS_HANG_MS),
        QA_HARNESS_CONTROL: control, QA_HARNESS_NAME: name, ...extraEnv,
      },
    });
    children.push(child);
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { child, output };
  };
  const start = (name: string, tier = 'model', files: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) =>
    launch(name, ['scripts/qa/cli.ts', '--tier', tier, ...files.flatMap(file => ['--file', file])], extraEnv);
  const startArgs = (name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    launch(name, ['scripts/qa/cli.ts', ...args], extraEnv);
  const startGoal = (name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    launch(name, ['scripts/goal/goalctl.ts', 'test', ...args], extraEnv);
  return { slots, control, lockFile, start, startArgs, startGoal, async stop() {
    for (const child of children) { if (child.exitCode === null) child.kill(); }
    await Promise.all(children.map(child => child.exited));
  } };
}

async function until(predicate: () => boolean, description: string,
  run?: { child: ReturnType<typeof Bun.spawn>; output: Promise<string[]> }): Promise<void> {
  const deadline = Date.now() + PROCESS_HANG_MS;
  while (!predicate()) {
    if (run && run.child.exitCode !== null) {
      throw new Error(`Runner exited ${run.child.exitCode} while waiting for ${description}: ${(await run.output).join('\n')}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

type FixtureHarnessEvent = { phase: string; args: string[]; values: Record<string, string | undefined> };

function fixtureHarnessEvents(harness: ReturnType<typeof startupHarness>, name: string): FixtureHarnessEvent[] {
  const path = join(harness.control, `${name}-fixture-events`);
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as FixtureHarnessEvent) : [];
}

function startFaultRecoverySelection(harness: ReturnType<typeof startupHarness>, name: string,
  files: string[], environment: NodeJS.ProcessEnv = {}) {
  const args = ['--tier', 'fault/recovery', ...files.flatMap(file => ['--file', file])];
  writeFileSync(join(harness.control, `${name}-memory`), '');
  return harness.startArgs(name, args, { QA_HARNESS_CAPTURE_FIXTURE: '1', ...environment });
}

async function failFaultRecoveryAtStartup(harness: ReturnType<typeof startupHarness>, name: string,
  run: ReturnType<typeof startFaultRecoverySelection>): Promise<void> {
  try {
    await Promise.race([
      until(() => existsSync(join(harness.control, `${name}-started`)), 'fault/recovery shard startup'),
      run.child.exited.then(async code => {
        throw new Error(`QA runner exited ${code} before shard startup: ${(await run.output).join('\n')}`);
      }),
    ]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Timed out waiting for fault/recovery shard startup')) throw error;
    const events = fixtureHarnessEvents(harness, name);
    const waits = qaWaitStatusLines(harness.slots);
    throw new Error(`${error.message}; fixture events: ${JSON.stringify(events)}; QA waits: ${JSON.stringify(waits)}`);
  }
  writeFileSync(join(harness.control, `${name}-finish`), '');
  expect(await run.child.exited).toBe(1);
}

for (const entry of ['CLI', 'goalctl test']) {
for (const tier of ['model', 'integration', 'fault/recovery']) {
  test(`real ${entry} ${tier} holds no slot during memory shortage and starts after admission`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-cli-memory-order-'));
    const harness = startupHarness(directory);
    try {
      const files = tier === 'integration' ? ['tests/qa/integration/access-download-api.test.ts']
        : tier === 'fault/recovery' ? ['tests/qa/fault-recovery/content-rebuild.test.ts'] : ['model/tests/native-equivalence.test.ts'];
      const run = entry === 'CLI' ? harness.start('waiting', tier, files)
        : harness.startGoal('waiting', tier === 'model' ? ['--tier', tier, '--file', files[0]!] : files);
      await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting; QA memory:')), 'memory wait');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
      const other = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, process.pid, { deadline: Date.now() });
      expect(other.count).toBe(1);
      other.release();
      writeFileSync(join(harness.control, 'waiting-memory'), '');
      await until(() => existsSync(join(harness.control, 'waiting-started')), 'admitted stack startup');
      expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(readFileSync(join(harness.control, 'waiting-started'), 'utf8'));
      if (entry === 'goalctl test') expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).not.toBe(String(run.child.pid));
      // Readiness is still running: the lifetime lease remains held.
      expect(qaWaitStatusLines(harness.slots)).toEqual([]);
      writeFileSync(join(harness.control, 'waiting-finish'), '');
      expect(await run.child.exited).toBe(1);
      const output = (await run.output).join('\n');
      expect(output).toContain('QA artifacts:');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
    } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
  }, PROCESS_HANG_MS * 4);
}
}

for (const file of [
  'services/account/tests/account-pitr.integration.test.ts',
  'services/account/tests/account-access-recovery.integration.test.ts',
  'services/main/tests/access-pitr.integration.test.ts',
  'services/main/tests/content-recovery.integration.test.ts',
  'tests/qa/fault-recovery/search-ops-quickstart.test.ts',
]) {
  test(`goalctl native startup waits for its host-admitted lease: ${file}`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-native-slot-'));
    const harness = startupHarness(directory);
    const holder = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
    const slot = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, holder.pid);
    try {
      // This case blocks on the runner lease, not a second, synthetic memory shortage.
      writeFileSync(join(harness.control, 'native-memory'), '');
      const run = harness.startGoal('native', [file], { QA_HARNESS_REAL_HOST_TEST: '1' });
      await until(() => existsSync(join(harness.control, 'native-admitted')), 'host memory admission');
      await until(() => qaWaitStatusLines(harness.slots).some(line => line.startsWith('QA waiting for slot:')),
        'native slot wait after host memory admission');
      expect(existsSync(join(harness.control, 'native-resource-attempt'))).toBe(false);
      expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(String(holder.pid));
      slot.release();
      await Promise.race([until(() => existsSync(join(harness.control, 'native-started')), 'native resource lease'),
        run.child.exited.then(async code => { throw new Error(`Native runner exited ${code}: ${(await run.output).join('\n')}`); })]);
      expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(readFileSync(join(harness.control, 'native-started'), 'utf8'));
      writeFileSync(join(harness.control, 'native-finish'), '');
      expect(await run.child.exited).toBe(1);
      expect((await run.output).join('\n')).toContain('QA artifacts:');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
    } finally {
      slot.release(); holder.kill(); await holder.exited;
      await harness.stop(); rmSync(directory, { recursive: true, force: true });
    }
  }, PROCESS_HANG_MS * 4);
}

test('goalctl successive startup processes restart their sequences after a slot retry', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-startup-request-identity-'));
  const harness = startupHarness(directory);
  const holder = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  const slot = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, holder.pid);
  const requests = () => {
    const path = join(harness.control, 'successive-requests');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => line.split(' ')) : [];
  };
  try {
    writeFileSync(join(harness.control, 'successive-memory'), '');
    const run = harness.startGoal('successive', ['tests/qa/fault-recovery/work-title-control.test.ts'], { QA_HARNESS_REPEAT: '1' });
    await until(() => requests().some(parts => Number(parts.at(-1)) >= 2), 'startup retry beyond sequence one');
    expect(existsSync(join(harness.control, 'successive-started'))).toBe(false);
    slot.release();
    await until(() => existsSync(join(harness.control, 'successive-started')), 'first startup');
    writeFileSync(join(harness.control, 'successive-finish'), '');
    await until(() => readFileSync(join(harness.control, 'successive-startups'), 'utf8').trim().split('\n').length === 2,
      'second startup with a reset sequence');
    expect(await run.child.exited).toBe(1);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    const identities = [...new Set(requests().map(parts => parts[2]))];
    expect(identities).toHaveLength(2);
    expect(requests().filter(parts => parts[2] === identities[1]).map(parts => parts[3])).toEqual(['1']);
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
  } finally {
    slot.release(); holder.kill(); await holder.exited;
    await harness.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, PROCESS_HANG_MS * 4);

for (const blockedBy of ['memory', 'startup']) {
  test(`completed host tier releases its lease before model ${blockedBy} admission`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-host-stack-transition-'));
    const harness = startupHarness(directory);
    const priorId = `host-stack-${randomUUID().slice(0, 8)}`;
    const prior = join(directory, 'prior');
    const priorLink = join(root, '.artifacts', 'qa', priorId);
    const mutex = new Database(harness.lockFile, { create: true });
    mkdirSync(prior);
    mkdirSync(join(root, '.artifacts', 'qa'), { recursive: true });
    symlinkSync(prior, priorLink, 'dir');
    writeFileSync(join(prior, 'acceptance.json'), JSON.stringify({ tiers: [
      { name: 'unit', status: 'failed' }, { name: 'model', status: 'failed' },
    ] }));
    writeFileSync(join(prior, 'unit.xml'), '<testsuite><testcase file="tests/qa/unit/memory-admission.test.ts" '
      + 'name="memory readings sum actual container use, use Docker VM total and host MemAvailable"><failure/></testcase></testsuite>');
    writeFileSync(join(prior, 'model.xml'), '<testsuite><testcase file="model/tests/native-equivalence.test.ts" '
      + 'name="QA file did not complete"><failure/></testcase></testsuite>');
    try {
      if (blockedBy === 'startup') {
        mutex.exec('BEGIN IMMEDIATE');
        writeFileSync(join(harness.control, 'transition-memory'), '');
      }
      const run = harness.startArgs('transition', ['--only-failed', priorId], { QA_HARNESS_REAL_HOST_TEST: '1' });
      await until(() => existsSync(join(harness.control, 'transition-host-finished')), 'completed host tier');
      await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes(
        blockedBy === 'memory' ? 'Waiting; QA memory:' : 'Waiting for another QA startup')), 'blocked model startup');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
      const other = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, process.pid, { deadline: Date.now() });
      other.release();
      if (blockedBy === 'startup') mutex.exec('ROLLBACK');
      else writeFileSync(join(harness.control, 'transition-memory'), '');
      await until(() => existsSync(join(harness.control, 'transition-started')), 'model startup after admission');
      expect(existsSync(join(harness.slots, '0'))).toBe(true);
      writeFileSync(join(harness.control, 'transition-finish'), '');
      expect(await run.child.exited).toBe(1);
      expect((await run.output).join('\n')).toContain('| unit | passed |');
      expect(existsSync(join(harness.slots, '0'))).toBe(false);
    } finally {
      mutex.close(true); await harness.stop();
      rmSync(priorLink, { force: true }); rmSync(directory, { recursive: true, force: true });
    }
  }, PROCESS_HANG_MS * 4);
}

test('an erasure-only selection prepares its default small fixture before the shard', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-erasure-fixture-preparation-'));
  const harness = startupHarness(directory);
  const campaign = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
  try {
    const run = startFaultRecoverySelection(harness, 'erasure-only', [campaign], {
      QA_HARNESS_PREPARED_FIXTURE: 'fixture-erasure-prepared',
    });
    await failFaultRecoveryAtStartup(harness, 'erasure-only', run);
    const events = fixtureHarnessEvents(harness, 'erasure-only');
    const preparation = events.find(event => event.phase === 'prepare');
    const shard = events.find(event => event.phase === 'stack-up');
    expect(events.filter(event => event.phase === 'prepare')).toHaveLength(1);
    expect(preparation?.args).toContain('--prepare');
    expect(preparation?.args).toContain('--profile');
    expect(preparation?.args).toContain('small');
    expect(shard?.values.ERASURE_CAMPAIGN_FIXTURE).toBe('fixture-erasure-prepared');
    expect(shard?.values.REZICS_FIXTURE_ROOT).toBe(join(directory, 'fixture'));
    expect(events.findIndex(event => event.phase === 'prepare'))
      .toBeLessThan(events.findIndex(event => event.phase === 'stack-up'));
  } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);

test('launch and erasure share one prepared small fixture across their selected shards', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-shared-fixture-preparation-'));
  const harness = startupHarness(directory);
  const campaign = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
  const launch = 'tests/qa/fault-recovery/g-727-launch-drill.test.ts';
  try {
    const run = startFaultRecoverySelection(harness, 'shared-fixture', [launch, campaign], {
      QA_HARNESS_PREPARED_FIXTURE: 'fixture-shared-small',
    });
    await failFaultRecoveryAtStartup(harness, 'shared-fixture', run);
    const events = fixtureHarnessEvents(harness, 'shared-fixture');
    const shardEvents = events.filter(event => event.phase === 'stack-up' || event.phase === 'test');
    expect(events.filter(event => event.phase === 'prepare')).toHaveLength(1);
    expect(shardEvents.length).toBeGreaterThanOrEqual(2);
    expect(shardEvents.every(event => event.values.G727_LAUNCH_FIXTURE === 'fixture-shared-small'
      && event.values.ERASURE_CAMPAIGN_FIXTURE === 'fixture-shared-small')).toBe(true);
  } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);

test('a supplied launch fixture does not suppress erasure small-fixture preparation', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-independent-fixture-needs-'));
  const harness = startupHarness(directory);
  const campaign = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
  const launch = 'tests/qa/fault-recovery/g-727-launch-drill.test.ts';
  try {
    const run = startFaultRecoverySelection(harness, 'independent-fixture-needs', [launch, campaign], {
      G727_LAUNCH_FIXTURE: 'fixture-launch-caller',
      QA_HARNESS_PREPARED_FIXTURE: 'fixture-erasure-prepared',
    });
    await failFaultRecoveryAtStartup(harness, 'independent-fixture-needs', run);
    const events = fixtureHarnessEvents(harness, 'independent-fixture-needs');
    const shardEvents = events.filter(event => event.phase === 'stack-up' || event.phase === 'test');
    expect(events.filter(event => event.phase === 'prepare')).toHaveLength(1);
    expect(shardEvents.length).toBeGreaterThanOrEqual(2);
    expect(shardEvents.every(event => event.values.G727_LAUNCH_FIXTURE === 'fixture-launch-caller'
      && event.values.ERASURE_CAMPAIGN_FIXTURE === 'fixture-erasure-prepared')).toBe(true);
  } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);

for (const scenario of [
  { name: 'explicit fixture', environment: { ERASURE_CAMPAIGN_FIXTURE: 'fixture-caller-retained' }, expected: 'fixture-caller-retained' },
  { name: 'explicit source copy', environment: { ERASURE_CAMPAIGN_SOURCES: 'fixture-caller-source', ERASURE_CAMPAIGN_COPY: '0' }, expected: undefined },
  { name: 'medium profile', environment: { ERASURE_CAMPAIGN_PROFILE: 'medium' }, expected: undefined },
  { name: 'empty malformed fixture', environment: { ERASURE_CAMPAIGN_FIXTURE: '' }, expected: '' },
]) {
  test(`erasure ${scenario.name} bypasses automatic small-fixture preparation`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-erasure-fixture-bypass-'));
    const harness = startupHarness(directory);
    const campaign = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
    try {
      const run = startFaultRecoverySelection(harness, 'fixture-bypass', [campaign], scenario.environment);
      await failFaultRecoveryAtStartup(harness, 'fixture-bypass', run);
      const events = fixtureHarnessEvents(harness, 'fixture-bypass');
      expect(events.filter(event => event.phase === 'prepare')).toHaveLength(0);
      const shard = events.find(event => event.phase === 'stack-up');
      if (scenario.expected === undefined) {
        expect(shard?.values.ERASURE_CAMPAIGN_FIXTURE).toBeUndefined();
      } else {
        expect(shard?.values.ERASURE_CAMPAIGN_FIXTURE).toBe(scenario.expected);
      }
      for (const [key, value] of Object.entries(scenario.environment)) expect(shard?.values[key]).toBe(value);
    } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
  }, PROCESS_HANG_MS * 4);
}

test('failed small-fixture preparation stops before any erasure shard starts', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-erasure-fixture-preparation-failure-'));
  const harness = startupHarness(directory);
  const campaign = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
  try {
    const run = startFaultRecoverySelection(harness, 'failed-preparation', [campaign], {
      QA_HARNESS_FAIL_FIXTURE_PREPARATION: '1',
    });
    await until(() => existsSync(join(harness.control, 'failed-preparation-prepare-failed')),
      'fixture preparation failure');
    expect(await run.child.exited).toBe(1);
    const events = fixtureHarnessEvents(harness, 'failed-preparation');
    expect(events.filter(event => event.phase === 'prepare')).toHaveLength(1);
    expect(events.some(event => event.phase === 'stack-up' || event.phase === 'test')).toBe(false);
    expect(existsSync(join(harness.control, 'failed-preparation-started'))).toBe(false);
    const output = (await run.output).join('\n');
    const artifacts = /QA artifacts: (.+)/.exec(output)?.[1];
    expect(artifacts).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(artifacts!, 'acceptance.json'), 'utf8'));
    expect(manifest.tiers).toContainEqual(expect.objectContaining({ name: 'fault/recovery', status: 'failed' }));
    expect(readFileSync(join(artifacts!, 'fault-recovery.xml'), 'utf8')).toContain('Small-fixture preparation failed');
  } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);

test('finished fixture preparation releases its lease before drill startup admission', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-preparation-stack-transition-'));
  // A surrounding gate's retained source must not bypass this preparation.
  const harness = startupHarness(directory, { ...process.env,
    G727_LAUNCH_SOURCE_RUN_ID: 'inherited-source', G727_LAUNCH_FIXTURE: 'inherited-fixture',
  });
  const drill = [...selfManagedFaultFiles].find(file => file.endsWith('launch-drill.test.ts'))!;
  try {
    expect(drill).toBeDefined();
    const run = harness.startGoal('preparation', [drill], {
      G727_LAUNCH_PROFILE: 'small',
    });
    await until(() => existsSync(join(harness.control, 'preparation-prepared')), 'stopped prepared source', run);
    await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting; QA memory:')), 'drill memory wait', run);
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    const other = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, process.pid, { deadline: Date.now() });
    other.release();
    writeFileSync(join(harness.control, 'preparation-memory'), '');
    await until(() => existsSync(join(harness.control, 'preparation-started')), 'drill startup after admission', run);
    expect(existsSync(join(harness.slots, '0'))).toBe(true);
    writeFileSync(join(harness.control, 'preparation-finish'), '');
    expect(await run.child.exited).toBe(1);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
  } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);

test('real QA CLI retries fresh memory admission while its slot is busy', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-cli-slot-retry-'));
  const harness = startupHarness(directory);
  const holder = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)']);
  const slot = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' }, holder.pid);
  try {
    writeFileSync(join(harness.control, 'waiting-memory'), '');
    const run = harness.start('waiting');
    await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting for a QA slot after memory admission')),
      'slot wait after admission');
    // Existing workloads can consume memory while slots are busy. Admission must be fresh on retry.
    rmSync(join(harness.control, 'waiting-memory'));
    slot.release();
    await until(() => qaWaitStatusLines(harness.slots).some(line => line.includes('Waiting; QA memory:')), 'fresh shortage');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    expect(existsSync(join(harness.control, 'waiting-started'))).toBe(false);
    writeFileSync(join(harness.control, 'waiting-memory'), '');
    await until(() => existsSync(join(harness.control, 'waiting-started')), 'recovered startup');
    writeFileSync(join(harness.control, 'waiting-finish'), '');
    expect(await run.child.exited).toBe(1);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
  } finally {
    slot.release(); holder.kill(); await holder.exited;
    await harness.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, PROCESS_HANG_MS * 4);

for (const tier of ['integration', 'fault/recovery']) {
test(`real QA CLI ${tier} shards reuse their inherited one-slot lease`, async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-cli-inherited-'));
  const harness = startupHarness(directory);
  const inherited = await acquireQaSlots(harness.slots, 1, { GOAL_QA_SLOTS: '1' });
  try {
    writeFileSync(join(harness.control, 'inherited-memory'), '');
    const run = harness.start('inherited', tier, [tier === 'integration' ? 'tests/qa/integration/access-download-api.test.ts'
      : 'tests/qa/fault-recovery/content-rebuild.test.ts'],
      { GOAL_IN_SLOT: '1', QA_HARNESS_SLOT_OWNER: String(process.pid), QA_HARNESS_REPEAT: '1' });
    await until(() => existsSync(join(harness.control, 'inherited-started')), 'startup with inherited lease');
    writeFileSync(join(harness.control, 'inherited-finish'), '');
    expect(await run.child.exited).toBe(1);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(String(process.pid));
  } finally {
    inherited.release(); await harness.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, PROCESS_HANG_MS * 4);
}

test('independent projects owned by one runner keep distinct leases', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-project-leases-'));
  const env = { GOAL_QA_SLOTS: '2' };
  const first = await acquireQaSlots(directory, 1, env);
  try {
    const second = await acquireQaSlots(directory, 1, env, process.pid, { inherit: false, deadline: Date.now() });
    try {
      expect(existsSync(join(directory, '0'))).toBe(true);
      expect(existsSync(join(directory, '1'))).toBe(true);
      first.release();
      expect(existsSync(join(directory, '1'))).toBe(true);
    } finally { second.release(); }
  } finally { first.release(); rmSync(directory, { recursive: true, force: true }); }
});

for (const entry of ['CLI', 'goalctl test']) {
test(`real ${entry} startup contenders hold no slots until their startup turn`, async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-cli-startup-order-'));
  const harness = startupHarness(directory);
  const mutex = new Database(harness.lockFile, { create: true });
  try {
    mutex.exec('BEGIN IMMEDIATE');
    writeFileSync(join(harness.control, 'first-memory'), '');
    writeFileSync(join(harness.control, 'second-memory'), '');
    const start = (name: string) => entry === 'CLI' ? harness.start(name)
      : harness.startGoal(name, ['--tier', 'model', '--file', 'model/tests/native-equivalence.test.ts']);
    const first = start('first'), second = start('second');
    await until(() => qaWaitStatusLines(harness.slots).filter(line => line.includes('Waiting for another QA startup')).length === 2,
      'both startup contenders');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    mutex.exec('ROLLBACK');
    await until(() => ['first', 'second'].some(name => existsSync(join(harness.control, name + '-started'))), 'first startup');
    const leader = existsSync(join(harness.control, 'first-started')) ? 'first' : 'second';
    const follower = leader === 'first' ? 'second' : 'first';
    expect(existsSync(join(harness.control, follower + '-started'))).toBe(false);
    writeFileSync(join(harness.control, leader + '-finish'), '');
    await until(() => existsSync(join(harness.control, follower + '-started')), 'next startup');
    writeFileSync(join(harness.control, follower + '-finish'), '');
    expect(await first.child.exited).toBe(1);
    expect(await second.child.exited).toBe(1);
    for (const output of [await first.output, await second.output]) expect(output.join('\n')).toContain('QA artifacts:');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
    expect(qaWaitStatusLines(harness.slots)).toEqual([]);
  } finally { mutex.close(true); await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);
}

test('goalctl bounded owner tier delegates a CLI-owned slot after host admission', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-goal-unit-slot-'));
  const harness = startupHarness(directory);
  const file = join(directory, 'selected.test.ts');
  writeFileSync(file, `import { expect, test } from 'bun:test';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    test('host tier owns its runner lease', async () => {
      expect(readFileSync(join(process.env.GOAL_QA_SLOT_DIRECTORY!, '0', 'pid'), 'utf8')).toBe(process.env.QA_HARNESS_SLOT_OWNER!);
      writeFileSync(join(process.env.QA_HARNESS_CONTROL!, 'host-started'), process.env.QA_HARNESS_SLOT_OWNER!);
      while (!existsSync(join(process.env.QA_HARNESS_CONTROL!, 'host-finish'))) await Bun.sleep(10);
    });`);
  try {
    const run = harness.startGoal('host', ['--tier', 'owner', '--file', file], { QA_HARNESS_REAL_HOST_TEST: '1' });
    await Promise.race([until(() => existsSync(join(harness.control, 'host-started')), 'host runner lease'),
      run.child.exited.then(async code => { throw new Error(`Host runner exited ${code}: ${(await run.output).join('\n')}`); })]);
    expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).toBe(readFileSync(join(harness.control, 'host-started'), 'utf8'));
    expect(readFileSync(join(harness.slots, '0', 'pid'), 'utf8')).not.toBe(String(run.child.pid));
    writeFileSync(join(harness.control, 'host-finish'), '');
    expect(await run.child.exited).toBe(0);
    expect((await run.output).join('\n')).toContain('QA artifacts:');
    expect(existsSync(join(harness.slots, '0'))).toBe(false);
  } finally { await harness.stop(); rmSync(directory, { recursive: true, force: true }); }
}, PROCESS_HANG_MS * 4);

for (const inherited of [false, true]) {
  test(`QA harness ${inherited ? 'inherited' : 'direct'} slot waits appear in Goal status until admitted`, async () => {
    const directory = mkdtempSync(join(root, '.temp', 'qa-harness-status-'));
    const holder = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)']);
    const statusDirectory = inherited ? join(directory, 'inherited') : directory;
    const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_ID: 'program', GOAL_QA_SLOTS: '1',
      ...(inherited ? { GOAL_QA_WAIT_DIR: join(statusDirectory, 'waiters'), GOAL_QA_COMMAND: 'task qa -- --tier model' } : {}) };
    try {
      mkdirSync(join(directory, '0'));
      writeFileSync(join(directory, '0', 'pid'), String(holder.pid));
      const acquire = harnessAdmission(env, directory);
      const waiterDirectory = env.GOAL_QA_WAIT_DIR!;
      const command = inherited ? 'task qa -- --tier model' : 'bun scripts/qa/cli.ts --tier model';
      let polls = 0;
      const slots = await acquire(1, { announce: () => {}, sleep: async () => {
        polls++;
        // The ordered ticket stands beside the wait's own record; the status shows the run once.
        const files = readdirSync(waiterDirectory).filter(name => !name.startsWith('ordered-slot-'));
        expect(files).toHaveLength(1);
        const record = JSON.parse(readFileSync(join(waiterDirectory, files[0]!), 'utf8')) as { since: string };
        expect(record).toMatchObject({ pid: process.pid, goal: 'program', command, waitingFor: 'slot' });
        expect(qaWaitStatusLines(statusDirectory)).toEqual([
          `QA waiting for slot: Goal program (pid ${process.pid}): ${command}; since ${record.since}; Waiting for a QA slot; all 1 slots are held`,
        ]);
        rmSync(join(directory, '0'), { recursive: true });
      } });
      try {
        expect(polls).toBe(1);
        expect(slots.count).toBe(1);
        expect(readdirSync(waiterDirectory)).toEqual([]);
      } finally { slots.release(); }
    } finally {
      holder.kill();
      await holder.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('QA harness slot failure removes its waiter record and exit hook', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-harness-status-deadline-'));
  const holder = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)']);
  const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_QA_SLOTS: '1' };
  let now = 0;
  const exitHooks = process.listenerCount('exit');
  try {
    mkdirSync(join(directory, '0'));
    writeFileSync(join(directory, '0', 'pid'), String(holder.pid));
    const acquire = harnessAdmission(env, directory);
    await expect(acquire(1, { now: () => now, deadline: 1, announce: () => {}, sleep: async () => {
      expect(qaWaitStatusLines(directory)).toHaveLength(1);
      now = 1;
    } })).rejects.toThrow('No QA slot became free before the deadline');
    expect(qaWaitStatusLines(directory)).toEqual([]);
    expect(process.listenerCount('exit')).toBe(exitHooks);
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('direct QA harness publishes memory waits through its inherited startup environment', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-harness-memory-status-'));
  const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_ID: 'program' };
  let now = 0;
  try {
    harnessAdmission(env, directory);
    await waitForMemory({ vm: 0, vmReserve: 0, host: 1, hostReserve: 0 }, {
      env: { ...env }, lockFile: join(directory, 'memory.sqlite'), readingMaxAgeMs: 0,
      deadline: 2, now: () => now, announce: () => {}, pollMs: 1,
      read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: now }),
      sleep: async ms => {
        const lines = qaWaitStatusLines(directory);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toStartWith(`QA waiting for memory: Goal program (pid ${process.pid}): bun scripts/qa/cli.ts --tier model; since 1970-01-01T00:00:00.000Z; Waiting; QA memory:`);
        now += ms;
      },
    });
    expect(qaWaitStatusLines(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('direct Storybook test dispatch publishes memory waits before launching browser workers', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-stories-memory-status-'));
  const story = 'packages/ui/src/components/badge.stories.tsx';
  const env: NodeJS.ProcessEnv = { REZICS_STACK_PROFILE: 'qa', GOAL_ID: 'program', GOAL_QA_SLOT_DIRECTORY: directory };
  let now = 0, started = false;
  try {
    const command = selectTestCommand([story]);
    const result = await dispatchTest([story], {
      env, deadline: 2,
      admission: (need, options) => waitForMemory(need, { ...options,
        lockFile: join(directory, 'memory.sqlite'), readingMaxAgeMs: 0,
        now: () => now, pollMs: 1, announce: () => {},
        read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: now ? need.host + need.hostReserve : 0 }),
        sleep: async ms => {
          expect(started).toBe(false);
          const lines = qaWaitStatusLines(directory);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toStartWith(`QA waiting for memory: Goal program (pid ${process.pid}): ${[command[0], ...command[1]].join(' ')}; since 1970-01-01T00:00:00.000Z; Waiting; QA memory:`);
          now += ms;
        },
      }),
      runner: async selected => { expect(selected).toEqual(command); started = true; return 0; },
    });
    expect(result).toBe(0);
    expect(started).toBe(true);
    expect(qaWaitStatusLines(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('QA resets every child stack after failure and retains failed resets for retry', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-ownership-'));
  try {
    const live = { profile: 'qa' as const, runId: 'title-test-l' };
    const restored = { profile: 'qa' as const, runId: 'title-test-r', persistent: true };
    rememberQaStack(live, directory);
    rememberQaStack(restored, directory);
    expect(() => rememberQaStack({ profile: 'dev' }, directory)).toThrow('only start QA');
    const resets: string[][] = [];
    const failed = await cleanupQaStacks(directory, async args => {
      resets.push(args);
      if (args.includes(live.runId)) throw new Error('Docker unavailable');
    });
    expect(resets).toEqual([
      ['--profile', 'qa', '--run-id', live.runId],
      ['--profile', 'qa', '--run-id', restored.runId, '--persistent'],
    ]);
    expect(failed).toEqual(['rezics-qa-title-test-l.json: Docker unavailable']);
    expect(readdirSync(directory)).toEqual(['rezics-qa-title-test-l.json']);
    expect(await cleanupQaStacks(directory, async () => {})).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
    rememberQaStack(live, directory);
    forgetQaStack(live, directory);
    expect(await cleanupQaStacks(directory, async () => { throw new Error('already reset'); })).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('QA timeout kills child setup processes and the runner still resets both recorded sites', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'qa-timeout-'));
  const heartbeat = join(directory, 'heartbeat');
  try {
    const source = `import { rememberQaStack } from './scripts/qa/stack-ownership.ts';
      rememberQaStack({ profile: 'qa', runId: 'translation-test-l' });
      rememberQaStack({ profile: 'qa', runId: 'translation-test-r' });
      Bun.spawn([process.execPath, '-e', ${JSON.stringify(`import { appendFileSync } from 'node:fs';
        setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, '.'), 10);`)}],
        { stdout: 'inherit', stderr: 'inherit' });
      await Bun.sleep(10000);`;
    const result = await commandAsync(root, 'bun', ['-e', source], 500,
      { ...process.env, [QA_STACK_REGISTRY]: directory });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(existsSync(heartbeat)).toBe(true);
    const stopped = readFileSync(heartbeat, 'utf8');
    await Bun.sleep(50);
    expect(readFileSync(heartbeat, 'utf8')).toBe(stopped);
    const resets: string[] = [];
    expect(await cleanupQaStacks(directory, async args => { resets.push(args[3]!); })).toEqual([]);
    expect(resets).toEqual(['translation-test-l', 'translation-test-r']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dev stop retains custom isolated backends until their cleanup succeeds', () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const checkout = mkdtempSync(join(root, '.temp', 'dev-session-test-'));
  try {
    expect(startedDevStacks(checkout)).toEqual([]);
    const disposable = { profile: 'qa' as const, runId: 'wt-other-id', accountsApp: true };
    const persistent = { profile: 'qa' as const, runId: 'wt-persistent', persistent: true };
    rememberDevStack(checkout, disposable);
    rememberDevStack(checkout, persistent);
    rememberDevStack(checkout, disposable);
    expect(startedDevStacks(checkout).map(stack => stack.runId).sort()).toEqual(['wt-other-id', 'wt-persistent']);
    expect(devStackStopArgs(startedDevStacks(checkout)[0]!)).toEqual(['down', '--remove-orphans']);
    expect(devStackStopArgs(disposable)).toEqual(['down', '--volumes', '--remove-orphans']);
    expect(() => stopDevSession(checkout, () => {}, () => { throw new Error('Docker unavailable'); }))
      .toThrow('Docker unavailable');
    // An interrupted cleanup has no forget call: the next stop still sees both.
    expect(startedDevStacks(checkout)).toHaveLength(2);
    const stopped: string[] = [];
    // No --backend argument: stop everything the session remembers, even if
    // AppHost never finished starting. Preserve the host failure for diagnosis.
    expect(() => stopDevSession(checkout, () => { throw new Error('AppHost absent'); },
      stack => { stopped.push(stack.runId!); })).toThrow('AppHost absent');
    expect(stopped.sort()).toEqual(['wt-other-id', 'wt-persistent']);
    expect(startedDevStacks(checkout)).toEqual([]);
    expect(() => rememberDevStack(checkout, { profile: 'dev' })).toThrow('Only isolated');
  } finally { rmSync(checkout, { recursive: true, force: true }); }
});

test('browser runners have independent budgets scaled to the selected files', () => {
  const small = browserBudgets(1, 1);
  const full = browserBudgets(18, 137);
  expect(small.playwright).toBe(300_000);
  expect(full.playwright).toBeGreaterThan(small.playwright);
  expect(full.storybook).toBeGreaterThan(180_000);
  expect(browserBudgets(1, 137).playwright).toBe(small.playwright);
  expect(browserBudgets(18, 1).storybook).toBe(small.storybook);
  expect(() => browserBudgets(0, 1)).toThrow('positive integers');
  // Each engine project repeats the files, so the Playwright budget grows with them.
  expect(browserBudgets(1, 1, 3).playwright).toBe(3 * small.playwright);
  expect([browserProjectCount(undefined), browserProjectCount('desktop-chrome'), browserProjectCount('a,b'), browserProjectCount('all')]).toEqual([1, 1, 2, 3]);
  const selected = browserFileCounts(root, ['apps/web/tests/work-page.e2e.ts']);
  expect(selected.playwright).toBe(1);
  expect(selected.storybook).toBeGreaterThan(1);
});

test('goalctl test routes explicit stories and tier runs to their owning runner', () => {
  expect(selectTestCommand(['apps/web/features/manage/members.stories.tsx', '-t', 'Give Role']))
    .toEqual(['task', ['storybook:test', '--', 'features/manage/members.stories.tsx', '-t', 'Give Role']]);
  expect(selectTestCommand(['apps/accounts/features/account/personal-info.stories.tsx'])[1][0])
    .toBe('accounts:storybook:test');
  expect(() => selectTestCommand(['apps/web/features/manage/members.stories.tsx',
    'apps/accounts/features/account/personal-info.stories.tsx'])).toThrow('separately');
  expect(selectTestCommand(['--tier', 'unit'])).toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'unit']]);
  expect(() => selectTestCommand(['--tier', 'made-up'])).toThrow();
});

test('each tier bun test command carries that tier timeout', () => {
  expect(tierBunTestArgs('unit', ['tests/qa/unit'])).toEqual(['test', '--timeout=5000', 'tests/qa/unit']);
  expect(tierBunTestArgs('owner', ['scripts/dev/seed/api.test.ts'])).toEqual([
    'test', '--timeout=30000', 'scripts/dev/seed/api.test.ts']);
  expect(tierBunTestArgs('integration', ['tests/qa/integration/shared-stack.test.ts'])).toEqual([
    'test', '--timeout=60000', 'tests/qa/integration/shared-stack.test.ts']);
  expect(tierBunTestArgs('fault/recovery', ['tests/qa/fault-recovery/lost-response.test.ts'])).toEqual([
    'test', '--timeout=60000', 'tests/qa/fault-recovery/lost-response.test.ts']);
  const unit = 'tests/qa/unit/qa-harness.test.ts';
  const timeouts = (args: string[]) => args.filter(arg => arg === '--timeout' || arg.startsWith('--timeout='));
  expect(timeouts(selectTestCommand([unit])[1])).toEqual(['--timeout=5000']);
  expect(timeouts(selectTestCommand([unit, '--timeout=60000'])[1])).toEqual(['--timeout=60000']);
  const directory = mkdtempSync(join(root, '.temp', 'caller-timeout-'));
  const hang = join(directory, 'hang.test.ts');
  writeFileSync(hang, "import { test } from 'bun:test';\ntest('hang', () => {});\n");
  try {
    const detached = selectTestCommand([hang, '--timeout=60000']);
    expect(detached[0]).toBe('bun');
    expect(timeouts(detached[1])).toEqual(['--timeout=60000']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const owner = selectTestCommand(['--timeout=60000', 'scripts/dev/seed/api.test.ts']);
  expect(owner).toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'owner', '--file',
    'scripts/dev/seed/api.test.ts', '--timeout=60000']]);
  expect(parseArgs(owner[1].slice(1)).timeoutArgs).toEqual(['--timeout=60000']);
  expect(tierBunTestArgs('owner', ['scripts/dev/seed/api.test.ts', '--timeout=60000'])).toEqual([
    'test', '--timeout=60000', 'scripts/dev/seed/api.test.ts']);
  const spaced = selectTestCommand(['scripts/dev/seed/api.test.ts', '--timeout', '45000'])[1];
  expect(spaced.slice(-2)).toEqual(['--timeout', '45000']);
  expect(timeouts(spaced)).toEqual(['--timeout']);
  const mixed = selectTestCommand([unit, 'scripts/dev/seed/api.test.ts', '--timeout=60000']);
  expect(timeouts(mixed[1])).toEqual(['--timeout=60000']);
  expect(() => selectTestCommand([unit, '--timeout=1000', '--timeout=2000'])).toThrow('Pass one --timeout');
});

test('a case sleeping 7s passes in owner and fails in unit', async () => {
  const directory = mkdtempSync(join(root, '.temp', 'tier-test-timeout-'));
  const plain = join(directory, 'plain.test.ts');
  const explicit = join(directory, 'explicit.test.ts');
  const raised = join(directory, 'raised.test.ts');
  writeFileSync(plain, `import { test } from 'bun:test';\ntest('sleeps', async () => { await Bun.sleep(7_000); });\n`);
  writeFileSync(explicit, `import { test } from 'bun:test';\ntest('sleeps', async () => { await Bun.sleep(7_000); }, 1_000);\n`);
  writeFileSync(raised, `import { setDefaultTimeout, test } from 'bun:test';\nsetDefaultTimeout(20_000);\ntest('sleeps', async () => { await Bun.sleep(7_000); });\n`);
  const env = { ...process.env };
  delete env.AGENT;
  delete env.CLAUDECODE;
  delete env.REPL_ID;
  const run = async (tier: 'unit' | 'owner', file: string) => {
    const child = Bun.spawn([process.execPath, ...tierBunTestArgs(tier, [file])], {
      cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { status: await child.exited, output: `${stdout}\n${stderr}` };
  };
  try {
    const [owner, unit, explicitOwner, raisedUnit] = await Promise.all([
      run('owner', plain), run('unit', plain), run('owner', explicit), run('unit', raised),
    ]);
    expect(owner.status).toBe(0);
    expect(unit.status).not.toBe(0);
    expect(unit.output).toContain('timed out after 5000ms');
    // A case timeout and setDefaultTimeout keep their own values.
    expect(explicitOwner.status).not.toBe(0);
    expect(explicitOwner.output).toContain('timed out after 1000ms');
    expect(raisedUnit.status).toBe(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 45_000);


test('explicit selected hidden integration paths reach Bun and preserve failure', async () => {
  const directory = mkdtempSync(join(root, '.temp/explicit-bun-file-'));
  const file = 'tests/qa/integration/.temp/sentinel.test.ts';
  const name = 'EXPLICITFILE01 reached hidden selection';
  mkdirSync(join(directory, dirname(file)), { recursive: true });
  writeFileSync(join(directory, file),
    `import { expect, test } from 'bun:test';\n`
    + `import { writeFileSync } from 'node:fs';\n`
    + `writeFileSync(process.env.EXPLICIT_FILE_WITNESS, 'imported');\n`
    + `test(${JSON.stringify(name)}, () => expect(process.env.EXPLICIT_FILE_FAIL).not.toBe('yes'));\n`);
  const source = ts.createSourceFile('cli.ts', readFileSync(join(root, 'scripts/qa/cli.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const shard = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'runShardWork');
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'batchArgs')
      declarations.push(node);
    ts.forEachChild(node, visit);
  };
  if (!shard) throw new Error('Missing QA shard boundary');
  visit(shard);
  expect(declarations).toHaveLength(1);
  const initializer = declarations[0]!.initializer;
  if (!initializer) throw new Error('Missing QA Bun arguments');
  const boundary = ts.transpileModule(initializer.getText(source),
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  try {
    for (const failing of [false, true]) {
      const batch = [file];
      const batchFile = join(directory, failing ? 'failed.xml' : 'passed.xml');
      const witness = join(directory, failing ? 'failed-import' : 'passed-import');
      const args = new Script(boundary).runInNewContext({
        tierBunTestArgs, tier: 'integration', batch, flags: ['-t', '^EXPLICITFILE01'], batchFile, options: failing ? { timeoutArgs: ['--timeout=1234'] } : {},
      }) as string[];
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: directory, env: { ...process.env, CLAUDECODE: '1', EXPLICIT_FILE_WITNESS: witness,
          EXPLICIT_FILE_FAIL: failing ? 'yes' : 'no' }, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(),
        new Response(child.stderr).text()]);
      expect({ status, stdout, stderr }).toMatchObject({ status: failing ? 1 : 0 });
      expect(readFileSync(witness, 'utf8')).toBe('imported');
      const results = parseJUnit(readFileSync(batchFile, 'utf8'), 'integration');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ name, failed: failing, skipped: false });
      expect(batch).toEqual([file]);
      expect(args.filter(arg => arg.startsWith('--timeout='))).toEqual([failing ? '--timeout=1234' : '--timeout=60000']);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
