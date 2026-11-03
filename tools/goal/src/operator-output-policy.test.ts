import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkSettings } from './config.ts';
import { evidenceBundle } from './evidence.ts';
import { configurationProblem, loadLocalSettings } from './local-settings.ts';
import { firstFailure, git, policyGit } from './merge.ts';
import { defaultPolicy, readControlPolicy } from './policy.ts';
import { scriptPolicy, readScriptPolicy, withScriptPolicy } from './script-policy.ts';
import { reportServices } from './service.ts';
import { repository, temporaryDirectory, harness } from './test-support.ts';
import { WorkerStore } from './store.ts';
import { recordToolBlockerFailure } from './tool-incidents.ts';
import { CHECK_COMPATIBILITY_CONTRACT, checkScriptCompatibility } from './check-compatibility.ts';
import { syncChecks } from '../scripts/cp-sync.ts';
import type { Attempt, Task } from './types.ts';
// Include the standalone entry points in workspace typing without starting their native probes.
type ManagerSmoke = typeof import('../scripts/smoke-codex-manager.ts');
type HostRoute = typeof import('../scripts/check-host-route.ts');
type CandidateProbe = typeof import('../scripts/candidate-cleanliness-probe.ts');

const root = resolve(import.meta.dir, '../../..');
function configured(overrides: unknown) {
  const f = temporaryDirectory();
  const file = join(f.path, 'local.json');
  writeFileSync(file, JSON.stringify({ version: 1, pools: [], policy: overrides }));
  try {
    return checkSettings({ cwd: root, localFile: file, env: { GOAL_MAIN_CHECKOUT: root } }).policy!;
  } finally {
    f.close();
  }
}

test('remaining output policies are validated local settings, including positive tiny bounds', () => {
  const policy = configured({
    evidence: { manifestCharacters: 1 },
    service: { logLines: 2 },
    cpSync: { testTimeoutMs: 19 },
  });
  expect(policy.evidence.manifestCharacters).toBe(1);
  expect(policy.service.logLines).toBe(2);
  expect(() => configured({ merge: { failureCharacters: 0 } })).toThrow('policy.merge.failureCharacters');
  expect(() => configured({ trainResolver: { timeoutMs: 1.5 } })).toThrow('policy.trainResolver.timeoutMs');
  expect(() => configured({ service: { unknown: 1 } })).toThrow('unknown policy.service.unknown');
  expect(policy.verifier.gateTimeoutMs).toBe(4 * 60 * 60 * 1000);
  expect(policy.verifier.standaloneGateTimeoutMs).toBe(2 * 60 * 60 * 1000);
});

