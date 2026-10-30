import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harness, integrationHarness } from './test-support.ts';
import { preparePromotionGate } from './promotion-placement.ts';
import { promote } from './promotion.ts';
import { gateEnvironment } from './merge.ts';
import { ensurePromotionObservationSchema, readPromotionGroupWindows } from './promotion-observation.ts';
import { git } from './tasks.ts';
import type { PromotionRun, Settings } from './types.ts';

const repositoryRoot = resolve(import.meta.dir, '../../..');

function host(name: 'a' | 'b' | 'c') {
  const baseline = {
    a: { slots: 5, memoryMaxGiB: 28, cpuQuotaPercent: 1100 },
    b: { slots: 7, memoryMaxGiB: 58, cpuQuotaPercent: 1500 },
    c: { slots: 5, memoryMaxGiB: 24, cpuQuotaPercent: 4800 },
  }[name];
  return {
    name,
    address: `gate@127.0.0.${name === 'a' ? '1' : name === 'b' ? '2' : '3'}`,
    identity: `/tmp/${name}-check-key`,
    ...baseline,
    processorsPerSlot: 2,
  };
}

function configured(settings: Settings, hostsFile: string): string[] {
  const command = ['env', 'KERNEL_CHECK_CONCURRENCY=5', `KERNEL_CHECK_REMOTE=${hostsFile}`, 'bun', 'scripts/gate.ts'];
  settings.gate = command;
  settings.promotionPlacement = { ordinaryHostsFile: hostsFile };
  return command;
}

function promotionRun(rootGate: string[]): PromotionRun {
  return {
    id: 'promotion-fixture',
    phase: 'gate-head',
    mainBase: 'a'.repeat(40),
    devHead: 'b'.repeat(40),
    taskIds: [],
    rootGate,
    promotionParallelism: 1,
    boundaries: [],
    headResults: [],
    prefixResults: [],
  };
}

test('Goal applies c-only placement to the frozen full gate and publishes only after its passing result', async () => {
  const h = integrationHarness();
  try {
    await h.seed('alpha');
    const frozenCandidate = h.head();
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    const ordinary = `${JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }, null, 2)}\n`;
    writeFileSync(ordinaryHostsFile, ordinary);
    const configuredGate = [
      'env',
      'KERNEL_CHECK_CONCURRENCY=5',
      `KERNEL_CHECK_REMOTE=${ordinaryHostsFile}`,
      'bun',
      'scripts/gate.ts',
    ];
    h.settings.gate = configuredGate;
    h.settings.promotionPlacement = { ordinaryHostsFile };
    const executed: { command: readonly string[]; head: string }[] = [];

    await promote({
      settings: h.settings,
      job: h.job,
      prepareGateCommand: (run, command) => preparePromotionGate(h.settings, run, command)?.command ?? null,
      runGate: async (command, cwd) => {
        executed.push({ command, head: git(cwd, ['rev-parse', 'HEAD']) });
        return { passed: true, output: '', timedOut: false };
      },
    });

    const fullGate = executed.find((entry) => entry.command.includes('scripts/gate.ts'))!;
    expect(fullGate.head).toBe(frozenCandidate);
    expect(fullGate.command).toEqual([
      'env',
      'KERNEL_CHECK_CONCURRENCY=5',
      `KERNEL_CHECK_REMOTE=${join(h.settings.stateDirectory, 'promotion-gate-hosts.json')}`,
      'GATE_REMOTE_SLOTS=3',
      'bun',
      'scripts/gate.ts',
    ]);
    expect(readFileSync(ordinaryHostsFile, 'utf8')).toBe(ordinary);
    expect(JSON.parse(readFileSync(join(h.settings.stateDirectory, 'promotion-gate-hosts.json'), 'utf8'))).toEqual({
      hosts: [
        {
          name: 'c',
          address: host('c').address,
          identity: host('c').identity,
          slots: 5,
          memoryMaxGiB: 24,
          cpuQuotaPercent: 4800,
        },
      ],
    });
    expect(h.head('main')).toBe(frozenCandidate);
    expect(readPromotionGroupWindows(h.store.db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          promotionId: expect.any(String),
          group: 'head',
          outcome: 'passed',
          physicalStatus: 'unavailable',
          physicalHost: null,
          resourceSampleCount: null,
        }),
      ]),
    );
  } finally {
    h.dispose();
  }
}, 45_000);

