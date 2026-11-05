import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentAdapter, withAgentAdapter } from './agents.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { TrainResolver } from './train-resolver.ts';
import { integrationHarness } from './test-support.ts';
import { lifecycleMetrics } from './lifecycle-metrics.ts';
import { formatLifecycleMetrics } from './report.ts';
import { codexAdapter } from './agents/codex.ts';
import { flowReport, readFlow, readFlowTasks } from './flow.ts';

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
  extraWorker?: { file: string; content: string },
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
  if (extraWorker) {
    mkdirSync(dirname(join(task.worktree, extraWorker.file)), { recursive: true });
    writeFileSync(join(task.worktree, extraWorker.file), extraWorker.content);
    git(task.worktree, 'add', '--', extraWorker.file);
    git(task.worktree, 'commit', '-qm', 'Retain effective fixture change');
  }
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
      onDevLandingTranspileHandoff(handoff) {
        h.job.onDevLandingTranspileHandoff(handoff);
      },
    },
    trainResolver: new TrainResolver(h.store, h.tasks),
  });
}

function resolverAdapter(
  write: string,
  started?: (call: number) => void,
  marker?: string | readonly string[],
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
        expect(options.promptViaStdin).toBe(true);
        const data = JSON.parse(options.prompt.split('\nDATA:\n')[1]!);
        expect(data.sourceContract).toContain('goal: fixture');
        expect(data.conflict.conflictFiles).toContain(expectedFile);
        expect(data.files.map((item: { path: string }) => item.path)).toContain(expectedFile);
        expect(options.prompt).toContain('git show :1:<path>');
        expect(options.prompt).toContain('git show :2:<path>');
        expect(options.prompt).toContain('git show :3:<path>');
        const target = targets[Math.min(calls - 1, targets.length - 1)]!;
        const targetLine = target.split(/\r?\n/).find((line) => /dev/i.test(line));
        if (targetLine)
          expect(data.files.find((item: { path: string }) => item.path === expectedFile).conflictHunks).toContain(
            targetLine,
          );
        inspectPrompt?.(options.prompt, data);
        started?.(calls);
        const callMarker = typeof marker === 'string' ? marker : marker?.[Math.min(calls - 1, marker.length - 1)];
        const promptBytes = Buffer.byteLength(options.prompt);
        const promptHash = createHash('sha256').update(options.prompt).digest('hex');
        const delivery = `const crypto=require('node:crypto');let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{if(Buffer.byteLength(prompt)!==${promptBytes}||crypto.createHash('sha256').update(prompt).digest('hex')!==${JSON.stringify(promptHash)})process.exit(3);${writeDirectly ? '' : `require('node:fs').writeFileSync(${JSON.stringify(expectedFile)},${JSON.stringify(write)})`}});`;
        const args = ['-e', `${waitForMarker(callMarker)}${delivery}`];
        expect(args.join('\0')).not.toContain(options.prompt);
        if (writeDirectly) {
          writeFileSync(join(options.worktree, expectedFile), write);
          return [process.execPath, args];
        }
        return [process.execPath, args];
      },
    },
    calls: () => calls,
  };
}

function waitForMarker(marker?: string): string {
  return marker
    ? `const fs=require('node:fs');const until=Date.now()+30000;while(!fs.existsSync(${JSON.stringify(marker)})){if(Date.now()>until)process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`
    : '';
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
    expect(h.store.events(task.id, 1).some((event) => event.kind === 'dev-conflict-landed')).toBe(true);
  } finally {
    h.dispose();
  }
}, 30_000);

test('a resolution replays cleanly onto an unrelated new dev head without another resolver session', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const task = await startConflict(h);
    const marker = join(h.settings.stateDirectory, 'release-dev-resolver');
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => (releaseStarted = resolve));
    const mocked = resolverAdapter(resolved, releaseStarted, marker);
    const resolving = withAgentAdapter(mocked.adapter, () => train(h).run());
    await started;

    const devOnly = 'packages/fixture/dev-only.ts';
    h.advanceDev(devOnly, 'export const devOnly = true;\n');
    writeFileSync(marker, 'continue');
    await resolving;
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(mocked.calls()).toBe(1);
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 1 } });
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
    expect(git(h.root, 'show', `dev:${file}`)).toBe(resolved.trimEnd());
    expect(git(h.root, 'show', `dev:${devOnly}`)).toBe('export const devOnly = true;');
    expect(git(h.root, 'worktree', 'list', '--porcelain')).not.toContain('train-resolver-dev-');
  } finally {
    h.dispose();
  }
}, 45_000);

