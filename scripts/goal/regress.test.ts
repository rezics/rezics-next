import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { selectTestCommand } from '../qa/test.ts';
import { appendInbox, checkoutNameLength, classify, executionOutcomes, inboxEntries, parseRegressArgs, regressionRegistry,
  runRegression, type Batch, type Execution, type ExpectedFile, type Manifest, type MergeEvent, type RegressionOptions } from './regress.ts';

function repo(extraIntegration = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'goal-regression-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Regression test'); git('config', 'user.email', 'test@example.invalid');
  const files: ExpectedFile[] = [
    ['unit', 'tests/qa/unit/example.test.ts'], ['model', 'model/tests/example.test.ts'],
    ['integration', 'tests/qa/integration/example.test.ts'], ['fault/recovery', 'tests/qa/fault-recovery/example.test.ts'],
    ['e2e', 'apps/web/tests/example.e2e.ts'], ['e2e', 'apps/web/features/example.stories.tsx'],
    ['accounts:storybook', 'apps/accounts/features/example.stories.tsx'],
    ...Array.from({ length: extraIntegration }, (_, index) => ['integration', `tests/qa/integration/subdir/extra-${index}.test.ts`]),
  ].map(([tier, file]) => ({ tier, file, outcome: 'pending' })) as ExpectedFile[];
  const write = (file: string, text: string) => { mkdirSync(dirname(join(dir, file)), { recursive: true }); writeFileSync(join(dir, file), text); };
  write('.gitignore', '.temp/\n.artifacts/\n');
  for (const file of files) write(file.file, 'pass\n');
  const commit = (changes: Record<string, string | null> = {}) => {
    for (const [path, text] of Object.entries(changes)) { if (text === null) rmSync(join(dir, path)); else write(path, text); }
    git('add', '.'); git('commit', '--allow-empty', '-qm', 'fixture'); return git('rev-parse', 'HEAD');
  };
  const base = commit();
  const stateDir = join(dir, '.temp/goal-orchestration');
  const calls: { commit: string; checkout: string; batch: Batch; directory: string }[] = [];
  const runner: NonNullable<RegressionOptions['runner']> = async (checkout, batch, directory) => {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
    calls.push({ commit: sha, checkout, batch, directory });
    const outcomes = Object.fromEntries(batch.files.map(file => [file, !existsSync(join(checkout, file)) ? 'missing'
      : readFileSync(join(checkout, file), 'utf8').startsWith('fail') ? 'failed' : 'passed'])) as Execution['outcomes'];
    return { code: Object.values(outcomes).every(result => result === 'passed') ? 0 : 1, outcomes,
      queueMs: 2, testMs: 3, totalMs: 5, artifactPaths: [directory] };
  };
  const options: RegressionOptions = { repo: dir, stateDir, registry: async () => files.map(file => ({ ...file })),
    prepare: async () => ({ ok: true, artifactPaths: [] }), runner };
  const event = (before: string, after: string, goal = 'owner') => {
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, 'merges.jsonl');
    const events = existsSync(path) ? readFileSync(path, 'utf8') : '';
    writeFileSync(path, events + JSON.stringify({ before, after, goal, taskIds: ['G-001', 'G-002'], at: new Date().toISOString() } satisfies MergeEvent) + '\n');
  };
  const run = (overrides: Partial<RegressionOptions> = {}) => runRegression({ ...options, ...overrides });
  const manifest = (id: string) => JSON.parse(readFileSync(join(stateDir, 'regress', id, 'manifest.json'), 'utf8')) as Manifest;
  return { dir, git, base, files, options, calls, runner, write, commit, event, run, manifest,
    unit: files[0]!.file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('pinned main-wide regression', () => {
  test('merges landing mid-run do not change the pinned SHA', async () => {
    const r = repo();
    try {
      let landed = false;
      const result = await r.run({ runId: 'pin', runner: async (...args) => {
        if (!landed) { landed = true; r.commit({ [r.unit]: 'fail\n' }); }
        return r.runner(...args);
      } });
      expect(result.atCommit).toBe(r.base);
      expect(r.git('rev-parse', 'main')).not.toBe(r.base);
      expect(new Set(r.calls.map(call => call.commit))).toEqual(new Set([r.base]));
      expect(result.status).toBe('passed');
    } finally { r.cleanup(); }
  });

  test('preflight never falls back to an ancestor Taskfile and executes only the committed Taskfile', async () => {
    const r = repo();
    const taskfile = (label: string) => `version: '3'\ntasks:\n  install:\n    cmds: ['echo ${label}']\n  gen:check:\n    cmds: ['echo ${label}']\n`;
    try {
      r.write('Taskfile.yml', taskfile('ancestor-task-used'));
      const unsupported = await r.run({ runId: 'no-taskfile', prepare: undefined });
      expect(unsupported.preflight.ok).toBe(false);
      expect(unsupported.preflight.artifactPaths).toHaveLength(0);
      expect(unsupported.status).toBe('failed');
      r.write('Taskfile.yml', taskfile('pinned-task-used')); r.commit();
      r.write('Taskfile.yml', taskfile('ancestor-task-used'));
      const supported = await r.run({ runId: 'pinned-taskfile', prepare: undefined });
      expect(supported.status).toBe('passed');
      expect(supported.preflight.artifactPaths).toHaveLength(2);
      for (const path of supported.preflight.artifactPaths) {
        const log = readFileSync(path, 'utf8');
        expect(log).toContain('pinned-task-used');
        expect(log).not.toContain('ancestor-task-used');
      }
    } finally { r.cleanup(); }
  });

  test('the harness manifest includes gate and subdirectory files, browser stories and explicit exclusions', async () => {
    const r = repo(1);
    try {
      r.write('scripts/qa/acceptance.ts', `export const unitHarnessFiles = ['tests/qa/harness.test.ts'];
export const legacyHostJenaGateFiles = ['services/main/tests/legacy.integration.test.ts'];
export function testArgs(tier) { return tier === 'model' ? ['model/tests'] : tier === 'integration'
? ['tests/qa/integration', 'services/main/tests/gate.integration.test.ts'] : [tier === 'fault/recovery' ? 'tests/qa/fault-recovery' : 'tests/qa/' + tier]; }
`);
      r.write('scripts/qa/core.ts', `export { expandTestPaths, splitTestArgs } from ${JSON.stringify(join(import.meta.dir, '../qa/core.ts'))};\n`);
      r.write('services/main/tests/gate.integration.test.ts', ''); r.write('tests/qa/harness.test.ts', '');
      r.write('tests/qa/load/example.test.ts', ''); r.write('tests/live/example.test.ts', '');
      r.write('packages/ui/src/example.stories.tsx', '');
      r.write('apps/web/.storybook/main.ts', "const config = { stories: ['../features/**/*.stories.@(ts|tsx)', '../../../packages/ui/src/**/*.stories.@(ts|tsx)'] };\n");
      r.write('apps/accounts/.storybook/main.ts', "const config = { stories: ['../features/**/*.stories.@(ts|tsx)'] };\n");
      const files = await regressionRegistry(r.dir);
      expect(files).toContainEqual({ file: 'services/main/tests/gate.integration.test.ts', tier: 'integration', outcome: 'pending' });
      expect(files).toContainEqual({ file: 'tests/qa/integration/subdir/extra-0.test.ts', tier: 'integration', outcome: 'pending' });
      expect(files).toContainEqual({ file: 'packages/ui/src/example.stories.tsx', tier: 'e2e', outcome: 'pending' });
      expect(files.filter(file => file.outcome === 'excluded').map(file => file.tier).sort()).toEqual(['legacy', 'live', 'load']);
    } finally { r.cleanup(); }
  });

  test('a fast-forward merge event is found and attributed with both boundaries verified', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      const after = r.commit({ [r.unit]: 'fail\n' }); r.event(r.base, after);
      expect(r.git('log', '--merges', '--format=%H')).toBe('');
      const result = await r.run({ runId: 'regression' });
      expect(result.diagnoses).toHaveLength(1);
      expect(result.diagnoses[0]).toMatchObject({ status: 'attributed', before: r.base, after, goal: 'owner', taskIds: ['G-001', 'G-002'] });
      expect(result.diagnoses[0]!.probes.slice(-2)).toEqual([{ commit: r.base, outcome: 'passed' }, { commit: after, outcome: 'failed' }]);
      const probes = r.calls.filter(call => call.directory.includes('/probes/'));
      expect(probes.every(call => call.checkout !== result.checkout)).toBe(true);
      expect(new Set(probes.map(call => call.checkout)).size).toBe(probes.length);
      expect(inboxEntries(r.options.stateDir, 'owner')).toHaveLength(1);
    } finally { r.cleanup(); }
  });

  test('unrecorded manager edits remain in the suspect range and never go to the nearest task', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      const task = r.commit(); r.event(r.base, task);
      const edit = r.commit({ [r.unit]: 'fail\n' });
      const result = await r.run({ runId: 'gap' });
      expect(result.diagnoses[0]).toMatchObject({ status: 'inconclusive', before: task, after: edit });
      expect(result.diagnoses[0]!.goal).toBeUndefined();
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(1);
      expect(inboxEntries(r.options.stateDir, 'owner')).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('distinct paths cannot collide in probe worktrees or overwrite each other’s artifacts', async () => {
    const r = repo();
    try {
      const files = ['tests/qa/unit/sub/entry.test.ts', 'tests/qa/unit/sub-entry.test.ts'];
      for (const file of files) { r.write(file, 'pass\n'); r.files.push({ file, tier: 'unit', outcome: 'pending' }); }
      const base = r.commit();
      await r.run({ runId: 'base' });
      const after = r.commit(Object.fromEntries(files.map(file => [file, 'fail\n']))); r.event(base, after);
      const result = await r.run({ runId: 'paths' });
      expect(result.diagnoses.every(diagnosis => diagnosis.status === 'attributed')).toBe(true);
      const probes = r.calls.filter(call => call.directory.includes('/probes/'));
      expect(new Set(probes.map(call => call.checkout)).size).toBe(probes.length);
    } finally { r.cleanup(); }
  });

  test('a failure present at the base is inherited', async () => {
    const r = repo();
    try {
      r.git('checkout', '--orphan', 'replacement');
      r.commit({ [r.unit]: 'fail\n' }); r.git('branch', '-M', 'main');
      const result = await r.run({ runId: 'inherited' });
      expect(result.diagnoses[0]).toMatchObject({ status: 'inherited', classification: 'deterministic' });
    } finally { r.cleanup(); }
  });

  test('a missing file or unavailable build at a probe is unavailable', async () => {
    for (const missing of [true, false]) {
      const r = repo();
      try {
        if (missing) { r.git('checkout', '--orphan', 'replacement'); r.commit({ [r.unit]: null }); r.git('branch', '-M', 'main'); }
        const base = r.git('rev-parse', 'HEAD');
        const after = r.commit({ [r.unit]: 'fail\n' }); r.event(base, after);
        const result = await r.run({ runId: 'unavailable', prepare: async checkout => ({
          ok: missing || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim() !== base,
          artifactPaths: [], reason: 'build unavailable' }) });
        expect(result.diagnoses[0]!.status).toBe('unavailable');
        expect(result.status).not.toBe('passed');
      } finally { r.cleanup(); }
    }
  });

  test('a flip-flopping probe is inconclusive and never exceeds eight probes', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      const after = r.commit({ [r.unit]: 'fail\n' }); r.event(r.base, after);
      let probes = 0;
      const result = await r.run({ runId: 'flip', runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[2].includes('/probes/') && r.calls.at(-1)!.commit === r.base && ++probes > 1) {
          result.outcomes[r.unit] = 'failed'; result.code = 1;
        }
        return result;
      } });
      expect(result.diagnoses[0]!.status).toBe('inconclusive');
      expect(result.diagnoses[0]!.probes.length).toBeLessThanOrEqual(8);
      expect(result.diagnoses[0]!.reason).toContain('Conflicting');
    } finally { r.cleanup(); }
  });

  test('the probe budget reports a suspect range rather than guessing a culprit', async () => {
    const r = repo();
    try {
      await r.run({ runId: 'base' });
      let previous = r.base;
      for (let index = 0; index < 130; index++) {
        const next = r.commit({ [r.unit]: index >= 70 ? 'fail\n' : 'pass\n' }); r.event(previous, next); previous = next;
      }
      await expect(r.run({ runId: 'budget', runner: async (...args) => {
        const result = await r.runner(...args);
        if (args[2].includes('/probes/') && args[2].endsWith('-8')) throw new Error('Interrupted final probe');
        return result;
      } })).rejects.toThrow('Interrupted final probe');
      const result = await r.run({ resume: 'budget' });
      expect(result.diagnoses[0]!.status).toBe('inconclusive');
      expect(result.probeCounts![r.unit]).toBe(8);
      expect(r.calls.filter(call => call.directory.includes('/probes/'))).toHaveLength(8);
      expect(result.diagnoses[0]!.reason).toContain('budget');
      expect(result.diagnoses[0]!.goal).toBeUndefined();
    } finally { r.cleanup(); }
  }, 30_000);

  test('infrastructure failures are void and re-queued; resume runs only unfinished batches', async () => {
    const r = repo(30);
    try {
      let engineDown = true;
      const runner: RegressionOptions['runner'] = async (...args) => {
        const result = await r.runner(...args);
        if (engineDown && args[1].id === 'integration-2') return { ...result, code: 1, classification: 'infrastructure', evidence: 'Cannot connect to the Docker daemon' };
        return result;
      };
      const first = await r.run({ runId: 'infra', runner });
      expect(first.status).toBe('incomplete');
      expect(first.batches.find(batch => batch.id === 'integration-2')!.attempts).toHaveLength(2);
      expect(first.files.some(file => file.outcome === 'void')).toBe(true);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(0);
      const completed = first.batches.filter(batch => batch.state === 'done').map(batch => batch.id);
      r.calls.length = 0; engineDown = false;
      const resumed = await r.run({ resume: 'infra', runner });
      expect(resumed.status).toBe('passed');
      expect(r.calls.every(call => !completed.includes(call.batch.id))).toBe(true);
      expect(r.calls).toHaveLength(1);
      expect(resumed.batches.filter(batch => batch.tier === 'integration').every(batch => batch.files.length <= 15)).toBe(true);
    } finally { r.cleanup(); }
  });

  test('an interrupted run resumes without repeating finished batches', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'interrupted', runner: async (...args) => {
        if (args[1].tier === 'model') throw new Error('interrupted');
        return r.runner(...args);
      } })).rejects.toThrow('interrupted');
      expect(r.manifest('interrupted').batches[0]!.state).toBe('done');
      r.calls.length = 0;
      expect((await r.run({ resume: 'interrupted' })).status).toBe('passed');
      expect(r.calls.some(call => call.batch.tier === 'unit')).toBe(false);
    } finally { r.cleanup(); }
  });

  test('resume voids PostgreSQL failures from an old long checkout path and retains verified passes', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'old-layout', runner: async (...args) => {
        if (args[1].tier === 'fault/recovery') throw new Error('interrupted');
        const result = await r.runner(...args);
        if (args[1].tier === 'integration') return { ...result, code: 1, evidence: 'pg_ctl -k checkout/.temp/pg-sock failed',
          outcomes: Object.fromEntries(args[1].files.map(file => [file, 'failed'])) as Execution['outcomes'] };
        return result;
      } })).rejects.toThrow('interrupted');
      const old = r.manifest('old-layout'); old.checkout = `/tmp/${'long'.repeat(40)}`;
      old.batches.find(batch => batch.tier === 'integration')!.attempts[0]!.evidence = 'pg_ctl -k checkout/.temp/pg-sock failed';
      writeFileSync(join(r.options.stateDir, 'regress/old-layout/manifest.json'), JSON.stringify(old));
      r.calls.length = 0;
      const result = await r.run({ resume: 'old-layout', runner: async (...args) => {
        expect(r.manifest('old-layout').batches.filter(batch => batch.state === 'running')).toHaveLength(1);
        return r.runner(...args);
      } });
      expect(result.status).toBe('passed');
      expect(result.batches.find(batch => batch.tier === 'integration')!.attempts[0]!.classification).toBe('infrastructure');
      expect(r.calls.some(call => call.batch.tier === 'unit' || call.batch.tier === 'model')).toBe(false);
      expect(inboxEntries(r.options.stateDir, 'program')).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('a stop during installation resumes the original SHA even after main advances', async () => {
    const r = repo();
    try {
      await expect(r.run({ runId: 'startup', prepare: async () => { throw new Error('installation interrupted'); } })).rejects.toThrow('interrupted');
      expect(r.manifest('startup').atCommit).toBe(r.base);
      r.commit({ [r.unit]: 'fail\n' });
      const resumed = await r.run({ resume: 'startup' });
      expect(resumed.atCommit).toBe(r.base);
      expect(resumed.status).toBe('passed');
    } finally { r.cleanup(); }
  });

  test('incomplete, zero-match, missing-data and restricted manifests are never green', async () => {
    const r = repo();
    try {
      const result = await r.run({ runId: 'missing', runner: async (...args) => ({ ...await r.runner(...args), outcomes: {} }) });
      expect(result.status).toBe('incomplete');
      const manifest = r.manifest('missing'); manifest.files.pop();
      writeFileSync(join(r.options.stateDir, 'regress/missing/manifest.json'), JSON.stringify(manifest));
      await expect(r.run({ resume: 'missing' })).rejects.toThrow('Incomplete');
      await expect(r.run({ runId: 'zero', registry: async () => [] })).rejects.toThrow('Zero-match');
      const restricted = await r.run({ runId: 'restricted', only: ['unit', 'model'], integrationBatches: 0 });
      expect(restricted.status).toBe('incomplete');
      expect(restricted.files.some(file => file.outcome === 'deferred')).toBe(true);
      const plan = r.manifest('restricted'); plan.batches.pop();
      writeFileSync(join(r.options.stateDir, 'regress/restricted/manifest.json'), JSON.stringify(plan));
      await expect(r.run({ resume: 'restricted' })).rejects.toThrow('batch plan');
    } finally { r.cleanup(); }
  });

  test('resume accepts registry exclusions but cannot hide a removed batch or lose an exclusion reason', async () => {
    const r = repo();
    try {
      r.files.push({ tier: 'live', file: 'tests/qa/live/engine.test.ts', outcome: 'excluded', reason: 'Opt-in live engine gate' });
      expect((await r.run({ runId: 'exclusions' })).status).toBe('passed');
      r.calls.length = 0;
      expect((await r.run({ resume: 'exclusions' })).status).toBe('passed');
      const path = join(r.options.stateDir, 'regress/exclusions/manifest.json');
      const recorded = readFileSync(path, 'utf8');
      const hidden = JSON.parse(recorded) as Manifest;
      hidden.files.find(file => file.file === r.unit)!.outcome = 'excluded';
      hidden.batches = hidden.batches.filter(batch => batch.tier !== 'unit');
      writeFileSync(path, JSON.stringify(hidden));
      await expect(r.run({ resume: 'exclusions' })).rejects.toThrow('exclusions');
      const missingReason = JSON.parse(recorded) as Manifest;
      missingReason.files.find(file => file.tier === 'live')!.reason = undefined;
      writeFileSync(path, JSON.stringify(missingReason));
      await expect(r.run({ resume: 'exclusions' })).rejects.toThrow('exclusions');
      expect(r.calls).toHaveLength(0);
    } finally { r.cleanup(); }
  });

  test('flaky, order-dependent, deadline and resource outcomes stay distinct', async () => {
    for (const classification of ['flaky', 'order-dependent', 'deadline', 'resource'] as const) {
      const r = repo();
      try {
        r.commit({ [r.unit]: 'fail\n' });
        const result = await r.run({ runId: classification, runner: async (...args) => {
          const result = await r.runner(...args);
          if (args[1].files.includes(r.unit) && ((classification === 'flaky' && args[2].endsWith('/confirm'))
            || (classification === 'order-dependent' && args[2].includes('/alone-')))) {
            result.outcomes[r.unit] = 'passed'; result.code = 0;
          }
          if (classification === 'resource' || classification === 'deadline') result.classification = classification;
          return result;
        } });
        expect(result.diagnoses[0]!.classification).toBe(classification);
        expect(result.diagnoses[0]!.status).toBe('inconclusive');
      } finally { r.cleanup(); }
    }
  });

  test('a runner failure with passing files is unavailable rather than assigned to an arbitrary file', async () => {
    const r = repo();
    try {
      const result = await r.run({ runId: 'runner', runner: async (...args) => ({ ...await r.runner(...args),
        code: args[1].tier === 'unit' ? 1 : 0 }) });
      expect(result.status).not.toBe('passed');
      expect(result.diagnoses[0]).toMatchObject({ file: 'batch:unit-1', status: 'unavailable' });
      expect(result.diagnoses[0]!.classification).not.toBe('flaky');
    } finally { r.cleanup(); }
  });

  test('stale generated artifacts fail preflight and are reported without regenerating', async () => {
    const r = repo();
    try {
      const result = await r.run({ runId: 'stale', prepare: async () => ({ ok: false,
        artifactPaths: ['generated.log'], reason: 'Generated artifacts are stale' }) });
      expect(result.status).toBe('failed');
      expect(result.diagnoses).toContainEqual(expect.objectContaining({ file: 'preflight', status: 'unavailable' }));
      expect(inboxEntries(r.options.stateDir, 'program')[0]!.artifactPaths).toEqual(['generated.log']);
    } finally { r.cleanup(); }
  });
});

