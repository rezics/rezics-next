import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runWebTestLanes, webCheckTimingsFile } from '../scripts/check.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/check-timings-'));
const fakeTests = join(temporary, 'tests');
const events = join(temporary, 'events');
mkdirSync(fakeTests, { recursive: true });
mkdirSync(events, { recursive: true });

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function addFakeTest(name: string) {
  writeFileSync(
    join(fakeTests, name),
    [
      "import { expect, test } from 'bun:test';",
      `const events = ${JSON.stringify(events)};`,
      `const name = ${JSON.stringify(name.split('/').at(-1))};`,
      `test(${JSON.stringify(name)}, async () => {`,
      "  await Bun.sleep(30);",
      '  expect(true).toBe(true);',
      "  await Bun.write(`${events}/${name}`, String(Date.now()));",
      '});',
    ].join('\n'),
  );
  return relative(app, join(fakeTests, name)).split('\\').join('/');
}

function timing(wall: number) {
  return { wall, create: 0, drop: 0, outsideTests: 0, result: 'pass', tests: [] };
}

test('web checks write measured timings to the ignored cache and preserve the tracked seed', async () => {
  const first = addFakeTest('timings-cache-first.test.ts');
  const second = addFakeTest('timings-cache-second.test.ts');
  const cache = join(temporary, '.cache', 'check-timings.json');
  const seed = join(temporary, 'check-timings-seed.json');
  const trackedSeed = readFileSync(join(app, 'check-timings.json'), 'utf8');
  writeFileSync(seed, trackedSeed);

  const result = await runWebTestLanes({
    files: [first, second],
    directory: app,
    timingsFile: cache,
    previousTimingsFile: cache,
    seedTimingsFile: seed,
    env: { ...process.env, WEB_UNIT_CHECK_CONCURRENCY: '1' },
  });

  expect(result.failed).toEqual([]);
  const measured = JSON.parse(readFileSync(cache, 'utf8')) as {
    files: Record<string, { wall: number }>;
  };
  expect(measured.files[first]?.wall).toBeGreaterThan(0);
  expect(measured.files[second]?.wall).toBeGreaterThan(0);
  expect(readFileSync(join(app, 'check-timings.json'), 'utf8')).toBe(trackedSeed);
  expect(webCheckTimingsFile).toBe(join(app, '.cache', 'check-timings.json'));
});

test('the local timing cache takes precedence and the tracked seed is used when the cache is absent', async () => {
  const slower = addFakeTest('timings-source-slower.test.ts');
  const faster = addFakeTest('timings-source-faster.test.ts');
  const cache = join(temporary, 'timings-source-cache.json');
  const seed = join(temporary, 'timings-source-seed.json');
  writeFileSync(cache, JSON.stringify({ files: { [slower]: timing(50), [faster]: timing(1) } }));
  writeFileSync(seed, JSON.stringify({ files: { [slower]: timing(1), [faster]: timing(50) } }));
  const output = join(temporary, 'timings-source-output.json');
  const runOptions = {
    files: [faster, slower],
    directory: app,
    timingsFile: output,
    previousTimingsFile: cache,
    seedTimingsFile: seed,
    env: { ...process.env, WEB_UNIT_CHECK_CONCURRENCY: '1' },
  };
  const slowerEvent = join(events, slower.split('/').at(-1)!);
  const fasterEvent = join(events, faster.split('/').at(-1)!);

  await runWebTestLanes(runOptions);
  expect(readFileSync(slowerEvent, 'utf8')).toBeTruthy();
  expect(Number(readFileSync(slowerEvent, 'utf8'))).toBeLessThan(
    Number(readFileSync(fasterEvent, 'utf8')),
  );

  rmSync(cache);
  rmSync(output);
  rmSync(slowerEvent);
  rmSync(fasterEvent);
  await runWebTestLanes(runOptions);
  expect(Number(readFileSync(fasterEvent, 'utf8'))).toBeLessThan(
    Number(readFileSync(slowerEvent, 'utf8')),
  );
});
