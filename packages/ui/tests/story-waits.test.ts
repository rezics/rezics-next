import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const probe = join(root, 'src', 'components', 'slow-probe.stories.tsx');

test('a story waits up to fifteen seconds for what it expects, so a loaded machine does not fail it', async () => {
  // A control that appears three seconds late, as on a machine running several gates at once.
  writeFileSync(
    probe,
    [
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
    ].join('\n'),
  );
  const output = mkdtempSync(join(tmpdir(), 'rezics-ui-story-waits-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        '--reporter=json',
        `--outputFile=${report}`,
        'src/components/slow-probe.stories.tsx',
      ],
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
    const outcomes = result.testResults
      .flatMap((file) => file.assertionResults)
      .map((assertion) =>
        `${assertion.title}: ${assertion.status} ${assertion.failureMessages[0]?.split('\n')[0] ?? ''}`.trim(),
      )
      .sort();
    expect(outcomes).toEqual(['Found Late: passed', 'Waited Late: passed']);
  } finally {
    rmSync(probe, { force: true });
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
