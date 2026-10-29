import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './merge.ts';
import { rebaseOnto } from './merge-train.ts';
import { integrationHarness, repository } from './test-support.ts';

async function dispatch(h: ReturnType<typeof integrationHarness>, file: string, content: string) {
  const task = h.dispatch(file);
  mkdirSync(dirname(join(task.worktree, file)), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content }));
  await h.start(task);
  return task;
}

function notices(h: ReturnType<typeof integrationHarness>) {
  return (h.store.db.query('SELECT event FROM manager_inbox').all() as { event: string }[]).map(
    (row) => JSON.parse(row.event) as { taskId: string; summary: string },
  );
}

test('Markdown unions preserve both sides across multiple files and separated replacement hunks', () => {
  const repo = repository();
  try {
    const paths = ['guide.md', 'notes.md'];
    const content = (side: string) => `${side} start\n${'unchanged context\n'.repeat(10)}${side} end\n`;
    for (const file of paths) writeFileSync(join(repo.main, file), content('base'));
    git(repo.main, 'add', '.');
    git(repo.main, 'commit', '-m', 'Add Markdown');
    const originalBase = git(repo.main, 'rev-parse', 'HEAD');
    const worker = join(repo.path, 'worker');
    git(repo.main, 'worktree', 'add', '-b', 'worker', worker, originalBase);
    for (const file of paths) writeFileSync(join(worker, file), content('worker'));
    git(worker, 'add', '.');
    git(worker, 'commit', '-m', 'Revise worker Markdown');
    for (const file of paths) writeFileSync(join(repo.main, file), content('integration'));
    git(repo.main, 'add', '.');
    git(repo.main, 'commit', '-m', 'Revise integration Markdown');
    const log = join(repo.path, 'rebase.log');

    rebaseOnto(worker, git(repo.main, 'rev-parse', 'HEAD'), originalBase, log);

    for (const file of paths) {
      const landed = readFileSync(join(worker, file), 'utf8');
      for (const line of ['worker start', 'worker end', 'integration start', 'integration end'])
        expect(landed).toContain(line);
      expect(readFileSync(log, 'utf8')).toContain(file);
    }
    expect(git(worker, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  } finally {
    repo.close();
  }
});

test('a batch landing tells each task owner which Markdown files were unioned', async () => {
  const h = integrationHarness();
  try {
    const first = await dispatch(h, 'guide.md', '# Guide\nWorker guide\n');
    const second = await dispatch(h, 'notes.md', '# Notes\nWorker notes\n');
    h.advanceDev('guide.md', '# Guide\nIntegration guide\n');
    h.advanceDev('notes.md', '# Notes\nIntegration notes\n');

    await h.train();

    for (const [task, file] of [
      [first, 'guide.md'],
      [second, 'notes.md'],
    ] as const) {
      expect(h.store.task(task.id).state).toBe('integrated');
      const outcome = h.outcomes.find((item) => item.taskId === task.id)!;
      expect(readFileSync(outcome.logPath, 'utf8')).toContain(`Markdown union: ${file}`);
      expect(
        notices(h).some((event) => event.taskId === task.id && event.summary.includes(`Markdown union: ${file}`)),
      ).toBe(true);
    }
  } finally {
    h.dispose();
  }
}, 30_000);

test('retry unions are retained in the subsequent landing log and the task owner notice', async () => {
  const h = integrationHarness();
  try {
    const file = 'guide.md';
    const task = await dispatch(h, file, '# Guide\nWorker addition\n');
    h.advanceDev(file, '# Guide\nIntegration addition\n');
    // Let the next real worker keep the rebased result, so it reports success without overwriting the union.
    const launcher = h.tasks as unknown as { launcher: (...args: unknown[]) => unknown };
    const original = launcher.launcher;
    launcher.launcher = (...args) => {
      const content = readFileSync(join(task.worktree, file), 'utf8');
      expect(content).toContain('Worker addition');
      expect(content).toContain('Integration addition');
      writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content }));
      return original(...args);
    };
    await h.job.start(task.id, { escalation: 'rebase-conflict' });
    await h.job.drain();

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    const outcome = h.outcomes.find((item) => item.taskId === task.id && item.attempt === 2)!;
    expect(readFileSync(outcome.logPath, 'utf8')).toContain(`Markdown union: ${file}`);
    expect(
      notices(h).some((event) => event.taskId === task.id && event.summary.includes(`Markdown union: ${file}`)),
    ).toBe(true);
  } finally {
    h.dispose();
  }
}, 30_000);

