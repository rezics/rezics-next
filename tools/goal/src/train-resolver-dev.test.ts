import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentAdapter, withAgentAdapter } from './agents.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { TrainResolver } from './train-resolver.ts';
import { integrationHarness } from './test-support.ts';

const file = 'packages/fixture/value.ts';
const base = 'export const value = "base";\n';
const worker = 'export const value = "worker";\n';
const dev = 'export const value = "dev";\n';
const resolved = 'export const value = "worker";\nexport const fromDev = true;\n';

async function startConflict(h: ReturnType<typeof integrationHarness>) {
  mkdirSync(dirname(join(h.root, file)), { recursive: true });
  writeFileSync(join(h.root, file), base);
  git(h.root, 'add', '--', file);
  git(h.root, 'commit', '-m', 'Seed dev resolver fixture');
  h.ensureDev();
  const task = h.dispatch(file);
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: worker }));
  await h.start(task);
  h.advanceDev(file, dev);
  return task;
}

function train(h: ReturnType<typeof integrationHarness>): MergeTrain {
  return new MergeTrain({
    ...h.settings,
    queue: h.queue,
    fence: h.store,
    sink: {
      onGateOutcome(outcome) {
        h.outcomes.push(outcome);
        h.job.onGateOutcome(outcome);
      },
    },
    trainResolver: new TrainResolver(h.store, h.tasks),
  });
}

function resolverAdapter(
  write: string,
  started?: () => void,
  marker?: string,
  targets: readonly string[] = [dev],
) {
  let calls = 0;
  return {
    adapter: {
      ...agentAdapter('codex'),
      start(options: Parameters<ReturnType<typeof agentAdapter>['start']>[0]): [string, string[]] {
        calls++;
        const data = JSON.parse(options.prompt.split('\nDATA:\n')[1]!);
        expect(data.sourceContract).toContain('goal: fixture');
        expect(data.conflict.conflictFiles).toContain(file);
        expect(data.files[0]).toMatchObject({
          path: file,
          base,
          target: targets[Math.min(calls - 1, targets.length - 1)],
          source: worker,
        });
        started?.();
        const wait = marker
          ? `const fs=require('node:fs');const until=Date.now()+30000;while(!fs.existsSync(${JSON.stringify(marker)})){if(Date.now()>until)process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`
          : '';
        return [
          process.execPath,
          ['-e', `${wait}require('node:fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(write)})`],
        ];
      },
    },
    calls: () => calls,
  };
}

test('a code conflict uses the dev resolver and lands without starting another worker attempt', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const task = await startConflict(h);
    const mocked = resolverAdapter(resolved);
    await withAgentAdapter(mocked.adapter, () => train(h).run());
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(mocked.calls()).toBe(1);
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 1 } });
    expect(outcome.conflictResolution?.tokens).toEqual({ input: 0, cached: 0, output: 0 });
    expect(readFileSync(outcome.logPath, 'utf8')).toContain('Dev landing conflict method=resolver');
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
    expect(git(h.root, 'show', `dev:${file}`)).toBe(resolved.trimEnd());
  } finally {
    h.dispose();
  }
}, 30_000);

test('the resolver releases the train lock, then retries at the front when dev moves during resolution', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const task = await startConflict(h);
    const marker = join(h.settings.stateDirectory, 'release-dev-resolver');
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => (releaseStarted = resolve));
    const mocked = resolverAdapter(resolved, releaseStarted, marker, [
      dev,
      'export const value = "dev2";\nexport const fromDev = true;\n',
    ]);
    const resolving = withAgentAdapter(mocked.adapter, () => train(h).run());
    await started;

    const otherFile = 'packages/fixture/other.ts';
    const other = h.dispatch(otherFile);
    writeFileSync(
      join(other.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: otherFile, content: 'export const other = true;\n' }),
    );
    await h.start(other);
    await h.train();
    expect(h.store.task(other.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });

    h.advanceDev(file, 'export const value = "dev2";\nexport const fromDev = true;\n');
    writeFileSync(marker, 'continue');
    await resolving;
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(mocked.calls()).toBe(2);
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 2 } });
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
    expect(git(h.root, 'show', `dev:${file}`)).toBe(resolved.trimEnd());
  } finally {
    h.dispose();
  }
}, 45_000);

test('a failed resolver returns the conflict to the same worker attempt session', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const task = await startConflict(h);
    const adapter = {
      ...agentAdapter('codex'),
      start(): [string, string[]] {
        return [process.execPath, ['-e', 'process.exit(1)']];
      },
    };
    await withAgentAdapter(adapter, () => train(h).run());
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(outcome).toMatchObject({ passed: false, conflictResolution: { method: 'worker', attempts: 1 } });
    expect(outcome.rebaseConflict?.paths).toEqual([file]);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).escalation).toBe('rebase-conflict');
  } finally {
    h.dispose();
  }
}, 30_000);
