import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, '../scripts/screenshots.ts'), 'utf8');

function extracted<T>(startName: string, endName: string, ending = `\nreturn ${startName};`): T {
  const ordinaryStart = source.indexOf(`function ${startName}(`);
  const start = ordinaryStart < 0 ? source.indexOf(`async function ${startName}(`) : ordinaryStart;
  const asyncEnd = source.indexOf(`\nasync function ${endName}(`, start);
  const ordinaryEnd = source.indexOf(`\nfunction ${endName}(`, start);
  const end = asyncEnd < 0 ? ordinaryEnd : ordinaryEnd < 0 ? asyncEnd : Math.min(asyncEnd, ordinaryEnd);
  if (start < 0 || end < 0) throw new Error(`Could not extract ${startName}.`);
  return new Function(`${source.slice(start, end)}${ending}`)() as T;
}

type Job = { id: string; locale: string; theme: string };
type CaptureResult = { files: string[]; failures: { job: Job; error: string }[] };
type CaptureJobs = (jobs: readonly Job[], run: (job: Job, worker: number) => Promise<string>) => Promise<CaptureResult>;

test('one failed story does not stop later screenshot jobs', async () => {
  const captureJobs = extracted<CaptureJobs>('captureJobs', 'reportCaptureResults');
  const jobs = [
    { id: 'first', locale: 'en', theme: 'light' },
    { id: 'broken', locale: 'ja', theme: 'dark' },
    { id: 'last', locale: 'zh-Hant', theme: 'light' },
  ];
  const visited: string[] = [];
  const result = await captureJobs(jobs, async (job) => {
    visited.push(job.id);
    if (job.id === 'broken') throw new Error('Synthetic render failure');
    return `${job.id}.png`;
  });
  expect(visited).toEqual(['first', 'broken', 'last']);
  expect(result.files).toEqual(['first.png', 'last.png']);
  expect(result.failures).toEqual([{ job: jobs[1], error: 'Synthetic render failure' }]);
});

test('failures print one line per failed job after files and produce a nonzero result', () => {
  const report = extracted<
    (files: string[], failures: { job: Job; error: string }[], write: (s: string) => void) => number
  >('reportCaptureResults', 'capture');
  const lines: string[] = [];
  const code = report(
    ['one.png', 'two.png'],
    [
      { job: { id: 'broken-a', locale: 'en', theme: 'dark' }, error: 'render exploded' },
      { job: { id: 'broken-b', locale: 'ja', theme: 'light' }, error: 'timeout\nsecond line' },
    ],
    (line) => lines.push(line),
  );
  expect(code).toBe(1);
  expect(lines.join('')).toBe(
    'one.png\ntwo.png\n2\nbroken-a en dark: render exploded\nbroken-b ja light: timeout second line\n',
  );
});

test('a run without failures retains its zero exit status and output', () => {
  const report = extracted<
    (files: string[], failures: { job: Job; error: string }[], write: (s: string) => void) => number
  >('reportCaptureResults', 'capture');
  const lines: string[] = [];
  expect(report(['one.png'], [], (line) => lines.push(line))).toBe(0);
  expect(lines.join('')).toBe('one.png\n1\n');
});

test('full page capture resets scroll only when no viewport overlay is open', async () => {
  const prepare = extracted<(page: { evaluate: (fn: () => unknown) => Promise<unknown> }) => Promise<void>>(
    'prepareFullPageCapture',
    'captureOne',
  );
  let overlay = false;
  let scrolled = false;
  let framed = false;
  const page = {
    evaluate: async (fn: () => unknown) => {
      return Function(
        'window',
        'requestAnimationFrame',
        'document',
        `return (${fn.toString()})();`,
      )(
        {
          scrollTo: () => {
            scrolled = true;
          },
        },
        (callback: () => void) => {
          framed = true;
          callback();
        },
        { querySelector: () => (overlay ? {} : null) },
      );
    },
  };
  await prepare(page);
  expect(scrolled).toBe(true);
  expect(framed).toBe(true);
  overlay = true;
  scrolled = false;
  framed = false;
  await prepare(page);
  expect(scrolled).toBe(false);
  expect(framed).toBe(false);
});