test('an observation write failure cannot turn a rejected full gate into promotion', async () => {
  const h = integrationHarness();
  try {
    await h.seed('alpha');
    const frozenCandidate = h.head();
    const mainBefore = h.head('main');
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }));
    h.settings.gate = [
      'env',
      'KERNEL_CHECK_CONCURRENCY=5',
      `KERNEL_CHECK_REMOTE=${ordinaryHostsFile}`,
      'bun',
      'scripts/gate.ts',
    ];
    h.settings.promotionPlacement = { ordinaryHostsFile };
    ensurePromotionObservationSchema(h.store.db);
    h.store.db.exec(`CREATE TRIGGER reject_promotion_observation BEFORE INSERT ON promotion_group_windows
      BEGIN SELECT RAISE(ABORT, 'fixture telemetry failure'); END`);
    let rootGateCalled = false;

    await promote({
      settings: h.settings,
      job: h.job,
      prepareGateCommand: (run, command) => preparePromotionGate(h.settings, run, command)?.command ?? null,
      runGate: async (command) => {
        if (command.includes('scripts/gate.ts')) {
          rootGateCalled = true;
          return { passed: false, output: 'AssertionError: gate rejected the frozen candidate', timedOut: false };
        }
        return { passed: true, output: '', timedOut: false };
      },
    });

    expect(rootGateCalled).toBe(true);
    expect(h.head('main')).toBe(mainBefore);
    expect(h.head()).toBe(frozenCandidate);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    expect(readPromotionGroupWindows(h.store.db)).toEqual([]);
  } finally {
    h.dispose();
  }
}, 45_000);

test('promotion derives a c-only file from the ordinary schema and forwards the supported full gate policy', () => {
  const h = harness();
  try {
    mkdirSync(h.settings.stateDirectory, { recursive: true });
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    const source = `${JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }, null, 2)}\n`;
    writeFileSync(ordinaryHostsFile, source);
    const originalSettingsCommand = configured(h.settings, ordinaryHostsFile);
    const run = promotionRun(originalSettingsCommand);
    const prepared = preparePromotionGate(h.settings, run, originalSettingsCommand)!;
    const selected = JSON.parse(readFileSync(prepared.snapshot.hostsFile, 'utf8')) as {
      hosts: Record<string, unknown>[];
    };

    expect(selected.hosts).toHaveLength(1);
    expect(selected.hosts[0]).toEqual({
      name: 'c',
      address: host('c').address,
      identity: host('c').identity,
      slots: 5,
      memoryMaxGiB: 24,
      cpuQuotaPercent: 4800,
    });
    expect(prepared.snapshot).toMatchObject({
      host: 'c',
      gateSlots: 3,
      ordinarySlots: 14,
      cOrdinarySlots: 4,
      retainedOrdinarySlots: 11,
    });
    expect(prepared.snapshot.retainedOrdinarySlots / prepared.snapshot.ordinarySlots).toBeGreaterThanOrEqual(0.7);
    const ordinary = [host('a'), host('b'), host('c')].map((entry) => entry.slots - 1);
    expect((ordinary[0]! + ordinary[1]!) / prepared.snapshot.ordinarySlots).toBeGreaterThanOrEqual(0.7);
    expect(prepared.command).toEqual([
      'env',
      'KERNEL_CHECK_CONCURRENCY=5',
      `KERNEL_CHECK_REMOTE=${prepared.snapshot.hostsFile}`,
      'GATE_REMOTE_SLOTS=3',
      'bun',
      'scripts/gate.ts',
    ]);
    expect(prepared.command).not.toContain('GATE_CONCURRENCY=');
    expect(prepared.command).not.toContain('REMOTE_CHECK_PRIORITY=');
    expect(readFileSync(ordinaryHostsFile, 'utf8')).toBe(source);
    expect(h.settings.gate).toEqual(originalSettingsCommand);
    expect(preparePromotionGate(h.settings, run, originalSettingsCommand)?.snapshot).toEqual(prepared.snapshot);

    const gateSource = readFileSync(join(repositoryRoot, 'scripts/gate.ts'), 'utf8');
    const remoteCheckSource = readFileSync(join(repositoryRoot, 'scripts/remote-check.ts'), 'utf8');
    const kernelSource = readFileSync(join(repositoryRoot, 'services/kernel/scripts/check.ts'), 'utf8');
    expect(gateSource).toContain("new Bun.Glob('{apps,services,packages}/*/package.json')");
    expect(gateSource).toContain("await run(['bun', 'install', '--frozen-lockfile'], root)");
    expect(gateSource).toContain("const command = ['bun', 'run', 'check']");
    expect(gateSource).toContain('tools/goal/scripts/gate.ts');
    expect(gateSource).toContain('process.execPath');
    expect(remoteCheckSource).toContain('bun install --frozen-lockfile');
    expect(kernelSource).toContain('process.env.KERNEL_CHECK_CONCURRENCY ?? 6');
  } finally {
    h.dispose();
  }
});