test('a target-preserving resolution publishes its other change after dev moves', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const effectiveFile = 'packages/fixture/effective.txt';
    const concurrentFile = 'packages/fixture/concurrent.txt';
    const task = await startConflict(h, file, base, worker, dev, {
      file: effectiveFile,
      content: 'worker effective change\n',
    });
    const marker = join(h.settings.stateDirectory, 'release-target-preserving-resolver');
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolve) => (releaseStarted = resolve));
    const mocked = resolverAdapter(dev, releaseStarted, marker);
    const resolving = withAgentAdapter(mocked.adapter, () => train(h).run());
    await started;

    const concurrentHead = h.advanceDev(concurrentFile, 'concurrent target edit\n');
    writeFileSync(marker, 'continue');
    await resolving;
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(mocked.calls()).toBe(1);
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 1 } });
    expect(outcome.mergedCommit).toBe(git(h.root, 'rev-parse', 'refs/heads/dev'));
    expect(outcome.mergedCommit).not.toBe(concurrentHead);
    expect(h.store.task(task.id)).toMatchObject({
      currentAttempt: 1,
      state: 'integrated',
      integratedCommit: outcome.mergedCommit,
    });
    expect(git(h.root, 'show', `dev:${file}`)).toBe(dev.trimEnd());
    expect(git(h.root, 'show', `dev:${effectiveFile}`)).toBe('worker effective change');
    expect(git(h.root, 'show', `dev:${concurrentFile}`)).toBe('concurrent target edit');
  } finally {
    h.dispose();
  }
}, 45_000);

test('a resolution that conflicts with a moved dev head runs the resolver again on that head', async () => {
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
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 2 } });
    expect(mocked.calls()).toBe(2);
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
    expect(git(h.root, 'show', `dev:${file}`)).toBe(resolved.trimEnd());
  } finally {
    h.dispose();
  }
}, 45_000);

