import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { frozenFile } from './frozen.ts';
import { integrationHarness, harness } from './test-support.ts';
import { git, WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import { reading } from './test-support.ts';
import { launch } from './launch.ts';

const block = '```ts path=tests/acceptance.test.ts\n// keep this comment\ntest("frozen", () => {});\n```';
function briefWith(blocks: string[], paths = ['tests/**']): string {
  return `---\ngoal: fixture\nkind: implementation\npaths: [${paths.join(', ')}]\nriskAreas: []\nacceptance:\n  command: [bun, test]\n  tests: [frozen]\n  failing: true\nestimate:\n  lines: 100\n  files: 4\ncriticalPath: false\nwaiting: []\n---\n\n${blocks.join('\n\n')}\n`;
}

describe('frozen acceptance files', () => {
  test('Keep frozen acceptance content consistent with its recorded hash.', () => {
    const bytes = Buffer.from('\uFEFFcafé\r\n', 'utf8');
    const file = frozenFile('tests/a.ts', bytes);
    expect(Buffer.from(file.content, 'utf8').equals(bytes)).toBe(true);
    expect(file.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(() => frozenFile('tests/bad.ts', Uint8Array.of(0xff))).toThrow(
      'frozen file is not valid UTF-8: tests/bad.ts',
    );
  });

  test('dispatch writes every path-tagged block byte for byte and commits them first', () => {
    const h = harness();
    try {
      const second = '```js path=tests/second.test.js\nconst text = "exact";\n```';
      writeFileSync(h.briefFile, briefWith([block, second], ['tests/acceptance.test.ts', 'tests/second.test.js']));
      const task = h.tasks.dispatch(h.briefFile);
      expect(readFileSync(join(task.worktree, 'tests/acceptance.test.ts'), 'utf8')).toBe(
        '// keep this comment\ntest("frozen", () => {});\n',
      );
      expect(readFileSync(join(task.worktree, 'tests/second.test.js'), 'utf8')).toBe('const text = "exact";\n');
      expect(git(task.worktree, ['show', '--format=%s', '--no-patch', 'HEAD'])).toBe('test: frozen acceptance files');
      expect(
        git(task.worktree, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').sort(),
      ).toEqual(['tests/acceptance.test.ts', 'tests/second.test.js']);
      expect((task as typeof task & { frozenFiles: unknown[] }).frozenFiles).toHaveLength(2);
    } finally {
      h.dispose();
    }
  });

  test('a frozen block outside declared paths refuses dispatch', () => {
    const h = harness();
    try {
      writeFileSync(h.briefFile, briefWith([block], ['unrelated.txt']));
      expect(() => h.tasks.dispatch(h.briefFile)).toThrow('outside declared paths');
    } finally {
      h.dispose();
    }
  });

  test('integration refuses a branch that changed a frozen file and reports it to the manager', async () => {
    const h = integrationHarness();
    try {
      writeFileSync(h.briefFile, briefWith([block], ['result.txt', 'tests/acceptance.test.ts']));
      // Dispatch a task whose worker can pass its normal acceptance command.
      const real = h.tasks.dispatch(h.briefFile);
      // The fixture worker writes the file its plan names, as h.dispatch would arrange.
      mkdirSync(join(real.worktree, '.temp'), { recursive: true });
      writeFileSync(
        join(real.worktree, '.temp/worker-plan.json'),
        JSON.stringify({ file: 'result.txt', content: 'result\n' }),
      );
      const idleJob = new WorkerJob(
        h.tasks,
        h.queue,
        { deliver: (event) => h.inbox.push(event) },
        undefined,
        async () => {},
      );
      await idleJob.start(real.id);
      await idleJob.drain();
      writeFileSync(join(real.worktree, 'tests/acceptance.test.ts'), 'worker changed the acceptance test\n');
      git(real.worktree, ['add', '--', 'tests/acceptance.test.ts']);
      git(real.worktree, ['commit', '-m', 'change frozen acceptance']);
      const advancedTarget = h.advanceDev('tests/acceptance.test.ts', 'integration changed frozen acceptance\n');
      await h.train();
      expect(advancedTarget).not.toBe(h.head('main'));
      expect(h.head()).toBe(advancedTarget);
      expect(
        h.inbox.some((event) => event.kind === 'spec-conflict' && event.summary.includes('tests/acceptance.test.ts')),
      ).toBe(true);
      expect(h.store.task(real.id).currentAttempt).toBe(1);
      expect(h.store.task(real.id).state).toBe('stopped');
      expect(h.store.attempt({ taskId: real.id, attempt: 1 }).escalation).toBe('spec-conflict');
      const outcome = h.store.events(real.id, 1).find((event) => event.kind === 'gate-outcome');
      const durableOutcome = JSON.parse(outcome!.body);
      expect(durableOutcome.refusal).toEqual({
        kind: 'frozen-acceptance-change',
        paths: ['tests/acceptance.test.ts'],
      });
      expect(durableOutcome.rebaseConflict).toBeUndefined();
      expect(durableOutcome.conflictedFiles).toBeUndefined();
      const refusalEvents = h.store.events(real.id).filter((event) => event.kind === 'manager-event');
      expect(refusalEvents).toHaveLength(1);
      expect(JSON.parse(refusalEvents[0]!.body).summary).toContain('tests/acceptance.test.ts');
      expect(h.queue.next()).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  test('a retry with a reshaped brief commits its replacement frozen blocks before launch', async () => {
    const h = harness();
    try {
      const original = briefWith([block], ['tests/acceptance.test.ts']);
      writeFileSync(h.briefFile, original);
      const task = h.tasks.dispatch(h.briefFile);
      const reshapedPath = join(h.settings.stateDirectory, 'reshaped.md');
      const replacement = '```ts path=tests/replacement.test.ts\ntest("replacement", () => {});\n```';
      writeFileSync(reshapedPath, briefWith([replacement], ['tests/replacement.test.ts']));
      const fakeLauncher: typeof launch = async (_store, _current, attempt) => {
        const { EventEmitter } = await import('node:events');
        return { child: new EventEmitter() as never, exited: Promise.resolve({ code: 0, signal: null }), attempt };
      };
      const retryTasks = new WorkerTasks(h.settings, h.store, (pool) => reading(pool), fakeLauncher);
      await retryTasks.retry(task.id, { brief: reshapedPath });
      const updated = h.store.task(task.id);
      expect(readFileSync(join(updated.worktree, 'tests/replacement.test.ts'), 'utf8')).toBe(
        'test("replacement", () => {});\n',
      );
      expect(git(updated.worktree, ['show', '--format=%s', '--no-patch', 'HEAD'])).toBe(
        'test: frozen acceptance files',
      );
      expect(
        (updated as typeof updated & { frozenFiles: { path: string }[] }).frozenFiles.map((file) => file.path),
      ).toEqual(['tests/replacement.test.ts']);
    } finally {
      h.dispose();
    }
  });
});