test('retry manifests honor caller bounds while complete evidence and contract remain available', () => {
  const f = repository();
  try {
    const base = git(f.main, 'rev-parse', 'HEAD');
    writeFileSync(join(f.main, 'base'), 'changed\n');
    const task = {
      id: 'task',
      worktree: f.main,
      base,
      brief: { markdown: 'original contract', acceptance: { command: ['bun', 'test'] } },
    } as Task;
    const failure = firstFailure('Error: assertion failed\nsecond output\nthird output');
    const attempt = {
      taskId: 'task',
      attempt: 1,
      evidencePath: join(f.path, 'evidence'),
      approaches: [
        { approach: 'old', result: 'no' },
        { approach: 'latest', result: 'still investigating' },
      ],
      result: '',
      failure,
    } as Attempt;
    const policy = configured({
      evidence: { outputLines: 1, fieldCharacters: 8, approaches: 1, approachResultCharacters: 4 },
    });
    const directory = evidenceBundle(task, attempt, failure, policy.evidence);
    const record = JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8'));
    expect(record.manifest).toContain('First assertion: Error: …');
    expect(record.manifest).toContain('Failure output:\nError: assertion failed\n\n');
    expect(record.manifest).toContain('- latest — sti…');
    expect(record.manifest).not.toContain('- old');
    expect(record.excerpt).toBe(failure.excerpt);
    expect(readFileSync(join(directory, 'contract.md'), 'utf8')).toBe('original contract');
    expect(readFileSync(join(directory, 'diff.patch'), 'utf8')).toContain('+changed');
    expect(JSON.parse(readFileSync(join(directory, 'approaches.json'), 'utf8'))).toHaveLength(2);
    evidenceBundle(task, attempt, failure, readControlPolicy({ evidence: { manifestCharacters: 1 } }).evidence);
    expect(JSON.parse(readFileSync(join(directory, 'failure.json'), 'utf8')).manifest).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('failure excerpt bounds do not change normalized failure identity', () => {
  const output = 'Error: expected 3 at src/example.ts:22\n' + 'diagnostic\n'.repeat(20);
  const original = firstFailure(output);
  const bounded = firstFailure(
    output,
    configured({ merge: { failureLines: 1, failureHeadCharacters: 8, failureCharacters: 12 } }).merge,
  );
  expect(bounded.fingerprint).toBe(original.fingerprint);
  expect(bounded.assertion).toBe(original.assertion);
  expect(bounded.excerpt).toHaveLength(12);
  expect(firstFailure(output, readControlPolicy({ merge: { failureCharacters: 1 } }).merge).excerpt).toHaveLength(1);
});

test('caller Git buffer bounds fail without truncating a successful result', () => {
  const f = repository();
  try {
    git(f.main, 'config', 'goal.fixture', 'x'.repeat(1000));
    expect(policyGit(f.main, ['config', '--get', 'goal.fixture'])).toHaveLength(1000);
    expect(() =>
      policyGit(f.main, ['config', '--get', 'goal.fixture'], configured({ merge: { gitBufferBytes: 16 } }).merge),
    ).toThrow();
  } finally {
    f.close();
  }
});

test('last valid settings bound invalid-edit diagnostics with their retained policy', () => {
  const f = temporaryDirectory();
  const file = join(f.path, 'local.json');
  const validate = (local: unknown) => ({ policy: readControlPolicy((local as { policy?: unknown }).policy) });
  try {
    writeFileSync(file, JSON.stringify({ policy: { localSettings: { diagnosticCharacters: 7 } } }));
    loadLocalSettings(file, f.path, validate);
    writeFileSync(file, '{' + 'bad'.repeat(200));
    const fallback = loadLocalSettings(file, f.path, validate);
    expect(configurationProblem(fallback)?.error).toHaveLength(7);
    expect(fallback.policy.localSettings.diagnosticCharacters).toBe(7);
  } finally {
    f.close();
  }
});

test('script invocations isolate caller snapshots and forward proof command deadlines', async () => {
  const a = configured({ cpSync: { testTimeoutMs: 17, suiteTimeoutMs: 23 } });
  const b = readControlPolicy({ cpSync: { testTimeoutMs: 29 } });
  await Promise.all(
    [a, b].map((policy) =>
      withScriptPolicy(policy, async () => {
        await Promise.resolve();
        expect(scriptPolicy()).toBe(policy);
        const checks = syncChecks('/fixture', true);
        const suites = checks.filter((check) => check.kind === 'suite');
        expect(suites.length).toBeGreaterThan(0);
        for (const suite of suites) {
          expect(suite.argv).toContain(String(policy.cpSync.testTimeoutMs));
          expect(suite.timeoutMs).toBe(policy.cpSync.suiteTimeoutMs);
        }
        expect(syncChecks('/fixture', false).some((check) => check.kind === 'suite')).toBe(false);
      }),
    ),
  );
  expect(scriptPolicy()).toBe(defaultPolicy);
  const f = repository();
  try {
    const file = join(f.path, 'local.json');
    writeFileSync(file, JSON.stringify({ policy: { cpSync: { testTimeoutMs: 41 } } }));
    expect(readScriptPolicy(f.main, { GOAL_LOCAL_CONFIG: file }).cpSync.testTimeoutMs).toBe(41);
    expect(() => readScriptPolicy(f.main, { GOAL_LOCAL_CONFIG: join(f.main, 'base') })).toThrow('must be untracked');
  } finally {
    f.close();
  }
});

test('service log requests use the caller page size and preserve injected execution', async () => {
  const calls: string[][] = [];
  const code = await reportServices(
    'logs',
    async (argv) => {
      calls.push(argv);
      return { code: 0, output: 'ActiveState=active' };
    },
    () => {},
    configured({ service: { logLines: 3 } }).service,
  );
  expect(code).toBe(0);
  const journals = calls.filter((argv) => argv[0] === 'journalctl');
  expect(journals).toHaveLength(4);
  for (const argv of journals) expect(argv).toContain('--lines=3');
});

test('incident thresholds, example limits and probe cadence follow the operator snapshot', () => {
  const h = harness();
  const now = Date.now();
  const policy = configured({ toolIncidents: { threshold: 2, windowMs: 100, probeMs: 200, exampleTasks: 1 } });
  h.settings.policy = policy;
  const store = new WorkerStore(h.store.db, policy);
  try {
    let result: ReturnType<typeof recordToolBlockerFailure> | undefined;
    for (const offset of [-101, 0, 1]) {
      const task = h.tasks.dispatch(h.briefFile);
      const next = store.nextAttempt(
        { taskId: task.id, attempt: 0 },
        (attempt) =>
          ({
            taskId: task.id,
            attempt,
            state: 'exited',
            failureKind: 'tool',
            blocker: 'ENOSPC: shared cache failed',
            result: '',
            logPath: '',
            process: null,
          }) as Attempt,
      );
      result = recordToolBlockerFailure(
        store,
        store.task(task.id),
        store.attempt({ taskId: task.id, attempt: next.attempt }),
        h.settings,
        { deliver() {} },
        now + offset,
      );
      if (offset <= 0) expect(result.incident).toBeNull();
    }
    expect(result?.opened).toBe(true);
    expect(result?.incident?.exampleTasks).toHaveLength(1);
    expect(result?.incident?.nextProbeAt).toBe(new Date(now + 201).toISOString());
  } finally {
    h.dispose();
  }
});

test('standalone compatibility diagnostics forward native bounds without launching real checks', () => {
  const f = temporaryDirectory();
  try {
    writeFileSync(join(f.path, 'package.json'), JSON.stringify({ packageManager: 'bun@unknown' }));
    const script = join(f.path, CHECK_COMPATIBILITY_CONTRACT.workerCheck.script);
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "process.stdout.write('x'.repeat(1000));");
    const report = checkScriptCompatibility(
      f.path,
      configured({ nativeCommands: { commandBufferBytes: 16 } }).nativeCommands,
    );
    expect(report.compatible).toBe(false);
    const start = report.checks.find((check) => check.field === 'workerCheck.start');
    expect(start?.status).toBe('incompatible');
    expect(String(start?.evidence?.stdout).length).toBeLessThanOrEqual(16);
  } finally {
    f.close();
  }
});
