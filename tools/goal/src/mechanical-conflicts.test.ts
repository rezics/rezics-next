import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git } from './merge.ts';
import { rebaseOnto } from './merge-train.ts';
import { integrationHarness, markdown as briefMarkdown, repository } from './test-support.ts';

const guide = 'docs/guide.md';

function addGuide(h: ReturnType<typeof integrationHarness>) {
  mkdirSync(dirname(join(h.root, guide)), { recursive: true });
  writeFileSync(join(h.root, guide), '# Guide\n');
  git(h.root, 'add', '--', guide);
  git(h.root, 'commit', '-m', 'Add guide');
}

async function dispatchFile(h: ReturnType<typeof integrationHarness>, file: string, content: string) {
  const task = h.dispatch(file);
  mkdirSync(dirname(join(task.worktree, file)), { recursive: true });
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content }));
  await h.start(task);
  return task;
}

test('a retry rebase unions appended Markdown lines from both sides', async () => {
  const h = integrationHarness();
  try {
    addGuide(h);
    h.ensureDev();
    const task = await dispatchFile(h, guide, '# Guide\n\nWorker addition\n');
    h.advanceDev(guide, '# Guide\n\nIntegration addition\n');
    let rebasedContent = '';
    (h.tasks as unknown as { launcher: (...args: unknown[]) => unknown }).launcher = (() => {
      rebasedContent = readFileSync(join(task.worktree, guide), 'utf8');
      return undefined;
    }) as (...args: unknown[]) => unknown;
    const retry = (
      h.tasks as unknown as { retryTask: (id: string, options: object, leased: boolean) => Promise<unknown> }
    ).retryTask;

    await retry.call(h.tasks, task.id, { escalation: 'rebase-conflict' }, true);

    expect(rebasedContent).toContain('Worker addition');
    expect(rebasedContent).toContain('Integration addition');
    const latest = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(readFileSync(`${latest.logPath}.rebase`, 'utf8')).toContain(`Markdown union: ${guide}`);
  } finally {
    h.dispose();
  }
}, 30_000);

test('the train lands a Markdown union and names it in the landing log and owner notice', async () => {
  const h = integrationHarness();
  try {
    addGuide(h);
    const task = await dispatchFile(h, guide, '# Guide\n\nWorker addition\n');
    const ownerBrief = join(h.settings.stateDirectory, `owner-${crypto.randomUUID()}.md`);
    writeFileSync(
      ownerBrief,
      briefMarkdown
        .replace('goal: fixture', 'goal: docs')
        .replace('paths: [result.txt]', `paths: [${guide}]`)
        .replace('command: [bun, test]', 'command: ["true"]'),
    );
    h.tasks.dispatch(ownerBrief);
    h.advanceDev(guide, '# Guide\n\nIntegration addition\n');

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    const landed = git(h.root, `show`, `dev:${guide}`);
    expect(landed).toContain('Worker addition');
    expect(landed).toContain('Integration addition');
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log).toContain(`Markdown union: ${guide}`);
    const notices = h.store.db.query('SELECT event FROM manager_inbox').all() as { event: string }[];
    expect(
      notices.map((row) => JSON.parse(row.event).summary as string).some((summary) => summary.includes(guide)),
    ).toBe(true);
  } finally {
    h.dispose();
  }
}, 30_000);

test('a promotion-stage generated conflict regenerates during a dev landing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const generated = 'packages/client/src/kernel/http/kernel.d.ts';
    const script = join(h.settings.stateDirectory, `regenerate-${crypto.randomUUID()}.mjs`);
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(generated)}, 'regenerated from dev\\n');`,
    );
    h.settings.derivedFiles = [
      { path: 'packages/client/src/kernel/**', stage: 'promotion', command: [process.execPath, script] },
    ];
    const task = await dispatchFile(h, generated, 'worker generated output\n');
    h.advanceDev(generated, 'integration generated output\n');

    await h.train();

    expect(h.store.task(task.id).state).toBe('integrated');
    expect(git(h.root, 'show', `dev:${generated}`)).toBe('regenerated from dev');
  } finally {
    h.dispose();
  }
}, 30_000);

test('a Markdown union does not bypass a conflict in another file', () => {
  const repo = repository();
  const worker = join(repo.path, 'worker');
  const path = 'guide.md';
  try {
    writeFileSync(join(repo.main, path), '# Guide\n');
    git(repo.main, 'add', path);
    git(repo.main, 'commit', '-m', 'Add guide');
    const originalBase = git(repo.main, 'rev-parse', 'HEAD');
    git(repo.main, 'worktree', 'add', '-b', 'worker', worker, originalBase);
    writeFileSync(join(worker, path), '# Guide\n\nWorker addition\n');
    writeFileSync(join(worker, 'result.txt'), 'worker change\n');
    git(worker, 'add', '.');
    git(worker, 'commit', '-m', 'Change Markdown and result');
    writeFileSync(join(repo.main, path), '# Guide\n\nIntegration addition\n');
    writeFileSync(join(repo.main, 'result.txt'), 'integration change\n');
    git(repo.main, 'add', '.');
    git(repo.main, 'commit', '-m', 'Conflict with worker');
    const base = git(repo.main, 'rev-parse', 'HEAD');

    expect(() => rebaseOnto(worker, base, originalBase, join(repo.path, 'rebase.log'))).toThrow();
    expect(git(worker, 'diff', '--name-only', '--diff-filter=U')).toContain('result.txt');
  } finally {
    repo.close();
  }
});