test('the actual root gate forwards the derived host file, three remote slots, and kernel concurrency five', () => {
  const h = harness();
  try {
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }));
    const command = configured(h.settings, ordinaryHostsFile);
    const prepared = preparePromotionGate(h.settings, promotionRun(command), command)!;
    const fake = join(h.settings.stateDirectory, 'fake-bin');
    const eventsDirectory = join(h.settings.stateDirectory, 'fake-remote');
    mkdirSync(fake, { recursive: true });
    mkdirSync(eventsDirectory, { recursive: true });
    const fakeSsh = join(fake, 'ssh');
    writeFileSync(
      fakeSsh,
      `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const dir = process.env.FAKE_REMOTE!;
const script = process.argv.at(-1) ?? '';
const host = process.argv.find((argument) => argument.startsWith('gate@')) ?? '';
const identityIndex = process.argv.indexOf('-i');
const identity = identityIndex < 0 ? '' : process.argv[identityIndex + 1] ?? '';
const record = (kind, value = '', target = '', key = '') =>
  appendFileSync(dir + '/events.jsonl', JSON.stringify({ kind, value, target, key }) + '\\n');
const hold = () => { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); };
if (script.includes('MemAvailable')) { record('probe'); console.log('AVAILABLE 8000000000'); }
else if (script.includes('REMOTE_CHECK_RESERVATION')) { record('reservation'); console.log('RESERVATION'); hold(); }
else if (script.includes('REMOTE_CHECK_SLOT_')) { record('slot'); console.log('SLOT 0'); hold(); }
else if (script.includes('systemd-run')) { record('run', script, host, identity); console.log('fake remote gate'); }
else record('cleanup');
`,
    );
    chmodSync(fakeSsh, 0o755);
    const fakeRsync = join(fake, 'rsync');
    writeFileSync(
      fakeRsync,
      `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const input = await Bun.stdin.text();
appendFileSync(process.env.FAKE_REMOTE + '/events.jsonl', JSON.stringify({ kind: 'rsync', files: input.split('\\0').filter(Boolean).length }) + '\\n');
`,
    );
    chmodSync(fakeRsync, 0o755);

    const gateEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fake}:${process.env.PATH}`,
      FAKE_REMOTE: eventsDirectory,
    };
    delete gateEnvironment.KERNEL_CHECK_ON_REMOTE;
    const result = spawnSync(prepared.command[0]!, prepared.command.slice(1), {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: gateEnvironment,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const events = readFileSync(join(eventsDirectory, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; value?: string; target?: string; key?: string });
    expect(events.filter((event) => event.kind === 'slot')).toHaveLength(3);
    const remoteEvent = events.find((event) => event.kind === 'run');
    const remoteRun = remoteEvent?.value ?? '';
    expect(remoteEvent?.target).toBe(host('c').address);
    expect(remoteEvent?.key).toBe(host('c').identity);
    expect(remoteRun).toContain('KERNEL_CHECK_CONCURRENCY=5');
    expect(remoteRun).toContain('bun scripts/gate.ts');
  } finally {
    h.dispose();
  }
}, 45_000);

test('an explicit unreadable remote gate host path fails instead of running the full gate locally', () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATE_REMOTE_SLOTS: '3',
    KERNEL_CHECK_CONCURRENCY: '5',
    KERNEL_CHECK_REMOTE: join(repositoryRoot, `.temp/goal/route-${randomUUID()}/promotion-gate-hosts.json`),
  };
  delete env.KERNEL_CHECK_ON_REMOTE;
  const result = spawnSync('bun', ['scripts/gate.ts'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('refusing to run the gate locally');
  expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toContain('bun install --frozen-lockfile');
});

test('promotion rejects local-only routing flags and removes inherited local mode from gate children', () => {
  const h = harness();
  try {
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }));
    const command = configured(h.settings, ordinaryHostsFile);
    const localOnly = [...command];
    localOnly.splice(localOnly.indexOf('bun'), 0, 'KERNEL_CHECK_ON_REMOTE=1');
    h.settings.gate = localOnly;
    expect(() => preparePromotionGate(h.settings, promotionRun(localOnly), localOnly)).toThrow('local-only');
    expect(gateEnvironment({ KERNEL_CHECK_ON_REMOTE: '1' }).KERNEL_CHECK_ON_REMOTE).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('invalid, ambiguous, mismatched, unreadable, or undersized host inputs fail before a gate command is returned', () => {
  const h = harness();
  try {
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    const command = configured(h.settings, ordinaryHostsFile);
    const run = promotionRun(command);
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('not readable');

    const trackedHostsFile = join(h.root, 'tracked-hosts.json');
    writeFileSync(trackedHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }));
    git(h.root, ['add', 'tracked-hosts.json']);
    h.settings.promotionPlacement = { ordinaryHostsFile: trackedHostsFile };
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('must remain untracked');
    h.settings.promotionPlacement = { ordinaryHostsFile };

    writeFileSync(ordinaryHostsFile, '{"hosts":[]}');
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('lists no hosts');

    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b')] }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('must be exactly a,b,c');

    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c'), host('c')] }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('duplicate hosts: c');

    const lowCapacity = { ...host('c'), slots: 2 };
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), lowCapacity] }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('must leave one ordinary slot');

    const wrongResources = { ...host('c'), memoryMaxGiB: 25 };
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), wrongResources] }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('differs from the measured topology');

    const wrongA = { ...host('a'), cpuQuotaPercent: 1000 };
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [wrongA, host('b'), host('c')] }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('differs from the measured topology');
    const wrongB = { ...host('b'), memoryMaxGiB: 59 };
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), wrongB, host('c')] }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('differs from the measured topology');

    const duplicateEnv = ['env', 'KERNEL_CHECK_REMOTE=/tmp/a', 'KERNEL_CHECK_REMOTE=/tmp/b', 'bun', 'scripts/gate.ts'];
    h.settings.gate = duplicateEnv;
    h.settings.promotionPlacement = { ordinaryHostsFile };
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }));
    expect(() => preparePromotionGate(h.settings, promotionRun(duplicateEnv), duplicateEnv)).toThrow(
      'ambiguous KERNEL_CHECK_REMOTE',
    );

    h.settings.gate = command;
    const noPolicy = { ...h.settings };
    delete noPolicy.promotionPlacement;
    expect(() => preparePromotionGate(noPolicy, promotionRun(command), command)).toThrow(
      'promotionPlacement.ordinaryHostsFile is required',
    );
  } finally {
    h.dispose();
  }
});

test('a changed ordinary host generation is rejected and cannot switch a live promotion run', () => {
  const h = harness();
  try {
    const ordinaryHostsFile = join(h.settings.stateDirectory, 'remote-check-hosts.json');
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: [host('a'), host('b'), host('c')] }));
    const command = configured(h.settings, ordinaryHostsFile);
    const run = promotionRun(command);
    const prepared = preparePromotionGate(h.settings, run, command)!;
    const changed = [host('a'), host('b'), { ...host('c'), identity: '/tmp/rotated-key' }];
    writeFileSync(ordinaryHostsFile, JSON.stringify({ hosts: changed }));
    expect(() => preparePromotionGate(h.settings, run, command)).toThrow('changed during this run');
    expect(readFileSync(prepared.snapshot.hostsFile, 'utf8')).toContain('/tmp/c-check-key');
  } finally {
    h.dispose();
  }
});