test('separate dev moves during resolver passes replay and land the same accepted worker attempt', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const task = await startConflict(h);
    const workerCommit = git(task.worktree, 'rev-parse', 'HEAD');
    const firstMove = 'export const value = "dev2";\nexport const fromDev = true;\n';
    const lateFile = 'packages/fixture/dev-late.ts';
    const firstMarker = join(h.settings.stateDirectory, 'release-first-dev-resolver');
    const secondMarker = join(h.settings.stateDirectory, 'release-second-dev-resolver');
    let releaseFirstStarted!: () => void;
    let releaseSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => (releaseFirstStarted = resolve));
    const secondStarted = new Promise<void>((resolve) => (releaseSecondStarted = resolve));
    const mocked = resolverAdapter(
      resolved,
      (call) => {
        if (call === 1) releaseFirstStarted();
        if (call === 2) releaseSecondStarted();
      },
      [firstMarker, secondMarker],
      [dev, firstMove],
    );
    const resolving = withAgentAdapter(mocked.adapter, () => train(h).run());
    await firstStarted;

    const firstTarget = h.advanceDev(file, firstMove);
    writeFileSync(firstMarker, 'continue');
    const secondBoundary = await Promise.race([
      secondStarted.then(() => 'second resolver started'),
      resolving.then(() => 'train finished before second resolver'),
    ]);
    expect(secondBoundary).toBe('second resolver started');
    expect(mocked.calls()).toBe(2);

    const secondTarget = h.advanceDev(lateFile, 'export const devLate = true;\n');
    writeFileSync(secondMarker, 'continue');
    await resolving;
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    const finalHead = h.head();
    expect(h.outcomes.filter((item) => item.taskId === task.id)).toHaveLength(1);
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 2 } });
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
    expect(h.store.events(task.id, 1).filter((event) => event.kind === 'dev-conflict-landed')).toHaveLength(1);
    expect(git(h.root, 'show', `dev:${file}`)).toBe(resolved.trimEnd());
    expect(git(h.root, 'show', `dev:${lateFile}`)).toBe('export const devLate = true;');
    expect(git(h.root, 'rev-parse', `${finalHead}^1`)).toBe(secondTarget);
    expect(git(h.root, 'rev-parse', `${finalHead}^2`)).toBe(workerCommit);
    expect(git(h.root, 'merge-base', '--is-ancestor', firstTarget, finalHead)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', secondTarget, finalHead)).toBe('');
    expect(readFileSync(outcome.logPath, 'utf8')).toContain('Train resolution replayed cleanly');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a 300 KB resolver prompt is delivered over stdin and the resolution lands', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    const task = await startConflict(h);
    h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
      current.brief.markdown += `\n${'x'.repeat(300 * 1024)}`;
    });
    const mocked = resolverAdapter(resolved, undefined, undefined, [dev], file, (prompt) => {
      expect(Buffer.byteLength(prompt)).toBeGreaterThanOrEqual(300 * 1024);
      const [, codexArgs] = codexAdapter.start({
        profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'codex' },
        pool: h.settings.pools.find((pool) => pool.cli === 'codex')!,
        worktree: task.worktree,
        prompt,
        promptViaStdin: true,
        resolver: true,
        codex: h.settings.codex,
      });
      expect(codexArgs.at(-1)).toBe('-');
      expect(codexArgs.join('\0')).not.toContain(prompt);
    });
    await withAgentAdapter(mocked.adapter, () => train(h).run());
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(mocked.calls()).toBe(1);
    expect(outcome).toMatchObject({ passed: true, conflictResolution: { method: 'resolver', attempts: 1 } });
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
        return [process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"]];
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
        return [process.execPath, ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(1))"]];
      },
    };
    await withAgentAdapter(adapter, () => train(h).run());
    await h.job.drain();

    const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
    expect(outcome).toMatchObject({ passed: false, conflictResolution: { method: 'worker', attempts: 1 } });
    expect(outcome.rebaseConflict?.paths).toEqual([file]);
    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).escalation).toBe('rebase-conflict');
    const returned = h.store.events(task.id, 1).find((event) => event.kind === 'dev-conflict-returned');
    expect(JSON.parse(returned!.body).reason).toContain('Train resolver exited with 1');
    expect(formatLifecycleMetrics(lifecycleMetrics(h.store.db, Date.now())).join('\n')).toContain(
      'Dev resolver conflicts in trailing hour: 0 resolved and landed; 1 returned to worker (reasons: 1 × Error: Train resolver exited with 1); 0 still in progress',
    );
  } finally {
    h.dispose();
  }
}, 30_000);

