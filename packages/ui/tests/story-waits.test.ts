import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const components = join(root, 'src', 'components');

/** Run one throwaway story file in the browser project and return each story's outcome. */
async function runProbe(name: string, source: string[]): Promise<string[]> {
  const probe = join(components, name);
  writeFileSync(probe, source.join('\n'));
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-story-waits-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      ['bun', 'x', 'vitest', 'run', '--reporter=json', `--outputFile=${report}`, `src/components/${name}`],
      { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(existsSync(report), `${stdout.slice(-2000)}\n${stderr.slice(-4000)}`).toBe(true);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { name: string; assertionResults: { status: string; title: string; failureMessages: string[] }[] }[];
    };
    return result.testResults
      .flatMap((file) => file.assertionResults)
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
  } finally {
    rmSync(probe, { force: true });
    rmSync(output, { recursive: true, force: true });
  }
}

test('a story waits up to fifteen seconds for what it expects, so a loaded machine does not fail it', async () => {
  // A control that appears three seconds late, as on a machine running several gates at once.
  const outcomes = await runProbe('slow-probe.stories.tsx', [
    "import type { Meta, StoryObj } from '@storybook/react-vite';",
    "import { useEffect, useState } from 'react';",
    "import { expect, waitFor, within } from 'storybook/test';",
    '',
    'function Late() {',
    '  const [shown, setShown] = useState(false);',
    '  useEffect(() => {',
    '    const timer = setTimeout(() => setShown(true), 3_000);',
    '    return () => clearTimeout(timer);',
    '  }, []);',
    '  return shown ? <button type="button">Late control</button> : <p>Waiting</p>;',
    '}',
    '',
    "const meta = { title: 'Probe/Slow', component: Late } satisfies Meta<typeof Late>;",
    'export default meta;',
    'type Story = StoryObj<typeof meta>;',
    '',
    'export const FoundLate: Story = {',
    '  async play({ canvasElement }) {',
    "    await within(canvasElement).findByRole('button', { name: 'Late control' });",
    '  },',
    '};',
    '',
    'export const WaitedLate: Story = {',
    '  async play({ canvasElement }) {',
    "    await waitFor(() => expect(within(canvasElement).getByRole('button', { name: 'Late control' })).toBeVisible());",
    '  },',
    '};',
    '',
  ]);
  expect(outcomes).toEqual(['Found Late: passed', 'Waited Late: passed']);
}, 300_000);

test("a focus wait allows as long as the stories' other waits before it fails", async () => {
  // Focus is already on the target, but animation frames arrive 1.2 seconds apart, as on a machine running
  // several gates at once. The wait needs two frames of steady focus, so it needs more than two seconds.
  const outcomes = await runProbe('slow-frames-probe.stories.tsx', [
    "import type { Meta, StoryObj } from '@storybook/react-vite';",
    "import { expect, within } from 'storybook/test';",
    "import { focusForTyping, waitForFocus } from '../test/focus.ts';",
    '',
    'const meta = { title: \'Probe/SlowFrames\', render: () => <textarea aria-label="Notes" /> } satisfies Meta;',
    'export default meta;',
    'type Story = StoryObj<typeof meta>;',
    '',
    'async function withSlowFrames(run: () => Promise<void>) {',
    '  const original = window.requestAnimationFrame;',
    '  window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 1_200);',
    '  try {',
    '    await run();',
    '  } finally {',
    '    window.requestAnimationFrame = original;',
    '  }',
    '}',
    '',
    'export const WaitForFocus: Story = {',
    '  async play({ canvasElement }) {',
    "    const field = within(canvasElement).getByRole('textbox', { name: 'Notes' });",
    '    field.focus();',
    '    await withSlowFrames(() => waitForFocus(field));',
    '    expect(field).toHaveFocus();',
    '  },',
    '};',
    '',
    'export const FocusForTyping: Story = {',
    '  async play({ canvasElement }) {',
    "    const field = within(canvasElement).getByRole('textbox', { name: 'Notes' });",
    '    await withSlowFrames(() => focusForTyping(field));',
    '    expect(field).toHaveFocus();',
    '  },',
    '};',
    '',
  ]);
  expect(outcomes).toEqual(['Focus For Typing: passed', 'Wait For Focus: passed']);
}, 300_000);