test('classification uses engine evidence without treating application ECONNREFUSED as Docker failure', () => {
  expect(classify('connect ECONNREFUSED 127.0.0.1:3001')).toBe('deterministic');
  for (const log of ['docker engine ECONNREFUSED', 'dial unix /var/run/docker.sock: connect: no such file or directory',
    'failed to connect to the Docker API', 'network pool exhausted', 'Out of memory: Killed process 123 (qemu)']) expect(classify(log)).toBe('infrastructure');
  expect(classify('spawnSync bun ETIMEDOUT')).toBe('deadline');
  expect(classify('No QA slot became free within one hour')).toBe('deadline');
  expect(classify('The heavy QA lock stayed held for six hours')).toBe('deadline');
  expect(classify('model failed or exceeded 180s')).toBe('deterministic');
  expect(classify('', 137)).toBe('resource');
});

test('file evidence parses Vitest stories and rejects zero tests and absent data', () => {
  const batch: Batch = { id: 'browser', tier: 'e2e', state: 'pending', attempts: [], files: ['apps/web/features/a.stories.tsx', 'packages/ui/src/a.stories.tsx', 'apps/web/tests/a.e2e.ts'] };
  expect(executionOutcomes('/repo', batch, [], '', ' ✓ |storybook (chromium)| features/a.stories.tsx (2 tests) 10ms\n ❯ |storybook (chromium)| ../../packages/ui/src/a.stories.tsx (2 tests | 1 failed)\n'))
    .toEqual({ 'apps/web/features/a.stories.tsx': 'passed', 'packages/ui/src/a.stories.tsx': 'failed', 'apps/web/tests/a.e2e.ts': 'missing' });
  expect(executionOutcomes('/repo', batch, [], '<testsuite name="features/a.stories.tsx" tests="0" failures="0"></testsuite>')['apps/web/features/a.stories.tsx']).toBe('missing');
});