test('a dev compile defect returns to the original worker session, repairs in place and lands only after a fresh transpile', async () => {
  const h = integrationHarness();
  const file = 'packages/fixture/const-reassignment.ts';
  let resumedSession: string | undefined;
  let repairPrompt = '';
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const file = ${JSON.stringify(file)};
    const content = process.env.GOAL_ATTEMPT === '1'
      ? 'const count = 1;\\ncount = 2;\\nexport { count };\\n'
      : 'export const count = 2;\\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const committed = spawnSync('git', ['add', '--', file], { stdio: 'ignore' });
    if (committed.status !== 0 || spawnSync('git', ['commit', '-qm', 'Worker fixture source']).status !== 0) process.exit(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'compiler-repair-session' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RESULT: success' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
  `;
  const adapter = {
    ...codexAdapter,
    start() {
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
    resume(options: Parameters<NonNullable<typeof codexAdapter.resume>>[0]) {
      resumedSession = options.session;
      repairPrompt = options.prompt;
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
  };
  try {
    h.settings.integration.devLandingChecks = false;
    h.ensureDev();
    const task = h.dispatch(file);
    await withAgentAdapter(adapter, async () => {
      await h.start(task);
      const brokenSource = git(task.worktree, 'rev-parse', 'HEAD');
      await h.train();
      expect(resumedSession).toBe('compiler-repair-session');
      expect(repairPrompt).toContain('Bun rejected dev candidate');
      expect(repairPrompt).toContain('const-reassignment.ts:2:');
      expect(repairPrompt).toContain('Retained compiler log:');
      const retry = h.store.task(task.id);
      expect(retry.currentAttempt).toBe(2);
      expect(git(task.worktree, 'rev-parse', 'HEAD')).not.toBe(brokenSource);
      await h.train();
    });
    const diagnosticEvent = h.store.events(task.id, 1).find((event) => event.kind === 'dev-landing-transpile-returned');
    const diagnostic = JSON.parse(diagnosticEvent!.body) as {
      sourceCommit: string;
      candidate: string;
      logPath: string;
      diagnostic: string;
      compilerDiagnostic: { file: string; line: number; column: number; message: string };
    };
    expect(diagnostic.sourceCommit).toBe(git(task.worktree, 'rev-parse', 'HEAD~1'));
    expect(diagnostic.candidate).toMatch(/^[0-9a-f]{40}$/);
    expect(diagnostic.logPath.startsWith('/')).toBe(true);
    expect(existsSync(diagnostic.logPath)).toBe(true);
    expect(existsSync(diagnostic.compilerDiagnostic.file)).toBe(true);
    expect(diagnostic.compilerDiagnostic).toMatchObject({ file: join(task.worktree, file), line: 2 });
    expect(readFileSync(diagnostic.logPath, 'utf8')).toContain('Dev landing transpile diagnostic:');
    expect(diagnostic.diagnostic).toContain('constant');
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.outcome).toBe('superseded');
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('superseded');
    expect(h.store.events(task.id, 1).filter((event) => event.kind === 'gate-outcome')).toHaveLength(0);
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.guardIds).toContain('dev-landing-transpile');
    expect(h.store.task(task.id).state).toBe('integrated');
    const landed = git(h.root, 'show', `dev:${file}`);
    expect(landed).toBe('export const count = 2;');
    const outcome = h.outcomes.find((item) => item.taskId === task.id && item.passed)!;
    expect(git(h.root, 'rev-parse', 'dev')).toBe(outcome.devTranspile!.candidate);
    expect(outcome.devTranspile).toMatchObject({ outcome: 'passed', typescriptFileCount: 1 });
    const price = flowReport(readFlow(h.store.db), readFlowTasks(h.store.db));
    expect(price.devTranspile).toMatchObject({
      successfulChecks: 1,
      repairHandbacks: 1,
      unavailable: 0,
      measuredChecks: 2,
    });
    expect(price.devTranspile.totalMs).toBeGreaterThanOrEqual(0);
  } finally {
    h.dispose();
  }
}, 60_000);

test('the combined dev candidate is transpiled once with all changed TypeScript entries', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    h.settings.integration.batchSize = 2;
    h.ensureDev();
    const entries = ['packages/fixture/combined-a.ts', 'packages/fixture/combined-b.ts'];
    const tasks = entries.map((path) => h.dispatch(path));
    for (const [index, task] of tasks.entries()) {
      const path = entries[index]!;
      writeFileSync(
        join(task.worktree, '.temp/worker-plan.json'),
        JSON.stringify({ file: path, content: `export const value${index} = ${index};\n` }),
      );
      await h.start(task);
    }
    await h.train();
    const combined = h.outcomes.find((outcome) => outcome.devTranspile);
    expect(combined?.devTranspile).toMatchObject({ outcome: 'passed', changedFileCount: 2, typescriptFileCount: 2 });
    for (const path of entries) expect(git(h.root, 'show', `dev:${path}`)).toContain('export const value');
    const events = readFlow(h.store.db).filter((event) => event.action === 'dev-transpile');
    expect(events).toHaveLength(1);
    expect(flowReport(events, readFlowTasks(h.store.db)).devTranspile.successfulChecks).toBe(1);
    expect(flowReport(readFlow(h.store.db), readFlowTasks(h.store.db)).devKernelImport.successfulChecks).toBe(0);
  } finally {
    h.dispose();
  }
}, 60_000);

test('control-plane source that lands on dev receives the same changed-file transpile', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    h.ensureDev();
    const path = 'tools/goal/src/control-plane-fixture.ts';
    const task = h.dispatch(path, [], ['true'], 'control-plane');
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: path, content: 'export const controlPlaneFixture = true;\n' }),
    );
    await h.start(task);
    await h.train();
    const outcome = h.outcomes.find((item) => item.taskId === task.id && item.passed)!;
    expect(outcome.devTranspile).toMatchObject({ outcome: 'passed', changedFileCount: 1, typescriptFileCount: 1 });
    expect(git(h.root, 'show', `dev:${path}`)).toBe('export const controlPlaneFixture = true;');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a moving dev head replays the candidate and publishes only the freshly transpiled result', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    h.ensureDev();
    const path = 'packages/fixture/replay.ts';
    const task = h.dispatch(path);
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: path, content: 'export const replayed = true;\n' }),
    );
    await h.start(task);
    let moved = false;
    const train = new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome(outcome) {
          h.outcomes.push(outcome);
          h.job.onGateOutcome(outcome);
        },
      },
      beforeIntegrationAdvance() {
        if (moved) return;
        moved = true;
        h.advanceDev('packages/fixture/replay-peer.ts', 'export const peer = true;\n');
      },
    });
    await train.run();
    await h.job.drain();
    expect(moved).toBe(true);
    expect(git(h.root, 'show', `dev:${path}`)).toBe('export const replayed = true;');
    expect(git(h.root, 'show', 'dev:packages/fixture/replay-peer.ts')).toBe('export const peer = true;');
    const outcome = h.outcomes.find((item) => item.taskId === task.id && item.passed)!;
    expect(git(h.root, 'rev-parse', 'dev')).toBe(outcome.devTranspile!.candidate);
    const report = flowReport(readFlow(h.store.db), readFlowTasks(h.store.db));
    expect(report.devTranspile).toMatchObject({ successfulChecks: 1, repairHandbacks: 0, measuredChecks: 1 });
  } finally {
    h.dispose();
  }
}, 60_000);

// The Kernel dump command needs a throwaway Postgres; this stand-in derives the dump from the migrations and fails on a
// migration marked `-- fail:`, which is enough to exercise the schema regeneration step, its commit and its handback.
const KERNEL_DERIVED_STAND_IN = [
  "import { readdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "const migrations = readdirSync('db/access/migrations').sort().map((name) => readFileSync('db/access/migrations/' + name, 'utf8')).join('');",
  'const failure = migrations.match(/^-- fail: (.+)$/m);',
  'if (failure) {',
  "  console.error('ERROR: ' + failure[1]);",
  '  process.exit(1);',
  '}',
  "writeFileSync('db/access/schema.sql', '-- derived\\n' + migrations);",
].join('\n');

test('a migration on a dev landing publishes its regenerated schema dump, and a failed regeneration returns to the worker', async () => {
  const h = integrationHarness();
  const migration = 'services/kernel/db/access/migrations/002_recovery.sql';
  let resumedSession: string | undefined;
  let repairPrompt = '';
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const file = ${JSON.stringify(migration)};
    const content = process.env.GOAL_ATTEMPT === '1'
      ? '-- fail: column "recovery" does not exist\\n'
      : 'alter table accounts add recovery text;\\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const committed = spawnSync('git', ['add', '--', file], { stdio: 'ignore' });
    if (committed.status !== 0 || spawnSync('git', ['commit', '-qm', 'Worker migration']).status !== 0) process.exit(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'schema-repair-session' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RESULT: success' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
  `;
  const adapter = {
    ...codexAdapter,
    start() {
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
    resume(options: Parameters<NonNullable<typeof codexAdapter.resume>>[0]) {
      resumedSession = options.session;
      repairPrompt = options.prompt;
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
  };
  try {
    h.settings.integration.devLandingChecks = false;
    h.advanceDev(
      'services/kernel/package.json',
      `${JSON.stringify({ private: true, scripts: { derived: 'bun scripts/derived.ts' } })}\n`,
    );
    h.advanceDev('services/kernel/scripts/derived.ts', `${KERNEL_DERIVED_STAND_IN}\n`);
    h.advanceDev('services/kernel/db/access/migrations/001_accounts.sql', 'create table accounts ();\n');
    h.advanceDev('services/kernel/db/access/schema.sql', '-- derived\ncreate table accounts ();\n');
    h.ensureDev();
    const task = h.dispatch(migration);
    await withAgentAdapter(adapter, async () => {
      await h.start(task);
      await h.train();
      expect(resumedSession).toBe('schema-repair-session');
      expect(repairPrompt).toContain('Schema dump regeneration rejected dev candidate');
      expect(repairPrompt).toContain('Regeneration error: ERROR: column "recovery" does not exist');
      expect(repairPrompt).toContain('Retained regeneration log:');
      expect(h.store.task(task.id).currentAttempt).toBe(2);
      await h.train();
    });
    expect(h.store.events(task.id, 1).some((event) => event.kind === 'dev-landing-transpile-returned')).toBe(true);
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.guardIds).toContain('dev-landing-schema');
    expect(h.store.events(task.id, 1).filter((event) => event.kind === 'gate-outcome')).toHaveLength(0);
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', 'dev:services/kernel/db/access/schema.sql')).toContain(
      'alter table accounts add recovery text;',
    );
    expect(git(h.root, 'log', '--format=%s', '-2', 'dev')).toBe(
      `chore(kernel): regenerate schema dumps for ${task.id}\nWorker migration`,
    );
    expect(git(h.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'dev')).toBe(
      'services/kernel/db/access/schema.sql',
    );
  } finally {
    h.dispose();
  }
}, 120_000);

const KERNEL_IMPORT_STAND_IN = [
  "import { appendFileSync } from 'node:fs';",
  'export async function withThrowawayDatabase(work) {',
  "  if (process.env.KERNEL_IMPORT_RUNS) appendFileSync(process.env.KERNEL_IMPORT_RUNS, 'run\\n');",
  "  return work({ ...process.env, DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:59999/rezics?sslmode=disable', KERNEL_DATABASE_CONTAINER: 'fixture' });",
  '}',
  'if (import.meta.main) process.exit(0);',
].join('\n');

function seedKernelImportFixture(h: ReturnType<typeof integrationHarness>, server: string, worker: string) {
  h.advanceDev(
    'services/kernel/package.json',
    `${JSON.stringify({ private: true, scripts: { derived: 'bun scripts/derived.ts' } })}\n`,
  );
  h.advanceDev('services/kernel/scripts/derived.ts', `${KERNEL_IMPORT_STAND_IN}\n`);
  h.advanceDev('services/kernel/src/server.ts', server);
  h.advanceDev('services/kernel/src/worker.ts', worker);
}

test('a Kernel-source TDZ on a dev landing returns to the original session and publishes after repair', async () => {
  const h = integrationHarness();
  h.settings.integration.devKernelImport = true;
  const file = 'services/kernel/src/cycle-a.ts';
  let resumedSession: string | undefined;
  let repairPrompt = '';
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const file = ${JSON.stringify(file)};
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, process.env.GOAL_ATTEMPT === '1'
      ? "import { b } from './cycle-b.ts';\\nexport const a = b + 1;\\n"
      : 'export const a = 1;\\n');
    if (spawnSync('git', ['add', '--', file], { stdio: 'ignore' }).status !== 0 || spawnSync('git', ['commit', '-qm', 'Worker kernel source']).status !== 0) process.exit(2);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'kernel-import-repair-session' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RESULT: success' } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }));
  `;
  const adapter = {
    ...codexAdapter,
    start() {
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
    resume(options: Parameters<NonNullable<typeof codexAdapter.resume>>[0]) {
      resumedSession = options.session;
      repairPrompt = options.prompt;
      return [process.execPath, ['-e', script]] as [string, string[]];
    },
  };
  try {
    h.settings.integration.devLandingChecks = false;
    seedKernelImportFixture(
      h,
      "import { a } from './cycle-a.ts';\nexport const server = a;\n",
      'export const worker = true;\n',
    );
    h.advanceDev('services/kernel/src/cycle-b.ts', "import { a } from './cycle-a.ts';\nexport const b = a + 1;\n");
    h.ensureDev();
    const runs = join(h.root, '.temp', 'kernel-import-runs.log');
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    process.env.KERNEL_IMPORT_RUNS = runs;
    const task = h.dispatch(file);
    await withAgentAdapter(adapter, async () => {
      await h.start(task);
      await h.train();
      expect(resumedSession).toBe('kernel-import-repair-session');
      expect(repairPrompt).toContain('Kernel entry import rejected dev candidate');
      expect(repairPrompt).toContain('Retained import log:');
      expect(h.store.task(task.id).currentAttempt).toBe(2);
      await h.train();
    });
    expect(h.store.events(task.id, 1).some((event) => event.kind === 'dev-landing-transpile-returned')).toBe(true);
    expect(h.store.record({ taskId: task.id, attempt: 1 })?.guardIds).toContain('dev-landing-kernel-import');
    expect(h.store.events(task.id, 1).filter((event) => event.kind === 'gate-outcome')).toHaveLength(0);
    expect(h.store.attempt({ taskId: task.id, attempt: 1 }).state).toBe('superseded');
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${file}`)).toBe('export const a = 1;');
    const outcome = h.outcomes.find((item) => item.taskId === task.id && item.passed)!;
    expect(outcome.devKernelImport).toMatchObject({ outcome: 'passed' });
    const price = flowReport(readFlow(h.store.db), readFlowTasks(h.store.db));
    expect(price.devKernelImport).toMatchObject({ successfulChecks: 1, repairHandbacks: 1 });
  } finally {
    delete process.env.KERNEL_IMPORT_RUNS;
    h.dispose();
  }
}, 60_000);

