import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveMechanicalConflicts } from './merge-train.ts';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

function conflictStages(root: string, file: string, base: string, task: string, dev: string): void {
  writeFileSync(join(root, file), 'unmerged content\n');
  const blobs = [base, task, dev].map((content) => {
    const path = join(root, '.temp/union-stage');
    writeFileSync(path, content);
    return git(root, 'hash-object', '-w', path);
  });
  const input = blobs.map((blob, index) => `100644 ${blob} ${index + 1}\t${file}`).join('\n');
  const staged = spawnSync('git', ['update-index', '--index-info'], { cwd: root, encoding: 'utf8', input: `${input}\n` });
  expect(staged.status).toBe(0);
}

test('a Markdown union that retains a line deleted by the task is returned to the worker', () => {
  const h = integrationHarness();
  try {
    const file = '.temp/deleted-union.md';
    mkdirSync(join(h.root, '.temp'), { recursive: true });
    conflictStages(h.root, file, 'before\nold permission\nafter\n', 'before\nnew permission\nafter\n', 'before\nold permission\ndev note\nafter\n');

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
    conflictStages(h.root, file, 'before\nafter\n', 'before\ntask insertion\nafter\n', 'before\ndev insertion\nafter\n');

    expect(resolveMechanicalConflicts(h.root, [file], undefined, 'union')).toEqual([file]);
    expect(readFileSync(join(h.root, file), 'utf8')).toContain('task insertion');
    expect(readFileSync(join(h.root, file), 'utf8')).toContain('dev insertion');
  } finally {
    h.dispose();
  }
});