test('a retry regenerates both promotion paths once after taking the integration side', async () => {
  const h = integrationHarness();
  try {
    const paths = ['packages/client/src/kernel/http/kernel.d.ts', 'contracts/openapi.json'];
    const command = [process.execPath, join(h.settings.stateDirectory, 'regenerate.mjs')];
    writeFileSync(
      command[1]!,
      `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
for (const file of ${JSON.stringify(paths)}) {
  if (readFileSync(file, 'utf8') !== 'integration output\\n') throw new Error('Generator did not receive integration side');
  writeFileSync(file, 'regenerated output\\n');
}
appendFileSync('.temp/generator-runs', 'run\\n');
`,
    );
    h.settings.derivedFiles = paths.map((path) => ({ path, stage: 'promotion', command }));
    const task = await dispatch(h, paths[0]!, 'worker output\n');
    mkdirSync(dirname(join(task.worktree, paths[1]!)), { recursive: true });
    writeFileSync(join(task.worktree, paths[1]!), 'worker output\n');
    git(task.worktree, 'add', paths[1]!);
    git(task.worktree, 'commit', '--amend', '--no-edit');
    for (const file of paths) h.advanceDev(file, 'integration output\n');
    let regenerated = false;
    (h.tasks as unknown as { launcher: () => undefined }).launcher = () => {
      for (const file of paths) expect(readFileSync(join(task.worktree, file), 'utf8')).toBe('regenerated output\n');
      expect(readFileSync(join(task.worktree, '.temp/generator-runs'), 'utf8')).toBe('run\n');
      expect(git(task.worktree, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      regenerated = true;
      return undefined;
    };
    const retry = (
      h.tasks as unknown as { retryTask: (id: string, options: object, leased: boolean) => Promise<unknown> }
    ).retryTask;

    await retry.call(h.tasks, task.id, { escalation: 'rebase-conflict' }, true);

    expect(regenerated).toBe(true);
  } finally {
    h.dispose();
  }
}, 30_000);

test('a dev landing resolves Markdown together with a promotion-stage generated conflict', async () => {
  const h = integrationHarness();
  try {
    const generated = 'contracts/openapi.json';
    const command = [process.execPath, join(h.settings.stateDirectory, 'regenerate.mjs')];
    writeFileSync(
      command[1]!,
      `
import { readFileSync, writeFileSync } from 'node:fs';
if (readFileSync('contracts/openapi.json', 'utf8') !== 'integration output\\n') throw new Error('Wrong generated side');
writeFileSync('contracts/openapi.json', 'regenerated output\\n');
`,
    );
    h.settings.derivedFiles = [{ path: generated, stage: 'promotion', command }];
    const task = await dispatch(h, 'guide.md', '# Guide\nWorker addition\n');
    mkdirSync(join(task.worktree, 'contracts'), { recursive: true });
    writeFileSync(join(task.worktree, generated), 'worker output\n');
    git(task.worktree, 'add', generated);
    git(task.worktree, 'commit', '--amend', '--no-edit');
    h.advanceDev('guide.md', '# Guide\nIntegration addition\n');
    h.advanceDev(generated, 'integration output\n');

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${generated}`)).toBe('regenerated output');
    const guide = git(h.root, 'show', 'dev:guide.md');
    expect(guide).toContain('Worker addition');
    expect(guide).toContain('Integration addition');
  } finally {
    h.dispose();
  }
}, 30_000);