test('a combined Kernel-source candidate runs one import phase, and a replayed candidate is imported again', async () => {
  const h = integrationHarness();
  h.settings.integration.devKernelImport = true;
  try {
    h.settings.integration.devLandingChecks = false;
    h.settings.integration.batchSize = 2;
    seedKernelImportFixture(h, 'export const server = true;\n', 'export const worker = true;\n');
    h.ensureDev();
    const runs = join(h.root, '.temp', 'kernel-import-runs.log');
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    writeFileSync(runs, '');
    process.env.KERNEL_IMPORT_RUNS = runs;
    const entries = ['services/kernel/src/member-a.ts', 'services/kernel/src/member-b.ts'];
    const tasks = entries.map((path) => h.dispatch(path));
    for (const [index, task] of tasks.entries()) {
      writeFileSync(
        join(task.worktree, '.temp/worker-plan.json'),
        JSON.stringify({ file: entries[index]!, content: `export const member${index} = ${index};\n` }),
      );
      await h.start(task);
    }
    await h.train();
    const combined = h.outcomes.find((outcome) => outcome.devKernelImport);
    expect(combined?.devKernelImport).toMatchObject({ outcome: 'passed', kernelFileCount: 2 });
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toEqual(['run']);
    writeFileSync(runs, '');
    const replay = h.dispatch('services/kernel/src/replay.ts');
    writeFileSync(
      join(replay.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'services/kernel/src/replay.ts', content: 'export const replayed = true;\n' }),
    );
    await h.start(replay);
    let moved = false;
    const trainRun = new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome(outcome) {
          h.outcomes.push(outcome);
          h.job.onGateOutcome(outcome);
        },
        onDevLandingTranspileHandoff(handoff) {
          h.job.onDevLandingTranspileHandoff(handoff);
        },
      },
      beforeIntegrationAdvance() {
        if (moved) return;
        moved = true;
        h.advanceDev('services/kernel/src/replay-peer.ts', 'export const peer = true;\n');
      },
    });
    await trainRun.run();
    await h.job.drain();
    expect(moved).toBe(true);
    expect(readFileSync(runs, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(1);
    const replayed = h.outcomes.find((item) => item.taskId === replay.id && item.passed)!;
    expect(replayed.devKernelImport).toMatchObject({ outcome: 'passed' });
  } finally {
    delete process.env.KERNEL_IMPORT_RUNS;
    h.dispose();
  }
}, 60_000);

test('control-plane landings on dev skip Kernel import when the candidate has no Kernel source delta', async () => {
  const h = integrationHarness();
  try {
    h.settings.integration.devLandingChecks = false;
    seedKernelImportFixture(h, 'export const server = true;\n', 'export const worker = true;\n');
    h.ensureDev();
    const path = 'tools/goal/src/control-plane-kernel-skip.ts';
    const task = h.dispatch(path, [], ['true'], 'control-plane');
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: path, content: 'export const controlPlaneKernelSkip = true;\n' }),
    );
    await h.start(task);
    await h.train();
    const outcome = h.outcomes.find((item) => item.taskId === task.id && item.passed)!;
    expect(outcome.devKernelImport).toBeUndefined();
    expect(git(h.root, 'show', `dev:${path}`)).toBe('export const controlPlaneKernelSkip = true;');
  } finally {
    h.dispose();
  }
}, 60_000);
