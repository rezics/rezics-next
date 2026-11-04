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

async function startConflict(
  h: ReturnType<typeof integrationHarness>,
  conflictFile = file,
  baseContent = base,
  workerContent = worker,
  devContent = dev,
) {
  mkdirSync(dirname(join(h.root, conflictFile)), { recursive: true });
  writeFileSync(join(h.root, conflictFile), baseContent);
  git(h.root, 'add', '--', conflictFile);
  git(h.root, 'commit', '-m', 'Seed dev resolver fixture');
  h.ensureDev();
  const task = h.dispatch(conflictFile);
  writeFileSync(
    join(task.worktree, '.temp/worker-plan.json'),
    JSON.stringify({ file: conflictFile, content: workerContent }),
  );
  await h.start(task);
  h.advanceDev(conflictFile, devContent);
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
  expectedFile = file,
  inspectPrompt?: (prompt: string, data: any) => void,
  writeDirectly = false,
) {
  let calls = 0;
  return {
    adapter: {
      ...agentAdapter('codex'),
      start(options: Parameters<ReturnType<typeof agentAdapter>['start']>[0]): [string, string[]] {
        calls++;
        const data = JSON.parse(options.prompt.split('\nDATA:\n')[1]!);
        expect(data.sourceContract).toContain('goal: fixture');
        expect(data.conflict.conflictFiles).toContain(expectedFile);
        expect(data.files.map((item: { path: string }) => item.path)).toContain(expectedFile);
        expect(options.prompt).toContain('git show :1:<path>');
        expect(options.prompt).toContain('git show :2:<path>');
        expect(options.prompt).toContain('git show :3:<path>');
        const target = targets[Math.min(calls - 1, targets.length - 1)]!;
        const targetLine = target.split(/\r?\n/).find((line) => /dev/i.test(line));
        if (targetLine) expect(data.files.find((item: { path: string }) => item.path === expectedFile).conflictHunks).toContain(targetLine);
        inspectPrompt?.(options.prompt, data);
        started?.();
        if (writeDirectly) {
          writeFileSync(join(options.worktree, expectedFile), write);
          return [process.execPath, ['-e', 'process.exit(0)']];
        }
        const wait = marker
          ? `const fs=require('node:fs');const until=Date.now()+30000;while(!fs.existsSync(${JSON.stringify(marker)})){if(Date.now()>until)process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`
          : '';
        return [
          process.execPath,
          ['-e', `${wait}require('node:fs').writeFileSync(${JSON.stringify(expectedFile)},${JSON.stringify(write)})`],
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

test('large Markdown and TypeScript conflicts resolve from compact hunks with readable stages', async () => {
  const scenarios = [
    {
      file: 'packages/fixture/large.md',
      size: 400 * 1024,
      prefix: '# Unchanged context\n',
      baseChange: 'old permission',
      workerChange: 'new permission',
      devChange: 'dev note',
      resolvedChange: 'new permission\ndev note',
      markdown: true,
    },
    {
      file: 'packages/fixture/large.ts',
      size: 150 * 1024,
      prefix: '// unchanged context\n',
      baseChange: 'export const value = "base";',
      workerChange: 'export const value = "worker";',
      devChange: 'export const value = "dev";',
      resolvedChange: 'export const value = "resolved";',
      markdown: false,
    },
  ];

  for (const scenario of scenarios) {
    const h = integrationHarness();
    try {
      h.settings.integration.devLandingChecks = false;
      const padding = scenario.prefix.repeat(Math.ceil(scenario.size / Buffer.byteLength(scenario.prefix)));
      const before = `${padding}before\n`;
      const after = '\nafter\n';
      const baseContent = `${before}${scenario.baseChange}${after}`;
      const workerContent = `${before}${scenario.workerChange}${after}`;
      const devContent = scenario.markdown
        ? `${before}${scenario.baseChange}\n${scenario.devChange}${after}`
        : `${before}${scenario.devChange}${after}`;
      const resolvedContent = scenario.markdown
        ? `${before}${scenario.resolvedChange}${after}`
        : `${before}${scenario.resolvedChange}${after}`;
      const task = await startConflict(h, scenario.file, baseContent, workerContent, devContent);
      const mocked = resolverAdapter(
        resolvedContent,
        undefined,
        undefined,
        [devContent],
        scenario.file,
        (prompt, data) => {
          expect(Buffer.byteLength(prompt)).toBeLessThan(64 * 1024);
          expect(data.files[0].conflictHunks).toContain('before');
          expect(data.files[0].conflictHunks).toContain(scenario.workerChange);
          expect(data.files[0].conflictHunks).toContain(scenario.devChange);
        },
        true,
      );
      await withAgentAdapter(mocked.adapter, () => train(h).run());
      await h.job.drain();

      const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
      expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 1 } });
      expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
      expect(git(h.root, 'show', `dev:${scenario.file}`)).toBe(resolvedContent.trimEnd());
    } finally {
      h.dispose();
    }
  }
}, 60_000);

test('long compiler evidence reaches repair with first and last lines and the full log path', async () => {
  const h = integrationHarness();
  try {
    const task = await startConflict(h);
    const entry = h.queue.next()!;
    const request = entry.request;
    const sourceCommit = git(h.root, 'rev-parse', request.branch);
    const targetHead = git(h.root, 'rev-parse', 'dev');
    const commonBase = git(h.root, 'merge-base', sourceCommit, targetHead);
    const logPath = join(h.settings.stateDirectory, 'compiler-output-full.log');
    const compilerOutput = [
      'FIRST_COMPILER_DIAGNOSTIC',
      ...Array.from({ length: 20_000 }, (_, index) => `compiler detail ${index}`),
      'LAST_COMPILER_DIAGNOSTIC',
    ].join('\n');
    writeFileSync(logPath, compilerOutput);
    const conflict = {
      taskId: request.taskId,
      attempt: request.attempt,
      key: 'long-compiler-evidence',
      sourceCommit,
      targetCommit: targetHead,
      targetRef: 'refs/heads/dev',
      targetHead,
      commonBase,
      conflictFiles: [file],
      startedAt: new Date().toISOString(),
      method: 'resolver' as const,
      tokens: { input: 0, cached: 0, output: 0 },
    };
    const adapter = {
      ...agentAdapter('codex'),
      start(options: Parameters<ReturnType<typeof agentAdapter>['start']>[0]): [string, string[]] {
        expect(options.prompt).toContain('FIRST_COMPILER_DIAGNOSTIC');
        expect(options.prompt).toContain('LAST_COMPILER_DIAGNOSTIC');
        expect(options.prompt).toContain(logPath);
        expect(options.prompt).not.toContain('compiler detail 10000');
        writeFileSync(join(options.worktree, file), 'repaired source\n');
        return [process.execPath, ['-e', 'process.exit(0)']];
      },
    };
    const repaired = await withAgentAdapter(adapter, () =>
      new TrainResolver(h.store, h.tasks).repair(request, task.worktree, conflict, compilerOutput, logPath),
    );
    expect(repaired).toBe(true);
    expect(readFileSync(join(task.worktree, file), 'utf8')).toBe('repaired source\n');
  } finally {
    h.dispose();
  }
}, 30_000);

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
