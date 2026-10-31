import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Toaster, createToastManager, useToastManager } from '../src/shadcn/toast';

test('one root supplies the default or explicit manager to descendant regions; distinct managers stay isolated', () => {
  const first = createToastManager();
  const second = createToastManager();
  for (const manager of [undefined, first]) {
    const observed: ReturnType<typeof useToastManager>[] = [];
    function Observe() {
      observed.push(useToastManager());
      return null;
    }
    renderToStaticMarkup(
      <Toaster toastManager={manager}>
        <Observe />
        <section>
          <Observe />
          <div>
            <Observe />
          </div>
        </section>
        <Toaster toastManager={second}>
          <Observe />
        </Toaster>
      </Toaster>,
    );
    expect(observed).toHaveLength(4);
    expect(observed[1]!.add).toBe(observed[0]!.add);
    expect(observed[1]!.toasts).toBe(observed[0]!.toasts);
    expect(observed[2]!.add).toBe(observed[0]!.add);
    expect(observed[2]!.toasts).toBe(observed[0]!.toasts);
    expect(observed[3]!.add).not.toBe(observed[0]!.add);
  }
});

test('composed, standalone and independent toast stories retain live feedback, keyboard actions and original undo outcomes', async () => {
  const root = join(import.meta.dir, '..');
  const temporary = join(root, '../../.temp');
  mkdirSync(temporary, { recursive: true });
  const output = mkdtempSync(join(temporary, 'toast-composition-'));
  const report = join(output, 'stories.json');
  try {
    const run = Bun.spawn(
      [
        'bun',
        'x',
        'vitest',
        'run',
        'src/components/shadcn-toast.stories.tsx',
        'src/components/undo-toast.stories.tsx',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '1' } },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: { assertionResults: { title: string; status: string }[] }[];
    };
    const outcomes = result.testResults.flatMap((file) => file.assertionResults);
    for (const title of [
      'Default',
      'Composed',
      'Same Manager',
      'Independent Manager',
      'Replacement And Undo',
      'Window',
    ])
      expect(
        outcomes.some((outcome) => outcome.title === title && outcome.status === 'passed'),
        title,
      ).toBe(true);
    expect(outcomes.filter((outcome) => outcome.status !== 'passed')).toEqual([]);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 300_000);
