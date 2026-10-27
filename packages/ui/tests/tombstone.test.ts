import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = join(import.meta.dir, '..');
const output = join(root, '../../.temp/deletion-acceptance');

test("Tombstone renders a reference to a deleted or withheld record in the place and size the record would take (a post, a card in a grid or row, a list row), with its kind's message and no title, author, cover or link of the record", async () => {
  const { Tombstone } = await import('../src/components/tombstone.tsx');
  for (const shape of ['post', 'card', 'row'] as const) {
    for (const reason of ['deleted', 'withheld'] as const) {
      const html = renderToStaticMarkup(createElement(Tombstone, { shape, reason }));
      expect(html).toContain(`data-shape="${shape}"`);
      expect(html).toContain(reason === 'deleted' ? 'deleted' : 'withheld');
      expect(html).not.toMatch(/<(a|img|picture|h[1-6])\b|href=|src=|author/i);
      if (shape === 'card') expect(html).toContain('data-slot="aspect-ratio"');
    }
  }
});

test('a deleted tombstone and a withheld tombstone read differently, and neither offers an action to a reader who is not the owner', async () => {
  const { Tombstone } = await import('../src/components/tombstone.tsx');
  const deleted = renderToStaticMarkup(createElement(Tombstone, { shape: 'row', reason: 'deleted' }));
  const withheld = renderToStaticMarkup(createElement(Tombstone, { shape: 'row', reason: 'withheld' }));
  expect(deleted).not.toBe(withheld);
  expect(deleted + withheld).not.toContain('<button');
  const ownerWithheld = renderToStaticMarkup(
    createElement(Tombstone, {
      shape: 'post',
      reason: 'withheld',
      restoreUntil: new Date(Date.now() + 86_400_000),
      onRestore() {},
    }),
  );
  expect(ownerWithheld).not.toContain('<button');
});

test("the owner's tombstone of a deleted record offers Restore until its restore deadline, shown as a relative time, and nothing after it", async () => {
  const { Tombstone } = await import('../src/components/tombstone.tsx');
  const render = (restoreUntil: Date | string, onRestore?: () => void) =>
    renderToStaticMarkup(
      createElement(Tombstone, { shape: 'post', reason: 'deleted', restoreUntil, ...(onRestore ? { onRestore } : {}) }),
    );
  const future = new Date(Date.now() + 30 * 86_400_000);
  const html = render(future, () => {});
  expect(html).toContain('Restore');
  expect(html).toContain('<button');
  expect(html).toContain(`dateTime="${future.toISOString()}"`);
  expect(html).toMatch(/in (about )?30 days/);
  for (const deadline of [new Date(Date.now() - 1), new Date(), 'invalid']) {
    const expired = render(deadline, () => {});
    expect(expired).not.toContain('<button');
    expect(expired).not.toContain('<time');
  }
  expect(render(future)).not.toContain('<button');
});

test("undoToast(label, onUndo) shows the action's result with an Undo button for a fixed window, calls onUndo once when pressed, and is announced politely to screen readers", async () => {
  const { undoToast } = await import('../src/components/undo-toast.tsx');
  const { toast } = await import('../src/shadcn/toast.tsx');
  const events: unknown[] = [];
  const unsubscribe = toast[' subscribe']((event) => events.push(event));
  let calls = 0;
  try {
    undoToast('Post deleted', () => {
      calls++;
    });
    const first = events.at(-1) as {
      options: {
        title: string;
        timeout: number;
        priority: string;
        actionProps: { children: string; onClick: () => void };
      };
    };
    expect(first.options.title).toBe('Post deleted');
    expect(first.options.timeout).toBe(8000);
    expect(first.options.priority).toBe('low');
    expect(first.options.actionProps.children).toBe('Undo');
    undoToast(
      'Review deleted',
      () => {
        calls += 10;
      },
      { undo: 'Revert' },
    );
    first.options.actionProps.onClick();
    expect(calls).toBe(0);
    const second = events.findLast(
      (event) => (event as { options?: { title?: string } }).options?.title === 'Review deleted',
    ) as typeof first;
    expect(second.options.actionProps.children).toBe('Revert');
    second.options.actionProps.onClick();
    second.options.actionProps.onClick();
    expect(calls).toBe(10);
  } finally {
    unsubscribe();
  }
});

test('the tombstone and undo toast stories have no accessibility violations in light and dark themes', async () => {
  mkdirSync(output, { recursive: true });
  const report = join(output, 'stories.json');
  const run = Bun.spawn(
    [
      'bun',
      'scripts/isolated.ts',
      'bun',
      'x',
      'vitest',
      'run',
      '--reporter=json',
      `--outputFile=${report}`,
      'src/components/tombstone.stories.tsx',
      'src/components/undo-toast.stories.tsx',
    ],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '1' },
    },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { status: string; title: string }[] }[];
    };
    const outcomes = result.testResults.flatMap((file) => file.assertionResults);
    expect(outcomes.map((test) => `${test.title}: ${test.status}`).sort()).toEqual([
      'Dark: passed',
      'Dark: passed',
      'Deadline: passed',
      'Footprints: passed',
      'Light: passed',
      'Light: passed',
      'Replacement And Undo: passed',
      'Window: passed',
    ]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
