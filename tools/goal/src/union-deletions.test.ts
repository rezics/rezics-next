import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveMechanicalConflicts } from './merge-train.ts';
import { git } from './merge.ts';
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

test('a train returns a union that preserves replaced task lines to its worker with the lines named', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('README.md');
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'README.md', content: 'Updated fixture\n' }),
    );
    await h.start(task);
    const dev = h.advanceDev('README.md', 'Fixture\nDev note\n');

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.conflictedFiles).toEqual(['README.md']);
    expect(outcome.firstFailure?.assertion).toContain('task-deleted lines remain: "Fixture"');
    expect(readFileSync(outcome.logPath, 'utf8')).toContain('task-deleted lines remain: "Fixture"');
    expect(outcome.mergedCommit).toBeUndefined();
    expect(h.store.task(task.id).currentAttempt).toBeGreaterThan(1);
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.head('dev')).toBe(dev);
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
