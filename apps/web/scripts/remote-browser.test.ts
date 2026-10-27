import { expect, mock, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

type Handed = {
  label: string;
  command: string[];
  returns?: string[];
  keepsFiles?: boolean;
};

const handed: Handed[] = [];
const localRuns: string[] = [];
// 0 means the fake host ran the command. null means the placement stayed on this machine.
let remoteCode: number | null = 0;

mock.module('../../../scripts/stack-run.ts', () => ({
  stackRun: async (
    run: Handed & { keepsFiles?: boolean; returns?: string[] },
    local: (env: Record<string, string>) => Promise<number>,
  ) => {
    handed.push({
      label: run.label,
      command: [...run.command],
      ...(run.returns === undefined ? {} : { returns: [...run.returns] }),
      ...(run.keepsFiles === undefined ? {} : { keepsFiles: run.keepsFiles }),
    });
    const staysLocal = remoteCode === null || (run.keepsFiles === true && run.returns === undefined);
    if (staysLocal) {
      localRuns.push(run.label);
      return run.label === 'web browser check' ? local({}) : 0;
    }
    return remoteCode ?? 0;
  },
}));

const { placeBrowserCheck, runBrowserWorker } = await import('./check.ts');
const { runScreenshots } = await import('./screenshots.ts');
const { runRecord } = await import('./record.ts');

function handedLabel(label: string): Handed {
  const run = handed.find((item) => item.label === label);
  if (!run) throw new Error(`placement was not asked to run ${label}`);
  return run;
}

test('browser-driven web checks, screenshots and recordings run on a check host and their outputs return', async () => {
  handed.length = 0;
  localRuns.length = 0;
  remoteCode = 0;
  await placeBrowserCheck(['tests/page-stories.test.ts'], { testScript: 'bun run test' });
  await runScreenshots(['--story', 'pages-missing-subject--signed-out', '--out', join(root, '.temp/shots')]);
  await runScreenshots([]);
  await runRecord(['offer', 'order-paid']);

  const browser = handedLabel('web browser check');
  expect(localRuns).toEqual([]);
  expect(browser.command.slice(0, 4)).toEqual(['bun', 'scripts/check.ts', '--browser', '--report']);
  expect(browser.returns).toHaveLength(1);
  expect(browser.returns?.[0]).toMatch(/^\.temp\/web-check-/);
  const browserReport = browser.returns?.[0];
  if (!browserReport) throw new Error('browser placement did not declare its report directory');
  expect(browser.command).toContain(browserReport);
  expect(browser.command).toContain('--test-command');
  expect(browser.command).toContain('bun run test');
  expect(browser.command).toContain('tests/page-stories.test.ts');
  expect(browser.keepsFiles).toBeUndefined();

  const screenshots = handed.filter((run) => run.label === 'web screenshots');
  expect(screenshots[0]).toEqual({
    label: 'web screenshots',
    command: [
      'bun',
      'scripts/screenshots.ts',
      '--story',
      'pages-missing-subject--signed-out',
      '--out',
      '../../.temp/shots',
    ],
    returns: ['.temp/shots'],
  });
  expect(screenshots[1]?.returns).toEqual(['.temp/screenshots']);
  expect(screenshots[1]?.command).toContain('--out');
  expect(screenshots[1]?.command).toContain('../../.temp/screenshots');
  expect(screenshots[1]?.keepsFiles).toBeUndefined();

  const recorded = handedLabel('web record');
  expect(recorded.command).toEqual(['bun', 'scripts/record.ts', 'offer', 'order-paid']);
  expect(recorded.returns).toEqual(['apps/web/src/kernel/recorded']);
  expect(recorded.keepsFiles).toBeUndefined();
});

test('a browser run stays local only where the placement decision says so', async () => {
  handed.length = 0;
  localRuns.length = 0;
  remoteCode = 0;
  await runScreenshots([]);
  await runRecord([]);
  await placeBrowserCheck(['tests/page-stories.test.ts']);
  expect(handed.map((run) => run.label)).toEqual(['web screenshots', 'web record', 'web browser check']);
  expect(localRuns).toEqual([]);
  expect(handed.every((run) => run.returns !== undefined && run.returns.length > 0)).toBe(true);
  expect(handed.every((run) => run.keepsFiles !== true)).toBe(true);

  handed.length = 0;
  remoteCode = null;
  const local = await placeBrowserCheck([]);
  expect(local.code).toBe(0);
  expect(local.failed).toEqual([]);
  expect(handed).toHaveLength(1);
  const localBrowser = handed[0];
  if (!localBrowser) throw new Error('browser placement was not recorded');
  const localReport = localBrowser.command[4];
  if (!localReport) throw new Error('browser placement did not pass its report directory');
  expect(localBrowser.returns).toEqual([localReport]);
  expect(localRuns).toEqual(['web browser check']);

  handed.length = 0;
  localRuns.length = 0;
  remoteCode = 0;
  const outside = '/tmp/web-screenshots-outside';
  await runScreenshots(['--out', outside]);
  expect(handed).toEqual([
    {
      label: 'web screenshots',
      command: ['bun', 'scripts/screenshots.ts', '--out', outside],
      keepsFiles: true,
    },
  ]);
  expect(localRuns).toEqual(['web screenshots']);

  const beforeWorker = handed.length;
  const report = '.temp/web-check-placement-worker';
  try {
    await runBrowserWorker({ files: [], report, testScript: 'bun run test' });
  } finally {
    rmSync(resolve(root, report), { recursive: true, force: true });
  }
  // The command a host is already running does not hand itself off again.
  expect(handed).toHaveLength(beforeWorker);
});