test('inbox delivery is idempotent, acknowledgements are per line and infrastructure is never routed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regression-inbox-'));
  try {
    const entry = { runId: 'run', atCommit: 'sha', failingTests: ['a'], after: 'sha', goal: 'program', taskIds: [],
      status: 'inconclusive' as const, classification: 'deterministic' as const, artifactPaths: [] };
    appendInbox(dir, entry); appendInbox(dir, entry); appendInbox(dir, { ...entry, failingTests: ['b'] });
    appendInbox(dir, { ...entry, failingTests: ['infra'], classification: 'infrastructure' });
    expect(inboxEntries(dir, 'program')).toHaveLength(2);
    expect(inboxEntries(dir, 'program', 2).map(entry => entry.acknowledged)).toEqual([false, true]);
    expect(() => inboxEntries(dir, 'program', 3)).toThrow('existing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bounded CLI selections preserve the resume configuration', () => {
  expect(parseRegressArgs(['--at', 'main', '--only', 'unit,model', '--integration-batches', '2']))
    .toEqual({ at: 'main', only: ['unit', 'model'], integrationBatches: 2 });
  expect(() => parseRegressArgs(['--resume', 'run', '--only', 'unit'])).toThrow('original selection');
  expect(() => parseRegressArgs(['--integration-batches', '-1'])).toThrow('Invalid');
});

test('detached worktree names leave room for owner PostgreSQL Unix sockets', () => {
  const repo = '/home/edge/projects/rezics/rezics-next/.temp/worktrees/sample';
  const length = checkoutNameLength(repo);
  expect(Buffer.byteLength(join(repo, '.temp/regress', 'a'.repeat(length), '.temp/pg-sock/.s.PGSQL.65535'))).toBeLessThanOrEqual(107);
  expect(() => checkoutNameLength(`/tmp/${'a'.repeat(100)}`)).toThrow('too deep');
});

test('shared UI stories can be selected alone through the web Storybook command', () => {
  const root = join(import.meta.dir, '../..');
  const file = [...new Bun.Glob('packages/ui/src/**/*.stories.tsx').scanSync({ cwd: root })][0]!;
  const [program, args] = selectTestCommand([file]);
  expect(program).toBe('task');
  expect(args).toEqual(['storybook:test', '--', `../../${file}`]);
});
