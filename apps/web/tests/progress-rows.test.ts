import { expect, test } from 'bun:test';

const source = (name: string) => Bun.file(new URL(`../src/library/${name}`, import.meta.url)).text();

test('the progress index and session use the shared progress row', async () => {
  for (const name of ['progress-page.tsx', 'progress-session.tsx']) {
    const text = await source(name);
    expect(text, name).toContain('@rezics/ui/progress-row');
    expect(text, name).toContain('<ProgressRow');
  }
});

test('session completion and abandonment are offered in the progress row menu', async () => {
  const text = await source('progress-session.tsx');
  expect(text).toContain('@rezics/ui/menu');
  expect(text).toContain('m.library_progress_complete()');
  expect(text).toContain('m.library_progress_abandon()');
});

test('published logs show state and relative time without progress bars', async () => {
  for (const name of ['log-page.tsx', 'logs-progress.tsx']) {
    const text = await source(name);
    expect(text, name).toContain('stateLabel(');
    expect(text, name).toContain('RelativeTime');
    expect(text, name).not.toContain('<ProgressRow');
    expect(text, name).not.toContain('<progress');
  }
});
