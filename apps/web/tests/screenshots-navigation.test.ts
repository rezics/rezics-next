import { expect, test } from 'bun:test';
import { navigateStory, createProgressReporter } from '../scripts/screenshots.ts';

const url = 'http://127.0.0.1:6006/iframe.html?id=pages-board--signed-in&globals=locale:en;theme:light';
const options = { waitUntil: 'load' as const, timeout: 60_000 };

function networkChange() {
  return new Error(`goto: net::ERR_NETWORK_CHANGED at ${url}`);
}

test('a navigation network change is retried once, reported with its story id, and capture can continue', async () => {
  const errors: Error[] = [networkChange()];
  const calls: Array<{ url: string; options: typeof options }> = [];
  const progress: string[] = [];
  const page = {
    goto: async (target: string, settings: typeof options) => {
      calls.push({ url: target, options: settings });
      const error = errors.shift();
      if (error) throw error;
      return null;
    },
  };

  await navigateStory(page, 'pages-board--signed-in', url, (line) => progress.push(line));
  expect(calls).toEqual([
    { url, options },
    { url, options },
  ]);
  expect(progress).toEqual(['Retrying navigation for story pages-board--signed-in after net::ERR_NETWORK_CHANGED.']);
  // A resolved retry lets the caller continue with the rest of the capture.
  expect(await page.goto(url, options)).toBeNull();
});

test('a second network change fails with the story id and error', async () => {
  const page = {
    goto: async () => {
      throw networkChange();
    },
  };
  const progress: string[] = [];
  const error = await navigateStory(page, 'pages-board--signed-in', url, (line) => progress.push(line)).then(
    () => undefined,
    (value: unknown) => value,
  );

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('pages-board--signed-in');
  expect((error as Error).message).toContain('net::ERR_NETWORK_CHANGED');
  expect(progress).toHaveLength(1);
});

test.each(['net::ERR_CONNECTION_REFUSED', 'Timeout 60000ms exceeded'])(
  'navigation error %s is not retried',
  async (message) => {
    let calls = 0;
    const page = {
      goto: async () => {
        calls += 1;
        throw new Error(message);
      },
    };
    await expect(navigateStory(page, 'pages-board--signed-in', url, () => undefined)).rejects.toThrow(message);
    expect(calls).toBe(1);
  },
);

test('progress reports build start, build duration, and every captured file on stderr', () => {
  const lines: string[] = [];
  let now = 1_000;
  const reporter = createProgressReporter(
    (line) => lines.push(line),
    () => now,
  );
  reporter.buildStarted();
  now += 12_345;
  reporter.buildFinished();
  reporter.captured(12, 96, '/tmp/pages-board--signed-in.en.light.png');

  expect(lines).toEqual([
    'Storybook build started.',
    'Storybook build finished in 12.3s.',
    'captured 12/96 /tmp/pages-board--signed-in.en.light.png',
  ]);
});
