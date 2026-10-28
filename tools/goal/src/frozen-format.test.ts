import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { FORMAT_FLAGS } from './merge-train.ts';
import { git } from './tasks.ts';
import { integrationHarness, harness } from './test-support.ts';

const frozenPath = 'tests/acceptance.test.ts';
const rawFormattedTest = 'test("frozen",()=>{});\n';
const formattedTest = "test('frozen', () => {});\n";

function brief(content: string): string {
  return `---
goal: frozen-format
kind: implementation
paths: [result.txt, ${frozenPath}]
riskAreas: []
acceptance:
  command: ["true"]
  tests: ["frozen formatter"]
  failing: true
estimate:
  lines: 100
  files: 2
criticalPath: false
waiting: []
---

${String.fromCharCode(96).repeat(3)}ts path=${frozenPath}
${content}${String.fromCharCode(96).repeat(3)}
`;
}

function useRepositoryFormatter(h: { settings: { formatCommand: string[] } }): void {
  const repository = resolve(import.meta.dir, '../../..');
  h.settings.formatCommand = [
    join(repository, 'node_modules/.bin/oxfmt'),
    `--config=${join(repository, '.oxfmtrc.json')}`,
    ...FORMAT_FLAGS,
  ];
}

function storedHash(task: unknown, path: string): string | undefined {
  return (task as { frozenFiles?: { path: string; hash: string }[] }).frozenFiles?.find((file) => file.path === path)
    ?.hash;
}

describe('frozen acceptance formatting', () => {
  test('formats a brief file before commit and records the formatted bytes hash', () => {
    const h = harness();
    try {
      useRepositoryFormatter(h);
      writeFileSync(h.briefFile, brief(rawFormattedTest));

      const task = h.tasks.dispatch(h.briefFile);
      const path = join(task.worktree, frozenPath);
      const formattedBytes = readFileSync(path);

      expect(formattedBytes.toString('utf8')).toBe(formattedTest);
      expect(storedHash(task, frozenPath)).toBe(createHash('sha256').update(formattedBytes).digest('hex'));
      expect(git(task.worktree, ['show', `HEAD:${frozenPath}`])).toBe(formattedTest.trimEnd());
    } finally {
      h.dispose();
    }
  });

  test('keeps unparsable brief bytes and reports the formatter error during dispatch', () => {
    const h = harness();
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      errors.push(values.map(String).join(' '));
    });
    const invalid = 'const = ;\n';
    try {
      useRepositoryFormatter(h);
      writeFileSync(h.briefFile, brief(invalid));

      const task = h.tasks.dispatch(h.briefFile);
      const bytes = readFileSync(join(task.worktree, frozenPath));

      expect(bytes.toString('utf8')).toBe(invalid);
      expect(storedHash(task, frozenPath)).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(errors.join('\n')).toContain('Frozen acceptance formatter failed:');
      expect(errors.join('\n')).toContain(frozenPath);
    } finally {
      errorSpy.mockRestore();
      h.dispose();
    }
  });

  test('the train accepts a formatted frozen file unchanged', async () => {
    const h = integrationHarness();
    try {
      useRepositoryFormatter(h);
      h.ensureDev();
      writeFileSync(h.briefFile, brief(rawFormattedTest));
      const task = h.tasks.dispatch(h.briefFile);
      expect(readFileSync(join(task.worktree, frozenPath), 'utf8')).toBe(formattedTest);
      mkdirSync(join(task.worktree, '.temp'), { recursive: true });
      writeFileSync(
        join(task.worktree, '.temp/worker-plan.json'),
        JSON.stringify({ file: 'result.txt', content: 'accepted\n' }),
      );

      await h.start(task);
      await h.train();

      expect(h.outcomes[0]?.passed).toBe(true);
      expect(h.head()).not.toBe(h.head('main'));
    } finally {
      h.dispose();
    }
  });

  test('the train still refuses a worker edit to a formatted frozen file', async () => {
    const h = integrationHarness();
    try {
      useRepositoryFormatter(h);
      h.ensureDev();
      writeFileSync(h.briefFile, brief(rawFormattedTest));
      const task = h.tasks.dispatch(h.briefFile);
      const base = h.head();
      mkdirSync(join(task.worktree, '.temp'), { recursive: true });
      writeFileSync(
        join(task.worktree, '.temp/worker-plan.json'),
        JSON.stringify({ file: frozenPath, content: 'worker edit\n' }),
      );

      await h.start(task);
      await h.train();

      expect(h.head()).toBe(base);
      expect(h.outcomes[0]?.passed).toBe(false);
      expect(h.outcomes[0]?.conflictedFiles).toContain(frozenPath);
    } finally {
      h.dispose();
    }
  });
});
