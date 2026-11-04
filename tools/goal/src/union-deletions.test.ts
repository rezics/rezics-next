import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentAdapter, withAgentAdapter } from './agents.ts';
import { MergeTrain } from './merge-train.ts';
import { resolveMechanicalConflicts } from './merge-train.ts';
import { git } from './merge.ts';
import { TrainResolver } from './train-resolver.ts';
import { integrationHarness } from './test-support.ts';

function conflictStages(root: string, file: string, base: string, dev: string, task: string): void {
  writeFileSync(join(root, file), 'unmerged content\n');
  const blobs = [base, task, dev].map((content) => {
    const path = join(root, '.temp/union-stage');
    writeFileSync(path, content);
    return git(root, 'hash-object', '-w', path);
  });
  const input = blobs.map((blob, index) => `100644 ${blob} ${index + 1}\t${file}`).join('\n');
  const staged = spawnSync('git', ['update-index', '--index-info'], {
    cwd: root,
    encoding: 'utf8',
    input: `${input}\n`,
  });
  expect(staged.status).toBe(0);
}

test('a Markdown union that retains a line deleted by the task is returned to the worker', () => {
  const h = integrationHarness();
  try {
    const file = '.temp/deleted-union.md';
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    conflictStages(
      h.root,
      file,
      'before\nold permission\nafter\n',
      'before\nold permission\ndev note\nafter\n',
      'before\nnew permission\nafter\n',
    );

    expect(() => resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toThrow(
      `Worker change conflicts with dev in ${file}: task-deleted lines remain: "old permission"`,
    );
  } finally {
    h.dispose();
  }
});

test('a union of independent Markdown insertions still integrates', () => {
  const h = integrationHarness();
  try {
    const file = '.temp/independent-union.md';
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    conflictStages(
      h.root,
      file,
      'before\nafter\n',
      'before\ndev insertion\nafter\n',
      'before\ntask insertion\nafter\n',
    );

    expect(resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toEqual([file]);
    expect(readFileSync(join(h.root, file), 'utf8')).toContain('task insertion');
    expect(readFileSync(join(h.root, file), 'utf8')).toContain('dev insertion');
  } finally {
    h.dispose();
  }
});

test('a conflicting JSON message replacement remains unresolved for the worker', () => {
  const h = integrationHarness();
  try {
    const file = 'apps/web/messages/union-deletions.json';
    mkdirSync(join(h.root, 'apps/web/messages'), { recursive: true });
    conflictStages(
      h.root,
      file,
      '{\n  "permission": "old",\n  "title": "base"\n}\n',
      '{\n  "permission": "dev",\n  "title": "base"\n}\n',
      '{\n  "permission": "new",\n  "title": "base"\n}\n',
    );

    expect(resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toBe(false);
  } finally {
    h.dispose();
  }
});

test('a train resolves the Markdown task-deletion union without starting another worker attempt', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const task = h.dispatch('README.md');
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'README.md', content: 'Updated fixture\n' }),
    );
    await h.start(task);
    const dev = h.advanceDev('README.md', 'Fixture\nDev note\n');

    const adapter = {
      ...agentAdapter('codex'),
      start(options: Parameters<ReturnType<typeof agentAdapter>['start']>[0]): [string, string[]] {
        const data = JSON.parse(options.prompt.split('\nDATA:\n')[1]!);
        expect(data.sourceContract).toContain('goal: fixture');
        expect(data.files[0]).toMatchObject({
          path: 'README.md',
          base: 'Fixture\n',
          target: 'Fixture\nDev note\n',
          source: 'Updated fixture\n',
        });
        return [
          process.execPath,
          ['-e', `require('node:fs').writeFileSync('README.md', 'Updated fixture\\nDev note\\n')`],
        ];
      },
    };
    await withAgentAdapter(adapter, async () => {
      await new MergeTrain({
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
      }).run();
    });
    await h.job.drain();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(true);
    expect(outcome.conflictedFiles).toEqual(['README.md']);
    expect(outcome).toMatchObject({ conflictResolution: { method: 'resolver', attempts: 1 } });
    expect(readFileSync(outcome.logPath, 'utf8')).toContain('Dev landing conflict method=resolver');
    expect(h.store.task(task.id)).toMatchObject({ currentAttempt: 1, state: 'integrated' });
    expect(h.head('dev')).not.toBe(dev);
    expect(git(h.root, 'show', 'dev:README.md')).toBe('Updated fixture\nDev note');
  } finally {
    h.dispose();
  }
}, 30_000);

test('a JSON-message union rejects deleted lines retained elsewhere in the result', () => {
  const h = integrationHarness();
  try {
    const file = 'apps/web/messages/deleted-lines.json';
    mkdirSync(join(h.root, 'apps/web/messages'), { recursive: true });
    const base = '{\n  "obsolete": {\n    "text": "old"\n  },\n  "keep": {\n    "text": "old"\n  }\n}\n';
    const task = '{\n  "keep": {\n    "text": "old"\n  }\n}\n';
    const dev =
      '{\n  "obsolete": {\n    "text": "old"\n  },\n  "keep": {\n    "text": "old"\n  },\n  "new": "dev"\n}\n';
    conflictStages(h.root, file, base, dev, task);

    expect(() => resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toThrow(
      `Worker change conflicts with dev in ${file}: task-deleted lines remain:`,
    );
    expect(() => resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toThrow(
      JSON.stringify('    "text": "old"'),
    );
    expect(readFileSync(join(h.root, file), 'utf8')).toBe('unmerged content\n');
  } finally {
    h.dispose();
  }
});

test('a union of independent JSON-message insertions still integrates', () => {
  const h = integrationHarness();
  try {
    const file = 'apps/web/messages/independent.json';
    mkdirSync(join(h.root, 'apps/web/messages'), { recursive: true });
    conflictStages(h.root, file, '{}\n', '{\n  "dev": "addition"\n}\n', '{\n  "task": "addition"\n}\n');

    expect(resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.root, file), 'utf8'))).toEqual({ task: 'addition', dev: 'addition' });
  } finally {
    h.dispose();
  }
});

test('a task line deleted and also added elsewhere is allowed even when its count decreases', () => {
  const h = integrationHarness();
  try {
    const file = '.temp/moved-lines.md';
    const context = 'unchanged context\n'.repeat(10);
    const base = `head\nsame\nleft\n${context}right\nsame\ntail\n`;
    const task = `head\nleft\n${context}right\ntail\nsame\n`;
    const dev = `head\nsame\ndev note\nleft\n${context}right\nsame\ntail\n`;
    conflictStages(h.root, file, base, dev, task);

    expect(resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toEqual([file]);
    expect(readFileSync(join(h.root, file), 'utf8')).toContain('dev note');
  } finally {
    h.dispose();
  }
});

test('a retained deletion is named even when the union otherwise equals dev', () => {
  const h = integrationHarness();
  try {
    const file = '.temp/deleted-only.md';
    // Rebase index order: base, dev, task.
    conflictStages(
      h.root,
      file,
      'before\nold permission\nafter\n',
      'before\nafter\n',
      'before\nold permission\ndev note\nafter\n',
    );

    expect(() => resolveMechanicalConflicts(h.root, [file], undefined, 'union', 3)).toThrow(
      `Worker change conflicts with dev in ${file}: task-deleted lines remain: "old permission"`,
    );
  } finally {
    h.dispose();
  }
});
